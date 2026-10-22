import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as inventoryApi from '../../../api/inventoryApi'
import { InventoryProvider } from '../../../contexts/InventoryContext'
import type { Location } from '../../../types/inventory'
import { InventorySessionPage } from '../InventorySessionPage'

import { INVENTORY_DRAFT_VERSION, buildInventoryDraftKey, type InventoryDraft } from '@/lib/inventoryDraftStorage'
import { SHOP_STORAGE_KEY } from '@/lib/shopStorage'
import { ShopProvider } from '@/state/ShopContext'
import type { Shop } from '@/types/shop'
import type { ShopUser } from '@/types/user'

const fetchLocationsMock = vi.spyOn(inventoryApi, 'fetchLocations')
const startInventoryRunMock = vi.spyOn(inventoryApi, 'startInventoryRun')
const completeInventoryRunMock = vi.spyOn(inventoryApi, 'completeInventoryRun')
const releaseInventoryRunMock = vi.spyOn(inventoryApi, 'releaseInventoryRun')

const shop: Shop = { id: 'shop-resume', name: 'Boutique reprise', kind: 'boutique' }

const owner: ShopUser = {
  id: 'user-resume',
  shopId: shop.id,
  login: 'resume',
  displayName: 'Opérateur Reprise',
  isAdmin: false,
  disabled: false,
}

const RESTORED_RUN_ID = 'run-restored'

const baseLocation: Location = {
  id: '44444444-4444-4444-4444-444444444444',
  code: 'RES',
  label: 'Réserve',
  disabled: false,
  isBusy: false,
  busyBy: null,
  activeRunId: null,
  activeCountType: null,
  activeStartedAtUtc: null,
  countStatuses: [
    {
      countType: 1,
      status: 'not_started',
      runId: null,
      ownerDisplayName: null,
      ownerUserId: null,
      startedAtUtc: null,
      completedAtUtc: null,
    },
  ],
}

const locationWithOpenRun: Location = {
  ...baseLocation,
  isBusy: true,
  busyBy: owner.displayName,
  activeRunId: RESTORED_RUN_ID,
  activeCountType: 1,
  countStatuses: [
    {
      countType: 1,
      status: 'in_progress',
      runId: RESTORED_RUN_ID,
      ownerDisplayName: owner.displayName,
      ownerUserId: owner.id,
      startedAtUtc: new Date('2026-10-22T08:00:00.000Z'),
      completedAtUtc: null,
    },
  ],
}

const buildDraft = (overrides: Partial<InventoryDraft> = {}): InventoryDraft => ({
  version: INVENTORY_DRAFT_VERSION,
  shopId: shop.id,
  savedAt: '2026-10-22T09:00:00.000Z',
  selectedUser: owner,
  countType: 1,
  location: baseLocation,
  sessionId: RESTORED_RUN_ID,
  items: [
    {
      id: 'item-1',
      product: { ean: '5000000000001', name: 'Popcorn caramel', sku: 'POP-1' },
      quantity: 4,
      lastScanAt: '2026-10-22T08:58:00.000Z',
      isManual: false,
      addedAt: 1_760_000_000_000,
    },
    {
      id: 'item-2',
      product: { ean: '5000000000002', name: 'Soda cola', sku: 'SODA-1' },
      quantity: 1,
      lastScanAt: '2026-10-22T08:59:00.000Z',
      isManual: true,
      addedAt: 1_760_000_000_001,
    },
  ],
  userSnapshots: {},
  ...overrides,
})

const renderRestoredSessionPage = () =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/inventory/session' }]}>
      <ShopProvider>
        <InventoryProvider>
          <InventorySessionPage />
        </InventoryProvider>
      </ShopProvider>
    </MemoryRouter>,
  )

// jsdom n'implémente pas <dialog>.showModal : sans ce polyfill la page bascule sur window.confirm
// et la clôture serait déclenchée deux fois (confirm + bouton de confirmation).
const dialogPrototype = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void
  close?: () => void
}
const originalShowModal = dialogPrototype.showModal
const originalClose = dialogPrototype.close

beforeAll(() => {
  if (typeof dialogPrototype.showModal !== 'function') {
    dialogPrototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
  }
  if (typeof dialogPrototype.close !== 'function') {
    dialogPrototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
  }
})

afterAll(() => {
  dialogPrototype.showModal = originalShowModal
  dialogPrototype.close = originalClose
  fetchLocationsMock.mockRestore()
  startInventoryRunMock.mockRestore()
  completeInventoryRunMock.mockRestore()
  releaseInventoryRunMock.mockRestore()
})

describe('InventorySessionPage — reprise d’un comptage restauré', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(SHOP_STORAGE_KEY, JSON.stringify(shop))
    localStorage.setItem(buildInventoryDraftKey(shop.id), JSON.stringify(buildDraft()))
    fetchLocationsMock.mockReset()
    startInventoryRunMock.mockReset()
    completeInventoryRunMock.mockReset()
    releaseInventoryRunMock.mockReset()
    releaseInventoryRunMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('affiche les lignes restaurées et continue sur le même run quand il est toujours ouvert', async () => {
    fetchLocationsMock.mockResolvedValue([locationWithOpenRun])

    renderRestoredSessionPage()

    const scannedItems = await screen.findAllByTestId('scanned-item')
    expect(scannedItems).toHaveLength(2)
    expect(scannedItems.some((element) => /Popcorn caramel/.test(element.textContent ?? ''))).toBe(true)
    expect(scannedItems.some((element) => /Soda cola/.test(element.textContent ?? ''))).toBe(true)

    const quantityInputs = screen.getAllByTestId('quantity-input')
    expect(quantityInputs.map((input) => (input as HTMLInputElement).value).sort()).toEqual(['1', '4'])

    const banner = await screen.findByTestId('resume-banner')
    await waitFor(() => expect(banner).toHaveAttribute('data-state', 'active'))
    expect(banner.textContent).toContain('2 lignes restaurées')
    expect(banner.textContent).toContain('toujours ouvert')
    expect(fetchLocationsMock).toHaveBeenCalledWith(shop.id, { includeDisabled: true })
    expect(startInventoryRunMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('btn-restart-run')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByTestId('btn-dismiss-resume'))
    expect(screen.queryByTestId('resume-banner')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('scanned-item')).toHaveLength(2)
  })

  it('conserve les lignes et propose de rouvrir le comptage quand le run serveur a disparu', async () => {
    fetchLocationsMock.mockResolvedValue([baseLocation])
    startInventoryRunMock.mockResolvedValue({
      runId: 'run-new',
      inventorySessionId: 'session-new',
      locationId: baseLocation.id,
      countType: 1,
      ownerDisplayName: owner.displayName,
      ownerUserId: owner.id,
      startedAtUtc: '2026-10-22T09:05:00.000Z',
    })

    renderRestoredSessionPage()

    const banner = await screen.findByTestId('resume-banner')
    await waitFor(() => expect(banner).toHaveAttribute('data-state', 'missing'))
    expect(banner.textContent).toContain('n’existe plus')
    expect(banner.textContent).toContain('2 lignes ont été conservées')
    expect(screen.getAllByTestId('scanned-item')).toHaveLength(2)
    // Aucune libération du run disparu, et pas de redémarrage silencieux.
    expect(releaseInventoryRunMock).not.toHaveBeenCalled()
    expect(startInventoryRunMock).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByTestId('btn-restart-run'))

    await waitFor(() => expect(startInventoryRunMock).toHaveBeenCalledTimes(1))
    expect(startInventoryRunMock).toHaveBeenCalledWith(baseLocation.id, {
      shopId: shop.id,
      ownerUserId: owner.id,
      countType: 1,
    })
    await waitFor(() => expect(screen.getByTestId('resume-banner')).toHaveAttribute('data-state', 'restarted'))
    expect(screen.getAllByTestId('scanned-item')).toHaveLength(2)

    const persisted = JSON.parse(localStorage.getItem(buildInventoryDraftKey(shop.id)) ?? 'null') as InventoryDraft | null
    await waitFor(() => {
      const latest = JSON.parse(localStorage.getItem(buildInventoryDraftKey(shop.id)) ?? 'null') as InventoryDraft | null
      expect(latest?.sessionId).toBe('run-new')
    })
    expect(persisted?.items ?? []).toHaveLength(2)
  })

  it('garde les lignes et explique quoi faire si la clôture répond 404 (run disparu)', async () => {
    fetchLocationsMock.mockResolvedValue([locationWithOpenRun])
    completeInventoryRunMock.mockRejectedValue(
      Object.assign(new Error('Le run fourni est introuvable.'), { status: 404 }),
    )

    renderRestoredSessionPage()

    await waitFor(() => expect(screen.getByTestId('resume-banner')).toHaveAttribute('data-state', 'active'))

    const user = userEvent.setup()
    await user.click(screen.getByTestId('btn-complete-run'))
    const [confirmButton] = await screen.findAllByTestId('btn-confirm-complete')
    await user.click(confirmButton)

    await waitFor(() => expect(completeInventoryRunMock).toHaveBeenCalledTimes(1))
    expect(completeInventoryRunMock.mock.calls[0]?.[1]).toMatchObject({ runId: RESTORED_RUN_ID })

    expect(await screen.findByText(/n’existe plus/)).toBeInTheDocument()
    expect(screen.getByText(/2 lignes sont conservées/)).toBeInTheDocument()
    expect(screen.getAllByTestId('scanned-item')).toHaveLength(2)

    // Nouvelle tentative : le run disparu n'est plus référencé, le serveur en créera un nouveau.
    completeInventoryRunMock.mockResolvedValue({
      runId: 'run-created',
      inventorySessionId: 'session-created',
      locationId: baseLocation.id,
      countType: 1,
      completedAtUtc: '2026-10-22T09:10:00.000Z',
      itemsCount: 2,
      totalQuantity: 5,
    })
    await user.click(screen.getByTestId('btn-complete-run'))
    const [secondConfirm] = await screen.findAllByTestId('btn-confirm-complete')
    await user.click(secondConfirm)

    await waitFor(() => expect(completeInventoryRunMock).toHaveBeenCalledTimes(2))
    expect(completeInventoryRunMock.mock.calls[1]?.[1]).toMatchObject({ runId: null })
  })
})
