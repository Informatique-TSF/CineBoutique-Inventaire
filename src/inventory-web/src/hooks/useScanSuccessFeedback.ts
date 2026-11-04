import { useCallback, useEffect, useMemo, useRef } from 'react'

type AudioContextConstructor = typeof AudioContext

const getAudioContextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext ??
    null
  )
}

/**
 * Retour « code lu » : bip court et vibration brève (Android ; Safari iOS n’expose pas la vibration).
 *
 * Sur iOS, un contexte audio créé hors d’un geste reste muet : `unlock` doit être appelé
 * pendant un toucher (ex. : appui sur « Valider ») pour que les bips suivants soient audibles.
 */
export const useScanSuccessFeedback = () => {
  const contextRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    return () => {
      const context = contextRef.current
      contextRef.current = null
      if (context && context.state !== 'closed') {
        void context.close().catch(() => undefined)
      }
    }
  }, [])

  const ensureContext = useCallback(() => {
    if (contextRef.current) {
      return contextRef.current
    }
    const Constructor = getAudioContextConstructor()
    if (!Constructor) {
      return null
    }
    try {
      contextRef.current = new Constructor()
    } catch {
      contextRef.current = null
    }
    return contextRef.current
  }, [])

  const unlock = useCallback(() => {
    const context = ensureContext()
    if (context?.state === 'suspended') {
      void context.resume().catch(() => undefined)
    }
  }, [ensureContext])

  const play = useCallback(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(35)
      } catch {
        // Vibration refusée par le navigateur : le bip suffit.
      }
    }
    const context = ensureContext()
    if (!context) {
      return
    }
    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined)
    }
    const now = context.currentTime
    const oscillator = context.createOscillator()
    const gain = context.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(1046, now)

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)

    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.13)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
  }, [ensureContext])

  return useMemo(() => ({ play, unlock }), [play, unlock])
}
