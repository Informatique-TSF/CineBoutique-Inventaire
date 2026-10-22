import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { startTransition, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HttpError } from '../../lib/api/http'
import { SELECTED_USER_STORAGE_PREFIX } from '../../lib/selectedUserStorage'
import type { StartInventoryRunPayload, StartInventoryRunResponse } from '../api/inventoryApi'
import { useInventory } from '../contexts/InventoryContext'
import { InventoryCountTypeStep } from '../pages/inventory/InventoryCountTypeStep'
import { InventoryLayout } from '../pages/inventory/InventoryLayout'
import { InventoryLocationStep } from '../pages/inventory/InventoryLocationStep'
import { InventorySessionPage } from '../pages/inventory/InventorySessionPage'
import { AppProviders } from '../providers/AppProviders'
import { CountType } from '../types/inventory'
import type {
  ConflictZoneDetail,
  InventorySummary,
  Location,
  CompleteInventoryRunPayload,
} from '../types/inventory'

import type { ShopUser } from '@/types/user'


const {
  fetchLocationsMock,
  fetchProductMock,
  fetchInventorySummaryMock,
  completeInventoryRunMock,
  startInventoryRunMock,
  releaseInventoryRunMock,
  fetchShopUsersMock,
  getConflictZoneDetailMock,
  shopUsers,
  reserveLocation,
} = vi.hoisted(() => {
  const reserveLocation: Location = {
    id: 'zone-1',
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
      {
        countType: 2,
        status: 'not_started',
        runId: null,
        ownerDisplayName: null,
        ownerUserId: null,
        startedAtUtc: null,
        completedAtUtc: null,
      },
    ],
  }
  const busyLocation: Location = {
    id: 'zone-2',
    code: 'SAL1',
    label: 'Salle 1',
    disabled: false,
    isBusy: true,
    busyBy: 'paul.dupont',
    activeCountType: 1,
    activeRunId: 'run-1',
    activeStartedAtUtc: new Date(),
    countStatuses: [
      {
        countType: 1,
        status: 'in_progress',
        runId: 'run-1',
        ownerDisplayName: 'paul.dupont',
        ownerUserId: 'user-lyon-1',
        startedAtUtc: new Date(),
        completedAtUtc: null,
      },
      {
        countType: 2,
        status: 'not_started',
        runId: null,
        ownerDisplayName: null,
        ownerUserId: null,
        startedAtUtc: null,
        completedAtUtc: null,
      },
    ],
  }
  const emptySummary: InventorySummary = {
    activeSessions: 0,
    openRuns: 0,
    completedRuns: 0,
    conflicts: 0,
    lastActivityUtc: null,
    openRunDetails: [],
    completedRunDetails: [],
    conflictZones: [],
  }
  const shopUsers: ShopUser[] = [
    {
      id: 'user-paris',
      shopId: 'shop-123',
      login: 'paris',
      displayName: 'Utilisateur Paris',
      isAdmin: false,
      disabled: false,
    },
    {
      id: 'user-lyon-1',
      shopId: 'shop-123',
      login: 'lyon1',
      displayName: 'Utilisateur Lyon 1',
      isAdmin: false,
      disabled: false,
    },
    {
      id: 'user-lyon-2',
      shopId: 'shop-123',
      login: 'lyon2',
      displayName: 'Utilisateur Lyon 2',
      isAdmin: false,
      disabled: false,
    },
    {
      id: 'user-marseille-1',
      shopId: 'shop-123',
      login: 'marseille1',
      displayName: 'Utilisateur Marseille 1',
      isAdmin: false,
      disabled: false,
    },
    {
      id: 'user-lille',
      shopId: 'shop-123',
      login: 'lille',
      displayName: 'Utilisateur Lille',
      isAdmin: false,
      disabled: false,
    },
  ]
  return {
    fetchLocationsMock: vi.fn(async (shopId: string, options?: { includeDisabled?: boolean }): Promise<Location[]> => {
      void options
      expect(shopId).toBeTruthy()
      return [
        { ...reserveLocation },
        { ...busyLocation },
      ]
    }),
    fetchProductMock: vi.fn(() => Promise.resolve({ ean: '12345678', name: 'Popcorn caramel' })),
    fetchInventorySummaryMock: vi.fn(async (): Promise<InventorySummary> => ({ ...emptySummary })),
    completeInventoryRunMock: vi.fn<(locationId: string, payload: CompleteInventoryRunPayload) => Promise<{
        runId: string;
        inventorySessionId: string;
        locationId: string;
        countType: number;
        completedAtUtc: string;
        itemsCount: number;
        totalQuantity: number;
      }>>()
      .mockResolvedValue({
        runId: 'run-1',
        inventorySessionId: 'session-1',
        locationId: reserveLocation.id,
        countType: 1,
        completedAtUtc: new Date().toISOString(),
        itemsCount: 1,
        totalQuantity: 1,
      }),
    startInventoryRunMock: vi
      .fn<
        (locationId: string, payload: StartInventoryRunPayload) => Promise<StartInventoryRunResponse>
      >()
      .mockResolvedValue({
        runId: 'run-lock-1',
        inventorySessionId: 'session-lock-1',
        locationId: reserveLocation.id,
        countType: 1,
        ownerDisplayName: shopUsers[0]?.displayName ?? 'Utilisateur Paris',
        ownerUserId: shopUsers[0]?.id ?? 'user-paris',
        startedAtUtc: new Date().toISOString(),
      }),
    releaseInventoryRunMock: vi.fn(async () => {}),
    fetchShopUsersMock: vi.fn(async (shopId: string, options?: { includeDisabled?: boolean }): Promise<ShopUser[]> => {
      void options
      expect(shopId).toBeTruthy()
      return shopUsers
    }),
    getConflictZoneDetailMock: vi
      .fn<(locationId: string, signal?: AbortSignal) => Promise<ConflictZoneDetail>>()
      .mockResolvedValue({
        locationId: reserveLocation.id,
        locationCode: reserveLocation.code,
        locationLabel: reserveLocation.label,
        runs: [],
        items: [],
      }),
    shopUsers,
    reserveLocation,
  }
})

const testShop = { id: 'shop-123', name: 'Boutique test', kind: 'boutique' } as const

vi.mock('../api/inventoryApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/inventoryApi')>()
  return {
    ...actual,
    fetchLocations: fetchLocationsMock,
    fetchProductByEan: fetchProductMock,
    fetchInventorySummary: fetchInventorySummaryMock,
    completeInventoryRun: completeInventoryRunMock,
    startInventoryRun: startInventoryRunMock,
    releaseInventoryRun: releaseInventoryRunMock,
    getConflictZoneDetail: getConflictZoneDetailMock,
  }
})

vi.mock('../api/shopUsers', () => ({
  fetchShopUsers: fetchShopUsersMock,
}))

interface RenderInventoryOptions {
  initialize?: (inventory: ReturnType<typeof useInventory>) => void
}

const applyDefaultInitialization = (inventory: ReturnType<typeof useInventory>) => {
  const defaultUser = shopUsers[0]
  if (defaultUser) {
    inventory.setSelectedUser(defaultUser)
  }
}

const renderInventoryRoutes = (initialEntry: string, options?: RenderInventoryOptions) => {
  const customInitialize = options?.initialize

  const Bootstrapper = ({ children }: { children: ReactNode }) => {
    const inventory = useInventory()
    const initializedRef = useRef(false)
    const [ready, setReady] = useState(false)
    const initializeRef = useRef(customInitialize)

    useEffect(() => {
      initializeRef.current = customInitialize
    })

    useLayoutEffect(() => {
      if (initializedRef.current) {
        return
      }

      const initializer = initializeRef.current ?? applyDefaultInitialization
      initializer(inventory)
      initializedRef.current = true
      startTransition(() => {
        setReady(true)
      })
    }, [inventory])

    if (!ready) {
      return null
    }

    return <>{children}</>
  }

  const routerTree = (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/inventory/start" element={<Navigate to="/select-shop" replace />} />
        <Route path="/inventory" element={<InventoryLayout />}>
          <Route index element={<Navigate to="count-type" replace />} />
          <Route path="location" element={<InventoryLocationStep />} />
          <Route path="count-type" element={<InventoryCountTypeStep />} />
          <Route path="session" element={<InventorySessionPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )

  return render(
    <AppProviders>
      <Bootstrapper>{routerTree}</Bootstrapper>
    </AppProviders>,
  )
}

describe("Workflow d'inventaire", () => {
  beforeEach(() => {
    // Isole chaque test du brouillon de comptage persisté par InventoryProvider.
    localStorage.clear()
    localStorage.setItem('cb.shop', JSON.stringify(testShop))
    sessionStorage.clear()
    sessionStorage.setItem(
      `${SELECTED_USER_STORAGE_PREFIX}.${testShop.id}`,
      JSON.stringify({ userId: shopUsers[0]?.id ?? 'user-paris' }),
    )
    fetchShopUsersMock.mockReset()
    fetchShopUsersMock.mockResolvedValue(shopUsers)
    fetchLocationsMock.mockReset()
    fetchLocationsMock.mockImplementation(async (shopId: string, options?: { includeDisabled?: boolean }): Promise<Location[]> => {
      void options
      expect(shopId).toBeTruthy()
      return [
        { ...reserveLocation },
        {
          id: 'zone-2',
          code: 'SAL1',
          label: 'Salle 1',
          disabled: false,
          isBusy: true,
          busyBy: 'paul.dupont',
          activeCountType: 1,
          activeRunId: 'run-1',
          activeStartedAtUtc: new Date(),
          countStatuses: [
            {
              countType: 1,
              status: 'in_progress',
              runId: 'run-1',
              ownerDisplayName: 'paul.dupont',
              ownerUserId: 'user-lyon-1',
              startedAtUtc: new Date(),
              completedAtUtc: null,
            },
            {
              countType: 2,
              status: 'not_started',
              runId: null,
              ownerDisplayName: null,
              ownerUserId: null,
              startedAtUtc: null,
              completedAtUtc: null,
            },
          ],
        },
      ]
    })
    fetchProductMock.mockReset()
    fetchProductMock.mockImplementation(() => Promise.resolve({ ean: '12345678', name: 'Popcorn caramel' }))
    fetchInventorySummaryMock.mockReset()
    fetchInventorySummaryMock.mockImplementation(async (): Promise<InventorySummary> => ({
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 0,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [],
    }))
    getConflictZoneDetailMock.mockReset()
    getConflictZoneDetailMock.mockResolvedValue({
      locationId: reserveLocation.id,
      locationCode: reserveLocation.code,
      locationLabel: reserveLocation.label,
      runs: [],
      items: [],
    })
    completeInventoryRunMock.mockReset()
    completeInventoryRunMock.mockImplementation(async () => ({
      runId: 'run-1',
      inventorySessionId: 'session-1',
      locationId: reserveLocation.id,
      countType: 2,
      completedAtUtc: new Date().toISOString(),
      itemsCount: 1,
      totalQuantity: 1,
    }))
    startInventoryRunMock.mockReset()
    startInventoryRunMock.mockImplementation(async () => ({
      runId: 'run-lock-1',
      inventorySessionId: 'session-lock-1',
      locationId: reserveLocation.id,
      countType: 1,
      ownerDisplayName: shopUsers[0]?.displayName ?? 'Utilisateur Paris',
      ownerUserId: shopUsers[0]?.id ?? 'user-paris',
      startedAtUtc: new Date().toISOString(),
    }))
    releaseInventoryRunMock.mockReset()
    releaseInventoryRunMock.mockResolvedValue()
  })

  it('bloque le comptage n°2 tant que le n°1 est en cours', async () => {
    renderInventoryRoutes('/inventory/location')

    const locationPages = await screen.findAllByTestId('page-location')
    expect(locationPages).not.toHaveLength(0)

    await waitFor(() => expect(fetchLocationsMock).toHaveBeenCalledTimes(1))
    const [shopIdArg, optionsArg] = fetchLocationsMock.mock.calls[0] ?? []
    expect(shopIdArg).toBe(testShop.id)
    expect(optionsArg).toEqual({ includeDisabled: true })

    await waitFor(() => expect(fetchInventorySummaryMock).toHaveBeenCalledTimes(1))

    const busyZoneCard = await screen.findByTestId('zone-card-zone-2')
    expect(within(busyZoneCard).getByText(/Comptage n°1 en cours/i)).toBeInTheDocument()

    fireEvent.click(within(busyZoneCard).getByTestId('btn-select-zone'))

    const countTypePages = await screen.findAllByTestId('page-count-type')
    const activeCountTypePage = countTypePages[countTypePages.length - 1]

    const countTypeOneButton = within(activeCountTypePage).getByTestId('btn-count-type-1')
    expect(countTypeOneButton).toBeDisabled()

    const countTypeTwoButton = within(activeCountTypePage).getByTestId('btn-count-type-2')
    expect(countTypeTwoButton).toBeDisabled()
    expect(within(countTypeTwoButton).getByText(/Terminez d’abord le comptage n°1\./i)).toBeInTheDocument()
  })

  it("affiche l'état de conflit pour une zone terminée", async () => {
    const completedZone: Location = {
      id: 'zone-4',
      code: 'ZC4',
      label: 'Zone ZC4',
      disabled: false,
      isBusy: false,
      busyBy: null,
      activeRunId: null,
      activeCountType: null,
      activeStartedAtUtc: null,
      countStatuses: [
        {
          countType: CountType.Count1,
          status: 'completed',
          runId: 'run-10',
          ownerDisplayName: 'Luc',
          ownerUserId: 'user-luc',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
        {
          countType: CountType.Count2,
          status: 'completed',
          runId: 'run-11',
          ownerDisplayName: 'Mila',
          ownerUserId: 'user-mila',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
      ],
    }

    fetchLocationsMock.mockResolvedValueOnce([
      { ...reserveLocation },
      completedZone,
    ])

    fetchInventorySummaryMock.mockResolvedValueOnce({
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 1,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [
        {
          locationId: completedZone.id,
          locationCode: completedZone.code,
          locationLabel: completedZone.label,
          conflictLines: 1,
        },
      ],
    })

    renderInventoryRoutes('/inventory/location')

    const conflictZoneCard = await screen.findByTestId(`zone-card-${completedZone.id}`)
    await waitFor(() => expect(within(conflictZoneCard).getByText('Conflit détecté')).toBeInTheDocument())
    expect(within(conflictZoneCard).queryByText('Aucun conflit')).not.toBeInTheDocument()
  })

  it('propose automatiquement le 3ᵉ comptage pour une zone en conflit', async () => {
    const conflictZone: Location = {
      id: 'zone-5',
      code: 'ZC5',
      label: 'Zone ZC5',
      disabled: false,
      isBusy: false,
      busyBy: null,
      activeRunId: null,
      activeCountType: null,
      activeStartedAtUtc: null,
      countStatuses: [
        {
          countType: CountType.Count1,
          status: 'completed',
          runId: 'run-21',
          ownerDisplayName: 'Chloé',
          ownerUserId: 'user-chloe',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
        {
          countType: CountType.Count2,
          status: 'completed',
          runId: 'run-22',
          ownerDisplayName: 'Utilisateur Nice 1',
          ownerUserId: 'user-nice-1',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
      ],
    }

    fetchLocationsMock.mockResolvedValueOnce([
      { ...reserveLocation },
      conflictZone,
    ])

    fetchInventorySummaryMock.mockResolvedValueOnce({
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 1,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [
        {
          locationId: conflictZone.id,
          locationCode: conflictZone.code,
          locationLabel: conflictZone.label,
          conflictLines: 3,
        },
      ],
    })

    renderInventoryRoutes('/inventory/location')

    const conflictCard = await screen.findByTestId(`zone-card-${conflictZone.id}`)
    const actionButton = within(conflictCard).getByTestId('btn-select-zone')
    expect(actionButton).toBeEnabled()
    expect(actionButton).toHaveTextContent('Lancer le 3ᵉ comptage')

    fireEvent.click(actionButton)

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSession = sessionPages[sessionPages.length - 1]
    await waitFor(() => expect(within(activeSession).getByText(/Comptage n°3/i)).toBeInTheDocument())
  })

  it('propose un 4ᵉ comptage après un troisième comptage divergent et envoie countType 4', async () => {
    const conflictZone: Location = {
      id: 'zone-6',
      code: 'ZC6',
      label: 'Zone ZC6',
      disabled: false,
      isBusy: false,
      busyBy: null,
      activeRunId: null,
      activeCountType: null,
      activeStartedAtUtc: null,
      countStatuses: [
        {
          countType: CountType.Count1,
          status: 'completed',
          runId: 'run-c31',
          ownerDisplayName: 'Alice',
          ownerUserId: 'user-alice',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
        {
          countType: CountType.Count2,
          status: 'completed',
          runId: 'run-c32',
          ownerDisplayName: 'Bruno',
          ownerUserId: 'user-bruno',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
        {
          countType: CountType.Count3,
          status: 'completed',
          runId: 'run-c33',
          ownerDisplayName: 'Chloé',
          ownerUserId: 'user-chloe',
          startedAtUtc: new Date(),
          completedAtUtc: new Date(),
        },
      ],
    }

    fetchLocationsMock.mockResolvedValueOnce([
      { ...reserveLocation },
      conflictZone,
    ])

    fetchInventorySummaryMock.mockResolvedValueOnce({
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 1,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [
        {
          locationId: conflictZone.id,
          locationCode: conflictZone.code,
          locationLabel: conflictZone.label,
          conflictLines: 5,
        },
      ],
    })

    getConflictZoneDetailMock.mockResolvedValueOnce({
      locationId: conflictZone.id,
      locationCode: conflictZone.code,
      locationLabel: conflictZone.label,
      runs: [
        {
          runId: 'run-c31',
          countType: 1,
          completedAtUtc: '2024-01-01T10:00:00Z',
          ownerDisplayName: 'Alice',
        },
        {
          runId: 'run-c32',
          countType: 2,
          completedAtUtc: '2024-01-01T11:00:00Z',
          ownerDisplayName: 'Bruno',
        },
        {
          runId: 'run-c33',
          countType: 3,
          completedAtUtc: '2024-01-01T12:00:00Z',
          ownerDisplayName: 'Chloé',
        },
      ],
      items: [
        {
          productId: 'prod-111',
          ean: '1111111111111',
          qtyC1: 10,
          qtyC2: 12,
          delta: -3,
          allCounts: [
            { runId: 'run-c31', countType: 1, quantity: 10 },
            { runId: 'run-c32', countType: 2, quantity: 12 },
            { runId: 'run-c33', countType: 3, quantity: 9 },
          ],
        },
      ],
    })

    renderInventoryRoutes('/inventory/location')

    const conflictCard = await screen.findByTestId(`zone-card-${conflictZone.id}`)
    const actionButton = within(conflictCard).getByTestId('btn-select-zone')
    await waitFor(() => expect(actionButton).toHaveTextContent('Lancer le 4ᵉ comptage'))

    fireEvent.click(actionButton)

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSession = sessionPages[sessionPages.length - 1]
    await waitFor(() => expect(within(activeSession).getByText(/Comptage n°4/i)).toBeInTheDocument())

    const conflictButton = await within(activeSession).findByTestId('btn-view-conflicts')
    fireEvent.click(conflictButton)

    await waitFor(() => expect(getConflictZoneDetailMock).toHaveBeenCalled())

    const accordionPanel = await within(activeSession).findByTestId('conflict-details-panel')
    expect(accordionPanel.getAttribute('data-state')).toBe('open')

    const accordionScope = within(accordionPanel)
    await accordionScope.findByText('Comptage 1')
    await accordionScope.findByText('Comptage 2')
    await accordionScope.findByText('Comptage 3')
    await accordionScope.findByText('Amplitude')

    fireEvent.click(conflictButton)
    expect(accordionPanel.getAttribute('data-state')).toBe('closed')

    const input = within(activeSession).getByLabelText('Scanner (douchette ou saisie)')
    fireEvent.change(input, { target: { value: '12345678' } })

    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('12345678'))
    await waitFor(() => {
      const scannedItems = within(activeSession).getAllByTestId('scanned-item')
      expect(scannedItems.some((element) => /Popcorn caramel/.test(element.textContent ?? ''))).toBe(true)
    })
    await waitFor(() => expect(startInventoryRunMock).toHaveBeenCalledTimes(1))
    const [startLocationId, startPayload] = startInventoryRunMock.mock.calls.at(-1)!
    expect(startLocationId).toBe(conflictZone.id)
    expect(startPayload.countType).toBe(4)

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      const finishButton = await within(activeSession).findByTestId('btn-complete-run')
      fireEvent.click(finishButton)

      await waitFor(() => expect(completeInventoryRunMock).toHaveBeenCalledTimes(1))
    } finally {
      confirmSpy.mockRestore()
    }

    const [completeLocationId, completePayload] = completeInventoryRunMock.mock.calls.at(-1)!
    expect(completeLocationId).toBe(conflictZone.id)
    expect(completePayload.countType).toBe(4)
  })

  it('autorise la reprise de son propre comptage', async () => {
    const selfRunLocation: Location = {
      ...reserveLocation,
      id: 'zone-3',
      code: 'SAL2',
      label: 'Salle 2',
      isBusy: true,
      busyBy: shopUsers[0].displayName,
      activeRunId: 'run-self',
      activeCountType: 1,
      activeStartedAtUtc: new Date(),
      countStatuses: [
        {
          countType: CountType.Count1,
          status: 'in_progress',
          runId: 'run-self',
          ownerDisplayName: shopUsers[0].displayName,
          ownerUserId: shopUsers[0].id,
          startedAtUtc: new Date(),
          completedAtUtc: null,
        },
        reserveLocation.countStatuses[1],
      ],
    }

    fetchLocationsMock.mockResolvedValueOnce([
      { ...reserveLocation },
      selfRunLocation,
    ])

    renderInventoryRoutes('/inventory/location')

    const selfZoneCard = await screen.findByTestId('zone-card-zone-3')
    fireEvent.click(within(selfZoneCard).getByTestId('btn-select-zone'))

    const countTypePages = await screen.findAllByTestId('page-count-type')
    const activeCountTypePage = countTypePages[countTypePages.length - 1]

    const countTypeOneButton = within(activeCountTypePage).getByTestId('btn-count-type-1')
    expect(countTypeOneButton).not.toBeDisabled()

    fireEvent.click(countTypeOneButton)

    await waitFor(() =>
      expect(
        screen.getAllByText((content) => content.replace(/\s+/g, ' ').includes('Zone : Salle 2')).length,
      ).toBeGreaterThan(0),
    )
    await waitFor(() =>
      expect(
        screen.getAllByText((content) => content.replace(/\s+/g, ' ').includes('Comptage : 1')).length,
      ).toBeGreaterThan(0),
    )
  })

  it("ajoute automatiquement un produit lorsqu'un EAN connu est saisi", async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const input = (await screen.findByLabelText('Scanner (douchette ou saisie)')) as HTMLInputElement
    expect(input).toBeDefined()
    fireEvent.change(input, { target: { value: '12345678' } })

    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('12345678'))
    await waitFor(() => expect(screen.getByText('Popcorn caramel')).toBeInTheDocument())
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
  })

  it('affiche un feedback visuel clair lorsqu’un code RFID alphanumérique est introuvable', async () => {
    const notFoundError: HttpError = {
      name: 'Error',
      message: 'HTTP 404',
      status: 404,
      url: '/api/products/RFID001',
    }

    fetchProductMock.mockRejectedValueOnce(notFoundError)

    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const input = (await screen.findByLabelText('Scanner (douchette ou saisie)')) as HTMLInputElement
    expect(input).toBeDefined()

    fireEvent.change(input, { target: { value: 'rfid001' } })

    await waitFor(() =>
      expect(
        screen.getByText(
          'Code rfid001 introuvable dans la liste des produits à inventorier.',
        ),
      ).toBeInTheDocument(),
    )
    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('rfid001'))
    expect(document.body).toHaveClass('inventory-flash-active')
    expect(screen.queryByTestId('btn-open-manual')).not.toBeInTheDocument()
  })

  it("n'ajoute pas automatiquement les codes RFID introuvables à la session", async () => {
    const notFoundError: HttpError = {
      name: 'Error',
      message: 'HTTP 404',
      status: 404,
      url: '/api/products/RFID001',
    }

    fetchProductMock.mockRejectedValueOnce(notFoundError)

    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const input = (await screen.findByLabelText('Scanner (douchette ou saisie)')) as HTMLInputElement
    expect(input).toBeDefined()

    fireEvent.change(input, { target: { value: 'rfid001\n' } })

    await waitFor(() =>
      expect(
        screen.getByText(
          'Code rfid001 introuvable dans la liste des produits à inventorier.',
        ),
      ).toBeInTheDocument(),
    )
    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('rfid001'))

    expect(screen.queryAllByTestId('scanned-item')).toHaveLength(0)
  })

  it('recherche les saisies manuelles avec espaces et caractères spéciaux sans les modifier', async () => {
    const notFoundError: HttpError = {
      name: 'Error',
      message: 'HTTP 404',
      status: 404,
      url: '/api/products/RF ID 001-★',
    }

    fetchProductMock.mockRejectedValueOnce(notFoundError)

    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const input = (await screen.findByLabelText('Scanner (douchette ou saisie)')) as HTMLInputElement
    expect(input).toBeDefined()

    fireEvent.change(input, { target: { value: 'RF ID 001-★' } })

    await waitFor(() =>
      expect(
        screen.getByText(
          'Code RF ID 001-★ introuvable dans la liste des produits à inventorier.',
        ),
      ).toBeInTheDocument(),
    )
    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('RF ID 001-★'))
  })

  it("restaure l'utilisateur sélectionné depuis la session", async () => {
    const storageKey = `${SELECTED_USER_STORAGE_PREFIX}.${testShop.id}`
    sessionStorage.setItem(storageKey, JSON.stringify({ userId: shopUsers[0].id }))

    renderInventoryRoutes('/inventory/location')

    const userSummaries = await screen.findAllByText((content) =>
      content.replace(/\s+/g, ' ').includes(`Utilisateur : ${shopUsers[0].displayName}`),
    )
    expect(userSummaries.length).toBeGreaterThan(0)
  })

  it('démarre un run serveur lors du premier scan', async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]
    const input = within(activeSessionPage).getByLabelText('Scanner (douchette ou saisie)')

    fireEvent.change(input, { target: { value: '87654321' } })

    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('87654321'))
    await waitFor(() => {
      const scannedItems = within(activeSessionPage).getAllByTestId('scanned-item')
      expect(scannedItems.some((element) => /Popcorn caramel/.test(element.textContent ?? ''))).toBe(true)
    })

    await waitFor(() => expect(startInventoryRunMock).toHaveBeenCalledTimes(1))
    const calls = startInventoryRunMock.mock.calls
    const lastCall = calls[calls.length - 1]
    expect(lastCall).toBeDefined()
    const [locationId, payload] = lastCall!
    expect(locationId).toBe(reserveLocation.id)
    expect(payload).toMatchObject({ countType: 1, ownerUserId: shopUsers[0].id, shopId: testShop.id })
  })

  it("n'effectue pas de recherche produit sans boutique sélectionnée", async () => {
    localStorage.removeItem('cb.shop')

    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]
    const input = within(activeSessionPage).getByLabelText('Scanner (douchette ou saisie)')

    fireEvent.change(input, { target: { value: '87654321' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(
        within(activeSessionPage).getByText('Sélectionnez une boutique valide avant de scanner un produit.'),
      ).toBeInTheDocument(),
    )

    expect(fetchProductMock).not.toHaveBeenCalled()
  })

  it("ne libère pas le run immédiatement après l'avoir démarré", async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]
    const input = within(activeSessionPage).getByLabelText('Scanner (douchette ou saisie)')

    fireEvent.change(input, { target: { value: '87654321' } })

    await waitFor(() => {
      const scannedItems = within(activeSessionPage).getAllByTestId('scanned-item')
      expect(scannedItems.some((element) => /Popcorn caramel/.test(element.textContent ?? ''))).toBe(true)
    })
    await waitFor(() => expect(startInventoryRunMock).toHaveBeenCalledTimes(1))

    await waitFor(() => {
      expect(releaseInventoryRunMock).not.toHaveBeenCalled()
    })
  })

  it('libère automatiquement la zone lorsque tous les articles sont supprimés', async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.setSessionId('run-lock-1')
        inventory.addOrIncrementItem({ ean: '1234567890123', name: 'Popcorn caramel' })
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]

    const initialItem = await within(activeSessionPage).findByTestId('scanned-item')
    expect(initialItem).toBeInTheDocument()

    const removeButton = within(initialItem).getByRole('button', { name: 'Retirer' })
    fireEvent.click(removeButton)

    await waitFor(() => expect(within(activeSessionPage).queryByTestId('scanned-item')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(releaseInventoryRunMock).toHaveBeenCalledWith(
        reserveLocation.id,
        'run-lock-1',
        shopUsers[0].id,
      ),
    )

    expect(within(activeSessionPage).queryByText(/Session existante/)).not.toBeInTheDocument()
  })

  it("place l'article modifié en premier et conserve un journal des actions", async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
        inventory.addOrIncrementItem({ ean: '001', name: 'Produit A' })
        inventory.addOrIncrementItem({ ean: '0000', name: 'Produit B' })
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]

    const readRenderedEans = () =>
      within(activeSessionPage)
        .queryAllByTestId('scanned-item')
        .map((element) => element.getAttribute('data-ean') ?? '')

    await waitFor(() => expect(readRenderedEans()).toEqual(['0000', '001']))

    const initialRows = within(activeSessionPage).getAllByTestId('scanned-item')
    expect(initialRows).toHaveLength(2)
    const secondRow = initialRows[1]
    const incrementButton = within(secondRow).getByRole('button', { name: 'Ajouter' })

    fireEvent.click(incrementButton)

    await waitFor(() => expect(within(secondRow).getByDisplayValue('2')).toBeInTheDocument())
    await waitFor(() => {
      const rendered = readRenderedEans()
      expect(rendered).toEqual(expect.arrayContaining(['0000', '001']))
      expect(rendered).toHaveLength(2)
    })

    const updatedRows = within(activeSessionPage).getAllByTestId('scanned-item')
    const updatedFirstRow = updatedRows[0]
    const decrementButton = within(updatedFirstRow).getByRole('button', { name: 'Retirer' })

    fireEvent.click(decrementButton)

    await waitFor(() => expect(within(updatedFirstRow).getByDisplayValue('1')).toBeInTheDocument())
    await waitFor(() => {
      const rendered = readRenderedEans()
      expect(rendered).toEqual(expect.arrayContaining(['0000', '001']))
      expect(rendered).toHaveLength(2)
    })

    const openLogsButton = within(activeSessionPage).getByRole('button', { name: /journal des actions/i })
    fireEvent.click(openLogsButton)

    const logsDialog = await screen.findByRole('dialog', { name: 'Journal de session' })
    const logItems = within(logsDialog).getAllByRole('listitem')
    expect(logItems[0]).toHaveTextContent('Quantité mise à jour pour Produit A (EAN 001) → 1')
  })

  it('permet de saisir directement une quantité élevée', async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count1)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
        inventory.addOrIncrementItem({ ean: '1234567890123', name: 'Popcorn caramel' })
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]

    const itemRow = within(activeSessionPage).getByTestId('scanned-item')
    const quantityInput = within(itemRow).getByLabelText('Quantité pour Popcorn caramel') as HTMLInputElement

    fireEvent.change(quantityInput, { target: { value: '2000' } })
    fireEvent.blur(quantityInput)

    await waitFor(() => expect(within(itemRow).getByDisplayValue('2000')).toBeInTheDocument())

    fireEvent.change(quantityInput, { target: { value: '' } })
    fireEvent.blur(quantityInput)

    await waitFor(() => expect(within(itemRow).getByDisplayValue('2000')).toBeInTheDocument())

    fireEvent.change(quantityInput, { target: { value: '0' } })
    fireEvent.blur(quantityInput)

    await waitFor(() => expect(within(activeSessionPage).queryByTestId('scanned-item')).not.toBeInTheDocument())
  })

  it('envoie le comptage finalisé lorsque le bouton est actionné', async () => {
    renderInventoryRoutes('/inventory/session', {
      initialize: (inventory) => {
        inventory.setSelectedUser(shopUsers[0])
        inventory.setCountType(CountType.Count2)
        inventory.setLocation({ ...reserveLocation })
        inventory.clearSession()
      },
    })

    const sessionPages = await screen.findAllByTestId('page-session')
    const activeSessionPage = sessionPages[sessionPages.length - 1]
    const input = within(activeSessionPage).getByLabelText('Scanner (douchette ou saisie)')
    fireEvent.change(input, { target: { value: '12345678' } })

    await waitFor(() => expect(fetchProductMock).toHaveBeenCalledWith('12345678'))
    await waitFor(() => {
      const scannedItems = within(activeSessionPage).getAllByTestId('scanned-item')
      expect(scannedItems.some((element) => /Popcorn caramel/.test(element.textContent ?? ''))).toBe(true)
    })
    await waitFor(() => expect(startInventoryRunMock).toHaveBeenCalledTimes(1))
    const finishButton = await within(activeSessionPage).findByTestId('btn-complete-run')
    expect(finishButton).toBeInTheDocument()

    fireEvent.click(finishButton)

    await waitFor(() => expect(completeInventoryRunMock).toHaveBeenCalledTimes(1))
    expect(completeInventoryRunMock.mock.calls.length).toBeGreaterThan(0)
    const [locationId, payload] = completeInventoryRunMock.mock.calls.at(-1)!
    expect(payload).toBeTruthy()
    expect(locationId).toBeTruthy()
    expect(payload).toMatchObject({
      runId: 'run-lock-1',
      countType: CountType.Count2,
      ownerUserId: shopUsers[0].id,
    })
    expect(payload.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ean: '12345678',
          isManual: false,
        }),
      ]),
    )
  })

})
