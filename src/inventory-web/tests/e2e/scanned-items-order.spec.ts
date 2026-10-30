import { test, expect } from '@playwright/test'

const testShop = {
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Cinéma test',
  kind: 'boutique',
}

const mockLocations = [
  {
    id: '11111111-1111-4111-8111-222222222222',
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

const productsByEan: Record<string, { ean: string; name: string }> = {
  '00000001': { ean: '00000001', name: 'Produit 00000001' },
  '00000002': { ean: '00000002', name: 'Produit 00000002' },
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

test.describe("Ordre d'affichage des articles scannés", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, value)
    }, { key: 'cb.shop', value: JSON.stringify(testShop) })

    await page.route('**/api/inventories/**/start', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.fallback()
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: '00000000-0000-4000-8000-000000000001',
          inventorySessionId: '00000000-0000-4000-8000-000000000002',
          locationId: mockLocations[0].id,
          countType: 1,
          ownerDisplayName: mockUsers[0].displayName,
          ownerUserId: mockUsers[0].id,
          startedAtUtc: new Date().toISOString(),
        }),
      })
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

    await page.route('**/api/products/**', async (route, request) => {
      if (request.method() !== 'GET') {
        await route.fallback()
        return
      }

      const url = new URL(request.url())
      if (url.pathname.endsWith('/products/search')) {
        const match = productsByEan[url.searchParams.get('code') ?? '']
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(match ? [match] : []),
        })
        return
      }
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

  test('maintient un ordre stable lors des ajustements de quantité', async ({ page }) => {
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
    await zoneCard.getByTestId('btn-select-zone').click()

    await expect(page).toHaveURL(/\/inventory\/count-type/, { timeout: 5000 })
    const countTypeButton = page.getByTestId('btn-count-type-1')
    if (await countTypeButton.isDisabled()) {
      await page.getByTestId('btn-count-type-2').click()
    } else {
      await countTypeButton.click()
    }

    await page.evaluate(() => {
      window.history.pushState({}, '', '/inventory/session')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await expect(page).toHaveURL(/\/inventory\/session/, { timeout: 5000 })

    const scannerInput = page.getByLabel('Scanner (douchette ou saisie)')

    await scannerInput.fill('00000001')
    await expect(page.locator('[data-testid="scanned-item"][data-ean="00000001"]').first()).toBeVisible({ timeout: 5000 })

    await scannerInput.fill('00000002')
    await expect(page.locator('[data-testid="scanned-item"][data-ean="00000002"]').first()).toBeVisible({ timeout: 5000 })

    const firstRowEan = await page.getByTestId('scanned-item').nth(0).getAttribute('data-ean')
    const secondRowEan = await page.getByTestId('scanned-item').nth(1).getAttribute('data-ean')
    expect(firstRowEan).toBe('00000002')
    expect(secondRowEan).toBe('00000001')

    const productFirstRow = page.locator('[data-testid="scanned-item"][data-ean="00000001"]')

    await productFirstRow.getByRole('button', { name: 'Ajouter' }).click()
    await expect(productFirstRow.getByTestId('quantity-input')).toHaveValue('2')

    const firstRowAfterIncrement = await page.getByTestId('scanned-item').nth(0).getAttribute('data-ean')
    const secondRowAfterIncrement = await page.getByTestId('scanned-item').nth(1).getAttribute('data-ean')
    expect(firstRowAfterIncrement).toBe('00000001')
    expect(secondRowAfterIncrement).toBe('00000002')

    await productFirstRow.getByRole('button', { name: 'Retirer' }).click()
    await expect(productFirstRow.getByTestId('quantity-input')).toHaveValue('1')

    const firstRowAfterDecrement = await page.getByTestId('scanned-item').nth(0).getAttribute('data-ean')
    const secondRowAfterDecrement = await page.getByTestId('scanned-item').nth(1).getAttribute('data-ean')
    expect(firstRowAfterDecrement).toBe('00000001')
    expect(secondRowAfterDecrement).toBe('00000002')
  })
})
