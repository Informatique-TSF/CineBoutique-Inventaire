import { test, expect } from '@playwright/test'

const testShop = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Cinéma test',
  kind: 'boutique',
}

const mockLocations = [
  {
    id: '11111111-1111-4111-8111-111111111111',
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

const simulatedEan = '5901234123457'

test.describe('Scanner avec BarcodeDetector', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, value)
    }, { key: 'cb.shop', value: JSON.stringify(testShop) })

    await page.addInitScript(({ ean }) => {
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

      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => stream,
        },
      })

      Object.defineProperty(HTMLVideoElement.prototype, 'play', {
        configurable: true,
        value: () => Promise.resolve(),
      })
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        set(value) {
          this.__srcObject = value
        },
        get() {
          return this.__srcObject
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

      class FakeBarcodeDetector {
        static async getSupportedFormats() {
          return ['ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code']
        }
        detect = async () => [{ rawValue: ean, format: 'ean_13' as const }]
      }

      Object.defineProperty(window, 'BarcodeDetector', {
        configurable: true,
        value: FakeBarcodeDetector,
      })
    }, { ean: simulatedEan })

    await page.route('**/api/inventories/**/start', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.fallback()
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: '00000000-0000-4000-8000-000000000010',
          inventorySessionId: '00000000-0000-4000-8000-000000000011',
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

    await page.route('**/api/products/search**', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ean: simulatedEan, name: 'Produit simulé' }]),
        })
        return
      }
      await route.fallback()
    })

    await page.route(`**/api/products/${simulatedEan}**`, async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ean: simulatedEan, name: 'Produit simulé' }),
        })
        return
      }
      await route.fallback()
    })
  })

  test('déclenche onDetected via BarcodeDetector', async ({ page }) => {
    await page.goto('/inventory/location')

    await expect(page).toHaveURL(/\/select-user/, { timeout: 5000 })

    const identifyHeading = page.getByRole('heading', { name: 'Choisir un utilisateur' })
    await expect(identifyHeading).toBeVisible({ timeout: 5000 })

    const userButton = page.getByRole('button', { name: mockUsers[0].displayName })
    await expect(userButton).toBeVisible({ timeout: 5000 })
    await userButton.click()

    await expect(page).toHaveURL(/\/inventory\/location/, { timeout: 5000 })
    await expect(page.getByTestId('page-location')).toBeVisible({ timeout: 5000 })

    const zoneCard = page.getByTestId(`zone-card-${mockLocations[0].id}`)
    await expect(zoneCard).toBeVisible({ timeout: 5000 })
    const zoneSelectButton = zoneCard.getByTestId('btn-select-zone')
    await expect(zoneSelectButton).toBeVisible({ timeout: 5000 })
    await zoneSelectButton.click()

    await expect(page).toHaveURL(/\/inventory\/count-type/, { timeout: 5000 })
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

    await expect(page.getByText('Produit simulé ajouté')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(`EAN ${simulatedEan}`, { exact: true })).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('listitem').filter({ hasText: simulatedEan })).toBeVisible({ timeout: 5000 })
  })
})
