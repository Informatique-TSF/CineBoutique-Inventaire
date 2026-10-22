import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InventoryProvider, useInventory } from '../InventoryContext'

import type { Location, Product } from '@/app/types/inventory'
import { buildInventoryDraftKey } from '@/lib/inventoryDraftStorage'
import { SHOP_STORAGE_KEY } from '@/lib/shopStorage'
import { pwaUpdateStore } from '@/pwa/updateStore'
import type { Shop } from '@/types/shop'
import type { ShopUser } from '@/types/user'

const shop: Shop = { id: 'shop-persist', name: 'Boutique persistance', kind: 'boutique' }
const otherShop: Shop = { id: 'shop-autre', name: 'Autre boutique', kind: 'lumiere' }

const user: ShopUser = {
  id: 'user-persist',
  shopId: shop.id,
  login: 'persist',
  displayName: 'Opérateur Persistance',
  isAdmin: false,
  disabled: false,
}

const location: Location = {
  id: '22222222-2222-2222-2222-222222222222',
  code: 'RES',
  label: 'Réserve',
  disabled: false,
  isBusy: false,
  busyBy: null,
  activeRunId: null,
  activeCountType: null,
  activeStartedAtUtc: null,
  countStatuses: [],
}

const products: Product[] = [
  { ean: '3000000000001', name: 'Popcorn caramel', sku: 'POP-1' },
  { ean: '3000000000002', name: 'Soda cola', sku: 'SODA-1' },
  { ean: '3000000000003', name: 'Affiche collector', sku: 'AFF-1' },
]

const draftKey = buildInventoryDraftKey(shop.id)

const readDraft = () => {
  const raw = localStorage.getItem(draftKey)
  return raw ? (JSON.parse(raw) as { items: Array<{ quantity: number }>; sessionId: string | null }) : null
}

const renderInventory = () =>
  renderHook(() => useInventory(), {
    wrapper: InventoryProvider,
  })

describe('InventoryProvider — persistance locale du comptage', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(SHOP_STORAGE_KEY, JSON.stringify(shop))
    pwaUpdateStore.reset()
  })

  afterEach(() => {
    localStorage.clear()
    pwaUpdateStore.reset()
  })

  it('signale au store PWA qu’un comptage est en cours dès qu’il y a des lignes', () => {
    const { result } = renderInventory()
    expect(pwaUpdateStore.getSnapshot().countInProgress).toBe(false)

    act(() => {
      result.current.setSelectedUser(user)
      result.current.setLocation(location)
      result.current.setCountType(1)
      result.current.addOrIncrementItem(products[0])
    })
    expect(pwaUpdateStore.getSnapshot().countInProgress).toBe(true)

    act(() => {
      result.current.clearSession()
    })
    expect(pwaUpdateStore.getSnapshot().countInProgress).toBe(false)
  })

  it('restaure les articles, la zone, le comptage et le run après un démontage/remontage du provider', () => {
    const first = renderInventory()

    act(() => {
      const inventory = first.result.current
      inventory.setSelectedUser(user)
      inventory.setLocation(location)
      inventory.setCountType(2)
      inventory.setSessionId('run-persist')
      inventory.addOrIncrementItem(products[0])
      inventory.addOrIncrementItem(products[1], { isManual: true })
      inventory.addOrIncrementItem(products[2])
    })
    act(() => {
      first.result.current.setQuantity(products[0].ean, 5)
    })

    expect(first.result.current.items).toHaveLength(3)
    expect(first.result.current.restoredDraft).toBeNull()

    // Le démontage joue le rôle du rechargement de la page : le brouillon est écrit de façon synchrone.
    first.unmount()

    const persisted = readDraft()
    expect(persisted).not.toBeNull()
    expect(persisted?.items).toHaveLength(3)
    expect(persisted?.sessionId).toBe('run-persist')

    const second = renderInventory()
    const restored = second.result.current

    expect(restored.selectedUser).toEqual(user)
    expect(restored.location?.id).toBe(location.id)
    expect(restored.countType).toBe(2)
    expect(restored.sessionId).toBe('run-persist')
    expect(restored.items).toHaveLength(3)

    const byEan = new Map(restored.items.map((item) => [item.product.ean, item]))
    expect(byEan.get(products[0].ean)).toMatchObject({ quantity: 5, isManual: false, product: { name: 'Popcorn caramel' } })
    expect(byEan.get(products[1].ean)).toMatchObject({ quantity: 1, isManual: true, product: { sku: 'SODA-1' } })
    expect(byEan.get(products[2].ean)).toMatchObject({ quantity: 1, isManual: false })

    expect(restored.restoredDraft).toMatchObject({ itemCount: 3 })
    expect(typeof restored.restoredDraft?.savedAt).toBe('string')
    expect(restored.logs.some((entry) => entry.message.includes('Comptage restauré'))).toBe(true)

    act(() => {
      second.result.current.dismissRestoredDraft()
    })
    expect(second.result.current.restoredDraft).toBeNull()
    // Les lignes restent intactes après fermeture du bandeau.
    expect(second.result.current.items).toHaveLength(3)
  })

  it('écrit immédiatement le brouillon quand la page est masquée (pagehide / visibilitychange)', () => {
    const { result } = renderInventory()

    act(() => {
      result.current.setSelectedUser(user)
      result.current.setLocation(location)
      result.current.setCountType(1)
      result.current.addOrIncrementItem(products[0])
    })

    // Avant le délai de regroupement, rien n'est encore écrit.
    expect(readDraft()).toBeNull()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(readDraft()?.items).toHaveLength(1)

    act(() => {
      result.current.addOrIncrementItem(products[1])
    })
    expect(readDraft()?.items).toHaveLength(1)

    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Document.prototype, 'visibilityState', originalDescriptor)
      }
      delete (document as { visibilityState?: unknown }).visibilityState
    }

    expect(readDraft()?.items).toHaveLength(2)
  })

  it('ne restaure rien quand le brouillon appartient à une autre boutique', () => {
    const first = renderInventory()
    act(() => {
      first.result.current.setSelectedUser(user)
      first.result.current.setLocation(location)
      first.result.current.setCountType(1)
      first.result.current.addOrIncrementItem(products[0])
    })
    first.unmount()
    expect(readDraft()).not.toBeNull()

    localStorage.setItem(SHOP_STORAGE_KEY, JSON.stringify(otherShop))
    const second = renderInventory()

    expect(second.result.current.items).toHaveLength(0)
    expect(second.result.current.location).toBeNull()
    expect(second.result.current.restoredDraft).toBeNull()
    // Le brouillon de la première boutique n'est pas touché.
    expect(readDraft()).not.toBeNull()
  })

  it('ignore un brouillon corrompu et repart d’un état vide', () => {
    localStorage.setItem(draftKey, '{not json')

    const { result } = renderInventory()

    expect(result.current.items).toHaveLength(0)
    expect(result.current.restoredDraft).toBeNull()
    expect(localStorage.getItem(draftKey)).toBeNull()
  })

  it('supprime le brouillon après la fin du comptage (clearSession) et lors d’un reset', () => {
    const { result, unmount } = renderInventory()

    act(() => {
      result.current.setSelectedUser(user)
      result.current.setLocation(location)
      result.current.setCountType(1)
      result.current.setSessionId('run-done')
      result.current.addOrIncrementItem(products[0])
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(readDraft()).not.toBeNull()

    act(() => {
      result.current.clearSession()
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(readDraft()).toBeNull()

    act(() => {
      result.current.addOrIncrementItem(products[1])
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(readDraft()).not.toBeNull()

    act(() => {
      result.current.reset()
    })
    // reset() supprime le brouillon immédiatement, sans attendre le délai de regroupement.
    expect(readDraft()).toBeNull()

    unmount()
    expect(readDraft()).toBeNull()
  })

  it('conserve le comptage d’un autre utilisateur via les instantanés persistés', () => {
    const otherUser: ShopUser = { ...user, id: 'user-bis', login: 'bis', displayName: 'Opérateur Bis' }
    const first = renderInventory()

    act(() => {
      first.result.current.setSelectedUser(user)
      first.result.current.setLocation(location)
      first.result.current.setCountType(1)
      first.result.current.addOrIncrementItem(products[0])
      first.result.current.addOrIncrementItem(products[1])
    })
    act(() => {
      first.result.current.setSelectedUser(otherUser)
    })
    expect(first.result.current.items).toHaveLength(0)
    first.unmount()

    const second = renderInventory()
    expect(second.result.current.selectedUser?.id).toBe(otherUser.id)
    expect(second.result.current.items).toHaveLength(0)

    act(() => {
      second.result.current.setSelectedUser(user)
    })
    expect(second.result.current.items).toHaveLength(2)
    expect(second.result.current.location?.id).toBe(location.id)
  })
})
