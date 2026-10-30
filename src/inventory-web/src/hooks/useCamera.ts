import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'

import { CameraUnsupportedError, InsecureContextError, isOverconstrainedError } from '@/lib/scan/cameraErrors'

export type CameraOptions = {
  /**
   * Contraintes de base (compatibilité). Seule la partie `video` est prise en compte :
   * elle est fusionnée par-dessus les contraintes « préférées » du hook.
   */
  constraints?: MediaStreamConstraints
  /** Si true, coupe la caméra quand l’onglet est caché et la relance quand il redevient visible */
  autoResumeOnVisible?: boolean
  /** Si false, le hook n’ouvre jamais la caméra (et la coupe si elle était ouverte). */
  enabled?: boolean
}

export type CameraDevice = {
  deviceId: string
  label: string
}

export type TrackEnhancements = {
  focusMode: boolean
  zoom: number | null
}

type StartOptions = {
  deviceId?: string | null
  exactDevice?: boolean
}

export type UseCameraResult = {
  active: boolean
  error: unknown
  start: (options?: StartOptions) => Promise<void>
  stop: () => void
  devices: CameraDevice[]
  currentDeviceId: string | null
  canSwitchCamera: boolean
  switchCamera: () => Promise<void>
}

type StreamEnabledVideo = HTMLVideoElement & { srcObject: MediaStream | null }

type MediaSettingsRange = { min?: number; max?: number; step?: number }
type ExtendedCapabilities = MediaTrackCapabilities & {
  focusMode?: string[]
  zoom?: MediaSettingsRange | number[]
  torch?: boolean
}
type ExtendedConstraintSet = MediaTrackConstraintSet & {
  focusMode?: string
  zoom?: number
}

/** Contraintes demandées en premier : 1080p / 30 fps sur la caméra arrière. */
export const PREFERRED_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
}

/** Contraintes de repli après `OverconstrainedError`. */
export const MINIMAL_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
}

/** Zoom cible appliqué quand la capacité existe (iPhone Safari 17+, Chrome Android). */
export const TARGET_ZOOM = 2

export const CAMERA_DEVICE_STORAGE_KEY = 'cb.scan.cameraDeviceId'

const BACK_CAMERA_LABEL = /\b(back|rear|arri[èe]re|environment|world|traseira|r[üu]ck)\b/i

const setVideoStream = (video: HTMLVideoElement, stream: MediaStream | null) => {
  ;(video as StreamEnabledVideo).srcObject = stream
}

const stopStream = (stream: MediaStream | null | undefined) => {
  if (!stream) {
    return
  }
  for (const track of stream.getTracks()) {
    if (typeof track.stop === 'function') {
      track.stop()
    }
  }
}

const readStoredDeviceId = (): string | null => {
  try {
    const value = localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

const persistDeviceId = (deviceId: string | null) => {
  try {
    if (deviceId) {
      localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, deviceId)
    } else {
      localStorage.removeItem(CAMERA_DEVICE_STORAGE_KEY)
    }
  } catch {
    // Stockage indisponible (navigation privée…) : on ignore.
  }
}

/**
 * Construit les contraintes vidéo. `deviceId` est appliqué en `exact` lors d’un
 * changement explicite de caméra, en `ideal` pour une préférence mémorisée (un
 * identifiant périmé ne doit pas faire échouer le démarrage).
 */
export const buildVideoConstraints = (
  base: MediaTrackConstraints,
  deviceId: string | null,
  options: { minimal?: boolean; exactDevice?: boolean } = {},
): MediaTrackConstraints => {
  const video: MediaTrackConstraints = options.minimal
    ? { ...MINIMAL_VIDEO_CONSTRAINTS }
    : { ...PREFERRED_VIDEO_CONSTRAINTS, ...base }
  if (deviceId) {
    delete video.facingMode
    video.deviceId = options.exactDevice ? { exact: deviceId } : { ideal: deviceId }
  }
  return video
}

const toRange = (value: MediaSettingsRange | number[] | undefined): { min: number; max: number } | null => {
  if (!value) {
    return null
  }
  if (Array.isArray(value)) {
    const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    if (numbers.length === 0) {
      return null
    }
    return { min: Math.min(...numbers), max: Math.max(...numbers) }
  }
  const { min, max } = value
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) {
    return null
  }
  return { min, max }
}

const readCapabilities = (track: MediaStreamTrack): ExtendedCapabilities | null => {
  if (typeof track.getCapabilities !== 'function') {
    return null
  }
  try {
    return track.getCapabilities() as ExtendedCapabilities
  } catch {
    return null
  }
}

/**
 * Applique la mise au point continue et un zoom modéré lorsque la piste les annonce.
 * Chaque réglage est indépendant : l’échec de l’un n’empêche pas l’autre.
 */
export const applyTrackEnhancements = async (track: MediaStreamTrack): Promise<TrackEnhancements> => {
  const result: TrackEnhancements = { focusMode: false, zoom: null }
  const capabilities = readCapabilities(track)
  if (!capabilities || typeof track.applyConstraints !== 'function') {
    return result
  }

  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
    try {
      const constraint: ExtendedConstraintSet = { focusMode: 'continuous' }
      await track.applyConstraints({ advanced: [constraint] })
      result.focusMode = true
    } catch {
      // Non bloquant.
    }
  }

  const zoomRange = toRange(capabilities.zoom)
  if (zoomRange && zoomRange.max > zoomRange.min) {
    const zoom = Math.min(Math.max(TARGET_ZOOM, zoomRange.min), zoomRange.max)
    try {
      const constraint: ExtendedConstraintSet = { zoom }
      await track.applyConstraints({ advanced: [constraint] })
      result.zoom = zoom
    } catch {
      // Non bloquant.
    }
  }

  return result
}

export const listVideoInputs = async (): Promise<CameraDevice[]> => {
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
    return []
  }
  try {
    const all = await mediaDevices.enumerateDevices()
    return all
      .filter((device) => device.kind === 'videoinput' && device.deviceId)
      .map((device) => ({ deviceId: device.deviceId, label: device.label ?? '' }))
  } catch {
    return []
  }
}

/**
 * Choisit la caméra suivante. Priorité aux caméras arrière (libellés « back »,
 * « rear », « arrière »…) pour permettre de quitter l’ultra grand-angle des Samsung.
 * Si une seule caméra arrière est identifiée, il n’y a rien à proposer. Si les
 * libellés sont inconnus (pas encore de permission), on alterne sur tout.
 */
export const selectNextCamera = (devices: CameraDevice[], currentDeviceId: string | null): CameraDevice | null => {
  if (devices.length < 2) {
    return null
  }
  const labelled = devices.filter((device) => device.label.trim().length > 0)
  const backCameras = labelled.filter((device) => BACK_CAMERA_LABEL.test(device.label))
  let pool: CameraDevice[]
  if (backCameras.length >= 2) {
    pool = backCameras
  } else if (backCameras.length === 1 && labelled.length === devices.length) {
    return null
  } else {
    pool = devices
  }
  const currentIndex = pool.findIndex((device) => device.deviceId === currentDeviceId)
  const next = pool[(currentIndex + 1) % pool.length]
  if (!next || next.deviceId === currentDeviceId) {
    return null
  }
  return next
}

const getUserMediaStream = async (
  base: MediaTrackConstraints,
  deviceId: string | null,
  exactDevice: boolean,
): Promise<MediaStream> => {
  const mediaDevices = navigator.mediaDevices
  try {
    return await mediaDevices.getUserMedia({
      video: buildVideoConstraints(base, deviceId, { exactDevice }),
      audio: false,
    })
  } catch (error) {
    if (!isOverconstrainedError(error)) {
      throw error
    }
    // Une seule nouvelle tentative, avec les contraintes minimales (sans deviceId).
    return mediaDevices.getUserMedia({
      video: buildVideoConstraints(base, null, { minimal: true }),
      audio: false,
    })
  }
}

export function useCamera(
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  { constraints, autoResumeOnVisible = true, enabled = true }: CameraOptions = {},
): UseCameraResult {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null)
  const startingRef = useRef(false)
  const sessionRef = useRef(0)
  const devicesRef = useRef<CameraDevice[]>([])
  const currentDeviceIdRef = useRef<string | null>(null)
  const preferredDeviceIdRef = useRef<string | null>(readStoredDeviceId())
  const baseVideoRef = useRef<MediaTrackConstraints>({})

  const baseVideo = constraints?.video
  useEffect(() => {
    baseVideoRef.current = baseVideo && typeof baseVideo === 'object' ? baseVideo : {}
  }, [baseVideo])

  const refreshDevices = useCallback(async () => {
    const list = await listVideoInputs()
    devicesRef.current = list
    setDevices(list)
  }, [])

  const stop = useCallback(() => {
    sessionRef.current += 1
    const el = videoRef.current
    const stream = el ? (el as StreamEnabledVideo).srcObject : null
    stopStream(stream)
    if (el) {
      el.pause()
      setVideoStream(el, null)
      el.removeAttribute('src')
    }
    setActive(false)
  }, [videoRef])

  const start = useCallback(
    async (options?: StartOptions) => {
      if (startingRef.current) return
      const el = videoRef.current
      if (!el) return
      startingRef.current = true
      const session = ++sessionRef.current
      setError(null)
      try {
        if (typeof window !== 'undefined' && window.isSecureContext === false) {
          throw new InsecureContextError()
        }
        if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
          throw new CameraUnsupportedError()
        }
        const requestedDeviceId =
          options?.deviceId !== undefined ? options.deviceId : preferredDeviceIdRef.current
        const stream = await getUserMediaStream(
          baseVideoRef.current,
          requestedDeviceId,
          Boolean(options?.exactDevice),
        )
        if (session !== sessionRef.current || videoRef.current !== el) {
          // `stop()` a été appelé pendant l’attente : on libère le flux obtenu.
          stopStream(stream)
          return
        }
        el.setAttribute('playsinline', 'true') // iOS
        el.muted = true
        setVideoStream(el, stream)
        await el.play().catch(() => undefined)
        const [track] = stream.getVideoTracks()
        if (track) {
          await applyTrackEnhancements(track)
          let settingsDeviceId: string | undefined
          try {
            settingsDeviceId = track.getSettings?.().deviceId
          } catch {
            settingsDeviceId = undefined
          }
          const resolvedDeviceId = settingsDeviceId ?? requestedDeviceId ?? null
          currentDeviceIdRef.current = resolvedDeviceId
          setCurrentDeviceId(resolvedDeviceId)
        }
        if (session !== sessionRef.current) {
          stopStream(stream)
          return
        }
        setActive(true)
        void refreshDevices()
      } catch (err) {
        if (session === sessionRef.current) {
          setError(err)
          setActive(false)
        }
      } finally {
        startingRef.current = false
      }
    },
    [refreshDevices, videoRef],
  )

  const switchCamera = useCallback(async () => {
    const next = selectNextCamera(devicesRef.current, currentDeviceIdRef.current)
    if (!next) {
      return
    }
    preferredDeviceIdRef.current = next.deviceId
    persistDeviceId(next.deviceId)
    stop()
    await start({ deviceId: next.deviceId, exactDevice: true })
  }, [start, stop])

  // Lance/arrête quand la balise <video> est disponible / quand le composant monte-démonte
  useEffect(() => {
    if (!enabled) {
      stop()
      return
    }
    const el = videoRef.current
    if (!el) return
    let cancelled = false
    ;(async () => {
      if (!cancelled) await start()
    })()
    return () => {
      cancelled = true
      stop()
    }
  }, [enabled, start, stop, videoRef])

  // Couper/reprendre sur visibilitychange (utile sur iOS/PWA)
  useEffect(() => {
    if (!autoResumeOnVisible || !enabled) return
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        // si le flux est déjà actif, ne rien faire
        if (!active) void start()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [active, autoResumeOnVisible, enabled, start, stop])

  const canSwitchCamera = useMemo(
    () => selectNextCamera(devices, currentDeviceId) !== null,
    [currentDeviceId, devices],
  )

  return { active, error, start, stop, devices, currentDeviceId, canSwitchCamera, switchCamera }
}
