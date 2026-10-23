import { test, expect } from '@playwright/test'

const testShop = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Cinéma test',
  kind: 'boutique',
}

const mockLocations = [
  {
    id: '11111111-1111-4111-8111-333333333333',
    code: 'Z1',
    label: 'Zone test',
    isBusy: false,
    busyBy: null,
    activeRunId: null,
    activeCountType: 1,
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
      {
        countType: 3,
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

const mockUsers = [
  {
    id: 'user-paris',
    shopId: testShop.id,
    login: 'paris',
    displayName: 'Utilisateur Paris',
    isAdmin: false,
    disabled: false,
  },
  {
    id: 'user-lyon',
    shopId: testShop.id,
    login: 'lyon',
    displayName: 'Utilisateur Lyon',
    isAdmin: false,
    disabled: false,
  },
]

const scannedProducts = [
  { ean: '5901234123457', name: 'Produit caméra A' },
  { ean: '9780201379624', name: 'Produit caméra B' },
  { ean: '3033710074365', name: 'Produit caméra C' },
  { ean: '3520111510017', name: 'Produit caméra D' },
]

const productsByEan = Object.fromEntries(scannedProducts.map((product) => [product.ean, product]))

declare global {
  interface Window {
    __pushCameraScan?: (ean: string) => void
  }
}

test.describe('Mode scan caméra - bottom sheet', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ shop }) => {
      window.localStorage.setItem('cb.shop', JSON.stringify(shop))
    }, { shop: testShop })

    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', {
        configurable: true,
        value: true,
      })

      const track = {
        kind: 'video',
        stop: () => {},
        applyConstraints: async () => {},
        getCapabilities: () => ({ torch: true }),
        getSettings: () => ({ deviceId: 'mock-device' }),
      }

      const stream = {
        id: 'mock-stream',
        active: true,
        getTracks: () => [track],
        getVideoTracks: () => [track],
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      const queue: string[] = []
      Object.defineProperty(window, '__pushCameraScan', {
        configurable: true,
        value: (ean: string) => {
          queue.push(ean)
        },
      })

      class FakeBarcodeDetector {
        constructor(options: { formats?: string[] } = {}) {
          void options
        }
        async detect() {
          const value = queue.shift()
          if (!value) {
            return []
          }
          return [{ rawValue: value, format: 'ean_13' }]
        }
      }

      Object.defineProperty(window, 'BarcodeDetector', {
        configurable: true,
        value: FakeBarcodeDetector,
      })

      const getUserMediaMock = async () => stream
      const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices & Record<string, unknown>)

      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        writable: true,
        value: getUserMediaMock,
      })

      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        writable: true,
        value: mediaDevices,
      })

      Object.defineProperty(HTMLVideoElement.prototype, 'play', {
        configurable: true,
        value: () => Promise.resolve(),
      })

      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        set(value) {
          ;(this as unknown as { __srcObject?: unknown }).__srcObject = value
        },
        get() {
          return (this as unknown as { __srcObject?: unknown }).__srcObject ?? null
        },
      })

      Object.defineProperty(HTMLVideoElement.prototype, 'readyState', {
        configurable: true,
        get() {
          return 4
        },
      })

      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
        configurable: true,
        get() {
          return 640
        },
      })

      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
        configurable: true,
        get() {
          return 480
        },
      })
    })

    await page.route('**/api/inventories/**/start', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.fallback()
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: '00000000-0000-4000-8000-000000000101',
          inventorySessionId: '00000000-0000-4000-8000-000000000102',
          locationId: mockLocations[0].id,
          countType: 1,
          ownerDisplayName: mockUsers[0].displayName,
          ownerUserId: mockUsers[0].id,
          startedAtUtc: new Date().toISOString(),
        }),
      })
    })

    await page.route('**/api/locations**', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockLocations),
        })
        return
      }
      await route.fallback()
    })

    await page.route('**/api/shops', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([testShop]),
        })
        return
      }
      await route.fallback()
    })

    await page.route('**/api/shops/**/users', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockUsers),
        })
        return
      }
      await route.fallback()
    })

    await page.route('**/api/products/**', async (route, request) => {
      if (request.method() !== 'GET') {
        await route.fallback()
        return
      }

      const url = new URL(request.url())
      const ean = url.pathname.split('/').pop() ?? ''
      const product = productsByEan[ean]

      if (!product) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(product),
      })
    })
  })

  test('affiche la bottom sheet et permet d\'ajuster les quantités', async ({ page }) => {
    await page.goto('/inventory/location')

    await expect(page).toHaveURL(/\/select-user/, { timeout: 5000 })

    const identifyHeading = page.getByRole('heading', { name: 'Choisir un utilisateur' })
    await expect(identifyHeading).toBeVisible({ timeout: 5000 })

    const userButton = page.getByRole('button', { name: mockUsers[0].displayName })
    await expect(userButton).toBeVisible({ timeout: 5000 })
    await userButton.click()

    await expect(page).toHaveURL(/\/inventory\/location/, { timeout: 5000 })
    const zoneCard = page.getByTestId(`zone-card-${mockLocations[0].id}`)
    await expect(zoneCard).toBeVisible({ timeout: 5000 })
    const zoneSelectButton = zoneCard.getByTestId('btn-select-zone')
    await expect(zoneSelectButton).toBeVisible({ timeout: 5000 })

    await Promise.all([
      page.waitForURL(/\/inventory\/count-type/, { timeout: 5000 }),
      zoneSelectButton.click(),
    ])

    await expect(page.getByTestId('page-count-type')).toBeVisible({ timeout: 5000 })

    const btnCount1 = page.getByTestId('btn-count-type-1')
    await expect(btnCount1).toBeVisible({ timeout: 5000 })
    const btnCount2 = page.getByTestId('btn-count-type-2')
    await expect(btnCount2).toBeVisible({ timeout: 5000 })

    if (await btnCount1.isDisabled()) {
      await Promise.all([
        page.waitForURL(/\/inventory\/session/, { timeout: 5000 }),
        btnCount2.click(),
      ])
    } else {
      await Promise.all([
        page.waitForURL(/\/inventory\/session/, { timeout: 5000 }),
        btnCount1.click(),
      ])
    }

    await expect(page).toHaveURL(/\/inventory\/session/, { timeout: 5000 })
    await expect(page.getByTestId('page-session')).toBeVisible({ timeout: 5000 })

    const scanCameraButton = page.getByTestId('btn-scan-camera')
    await expect(scanCameraButton).toBeVisible({ timeout: 5000 })
    await scanCameraButton.click()

    await expect(page).toHaveURL(/\/inventory\/scan-camera/, { timeout: 5000 })
    await expect(page.getByTestId('scan-camera-page')).toBeVisible({ timeout: 5000 })

    await page.waitForFunction(() => typeof window.__pushCameraScan === 'function')

    const sheet = page.getByTestId('scan-sheet')
    await expect(sheet).toBeVisible({ timeout: 5000 })
    await expect(sheet).toHaveAttribute('data-state', 'closed')
    await expect(sheet.getByText('Scannez un article pour débuter.')).toBeVisible({ timeout: 5000 })

    for (const product of scannedProducts) {
      await page.evaluate((ean) => {
        window.__pushCameraScan?.(ean)
      }, product.ean)

      await expect(sheet.getByText(product.name, { exact: true })).toBeVisible({ timeout: 5000 })
      await expect(sheet.getByText(`EAN ${product.ean}`, { exact: true })).toBeVisible({ timeout: 5000 })
    }

    await expect(sheet.locator('[data-testid="scanned-row"]')).toHaveCount(3)
    await expect(sheet.getByText(scannedProducts[0].name, { exact: true })).toHaveCount(0)
    await expect(sheet.locator('[data-testid="scanned-row"]').last()).toContainText(scannedProducts.at(-1)?.name ?? '')

    const handle = page.getByTestId('scan-sheet-handle')
    const handleBox = await handle.boundingBox()
    expect(handleBox).not.toBeNull()
    const handleCenterX = Math.round(handleBox!.x + handleBox!.width / 2)
    const handleCenterY = Math.round(handleBox!.y + handleBox!.height / 2)
    await page.mouse.move(handleCenterX, handleCenterY)
    await page.mouse.down()
    await page.mouse.move(handleCenterX, handleCenterY - 200, { steps: 10 })
    await page.mouse.up()
    await expect(sheet).toHaveAttribute('data-state', 'half')
    await expect(sheet.locator('[data-testid="scanned-row"]')).toHaveCount(scannedProducts.length)
    await expect(sheet.getByText(scannedProducts[0].name, { exact: true })).toBeVisible({ timeout: 5000 })

    const lastProductName = scannedProducts.at(-1)?.name ?? ''
    expect(lastProductName).not.toEqual('')

    const quantityInput = page.getByRole('textbox', {
      name: `Quantité pour ${lastProductName}`,
    })
    await quantityInput.scrollIntoViewIfNeeded()
    await quantityInput.click()
    await quantityInput.fill('5')
    await quantityInput.press('Enter')
    await expect(sheet).toHaveAttribute('data-state', 'full')
    await expect(quantityInput).toHaveValue('5')
    await quantityInput.blur()
  })
})

export {}
