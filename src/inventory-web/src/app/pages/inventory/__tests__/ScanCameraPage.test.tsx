import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InventoryProvider, useInventory } from '../../../contexts/InventoryContext'
import { CountType, type InventoryItem, type Location } from '../../../types/inventory'
import { ScanCameraPage } from '../ScanCameraPage'

import { RequestTimeoutError } from '@/lib/api/http'
import type { Shop } from '@/types/shop'
import type { ShopUser } from '@/types/user'

const fetchProductByEanMock = vi.hoisted(() => vi.fn())
const startInventoryRunMock = vi.hoisted(() => vi.fn())
const decodeBarcodeFromFileMock = vi.hoisted(() => vi.fn())
const scannerCallbacks = vi.hoisted(() => ({
  onDetected: undefined as undefined | ((value: string) => void | Promise<void>),
  onPickImage: undefined as undefined | ((file: File) => void),
}))
// État caméra piloté par les tests : la page est testée indépendamment du hook `useCamera`
// (dont le comportement réel — getUserMedia, contraintes, repli — est couvert par ses propres tests).
const cameraState = vi.hoisted(() => ({
  active: false,
  error: null as unknown,
  canSwitchCamera: false,
  switchCamera: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  stop: vi.fn(),
}))

vi.mock('../../../api/inventoryApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/inventoryApi')>()
  return {
    ...actual,
    fetchProductByEan: fetchProductByEanMock,
    startInventoryRun: startInventoryRunMock,
  }
})

vi.mock('@/lib/scan/barcodeDetector', () => ({
  decodeBarcodeFromFile: decodeBarcodeFromFileMock,
}))

vi.mock('@/hooks/useCamera', () => ({
  useCamera: () => ({
    active: cameraState.active,
    error: cameraState.error,
    start: cameraState.start,
    stop: cameraState.stop,
    devices: [],
    currentDeviceId: null,
    canSwitchCamera: cameraState.canSwitchCamera,
    switchCamera: cameraState.switchCamera,
  }),
}))

vi.mock('../../../components/BarcodeScanner', () => ({
  BarcodeScanner: ({
    onDetected,
    onPickImage,
    onTorchStateChange,
    torchControllerRef,
  }: {
    onDetected: (value: string) => void | Promise<void>
    onPickImage?: (file: File) => void
    onTorchStateChange?: (state: { supported: boolean; enabled: boolean }) => void
    torchControllerRef?: {
      current: null | { set: (value: boolean) => Promise<boolean>; toggle: () => Promise<boolean> }
    }
  }) => {
    // Déclenche les callbacks après le render pour éviter les warnings “setState during render”.
    useEffect(() => {
      scannerCallbacks.onDetected = onDetected
      scannerCallbacks.onPickImage = onPickImage
      onTorchStateChange?.({ supported: false, enabled: false })
      if (torchControllerRef) {
        torchControllerRef.current = {
          set: async () => true,
          toggle: async () => true,
        }
      }
    }, [onDetected, onPickImage, onTorchStateChange, torchControllerRef])

    return (
      <button type="button" data-testid="mock-barcode-scanner" onClick={() => onDetected('0123456789012')}>
        Simuler un scan
      </button>
    )
  },
}))

const shopMock: Shop = { id: 'shop-1', name: 'CinéBoutique Paris', kind: 'boutique' }
const userMock: ShopUser = {
  id: 'user-1',
  shopId: shopMock.id,
  login: 'user',
  displayName: 'Utilisateur Test',
  isAdmin: false,
  disabled: false,
}

const locationMock: Location = {
  id: 'loc-1',
  code: 'Z01',
  label: 'Zone test',
  isBusy: false,
  busyBy: null,
  activeRunId: null,
  activeCountType: null,
  activeStartedAtUtc: null,
  countStatuses: [],
  disabled: false,
}

vi.mock('@/state/ShopContext', () => ({
  useShop: () => ({ shop: shopMock, isLoaded: true, setShop: vi.fn() }),
}))

type ItemSeed = { ean: string; name: string; quantity?: number }

const InventoryInitializer = ({
  children,
  initialItems = [],
  countType = CountType.Count1,
}: {
  children: ReactNode
  initialItems?: ItemSeed[]
  countType?: CountType
}) => {
  const { setSelectedUser, setLocation, setCountType, clearSession, addOrIncrementItem, setQuantity } = useInventory()

  useLayoutEffect(() => {
    clearSession()
    setSelectedUser(userMock)
    setLocation(locationMock)
    setCountType(countType)
  }, [clearSession, countType, setCountType, setLocation, setSelectedUser])

  useEffect(() => {
    initialItems.forEach((item) => {
      addOrIncrementItem({ ean: item.ean, name: item.name })
      if (item.quantity && item.quantity > 1) {
        setQuantity(item.ean, item.quantity)
      }
    })
  }, [addOrIncrementItem, initialItems, setQuantity])

  return <>{children}</>
}

const renderScanCameraPage = (options?: {
  items?: ItemSeed[]
  countType?: CountType
  onItemsChange?: (items: InventoryItem[]) => void
}) => {
  const onItemsChange = options?.onItemsChange
  const ItemsObserver = () => {
    const { items } = useInventory()
    const handlerRef = useRef(onItemsChange)

    useEffect(() => {
      handlerRef.current = onItemsChange
    })

    useEffect(() => {
      handlerRef.current?.(items)
    }, [items])

    return null
  }

  return render(
    <MemoryRouter initialEntries={[{ pathname: '/inventory/scan-camera' }]}>
      <InventoryProvider>
        <InventoryInitializer initialItems={options?.items} countType={options?.countType}>
          <ItemsObserver />
          <ScanCameraPage />
        </InventoryInitializer>
      </InventoryProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  fetchProductByEanMock.mockReset()
  startInventoryRunMock.mockReset()
  decodeBarcodeFromFileMock.mockReset()
  scannerCallbacks.onDetected = undefined
  scannerCallbacks.onPickImage = undefined
  cameraState.active = false
  cameraState.error = null
  cameraState.canSwitchCamera = false
  cameraState.switchCamera.mockClear()
  cameraState.start.mockClear()
  cameraState.stop.mockClear()
  cleanup()
})

describe('ScanCameraPage', () => {
  it('affiche les informations de la zone et la quantité totale', async () => {
    renderScanCameraPage({
      items: [
        { ean: '1000000000001', name: 'Article 1' },
        { ean: '1000000000002', name: 'Article 2' },
      ],
    })

    expect(await screen.findByText('CinéBoutique Paris')).toBeInTheDocument()
    expect(screen.getByText('Zone test')).toBeInTheDocument()
    expect(screen.getByText('2 pièces')).toBeInTheDocument()
  })

  it('met à jour la quantité via les boutons plus et moins', async () => {
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      items: [{ ean: '2000000000001', name: 'Produit test', quantity: 2 }],
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    const row = await screen.findByTestId('scanned-row')
    const increment = within(row).getByRole('button', { name: /augmenter/i })
    const decrement = within(row).getByRole('button', { name: /diminuer/i })
    const input = within(row).getByRole('textbox', { name: /quantité/i })

    await userEvent.click(increment)
    await waitFor(() => expect(input).toHaveValue('3'))
    expect(latestItems[0]?.quantity).toBe(3)

    await userEvent.click(decrement)
    await waitFor(() => expect(input).toHaveValue('2'))
    expect(latestItems[0]?.quantity).toBe(2)
  })

  it('permet la saisie directe de la quantité', async () => {
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      items: [{ ean: '3000000000001', name: 'Produit manuel', quantity: 1 }],
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    const row = await screen.findByTestId('scanned-row')
    const input = within(row).getByRole('textbox', { name: /quantité/i })

    await userEvent.clear(input)
    await userEvent.type(input, '12')
    expect(input).toHaveValue('12')
    fireEvent.blur(input)

    await waitFor(() => expect(latestItems[0]?.quantity).toBe(12))
  })

  it('ajoute un article lors d’une détection simulée', async () => {
    fetchProductByEanMock.mockResolvedValue({
      ean: '9876543210987',
      name: 'Produit détecté',
      sku: 'SKU-987654',
      subGroup: 'Goodies',
    })
    startInventoryRunMock.mockResolvedValue({ runId: 'run-1' })

    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    await waitFor(() => expect(typeof scannerCallbacks.onDetected).toBe('function'))
    await scannerCallbacks.onDetected?.('0123456789012')

    await waitFor(() =>
      expect(fetchProductByEanMock).toHaveBeenCalledWith(
        '0123456789012',
        expect.objectContaining({ signal: expect.any(Object) }),
      ),
    )
    expect(startInventoryRunMock).toHaveBeenCalled()
    await waitFor(() => expect(latestItems.some((item) => item.product.ean === '9876543210987')).toBe(true))
    const row = await screen.findByTestId('scanned-row')
    expect(within(row).getByText('Produit détecté')).toBeInTheDocument()
    expect(within(row).getByText(/Sous-groupe Goodies/)).toBeInTheDocument()
  })

  it('normalise les codes alphanumériques sans filtrer les lettres', async () => {
    fetchProductByEanMock.mockResolvedValue({ ean: 'RFID-123A', name: 'Badge RFID' })
    startInventoryRunMock.mockResolvedValue({ runId: 'run-2' })

    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    await waitFor(() => expect(typeof scannerCallbacks.onDetected).toBe('function'))
    await scannerCallbacks.onDetected?.(' rf id-123a ')

    await waitFor(() =>
      expect(fetchProductByEanMock).toHaveBeenCalledWith(
        ' rf id-123a ',
        expect.objectContaining({ signal: expect.any(Object) }),
      ),
    )
    await waitFor(() => expect(startInventoryRunMock).toHaveBeenCalled())
    await waitFor(() => expect(latestItems.some((item) => item.product.ean === 'RFID-123A')).toBe(true))
    expect(await screen.findByText('Badge RFID')).toBeInTheDocument()
  })

  it("signale l'absence de résultat sans proposer d'ajout manuel", async () => {
    fetchProductByEanMock.mockRejectedValue({ status: 404 })

    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    await waitFor(() => expect(typeof scannerCallbacks.onDetected).toBe('function'))
    await scannerCallbacks.onDetected?.('0123456789012')

    await waitFor(() =>
      expect(
        screen.getByText('Code 0123456789012 introuvable dans la liste des produits à inventorier.'),
      ).toBeInTheDocument(),
    )
    expect(latestItems.some((item) => item.product.ean === '0123456789012')).toBe(false)
  })

  it('affiche un message lorsque la récupération du produit dépasse le délai', async () => {
    fetchProductByEanMock.mockRejectedValue(new RequestTimeoutError('/api/products/slow', 5000))

    renderScanCameraPage()

    await waitFor(() => expect(typeof scannerCallbacks.onDetected).toBe('function'))
    await scannerCallbacks.onDetected?.('0123456789012')

    await waitFor(() =>
      expect(
        screen.getByText('Lecture du produit trop longue. Vérifiez la connexion et réessayez.'),
      ).toBeInTheDocument(),
    )
  })

  it('ignore les lectures répétées du même code tant que la caméra le voit', async () => {
    fetchProductByEanMock.mockResolvedValue({ ean: '5555555555555', name: 'Bonbon' })
    startInventoryRunMock.mockResolvedValue({ runId: 'run-lock' })

    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    await waitFor(() => expect(typeof scannerCallbacks.onDetected).toBe('function'))

    await scannerCallbacks.onDetected?.('0123456789012')
    await waitFor(() => expect(fetchProductByEanMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(latestItems[0]?.quantity).toBe(1))

    await scannerCallbacks.onDetected?.('0123456789012')
    expect(fetchProductByEanMock).toHaveBeenCalledTimes(1)

    await new Promise((resolve) => setTimeout(resolve, 800))
    await scannerCallbacks.onDetected?.('0123456789012')
    await waitFor(() => expect(fetchProductByEanMock).toHaveBeenCalledTimes(2))
  })

  it('décode une photo de secours avec le même détecteur et traite le code lu', async () => {
    decodeBarcodeFromFileMock.mockResolvedValue('4006381333931')
    fetchProductByEanMock.mockResolvedValue({ ean: '4006381333931', name: 'Produit photo' })
    startInventoryRunMock.mockResolvedValue({ runId: 'run-photo' })

    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      onItemsChange: (items) => {
        latestItems = items
      },
    })

    await waitFor(() => expect(typeof scannerCallbacks.onPickImage).toBe('function'))
    const file = new File(['x'], 'code.jpg', { type: 'image/jpeg' })
    scannerCallbacks.onPickImage?.(file)

    await waitFor(() => expect(decodeBarcodeFromFileMock).toHaveBeenCalledWith(file))
    await waitFor(() =>
      expect(fetchProductByEanMock).toHaveBeenCalledWith(
        '4006381333931',
        expect.objectContaining({ signal: expect.any(Object) }),
      ),
    )
    await waitFor(() => expect(latestItems.some((item) => item.product.ean === '4006381333931')).toBe(true))
    expect(await screen.findByText('Produit photo')).toBeInTheDocument()
  })

  it('explique quand la photo ne contient aucun code lisible', async () => {
    decodeBarcodeFromFileMock.mockResolvedValue(null)

    renderScanCameraPage()

    await waitFor(() => expect(typeof scannerCallbacks.onPickImage).toBe('function'))
    scannerCallbacks.onPickImage?.(new File(['x'], 'flou.jpg', { type: 'image/jpeg' }))

    expect(
      await screen.findByText('Aucun code-barres lisible sur la photo. Rapprochez-vous et réessayez.'),
    ).toBeInTheDocument()
    expect(fetchProductByEanMock).not.toHaveBeenCalled()
  })

  it('affiche un message caméra en français avec le détail technique en petit', async () => {
    cameraState.error = new DOMException('Permission denied', 'NotAllowedError')

    renderScanCameraPage()

    const panel = await screen.findByTestId('scan-camera-error')
    expect(within(panel).getByText('Caméra indisponible')).toBeInTheDocument()
    expect(
      within(panel).getByText('Autorisez l’accès à la caméra dans les réglages du navigateur, puis réessayez.'),
    ).toBeInTheDocument()
    expect(within(panel).queryByText(/NotAllowedError/)).not.toBeInTheDocument()
  })

  it('signale un site non sécurisé plutôt qu’une erreur technique brute', async () => {
    const insecure = new Error('getUserMedia indisponible')
    insecure.name = 'InsecureContextError'
    cameraState.error = insecure

    renderScanCameraPage()

    expect(
      await screen.findByText('Site non sécurisé (HTTPS requis). Contactez le service informatique.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/getUserMedia indisponible/)).not.toBeInTheDocument()
  })

  it('propose de changer de caméra uniquement quand le hook le permet', async () => {
    cameraState.active = true
    cameraState.canSwitchCamera = true

    renderScanCameraPage()

    const button = await screen.findByTestId('scan-camera-switch')
    expect(button).toHaveAccessibleName('Changer de caméra')
    await userEvent.click(button)
    expect(cameraState.switchCamera).toHaveBeenCalledTimes(1)
  })

  it('masque le changement de caméra sans second objectif arrière', async () => {
    cameraState.active = true
    cameraState.canSwitchCamera = false

    renderScanCameraPage()

    await screen.findByText('CinéBoutique Paris')
    expect(screen.queryByTestId('scan-camera-switch')).not.toBeInTheDocument()
  })
})
