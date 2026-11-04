// src/inventory-web/src/lib/api/download.ts
import { buildHeaders, type HttpError } from '@/lib/api/http'

const extractProblemDetail = (text: string): { detail: string | null; problem: unknown } => {
  if (!text) {
    return { detail: null, problem: undefined }
  }
  try {
    const problem = JSON.parse(text) as { detail?: unknown; title?: unknown }
    const detail =
      typeof problem.detail === 'string' && problem.detail.trim().length > 0
        ? problem.detail
        : typeof problem.title === 'string' && problem.title.trim().length > 0
          ? problem.title
          : null
    return { detail, problem }
  } catch {
    return { detail: null, problem: undefined }
  }
}

/** Nom de fichier annoncé par l'API (Content-Disposition), sinon le nom de secours. */
export const extractFileName = (contentDisposition: string | null, fallback: string): string => {
  if (!contentDisposition) {
    return fallback
  }

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim())
    } catch {
      // nom encodé illisible : on essaie la forme simple
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition)
  const name = plain?.[1]?.trim()
  return name && name.length > 0 ? name : fallback
}

/**
 * Télécharge un fichier produit par l'API (CSV, Excel) avec les mêmes en-têtes que les autres appels.
 * En cas de refus (ex. 409 « Inventaire non terminé »), lève une erreur portant le message de l'API.
 */
export async function downloadFile(url: string, fallbackFileName: string): Promise<string> {
  const response = await fetch(url, { headers: buildHeaders() })

  if (!response.ok) {
    const text = await response.text()
    const { detail, problem } = extractProblemDetail(text)
    const error = new Error(detail ?? `Téléchargement impossible (HTTP ${response.status}).`) as HttpError
    error.status = response.status
    error.url = response.url || url
    error.body = text
    error.problem = problem
    throw error
  }

  const blob = await response.blob()
  const fileName = extractFileName(response.headers.get('Content-Disposition'), fallbackFileName)
  const objectUrl = URL.createObjectURL(blob)

  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    document.body.removeChild(anchor)
    // Laisse le temps au navigateur (Safari iOS notamment) de lire le fichier avant de libérer l'URL.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }

  return fileName
}
