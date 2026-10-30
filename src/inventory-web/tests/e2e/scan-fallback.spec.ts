import { test, expect } from '@playwright/test'

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

const testShop = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Cinéma test',
  kind: 'boutique',
}

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

test.describe('Scanner fallback', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, value)
    }, { key: 'cb.shop', value: JSON.stringify(testShop) })

    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', {
        configurable: true,
        value: false,
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
  })

  test('affiche le fallback photo lorsque la caméra est indisponible', async ({ page }) => {
    await page.addInitScript(() => {
      const navigatorWithMediaDevices = navigator as Navigator & {
        mediaDevices?: (MediaDevices & Record<string, unknown>) | undefined
      }
      const getUserMediaMock = () => Promise.reject(new Error('Caméra indisponible (test)'))
      const mediaDevices =
        navigatorWithMediaDevices.mediaDevices ??
        ({} as MediaDevices & Record<string, unknown>)

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
    })

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

    const cameraError = page.getByTestId('scan-camera-error')
    await expect(cameraError).toBeVisible({ timeout: 5000 })
    await expect(cameraError).toContainText('Site non sécurisé (HTTPS requis)')
    await expect(page.getByTestId('scan-photo-fallback')).toBeVisible({ timeout: 5000 })
    const fileInput = page.getByTestId('scan-photo-input')
    await expect(fileInput).toHaveCount(1)
    const inputType = await fileInput.getAttribute('type')
    expect(inputType).toBe('file')
  })
})
