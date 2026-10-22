import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CAMERA_DEVICE_STORAGE_KEY,
  MINIMAL_VIDEO_CONSTRAINTS,
  PREFERRED_VIDEO_CONSTRAINTS,
  applyTrackEnhancements,
  buildVideoConstraints,
  selectNextCamera,
  useCamera,
  type CameraDevice,
} from '@/hooks/useCamera'
import { CameraUnsupportedError, InsecureContextError } from '@/lib/scan/cameraErrors'

type FakeTrackOptions = {
  capabilities?: Record<string, unknown> | null
  deviceId?: string
}

const createFakeTrack = ({ capabilities = {}, deviceId = 'cam-main' }: FakeTrackOptions = {}) => {
  const track = {
    kind: 'video',
    stop: vi.fn(),
    applyConstraints: vi.fn(async () => undefined),
    getCapabilities: capabilities === null ? undefined : vi.fn(() => capabilities),
    getSettings: vi.fn(() => ({ deviceId })),
  }
  return track as unknown as MediaStreamTrack & typeof track
}

const createFakeStream = (track: MediaStreamTrack) =>
  ({
    getTracks: () => [track],
    getVideoTracks: () => [track],
  }) as unknown as MediaStream

const videoInput = (deviceId: string, label: string): MediaDeviceInfo =>
  ({ kind: 'videoinput', deviceId, label, groupId: 'g', toJSON: () => ({}) }) as MediaDeviceInfo

const installMediaDevices = (overrides: Partial<MediaDevices> = {}) => {
  const mediaDevices = {
    getUserMedia: vi.fn(),
    enumerateDevices: vi.fn(async () => [] as MediaDeviceInfo[]),
    ...overrides,
  }
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true })
  return mediaDevices
}

const originalPlay = HTMLMediaElement.prototype.play
const originalPause = HTMLMediaElement.prototype.pause

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
  localStorage.clear()
})

afterEach(() => {
  // Démonter avant de restaurer les prototypes : `stop()` appelle `pause()` au démontage.
  cleanup()
  HTMLMediaElement.prototype.play = originalPlay
  HTMLMediaElement.prototype.pause = originalPause
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Reflect.deleteProperty(window, 'isSecureContext')
  vi.restoreAllMocks()
})

const renderCamera = (options?: Parameters<typeof useCamera>[1]) => {
  const video = document.createElement('video')
  const ref = { current: video as HTMLVideoElement | null }
  const hook = renderHook(() => useCamera(ref, options))
  return { ...hook, video, ref }
}

describe('buildVideoConstraints', () => {
  it('demande 1080p / 30 ips en caméra arrière par défaut', () => {
    expect(buildVideoConstraints({}, null)).toEqual(PREFERRED_VIDEO_CONSTRAINTS)
  })

  it('remplace facingMode par deviceId (exact ou ideal)', () => {
    expect(buildVideoConstraints({}, 'abc', { exactDevice: true })).toEqual({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
      deviceId: { exact: 'abc' },
    })
    expect(buildVideoConstraints({}, 'abc').deviceId).toEqual({ ideal: 'abc' })
  })

  it('produit les contraintes minimales en mode repli', () => {
    expect(buildVideoConstraints({}, 'abc', { minimal: true })).toEqual({
      facingMode: undefined,
      deviceId: { ideal: 'abc' },
    })
    expect(buildVideoConstraints({}, null, { minimal: true })).toEqual(MINIMAL_VIDEO_CONSTRAINTS)
  })
})

describe('applyTrackEnhancements', () => {
  it('applique la mise au point continue et un zoom x2 quand la piste les annonce', async () => {
    const track = createFakeTrack({
      capabilities: { focusMode: ['manual', 'continuous'], zoom: { min: 1, max: 8, step: 0.1 } },
    })

    await expect(applyTrackEnhancements(track)).resolves.toEqual({ focusMode: true, zoom: 2 })
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] })
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 2 }] })
  })

  it('borne le zoom aux capacités annoncées', async () => {
    const track = createFakeTrack({ capabilities: { zoom: { min: 1, max: 1.5 } } })
    await expect(applyTrackEnhancements(track)).resolves.toEqual({ focusMode: false, zoom: 1.5 })
    expect(track.applyConstraints).toHaveBeenCalledTimes(1)
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 1.5 }] })
  })

  it('accepte un zoom exprimé en tableau de valeurs', async () => {
    const track = createFakeTrack({ capabilities: { zoom: [0.5, 1, 2, 4] } })
    await expect(applyTrackEnhancements(track)).resolves.toEqual({ focusMode: false, zoom: 2 })
  })

  it('ne touche à rien si la piste n’annonce ni focus ni zoom', async () => {
    const track = createFakeTrack({ capabilities: { facingMode: ['environment'], focusMode: ['manual'] } })
    await expect(applyTrackEnhancements(track)).resolves.toEqual({ focusMode: false, zoom: null })
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })

  it('ignore les pistes sans getCapabilities ou dont applyConstraints échoue', async () => {
    const noCaps = createFakeTrack({ capabilities: null })
    await expect(applyTrackEnhancements(noCaps)).resolves.toEqual({ focusMode: false, zoom: null })

    const failing = createFakeTrack({ capabilities: { focusMode: ['continuous'], zoom: { min: 1, max: 4 } } })
    failing.applyConstraints.mockRejectedValue(new Error('nope'))
    await expect(applyTrackEnhancements(failing)).resolves.toEqual({ focusMode: false, zoom: null })
    expect(failing.applyConstraints).toHaveBeenCalledTimes(2)
  })
})

describe('selectNextCamera', () => {
  const samsung: CameraDevice[] = [
    { deviceId: 'ultra', label: 'camera2 2, facing back' },
    { deviceId: 'front', label: 'camera2 1, facing front' },
    { deviceId: 'wide', label: 'camera2 0, facing back' },
  ]

  it('alterne uniquement entre les caméras arrière', () => {
    expect(selectNextCamera(samsung, 'ultra')).toEqual({ deviceId: 'wide', label: 'camera2 0, facing back' })
    expect(selectNextCamera(samsung, 'wide')).toEqual({ deviceId: 'ultra', label: 'camera2 2, facing back' })
  })

  it('reconnaît les libellés iPhone', () => {
    const iphone: CameraDevice[] = [
      { deviceId: 'a', label: 'Front Camera' },
      { deviceId: 'b', label: 'Back Camera' },
      { deviceId: 'c', label: 'Back Ultra Wide Camera' },
    ]
    expect(selectNextCamera(iphone, 'b')?.deviceId).toBe('c')
    expect(selectNextCamera(iphone, 'c')?.deviceId).toBe('b')
  })

  it('ne propose rien avec une seule caméra arrière identifiée', () => {
    const simple: CameraDevice[] = [
      { deviceId: 'back', label: 'Back Camera' },
      { deviceId: 'front', label: 'Front Camera' },
    ]
    expect(selectNextCamera(simple, 'back')).toBeNull()
    expect(selectNextCamera([simple[0]], 'back')).toBeNull()
  })

  it('alterne sur toutes les caméras quand les libellés sont inconnus', () => {
    const unlabelled: CameraDevice[] = [
      { deviceId: '1', label: '' },
      { deviceId: '2', label: '' },
    ]
    expect(selectNextCamera(unlabelled, '1')?.deviceId).toBe('2')
    expect(selectNextCamera(unlabelled, '2')?.deviceId).toBe('1')
    // Caméra courante inconnue : on part de la première.
    expect(selectNextCamera(unlabelled, null)?.deviceId).toBe('1')
  })
})

describe('useCamera', () => {
  it('démarre avec les contraintes préférées puis applique focus et zoom', async () => {
    const track = createFakeTrack({
      capabilities: { focusMode: ['continuous'], zoom: { min: 1, max: 4 } },
    })
    const mediaDevices = installMediaDevices({
      getUserMedia: vi.fn(async () => createFakeStream(track)),
    })

    const { result, video } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.active).toBe(true))
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: PREFERRED_VIDEO_CONSTRAINTS,
      audio: false,
    })
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] })
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 2 }] })
    expect(video.getAttribute('playsinline')).toBe('true')
    expect(result.current.error).toBeNull()
    expect(result.current.currentDeviceId).toBe('cam-main')
  })

  it('réessaie une fois avec les contraintes minimales après OverconstrainedError', async () => {
    const track = createFakeTrack()
    const getUserMedia = vi
      .fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValueOnce(new DOMException('width', 'OverconstrainedError'))
      .mockResolvedValueOnce(createFakeStream(track))
    installMediaDevices({ getUserMedia })

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.active).toBe(true))
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(getUserMedia.mock.calls[1][0]).toEqual({ video: MINIMAL_VIDEO_CONSTRAINTS, audio: false })
    expect(result.current.error).toBeNull()
  })

  it('remonte OverconstrainedError si le repli échoue aussi', async () => {
    const getUserMedia = vi
      .fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValue(new DOMException('still', 'OverconstrainedError'))
    installMediaDevices({ getUserMedia })

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect((result.current.error as DOMException).name).toBe('OverconstrainedError')
    expect(result.current.active).toBe(false)
  })

  it('ne réessaie pas pour les autres erreurs (NotAllowedError)', async () => {
    const getUserMedia = vi
      .fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    installMediaDevices({ getUserMedia })

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect((result.current.error as DOMException).name).toBe('NotAllowedError')
  })

  it('refuse de démarrer hors contexte sécurisé sans appeler getUserMedia', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    const mediaDevices = installMediaDevices({ getUserMedia: vi.fn() })

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.error).toBeInstanceOf(InsecureContextError))
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(result.current.active).toBe(false)
  })

  it('signale un navigateur sans mediaDevices', async () => {
    Reflect.deleteProperty(navigator, 'mediaDevices')

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.error).toBeInstanceOf(CameraUnsupportedError))
  })

  it('liste les caméras et bascule vers la caméra arrière suivante en deviceId exact', async () => {
    const ultraTrack = createFakeTrack({ deviceId: 'ultra' })
    const wideTrack = createFakeTrack({ deviceId: 'wide' })
    const getUserMedia = vi
      .fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockResolvedValueOnce(createFakeStream(ultraTrack))
      .mockResolvedValueOnce(createFakeStream(wideTrack))
    installMediaDevices({
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        videoInput('ultra', 'camera2 2, facing back'),
        videoInput('front', 'camera2 1, facing front'),
        videoInput('wide', 'camera2 0, facing back'),
      ]),
    })

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.canSwitchCamera).toBe(true))
    expect(result.current.devices).toHaveLength(3)
    expect(result.current.currentDeviceId).toBe('ultra')

    await act(async () => {
      await result.current.switchCamera()
    })

    expect(ultraTrack.stop).toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(getUserMedia.mock.calls[1][0]).toEqual({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
        deviceId: { exact: 'wide' },
      },
      audio: false,
    })
    await waitFor(() => expect(result.current.currentDeviceId).toBe('wide'))
    expect(result.current.active).toBe(true)
    expect(localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY)).toBe('wide')
  })

  it('ne propose pas de changement avec une seule caméra arrière', async () => {
    installMediaDevices({
      getUserMedia: vi.fn(async () => createFakeStream(createFakeTrack({ deviceId: 'back' }))),
      enumerateDevices: vi.fn(async () => [videoInput('back', 'Back Camera'), videoInput('front', 'Front Camera')]),
    })

    const { result } = renderCamera({ autoResumeOnVisible: false })

    await waitFor(() => expect(result.current.devices).toHaveLength(2))
    expect(result.current.canSwitchCamera).toBe(false)
  })

  it('n’ouvre pas la caméra lorsque enabled est false', async () => {
    const mediaDevices = installMediaDevices({ getUserMedia: vi.fn() })

    const { result } = renderCamera({ enabled: false, autoResumeOnVisible: false })

    await act(async () => {
      await Promise.resolve()
    })
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(result.current.active).toBe(false)
  })

  it('coupe les pistes et vide la vidéo au démontage', async () => {
    const track = createFakeTrack()
    installMediaDevices({ getUserMedia: vi.fn(async () => createFakeStream(track)) })

    const { result, unmount, video } = renderCamera({ autoResumeOnVisible: false })
    await waitFor(() => expect(result.current.active).toBe(true))

    unmount()

    expect(track.stop).toHaveBeenCalled()
    expect((video as HTMLVideoElement & { srcObject: unknown }).srcObject).toBeNull()
  })
})
