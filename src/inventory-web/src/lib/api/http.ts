// src/inventory-web/src/lib/api/http.ts
import { getInventoryHttpContextSnapshot } from '@/app/contexts/inventoryHttpContext'
import { loadSelectedShopUser } from '@/lib/selectedUserStorage'
import { loadShop } from '@/lib/shopStorage'

export interface HttpError extends Error {
  status: number
  url: string
  body?: string
  problem?: unknown
}

const SNIPPET_MAX_LENGTH = 512
const truncateSnippet = (v: string) => (v.length <= SNIPPET_MAX_LENGTH ? v : v.slice(0, SNIPPET_MAX_LENGTH))

function buildHttpError(message: string, res: Response, body?: string, extra?: Record<string, unknown>): HttpError {
  const err = new Error(message) as HttpError
  err.status = res.status
  err.url = res.url
  if (body != null) err.body = truncateSnippet(body)
  if (extra && 'problem' in extra) err.problem = (extra as { problem?: unknown }).problem
  return err
}

// ajout en haut si vous souhaitez un type dédié (optionnel)
export class AbortedRequestError extends Error {
  status = 499 as number; // code "client closed request" officieux
  url: string;
  constructor(url: string) {
    super('ABORTED');
    this.name = 'AbortedRequestError';
    this.url = url;
  }
}

export class RequestTimeoutError extends Error {
  status = 408 as number
  url: string
  timeoutMs: number
  constructor(url: string, timeoutMs: number) {
    super('TIMEOUT')
    this.name = 'RequestTimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

export type HttpRequestInit<TBody = unknown> = Omit<RequestInit, 'body'> & {
  body?: RequestInit['body'] | TBody
  timeoutMs?: number
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

const shouldJsonStringify = (value: unknown): value is Record<string, unknown> | unknown[] => {
  if (!value || typeof value !== 'object') {
    return false
  }

  if (Array.isArray(value)) {
    return true
  }

  if (value instanceof FormData || value instanceof Blob) {
    return false
  }

  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return false
  }

  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    return false
  }

  if (value instanceof ArrayBuffer) {
    return false
  }

  if (ArrayBuffer.isView(value)) {
    return false
  }

  return isPlainObject(value)
}

const sanitizeHeaderValue = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function buildHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input ?? {})


  const httpContext = getInventoryHttpContextSnapshot()
  const contextUser = httpContext.selectedUser ?? null
  const contextSessionId = sanitizeHeaderValue(httpContext.sessionId)

  let shopId: string | null = null
  let operator = contextUser ?? null

  try {
    const shop = loadShop()
    shopId = sanitizeHeaderValue(shop?.id ?? null)
  } catch {
    shopId = null
  }

  if (!operator && shopId) {
    operator = loadSelectedShopUser(shopId)
  }

  const operatorId = operator ? sanitizeHeaderValue(operator.id) : null
  const operatorDisplayName = operator ? sanitizeHeaderValue(operator.displayName) : null
  const operatorLogin = operator ? sanitizeHeaderValue(operator.login) : null
  const operatorShopId = operator ? sanitizeHeaderValue(operator.shopId) ?? shopId : shopId
  const preferredOperatorName = operatorDisplayName ?? operatorLogin ?? operatorId

  if (operator && operatorId) {
    headers.set('X-Operator-Id', operatorId)
  }

  if (operator && preferredOperatorName) {
    headers.set('X-Operator-Name', preferredOperatorName)
  }

  if (operator && operatorLogin) {
    headers.set('X-Operator-Login', operatorLogin)
  }

  if (operator && operatorShopId) {
    headers.set('X-Operator-ShopId', operatorShopId)
  }

  if (operator) {
    headers.delete('X-Admin')
    if (operator.isAdmin) {
      headers.set('X-Admin', 'true')
    }
  }

  const sessionId = contextSessionId ?? null
  if (sessionId) {
    headers.set('X-Session-Id', sessionId)
  }

  return headers
}

export default async function http<TBody = unknown>(url: string, init: HttpRequestInit<TBody> = {}): Promise<unknown> {
  // 1) Construire l'URL et injecter shopId si applicable
  let finalUrl = url
  try {
    const u = new URL(url, window.location.origin)
    const path = u.pathname
    const isApi = path.startsWith('/api')
    const isShops = path.startsWith('/api/shops')

    const shop = loadShop()
    if (isApi && !isShops && shop?.id && !u.searchParams.has('shopId')) {
      u.searchParams.set('shopId', shop.id)
    }
    finalUrl = u.toString()
  } catch {
    // Si l'URL est relative "bizarre", on laisse passer tel quel.
  }

  // 2) Préparer les headers et le body
  const { timeoutMs, signal: inputSignal, headers: initHeaders, body: rawBody, ...restInit } = init
  const headers = buildHeaders(initHeaders)
  let body: BodyInit | null | undefined = rawBody as BodyInit | null | undefined

  if (shouldJsonStringify(rawBody)) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    body = JSON.stringify(rawBody)
  }

  const supportsAbortController = typeof AbortController === 'function'
  const enableTimeout = typeof timeoutMs === 'number' && timeoutMs > 0
  const abortController = enableTimeout && supportsAbortController ? new AbortController() : null
  let linkedAbortCleanup: (() => void) | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let didTimeout = false

  let signal: AbortSignal | undefined = inputSignal
  if (abortController) {
    signal = abortController.signal
    if (inputSignal) {
      const forwardAbort = () => abortController.abort()
      if (inputSignal.aborted) {
        abortController.abort()
      } else {
        inputSignal.addEventListener('abort', forwardAbort, { once: true })
        linkedAbortCleanup = () => inputSignal.removeEventListener('abort', forwardAbort)
      }
    }
  }

  let timeoutPromise: Promise<never> | null = null
  if (enableTimeout) {
    timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        didTimeout = true
        if (abortController) {
          abortController.abort()
        }
        reject(new RequestTimeoutError(finalUrl, timeoutMs))
      }, timeoutMs)
    })
  }

  const cleanupTiming = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (linkedAbortCleanup) {
      linkedAbortCleanup()
      linkedAbortCleanup = null
    }
  }

  const fetchPromise = fetch(finalUrl, {
    ...restInit,
    headers,
    body,
    signal,
  })

  let res: Response
  try {
    if (timeoutPromise) {
      res = (await Promise.race([fetchPromise, timeoutPromise])) as Response
    } else {
      res = await fetchPromise
    }
    cleanupTiming()
  } catch (rawError: unknown) {
    cleanupTiming()
    if (rawError instanceof RequestTimeoutError) {
      throw rawError
    }
    const error = rawError as { message?: unknown; name?: unknown }
    const message = typeof error.message === 'string' ? error.message : ''
    const normalizedMessage = message.toLowerCase()

    // Ne hurle pas pour un abort normal (cleanup d'effet, navigation, etc.)
    if (error?.name === 'AbortError' || normalizedMessage.includes('aborted')) {
      if (didTimeout && typeof timeoutMs === 'number' && timeoutMs > 0) {
        throw new RequestTimeoutError(finalUrl, timeoutMs)
      }
      throw new AbortedRequestError(finalUrl)
    }

    throw rawError
  }
  
  const contentType = res.headers.get('Content-Type') ?? ''
  const isJson = contentType.includes('application/json')
  const text = await res.text()
  const snippet = truncateSnippet(text)

  if (!res.ok) {
    // Essayer d’extraire un “problem+json” pour enrichir l’erreur
    let problem: unknown = undefined
    if (isJson && text) {
      try {
        problem = JSON.parse(text)
      } catch {
        // rien
      }
    }
    const defaultMsg = `HTTP ${res.status}`
    const detail =
      (problem as { detail?: string } | undefined)?.detail ||
      (problem as { title?: string } | undefined)?.title ||
      snippet ||
      defaultMsg

    throw buildHttpError(detail, res, text, { problem, contentType, snippet })
  }

  if (!text) return null
  if (!isJson) return text

  try {
    return JSON.parse(text)
  } catch {
    throw buildHttpError('JSON invalide', res, text, {
      problem: { contentType, snippet },
      contentType,
      snippet,
    })
  }
}
