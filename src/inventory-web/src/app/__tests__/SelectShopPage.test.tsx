import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, type Location } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FetchShopsOptions } from '@/api/shops'
import { SelectShopPage } from '@/app/pages/select-shop/SelectShopPage'
import { ThemeProvider } from '@/theme/ThemeProvider'
import type { Shop } from '@/types/shop'

const fetchShopsMock = vi.hoisted(() => vi.fn<(options?: FetchShopsOptions) => Promise<Shop[]>>())
const useShopMock = vi.hoisted(() =>
  vi.fn(() => ({ shop: null, setShop: () => undefined, isLoaded: true })),
)
const useInventoryMock = vi.hoisted(() => vi.fn(() => ({ reset: () => undefined })))
const loadShopMock = vi.hoisted(() => vi.fn())
const clearShopMock = vi.hoisted(() => vi.fn())
const clearSelectedUserMock = vi.hoisted(() => vi.fn())
const setShopFn = vi.hoisted(() => vi.fn())
const resetInventoryFn = vi.hoisted(() => vi.fn())

vi.mock('@/api/shops', () => ({
  fetchShops: (options?: FetchShopsOptions) => fetchShopsMock(options),
}))

vi.mock('@/state/ShopContext', () => ({
  useShop: () => useShopMock(),
}))

vi.mock('@/app/contexts/InventoryContext', () => ({
  useInventory: () => useInventoryMock(),
}))

vi.mock('@/lib/shopStorage', () => ({
  loadShop: () => loadShopMock(),
  clearShop: (...args: Parameters<typeof clearShopMock>) => clearShopMock(...args),
}))

vi.mock('@/lib/selectedUserStorage', () => ({
  clearSelectedUserForShop: (...args: Parameters<typeof clearSelectedUserMock>) =>
    clearSelectedUserMock(...args),
  SELECTED_USER_STORAGE_PREFIX: 'cb.inventory.selectedUser',
}))

describe('SelectShopPage (routing)', () => {
  const shop: Shop = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Boutique 1',
    kind: 'boutique',
  }

  beforeEach(() => {
    fetchShopsMock.mockReset()
    fetchShopsMock.mockResolvedValue([shop])
    setShopFn.mockReset()
    resetInventoryFn.mockReset()
    clearSelectedUserMock.mockReset()
    loadShopMock.mockReturnValue(null)
    clearShopMock.mockReset()

    useShopMock.mockReturnValue({ shop: null, setShop: setShopFn, isLoaded: true })
    useInventoryMock.mockReturnValue({ reset: resetInventoryFn })
  })

  it('redirige vers la page de sélection utilisateur après avoir choisi une boutique', async () => {
    const locations: Location[] = []
    const LocationObserver = () => {
      const location = useLocation()
      useEffect(() => {
        locations.push(location)
      }, [location])
      return null
    }

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/select-shop']}>
          <LocationObserver />
          <SelectShopPage />
        </MemoryRouter>
      </ThemeProvider>,
    )

    // Un effet de la page peut annuler un clic arrivé pendant le chargement des boutiques :
    // on reclique jusqu'à ce que la sélection soit effective.
    await waitFor(() => {
      const entityRadio = screen.getByRole('radio', { name: /CinéBoutique/i })
      fireEvent.click(entityRadio)
      expect(entityRadio).toHaveAttribute('aria-checked', 'true')
    })

    const shopButton = await screen.findByTestId(`shop-${shop.id}`)
    fireEvent.click(shopButton)

    await waitFor(() => expect(setShopFn).toHaveBeenCalledWith(shop))
    await waitFor(() => expect(resetInventoryFn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(clearSelectedUserMock).toHaveBeenCalledWith(shop.id))
    await waitFor(() => expect(locations.at(-1)?.pathname).toBe('/select-user'))
  })

  it('conserve la cible de redirection transmise via location.state', async () => {
    const locations: Location[] = []
    const LocationObserver = () => {
      const location = useLocation()
      useEffect(() => {
        locations.push(location)
      }, [location])
      return null
    }

    render(
      <ThemeProvider>
        <MemoryRouter
          initialEntries={[{ pathname: '/select-shop', state: { redirectTo: '/inventory/location' } }]}
        >
          <LocationObserver />
          <SelectShopPage />
        </MemoryRouter>
      </ThemeProvider>,
    )

    // Un effet de la page peut annuler un clic arrivé pendant le chargement des boutiques :
    // on reclique jusqu'à ce que la sélection soit effective.
    await waitFor(() => {
      const entityRadio = screen.getByRole('radio', { name: /CinéBoutique/i })
      fireEvent.click(entityRadio)
      expect(entityRadio).toHaveAttribute('aria-checked', 'true')
    })

    const shopButton = await screen.findByTestId(`shop-${shop.id}`)
    fireEvent.click(shopButton)

    await waitFor(() => expect(locations.at(-1)?.pathname).toBe('/select-user'))
    expect(locations.at(-1)?.state).toMatchObject({ redirectTo: '/inventory/location' })
  })
})
