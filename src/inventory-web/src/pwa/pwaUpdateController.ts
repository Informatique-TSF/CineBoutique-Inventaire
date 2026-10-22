import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

import { pwaUpdateStore, type PwaUpdateStore } from './updateStore'

export type RegisterServiceWorker = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

/** Sous-ensemble de ServiceWorkerContainer utilisé ici (injectable dans les tests). */
export type ServiceWorkerContainerLike = {
  addEventListener: (type: 'controllerchange', listener: () => void) => void
  removeEventListener: (type: 'controllerchange', listener: () => void) => void
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined>
}

export const PWA_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
export const PWA_RELOAD_DELAY_MS = 150

export type PwaUpdateControllerOptions = {
  registerSW: RegisterServiceWorker
  store?: PwaUpdateStore
  reload?: () => void
  serviceWorkerContainer?: ServiceWorkerContainerLike | null
  checkIntervalMs?: number
  reloadDelayMs?: number
}

export type PwaUpdateController = {
  /** Demande au navigateur de vérifier s'il existe une nouvelle version (ne recharge jamais). */
  requestUpdateCheck: () => Promise<void>
  /** Applique la mise à jour en attente (équivaut au clic sur « Mettre à jour »). */
  applyUpdate: () => void
  dispose: () => void
}

/**
 * Mode « prompt » : le nouveau service worker reste en attente jusqu'à confirmation.
 * Le rechargement n'a lieu qu'après « Mettre à jour » ; les vérifications périodiques
 * (toutes les 30 min, au retour au premier plan, au focus) ne font que détecter une version.
 */
export const createPwaUpdateController = (options: PwaUpdateControllerOptions): PwaUpdateController => {
  const {
    registerSW,
    store = pwaUpdateStore,
    reload = () => window.location.reload(),
    serviceWorkerContainer = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker
      : null,
    checkIntervalMs = PWA_UPDATE_CHECK_INTERVAL_MS,
    reloadDelayMs = PWA_RELOAD_DELAY_MS,
  } = options

  let registration: ServiceWorkerRegistration | undefined
  let updateAccepted = false
  let intervalId: number | null = null
  let disposed = false

  const requestUpdateCheck = async () => {
    if (disposed) {
      return
    }

    try {
      if (!registration && serviceWorkerContainer) {
        registration = (await serviceWorkerContainer.getRegistration()) ?? undefined
      }
      await registration?.update()
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[pwa] vérification de mise à jour impossible', error)
      }
    }
  }

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      store.notifyUpdateAvailable()
    },
    onRegisteredSW(_swUrl, swRegistration) {
      registration = swRegistration
      void requestUpdateCheck()

      if (swRegistration && intervalId === null && !disposed) {
        // Évite que Safari iOS garde indéfiniment une version figée.
        intervalId = window.setInterval(() => {
          void requestUpdateCheck()
        }, checkIntervalMs)
      }
    },
    onRegisterError(error) {
      console.warn('[pwa] enregistrement du service worker impossible', error)
    },
  })

  const applyUpdate = () => {
    updateAccepted = true
    void updateServiceWorker(true).catch((error) => {
      console.warn('[pwa] application de la mise à jour impossible', error)
    })
  }

  const unregisterApplier = store.registerUpdateApplier(applyUpdate)

  // Rechargement uniquement après confirmation explicite de l'utilisateur.
  const handleControllerChange = () => {
    if (!updateAccepted) {
      return
    }
    window.setTimeout(reload, reloadDelayMs)
  }
  serviceWorkerContainer?.addEventListener('controllerchange', handleControllerChange)

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      void requestUpdateCheck()
    }
  }
  const handleFocus = () => {
    void requestUpdateCheck()
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('focus', handleFocus)

  const dispose = () => {
    disposed = true
    if (intervalId !== null) {
      window.clearInterval(intervalId)
      intervalId = null
    }
    serviceWorkerContainer?.removeEventListener('controllerchange', handleControllerChange)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('focus', handleFocus)
    unregisterApplier()
  }

  return { requestUpdateCheck, applyUpdate, dispose }
}
