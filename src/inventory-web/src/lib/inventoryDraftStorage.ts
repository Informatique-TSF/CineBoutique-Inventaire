import { z } from 'zod'

import type { InventoryItem, Location, Product } from '@/app/types/inventory'
import { loadShop } from '@/lib/shopStorage'
import type { ShopUser } from '@/types/user'

/**
 * Persistance locale du comptage en cours.
 *
 * Le brouillon est stocké dans localStorage, une entrée par boutique :
 *   cb.inventory.draft.v<version>.<shopId>
 *
 * Toute évolution incompatible du format doit incrémenter INVENTORY_DRAFT_VERSION
 * (et nettoyer l'ancienne clé dans `loadInventoryDraft`).
 */
export const INVENTORY_DRAFT_STORAGE_PREFIX = 'cb.inventory.draft'
export const INVENTORY_DRAFT_VERSION = 1

export const buildInventoryDraftKey = (shopId: string) =>
  `${INVENTORY_DRAFT_STORAGE_PREFIX}.v${INVENTORY_DRAFT_VERSION}.${shopId}`

export type InventoryDraftSnapshot = {
  countType: number | null
  location: Location | null
  sessionId: string | null
  items: InventoryItem[]
}

export type InventoryDraftPayload = InventoryDraftSnapshot & {
  selectedUser: ShopUser | null
  userSnapshots: Record<string, InventoryDraftSnapshot>
}

export type InventoryDraft = InventoryDraftPayload & {
  version: typeof INVENTORY_DRAFT_VERSION
  shopId: string
  savedAt: string
}

const warn = (message: string, error?: unknown) => {
  if (import.meta.env.DEV) {
    console.warn(`[inventoryDraftStorage] ${message}`, error)
  }
}

const getLocalStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage
  } catch (error) {
    warn('localStorage inaccessible', error)
    return null
  }
}

/** Identifiant de la boutique active (lecture tolérante aux erreurs de stockage). */
export const readInventoryDraftShopId = (): string | null => {
  try {
    const shopId = loadShop()?.id?.trim()
    return shopId && shopId.length > 0 ? shopId : null
  } catch (error) {
    warn('impossible de lire la boutique active', error)
    return null
  }
}

/* ------------------------------- Validation ------------------------------- */

const DateOrNullSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return null
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  return null
}, z.date().nullable())

const NullableStringSchema = z
  .string()
  .nullish()
  .transform((value) => (typeof value === 'string' ? value : null))

const NullableNumberSchema = z
  .number()
  .nullish()
  .transform((value) => (typeof value === 'number' ? value : null))

// Volontairement plus tolérant que LocationSchema (pas de contrainte UUID) :
// un brouillon ne doit jamais être perdu à cause d'un format d'identifiant.
const DraftLocationSchema = z.object({
  id: z.string().min(1),
  code: z.string(),
  label: z.string(),
  disabled: z.boolean().optional().default(false),
  isBusy: z.boolean().optional().default(false),
  busyBy: NullableStringSchema,
  activeRunId: NullableStringSchema,
  activeCountType: NullableNumberSchema,
  activeStartedAtUtc: DateOrNullSchema,
  countStatuses: z
    .array(
      z.object({
        countType: z.number(),
        status: z.enum(['not_started', 'in_progress', 'completed']),
        runId: NullableStringSchema,
        ownerDisplayName: NullableStringSchema,
        ownerUserId: NullableStringSchema,
        startedAtUtc: DateOrNullSchema,
        completedAtUtc: DateOrNullSchema,
      }),
    )
    .optional()
    .default([]),
})

const DraftProductSchema = z.object({
  ean: z.string(),
  name: z.string(),
  sku: z.string().optional(),
  group: z.string().nullable().optional(),
  subGroup: z.string().nullable().optional(),
  stock: z.number().optional(),
  lastCountedAt: z.string().nullable().optional(),
})

const DraftItemSchema = z.object({
  id: z.string().min(1),
  product: DraftProductSchema,
  quantity: z.number(),
  lastScanAt: z.string(),
  isManual: z.boolean(),
  addedAt: z.number(),
  hasConflict: z.boolean().optional(),
})

const DraftShopUserSchema = z.object({
  id: z.string().min(1),
  shopId: z.string(),
  login: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
})

const DraftSnapshotSchema = z.object({
  countType: NullableNumberSchema,
  location: DraftLocationSchema.nullable(),
  sessionId: NullableStringSchema,
  items: z.array(DraftItemSchema),
})

const InventoryDraftSchema = DraftSnapshotSchema.extend({
  version: z.literal(INVENTORY_DRAFT_VERSION),
  shopId: z.string().min(1),
  savedAt: z.string(),
  selectedUser: DraftShopUserSchema.nullable(),
  userSnapshots: z.record(z.string(), DraftSnapshotSchema).optional().default({}),
})

type ParsedDraftLocation = z.infer<typeof DraftLocationSchema>
type ParsedDraftSnapshot = z.infer<typeof DraftSnapshotSchema>

const toLocation = (parsed: ParsedDraftLocation): Location => ({
  id: parsed.id,
  code: parsed.code,
  label: parsed.label,
  disabled: parsed.disabled,
  isBusy: parsed.isBusy,
  busyBy: parsed.busyBy,
  activeRunId: parsed.activeRunId,
  activeCountType: parsed.activeCountType,
  activeStartedAtUtc: parsed.activeStartedAtUtc,
  countStatuses: parsed.countStatuses.map((status) => ({
    countType: status.countType,
    status: status.status,
    runId: status.runId,
    ownerDisplayName: status.ownerDisplayName,
    ownerUserId: status.ownerUserId,
    startedAtUtc: status.startedAtUtc,
    completedAtUtc: status.completedAtUtc,
  })),
})

const toProduct = (parsed: z.infer<typeof DraftProductSchema>): Product => ({
  ean: parsed.ean,
  name: parsed.name,
  sku: parsed.sku,
  group: parsed.group,
  subGroup: parsed.subGroup,
  stock: parsed.stock,
  lastCountedAt: parsed.lastCountedAt,
})

const toSnapshot = (parsed: ParsedDraftSnapshot): InventoryDraftSnapshot => ({
  countType: parsed.countType,
  location: parsed.location ? toLocation(parsed.location) : null,
  sessionId: parsed.sessionId && parsed.sessionId.trim().length > 0 ? parsed.sessionId : null,
  items: parsed.items.map((item) => ({
    id: item.id,
    product: toProduct(item.product),
    quantity: item.quantity,
    lastScanAt: item.lastScanAt,
    isManual: item.isManual,
    addedAt: item.addedAt,
    hasConflict: item.hasConflict,
  })),
})

/* -------------------------------- Contenu --------------------------------- */

/** Un instantané mérite d'être conservé s'il contient des lignes ou un run serveur ouvert. */
export const hasInventoryDraftSnapshotContent = (snapshot: InventoryDraftSnapshot): boolean =>
  snapshot.items.length > 0 || (typeof snapshot.sessionId === 'string' && snapshot.sessionId.trim().length > 0)

export const hasInventoryDraftContent = (payload: InventoryDraftPayload): boolean =>
  hasInventoryDraftSnapshotContent(payload) ||
  Object.values(payload.userSnapshots).some((snapshot) => hasInventoryDraftSnapshotContent(snapshot))

/* --------------------------------- Accès ---------------------------------- */

export const saveInventoryDraft = (shopId: string, payload: InventoryDraftPayload): boolean => {
  const storage = getLocalStorage()
  if (!storage) {
    return false
  }

  const draft: InventoryDraft = {
    version: INVENTORY_DRAFT_VERSION,
    shopId,
    savedAt: new Date().toISOString(),
    selectedUser: payload.selectedUser,
    countType: payload.countType,
    location: payload.location,
    sessionId: payload.sessionId,
    items: payload.items,
    userSnapshots: payload.userSnapshots,
  }

  try {
    storage.setItem(buildInventoryDraftKey(shopId), JSON.stringify(draft))
    return true
  } catch (error) {
    // Quota dépassé, mode privé, stockage désactivé : on ne bloque jamais le comptage.
    warn('impossible de sauvegarder le brouillon', error)
    return false
  }
}

export const clearInventoryDraft = (shopId: string | null | undefined) => {
  if (!shopId) {
    return
  }

  const storage = getLocalStorage()
  if (!storage) {
    return
  }

  try {
    storage.removeItem(buildInventoryDraftKey(shopId))
  } catch (error) {
    warn('impossible de supprimer le brouillon', error)
  }
}

/**
 * Charge le brouillon de la boutique. Un brouillon corrompu, d'une autre version
 * ou d'une autre boutique est supprimé et ignoré.
 */
export const loadInventoryDraft = (shopId: string): InventoryDraft | null => {
  const storage = getLocalStorage()
  if (!storage) {
    return null
  }

  const key = buildInventoryDraftKey(shopId)
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch (error) {
    warn('impossible de lire le brouillon', error)
    return null
  }

  if (!raw) {
    return null
  }

  try {
    const parsed = InventoryDraftSchema.safeParse(JSON.parse(raw))
    if (parsed.success && parsed.data.shopId === shopId) {
      const data = parsed.data
      const userSnapshots: Record<string, InventoryDraftSnapshot> = {}
      for (const [userId, snapshot] of Object.entries(data.userSnapshots)) {
        userSnapshots[userId] = toSnapshot(snapshot)
      }

      return {
        version: data.version,
        shopId: data.shopId,
        savedAt: data.savedAt,
        selectedUser: data.selectedUser,
        ...toSnapshot(data),
        userSnapshots,
      }
    }
    warn('brouillon invalide ignoré', parsed.success ? 'boutique différente' : parsed.error)
  } catch (error) {
    warn('brouillon illisible ignoré', error)
  }

  clearInventoryDraft(shopId)
  return null
}

/**
 * Synchronise le stockage avec l'état courant : on enregistre s'il y a quelque chose
 * à reprendre, sinon on supprime le brouillon (comptage terminé, libéré ou réinitialisé).
 */
export const syncInventoryDraft = (shopId: string | null, payload: InventoryDraftPayload) => {
  if (!shopId) {
    return
  }

  if (hasInventoryDraftContent(payload)) {
    saveInventoryDraft(shopId, payload)
    return
  }

  clearInventoryDraft(shopId)
}
