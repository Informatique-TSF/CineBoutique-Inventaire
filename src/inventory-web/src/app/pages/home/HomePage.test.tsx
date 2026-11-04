import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'


import { ThemeProvider } from '../../../theme/ThemeProvider'
import {
  fetchInventorySummary,
  fetchLocationSummaries,
  fetchLocations,
  getConflictZoneDetail,
  getCompletedRunDetail,
} from '../../api/inventoryApi'
import { InventoryProvider, useInventory } from '../../contexts/InventoryContext'
import type {
  CompletedRunDetail,
  ConflictZoneDetail,
  InventorySummary,
  Location,
} from '../../types/inventory'

import { HomePage } from './HomePage'

import { downloadFile } from '@/lib/api/download'
import type { HttpError } from '@/lib/api/http'
import { ShopProvider } from '@/state/ShopContext'
import type { ShopUser } from '@/types/user'

const navigateMock = vi.fn()
const testShop = { id: 'shop-1', name: 'Boutique de test', kind: 'boutique' }

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

vi.mock('../../api/inventoryApi', () => ({
  fetchInventorySummary: vi.fn(),
  fetchLocationSummaries: vi.fn(),
  fetchLocations: vi.fn(),
  getConflictZoneDetail: vi.fn(),
  getCompletedRunDetail: vi.fn(),
}))

vi.mock('@/lib/api/download', () => ({
  downloadFile: vi.fn(),
}))

const mockedDownloadFile = vi.mocked(downloadFile)

const {
  fetchInventorySummary: mockedFetchSummary,
  fetchLocationSummaries: mockedFetchLocationSummaries,
  fetchLocations: mockedFetchLocations,
  getConflictZoneDetail: mockedGetDetail,
  getCompletedRunDetail: mockedGetCompletedRunDetail,
} = vi.mocked({
  fetchInventorySummary,
  fetchLocationSummaries,
  fetchLocations,
  getConflictZoneDetail,
  getCompletedRunDetail,
})

const defaultUser: ShopUser = {
  id: 'user-alice',
  shopId: testShop.id,
  login: 'alice',
  displayName: 'Alice',
  isAdmin: false,
  disabled: false,
}

const emptyCompletedRunDetail: CompletedRunDetail = {
  runId: 'run-default',
  locationId: 'loc-default',
  locationCode: 'Z0',
  locationLabel: 'Zone 0',
  countType: 1,
  ownerDisplayName: null,
  ownerUserId: null,
  startedAtUtc: '',
  completedAtUtc: '',
  items: [],
}

const InventoryUserInitializer = ({ user }: { user: ShopUser | null }) => {
  const { setSelectedUser } = useInventory()
  useEffect(() => {
    if (user) {
      setSelectedUser(user)
    }
  }, [setSelectedUser, user])
  return null
}

const withProviders = (ui: ReactNode, user: ShopUser | null = defaultUser) => (
  <ThemeProvider>
    <ShopProvider>
      <InventoryProvider>
        <InventoryUserInitializer user={user} />
        <MemoryRouter>{ui}</MemoryRouter>
      </InventoryProvider>
    </ShopProvider>
  </ThemeProvider>
)

const renderHomePage = (options?: { user?: ShopUser | null }) => {
  const providedUser = options && 'user' in options ? options.user : undefined
  const resolvedUser = providedUser === undefined ? defaultUser : providedUser
  return render(withProviders(<HomePage />, resolvedUser))
}

describe('HomePage', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('cb.shop', JSON.stringify(testShop))
    mockedFetchSummary.mockReset()
    mockedFetchLocationSummaries.mockReset()
    mockedFetchLocations.mockReset()
    mockedGetDetail.mockReset()
    mockedGetCompletedRunDetail.mockReset()
    mockedGetCompletedRunDetail.mockResolvedValue(emptyCompletedRunDetail)
    navigateMock.mockReset()
    mockedDownloadFile.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('redirige vers la sélection de boutique si aucune boutique n’est mémorisée', async () => {
    localStorage.removeItem('cb.shop')
    renderHomePage({ user: null })

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/select-shop', { replace: true })
    })

    expect(mockedFetchSummary).not.toHaveBeenCalled()
    expect(mockedFetchLocations).not.toHaveBeenCalled()
  })

  it('affiche les zones en conflit et ouvre la modale de détail', async () => {
    const summary: InventorySummary = {
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 1,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [
        {
          locationId: 'loc-1',
          locationCode: 'B1',
          locationLabel: 'Zone B1',
          conflictLines: 2,
        },
      ],
    }

    const locations: Location[] = []
    const detail: ConflictZoneDetail = {
      locationId: 'loc-1',
      locationCode: 'B1',
      locationLabel: 'Zone B1',
      items: [
        { productId: 'p1', ean: '111', qtyC1: 5, qtyC2: 8, delta: -3 },
        { productId: 'p2', ean: '222', qtyC1: 3, qtyC2: 1, delta: 2 },
      ],
    }

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocationSummaries.mockResolvedValue([])
    mockedFetchLocations.mockResolvedValue(locations)
    mockedGetDetail.mockResolvedValue(detail)

    renderHomePage()

    await waitFor(() => {
      expect(mockedFetchSummary).toHaveBeenCalled()
    })

    expect(await screen.findByText('Conflits')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    const zoneButton = await screen.findByRole('button', { name: /B1 · Zone B1/i })
    fireEvent.click(zoneButton)

    const dialog = await screen.findByRole('dialog', { name: /B1 · Zone B1/i })
    expect(dialog).toBeInTheDocument()

    expect(await within(dialog).findByText(/EAN 111/i)).toBeInTheDocument()
    expect(within(dialog).getAllByText('Comptage 1').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('Comptage 2').length).toBeGreaterThan(0)
  })

  it('ouvre les modales des comptages en cours et terminés', async () => {
    const summary: InventorySummary = {
      activeSessions: 1,
      openRuns: 1,
      completedRuns: 1,
      conflicts: 0,
      lastActivityUtc: null,
      openRunDetails: [
        {
          runId: 'run-1',
          locationId: 'loc-1',
          locationCode: 'B1',
          locationLabel: 'Zone B1',
          countType: 1,
          ownerDisplayName: 'Alice',
          ownerUserId: 'user-alice',
          startedAtUtc: new Date('2024-01-01T10:00:00Z').toISOString(),
        },
      ],
      completedRunDetails: [
        {
          runId: 'run-2',
          locationId: 'loc-2',
          locationCode: 'S1',
          locationLabel: 'Zone S1',
          countType: 2,
          ownerDisplayName: 'Utilisateur Nice 1',
          ownerUserId: 'user-nice-1',
          startedAtUtc: new Date('2023-12-31T09:00:00Z').toISOString(),
          completedAtUtc: new Date('2023-12-31T10:00:00Z').toISOString(),
        },
      ],
      conflictZones: [],
    }

    const locations: Location[] = []

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocations.mockResolvedValue(locations)

    renderHomePage()

    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Comptages en cours/i })
      expect(buttons.some((button) => !button.hasAttribute('disabled'))).toBe(true)
    })

    const openRunsCards = screen.getAllByRole('button', { name: /Comptages en cours/i })
    const openRunsCard = openRunsCards.find((button) => !button.hasAttribute('disabled')) ?? openRunsCards[0]
    expect(openRunsCard).toBeDefined()
    fireEvent.click(openRunsCard)

    const openRunsModalTitle = await screen.findByRole('heading', { level: 2, name: /Comptages en cours/i })
    expect(openRunsModalTitle).toBeInTheDocument()
    const openRunsModal = await screen.findByRole('dialog', { name: /Comptages en cours/i })
    expect(screen.getByText(/Opérateur : Alice/i)).toBeInTheDocument()

    const closeOpenRunsButton = within(openRunsModal).getByRole('button', { name: /Fermer/i })
    fireEvent.click(closeOpenRunsButton)

    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 2, name: /Comptages en cours/i })).not.toBeInTheDocument()
    })

    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Comptages terminés/i })
      expect(buttons.some((button) => !button.hasAttribute('disabled'))).toBe(true)
    })

    const completedRunsCards = screen.getAllByRole('button', { name: /Comptages terminés/i })
    const completedRunsCard = completedRunsCards.find((button) => !button.hasAttribute('disabled')) ?? completedRunsCards[0]
    expect(completedRunsCard).toBeDefined()
    fireEvent.click(completedRunsCard)

    const completedRunsModalTitle = await screen.findByRole('heading', { level: 2, name: /Comptages terminés/i })
    expect(completedRunsModalTitle).toBeInTheDocument()
    const completedRunsModal = await screen.findByRole('dialog', { name: /Comptages terminés/i })
    expect(within(completedRunsModal).getByText(/Consultez les comptages finalisés\./i)).toBeInTheDocument()
    expect(within(completedRunsModal).getByText(/Opérateur : Utilisateur Nice 1/i)).toBeInTheDocument()
  })

  it('ne charge les emplacements qu’une seule fois', async () => {
    const summary: InventorySummary = {
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 0,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [],
    }

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocations.mockResolvedValue([])

    renderHomePage()

    await waitFor(() => {
      expect(mockedFetchSummary).toHaveBeenCalledTimes(1)
      expect(mockedFetchLocations).toHaveBeenCalledTimes(1)
    })
  })

  it('considère l’inventaire terminé lorsque toutes les zones actives sont désactivées', async () => {
    const summary: InventorySummary = {
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 1,
      conflicts: 0,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [
        {
          runId: 'run-final',
          locationId: 'loc-done',
          locationCode: 'Z1',
          locationLabel: 'Zone 1',
          countType: 1,
          ownerDisplayName: 'Alice',
          ownerUserId: defaultUser.id,
          startedAtUtc: '2024-01-01T08:00:00Z',
          completedAtUtc: '2024-01-01T08:10:00Z',
        },
      ],
      conflictZones: [],
    }

    const locations: Location[] = [
      {
        id: 'loc-1',
        code: 'Z1',
        label: 'Zone 1',
        disabled: false,
        isBusy: false,
        busyBy: null,
        activeRunId: null,
        activeCountType: null,
        activeStartedAtUtc: null,
        countStatuses: [
          {
            countType: 1,
            status: 'completed',
            runId: 'run-c1',
            ownerDisplayName: 'Alice',
            ownerUserId: defaultUser.id,
            startedAtUtc: new Date('2024-01-01T08:00:00Z'),
            completedAtUtc: new Date('2024-01-01T08:05:00Z'),
          },
          {
            countType: 2,
            status: 'completed',
            runId: 'run-c2',
            ownerDisplayName: 'Bob',
            ownerUserId: 'user-bob',
            startedAtUtc: new Date('2024-01-01T08:10:00Z'),
            completedAtUtc: new Date('2024-01-01T08:20:00Z'),
          },
        ],
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `loc-disabled-${index}`,
        code: `Z${index + 2}`,
        label: `Zone ${index + 2}`,
        disabled: true,
        isBusy: false,
        busyBy: null,
        activeRunId: null,
        activeCountType: null,
        activeStartedAtUtc: null,
        countStatuses: [],
      })),
    ]

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocations.mockResolvedValue(locations)
    mockedFetchLocationSummaries.mockResolvedValue([])

    renderHomePage()

    expect(await screen.findByText(/Inventaire terminé/i)).toBeInTheDocument()
    const startButtons = screen.getAllByText(/Débuter un comptage/i, { selector: 'button' })
    expect(startButtons.length).toBeGreaterThan(0)
    expect(
      startButtons.some(
        (button) => button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
      )
    ).toBe(true)
  })

  it("permet de reprendre un comptage appartenant à l'utilisateur courant", async () => {
    const startedAt = new Date('2024-01-01T10:00:00Z')
    const summary: InventorySummary = {
      activeSessions: 1,
      openRuns: 1,
      completedRuns: 0,
      conflicts: 0,
      lastActivityUtc: startedAt.toISOString(),
      openRunDetails: [
        {
          runId: 'run-1',
          locationId: 'loc-1',
          locationCode: 'B1',
          locationLabel: 'Zone B1',
          countType: 1,
          ownerDisplayName: 'Alice',
          ownerUserId: defaultUser.id,
          startedAtUtc: startedAt.toISOString(),
        },
      ],
      completedRunDetails: [],
      conflictZones: [],
    }

    const locations: Location[] = [
      {
        id: 'loc-1',
        code: 'B1',
        label: 'Zone B1',
        disabled: false,
        isBusy: true,
        busyBy: 'Alice',
        activeRunId: 'run-1',
        activeCountType: 1,
        activeStartedAtUtc: startedAt,
        countStatuses: [
          {
            countType: 1,
            status: 'in_progress',
            runId: 'run-1',
            ownerDisplayName: 'Alice',
            ownerUserId: defaultUser.id,
            startedAtUtc: startedAt,
            completedAtUtc: null,
          },
        ],
      },
    ]

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocations.mockResolvedValue(locations)
    mockedFetchLocationSummaries.mockResolvedValue([])

    renderHomePage()

    await waitFor(() => expect(mockedFetchSummary).toHaveBeenCalled())

    const ongoingMessages = await screen.findAllByText(/Vous avez un comptage en cours/i)
    expect(ongoingMessages.length).toBeGreaterThan(0)

    const openRunsCards = screen.getAllByRole('button', { name: /Comptages en cours/i })
    const openRunsCard = openRunsCards.find((button) => !button.hasAttribute('disabled')) ?? openRunsCards[0]
    fireEvent.click(openRunsCard)

    const resumeButton = await screen.findByRole('button', { name: /Reprendre/i })
    fireEvent.click(resumeButton)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/inventory/session')
    })

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Comptages en cours/i })).not.toBeInTheDocument()
    })
  })

  it('permet de lancer un nouveau comptage depuis un conflit', async () => {
    const summary: InventorySummary = {
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 1,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [
        {
          locationId: 'loc-1',
          locationCode: 'B1',
          locationLabel: 'Zone B1',
          conflictLines: 2,
        },
      ],
    }

    const locations: Location[] = [
      {
        id: 'loc-1',
        code: 'B1',
        label: 'Zone B1',
        disabled: false,
        isBusy: false,
        busyBy: null,
        activeRunId: null,
        activeCountType: null,
        activeStartedAtUtc: null,
        countStatuses: [
          {
            countType: 1,
            status: 'completed',
            runId: 'run-1',
            ownerDisplayName: 'Alice',
            ownerUserId: defaultUser.id,
            startedAtUtc: new Date('2024-01-01T08:00:00Z'),
            completedAtUtc: new Date('2024-01-01T08:30:00Z'),
          },
          {
            countType: 2,
            status: 'completed',
            runId: 'run-2',
            ownerDisplayName: 'Bob',
            ownerUserId: 'user-bob',
            startedAtUtc: new Date('2024-01-01T09:00:00Z'),
            completedAtUtc: new Date('2024-01-01T09:30:00Z'),
          },
        ],
      },
    ]

    const detail: ConflictZoneDetail = {
      locationId: 'loc-1',
      locationCode: 'B1',
      locationLabel: 'Zone B1',
      runs: [
        { runId: 'run-1', countType: 1, completedAtUtc: '2024-01-01T08:30:00Z', ownerDisplayName: 'Alice' },
        { runId: 'run-2', countType: 2, completedAtUtc: '2024-01-01T09:30:00Z', ownerDisplayName: 'Bob' },
      ],
      items: [],
    }

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocations.mockResolvedValue(locations)
    mockedFetchLocationSummaries.mockResolvedValue([])
    mockedGetDetail.mockResolvedValue(detail)

    renderHomePage()

    const conflictButton = await screen.findByRole('button', { name: /B1 · Zone B1/i })
    fireEvent.click(conflictButton)

    const launchButton = await screen.findByRole('button', { name: /Lancer le 3.? comptage/i })
    fireEvent.click(launchButton)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/inventory/session')
    })

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Zone B1/i })).not.toBeInTheDocument()
    })
  })

  it("redirige vers l'assistant d'inventaire au clic sur le CTA principal", async () => {
    const summary: InventorySummary = {
      activeSessions: 0,
      openRuns: 0,
      completedRuns: 0,
      conflicts: 0,
      lastActivityUtc: null,
      openRunDetails: [],
      completedRunDetails: [],
      conflictZones: [],
    }

    const locations: Location[] = []

    mockedFetchSummary.mockResolvedValue(summary)
    mockedFetchLocations.mockResolvedValue(locations)

    renderHomePage()

    const buttons = await screen.findAllByRole('button', { name: /Débuter un comptage/i })
    fireEvent.click(buttons[0])

    expect(navigateMock).toHaveBeenCalledWith('/inventory/location')
  })

  it('ignore le 404 produit sur la Home', async () => {
    const productNotFound = Object.assign(new Error('Produit introuvable'), {
      status: 404,
      url: 'http://localhost:5173/api/products/0000000000000',
    }) as HttpError

    mockedFetchSummary.mockRejectedValue(productNotFound)
    mockedFetchLocations.mockResolvedValue([])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      renderHomePage()

      await waitFor(() => expect(mockedFetchSummary).toHaveBeenCalled())

      await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('[home] produit introuvable ignoré', productNotFound)
    })

    expect(errorSpy).not.toHaveBeenCalledWith('[home] http error', expect.anything())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const placeholders = await screen.findAllByText('Les indicateurs ne sont pas disponibles pour le moment.')
    expect(placeholders.length).toBeGreaterThan(0)
  } finally {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  }
})
  const completedZone = (code: string): Location => ({
    id: `loc-${code}`,
    code,
    label: `Zone ${code}`,
    disabled: false,
    isBusy: false,
    busyBy: null,
    activeRunId: null,
    activeCountType: null,
    activeStartedAtUtc: null,
    countStatuses: [1, 2].map((countType) => ({
      countType,
      status: 'completed' as const,
      runId: `run-${code}-${countType}`,
      ownerDisplayName: 'Alice',
      ownerUserId: defaultUser.id,
      startedAtUtc: new Date('2026-12-17T08:00:00Z'),
      completedAtUtc: new Date('2026-12-17T08:30:00Z'),
    })),
  })

  const summaryWith = (overrides: Partial<InventorySummary>): InventorySummary => ({
    activeSessions: 0,
    openRuns: 0,
    completedRuns: 0,
    conflicts: 0,
    lastActivityUtc: null,
    openRunDetails: [],
    completedRunDetails: [],
    conflictZones: [],
    ...overrides,
  })

  it('télécharge le fichier d’import MCS et affiche le refus de l’API', async () => {
    mockedFetchSummary.mockResolvedValue(summaryWith({ completedRuns: 2 }))
    mockedFetchLocations.mockResolvedValue([completedZone('B01')])
    mockedFetchLocationSummaries.mockResolvedValue([])
    mockedDownloadFile.mockRejectedValueOnce(
      new Error('Le fichier d’import MCS sera disponible quand l’inventaire sera terminé.'),
    )

    renderHomePage()

    expect(await screen.findByText(/Inventaire terminé/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Fichier d.import MCS \(CSV\)/ }))

    await waitFor(() =>
      expect(mockedDownloadFile).toHaveBeenCalledWith(
        expect.stringMatching(/\/shops\/shop-1\/reports\/inventory\/stock-import\.csv$/),
        'import-stock.csv',
      ),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('sera disponible quand l’inventaire sera terminé')

    mockedDownloadFile.mockResolvedValueOnce('recap.xlsx')
    fireEvent.click(screen.getByRole('button', { name: /Récap des comptages \(Excel\)/ }))
    await waitFor(() =>
      expect(mockedDownloadFile).toHaveBeenLastCalledWith(
        expect.stringMatching(/\/shops\/shop-1\/reports\/inventory\/recap\.xlsx$/),
        'recap-comptages.xlsx',
      ),
    )
  })

  it('propose le récap pendant l’inventaire, mais pas encore le fichier d’import', async () => {
    const pendingZone: Location = { ...completedZone('B02'), countStatuses: [] }
    mockedFetchSummary.mockResolvedValue(summaryWith({}))
    mockedFetchLocations.mockResolvedValue([pendingZone])
    mockedFetchLocationSummaries.mockResolvedValue([])
    mockedDownloadFile.mockResolvedValue('recap.xlsx')

    renderHomePage()

    const exports = await screen.findByRole('region', { name: 'Exports' })
    expect(within(exports).getByRole('button', { name: /Fichier d.import MCS : inventaire non terminé/ })).toBeDisabled()

    const recapButton = within(exports).getByRole('button', { name: /Récap des comptages \(Excel\)/ })
    expect(recapButton).toBeEnabled()
    fireEvent.click(recapButton)

    await waitFor(() =>
      expect(mockedDownloadFile).toHaveBeenCalledWith(
        expect.stringMatching(/\/recap\.xlsx$/),
        'recap-comptages.xlsx',
      ),
    )
  })
})
