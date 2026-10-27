import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelectShopPage } from '../../src/app/pages/select-shop/SelectShopPage'
import { ThemeProvider } from '../../src/theme/ThemeProvider'

type Shop = {
  id: string
  name: string
  kind: 'boutique' | 'lumiere' | 'camera'
}

type FetchShopsOptions = {
  signal?: AbortSignal
  kind?: Shop['kind']
}

const fetchShopsMock = vi.fn<(options?: FetchShopsOptions) => Promise<Shop[]>>()
const navigateMock = vi.fn()
const setShopMock = vi.fn()
const resetInventoryMock = vi.fn()
const clearSelectedUserForShopMock = vi.fn<(shopId: string) => void>()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')

  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ state: null }),
  }
})

vi.mock('../../src/api/shops', () => ({
  fetchShops: (options?: FetchShopsOptions) => fetchShopsMock(options),
}))

const shopContextValue = { shop: null as Shop | null, setShop: setShopMock }

vi.mock('../../src/state/ShopContext', () => ({
  useShop: () => shopContextValue,
}))

vi.mock('../../src/app/contexts/InventoryContext', () => ({
  useInventory: () => ({ reset: resetInventoryMock }),
}))

vi.mock('../../src/lib/selectedUserStorage', () => ({
  clearSelectedUserForShop: (shopId: string) => clearSelectedUserForShopMock(shopId),
}))

describe('SelectShopPage', () => {
  beforeEach(() => {
    fetchShopsMock.mockReset()
    navigateMock.mockReset()
    setShopMock.mockReset()
    resetInventoryMock.mockReset()
    clearSelectedUserForShopMock.mockReset()
    shopContextValue.shop = null
  })

  it('redirige immédiatement après la sélection d’une boutique via la grille', async () => {
    const shops: Shop[] = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Boutique Alpha', kind: 'boutique' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Boutique Beta', kind: 'lumiere' },
    ]
    fetchShopsMock.mockResolvedValueOnce(shops)

    const user = userEvent.setup()
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={[{ pathname: '/select-shop' }]}> 
          <SelectShopPage />
        </MemoryRouter>
      </ThemeProvider>,
    )

    // Un effet de la page peut annuler un clic arrivé pendant le chargement des boutiques :
    // on reclique jusqu'à ce que la sélection soit effective.
    await waitFor(async () => {
      const entityRadio = screen.getByRole('radio', { name: /CinéBoutique/i })
      await user.click(entityRadio)
      expect(entityRadio).toHaveAttribute('aria-checked', 'true')
    })

    const choice = await screen.findByRole('button', { name: /Boutique Alpha/i })
    await user.click(choice)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/select-user', undefined)
    })

    expect(setShopMock).toHaveBeenCalledWith(shops[0])
    expect(resetInventoryMock).toHaveBeenCalledTimes(1)
    expect(clearSelectedUserForShopMock).toHaveBeenCalledWith(shops[0].id)
  })

  it('permet de sélectionner une boutique Lumière et de naviguer', async () => {
    const shops: Shop[] = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Boutique Alpha', kind: 'boutique' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Lumière Gamma', kind: 'lumiere' },
    ]
    fetchShopsMock.mockResolvedValueOnce(shops)

    const user = userEvent.setup()
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={[{ pathname: '/select-shop' }]}> 
          <SelectShopPage />
        </MemoryRouter>
      </ThemeProvider>,
    )

    const lumiereRadio = await screen.findByRole('radio', { name: /Lumière/i })
    await user.click(lumiereRadio)

    const choice = await screen.findByRole('button', { name: /Lumière Gamma/i })
    await user.click(choice)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/select-user', undefined)
    })

    expect(setShopMock).toHaveBeenCalledWith(shops[1])
    expect(resetInventoryMock).toHaveBeenCalledTimes(1)
    expect(clearSelectedUserForShopMock).toHaveBeenCalledWith(shops[1].id)
  })
})
