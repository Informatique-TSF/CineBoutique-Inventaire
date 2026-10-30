import { render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/App'
import type { InventoryContextValue } from '@/app/contexts/InventoryContext'
import type { Location } from '@/app/types/inventory'
import { CountType } from '@/app/types/inventory'
import { SELECTED_USER_STORAGE_PREFIX } from '@/lib/selectedUserStorage'
import type { Shop } from '@/types/shop'
import type { ShopUser } from '@/types/user'

type UseShopValue = {
  shop: Shop | null
  setShop: (shop: Shop | null) => void
  isLoaded: boolean
}

const createUseShopValue = (overrides: Partial<UseShopValue> = {}): UseShopValue => ({
  shop: null,
  setShop: () => undefined,
  isLoaded: true,
  ...overrides,
})

const useShopMock = vi.hoisted(() =>
  vi.fn(() => ({
    shop: null,
    setShop: () => undefined,
    isLoaded: true,
  } as UseShopValue)),
)

type UseInventoryValue = InventoryContextValue

const defaultInventoryUser: ShopUser = {
  id: 'user-default',
  shopId: 'shop-1',
  login: 'user.default',
  displayName: 'Utilisateur démo',
  isAdmin: false,
  disabled: false,
}

const defaultInventoryLocation: Location = {
  id: '11111111-1111-1111-1111-111111111111',
  code: 'LOC-1',
  label: 'Zone 1',
  isBusy: false,
  busyBy: null,
  activeRunId: null,
  activeCountType: null,
  activeStartedAtUtc: null,
  countStatuses: [],
  disabled: false,
}

const createUseInventoryValue = (overrides: Partial<UseInventoryValue> = {}): UseInventoryValue => ({
  selectedUser: { ...defaultInventoryUser },
  countType: CountType.Count1,
  location: { ...defaultInventoryLocation, countStatuses: [...defaultInventoryLocation.countStatuses] },
  sessionId: null,
  items: [],
  logs: [],
  restoredDraft: null,
  setSelectedUser: vi.fn(),
  setCountType: vi.fn(),
  setLocation: vi.fn(),
  setSessionId: vi.fn(),
  addOrIncrementItem: vi.fn(),
  initializeItems: vi.fn(),
  setQuantity: vi.fn(),
  removeItem: vi.fn(),
  reset: vi.fn(),
  clearSession: vi.fn(),
  logEvent: vi.fn(),
  clearLogs: vi.fn(),
  dismissRestoredDraft: vi.fn(),
  ...overrides,
})

const useInventoryMock = vi.hoisted(() => vi.fn(() => createUseInventoryValue()))

const fetchShopUsersMock = vi.hoisted(() =>
  vi.fn<(shopId: string) => Promise<ShopUser[]>>(async () => [defaultInventoryUser]),
)

vi.mock('@/state/ShopContext', () => ({
  useShop: () => useShopMock(),
}))

vi.mock('@/app/contexts/InventoryContext', () => ({
  useInventory: () => useInventoryMock(),
}))

vi.mock('@/app/api/shopUsers', () => ({
  fetchShopUsers: fetchShopUsersMock,
}))

vi.mock('@/app/pages/home/HomePage', () => ({
  HomePage: () => <div data-testid="home-page">Accueil</div>,
}))

vi.mock('@/app/pages/select-shop/SelectShopPage', () => ({
  SelectShopPage: () => <div data-testid="select-shop-page">Sélection boutique</div>,
}))

vi.mock('@/app/pages/SelectUserPage', () => ({
  default: () => <div data-testid="select-user-page">Sélection utilisateur</div>,
}))

vi.mock('@/app/pages/inventory/InventoryLayout', () => ({
  InventoryLayout: () => (
    <div data-testid="inventory-layout">
      <Outlet />
    </div>
  ),
}))

vi.mock('@/app/pages/inventory/InventoryLocationStep', () => ({
  InventoryLocationStep: () => <div data-testid="inventory-location-step" />,
}))

vi.mock('@/app/pages/inventory/InventoryCountTypeStep', () => ({
  InventoryCountTypeStep: () => <div data-testid="inventory-count-type-step" />, 
}))

vi.mock('@/app/pages/inventory/InventorySessionPage', () => ({
  InventorySessionPage: () => <div data-testid="inventory-session-page" />, 
}))

vi.mock('@/app/pages/admin/AdminLayout', () => ({
  AdminLayout: () => <div data-testid="admin-layout" />, 
}))

vi.mock('@/app/pages/admin/AdminLocationsPage', () => ({
  AdminLocationsPage: () => <div data-testid="admin-locations" />, 
}))

// Les mocks ci-dessus doivent être déclarés avant d'importer AppRoutes

describe('AppRoutes', () => {
  beforeEach(() => {
    useShopMock.mockReset()
    useInventoryMock.mockReset()
    useInventoryMock.mockReturnValue(createUseInventoryValue())
    sessionStorage.clear()
    fetchShopUsersMock.mockReset()
    fetchShopUsersMock.mockImplementation(async () => [defaultInventoryUser])
  })

  it('redirige vers la page de sélection quand aucune boutique n’est définie', async () => {
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop: null,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: true,
      }),
    )

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('select-shop-page')).toBeInTheDocument()
  })

  it('affiche la page d’accueil quand une boutique est disponible', async () => {
    const shop: Shop = { id: 'shop-1', name: 'Boutique 1', kind: 'boutique' }
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: true,
      }),
    )
    sessionStorage.setItem(
      `${SELECTED_USER_STORAGE_PREFIX}.${shop.id}`,
      JSON.stringify({
        userId: defaultInventoryUser.id,
        displayName: defaultInventoryUser.displayName,
        login: defaultInventoryUser.login,
        shopId: shop.id,
        isAdmin: defaultInventoryUser.isAdmin,
        disabled: defaultInventoryUser.disabled,
      }),
    )

    const seenPaths: string[] = []

    const LocationTracker = () => {
      const location = useLocation()
      useEffect(() => {
        seenPaths.push(location.pathname)
      }, [location])
      return null
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <LocationTracker />
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(seenPaths.at(-1)).toBe('/')
  })

  it('affiche le chargement tant que la boutique n’est pas initialisée', async () => {
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop: null,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: false,
      }),
    )

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(
      await screen.findByText('Chargement de votre boutique…'),
    ).toBeInTheDocument()
  })

  it('redirige vers l’identification quand aucun utilisateur n’est mémorisé', async () => {
    const shop: Shop = { id: 'shop-2', name: 'Boutique 2', kind: 'boutique' }
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: true,
      }),
    )

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('select-user-page')).toBeInTheDocument()
  })

  it('redirige vers la sélection de zone avant la caméra quand aucune zone n’est définie', async () => {
    const shop: Shop = { id: 'shop-3', name: 'Boutique 3', kind: 'boutique' }
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: true,
      }),
    )
    sessionStorage.setItem(
      `${SELECTED_USER_STORAGE_PREFIX}.${shop.id}`,
      JSON.stringify({
        userId: defaultInventoryUser.id,
        displayName: defaultInventoryUser.displayName,
        login: defaultInventoryUser.login,
        shopId: shop.id,
        isAdmin: defaultInventoryUser.isAdmin,
        disabled: defaultInventoryUser.disabled,
      }),
    )
    useInventoryMock.mockReturnValue(
      createUseInventoryValue({
        location: null,
        selectedUser: defaultInventoryUser,
      }),
    )

    render(
      <MemoryRouter initialEntries={['/inventory/scan-camera']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('inventory-location-step')).toBeInTheDocument()
  })

  it('redirige vers l’accueil quand un utilisateur standard tente d’accéder à /admin', async () => {
    const shop: Shop = { id: 'shop-admin', name: 'Boutique Admin', kind: 'boutique' }
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: true,
      }),
    )
    const nonAdmin = { ...defaultInventoryUser, isAdmin: false }
    sessionStorage.setItem(
      `${SELECTED_USER_STORAGE_PREFIX}.${shop.id}`,
      JSON.stringify({
        userId: nonAdmin.id,
        displayName: nonAdmin.displayName,
        login: nonAdmin.login,
        shopId: shop.id,
        isAdmin: nonAdmin.isAdmin,
        disabled: nonAdmin.disabled,
      }),
    )
    useInventoryMock.mockReturnValue(
      createUseInventoryValue({
        selectedUser: nonAdmin,
      }),
    )

    const seenPaths: string[] = []
    const LocationTracker = () => {
      const loc = useLocation()
      useEffect(() => {
        seenPaths.push(loc.pathname)
      }, [loc])
      return null
    }

    render(
      <MemoryRouter initialEntries={['/admin']}>
        <LocationTracker />
        <AppRoutes />
      </MemoryRouter>,
    )

    const homeInstances = await screen.findAllByTestId('home-page')
    expect(homeInstances.length).toBeGreaterThan(0)
    expect(screen.queryByTestId('admin-layout')).not.toBeInTheDocument()
    expect(seenPaths.at(-1)).toBe('/')
  })

  it('affiche la page administrateur pour un utilisateur admin', async () => {
    const shop: Shop = { id: 'shop-admin2', name: 'Boutique Admin 2', kind: 'boutique' }
    const adminUser = { ...defaultInventoryUser, isAdmin: true }
    useShopMock.mockReturnValue(
      createUseShopValue({
        shop,
        setShop: vi.fn() as unknown as UseShopValue['setShop'],
        isLoaded: true,
      }),
    )
    sessionStorage.setItem(
      `${SELECTED_USER_STORAGE_PREFIX}.${shop.id}`,
      JSON.stringify({
        userId: adminUser.id,
        displayName: adminUser.displayName,
        login: adminUser.login,
        shopId: shop.id,
        isAdmin: adminUser.isAdmin,
        disabled: adminUser.disabled,
      }),
    )
    useInventoryMock.mockReturnValue(
      createUseInventoryValue({
        selectedUser: adminUser,
      }),
    )

    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AppRoutes />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('admin-layout')).toBeInTheDocument()
  })
})
