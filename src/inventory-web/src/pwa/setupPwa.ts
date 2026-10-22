import { registerSW } from 'virtual:pwa-register'

import { createPwaUpdateController, type PwaUpdateController } from './pwaUpdateController'

let controller: PwaUpdateController | null = null

/**
 * Enregistre le service worker en mode « prompt » : la nouvelle version est proposée
 * via <UpdateToast /> et n'est appliquée (avec rechargement) qu'après confirmation.
 */
export const setupPwa = (): PwaUpdateController | null => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null
  }

  if (controller) {
    return controller
  }

  controller = createPwaUpdateController({
    registerSW,
    serviceWorkerContainer: navigator.serviceWorker,
    reload: () => window.location.reload(),
  })

  return controller
}
