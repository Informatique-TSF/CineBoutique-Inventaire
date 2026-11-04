import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { InventoryProvider, useInventory } from '../InventoryContext'

import type { Product } from '@/app/types/inventory'
import type { ShopUser } from '@/types/user'

const createUser = (overrides: Partial<ShopUser>): ShopUser => ({
  id: '00000000-0000-0000-0000-000000000000',
  shopId: '11111111-1111-1111-1111-111111111111',
  login: 'operator',
  displayName: 'Opéra Teur',
  isAdmin: false,
  disabled: false,
  ...overrides,
})

const sampleProduct: Product = {
  ean: '0123456789012',
  name: 'Produit test',
}

const renderInventory = () =>
  renderHook(() => useInventory(), {
    wrapper: InventoryProvider,
  })

describe('InventoryContext', () => {
  it('ajoute la quantité saisie, sans toucher à la quantité lors d’une simple relecture', () => {
    const { result } = renderInventory()

    act(() => {
      result.current.setSelectedUser(createUser({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }))
    })
    act(() => {
      result.current.addOrIncrementItem(sampleProduct, { quantity: 3 })
    })
    expect(result.current.items[0]?.quantity).toBe(3)

    act(() => {
      result.current.addOrIncrementItem(sampleProduct, { quantity: 2 })
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.quantity).toBe(5)
    expect(result.current.logs[0]?.message).toContain('+2, quantité 5')

    act(() => {
      result.current.addOrIncrementItem(sampleProduct)
      result.current.addOrIncrementItem(sampleProduct, { quantity: 0 })
    })
    expect(result.current.items[0]?.quantity).toBe(5)
  })

  it('restores scanned items when switching users', () => {
    const { result } = renderInventory()
    const getInventory = () => result.current

    const userA = createUser({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', login: 'operator.a' })
    const userB = createUser({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', login: 'operator.b' })

    act(() => {
      const inventory = getInventory()
      inventory.setSelectedUser(userA)
      inventory.addOrIncrementItem(sampleProduct)
      inventory.addOrIncrementItem(sampleProduct)
    })

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.quantity).toBe(1)

    act(() => {
      getInventory().setSelectedUser(userB)
    })

    expect(result.current.items).toHaveLength(0)

    act(() => {
      getInventory().setSelectedUser(userA)
    })

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.product.ean).toBe(sampleProduct.ean)
    expect(result.current.items[0]?.quantity).toBe(1)
  })

  it('restores items when the session is preserved before switching users', () => {
    const { result } = renderInventory()
    const getInventory = () => result.current

    const userA = createUser({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0000', login: 'operator.a' })
    const userB = createUser({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0000', login: 'operator.b' })

    act(() => {
      const inventory = getInventory()
      inventory.setSelectedUser(userA)
      inventory.addOrIncrementItem(sampleProduct)
    })

    expect(result.current.items).toHaveLength(1)

    act(() => {
      getInventory().clearSession({ preserveSnapshot: true })
    })

    expect(result.current.items).toHaveLength(0)

    act(() => {
      getInventory().setSelectedUser(userB)
    })

    expect(result.current.items).toHaveLength(0)

    act(() => {
      getInventory().setSelectedUser(userA)
    })

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.product.ean).toBe(sampleProduct.ean)
  })
})
