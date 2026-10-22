import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BarcodeScanner, HELP_TIMEOUT_MS, type TorchController } from '../BarcodeScanner'

import type { ScanDetector } from '@/lib/scan/barcodeDetector'

const detectorMocks = vi.hoisted(() => ({
  getBarcodeDetector: vi.fn<() => Promise<ScanDetector>>(),
}))

vi.mock('@/lib/scan/barcodeDetector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scan/barcodeDetector')>()
  return { ...actual, getBarcodeDetector: detectorMocks.getBarcodeDetector }
})

vi.mock('@/hooks/useCamera', () => ({
  useCamera: () => ({
    active: false,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    devices: [],
    currentDeviceId: null,
    canSwitchCamera: false,
    switchCamera: vi.fn(),
  }),
}))

type DrawCall = [CanvasImageSource, number, number, number, number, number, number, number, number]

const canvasState = vi.hoisted(() => ({ drawCalls: [] as DrawCall[] }))

const originalGetContext = HTMLCanvasElement.prototype.getContext
const descriptors = {
  readyState: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState'),
  videoWidth: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth'),
  videoHeight: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight'),
}

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[]) {}
  getVideoTracks() {
    return this.tracks
  }
  getTracks() {
    return this.tracks
  }
}

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 })
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      drawImage: (...args: DrawCall) => {
        canvasState.drawCalls.push(args)
      },
    } as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  vi.stubGlobal('MediaStream', FakeMediaStream)
})

afterAll(() => {
  if (descriptors.readyState) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', descriptors.readyState)
  if (descriptors.videoWidth) Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', descriptors.videoWidth)
  if (descriptors.videoHeight) Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', descriptors.videoHeight)
  HTMLCanvasElement.prototype.getContext = originalGetContext
  vi.unstubAllGlobals()
})

const createDetector = (sequence: string[][], engine: 'native' | 'wasm' = 'native') => {
  const queue = sequence.map((frame) => frame.map((rawValue) => ({ rawValue })))
  const detect = vi.fn(async () => queue.shift() ?? [])
  detectorMocks.getBarcodeDetector.mockResolvedValue({ engine, detect })
  return { detect }
}

const renderScanner = (
  props: Partial<Parameters<typeof BarcodeScanner>[0]> = {},
  videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null },
) => {
  const onDetected = props.onDetected ?? vi.fn()
  const utils = render(
    <BarcodeScanner
      active
      onDetected={onDetected}
      presentation="immersive"
      camera={{ videoRef, active: true }}
      {...props}
    />,
  )
  return { ...utils, onDetected, videoRef }
}

beforeEach(() => {
  canvasState.drawCalls.length = 0
  detectorMocks.getBarcodeDetector.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BarcodeScanner (pipeline unique)', () => {
  it('analyse la zone centrale et remonte le code une seule fois', async () => {
    const { detect } = createDetector([[], ['3017620422003'], [], [], []])
    const onDetected = vi.fn(async () => undefined)

    renderScanner({ onDetected })

    await waitFor(() => expect(onDetected).toHaveBeenCalledTimes(1))
    expect(onDetected).toHaveBeenCalledWith('3017620422003')

    // La boucle continue à tourner après la lecture…
    const callsAfterDetection = detect.mock.calls.length
    await waitFor(() => expect(detect.mock.calls.length).toBeGreaterThan(callsAfterDetection + 1))
    // …sans ré-émettre un code que le détecteur ne voit plus.
    expect(onDetected).toHaveBeenCalledTimes(1)

    // Le détecteur reçoit la zone d’intérêt (75 % x 50 % du flux 640x480), pas l’image entière.
    const [source] = detect.mock.calls[0] as unknown as [HTMLCanvasElement]
    expect(source).toBeInstanceOf(HTMLCanvasElement)
    expect(source.width).toBe(480)
    expect(source.height).toBe(240)
    const [, sx, sy, sw, sh] = canvasState.drawCalls[0]
    expect([sx, sy, sw, sh]).toEqual([80, 120, 480, 240])
  })

  it('remonte chaque code distinct et expose le moteur retenu', async () => {
    createDetector([['111111'], [], ['222222'], []], 'wasm')
    const onDetected = vi.fn()
    const onEngineChange = vi.fn()

    const { container } = renderScanner({ onDetected, onEngineChange })

    await waitFor(() => expect(onDetected).toHaveBeenCalledTimes(2))
    expect(onDetected.mock.calls.map(([value]) => value)).toEqual(['111111', '222222'])
    expect(onEngineChange).toHaveBeenCalledWith('wasm')
    expect(container.firstElementChild).toHaveAttribute('data-scan-engine', 'wasm')
  })

  it('ignore les valeurs vides et nettoie les espaces', async () => {
    createDetector([['   '], ['  42  '], []])
    const onDetected = vi.fn()

    renderScanner({ onDetected })

    await waitFor(() => expect(onDetected).toHaveBeenCalledWith('42'))
    expect(onDetected).toHaveBeenCalledTimes(1)
  })

  it('signale une erreur si le lecteur ne peut pas s’initialiser', async () => {
    detectorMocks.getBarcodeDetector.mockRejectedValue(new Error('wasm introuvable'))
    const onError = vi.fn()

    renderScanner({ onError, presentation: 'embedded' })

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Initialisation du lecteur impossible.'))
    expect(screen.getByText('Initialisation du lecteur impossible.')).toBeInTheDocument()
  })

  it('propose la photo de secours après 9 s sans lecture et transmet le fichier', async () => {
    vi.useFakeTimers()
    createDetector([])
    const onPickImage = vi.fn()

    renderScanner({ onPickImage })

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('scan-photo-fallback')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(HELP_TIMEOUT_MS + 50)
    })

    expect(screen.getByTestId('scan-photo-fallback')).toBeInTheDocument()
    expect(screen.getByText('Aucune détection, rapprochez‑vous ou améliorez l’éclairage.')).toBeInTheDocument()

    const input = screen.getByTestId('scan-photo-input') as HTMLInputElement
    expect(input).toHaveAttribute('accept', 'image/*')
    expect(input).toHaveAttribute('capture', 'environment')
    const file = new File(['x'], 'code.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onPickImage).toHaveBeenCalledWith(file)
  })

  it('propose la photo de secours quand la caméra est indisponible', () => {
    createDetector([])
    const onPickImage = vi.fn()

    render(
      <BarcodeScanner
        active={false}
        onDetected={vi.fn()}
        onPickImage={onPickImage}
        presentation="immersive"
        camera={{ videoRef: { current: null }, active: false, error: new DOMException('denied', 'NotAllowedError') }}
      />,
    )

    expect(screen.getByTestId('scan-photo-fallback')).toBeInTheDocument()
    expect(detectorMocks.getBarcodeDetector).not.toHaveBeenCalled()
  })

  it('détecte la lampe sur la piste vidéo et la pilote via le contrôleur', async () => {
    createDetector([])
    const applyConstraints = vi.fn(async () => undefined)
    const track = {
      applyConstraints,
      getCapabilities: () => ({ torch: true }),
    } as unknown as MediaStreamTrack
    const stream = new FakeMediaStream([track])
    const onTorchStateChange = vi.fn()
    const torchControllerRef: MutableRefObject<TorchController | null> = { current: null }
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }

    const { rerender } = render(
      <BarcodeScanner
        active={false}
        onDetected={vi.fn()}
        onTorchStateChange={onTorchStateChange}
        torchControllerRef={torchControllerRef}
        presentation="immersive"
        camera={{ videoRef, active: false }}
      />,
    )
    ;(videoRef.current as unknown as { srcObject: unknown }).srcObject = stream
    rerender(
      <BarcodeScanner
        active
        onDetected={vi.fn()}
        onTorchStateChange={onTorchStateChange}
        torchControllerRef={torchControllerRef}
        presentation="immersive"
        camera={{ videoRef, active: true }}
      />,
    )

    await waitFor(() => expect(onTorchStateChange).toHaveBeenCalledWith({ supported: true, enabled: false }))

    await act(async () => {
      await expect(torchControllerRef.current?.toggle()).resolves.toBe(true)
    })
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] })
    await waitFor(() => expect(onTorchStateChange).toHaveBeenCalledWith({ supported: true, enabled: true }))
  })

  it('arrête la boucle et réinitialise l’état quand le scanner est désactivé', async () => {
    const { detect } = createDetector([])
    const videoRef: MutableRefObject<HTMLVideoElement | null> = { current: null }
    const { rerender } = renderScanner({}, videoRef)

    await waitFor(() => expect(detect).toHaveBeenCalled())

    rerender(
      <BarcodeScanner active={false} onDetected={vi.fn()} presentation="immersive" camera={{ videoRef, active: false }} />,
    )
    const callsAtStop = detect.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(detect.mock.calls.length).toBe(callsAtStop)
    expect(screen.queryByText('Visez le code‑barres')).not.toBeInTheDocument()
  })
})
