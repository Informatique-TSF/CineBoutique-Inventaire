import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INVENTORY_DRAFT_VERSION,
  buildInventoryDraftKey,
  clearInventoryDraft,
  hasInventoryDraftContent,
  loadInventoryDraft,
  saveInventoryDraft,
  syncInventoryDraft,
  type InventoryDraftPayload,
} from '../inventoryDraftStorage'

import type { InventoryItem, Location } from '@/app/types/inventory'
import type { ShopUser } from '@/types/user'

const shopId = 'shop-123'

const user: ShopUser = {
  id: 'user-1',
  shopId,
  login: 'alice',
  displayName: 'Alice',
  isAdmin: false,
  disabled: false,
}

const location: Location = {
  id: '11111111-1111-1111-1111-111111111111',
  code: 'Z1',
  label: 'Zone 1',
  disabled: false,
  isBusy: true,
  busyBy: 'alice',
  activeRunId: 'run-1',
  activeCountType: 1,
  activeStartedAtUtc: new Date('2026-10-20T08:00:00.000Z'),
  countStatuses: [
    {
      countType: 1,
      status: 'in_progress',
      runId: 'run-1',
      ownerDisplayName: 'Alice',
      ownerUserId: 'user-1',
      startedAtUtc: new Date('2026-10-20T08:00:00.000Z'),
      completedAtUtc: null,
    },
  ],
}

const buildItem = (ean: string, quantity: number, isManual = false): InventoryItem => ({
  id: `item-${ean}`,
  product: { ean, name: `Produit ${ean}`, sku: `SKU-${ean}`, group: null, subGroup: 'Snacks' },
  quantity,
  lastScanAt: '2026-10-20T08:05:00.000Z',
  isManual,
  addedAt: 1_760_000_000_000,
})

const buildPayload = (overrides: Partial<InventoryDraftPayload> = {}): InventoryDraftPayload => ({
  selectedUser: user,
  countType: 1,
  location,
  sessionId: 'run-1',
  items: [buildItem('0001', 3), buildItem('0002', 1, true)],
  userSnapshots: {},
  ...overrides,
})

describe('inventoryDraftStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('sauvegarde puis recharge un brouillon complet (dates incluses)', () => {
    expect(saveInventoryDraft(shopId, buildPayload())).toBe(true)

    const raw = localStorage.getItem(buildInventoryDraftKey(shopId))
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ version: INVENTORY_DRAFT_VERSION, shopId })

    const loaded = loadInventoryDraft(shopId)
    expect(loaded).not.toBeNull()
    expect(loaded?.shopId).toBe(shopId)
    expect(loaded?.selectedUser).toEqual(user)
    expect(loaded?.countType).toBe(1)
    expect(loaded?.sessionId).toBe('run-1')
    expect(loaded?.items).toHaveLength(2)
    expect(loaded?.items[0]).toMatchObject({ product: { ean: '0001', subGroup: 'Snacks' }, quantity: 3, isManual: false })
    expect(loaded?.items[1]).toMatchObject({ product: { ean: '0002' }, quantity: 1, isManual: true })
    expect(loaded?.location?.id).toBe(location.id)
    expect(loaded?.location?.activeStartedAtUtc).toBeInstanceOf(Date)
    expect(loaded?.location?.activeStartedAtUtc?.toISOString()).toBe('2026-10-20T08:00:00.000Z')
    expect(loaded?.location?.countStatuses[0]?.startedAtUtc).toBeInstanceOf(Date)
    expect(loaded?.location?.countStatuses[0]?.completedAtUtc).toBeNull()
    expect(typeof loaded?.savedAt).toBe('string')
  })

  it('conserve les instantanés des autres utilisateurs', () => {
    saveInventoryDraft(
      shopId,
      buildPayload({
        userSnapshots: {
          'user-2': { countType: 2, location, sessionId: 'run-2', items: [buildItem('0003', 7)] },
        },
      }),
    )

    const loaded = loadInventoryDraft(shopId)
    expect(loaded?.userSnapshots['user-2']?.items[0]).toMatchObject({ product: { ean: '0003' }, quantity: 7 })
    expect(loaded?.userSnapshots['user-2']?.sessionId).toBe('run-2')
  })

  it('ignore et supprime un brouillon JSON corrompu', () => {
    const key = buildInventoryDraftKey(shopId)
    localStorage.setItem(key, '{"version":1,"shopId":"shop-123","items":[')

    expect(loadInventoryDraft(shopId)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('ignore et supprime un brouillon dont le schéma est invalide', () => {
    const key = buildInventoryDraftKey(shopId)
    localStorage.setItem(key, JSON.stringify({ version: INVENTORY_DRAFT_VERSION, shopId, items: 'oops' }))

    expect(loadInventoryDraft(shopId)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('ignore et supprime un brouillon d’une autre version', () => {
    const key = buildInventoryDraftKey(shopId)
    localStorage.setItem(
      key,
      JSON.stringify({
        version: INVENTORY_DRAFT_VERSION + 1,
        shopId,
        savedAt: '2026-10-20T08:00:00.000Z',
        selectedUser: null,
        countType: 1,
        location: null,
        sessionId: 'run-1',
        items: [],
        userSnapshots: {},
      }),
    )

    expect(loadInventoryDraft(shopId)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('ignore et supprime un brouillon rattaché à une autre boutique', () => {
    const key = buildInventoryDraftKey(shopId)
    saveInventoryDraft('autre-boutique', buildPayload())
    localStorage.setItem(key, localStorage.getItem(buildInventoryDraftKey('autre-boutique')) ?? '')

    expect(loadInventoryDraft(shopId)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('retourne null quand aucun brouillon n’existe', () => {
    expect(loadInventoryDraft(shopId)).toBeNull()
  })

  it('syncInventoryDraft enregistre quand il y a des lignes et supprime sinon', () => {
    const key = buildInventoryDraftKey(shopId)

    syncInventoryDraft(shopId, buildPayload())
    expect(localStorage.getItem(key)).not.toBeNull()

    syncInventoryDraft(shopId, buildPayload({ items: [], sessionId: null }))
    expect(localStorage.getItem(key)).toBeNull()

    // Un run serveur ouvert sans ligne mérite aussi d'être conservé.
    syncInventoryDraft(shopId, buildPayload({ items: [], sessionId: 'run-1' }))
    expect(localStorage.getItem(key)).not.toBeNull()

    // Un autre utilisateur avec des lignes en mémoire également.
    syncInventoryDraft(
      shopId,
      buildPayload({
        items: [],
        sessionId: null,
        userSnapshots: { 'user-2': { countType: 1, location, sessionId: null, items: [buildItem('0009', 1)] } },
      }),
    )
    expect(localStorage.getItem(key)).not.toBeNull()

    syncInventoryDraft(null, buildPayload())
    expect(localStorage.getItem(buildInventoryDraftKey('null'))).toBeNull()
  })

  it('hasInventoryDraftContent détecte les lignes, un run ouvert ou un instantané utilisateur', () => {
    expect(hasInventoryDraftContent(buildPayload({ items: [], sessionId: null }))).toBe(false)
    expect(hasInventoryDraftContent(buildPayload({ items: [], sessionId: '   ' }))).toBe(false)
    expect(hasInventoryDraftContent(buildPayload({ items: [], sessionId: 'run-1' }))).toBe(true)
    expect(hasInventoryDraftContent(buildPayload({ sessionId: null }))).toBe(true)
    expect(
      hasInventoryDraftContent(
        buildPayload({
          items: [],
          sessionId: null,
          userSnapshots: { 'user-2': { countType: null, location: null, sessionId: null, items: [buildItem('1', 1)] } },
        }),
      ),
    ).toBe(true)
  })

  it('clearInventoryDraft supprime la clé de la boutique uniquement', () => {
    saveInventoryDraft(shopId, buildPayload())
    saveInventoryDraft('shop-456', buildPayload())

    clearInventoryDraft(shopId)
    clearInventoryDraft(null)

    expect(localStorage.getItem(buildInventoryDraftKey(shopId))).toBeNull()
    expect(localStorage.getItem(buildInventoryDraftKey('shop-456'))).not.toBeNull()
  })

  it('ne lève pas d’exception quand le stockage refuse l’écriture (quota, mode privé)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    })

    expect(() => saveInventoryDraft(shopId, buildPayload())).not.toThrow()
    expect(saveInventoryDraft(shopId, buildPayload())).toBe(false)
    expect(() => syncInventoryDraft(shopId, buildPayload())).not.toThrow()

    setItemSpy.mockRestore()

    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError', 'SecurityError')
    })
    expect(() => loadInventoryDraft(shopId)).not.toThrow()
    expect(loadInventoryDraft(shopId)).toBeNull()
    getItemSpy.mockRestore()
  })
})
