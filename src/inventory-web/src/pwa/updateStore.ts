/**
 * Petit store externe (useSyncExternalStore) partagé entre le contrôleur PWA,
 * le bandeau de mise à jour et le contexte d'inventaire.
 *
 * - `updateAvailable` : un nouveau service worker est installé et attend une confirmation.
 * - `countInProgress` : un comptage contient des lignes sur cet appareil (le bandeau
 *   recommande alors « Plus tard » et explique la conséquence du rechargement).
 */
export type PwaUpdateSnapshot = {
  updateAvailable: boolean
  countInProgress: boolean
}

type Listener = () => void

const SERVER_SNAPSHOT: PwaUpdateSnapshot = { updateAvailable: false, countInProgress: false }

let snapshot: PwaUpdateSnapshot = { ...SERVER_SNAPSHOT }
/** Un service worker attend, même si le bandeau a été masqué avec « Plus tard ». */
let pendingUpdate = false
/** La mise à jour a été reportée pendant un comptage : on la reproposera à la fin du comptage. */
let deferredDuringCount = false
let applier: (() => void) | null = null
const listeners = new Set<Listener>()

const emit = () => {
  listeners.forEach((listener) => listener())
}

const patch = (next: Partial<PwaUpdateSnapshot>) => {
  const candidate: PwaUpdateSnapshot = { ...snapshot, ...next }
  if (
    candidate.updateAvailable === snapshot.updateAvailable &&
    candidate.countInProgress === snapshot.countInProgress
  ) {
    return
  }
  snapshot = candidate
  emit()
}

export const pwaUpdateStore = {
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getSnapshot: (): PwaUpdateSnapshot => snapshot,

  getServerSnapshot: (): PwaUpdateSnapshot => SERVER_SNAPSHOT,

  /** Appelé par le contrôleur quand un nouveau service worker est en attente. */
  notifyUpdateAvailable() {
    pendingUpdate = true
    deferredDuringCount = false
    patch({ updateAvailable: true })
  },

  /** « Plus tard » : masque le bandeau sans rien recharger. */
  dismissUpdate() {
    deferredDuringCount = snapshot.countInProgress
    patch({ updateAvailable: false })
  },

  /** « Mettre à jour » : masque le bandeau et délègue l'application au contrôleur. */
  acceptUpdate() {
    pendingUpdate = false
    deferredDuringCount = false
    patch({ updateAvailable: false })
    applier?.()
  },

  setCountInProgress(inProgress: boolean) {
    const reshow = !inProgress && snapshot.countInProgress && pendingUpdate && deferredDuringCount
    if (reshow) {
      deferredDuringCount = false
    }
    patch({ countInProgress: inProgress, updateAvailable: snapshot.updateAvailable || reshow })
  },

  registerUpdateApplier(fn: () => void) {
    applier = fn
    return () => {
      if (applier === fn) {
        applier = null
      }
    }
  },

  hasPendingUpdate: () => pendingUpdate,

  /** Réinitialisation complète (tests). */
  reset() {
    snapshot = { ...SERVER_SNAPSHOT }
    pendingUpdate = false
    deferredDuringCount = false
    applier = null
    emit()
  },
}

export type PwaUpdateStore = typeof pwaUpdateStore
