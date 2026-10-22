import classNames from 'clsx'
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ChangeEvent, type MutableRefObject,
} from 'react'

import { useCamera } from '@/hooks/useCamera'
import {
  getBarcodeDetector,
  normalizeFormats,
  type DetectorEngine,
  type ScanDetector,
  type SupportedFormat,
} from '@/lib/scan/barcodeDetector'
import { describeCameraError } from '@/lib/scan/cameraErrors'

export type { SupportedFormat } from '@/lib/scan/barcodeDetector'

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean }
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean }
export type TorchState = { supported: boolean; enabled: boolean }
export type TorchController = {
  set: (on: boolean) => Promise<boolean>
  toggle: () => Promise<boolean>
}

type ExternalCameraBinding = {
  videoRef: MutableRefObject<HTMLVideoElement | null>
  active: boolean
  error?: unknown
}

interface BarcodeScannerProps {
  active: boolean
  onDetected: (value: string) => void | Promise<void>
  onError?: (reason: string) => void
  /** Si fourni, propose la prise de photo de secours (caméra indisponible ou aucune lecture). */
  onPickImage?: (file: File) => void
  enableTorchToggle?: boolean
  onTorchStateChange?: (state: TorchState) => void
  torchControllerRef?: MutableRefObject<TorchController | null>
  preferredFormats?: SupportedFormat[]
  presentation?: 'embedded' | 'immersive'
  /** Si fourni, on n'ouvre/ferme jamais la caméra ici : on se contente de lire le flux. */
  camera?: ExternalCameraBinding
  /** Notifie le moteur retenu (natif ou WebAssembly), utile pour le diagnostic. */
  onEngineChange?: (engine: DetectorEngine) => void
}

/** Délai sans lecture avant de proposer de l’aide (et la photo de secours). */
export const HELP_TIMEOUT_MS = 9000
/** Intervalle minimal entre deux analyses d’image (~16 images/s). */
export const MIN_DETECT_INTERVAL_MS = 60
const WATCHDOG_POLL_MS = 1500        // fréquence de vérification
const STALL_THRESHOLD_MS = 2500      // au-delà, on considère le pipeline « figé »
/** Zone d’intérêt centrée : 75 % de la largeur, 50 % de la hauteur. */
const ROI_WIDTH_RATIO = 0.75
const ROI_HEIGHT_RATIO = 0.5
/** Largeur maximale envoyée au décodeur (limite la charge sur mobile). */
const MAX_ROI_WIDTH = 1280

const STATUS_AIM = 'Visez le code‑barres'
const STATUS_INIT = 'Initialisation du lecteur…'
const STATUS_NO_DETECTION = 'Aucune détection, rapprochez‑vous ou améliorez l’éclairage.'

const ENGINE_LABELS: Record<DetectorEngine, string> = {
  native: 'natif',
  wasm: 'WebAssembly',
}

type FrameHandle = { kind: 'rvfc' | 'raf'; id: number }

const asMediaStream = (value: unknown): MediaStream | null =>
  typeof MediaStream !== 'undefined' && value instanceof MediaStream ? value : null

const scheduleFrame = (video: HTMLVideoElement, callback: () => void, forceRaf: boolean): FrameHandle => {
  if (!forceRaf && typeof video.requestVideoFrameCallback === 'function') {
    return { kind: 'rvfc', id: video.requestVideoFrameCallback(() => callback()) }
  }
  return { kind: 'raf', id: requestAnimationFrame(() => callback()) }
}

const cancelFrame = (video: HTMLVideoElement | null, handle: FrameHandle | null) => {
  if (!handle) return
  if (handle.kind === 'rvfc') {
    if (video && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(handle.id)
    }
    return
  }
  cancelAnimationFrame(handle.id)
}

export function BarcodeScanner({
  active,
  onDetected,
  onError,
  onPickImage,
  enableTorchToggle = true,
  onTorchStateChange,
  torchControllerRef,
  preferredFormats,
  presentation = 'embedded',
  camera,
  onEngineChange,
}: BarcodeScannerProps) {
  const internalVideoRef = useRef<HTMLVideoElement | null>(null)
  const videoRef = camera?.videoRef ?? internalVideoRef
  const usingExternalCamera = Boolean(camera)

  // Sans liaison externe, le composant gère lui-même la caméra (page de simulation, usage embarqué).
  const internalCamera = useCamera(internalVideoRef, {
    enabled: !usingExternalCamera && active,
    autoResumeOnVisible: true,
  })
  const cameraActive = usingExternalCamera ? Boolean(camera?.active) : internalCamera.active
  const cameraError = usingExternalCamera ? camera?.error : internalCamera.error

  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchEnabled, setTorchEnabled] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [engine, setEngine] = useState<DetectorEngine | null>(null)
  const torchEnabledRef = useRef(false)

  const detectorRef = useRef<ScanDetector | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  const frameRef = useRef<FrameHandle | null>(null)
  const helpTimeoutRef = useRef<number | null>(null)
  const processingRef = useRef(false)
  const detectInFlightRef = useRef(false)
  const activeRef = useRef(false)
  const loopSessionRef = useRef(0)
  const lastDetectAtRef = useRef(0)
  const lastFrameAtRef = useRef(0)
  const useRafRef = useRef(false)
  const watchdogIdRef = useRef<number | null>(null)
  const restartLoopRef = useRef<(() => void) | null>(null)

  // Clé stable : un tableau littéral passé en prop change d’identité à chaque rendu,
  // mais pas de contenu. On ne relance le pipeline que si les formats changent vraiment.
  const formatsKey = normalizeFormats(preferredFormats).join(',')
  const formats = useMemo(() => formatsKey.split(',') as SupportedFormat[], [formatsKey])

  const dispatchError = useCallback((message: string) => {
    setError(message)
    onError?.(message)
  }, [onError])

  const stopLoop = useCallback(() => {
    loopSessionRef.current += 1
    cancelFrame(videoRef.current, frameRef.current)
    frameRef.current = null
  }, [videoRef])

  const stopWatchdog = useCallback(() => {
    if (watchdogIdRef.current !== null) {
      window.clearInterval(watchdogIdRef.current)
      watchdogIdRef.current = null
    }
  }, [])

  const getCurrentStream = useCallback(() => asMediaStream(videoRef.current?.srcObject), [videoRef])

  const setTorch = useCallback(async (on: boolean) => {
    const stream = getCurrentStream()
    const [track] = stream?.getVideoTracks() ?? []
    if (!track?.applyConstraints) return false
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as TorchConstraintSet] })
      setTorchEnabled(on)
      return true
    } catch {
      dispatchError('Activation de la lampe impossible sur cet appareil.')
      return false
    }
  }, [dispatchError, getCurrentStream])

  const cleanup = useCallback(() => {
    stopLoop()
    stopWatchdog()
    if (helpTimeoutRef.current) { clearTimeout(helpTimeoutRef.current); helpTimeoutRef.current = null }
    processingRef.current = false
    detectInFlightRef.current = false
    lastFrameAtRef.current = 0
    restartLoopRef.current = null
  }, [stopLoop, stopWatchdog])

  useEffect(() => {
    torchEnabledRef.current = torchEnabled
  }, [torchEnabled])

  useEffect(() => {
    if (!onTorchStateChange) return
    onTorchStateChange({ supported: torchSupported, enabled: torchEnabled })
  }, [onTorchStateChange, torchEnabled, torchSupported])

  useEffect(() => {
    if (!onEngineChange || !engine) return
    onEngineChange(engine)
  }, [engine, onEngineChange])

  useEffect(() => {
    if (!torchControllerRef) return
    const controller: TorchController = {
      set: async (on: boolean) => await setTorch(on),
      toggle: async () => await setTorch(!torchEnabledRef.current),
    }
    torchControllerRef.current = controller
    return () => {
      if (torchControllerRef.current === controller) {
        torchControllerRef.current = null
      }
    }
  }, [setTorch, torchControllerRef])

  const scheduleHelp = useCallback(() => {
    if (helpTimeoutRef.current) clearTimeout(helpTimeoutRef.current)
    helpTimeoutRef.current = window.setTimeout(() => {
      setShowHelp(true)
      setStatus(STATUS_NO_DETECTION)
    }, HELP_TIMEOUT_MS)
  }, [])

  const handleDetectedValue = useCallback(async (value: string) => {
    if (!value || processingRef.current) return
    lastFrameAtRef.current = performance.now()
    processingRef.current = true
    setShowHelp(false)
    setStatus('Code détecté, traitement en cours…')
    try {
      await Promise.resolve(onDetected(value))
      setStatus(STATUS_AIM)
    } catch {
      dispatchError('Traitement du code détecté impossible. Réessayez.')
    } finally {
      // Ne pas arrêter/redémarrer le pipeline ici : la boucle reste vivante.
      processingRef.current = false
      if (activeRef.current) {
        scheduleHelp()
      }
    }
  }, [dispatchError, onDetected, scheduleHelp])

  /** Prépare la source à analyser : la zone centrale du flux, réduite si nécessaire. */
  const captureRoi = useCallback((video: HTMLVideoElement): ImageBitmapSource | null => {
    const { videoWidth, videoHeight } = video
    if (!videoWidth || !videoHeight) return null
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas')
      contextRef.current = canvasRef.current.getContext('2d', { willReadFrequently: true })
    }
    const canvas = canvasRef.current
    const context = contextRef.current
    if (!canvas || !context) {
      // Pas de canvas 2D (environnement réduit) : on analyse l’image entière.
      return video
    }
    const cropW = Math.floor(videoWidth * ROI_WIDTH_RATIO)
    const cropH = Math.floor(videoHeight * ROI_HEIGHT_RATIO)
    const cropX = Math.floor((videoWidth - cropW) / 2)
    const cropY = Math.floor((videoHeight - cropH) / 2)
    const scale = Math.min(1, MAX_ROI_WIDTH / cropW)
    const targetW = Math.max(1, Math.round(cropW * scale))
    const targetH = Math.max(1, Math.round(cropH * scale))
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
    }
    context.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH)
    return canvas
  }, [])

  const detectOnce = useCallback(async () => {
    const video = videoRef.current
    const detector = detectorRef.current
    if (!video || !detector) return
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const source = captureRoi(video)
    if (!source) return
    detectInFlightRef.current = true
    try {
      const results = await detector.detect(source)
      const match = results.find((result) => result.rawValue && result.rawValue.trim())
      if (match) {
        await handleDetectedValue(match.rawValue.trim())
      }
    } catch {
      // Erreur transitoire du décodeur : on retentera à l’image suivante.
    } finally {
      detectInFlightRef.current = false
    }
  }, [captureRoi, handleDetectedValue, videoRef])

  const startLoop = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    stopLoop()
    const session = loopSessionRef.current
    lastFrameAtRef.current = performance.now()

    const tick = () => {
      if (!activeRef.current || session !== loopSessionRef.current) return
      const now = performance.now()
      lastFrameAtRef.current = now
      const shouldDetect =
        !detectInFlightRef.current &&
        !processingRef.current &&
        now - lastDetectAtRef.current >= MIN_DETECT_INTERVAL_MS
      if (shouldDetect) {
        lastDetectAtRef.current = now
        void detectOnce()
      }
      if (session !== loopSessionRef.current) return
      frameRef.current = scheduleFrame(video, tick, useRafRef.current)
    }

    frameRef.current = scheduleFrame(video, tick, useRafRef.current)
  }, [detectOnce, stopLoop, videoRef])

  useEffect(() => {
    restartLoopRef.current = startLoop
  }, [startLoop])

  const startWatchdog = useCallback(() => {
    if (watchdogIdRef.current !== null) return
    watchdogIdRef.current = window.setInterval(() => {
      const now = performance.now()
      const last = lastFrameAtRef.current || 0
      if (!activeRef.current || processingRef.current || now - last <= STALL_THRESHOLD_MS) return
      // Les images n’arrivent plus : on relance la lecture vidéo et la boucle (en rAF,
      // qui ne dépend pas de l’arrivée de nouvelles images).
      const video = videoRef.current
      if (video?.paused) {
        void video.play().catch(() => undefined)
      }
      useRafRef.current = true
      restartLoopRef.current?.()
    }, WATCHDOG_POLL_MS) as unknown as number
  }, [videoRef])

  // Démarrage/arrêt de la détection
  useEffect(() => {
    activeRef.current = active && cameraActive
    if (!activeRef.current) {
      cleanup()
      setStatus('')
      setError(null)
      setShowHelp(false)
      setTorchSupported(false)
      setTorchEnabled(false)
      return
    }

    const el = videoRef.current
    if (!el) return

    setStatus(STATUS_INIT)
    setError(null)
    setShowHelp(false)

    const stream = asMediaStream(el.srcObject)
    const [track] = stream?.getVideoTracks?.() ?? []
    const caps = track?.getCapabilities?.() as TorchCapabilities | undefined
    setTorchSupported(Boolean(caps?.torch))
    setTorchEnabled(false)

    let cancelled = false
    ;(async () => {
      try {
        const detector = await getBarcodeDetector(formats)
        if (cancelled) return
        detectorRef.current = detector
        setEngine(detector.engine)
        setStatus(STATUS_AIM)
        useRafRef.current = false
        lastDetectAtRef.current = 0
        startLoop()
        startWatchdog()
        scheduleHelp()
      } catch {
        if (!cancelled) dispatchError('Initialisation du lecteur impossible.')
      }
    })()

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        stopLoop()
      } else if (activeRef.current && detectorRef.current) {
        startLoop()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      cleanup()
    }
  }, [active, cameraActive, cleanup, dispatchError, formats, scheduleHelp, startLoop, startWatchdog, stopLoop, videoRef])

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!onPickImage) return
    const [file] = Array.from(event.target.files ?? [])
    if (file) onPickImage(file)
    event.target.value = ''
  }

  const cameraErrorLabel = useMemo(() => {
    if (!cameraError) return null
    const { message, technical } = describeCameraError(cameraError)
    return technical ? `${message} (${technical})` : message
  }, [cameraError])

  const cameraUnavailable = Boolean(cameraError) && !cameraActive
  const photoFallbackVisible = Boolean(onPickImage) && (showHelp || cameraUnavailable)

  const containerClass = presentation === 'immersive'
    ? 'relative h-full w-full bg-black text-slate-100'
    : 'relative overflow-hidden rounded-3xl border border-slate-700 bg-black/80 text-slate-100'

  const videoClass = presentation === 'immersive'
    ? 'pointer-events-none h-full w-full object-cover will-change-transform'
    : 'h-64 w-full object-contain bg-black will-change-transform'

  return (
    <div className={containerClass} data-scan-engine={engine ?? undefined}>
      <div className={presentation === 'immersive' ? 'relative h-full w-full' : 'flex flex-col gap-3'}>
        <div className="relative h-full w-full">
          <video ref={videoRef} className={videoClass} muted playsInline autoPlay />
          {!cameraUnavailable && (
            <div
              className={classNames(
                'pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-brand-400/70',
                presentation === 'immersive' ? 'h-1/2 w-3/4 max-w-md' : 'h-32 w-64',
              )}
              aria-hidden
            />
          )}
        </div>
        {presentation !== 'immersive' && (
          <div className="space-y-2 px-4 pb-4">
            {status && <p className="text-sm text-brand-200">{status}</p>}
            {error && <p className="text-sm text-red-300">{error}</p>}
            {cameraErrorLabel && !usingExternalCamera && (
              <p className="text-sm text-red-300">Caméra indisponible : {cameraErrorLabel}</p>
            )}
            {!error && !status && active && !cameraUnavailable && (
              <p className="text-sm text-slate-200">Visez le code‑barres.</p>
            )}
            {engine && (
              <p className="text-xs text-slate-400">Moteur de lecture : {ENGINE_LABELS[engine]}</p>
            )}
            {showHelp && (
              <p className="text-xs text-amber-200">
                Aucune détection pour l’instant. Approchez le code, ajustez l’éclairage
                ou importez une photo.
              </p>
            )}
            {enableTorchToggle && (
              <button
                type="button"
                className="rounded-xl border border-slate-500 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:border-brand-400 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
                onClick={() => void setTorch(!torchEnabled)}
                disabled={!torchSupported}
              >
                {torchSupported ? (torchEnabled ? 'Éteindre la lampe' : 'Allumer la lampe') : 'Lampe non prise en charge'}
              </button>
            )}
            {photoFallbackVisible && (
              <label className="flex cursor-pointer flex-col gap-2 rounded-2xl border border-slate-500 bg-slate-800/40 p-3 text-sm text-slate-100 hover:border-brand-400">
                <span className="font-medium">Prendre une photo du code‑barres</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="text-xs text-slate-300"
                  onChange={handleImageChange}
                  data-testid="scan-photo-input"
                />
              </label>
            )}
          </div>
        )}
        {presentation === 'immersive' && (photoFallbackVisible || status) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex flex-col items-center gap-2 px-6">
            {photoFallbackVisible && (
              <label
                className="pointer-events-auto inline-flex cursor-pointer items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-slate-900 shadow-lg backdrop-blur transition hover:bg-white focus-within:ring-2 focus-within:ring-white/70"
                data-testid="scan-photo-fallback"
              >
                Prendre une photo du code‑barres
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={handleImageChange}
                  data-testid="scan-photo-input"
                />
              </label>
            )}
            {status && (
              <span className="rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-emerald-200 backdrop-blur">
                {status}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
