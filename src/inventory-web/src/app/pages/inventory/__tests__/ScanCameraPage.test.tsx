import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InventoryProvider, useInventory } from '../../../contexts/InventoryContext'
import { CountType, type InventoryItem, type Location, type Product } from '../../../types/inventory'
import { SAME_CODE_COOLDOWN_MS, ScanCameraPage } from '../ScanCameraPage'

import { AbortedRequestError, RequestTimeoutError } from '@/lib/api/http'
import type { Shop } from '@/types/shop'
import type { ShopUser } from '@/types/user'

const fetchProductByEanMock = vi.hoisted(() => vi.fn())
const startInventoryRunMock = vi.hoisted(() => vi.fn())
const decodeBarcodeFromFileMock = vi.hoisted(() => vi.fn())
const scannerState = vi.hoisted(() => ({
  onDetected: undefined as undefined | ((value: string) => void | Promise<void>),
  onPickImage: undefined as undefined | ((file: File) => void | Promise<void>),
  paused: undefined as boolean | undefined,
  frameTone: undefined as string | undefined,
  torchSupported: false,
  torchToggle: vi.fn(async () => true),
  torchSet: vi.fn(async () => true),
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
    paused,
    frameTone,
  }: {
    onDetected: (value: string) => void | Promise<void>
    onPickImage?: (file: File) => void | Promise<void>
    onTorchStateChange?: (state: { supported: boolean; enabled: boolean }) => void
    torchControllerRef?: {
      current: null | { set: (value: boolean) => Promise<boolean>; toggle: () => Promise<boolean> }
    }
    paused?: boolean
    frameTone?: string
  }) => {
    scannerState.paused = paused
    scannerState.frameTone = frameTone
    // Déclenche les callbacks après le render pour éviter les warnings “setState during render”.
    useEffect(() => {
      scannerState.onDetected = onDetected
      scannerState.onPickImage = onPickImage
      onTorchStateChange?.({ supported: scannerState.torchSupported, enabled: false })
      if (torchControllerRef) {
        torchControllerRef.current = {
          set: scannerState.torchSet,
          toggle: scannerState.torchToggle,
        }
      }
    }, [onDetected, onPickImage, onTorchStateChange, torchControllerRef])

    return <div data-testid="mock-barcode-scanner" />
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

const clapProduct: Product = {
  ean: '3700412308516',
  name: 'Clap blanc grand modèle',
  sku: 'A-CLAPBLAGM',
  subGroup: 'Accessoires',
}

type ItemSeed = { ean: string; name: string; sku?: string; quantity?: number }

const InventoryInitializer = ({
  children,
  initialItems = [],
  countType = CountType.Count1,
}: {
  children: ReactNode
  initialItems?: ItemSeed[]
  countType?: CountType
}) => {
  const { setSelectedUser, setLocation, setCountType, clearSession, addOrIncrementItem } = useInventory()

  useLayoutEffect(() => {
    clearSession()
    setSelectedUser(userMock)
    setLocation(locationMock)
    setCountType(countType)
  }, [clearSession, countType, setCountType, setLocation, setSelectedUser])

  useEffect(() => {
    initialItems.forEach((item) => {
      addOrIncrementItem({ ean: item.ean, name: item.name, sku: item.sku }, { quantity: item.quantity ?? 1 })
    })
  }, [addOrIncrementItem, initialItems])

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
          <LocationDisplay />
          <ScanCameraPage />
        </InventoryInitializer>
      </InventoryProvider>
    </MemoryRouter>,
  )
}

const LocationDisplay = () => {
  const { pathname } = useLocation()
  return <p data-testid="current-path">{pathname}</p>
}

const waitForScanner = async () => {
  await waitFor(() => expect(typeof scannerState.onDetected).toBe('function'))
}

/** Simule une lecture caméra et attend la fin du traitement (recherche du produit comprise). */
const detect = async (code: string) => {
  await act(async () => {
    await scannerState.onDetected?.(code)
  })
}

afterEach(() => {
  fetchProductByEanMock.mockReset()
  startInventoryRunMock.mockReset()
  decodeBarcodeFromFileMock.mockReset()
  scannerState.onDetected = undefined
  scannerState.onPickImage = undefined
  scannerState.paused = undefined
  scannerState.frameTone = undefined
  scannerState.torchSupported = false
  scannerState.torchToggle.mockClear()
  scannerState.torchSet.mockClear()
  cameraState.active = false
  cameraState.error = null
  cameraState.canSwitchCamera = false
  cameraState.switchCamera.mockClear()
  cameraState.start.mockClear()
  cameraState.stop.mockClear()
  vi.restoreAllMocks()
  cleanup()
})

describe('ScanCameraPage', () => {
  it('affiche la zone et le total compté dans la barre du bas', async () => {
    renderScanCameraPage({
      items: [
        { ean: '1000000000001', name: 'Article 1' },
        { ean: '1000000000002', name: 'Article 2', quantity: 3 },
      ],
    })

    const bar = await screen.findByTestId('scan-summary-bar')
    expect(within(bar).getByText('Zone test')).toBeInTheDocument()
    await waitFor(() => expect(within(bar).getByTestId('scan-summary')).toHaveTextContent('2 réf. · 4 pièces'))
  })

  it('ouvre une fiche avec le code équipement et l’intitulé, sans rien compter avant validation', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitForScanner()
    expect(scannerState.paused).toBe(false)
    await detect('3700412308516')

    expect(fetchProductByEanMock).toHaveBeenCalledWith(
      '3700412308516',
      expect.objectContaining({ signal: expect.any(Object) }),
    )
    const sheet = await screen.findByTestId('scan-count-sheet')
    expect(within(sheet).getByRole('heading', { name: 'Clap blanc grand modèle' })).toBeInTheDocument()
    expect(within(sheet).getByText('A-CLAPBLAGM')).toBeInTheDocument()
    expect(within(sheet).getByText('EAN 3700412308516')).toBeInTheDocument()
    expect(within(sheet).getByText('Sous-groupe Accessoires')).toBeInTheDocument()
    expect(within(sheet).getByText('Code lu · nouveau dans cette zone')).toBeInTheDocument()
    expect(within(sheet).getByRole('textbox', { name: 'Quantité' })).toHaveValue('1')
    expect(within(sheet).getByTestId('scan-sheet-confirm')).toHaveTextContent('Valider · 1 pièce')
    // La lecture est suspendue et le cadre passe au vert tant que la fiche est ouverte.
    expect(scannerState.paused).toBe(true)
    expect(scannerState.frameTone).toBe('success')
    expect(screen.getByText('Lecture en pause')).toBeInTheDocument()
    expect(latestItems).toHaveLength(0)
    expect(startInventoryRunMock).not.toHaveBeenCalled()
  })

  it('valide la quantité choisie, revient à la caméra et propose d’annuler', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    startInventoryRunMock.mockResolvedValue({ runId: 'run-1' })
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitForScanner()
    await detect('3700412308516')
    const sheet = await screen.findByTestId('scan-count-sheet')

    await userEvent.click(within(sheet).getByRole('button', { name: '3 pièces' }))
    expect(within(sheet).getByRole('button', { name: '3 pièces' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Valider · 3 pièces' }))

    await waitFor(() => expect(screen.queryByTestId('scan-count-sheet')).not.toBeInTheDocument())
    expect(startInventoryRunMock).toHaveBeenCalledWith('loc-1', {
      shopId: 'shop-1',
      ownerUserId: 'user-1',
      countType: CountType.Count1,
    })
    expect(latestItems[0]?.product.ean).toBe('3700412308516')
    expect(latestItems[0]?.quantity).toBe(3)
    const toast = screen.getByTestId('scan-undo-toast')
    expect(toast).toHaveTextContent('+3 · Clap blanc grand modèle')
    expect(toast).toHaveTextContent('A-CLAPBLAGM · total dans la zone : 3')
    expect(scannerState.paused).toBe(false)
    expect(screen.getByTestId('scan-summary')).toHaveTextContent('1 réf. · 3 pièces')

    await userEvent.click(within(toast).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(latestItems).toHaveLength(0))
    expect(screen.queryByTestId('scan-undo-toast')).not.toBeInTheDocument()
  })

  it('ajoute la quantité saisie à un produit déjà compté dans la zone', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    startInventoryRunMock.mockResolvedValue({ runId: 'run-2' })
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      items: [{ ean: clapProduct.ean, name: clapProduct.name, sku: clapProduct.sku, quantity: 2 }],
      onItemsChange: (items) => (latestItems = items),
    })

    await waitFor(() => expect(latestItems[0]?.quantity).toBe(2))
    await waitForScanner()
    await detect('3700412308516')
    const sheet = await screen.findByTestId('scan-count-sheet')

    expect(within(sheet).getByText('Déjà compté dans cette zone : 2 pièces')).toBeInTheDocument()
    expect(scannerState.frameTone).toBe('warning')
    const input = within(sheet).getByRole('textbox', { name: 'À ajouter' })
    await userEvent.clear(input)
    await userEvent.type(input, '4a')
    expect(input).toHaveValue('4')
    expect(within(sheet).getByTestId('scan-sheet-total')).toHaveTextContent('Total dans la zone : 2 → 6')

    await userEvent.type(input, '{Enter}')
    await waitFor(() => expect(latestItems[0]?.quantity).toBe(6))
    expect(screen.getByTestId('scan-undo-toast')).toHaveTextContent('total dans la zone : 6')

    // Annuler rétablit la quantité d’avant, sans retirer le produit.
    await userEvent.click(screen.getByTestId('scan-undo'))
    await waitFor(() => expect(latestItems[0]?.quantity).toBe(2))
  })

  it('ajuste la quantité avec les boutons plus et moins, sans descendre sous 1', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    startInventoryRunMock.mockResolvedValue({ runId: 'run-3' })
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitForScanner()
    await detect('3700412308516')
    const sheet = await screen.findByTestId('scan-count-sheet')
    const input = within(sheet).getByRole('textbox', { name: 'Quantité' })
    const plus = within(sheet).getByRole('button', { name: 'Augmenter la quantité' })
    const minus = within(sheet).getByRole('button', { name: 'Diminuer la quantité' })

    await userEvent.click(minus)
    expect(input).toHaveValue('1')
    await userEvent.click(plus)
    await userEvent.click(plus)
    expect(input).toHaveValue('3')
    await userEvent.click(minus)
    expect(input).toHaveValue('2')

    await userEvent.clear(input)
    expect(within(sheet).getByTestId('scan-sheet-confirm')).toBeDisabled()
    await userEvent.type(input, '2')

    await userEvent.click(within(sheet).getByTestId('scan-sheet-confirm'))
    await waitFor(() => expect(latestItems[0]?.quantity).toBe(2))
  })

  it('n’ajoute rien en annulant, puis ignore un moment le même code', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitForScanner()
    await detect('3700412308516')
    const sheet = await screen.findByTestId('scan-count-sheet')

    // Une autre lecture pendant que la fiche est ouverte est ignorée.
    await detect('9999999999999')
    expect(fetchProductByEanMock).toHaveBeenCalledTimes(1)

    await userEvent.click(within(sheet).getByTestId('scan-sheet-cancel'))
    await waitFor(() => expect(screen.queryByTestId('scan-count-sheet')).not.toBeInTheDocument())
    expect(latestItems).toHaveLength(0)

    // La caméra voit encore l’étiquette : pas de nouvelle fiche.
    await detect('3700412308516')
    expect(fetchProductByEanMock).toHaveBeenCalledTimes(1)

    // Passé le délai, le même code est de nouveau lu.
    const later = Date.now() + SAME_CODE_COOLDOWN_MS + 500
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(later)
    await detect('3700412308516')
    nowSpy.mockRestore()
    expect(fetchProductByEanMock).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('scan-count-sheet')).toBeInTheDocument()
  })

  it('ferme la fiche avec la touche Échap', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    renderScanCameraPage()

    await waitForScanner()
    await detect('3700412308516')
    await screen.findByTestId('scan-count-sheet')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('scan-count-sheet')).not.toBeInTheDocument())
  })

  it('affiche une fiche d’erreur pour un code introuvable, sans rien ajouter', async () => {
    fetchProductByEanMock.mockRejectedValue({ status: 404 })
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitForScanner()
    await detect('0123456789012')

    const sheet = await screen.findByTestId('scan-error-sheet')
    expect(within(sheet).getByText('Code introuvable')).toBeInTheDocument()
    expect(
      within(sheet).getByText('Ce code n’est pas dans la liste des produits à inventorier.'),
    ).toBeInTheDocument()
    expect(within(sheet).getByText('0123456789012')).toBeInTheDocument()
    expect(within(sheet).getByText('Rien n’a été compté. Vérifiez l’étiquette puis rescannez.')).toBeInTheDocument()
    expect(scannerState.frameTone).toBe('error')
    expect(latestItems).toHaveLength(0)

    await userEvent.click(within(sheet).getByRole('button', { name: 'Rescanner' }))
    await waitFor(() => expect(screen.queryByTestId('scan-error-sheet')).not.toBeInTheDocument())
    expect(scannerState.paused).toBe(false)
  })

  it('signale une recherche trop longue', async () => {
    fetchProductByEanMock.mockRejectedValue(new RequestTimeoutError('/api/products/slow', 5000))
    renderScanCameraPage()

    await waitForScanner()
    await detect('0123456789012')

    expect(
      await screen.findByText('Lecture du produit trop longue. Vérifiez la connexion et réessayez.'),
    ).toBeInTheDocument()
  })

  it('signale un échec de récupération du produit', async () => {
    fetchProductByEanMock.mockRejectedValue(new Error('réseau'))
    renderScanCameraPage()

    await waitForScanner()
    await detect('0123456789012')

    expect(await screen.findByText('Échec de la récupération du produit. Réessayez.')).toBeInTheDocument()
  })

  it('refuse un code trop long', async () => {
    renderScanCameraPage()

    await waitForScanner()
    await detect('1'.repeat(33))

    expect(await screen.findByText('Code invalide : 32 caractères maximum.')).toBeInTheDocument()
    expect(fetchProductByEanMock).not.toHaveBeenCalled()
  })

  it('montre la recherche en cours et permet de l’annuler', async () => {
    let capturedSignal: AbortSignal | undefined
    fetchProductByEanMock.mockImplementation(
      (_code: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          capturedSignal = options.signal
          options.signal.addEventListener('abort', () => reject(new AbortedRequestError('/api/products')))
        }),
    )
    renderScanCameraPage()

    await waitForScanner()
    act(() => {
      void scannerState.onDetected?.('0123456789012')
    })

    const sheet = await screen.findByTestId('scan-lookup-sheet')
    expect(within(sheet).getByText('Code lu')).toBeInTheDocument()
    expect(within(sheet).getByText('0123456789012')).toBeInTheDocument()
    expect(within(sheet).getByText('Recherche du produit…')).toBeInTheDocument()

    await userEvent.click(within(sheet).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByTestId('scan-lookup-sheet')).not.toBeInTheDocument())
    expect(capturedSignal?.aborted).toBe(true)
    expect(screen.queryByTestId('scan-error-sheet')).not.toBeInTheDocument()
  })

  it('garde la fiche ouverte et affiche l’erreur si le comptage ne peut pas démarrer', async () => {
    fetchProductByEanMock.mockResolvedValue(clapProduct)
    startInventoryRunMock.mockRejectedValue(new Error('Zone déjà comptée par un autre utilisateur.'))
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitForScanner()
    await detect('3700412308516')
    const sheet = await screen.findByTestId('scan-count-sheet')
    await userEvent.click(within(sheet).getByTestId('scan-sheet-confirm'))

    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Zone déjà comptée par un autre utilisateur.')
    expect(latestItems).toHaveLength(0)
    expect(screen.getByTestId('scan-count-sheet')).toBeInTheDocument()
  })

  it('liste les articles et permet de corriger ou retirer une ligne', async () => {
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({
      items: [
        { ean: '2000000000001', name: 'Gaffer fluo jaune', sku: 'A-GA25FJA', quantity: 2 },
        { ean: '2000000000002', name: 'Cône de signalisation' },
      ],
      onItemsChange: (items) => (latestItems = items),
    })

    await waitFor(() => expect(latestItems).toHaveLength(2))
    await userEvent.click(screen.getByTestId('scan-open-list'))
    const list = await screen.findByTestId('scan-items-sheet')
    expect(within(list).getByText('CinéBoutique Paris')).toBeInTheDocument()
    expect(within(list).getAllByTestId('scanned-row')).toHaveLength(2)
    expect(within(list).getByText('A-GA25FJA · EAN 2000000000001')).toBeInTheDocument()
    expect(scannerState.paused).toBe(true)

    await userEvent.click(within(list).getByRole('button', { name: 'Corriger Gaffer fluo jaune, quantité 2' }))
    let editSheet = await screen.findByTestId('scan-count-sheet')
    expect(within(editSheet).getByText('Corriger la quantité comptée')).toBeInTheDocument()
    expect(within(editSheet).getByRole('textbox', { name: 'Quantité' })).toHaveValue('2')
    await userEvent.click(within(editSheet).getByRole('button', { name: '5 pièces' }))
    await userEvent.click(within(editSheet).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() =>
      expect(latestItems.find((item) => item.product.ean === '2000000000001')?.quantity).toBe(5),
    )
    expect(await screen.findByTestId('scan-items-sheet')).toBeInTheDocument()

    // Annuler une correction revient à la liste sans rien changer.
    await userEvent.click(screen.getByRole('button', { name: 'Corriger Cône de signalisation, quantité 1' }))
    editSheet = await screen.findByTestId('scan-count-sheet')
    await userEvent.click(within(editSheet).getByTestId('scan-sheet-cancel'))
    expect(await screen.findByTestId('scan-items-sheet')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Corriger Cône de signalisation, quantité 1' }))
    editSheet = await screen.findByTestId('scan-count-sheet')
    await userEvent.click(within(editSheet).getByRole('button', { name: 'Retirer de la liste' }))
    await waitFor(() => expect(latestItems).toHaveLength(1))

    await userEvent.click(await screen.findByRole('button', { name: 'Reprendre le scan' }))
    await waitFor(() => expect(screen.queryByTestId('scan-items-sheet')).not.toBeInTheDocument())
    expect(scannerState.paused).toBe(false)
  })

  it('indique une liste vide', async () => {
    renderScanCameraPage()

    await userEvent.click(await screen.findByTestId('scan-open-list'))
    expect(
      await screen.findByText('Aucun article compté pour l’instant. Scannez un code-barres pour commencer.'),
    ).toBeInTheDocument()
  })

  it('décode une photo de secours avec le même détecteur et ouvre la fiche du produit', async () => {
    decodeBarcodeFromFileMock.mockResolvedValue('4006381333931')
    fetchProductByEanMock.mockResolvedValue({ ean: '4006381333931', name: 'Produit photo' })
    startInventoryRunMock.mockResolvedValue({ runId: 'run-photo' })
    let latestItems: InventoryItem[] = []
    renderScanCameraPage({ onItemsChange: (items) => (latestItems = items) })

    await waitFor(() => expect(typeof scannerState.onPickImage).toBe('function'))
    const file = new File(['x'], 'code.jpg', { type: 'image/jpeg' })
    await act(async () => {
      await scannerState.onPickImage?.(file)
    })

    expect(decodeBarcodeFromFileMock).toHaveBeenCalledWith(file)
    expect(fetchProductByEanMock).toHaveBeenCalledWith(
      '4006381333931',
      expect.objectContaining({ signal: expect.any(Object) }),
    )
    const sheet = await screen.findByTestId('scan-count-sheet')
    expect(within(sheet).getByRole('heading', { name: 'Produit photo' })).toBeInTheDocument()
    await userEvent.click(within(sheet).getByTestId('scan-sheet-confirm'))
    await waitFor(() => expect(latestItems.some((item) => item.product.ean === '4006381333931')).toBe(true))
  })

  it('explique quand la photo ne contient aucun code lisible', async () => {
    decodeBarcodeFromFileMock.mockResolvedValue(null)
    renderScanCameraPage()

    await waitFor(() => expect(typeof scannerState.onPickImage).toBe('function'))
    await act(async () => {
      await scannerState.onPickImage?.(new File(['x'], 'flou.jpg', { type: 'image/jpeg' }))
    })

    expect(
      await screen.findByText('Aucun code-barres lisible sur la photo. Rapprochez-vous et réessayez.'),
    ).toBeInTheDocument()
    expect(fetchProductByEanMock).not.toHaveBeenCalled()
  })

  it('signale une photo impossible à lire', async () => {
    decodeBarcodeFromFileMock.mockRejectedValue(new Error('format inconnu'))
    renderScanCameraPage()

    await waitFor(() => expect(typeof scannerState.onPickImage).toBe('function'))
    await act(async () => {
      await scannerState.onPickImage?.(new File(['x'], 'casse.heic', { type: 'image/heic' }))
    })

    expect(await screen.findByText('Lecture de la photo impossible. Réessayez.')).toBeInTheDocument()
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
    expect(scannerState.torchSet).toHaveBeenCalledWith(false)
  })

  it('masque le changement de caméra sans second objectif arrière', async () => {
    cameraState.active = true
    cameraState.canSwitchCamera = false

    renderScanCameraPage()

    await screen.findByTestId('scan-summary-bar')
    expect(screen.queryByTestId('scan-camera-switch')).not.toBeInTheDocument()
  })

  it('pilote la lampe quand l’appareil en dispose', async () => {
    cameraState.active = true
    scannerState.torchSupported = true

    renderScanCameraPage()

    const torch = await screen.findByTestId('scan-camera-torch-toggle')
    expect(torch).toHaveAccessibleName('Allumer la lampe')
    await userEvent.click(torch)
    expect(scannerState.torchToggle).toHaveBeenCalledTimes(1)
  })

  it('revient à la session et coupe la caméra avec le bouton Retour', async () => {
    renderScanCameraPage()

    await userEvent.click(await screen.findByTestId('scan-camera-back'))

    await waitFor(() => expect(screen.getByTestId('current-path')).toHaveTextContent('/inventory/session'))
    expect(cameraState.stop).toHaveBeenCalled()
  })
})
