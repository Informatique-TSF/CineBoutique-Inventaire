import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { InventoryItem, InventoryLogEntry, InventoryLogEventType, Location, Product } from '../types/inventory'

import { resetInventoryHttpContextSnapshot, syncInventoryHttpContextSnapshot } from './inventoryHttpContext'

import {
  clearInventoryDraft,
  hasInventoryDraftContent,
  hasInventoryDraftSnapshotContent,
  loadInventoryDraft,
  readInventoryDraftShopId,
  syncInventoryDraft,
  type InventoryDraftPayload,
  type InventoryDraftSnapshot,
} from '@/lib/inventoryDraftStorage'
import { pwaUpdateStore } from '@/pwa/updateStore'
import type { ShopUser } from '@/types/user'

export type InventoryItemMutationResult = {
  status: 'added' | 'existing'
  item: InventoryItem
}

/** Informations sur le brouillon restauré au démarrage (comptage repris après un rechargement). */
export type RestoredDraftInfo = {
  savedAt: string
  itemCount: number
}

export interface InventoryContextValue {
  selectedUser: ShopUser | null
  countType: number | null
  location: Location | null
  sessionId: string | null
  items: InventoryItem[]
  logs: InventoryLogEntry[]
  restoredDraft: RestoredDraftInfo | null
  setSelectedUser: (user: ShopUser) => void
  setCountType: (type: number | null) => void
  setLocation: (location: Location | null) => void
  setSessionId: (sessionId: string | null) => void
  addOrIncrementItem: (product: Product, options?: { isManual?: boolean }) => InventoryItemMutationResult
  initializeItems: (
    entries: Array<{ product: Product; quantity?: number; isManual?: boolean; hasConflict?: boolean }>,
  ) => void
  setQuantity: (ean: string, quantity: number, options?: { promote?: boolean }) => void
  removeItem: (ean: string) => void
  reset: () => void
  clearSession: (options?: { preserveSnapshot?: boolean }) => void
  logEvent: (entry: { type: InventoryLogEventType; message: string; context?: InventoryLogEntry['context'] }) => void
  clearLogs: () => void
  dismissRestoredDraft: () => void
}

interface InventoryState {
  selectedUser: ShopUser | null
  countType: number | null
  location: Location | null
  sessionId: string | null
  items: InventoryItem[]
  logs: InventoryLogEntry[]
  userSnapshots: Record<string, InventorySnapshot>
  pendingSnapshotUserId: string | null
  restoredDraft: RestoredDraftInfo | null
}

type InventorySnapshot = {
  countType: number | null
  location: Location | null
  sessionId: string | null
  items: InventoryItem[]
  logs: InventoryLogEntry[]
}

/** Délai de regroupement des écritures du brouillon dans localStorage. */
export const INVENTORY_DRAFT_SAVE_DEBOUNCE_MS = 250

const cloneInventoryItems = (items: InventoryItem[]) =>
  items.map((item) => ({
    ...item,
    product: { ...item.product },
  }))

const cloneInventoryLogs = (logs: InventoryLogEntry[]) =>
  logs.map((entry) => ({
    ...entry,
    context: entry.context ? { ...entry.context } : undefined,
  }))

const createInitialState = (): InventoryState => ({
  selectedUser: null,
  countType: null,
  location: null,
  sessionId: null,
  items: [],
  logs: [],
  userSnapshots: {},
  pendingSnapshotUserId: null,
  restoredDraft: null,
})

const InventoryContext = createContext<InventoryContextValue | undefined>(undefined)

const createInventoryItemId = () => {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const randomSuffix = Math.random().toString(36).slice(2)
  return `inventory-item-${Date.now().toString(36)}-${randomSuffix}`
}

const createLogEntryId = () => {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const randomSuffix = Math.random().toString(36).slice(2)
  return `inventory-log-${Date.now().toString(36)}-${randomSuffix}`
}

const prependLogEntry = (
  logs: InventoryLogEntry[],
  entry: { type: InventoryLogEventType; message: string; context?: InventoryLogEntry['context'] },
) => [{ id: createLogEntryId(), timestamp: new Date().toISOString(), ...entry }, ...logs]

const toDraftSnapshot = (snapshot: InventorySnapshot): InventoryDraftSnapshot => ({
  countType: snapshot.countType,
  location: snapshot.location,
  sessionId: snapshot.sessionId,
  items: snapshot.items,
})

const toDraftPayload = (state: InventoryState): InventoryDraftPayload => {
  const userSnapshots: Record<string, InventoryDraftSnapshot> = {}
  for (const [userId, snapshot] of Object.entries(state.userSnapshots)) {
    userSnapshots[userId] = toDraftSnapshot(snapshot)
  }

  return {
    selectedUser: state.selectedUser,
    countType: state.countType,
    location: state.location,
    sessionId: state.sessionId,
    items: state.items,
    userSnapshots,
  }
}

/**
 * État initial : reprend le brouillon local de la boutique active s'il existe.
 * Les journaux ne sont pas persistés ; une entrée signale la reprise.
 */
const loadInitialState = (): InventoryState => {
  const base = createInitialState()
  const shopId = readInventoryDraftShopId()
  if (!shopId) {
    return base
  }

  const draft = loadInventoryDraft(shopId)
  if (!draft) {
    return base
  }

  if (!hasInventoryDraftContent(draft)) {
    clearInventoryDraft(shopId)
    return base
  }

  const userSnapshots: Record<string, InventorySnapshot> = {}
  for (const [userId, snapshot] of Object.entries(draft.userSnapshots)) {
    userSnapshots[userId] = { ...snapshot, logs: [] }
  }

  const restoredDraft: RestoredDraftInfo | null = hasInventoryDraftSnapshotContent(draft)
    ? { savedAt: draft.savedAt, itemCount: draft.items.length }
    : null

  const logs = restoredDraft
    ? prependLogEntry([], {
        type: 'status',
        message: `Comptage restauré depuis cet appareil (${restoredDraft.itemCount} article${
          restoredDraft.itemCount > 1 ? 's' : ''
        })`,
      })
    : []

  return {
    ...base,
    selectedUser: draft.selectedUser,
    countType: draft.countType,
    location: draft.location,
    sessionId: draft.sessionId,
    items: draft.items,
    logs,
    userSnapshots,
    restoredDraft,
  }
}

export const InventoryProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<InventoryState>(() => loadInitialState())
  const pendingDraftFlushRef = useRef<(() => void) | null>(null)
  const draftFlushTimerRef = useRef<number | null>(null)

  useEffect(() => {
    syncInventoryHttpContextSnapshot({
      selectedUser: state.selectedUser,
      sessionId: state.sessionId,
    })
  }, [state])

  useEffect(
    () => () => {
      resetInventoryHttpContextSnapshot()
    },
    [],
  )

  const flushPendingDraft = useCallback(() => {
    if (draftFlushTimerRef.current !== null) {
      window.clearTimeout(draftFlushTimerRef.current)
      draftFlushTimerRef.current = null
    }

    const flush = pendingDraftFlushRef.current
    pendingDraftFlushRef.current = null
    flush?.()
  }, [])

  // Le bandeau de mise à jour PWA recommande « Plus tard » tant que des lignes sont en cours.
  useEffect(() => {
    pwaUpdateStore.setCountInProgress(state.items.length > 0)
  }, [state.items.length])

  // Persistance locale (debounce) : chaque changement d'état replanifie une écriture.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const payload = toDraftPayload(state)
    pendingDraftFlushRef.current = () => {
      syncInventoryDraft(readInventoryDraftShopId(), payload)
    }

    if (draftFlushTimerRef.current !== null) {
      window.clearTimeout(draftFlushTimerRef.current)
    }
    draftFlushTimerRef.current = window.setTimeout(() => {
      draftFlushTimerRef.current = null
      flushPendingDraft()
    }, INVENTORY_DRAFT_SAVE_DEBOUNCE_MS)
  }, [flushPendingDraft, state])

  // Écriture synchrone quand la page est masquée / quittée (iOS peut tuer la PWA sans préavis).
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handlePageHide = () => {
      flushPendingDraft()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingDraft()
      }
    }

    window.addEventListener('pagehide', handlePageHide)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      flushPendingDraft()
    }
  }, [flushPendingDraft])

  const setSelectedUser = useCallback((user: ShopUser) => {
    setState((prev) => {
      if (prev.selectedUser?.id === user.id) {
        if (prev.selectedUser === user && prev.pendingSnapshotUserId === null) {
          return prev
        }

        return {
          ...prev,
          selectedUser: user,
          pendingSnapshotUserId: null,
        }
      }

      const previousUserId = prev.selectedUser?.id ?? null
      const shouldSkipPreviousSnapshot =
        previousUserId !== null && previousUserId === prev.pendingSnapshotUserId

      const snapshots = { ...prev.userSnapshots }

      if (previousUserId && previousUserId !== user.id && !shouldSkipPreviousSnapshot) {
        snapshots[previousUserId] = {
          countType: prev.countType,
          location: prev.location,
          sessionId: prev.sessionId,
          items: cloneInventoryItems(prev.items),
          logs: cloneInventoryLogs(prev.logs),
        }
      }

      const nextSnapshot = snapshots[user.id]

      return {
        ...prev,
        selectedUser: user,
        countType: nextSnapshot?.countType ?? null,
        location: nextSnapshot?.location ?? null,
        sessionId: nextSnapshot?.sessionId ?? null,
        items: nextSnapshot ? cloneInventoryItems(nextSnapshot.items) : [],
        logs: nextSnapshot ? cloneInventoryLogs(nextSnapshot.logs) : [],
        userSnapshots: snapshots,
        pendingSnapshotUserId: null,
        restoredDraft: null,
      }
    })
  }, [])

  const setCountType = useCallback((type: number | null) => {
    setState((prev) => ({
      ...prev,
      countType: type,
      pendingSnapshotUserId: null,
    }))
  }, [])

  const setLocation = useCallback((location: Location | null) => {
    setState((prev) => ({
      ...prev,
      location,
      pendingSnapshotUserId: null,
    }))
  }, [])

  const setSessionId = useCallback((sessionId: string | null) => {
    setState((prev) => ({
      ...prev,
      sessionId,
      pendingSnapshotUserId: null,
    }))
  }, [])

  const addOrIncrementItem = useCallback(
    (product: Product, options?: { isManual?: boolean }): InventoryItemMutationResult => {
      let mutationResult: InventoryItemMutationResult | null = null
      setState((prev) => {
        const existingIndex = prev.items.findIndex((item) => item.product.ean === product.ean)
        const timestamp = new Date().toISOString()
        if (existingIndex >= 0) {
          const existing = prev.items[existingIndex]
          const updated: InventoryItem = {
            ...existing,
            lastScanAt: timestamp,
            isManual: existing.isManual || Boolean(options?.isManual),
          }
          const remaining = prev.items.filter((_, index) => index !== existingIndex)
          mutationResult = { status: 'existing', item: updated }
          return {
            ...prev,
            items: [updated, ...remaining],
            pendingSnapshotUserId: null,
            logs: prependLogEntry(prev.logs, {
              type: 'item-rescanned',
              message: `${updated.product.name} relu (EAN ${updated.product.ean})  quantité ${updated.quantity}`,
              context: {
                ean: updated.product.ean,
                productName: updated.product.name,
                quantity: updated.quantity,
                isManual: updated.isManual,
              },
            }),
          }
        }
        const nextItem: InventoryItem = {
          id: createInventoryItemId(),
          product,
          quantity: 1,
          lastScanAt: timestamp,
          isManual: Boolean(options?.isManual),
          addedAt: Date.now(),
        }
        mutationResult = { status: 'added', item: nextItem }
        return {
          ...prev,
          items: [nextItem, ...prev.items],
          pendingSnapshotUserId: null,
          logs: prependLogEntry(prev.logs, {
            type: 'item-added',
            message: `${product.name} ${options?.isManual ? 'ajouté manuellement' : 'ajouté à la session'} (EAN ${product.ean})`,
            context: {
              ean: product.ean,
              productName: product.name,
              quantity: nextItem.quantity,
              isManual: nextItem.isManual,
            },
          }),
        }
      })
      if (!mutationResult) {
        return {
          status: 'added',
          item: {
            id: createInventoryItemId(),
            product: { ...product },
            quantity: 1,
            lastScanAt: new Date().toISOString(),
            isManual: Boolean(options?.isManual),
            addedAt: Date.now(),
          },
        }
      }
      return mutationResult
    },
    [],
  )

  const initializeItems = useCallback<InventoryContextValue['initializeItems']>((entries) => {
    setState((prev) => {
      const now = new Date()
      const baseTimestamp = now.getTime()
      const isoTimestamp = now.toISOString()
      const items: InventoryItem[] = entries.map((entry, index) => ({
        id: createInventoryItemId(),
        product: entry.product,
        quantity: typeof entry.quantity === 'number' ? entry.quantity : 0,
        lastScanAt: isoTimestamp,
        isManual: Boolean(entry.isManual),
        addedAt: baseTimestamp + index,
        hasConflict: entry.hasConflict,
      }))

      return {
        ...prev,
        items,
        logs: prev.logs,
        pendingSnapshotUserId: null,
      }
    })
  }, [])

  const setQuantity = useCallback(
    (ean: string, quantity: number, options?: { promote?: boolean }) => {
      setState((prev) => {
        const index = prev.items.findIndex((item) => item.product.ean === ean)
        if (index < 0) {
          return prev
        }

        const existing = prev.items[index]
        const timestamp = new Date().toISOString()
        const updated: InventoryItem = {
          ...existing,
          quantity,
          lastScanAt: timestamp,
        }

        const promote = options?.promote ?? true
        const items = promote
          ? [updated, ...prev.items.filter((_, itemIndex) => itemIndex !== index)]
          : prev.items.map((entry, itemIndex) => (itemIndex === index ? updated : entry))

        return {
          ...prev,
          items,
          pendingSnapshotUserId: null,
          logs: prependLogEntry(prev.logs, {
            type: 'item-quantity-updated',
            message: `Quantité mise à jour pour ${updated.product.name} (EAN ${updated.product.ean}) → ${quantity}`,
            context: {
              ean: updated.product.ean,
              productName: updated.product.name,
              quantity,
              isManual: updated.isManual,
            },
          }),
        }
      })
    },
    [],
  )

  const removeItem = useCallback((ean: string) => {
    setState((prev) => {
      const index = prev.items.findIndex((item) => item.product.ean === ean)
      if (index < 0) {
        return prev
      }

      const item = prev.items[index]
      const remaining = prev.items.filter((_, itemIndex) => itemIndex !== index)
      return {
        ...prev,
        items: remaining,
        pendingSnapshotUserId: null,
        logs: prependLogEntry(prev.logs, {
          type: 'item-removed',
          message: `${item.product.name} retiré de la session (EAN ${item.product.ean})`,
          context: {
            ean: item.product.ean,
            productName: item.product.name,
            quantity: item.quantity,
            isManual: item.isManual,
          },
        }),
      }
    })
  }, [])

  const reset = useCallback(() => {
    // Suppression immédiate du brouillon de la boutique courante (avant un éventuel changement de boutique).
    clearInventoryDraft(readInventoryDraftShopId())
    setState(() => createInitialState())
  }, [])

  const clearSession = useCallback(
    (options?: { preserveSnapshot?: boolean }) =>
      setState((prev) => {
        const selectedUserId = prev.selectedUser?.id ?? null
        const shouldPreserve = Boolean(options?.preserveSnapshot && selectedUserId)

        let snapshots = prev.userSnapshots
        if (selectedUserId) {
          if (shouldPreserve) {
            snapshots = {
              ...prev.userSnapshots,
              [selectedUserId]: {
                countType: prev.countType,
                location: prev.location,
                sessionId: prev.sessionId,
                items: cloneInventoryItems(prev.items),
                logs: cloneInventoryLogs(prev.logs),
              },
            }
          } else if (prev.userSnapshots[selectedUserId]) {
            snapshots = {
              ...prev.userSnapshots,
              [selectedUserId]: {
                countType: prev.countType,
                location: prev.location,
                sessionId: null,
                items: [],
                logs: [],
              },
            }
          }
        }

        return {
          ...prev,
          sessionId: null,
          items: [],
          logs: [],
          userSnapshots: snapshots,
          pendingSnapshotUserId: shouldPreserve ? selectedUserId : null,
          restoredDraft: null,
        }
      }),
    [],
  )

  const logEvent = useCallback<InventoryContextValue['logEvent']>((entry) => {
    setState((prev) => ({
      ...prev,
      logs: prependLogEntry(prev.logs, entry),
      pendingSnapshotUserId: null,
    }))
  }, [])

  const clearLogs = useCallback(
    () =>
      setState((prev) => ({
        ...prev,
        logs: [],
        pendingSnapshotUserId: null,
      })),
    [],
  )

  const dismissRestoredDraft = useCallback(
    () =>
      setState((prev) => {
        if (!prev.restoredDraft) {
          return prev
        }
        return { ...prev, restoredDraft: null }
      }),
    [],
  )

  const value = useMemo<InventoryContextValue>(
    () => ({
      selectedUser: state.selectedUser,
      countType: state.countType,
      location: state.location,
      sessionId: state.sessionId,
      items: state.items,
      logs: state.logs,
      restoredDraft: state.restoredDraft,
      setSelectedUser,
      setCountType,
      setLocation,
      setSessionId,
      addOrIncrementItem,
      initializeItems,
      setQuantity,
      removeItem,
      reset,
      clearSession,
      logEvent,
      clearLogs,
      dismissRestoredDraft,
    }),
    [
      state,
      addOrIncrementItem,
      clearLogs,
      clearSession,
      dismissRestoredDraft,
      logEvent,
      removeItem,
      reset,
      setCountType,
      setLocation,
      initializeItems,
      setQuantity,
      setSelectedUser,
      setSessionId,
    ],
  )

  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useInventory = () => {
  const context = useContext(InventoryContext)
  if (!context) {
    throw new Error('useInventory doit être utilisé dans InventoryProvider')
  }
  return context
}
