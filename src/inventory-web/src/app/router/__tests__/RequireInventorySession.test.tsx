import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InventoryProvider } from '@/app/contexts/InventoryContext'
import RequireInventorySession from '@/app/router/RequireInventorySession'
import type { Location } from '@/app/types/inventory'
import { INVENTORY_DRAFT_VERSION, buildInventoryDraftKey, type InventoryDraft } from '@/lib/inventoryDraftStorage'
import { SHOP_STORAGE_KEY } from '@/lib/shopStorage'
import type { Shop } from '@/types/shop'
import type { ShopUser } from '@/types/user'

const shop: Shop = { id: 'shop-guard', name: 'Boutique garde', kind: 'boutique' }

const user: ShopUser = {
  id: 'user-guard',
  shopId: shop.id,
  login: 'guard',
  displayName: 'Opérateur Garde',
  isAdmin: false,
  disabled: false,
}

const location: Location = {
  id: '33333333-3333-3333-3333-333333333333',
  code: 'SAL',
  label: 'Salle',
  disabled: false,
  isBusy: false,
  busyBy: null,
  activeRunId: null,
  activeCountType: null,
  activeStartedAtUtc: null,
  countStatuses: [],
}

const buildDraft = (overrides: Partial<InventoryDraft> = {}): InventoryDraft => ({
  version: INVENTORY_DRAFT_VERSION,
  shopId: shop.id,
  savedAt: '2026-10-22T09:00:00.000Z',
  selectedUser: user,
  countType: 1,
  location,
  sessionId: 'run-guard',
  items: [
    {
      id: 'item-1',
      product: { ean: '4000000000001', name: 'Produit garde' },
      quantity: 2,
      lastScanAt: '2026-10-22T08:59:00.000Z',
      isManual: false,
      addedAt: 1_760_000_000_000,
    },
  ],
  userSnapshots: {},
  ...overrides,
})

const renderGuard = () =>
  render(
    <InventoryProvider>
      <MemoryRouter initialEntries={['/inventory/session']}>
        <Routes>
          <Route path="/select-shop" element={<div data-testid="select-shop" />} />
          <Route path="/inventory/location" element={<div data-testid="location-step" />} />
          <Route path="/inventory/count-type" element={<div data-testid="count-type-step" />} />
          <Route element={<RequireInventorySession />}>
            <Route path="/inventory/session" element={<div data-testid="session-page" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </InventoryProvider>,
  )

describe('RequireInventorySession — reprise après rechargement', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(SHOP_STORAGE_KEY, JSON.stringify(shop))
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('laisse passer vers la session quand un brouillon valide a restauré zone et comptage', () => {
    localStorage.setItem(buildInventoryDraftKey(shop.id), JSON.stringify(buildDraft()))

    renderGuard()

    expect(screen.getByTestId('session-page')).toBeInTheDocument()
    expect(screen.queryByTestId('location-step')).not.toBeInTheDocument()
    expect(screen.queryByTestId('select-shop')).not.toBeInTheDocument()
  })

  it('redirige vers la sélection de boutique sans brouillon (aucun utilisateur en mémoire)', () => {
    renderGuard()

    expect(screen.getByTestId('select-shop')).toBeInTheDocument()
    expect(screen.queryByTestId('session-page')).not.toBeInTheDocument()
  })

  it('redirige vers la zone quand le brouillon restauré n’a pas de zone', () => {
    localStorage.setItem(buildInventoryDraftKey(shop.id), JSON.stringify(buildDraft({ location: null })))

    renderGuard()

    expect(screen.getByTestId('location-step')).toBeInTheDocument()
  })

  it('redirige vers le type de comptage quand le brouillon restauré n’a pas de comptage', () => {
    localStorage.setItem(buildInventoryDraftKey(shop.id), JSON.stringify(buildDraft({ countType: null })))

    renderGuard()

    expect(screen.getByTestId('count-type-step')).toBeInTheDocument()
  })

  it('ignore un brouillon corrompu et redirige comme sans brouillon', () => {
    localStorage.setItem(buildInventoryDraftKey(shop.id), '{"version":1,"items":')

    renderGuard()

    expect(screen.getByTestId('select-shop')).toBeInTheDocument()
    expect(localStorage.getItem(buildInventoryDraftKey(shop.id))).toBeNull()
  })
})
