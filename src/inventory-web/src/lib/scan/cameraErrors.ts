/**
 * Traduction des erreurs caméra (DOMException de getUserMedia et erreurs internes)
 * en messages français actionnables pour les utilisateurs de la boutique.
 */

export class InsecureContextError extends Error {
  constructor() {
    super('getUserMedia requiert un contexte sécurisé (HTTPS).')
    this.name = 'InsecureContextError'
  }
}

export class CameraUnsupportedError extends Error {
  constructor() {
    super('navigator.mediaDevices.getUserMedia est indisponible.')
    this.name = 'CameraUnsupportedError'
  }
}

export type CameraErrorDescription = {
  /** Message principal, lisible par un utilisateur non technicien. */
  message: string
  /** Détail technique (nom de l’erreur) à afficher en petit, ou `null`. */
  technical: string | null
}

export const MESSAGE_INSECURE_CONTEXT =
  'Site non sécurisé (HTTPS requis). Contactez le service informatique.'
export const MESSAGE_NOT_ALLOWED =
  'Autorisez l’accès à la caméra dans les réglages du navigateur, puis réessayez.'
export const MESSAGE_NOT_FOUND = 'Aucune caméra détectée sur cet appareil.'
export const MESSAGE_NOT_READABLE =
  'La caméra est utilisée par une autre application. Fermez-la puis réessayez.'
export const MESSAGE_OVERCONSTRAINED = 'Cette caméra ne prend pas en charge les réglages demandés.'
export const MESSAGE_UNSUPPORTED = 'Ce navigateur ne permet pas d’accéder à la caméra.'
export const MESSAGE_GENERIC = 'Impossible de démarrer la caméra.'

export const getErrorName = (error: unknown): string | null => {
  if (!error) {
    return null
  }
  if (typeof error === 'object' && 'name' in error) {
    const { name } = error as { name?: unknown }
    if (typeof name === 'string' && name.trim()) {
      return name.trim()
    }
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return null
}

const getErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
  }
  return null
}

export const isOverconstrainedError = (error: unknown): boolean => {
  const name = getErrorName(error)
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError'
}

export const describeCameraError = (error: unknown): CameraErrorDescription => {
  const name = getErrorName(error)
  switch (name) {
    case 'InsecureContextError':
      return { message: MESSAGE_INSECURE_CONTEXT, technical: null }
    case 'CameraUnsupportedError':
      return { message: MESSAGE_UNSUPPORTED, technical: null }
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { message: MESSAGE_NOT_ALLOWED, technical: null }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { message: MESSAGE_NOT_FOUND, technical: null }
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { message: MESSAGE_NOT_READABLE, technical: null }
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { message: MESSAGE_OVERCONSTRAINED, technical: null }
    default: {
      const message = getErrorMessage(error)
      const technical = name && message && name !== message ? `${name} : ${message}` : (name ?? message)
      return { message: MESSAGE_GENERIC, technical: technical ?? null }
    }
  }
}

/** Version « une ligne » (message + détail technique entre parenthèses). */
export const formatCameraErrorLabel = (error: unknown): string => {
  const { message, technical } = describeCameraError(error)
  return technical ? `${message} (${technical})` : message
}
