import { useSyncExternalStore } from 'react'

import { Button } from '@/app/components/ui/Button'

import { pwaUpdateStore } from './updateStore'

/**
 * Bandeau « Nouvelle version disponible » (mode prompt du service worker).
 * Aucun bouton ne reçoit le focus automatiquement : une douchette tape dans le champ
 * de scan actif et un vol de focus casserait le comptage.
 */
export const UpdateToast = () => {
  const { updateAvailable, countInProgress } = useSyncExternalStore(
    pwaUpdateStore.subscribe,
    pwaUpdateStore.getSnapshot,
    pwaUpdateStore.getServerSnapshot,
  )

  if (!updateAvailable) {
    return null
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pwa-update-toast"
      data-count-in-progress={countInProgress ? 'true' : 'false'}
      className="fixed inset-x-4 bottom-4 z-[10000] mx-auto max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm text-white shadow-elev-2"
    >
      <p className="font-semibold">Nouvelle version disponible</p>
      {countInProgress ? (
        <p className="mt-1 text-amber-200" data-testid="pwa-update-count-warning">
          Un comptage est en cours sur cet appareil. Terminez-le avant de mettre à jour : la mise à jour
          recharge l’application (vos lignes restent sauvegardées sur cet appareil).
        </p>
      ) : (
        <p className="mt-1 text-slate-200">
          Mettez à jour pour profiter des dernières corrections. L’application sera rechargée.
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant={countInProgress ? 'primary' : 'secondary'}
          onClick={pwaUpdateStore.dismissUpdate}
          data-testid="pwa-update-later"
          data-default-action={countInProgress ? 'true' : 'false'}
        >
          Plus tard
        </Button>
        <Button
          type="button"
          size="sm"
          variant={countInProgress ? 'secondary' : 'primary'}
          onClick={pwaUpdateStore.acceptUpdate}
          data-testid="pwa-update-apply"
          data-default-action={countInProgress ? 'false' : 'true'}
        >
          Mettre à jour
        </Button>
      </div>
    </div>
  )
}
