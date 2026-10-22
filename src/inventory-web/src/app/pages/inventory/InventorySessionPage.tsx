import type { ChangeEvent, FocusEvent, PointerEvent, KeyboardEvent } from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  completeInventoryRun,
  fetchLocations,
  fetchProductByEan,
  getConflictZoneDetail,
  releaseInventoryRun,
  startInventoryRun,
  type CompleteInventoryRunItem,
  type CompleteInventoryRunPayload,
} from '../../api/inventoryApi'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { LoadingIndicator } from '../../components/LoadingIndicator'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { useInventory } from '../../contexts/InventoryContext'
import type {
  ConflictRunHeader,
  ConflictZoneDetail,
  ConflictZoneItem,
  InventoryItem,
  Location,
  Product,
} from '../../types/inventory'
import { CountType } from '../../types/inventory'

import { ProductsModal, type ProductsModalItem } from '@/components/products/ProductsModal'
import { useScanDuplicateFeedback } from '@/hooks/useScanDuplicateFeedback'
import { useScanRejectionFeedback } from '@/hooks/useScanRejectionFeedback'
import type { HttpError } from '@/lib/api/http'
import { useShop } from '@/state/ShopContext'



const DEV_API_UNREACHABLE_HINT =
  "Impossible de joindre l’API : vérifie que le backend tourne (curl http://localhost:8080/healthz) ou que le proxy Vite est actif."

const isHttpError = (value: unknown): value is HttpError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { status?: unknown }).status === 'number' &&
  typeof (value as { url?: unknown }).url === 'string'

const buildHttpMessage = (prefix: string, error: HttpError) => {
  const problem = error.problem as { detail?: string; title?: string; message?: string } | undefined
  const detail = problem?.detail ?? problem?.title ?? problem?.message ?? error.body
  const trimmedDetail = detail?.trim()

  if (import.meta.env.DEV && error.status === 404) {
    const looksLikeProxyNotFound = !trimmedDetail || /^not found$/i.test(trimmedDetail)
    if (looksLikeProxyNotFound) {
      const diagnostics = [DEV_API_UNREACHABLE_HINT]
      if (error.url) {
        diagnostics.push(`URL: ${error.url}`)
      }
      if (trimmedDetail) {
        diagnostics.push(`Détail: ${trimmedDetail}`)
      }
      return diagnostics.join(' | ')
    }
  }

  const diagnostics: string[] = []
  if (typeof error.status === 'number') {
    diagnostics.push(`HTTP ${error.status}`)
  }
  if (error.url) {
    diagnostics.push(`URL: ${error.url}`)
  }
  if (trimmedDetail) {
    diagnostics.push(`Détail: ${trimmedDetail}`)
  }
  return diagnostics.length > 0 ? `${prefix} | ${diagnostics.join(' | ')}` : prefix
}

const MAX_SCAN_LENGTH = 32

const sanitizeScanValue = (value: string) => value.normalize('NFKC').replace(/\r|\n/g, '')

const normalizeIdentifier = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

const formatIdentifierForDisplay = (value: string | null | undefined): string =>
  normalizeIdentifier(value) ?? '—'

const IDENTIFIER_MIN_LENGTH = 3

const sanitizeEanForSubmission = (value: string | null | undefined): string | null => {
  const normalized = normalizeIdentifier(value)?.normalize('NFKC')
  if (!normalized) {
    return null
  }

  const collapsed = normalized.replace(/[\s.-]+/g, '')
  return collapsed.length > 0 ? collapsed.toUpperCase() : null
}

const isValidEanForSubmission = (ean: string | null | undefined): ean is string => {
  if (!ean) {
    return false
  }

  if (ean.length < IDENTIFIER_MIN_LENGTH || ean.length > MAX_SCAN_LENGTH) {
    return false
  }

  return /^[\p{L}\p{N}'#°._-]+$/u.test(ean)
}

const dedupeConflictItems = (items: ConflictZoneItem[]): ConflictZoneItem[] => {
  const seen = new Set<string>()
  const result: ConflictZoneItem[] = []

  items.forEach((item, index) => {
    const ean = normalizeIdentifier(item.ean)
    const productId = normalizeIdentifier(item.productId)
    const sku = normalizeIdentifier(item.sku)

    const key = ean ?? productId ?? sku ?? `index:${index}`
    if (seen.has(key)) {
      return
    }

    seen.add(key)
    result.push(item)
  })

  return result
}

const buildConflictLookupKey = (value: string | null | undefined): string | null => {
  const normalized = normalizeIdentifier(value)
  return normalized ? normalized.toUpperCase() : null
}

type InlineConflictRunSummary = {
  key: string
  countType: number
  quantity: number
}

type InlineConflictSummary = { runs: InlineConflictRunSummary[] }

type StatusTone = 'info' | 'warning'

/**
 * État de la vérification du run serveur après restauration d'un brouillon local :
 * - idle / checking : pas encore vérifié / vérification en cours
 * - active : le run serveur est toujours ouvert, on continue dessus
 * - no-run : lignes restaurées sans run serveur (rien à vérifier)
 * - missing : le run serveur n'existe plus, les lignes sont conservées localement
 * - restarted : un nouveau run a été ouvert à la demande de l'utilisateur
 * - unavailable : impossible de joindre le serveur pour vérifier
 */
type ResumeCheckState = 'idle' | 'checking' | 'active' | 'no-run' | 'missing' | 'restarted' | 'unavailable'

const RUN_RESTORED_TIME_FORMATTER = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
})

const formatRestoredAt = (value: string): string | null => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return RUN_RESTORED_TIME_FORMATTER.format(date)
}

const formatRestoredLines = (count: number): string => `${count} ligne${count > 1 ? 's' : ''}`

const isRunStillOpen = (locations: Location[], locationId: string, runId: string): boolean => {
  const match = locations.find((candidate) => candidate.id === locationId)
  if (!match) {
    return false
  }

  if (match.activeRunId === runId) {
    return true
  }

  return match.countStatuses.some((status) => status.runId === runId && status.status === 'in_progress')
}

// eslint-disable-next-line react-refresh/only-export-components
export const aggregateItemsForCompletion = (
  items: InventoryItem[],
  options?: { includeZeroQuantities?: boolean },
): CompleteInventoryRunItem[] => {
  const includeZeroQuantities = options?.includeZeroQuantities ?? false
  const aggregated = new Map<string, CompleteInventoryRunItem>()

  for (const item of items) {
    const normalizedEan = sanitizeEanForSubmission(item.product.ean)
    const quantity = Number.isFinite(item.quantity) ? item.quantity : 0

    if (!normalizedEan || !isValidEanForSubmission(normalizedEan) || quantity < 0) {
      continue
    }

    if (!includeZeroQuantities && quantity === 0) {
      continue
    }

    const existing = aggregated.get(normalizedEan)
    if (existing) {
      existing.quantity += quantity
      existing.isManual = existing.isManual || Boolean(item.isManual)
      continue
    }

    aggregated.set(normalizedEan, {
      ean: normalizedEan,
      quantity,
      isManual: Boolean(item.isManual),
    })
  }

  return Array.from(aggregated.values())
}

const collectInvalidEanLabels = (items: InventoryItem[]): string[] => {
  const labels: string[] = []

  for (const item of items) {
    const quantity = Number.isFinite(item.quantity) ? item.quantity : 0
    if (quantity <= 0) {
      continue
    }

    const sanitized = sanitizeEanForSubmission(item.product.ean)
    if (isValidEanForSubmission(sanitized)) {
      continue
    }

    const normalizedDisplay = normalizeIdentifier(item.product.ean)
    if (normalizedDisplay) {
      labels.push(normalizedDisplay)
      continue
    }

    labels.push(`${item.product.name} (EAN manquant)`)
  }

  return labels
}

const formatInvalidEanSummary = (labels: string[]): string => {
  if (labels.length === 0) {
    return ''
  }

  const preview = labels.slice(0, 3).map((label) => `«${label}»`).join(', ')
  const remaining = labels.length - 3

  if (remaining <= 0) {
    return preview
  }

  const plural = remaining > 1 ? 's' : ''
  return `${preview}… (+${remaining} autre${plural})`
}

const resolveLifecycleErrorMessage = (error: unknown, fallback: string): string => {
  if (isHttpError(error)) {
    const problem = error.problem as { message?: unknown; detail?: unknown; title?: unknown } | undefined
    const candidates = [problem?.message, problem?.detail, problem?.title]
    const message = candidates.find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    if (message) {
      return message.trim()
    }
    return buildHttpMessage(fallback, error)
  }

  if (error instanceof Error) {
    const trimmed = error.message.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }

  return fallback
}

export const InventorySessionPage = () => {
  const navigate = useNavigate()
  const {
    selectedUser,
    countType,
    location,
    items,
    addOrIncrementItem,
    initializeItems,
    setQuantity,
    removeItem,
    sessionId,
    setSessionId,
    clearSession,
    logs,
    logEvent,
    restoredDraft,
    dismissRestoredDraft,
  } = useInventory()
  const { shop, isLoaded: isShopLoaded } = useShop()
  const triggerScanRejectionFeedback = useScanRejectionFeedback()
  const triggerDuplicateFeedback = useScanDuplicateFeedback()
  const [status, setStatusState] = useState<{ text: string; tone: StatusTone } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [scanValue, setScanValue] = useState('')
  const [, setInputLookupStatus] = useState<'idle' | 'loading' | 'found' | 'not-found' | 'error'>('idle')
  const [completionLoading, setCompletionLoading] = useState(false)
  const completionDialogRef = useRef<HTMLDialogElement | null>(null)
  const completionConfirmationDialogRef = useRef<HTMLDialogElement | null>(null)
  const completionOkButtonRef = useRef<HTMLButtonElement | null>(null)
  const completionConfirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const logsDialogRef = useRef<HTMLDialogElement | null>(null)
  const removalConfirmationDialogRef = useRef<HTMLDialogElement | null>(null)
  const manualLookupIdRef = useRef(0)
  const lastSearchedInputRef = useRef<string | null>(null)
  const previousItemCountRef = useRef(items.length)
  const pendingFocusEanRef = useRef<string | null>(null)
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [conflictPrefillStatus, setConflictPrefillStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [conflictPrefillError, setConflictPrefillError] = useState<string | null>(null)
  const [conflictPrefillAttempt, setConflictPrefillAttempt] = useState(0)
  const conflictPrefillKeyRef = useRef<string | null>(null)
  const [conflictDetail, setConflictDetail] = useState<ConflictZoneDetail | null>(null)
  const [isConflictPanelOpen, setConflictPanelOpen] = useState(false)
  const [catalogueOpen, setCatalogueOpen] = useState(false)
  const [pendingRemovalItem, setPendingRemovalItem] = useState<InventoryItem | null>(null)
  const [resumeCheck, setResumeCheck] = useState<ResumeCheckState>('idle')
  const [restartingRun, setRestartingRun] = useState(false)
  const resumeCheckStartedRef = useRef(false)

  const isConflictResolutionMode = typeof countType === 'number' && countType >= CountType.Count3
  const canDisplayScanInputs =
    !isConflictResolutionMode || (typeof countType === 'number' && countType > CountType.Count3)

  const updateStatus = useCallback(
    (message: string | null, options?: { tone?: StatusTone }) => {
      if (!message) {
        setStatusState(null)
        return
      }
      const tone = options?.tone ?? 'info'
      setStatusState({ text: message, tone })
      const normalized = message.trim().toLowerCase()
      const isLookupMessage = normalized.startsWith('recherche du code')
      const containsProductAddition =
        normalized.includes('ajouté') || normalized.includes('ajoutée')
      if (!isLookupMessage && !containsProductAddition) {
        logEvent({
          type: 'status',
          message,
        })
      }
    },
    [logEvent],
  )

  const handleOpenLogsDialog = useCallback(() => {
    const dialog = logsDialogRef.current
    if (!dialog) {
      return
    }

    if (typeof dialog.showModal === 'function') {
      dialog.showModal()
      return
    }

    dialog.setAttribute('open', '')
  }, [])

  const handleCloseLogsDialog = useCallback(() => {
    const dialog = logsDialogRef.current
    if (!dialog) {
      return
    }

    if (typeof dialog.close === 'function') {
      dialog.close()
      return
    }

    dialog.removeAttribute('open')
  }, [])

  const formatLogTimestamp = useCallback((value: string) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(date)
  }, [])

  const selectedUserDisplayName = selectedUser?.displayName ?? null
  const countTypeLabel = typeof countType === 'number' ? `Comptage n°${countType}` : 'Comptage n°–'
  const ownerUserId = selectedUser?.id?.trim() ?? ''
  const existingRunId = typeof sessionId === 'string' ? sessionId.trim() : ''
  const locationId = location?.id?.trim() ?? ''
  const shopId = shop?.id?.trim() ?? ''
  const inlineConflictSummariesByKey = useMemo<Map<string, InlineConflictSummary> | null>(() => {
    if (!conflictDetail) {
      return null
    }

    const runs: ConflictRunHeader[] = Array.isArray(conflictDetail.runs) ? conflictDetail.runs : []
    const summariesByKey = new Map<string, InlineConflictSummary>()

    for (const conflictItem of conflictDetail.items ?? []) {
      const counts = Array.isArray(conflictItem.allCounts) ? conflictItem.allCounts : []
      const countsByRunId = new Map<string, number>()
      for (const count of counts) {
        if (!count?.runId) {
          continue
        }
        countsByRunId.set(count.runId, count.quantity)
      }

      const hasDynamicRuns = runs.length > 0 && countsByRunId.size > 0
      const inlineRuns: InlineConflictRunSummary[] = hasDynamicRuns
        ? runs.map((run) => ({
            key: run.runId,
            countType: run.countType,
            quantity: countsByRunId.get(run.runId) ?? 0,
          }))
        : [
            {
              key: 'count-1',
              countType: 1,
              quantity: conflictItem.qtyC1,
            },
            {
              key: 'count-2',
              countType: 2,
              quantity: conflictItem.qtyC2,
            },
          ]

      const summary: InlineConflictSummary = { runs: inlineRuns }

      const keys = [
        buildConflictLookupKey(conflictItem.productId),
        buildConflictLookupKey(conflictItem.ean),
        buildConflictLookupKey(conflictItem.sku),
      ]

      for (const key of keys) {
        if (!key || summariesByKey.has(key)) {
          continue
        }
        summariesByKey.set(key, summary)
      }
    }

    return summariesByKey
  }, [conflictDetail])

  useEffect(() => {
    if (!isConflictResolutionMode || !location) {
      setConflictDetail(null)
    }
  }, [isConflictResolutionMode, location])

  useEffect(() => {
    if (!isConflictResolutionMode) {
      setConflictPrefillStatus('idle')
      setConflictPrefillError(null)
      conflictPrefillKeyRef.current = null
      setConflictDetail(null)
      setConflictPanelOpen(false)
    }
  }, [isConflictResolutionMode])

  useEffect(() => {
    if (!isConflictResolutionMode) {
      return
    }

    if (!locationId) {
      setConflictPrefillStatus('idle')
      setConflictPrefillError('Impossible de charger les références en conflit.')
      setConflictDetail(null)
      return
    }

    const key = `${locationId}:${countType ?? ''}`

    if (items.length > 0 && conflictPrefillKeyRef.current === key) {
      setConflictPrefillStatus('loaded')
      setConflictPrefillError(null)
      return
    }

    if (items.length > 0 && conflictPrefillKeyRef.current !== key) {
      conflictPrefillKeyRef.current = key
      setConflictPrefillStatus('loaded')
      setConflictPrefillError(null)
      return
    }

    let cancelled = false
    const abortController = new AbortController()

    const buildFallbackProduct = (ean: string, sku?: string | null): Product => {
      const normalizedEan = (ean ?? '').trim()
      const normalizedSku = typeof sku === 'string' ? sku.trim() : ''
      const label = normalizedSku
        ? `SKU ${normalizedSku}`
        : normalizedEan
          ? `EAN ${normalizedEan}`
          : 'Produit en conflit'
      return {
        ean: normalizedEan || ean,
        name: label,
        sku: normalizedSku || undefined,
      }
    }

    const loadConflicts = async () => {
      try {
        const detail = await getConflictZoneDetail(locationId, abortController.signal)
        if (cancelled) {
          return
        }

        const runs = Array.isArray(detail.runs) ? detail.runs : []
        const rawConflictItems = Array.isArray(detail.items) ? detail.items : []
        const conflictItems = dedupeConflictItems(rawConflictItems)

        if (conflictItems.length === 0) {
          initializeItems([])
          setConflictDetail({
            locationId: detail.locationId,
            locationCode: detail.locationCode,
            locationLabel: detail.locationLabel,
            runs,
            items: [],
          })
          setConflictPrefillStatus('loaded')
          setConflictPrefillError(null)
          conflictPrefillKeyRef.current = key
          return
        }

        const productCache = new Map<string, Promise<Product>>()
        const resolveProduct = (ean: string, sku?: string | null) => {
          const normalizedEan = (ean ?? '').trim()
          if (!normalizedEan) {
            return Promise.resolve(buildFallbackProduct(ean, sku))
          }
          const cached = productCache.get(normalizedEan)
          if (cached) {
            return cached
          }
          const request = (async () => {
            try {
              return await fetchProductByEan(normalizedEan)
            } catch (error) {
              console.warn('[inventory] produit conflit introuvable, fallback', normalizedEan, error)
              return buildFallbackProduct(normalizedEan, sku)
            }
          })()
          productCache.set(normalizedEan, request)
          return request
        }

        const products = await Promise.all(
          conflictItems.map((item) => resolveProduct(item.ean ?? '', item.sku ?? undefined)),
        )

        if (cancelled) {
          return
        }

        const enrichedItems: ConflictZoneItem[] = []
        const initializationEntries = conflictItems.map((item, index) => {
          const resolved = products[index]
          const normalizedEan = (item.ean ?? '').trim()
          const resolvedName = resolved.name?.trim()
          const resolvedEan = resolved.ean?.trim()
          const resolvedSku = resolved.sku?.trim()
          const fallbackSku = item.sku?.trim() ?? ''
          const detailSku =
            resolvedSku && resolvedSku.length > 0
              ? resolved.sku
              : fallbackSku.length > 0
                ? item.sku
                : undefined
          const detailEan =
            resolvedEan && resolvedEan.length > 0
              ? resolvedEan
              : normalizedEan || resolved.ean || item.ean

          enrichedItems.push({
            ...item,
            name: resolvedName && resolvedName.length > 0 ? resolved.name : item.name,
            sku: detailSku,
            ean: detailEan,
          })

          return {
            product: {
              ...resolved,
              ean: resolvedEan && resolvedEan.length > 0 ? resolvedEan : normalizedEan || resolved.ean,
              sku: detailSku,
            },
            quantity: 0,
            hasConflict: true,
          }
        })

        initializeItems(initializationEntries)

        setConflictDetail({
          locationId: detail.locationId,
          locationCode: detail.locationCode,
          locationLabel: detail.locationLabel,
          runs,
          items: enrichedItems,
        })
        setConflictPrefillStatus('loaded')
        setConflictPrefillError(null)
        conflictPrefillKeyRef.current = key
      } catch (error) {
        if (cancelled) {
          return
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        console.error('[inventory] échec chargement références conflit', error)
        setConflictDetail(null)
        setConflictPrefillError('Impossible de charger les références en conflit.')
        setConflictPrefillStatus('error')
        conflictPrefillKeyRef.current = null
      }
    }

    setConflictDetail(null)
    setConflictPrefillStatus('loading')
    setConflictPrefillError(null)
    conflictPrefillKeyRef.current = key
    void loadConflicts()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [
    countType,
    initializeItems,
    isConflictResolutionMode,
    items.length,
    locationId,
    conflictPrefillAttempt,
  ])

  useEffect(() => {
    if (!selectedUser) {
      navigate('/select-shop', { replace: true })
    } else if (!locationId) {
      navigate('/inventory/location', { replace: true })
    } else if (!countType) {
      navigate('/inventory/count-type', { replace: true })
    }
  }, [countType, locationId, navigate, selectedUser])

  // Après restauration d'un brouillon local : vérifie une seule fois que le run serveur est toujours ouvert.
  useEffect(() => {
    if (!restoredDraft || !isShopLoaded || resumeCheckStartedRef.current) {
      return
    }

    resumeCheckStartedRef.current = true

    if (!existingRunId) {
      setResumeCheck('no-run')
      return
    }

    if (!shopId || !locationId) {
      setResumeCheck('unavailable')
      return
    }

    let cancelled = false
    setResumeCheck('checking')

    void (async () => {
      try {
        const locations = await fetchLocations(shopId, { includeDisabled: true })
        if (cancelled) {
          return
        }

        if (isRunStillOpen(locations, locationId, existingRunId)) {
          setResumeCheck('active')
          return
        }

        // Le run n'existe plus côté serveur : on garde les lignes, on oublie seulement l'identifiant du run.
        setSessionId(null)
        setResumeCheck('missing')
      } catch (error) {
        if (cancelled) {
          return
        }
        console.warn('[inventory] vérification du comptage restauré impossible', error)
        setResumeCheck('unavailable')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [existingRunId, isShopLoaded, locationId, restoredDraft, setSessionId, shopId])

  const handleRetryConflictPrefill = useCallback(() => {
    setConflictDetail(null)
    setConflictPrefillAttempt((attempt) => attempt + 1)
  }, [setConflictDetail])

  const handleToggleConflictPanel = useCallback(() => {
    if (!isConflictPanelOpen && conflictPrefillStatus === 'idle') {
      setConflictPrefillAttempt((attempt) => attempt + 1)
    }
    setConflictPanelOpen((open) => !open)
  }, [conflictPrefillStatus, isConflictPanelOpen])

  const displayedItems = items

  useLayoutEffect(() => {
    const scanInputs = document.querySelectorAll<HTMLInputElement>('input[name="scanInput"]')

    scanInputs.forEach((element, index) => {
      const label = element.id
        ? document.querySelector<HTMLLabelElement>(`label[for="${element.id}"]`)
        : null

      if (index === 0) {
        element.removeAttribute('aria-hidden')
        element.removeAttribute('tabindex')
        label?.removeAttribute('aria-hidden')
        label?.removeAttribute('hidden')
        label?.removeAttribute('data-ignored-scan-label')
      } else {
        element.setAttribute('aria-hidden', 'true')
        element.setAttribute('tabindex', '-1')
        label?.setAttribute('aria-hidden', 'true')
        label?.setAttribute('hidden', '')
        label?.setAttribute('data-ignored-scan-label', 'true')
      }
    })
  }, [])

  const isValidCountType = typeof countType === 'number' && countType >= 1

  const ensureScanPrerequisites = useCallback(() => {
    if (!shopId) {
      throw new Error('Sélectionnez une boutique valide avant de scanner un produit.')
    }

    if (!ownerUserId) {
      throw new Error('Sélectionnez un utilisateur avant de scanner un produit.')
    }

    if (!locationId) {
      throw new Error('Sélectionnez une zone avant de scanner un produit.')
    }

    if (!isValidCountType) {
      throw new Error('Choisissez un type de comptage avant de scanner un produit.')
    }
  }, [isValidCountType, locationId, ownerUserId, shopId])

  const searchProductByEan = useCallback(
    async (ean: string) => {
      try {
        ensureScanPrerequisites()
      } catch (error) {
        return { status: 'error' as const, error }
      }

      try {
        const product = await fetchProductByEan(ean)
        return { status: 'found' as const, product }
      } catch (error) {
        const err = error as HttpError
        if (isHttpError(err) && err.status === 404) {
          console.warn('[inventory] produit introuvable ignoré', err)
          return { status: 'not-found' as const, error: err }
        }
        console.error('[inventory] échec lecture produit', err)
        return { status: 'error' as const, error: err }
      }
    },
    [ensureScanPrerequisites],
  )

  const ensureActiveRun = useCallback(async () => {
    if (items.length > 0 && existingRunId) {
      return existingRunId
    }

    if (existingRunId) {
      return existingRunId
    }

    if (!locationId) {
      throw new Error('Sélectionnez une zone avant de scanner.')
    }

    if (!ownerUserId) {
      throw new Error("Sélectionnez un utilisateur avant de démarrer le comptage.")
    }

    if (!shopId) {
      throw new Error('Sélectionnez une boutique valide avant de démarrer le comptage.')
    }

    if (!isValidCountType) {
      throw new Error('Le type de comptage est invalide.')
    }

    const response = await startInventoryRun(locationId, {
      shopId,
      ownerUserId,
      countType: countType as number,
    })

    const sanitizedRunId = typeof response.runId === 'string' ? response.runId.trim() : ''
    if (sanitizedRunId) {
      setSessionId(sanitizedRunId)
      return sanitizedRunId
    }

    return null
  }, [
    countType,
    existingRunId,
    isValidCountType,
    items.length,
    locationId,
    ownerUserId,
    setSessionId,
    shopId,
  ])

  const handleRestartRun = useCallback(async () => {
    setRestartingRun(true)
    setErrorMessage(null)
    try {
      const runId = await ensureActiveRun()
      if (runId) {
        setResumeCheck('restarted')
        updateStatus('Comptage rouvert sur le serveur, vous pouvez continuer.')
      } else {
        setErrorMessage('Impossible de rouvrir le comptage : le serveur n’a pas renvoyé d’identifiant.')
      }
    } catch (error) {
      setErrorMessage(resolveLifecycleErrorMessage(error, 'Impossible de rouvrir le comptage.'))
    } finally {
      setRestartingRun(false)
    }
  }, [ensureActiveRun, updateStatus])

  const addProductToSession = useCallback(
    async (product: Product, options?: { isManual?: boolean }) => {
      if (!existingRunId) {
        try {
          await ensureActiveRun()
        } catch (error) {
          const message = resolveLifecycleErrorMessage(error, 'Impossible de démarrer le comptage.')
          updateStatus(null)
          setErrorMessage(message)
          return null
        }
      }

      setErrorMessage(null)
      const result = addOrIncrementItem(product, options)
      if (result.status === 'existing') {
        const normalizedEan = product.ean?.trim()
        if (normalizedEan) {
          pendingFocusEanRef.current = normalizedEan
        }
        triggerDuplicateFeedback()
      }
      return result
    },
    [
      addOrIncrementItem,
      ensureActiveRun,
      existingRunId,
      setErrorMessage,
      triggerDuplicateFeedback,
      updateStatus,
    ],
  )

  const handlePickFromCatalogue = useCallback(
    async (row: ProductsModalItem) => {
      const sanitizedEan = sanitizeScanValue(row.ean ?? row.codeDigits ?? '')
      if (!sanitizedEan) {
        setErrorMessage(`Impossible d’ajouter ${row.name} : code manquant.`)
        updateStatus(null)
        return false
      }

      if (sanitizedEan.length > MAX_SCAN_LENGTH) {
        setErrorMessage(`Code ${sanitizedEan} invalide : ${MAX_SCAN_LENGTH} caractères maximum.`)
        updateStatus(null)
        return false
      }

      try {
        ensureScanPrerequisites()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Impossible d’ajouter ce produit.')
        updateStatus(null)
        return false
      }

      updateStatus(`Ajout de ${row.name}…`)
      setErrorMessage(null)

      const fallbackProduct: Product = {
        ean: sanitizedEan,
        name: row.name ?? sanitizedEan,
        sku: row.sku ?? undefined,
        group: row.group ?? null,
        subGroup: row.subGroup ?? null,
      }

      let resolvedProduct: Product | null = null
      try {
        resolvedProduct = await fetchProductByEan(sanitizedEan)
      } catch (error) {
        console.warn('[inventory] catalogue lookup failed, using fallback payload', error)
      }

      const productToAdd = resolvedProduct ?? fallbackProduct
      const result = await addProductToSession(
        { ...productToAdd, sku: productToAdd.sku ?? row.sku ?? undefined },
        { isManual: true },
      )
      if (!result) {
        updateStatus(null)
        return false
      }

      if (result.status === 'existing') {
        updateStatus(`${productToAdd.name} déjà scanné précédemment`, { tone: 'warning' })
        pendingFocusEanRef.current = productToAdd.ean ?? sanitizedEan
        setErrorMessage(null)
        return true
      }

      updateStatus(
        resolvedProduct ? `${productToAdd.name} ajouté` : `${productToAdd.name} ajouté via catalogue`,
      )
      pendingFocusEanRef.current = productToAdd.ean ?? sanitizedEan
      setErrorMessage(null)
      return true
    },
    [addProductToSession, ensureScanPrerequisites, updateStatus, setErrorMessage],
  )

  const handleUnknownProduct = useCallback(
    (code: string) => {
      updateStatus(null)
      setErrorMessage(
        `Code ${code} introuvable dans la liste des produits à inventorier.`,
      )
      setInputLookupStatus('not-found')
      setScanValue(code)
      triggerScanRejectionFeedback()
    },
    [triggerScanRejectionFeedback, updateStatus],
  )

  const handleDetected = useCallback(
    async (rawValue: string) => {
      const value = sanitizeScanValue(rawValue)
      if (!value) {
        return
      }

      if (value.length > MAX_SCAN_LENGTH) {
        updateStatus(null)
        setErrorMessage(`Code ${value} trop long : ${MAX_SCAN_LENGTH} caractères maximum.`)
        setInputLookupStatus('error')
        return
      }

      updateStatus(`Recherche du code ${value}`)
      setErrorMessage(null)

      const result = await searchProductByEan(value)

      if (result.status === 'found') {
        const product: Product = result.product
        const mutation = await addProductToSession(product)
        if (mutation) {
          if (mutation.status === 'existing') {
            updateStatus(`${product.name} déjà scanné précédemment`, { tone: 'warning' })
          } else {
            updateStatus(`${product.name} ajouté`)
          }
        }
        return
      }

      if (result.status === 'not-found') {
        handleUnknownProduct(value)
        return
      }

      const err = result.error
      updateStatus(null)
      setErrorMessage(
        resolveLifecycleErrorMessage(
          err,
          'Impossible de récupérer le produit. Réessayez ou signalez le code scanné.',
        ),
      )
      setInputLookupStatus('error')
    },
    [addProductToSession, handleUnknownProduct, searchProductByEan, updateStatus],
  )

  const normalizedScanValue = sanitizeScanValue(scanValue)
  const scanInputError = useMemo(() => {
    if (!normalizedScanValue) {
      return null
    }
    if (normalizedScanValue.length > MAX_SCAN_LENGTH) {
      return `Code ${normalizedScanValue} trop long : ${MAX_SCAN_LENGTH} caractères maximum.`
    }
    return null
  }, [normalizedScanValue])

  useEffect(() => {
    if (!normalizedScanValue) {
      manualLookupIdRef.current += 1
      lastSearchedInputRef.current = null
      setInputLookupStatus('idle')
      return
    }

    if (scanInputError) {
      manualLookupIdRef.current += 1
      lastSearchedInputRef.current = null
      setInputLookupStatus('error')
      setErrorMessage(scanInputError)
      return
    }

    if (lastSearchedInputRef.current === normalizedScanValue) {
      return
    }

    lastSearchedInputRef.current = normalizedScanValue
    const currentLookupId = ++manualLookupIdRef.current
    setInputLookupStatus('loading')
    updateStatus(`Recherche du code ${normalizedScanValue}`)
    setErrorMessage(null)

    const timeoutId = window.setTimeout(() => {
      void (async () => {
      const result = await searchProductByEan(normalizedScanValue)

        if (manualLookupIdRef.current !== currentLookupId) {
          return
        }

        if (result.status === 'found') {
          const product: Product = result.product
          const mutation = await addProductToSession(product)
          if (mutation) {
            if (mutation.status === 'existing') {
              updateStatus(`${product.name} déjà scanné précédemment`, { tone: 'warning' })
            } else {
              updateStatus(`${product.name} ajouté`)
            }
            setScanValue('')
            setInputLookupStatus('found')
          } else {
            setInputLookupStatus('error')
          }
          return
        }

        if (result.status === 'not-found') {
          handleUnknownProduct(normalizedScanValue)
          return
        }

        const err = result.error
        updateStatus(null)
        setErrorMessage(
          resolveLifecycleErrorMessage(
            err,
            'Impossible de récupérer le produit. Réessayez ou signalez le code scanné.',
          ),
        )
        setInputLookupStatus('error')
      })()
    }, 300)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    addProductToSession,
    handleUnknownProduct,
    normalizedScanValue,
    scanInputError,
    searchProductByEan,
    setScanValue,
    updateStatus,
  ])

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target
      if (value.includes('\n') || value.includes('\r')) {
        const code = sanitizeScanValue(value)
        setScanValue('')
        if (code) {
          void handleDetected(code)
        }
        return
      }
      const sanitized = sanitizeScanValue(value)
      setScanValue(sanitized)
      setErrorMessage(null)
    },
    [handleDetected],
  )

  const handleClearScan = useCallback(() => {
    setScanValue('')
    setErrorMessage(null)
    setInputLookupStatus('idle')
    inputRef.current?.focus()
  }, [setErrorMessage, setInputLookupStatus])

  const handleCompleteRun = useCallback(async () => {
    if (!isValidCountType) {
      setErrorMessage('Le type de comptage est invalide.')
      return
    }

    if (!shopId) {
      setErrorMessage('Sélectionnez une boutique valide avant de terminer le comptage.')
      return
    }

    if (!ownerUserId) {
      setErrorMessage('Sélectionnez un utilisateur avant de terminer le comptage.')
      return
    }

    if (items.length === 0) {
      setErrorMessage('Ajoutez au moins un article avant de terminer le comptage.')
      return
    }

    if (!locationId) {
      setErrorMessage("Impossible de terminer : la zone sélectionnée n’a pas d’identifiant valide.")
      return
    }
    setCompletionLoading(true)
    setErrorMessage(null)
    updateStatus('Envoi du comptage…')
    try {
      const invalidEanLabels = collectInvalidEanLabels(items)
      if (invalidEanLabels.length > 0) {
        const summary = formatInvalidEanSummary(invalidEanLabels)
        throw new Error(
          `Impossible de terminer : certains articles ont un EAN invalide (${summary}). Corrigez-les ou supprimez-les puis réessayez.`,
        )
      }

      const payloadItems = aggregateItemsForCompletion(items, {
        includeZeroQuantities: isConflictResolutionMode,
      })

      if (payloadItems.length === 0) {
        const message = isConflictResolutionMode
          ? 'Ajoutez au moins une référence valide (quantité 0 acceptée) pour terminer le comptage.'
          : 'Ajoutez au moins un article avec une quantité positive pour terminer le comptage.'
        throw new Error(message)
      }

      const payload: CompleteInventoryRunPayload = {
        runId: existingRunId || null,
        ownerUserId,
        countType: countType as number,
        items: payloadItems,
      }

      await completeInventoryRun(locationId, payload)
      updateStatus('Comptage terminé avec succès.')
      clearSession()
      setScanValue('')
      setInputLookupStatus('idle')
      const dialog = completionDialogRef.current
      if (dialog && typeof dialog.showModal === 'function') {
        dialog.showModal()
        requestAnimationFrame(() => {
          completionOkButtonRef.current?.focus()
        })
      } else {
        navigate('/', { replace: true })
      }
    } catch (error) {
      updateStatus(null)
      const httpStatus = (error as { status?: unknown } | null)?.status
      if (httpStatus === 404 && existingRunId) {
        // Le run référencé n'existe plus (clôturé, libéré ou réinitialisé ailleurs) :
        // on conserve les lignes et on détache l'identifiant pour permettre un nouvel envoi.
        setSessionId(null)
        setErrorMessage(
          `Le comptage côté serveur n’existe plus (il a été clôturé ou libéré). Vos ${formatRestoredLines(
            items.length,
          )} sont conservées sur cet appareil : relancez « Terminer ce comptage » pour les enregistrer dans un nouveau comptage.`,
        )
        return
      }
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Impossible de terminer le comptage.'
      setErrorMessage(message)
    } finally {
      setCompletionLoading(false)
    }
  }, [
    clearSession,
    countType,
    existingRunId,
    isConflictResolutionMode,
    isValidCountType,
    items,
    locationId,
    navigate,
    ownerUserId,
    setSessionId,
    shopId,
    updateStatus,
  ])

  const handleOpenCompletionConfirmation = useCallback(() => {
    const dialog = completionConfirmationDialogRef.current
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal()
      requestAnimationFrame(() => {
        completionConfirmButtonRef.current?.focus()
      })
      return
    }

    if (window.confirm(
      'Cette action est définitive : une fois validé, ce comptage ne pourra plus être modifié. Confirmez-vous la clôture du comptage ?',
    )) {
      void handleCompleteRun()
    }
  }, [handleCompleteRun])

  const handleCancelCompletionConfirmation = useCallback(() => {
    const dialog = completionConfirmationDialogRef.current
    if (dialog && typeof dialog.close === 'function') {
      dialog.close()
    }
  }, [])

  const handleConfirmCompletionConfirmation = useCallback(() => {
    const dialog = completionConfirmationDialogRef.current
    if (dialog && typeof dialog.close === 'function') {
      dialog.close()
    }
    void handleCompleteRun()
  }, [handleCompleteRun])

  useEffect(() => {
    const previousCount = previousItemCountRef.current
    previousItemCountRef.current = items.length

    if (!existingRunId || items.length > 0) {
      return
    }

    if (previousCount === 0) {
      return
    }

    if (!locationId || !ownerUserId) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        await releaseInventoryRun(locationId, existingRunId, ownerUserId)
        if (!cancelled) {
          setSessionId(null)
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(resolveLifecycleErrorMessage(error, 'Impossible de libérer le comptage.'))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [existingRunId, items.length, locationId, ownerUserId, setErrorMessage, setSessionId])

  useEffect(() => {
    const targetEan = pendingFocusEanRef.current
    if (!targetEan) {
      return
    }

    const quantityInput = document.querySelector<HTMLInputElement>(
      `[data-ean="${targetEan}"] input[data-testid="quantity-input"]`,
    )
    if (quantityInput) {
      requestAnimationFrame(() => {
        quantityInput.focus({ preventScroll: true })
        quantityInput.select?.()
      })
    }

    pendingFocusEanRef.current = null
  }, [items])

  const handleCompletionModalOk = () => {
    completionDialogRef.current?.close()
    navigate('/', { replace: true })
  }

  const clearQuantityDraft = useCallback((ean: string) => {
    setQuantityDrafts((prev) => {
      if (!(ean in prev)) {
        return prev
      }
      const next = { ...prev }
      delete next[ean]
      return next
    })
  }, [])

  const closeRemovalConfirmation = useCallback(() => {
    const dialog = removalConfirmationDialogRef.current
    if (!dialog) {
      return
    }

    if (typeof dialog.close === 'function') {
      dialog.close()
      return
    }

    dialog.removeAttribute('open')
  }, [])

  const resetPendingRemoval = useCallback(() => {
    setPendingRemovalItem(null)
  }, [])

  const handleCancelRemoval = useCallback(() => {
    closeRemovalConfirmation()
    resetPendingRemoval()
  }, [closeRemovalConfirmation, resetPendingRemoval])

  const handleConfirmRemoval = useCallback(() => {
    if (!pendingRemovalItem) {
      closeRemovalConfirmation()
      resetPendingRemoval()
      return
    }

    const targetEan = pendingRemovalItem.product.ean
    clearQuantityDraft(targetEan)
    removeItem(targetEan)
    closeRemovalConfirmation()
    resetPendingRemoval()
  }, [clearQuantityDraft, closeRemovalConfirmation, pendingRemovalItem, removeItem, resetPendingRemoval])

  const adjustQuantity = (ean: string, delta: number) => {
    const item = items.find((entry) => entry.product.ean === ean)
    if (!item) return
    const nextQuantity = item.quantity + delta
    if (nextQuantity <= 0) {
      clearQuantityDraft(ean)
      removeItem(ean)
      setPendingRemovalItem(null)
      const dialog = removalConfirmationDialogRef.current
      if (dialog?.open && typeof dialog.close === 'function') {
        dialog.close()
      }
      return
    }

    setQuantity(ean, nextQuantity)
    clearQuantityDraft(ean)
  }

  const commitQuantity = useCallback(
    (ean: string, rawValue: string | undefined) => {
      const sanitized = (rawValue ?? '').replace(/\D+/g, '').slice(0, 4)

      if (sanitized.length === 0) {
        clearQuantityDraft(ean)
        return
      }

      const parsed = Number.parseInt(sanitized, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        clearQuantityDraft(ean)
        removeItem(ean)
        return
      }

      setQuantity(ean, parsed)
      clearQuantityDraft(ean)
    },
    [clearQuantityDraft, removeItem, setQuantity],
  )

  const handleQuantityInputChange = useCallback(
    (ean: string, event: ChangeEvent<HTMLInputElement>) => {
      const sanitized = event.target.value.replace(/\D+/g, '').slice(0, 4)

      setQuantityDrafts((prev) => {
        const nextValue = sanitized
        const previousValue = prev[ean] ?? ''
        if (nextValue === previousValue) {
          return prev
        }
        return { ...prev, [ean]: nextValue }
      })
    },
    [],
  )

  const handleQuantityBlur = useCallback(
    (ean: string, event: FocusEvent<HTMLInputElement>) => {
      commitQuantity(ean, event.currentTarget.value)
    },
    [commitQuantity],
  )

  const handleQuantityKeyDown = useCallback(
    (ean: string, event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitQuantity(ean, event.currentTarget.value)
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        clearQuantityDraft(ean)
        event.currentTarget.blur()
      }
    },
    [clearQuantityDraft, commitQuantity],
  )

  const handleQuantityFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    requestAnimationFrame(() => {
      input.select()
    })
  }, [])

  const handleQuantityPointerDown = useCallback((event: PointerEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    if (document.activeElement !== input) {
      event.preventDefault()
      input.focus()
    }
  }, [])

  useEffect(() => {
    setQuantityDrafts((prev) => {
      const validEans = new Set(items.map((entry) => entry.product.ean))
      let changed = false
      const next: Record<string, string> = {}

      for (const [ean, value] of Object.entries(prev)) {
        if (validEans.has(ean)) {
          next[ean] = value
        } else {
          changed = true
        }
      }

      if (!changed && Object.keys(next).length === Object.keys(prev).length) {
        return prev
      }

      return next
    })
  }, [items])

  const hasPositiveQuantity = useMemo(() => {
    return items.some((item) => {
      const draftValue = quantityDrafts[item.product.ean]
      if (typeof draftValue === 'string' && draftValue.length > 0) {
        const parsed = Number.parseInt(draftValue, 10)
        return Number.isFinite(parsed) && parsed > 0
      }
      return item.quantity > 0
    })
  }, [items, quantityDrafts])

  const canCompleteRun =
    locationId.length > 0 &&
    isValidCountType &&
    ownerUserId.length > 0 &&
    shopId.length > 0 &&
    items.length > 0 &&
    (isConflictResolutionMode || hasPositiveQuantity) &&
    !completionLoading &&
    (!isConflictResolutionMode || conflictPrefillStatus === 'loaded')

  const resumeBanner = useMemo(() => {
    if (!restoredDraft) {
      return null
    }

    const restoredAtLabel = formatRestoredAt(restoredDraft.savedAt)
    const restoredSummary = `${formatRestoredLines(restoredDraft.itemCount)} restaurée${
      restoredDraft.itemCount > 1 ? 's' : ''
    }${restoredAtLabel ? ` (sauvegarde du ${restoredAtLabel})` : ''}.`

    let title = 'Comptage restauré depuis cet appareil'
    let body: string
    let tone: 'info' | 'warning' | 'success' = 'info'

    switch (resumeCheck) {
      case 'active':
        body = `${restoredSummary} Le comptage côté serveur est toujours ouvert, vous pouvez continuer.`
        break
      case 'no-run':
        body = `${restoredSummary} Vous pouvez continuer.`
        break
      case 'missing':
        title = 'Le comptage côté serveur n’existe plus'
        tone = 'warning'
        body = `Il a été clôturé ou libéré depuis un autre appareil. Vos ${formatRestoredLines(
          items.length,
        )} ont été conservées sur cet appareil : reprenez le comptage pour les enregistrer (un nouveau comptage sera ouvert sur cette zone).`
        break
      case 'restarted':
        title = 'Comptage rouvert'
        tone = 'success'
        body = `Un nouveau comptage a été ouvert sur le serveur avec vos ${formatRestoredLines(
          items.length,
        )}. Vous pouvez continuer.`
        break
      case 'unavailable':
        body = `${restoredSummary} Impossible de vérifier l’état du comptage côté serveur pour le moment ; vous pouvez continuer.`
        break
      case 'checking':
      case 'idle':
      default:
        body = `${restoredSummary} Vérification du comptage côté serveur…`
        break
    }

    const toneClassName =
      tone === 'warning'
        ? 'border-amber-300/80 bg-amber-50/80 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100'
        : tone === 'success'
          ? 'border-emerald-300/80 bg-emerald-50/80 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-100'
          : 'border-brand-200/80 bg-brand-50/80 text-brand-900 dark:border-brand-400/40 dark:bg-brand-500/10 dark:text-brand-100'

    const isChecking = resumeCheck === 'checking' || resumeCheck === 'idle'

    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="resume-banner"
        data-state={resumeCheck}
        className={`space-y-2 rounded-2xl border p-3 text-sm ${toneClassName}`}
      >
        <p className="font-semibold">{title}</p>
        <p>{body}</p>
        {!isChecking && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {resumeCheck === 'missing' && (
              <Button
                type="button"
                size="sm"
                onClick={() => void handleRestartRun()}
                disabled={restartingRun}
                data-testid="btn-restart-run"
              >
                {restartingRun ? 'Réouverture…' : 'Reprendre le comptage'}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={dismissRestoredDraft}
              data-testid="btn-dismiss-resume"
            >
              Fermer
            </Button>
          </div>
        )}
      </div>
    )
  }, [dismissRestoredDraft, handleRestartRun, items.length, restartingRun, restoredDraft, resumeCheck])

  return (
    <div className="flex flex-col gap-6" data-testid="page-session" ref={pageRef}>
      <Card className="space-y-3 md:space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">Session de comptage</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {location?.label} • {countTypeLabel} •
              {' '}
              {selectedUserDisplayName ?? '–'}
            </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleOpenLogsDialog}
            aria-haspopup="dialog"
            data-testid="btn-open-logs"
          >
            Journal des actions ({logs.length})
          </Button>
          {canDisplayScanInputs && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => navigate('/inventory/scan-camera')}
                data-testid="btn-scan-camera"
              >
                Scan caméra
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCatalogueOpen(true)}
                data-testid="btn-open-catalogue"
                disabled={!shopId}
              >
                Ajout via catalogue
              </Button>
            </>
          )}
        </div>
      </div>
        {resumeBanner}
        {isConflictResolutionMode && (
          <div className="space-y-2 rounded-2xl border border-rose-200/80 bg-rose-50/80 p-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-rose-300 bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-400/70 dark:bg-rose-500/20 dark:text-rose-100">
                <span aria-hidden>⚠️</span>
                Zone en conflit
              </span>
              {conflictDetail?.items?.length ? (
                <span className="text-xs text-rose-500 dark:text-rose-100/70">
                  {conflictDetail.items.length} référence{conflictDetail.items.length > 1 ? 's' : ''} à vérifier
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="btn-view-conflicts"
                onClick={handleToggleConflictPanel}
              >
                {isConflictPanelOpen ? 'Masquer les détails' : 'Voir les détails'}
              </Button>
            </div>
            {conflictPrefillStatus === 'loading' && (
              <div className="pt-1">
                <LoadingIndicator label="Chargement des références en conflit" />
              </div>
            )}
            {conflictPrefillStatus === 'error' && (
              <div className="flex flex-wrap items-center gap-3 text-rose-700 dark:text-rose-200">
                <span>{conflictPrefillError ?? 'Impossible de charger les références en conflit.'}</span>
                <Button type="button" variant="ghost" size="sm" onClick={handleRetryConflictPrefill}>
                  Réessayer
                </Button>
              </div>
            )}
            {conflictPrefillStatus === 'loaded' &&
              conflictDetail &&
              conflictDetail.items.length === 0 && (
                <p className="text-xs font-medium text-rose-600 dark:text-rose-200">
                  Toutes les divergences ont été résolues pour cette zone.
                </p>
              )}
            <div
              data-testid="conflict-details-panel"
              data-state={isConflictPanelOpen ? 'open' : 'closed'}
              hidden={!isConflictPanelOpen}
              className="space-y-3 rounded-xl border border-rose-200/80 bg-white/70 p-3 text-sm text-slate-700 shadow-inner dark:border-rose-500/30 dark:bg-slate-900/60 dark:text-slate-100"
            >
              {conflictPrefillStatus === 'loading' ? (
                <LoadingIndicator label="Chargement des détails de conflit" />
              ) : conflictDetail ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {conflictDetail.runs?.map((run) => (
                      <div
                        key={run.runId ?? `run-${run.countType}`}
                        className="rounded-lg border border-rose-100/80 bg-white/70 p-2.5 dark:border-rose-500/30 dark:bg-rose-500/10"
                      >
                        <p className="text-sm font-semibold text-rose-700 dark:text-rose-100">
                          Comptage {run.countType}
                        </p>
                        {run.ownerDisplayName && (
                          <p className="text-xs text-rose-600 dark:text-rose-100/80">
                            Opérateur : {run.ownerDisplayName}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-200">
                    Amplitude
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    Détails des écarts disponibles ci-dessus pour chaque passage.
                  </p>
                </>
              ) : (
                <p className="text-xs text-rose-700 dark:text-rose-200">
                  Détails des conflits indisponibles pour le moment.
                </p>
              )}
            </div>
          </div>
        )}
        {canDisplayScanInputs && (
          <div className="space-y-2">
            <Input
              ref={inputRef}
              name="scanInput"
              label="Scanner (douchette ou saisie)"
              placeholder="Saisissez ou scannez un code EAN/RFID"
              value={scanValue}
              onChange={handleInputChange}
              inputMode="text"
              maxLength={MAX_SCAN_LENGTH}
              autoComplete="off"
              aria-invalid={Boolean(scanInputError)}
              endAdornment={
                scanValue ? (
                  <button
                    type="button"
                    onClick={handleClearScan}
                    aria-label="Effacer la saisie"
                    className="rounded-full p-1 text-(--cb-muted) transition-colors duration-200 hover:text-(--cb-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-1 focus-visible:ring-offset-(--cb-surface-soft)"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="none"
                      className="h-4 w-4"
                    >
                      <path
                        d="m6 6 8 8m0-8-8 8"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : null
              }
              autoFocus={canDisplayScanInputs}
            />
            {scanInputError && (
              <p className="text-xs text-rose-600 dark:text-rose-300" aria-live="polite">
                {scanInputError}
              </p>
            )}
          </div>
        )}
        {status && (
          <p
            className={
              status.tone === 'warning'
                ? 'text-sm text-amber-700 dark:text-amber-300'
                : 'text-sm text-brand-600 dark:text-brand-200'
            }
            data-testid="status-message"
          >
            {status.text}
          </p>
        )}
        {errorMessage && <p className="text-sm text-red-600 dark:text-red-300">{errorMessage}</p>}
      </Card>

      <dialog
        ref={logsDialogRef}
        aria-modal="true"
        aria-labelledby="session-log-title"
        aria-describedby="session-log-description"
        className="px-4"
      >
        <Card className="w-full max-w-2xl shadow-elev-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p id="session-log-title" className="text-lg font-semibold">
                Journal de session
              </p>
              <p id="session-log-description" className="text-sm text-slate-600 dark:text-slate-300">
                Historique des scans, ajouts et ajustements réalisés pendant ce comptage.
              </p>
            </div>
            <Button type="button" variant="ghost" onClick={handleCloseLogsDialog}>
              Fermer
            </Button>
          </div>
          <div className="mt-4 max-h-96 overflow-y-auto">
            {logs.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">Aucun évènement enregistré pour l’instant.</p>
            ) : (
              <ul className="space-y-3" data-testid="logs-list">
                {logs.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-600 dark:bg-slate-900/60"
                  >
                    <p className="font-semibold text-slate-900 dark:text-white">{entry.message}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{formatLogTimestamp(entry.timestamp)}</p>
                    {entry.context?.ean && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        EAN {entry.context.ean}
                        {typeof entry.context.quantity === 'number' ? ` • Quantité ${entry.context.quantity}` : ''}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">Le journal est réinitialisé quand le comptage est terminé.</p>
        </Card>
      </dialog>

      <dialog
        ref={removalConfirmationDialogRef}
        aria-modal="true"
        aria-labelledby="remove-item-title"
        aria-describedby="remove-item-description"
        className="px-4"
        data-testid="confirm-remove-dialog"
        onCancel={(event) => {
          event.preventDefault()
          handleCancelRemoval()
        }}
        onClose={resetPendingRemoval}
      >
        <Card className="w-full max-w-md space-y-4 shadow-elev-2">
          <div className="space-y-2">
            <p id="remove-item-title" className="text-lg font-semibold text-slate-900 dark:text-white">
              Retirer cet article ?
            </p>
            <p id="remove-item-description" className="text-sm text-slate-600 dark:text-slate-300">
              {pendingRemovalItem
                ? `Confirmez la suppression de «${pendingRemovalItem.product.name}» de la liste des articles scannés.`
                : 'Confirmez la suppression de cet article de la liste des articles scannés.'}
            </p>
            {pendingRemovalItem && (
              <div className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                <p>Quantité actuelle : {pendingRemovalItem.quantity}</p>
                <p>EAN {formatIdentifierForDisplay(pendingRemovalItem.product.ean)}</p>
                {normalizeIdentifier(pendingRemovalItem.product.sku) && (
                  <p>SKU {formatIdentifierForDisplay(pendingRemovalItem.product.sku)}</p>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={handleCancelRemoval}>
              Annuler
            </Button>
            <Button type="button" variant="danger" onClick={handleConfirmRemoval}>
              Retirer
            </Button>
          </div>
        </Card>
      </dialog>

      <Card className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <h3 className="text-xl font-semibold text-slate-900 dark:text-white">Articles scannés</h3>
            <span className="text-sm text-slate-600 dark:text-slate-400">{items.length} références</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end" />
        </div>
        {displayedItems.length === 0 && (!isConflictResolutionMode || conflictPrefillStatus === 'loaded') && (
          <EmptyState
            title={isConflictResolutionMode ? 'Aucune référence en conflit' : 'En attente de scan'}
            description={
              isConflictResolutionMode
                ? 'Toutes les divergences ont été résolues pour cette zone.'
                : "Scannez un produit via la caméra ou la douchette pour l'ajouter au comptage."
            }
          />
        )}
        <ul className="flex flex-col gap-2.5 md:gap-3">
          {displayedItems.map((item) => {
            const skuDisplay = formatIdentifierForDisplay(item.product.sku)
            const eanDisplay = formatIdentifierForDisplay(item.product.ean)
            const subGroupDisplay = normalizeIdentifier(item.product.subGroup)
            const metadataSegments = [
              subGroupDisplay ? `Sous-groupe ${subGroupDisplay}` : null,
              `SKU ${skuDisplay}`,
              `EAN ${eanDisplay}`,
            ].filter((segment): segment is string => Boolean(segment))

            let inlineConflictSummary: InlineConflictSummary | null = null
            if (
              item.hasConflict &&
              conflictPrefillStatus === 'loaded' &&
              inlineConflictSummariesByKey
            ) {
              const eanKey = buildConflictLookupKey(item.product.ean)
              if (eanKey) {
                inlineConflictSummary = inlineConflictSummariesByKey.get(eanKey) ?? null
              }
              if (!inlineConflictSummary) {
                const skuKey = buildConflictLookupKey(item.product.sku)
                if (skuKey) {
                  inlineConflictSummary = inlineConflictSummariesByKey.get(skuKey) ?? null
                }
              }
            }

            const showInlineConflicts = Boolean(inlineConflictSummary?.runs.length)

            return (
              <li
                key={item.id}
                className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition-colors dark:border-slate-700 dark:bg-slate-900/60 md:rounded-3xl md:p-4"
                data-testid="scanned-item"
                data-item-id={item.id}
                data-ean={item.product.ean}
                data-sku={item.product.sku ?? ''}
              >
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
                    <div className="flex flex-col gap-1 md:flex-1">
                      <p className="text-base font-semibold text-slate-900 dark:text-white sm:text-lg">
                        {item.product.name}
                      </p>
                      <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500 sm:text-xs">
                        {metadataSegments.map((segment) => (
                          <span key={segment}>{segment}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3 md:flex-none">
                      {showInlineConflicts && inlineConflictSummary && (
                        <div
                          className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-rose-200/80 bg-rose-50/80 px-3 py-1.5 text-sm font-semibold text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
                          data-testid="scanned-item-conflicts"
                        >
                          {inlineConflictSummary.runs.map((run, index) => (
                            <Fragment key={run.key}>
                              <span className="inline-flex items-baseline gap-1">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-rose-500 dark:text-rose-200">
                                  C{run.countType}
                                </span>
                                <span className="text-base leading-none text-rose-700 dark:text-rose-100">
                                  {run.quantity}
                                </span>
                              </span>
                              {index < inlineConflictSummary.runs.length - 1 && (
                                <span className="text-xs font-normal text-rose-300 dark:text-rose-200/70">/</span>
                              )}
                            </Fragment>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-400 dark:text-slate-500 sm:hidden">
                          Quantité
                        </span>
                        <div className="flex items-center gap-2 rounded-xl bg-slate-100 p-2 shadow-inner sm:bg-transparent sm:p-0 sm:shadow-none">
                          <Button
                            type="button"
                            variant="secondary"
                            className="tap-highlight-none no-focus-ring btn-glyph-center h-10 w-10 text-lg font-semibold sm:h-9 sm:w-9"
                            onClick={() => adjustQuantity(item.product.ean, -1)}
                            aria-label="Retirer"
                          >
                            −
                          </Button>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={4}
                            data-testid="quantity-input"
                            aria-label={`Quantité pour ${item.product.name}`}
                            value={quantityDrafts[item.product.ean] ?? String(item.quantity)}
                            onChange={(event) => handleQuantityInputChange(item.product.ean, event)}
                            onBlur={(event) => handleQuantityBlur(item.product.ean, event)}
                            onKeyDown={(event) => handleQuantityKeyDown(item.product.ean, event)}
                            onFocus={handleQuantityFocus}
                            onPointerDown={handleQuantityPointerDown}
                            className="h-11 w-20 rounded-lg border border-slate-300 bg-white text-center text-xl font-bold text-slate-900 shadow-sm outline-none focus-visible:border-brand-400 focus-visible:ring-2 focus-visible:ring-brand-200 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                            autoComplete="off"
                          />
                          <Button
                            type="button"
                            className="tap-highlight-none no-focus-ring btn-glyph-center h-10 w-10 text-lg font-semibold sm:h-9 sm:w-9"
                            onClick={() => adjustQuantity(item.product.ean, 1)}
                            aria-label="Ajouter"
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        {displayedItems.length > 0 && (
          <div className="flex justify-end">
            <Button
              data-testid="btn-complete-run"
              className="py-3"
              disabled={!canCompleteRun}
              aria-disabled={!canCompleteRun}
              onClick={handleOpenCompletionConfirmation}
            >
              {completionLoading ? 'Enregistrement…' : 'Terminer ce comptage'}
            </Button>
          </div>
        )}
      </Card>
      <dialog
        ref={completionConfirmationDialogRef}
        aria-modal="true"
        aria-labelledby="completion-confirmation-title"
        aria-describedby="completion-confirmation-description"
        className="px-4"
      >
        <Card className="w-full max-w-lg shadow-elev-2">
          <div className="space-y-4">
            <p id="completion-confirmation-title" className="text-lg font-semibold">
              Confirmer la clôture du comptage
            </p>
            <p id="completion-confirmation-description" className="text-sm text-slate-600 dark:text-slate-300">
              Cette action est définitive&nbsp;: une fois validé, ce comptage ne pourra plus être modifié. Êtes-vous certain de vouloir terminer ce comptage&nbsp;?
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={handleCancelCompletionConfirmation}>
              Annuler
            </Button>
            <Button
              ref={completionConfirmButtonRef}
              type="button"
              onClick={handleConfirmCompletionConfirmation}
              data-testid="btn-confirm-complete"
            >
              Confirmer la clôture
            </Button>
          </div>
        </Card>
      </dialog>
      <dialog
        ref={completionDialogRef}
        id="complete-inventory-modal"
        aria-modal="true"
        aria-labelledby="completion-success-title"
        className="px-4"
      >
        <Card className="w-full max-w-lg shadow-elev-2">
          <p id="completion-success-title" className="text-lg font-semibold">
            Le comptage a été enregistré avec succès.
          </p>
          <div className="mt-6 flex justify-end">
            <Button
              ref={completionOkButtonRef}
              type="button"
              onClick={handleCompletionModalOk}
              data-testid="btn-complete-ok"
            >
              OK
            </Button>
          </div>
        </Card>
      </dialog>
      <ProductsModal
        open={catalogueOpen && Boolean(shopId)}
        onClose={() => setCatalogueOpen(false)}
        shopId={shopId}
        onSelect={handlePickFromCatalogue}
      />

    </div>
  )
}
