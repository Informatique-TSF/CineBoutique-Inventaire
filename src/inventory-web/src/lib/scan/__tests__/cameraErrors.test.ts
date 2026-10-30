import { describe, expect, it } from 'vitest'

import {
  CameraUnsupportedError,
  InsecureContextError,
  MESSAGE_GENERIC,
  MESSAGE_INSECURE_CONTEXT,
  MESSAGE_NOT_ALLOWED,
  MESSAGE_NOT_FOUND,
  MESSAGE_NOT_READABLE,
  MESSAGE_OVERCONSTRAINED,
  MESSAGE_UNSUPPORTED,
  describeCameraError,
  formatCameraErrorLabel,
  getErrorName,
  isOverconstrainedError,
} from '@/lib/scan/cameraErrors'

const domError = (name: string, message = 'détail technique') => new DOMException(message, name)

describe('describeCameraError', () => {
  it('traduit le contexte non sécurisé en consigne HTTPS', () => {
    expect(describeCameraError(new InsecureContextError())).toEqual({
      message: MESSAGE_INSECURE_CONTEXT,
      technical: null,
    })
  })

  it('traduit le refus de permission en consigne de réglages', () => {
    expect(describeCameraError(domError('NotAllowedError')).message).toBe(MESSAGE_NOT_ALLOWED)
    expect(describeCameraError({ name: 'PermissionDeniedError' }).message).toBe(MESSAGE_NOT_ALLOWED)
    expect(describeCameraError(domError('SecurityError')).message).toBe(MESSAGE_NOT_ALLOWED)
  })

  it('signale l’absence de caméra', () => {
    expect(describeCameraError(domError('NotFoundError')).message).toBe(MESSAGE_NOT_FOUND)
    expect(describeCameraError({ name: 'DevicesNotFoundError' }).message).toBe(MESSAGE_NOT_FOUND)
  })

  it('signale une caméra déjà utilisée pour NotReadableError et AbortError', () => {
    expect(describeCameraError(domError('NotReadableError')).message).toBe(MESSAGE_NOT_READABLE)
    expect(describeCameraError(domError('AbortError')).message).toBe(MESSAGE_NOT_READABLE)
    expect(describeCameraError({ name: 'TrackStartError' }).message).toBe(MESSAGE_NOT_READABLE)
  })

  it('signale des réglages non pris en charge après OverconstrainedError', () => {
    expect(describeCameraError(domError('OverconstrainedError')).message).toBe(MESSAGE_OVERCONSTRAINED)
    expect(describeCameraError({ name: 'ConstraintNotSatisfiedError' }).message).toBe(MESSAGE_OVERCONSTRAINED)
  })

  it('signale un navigateur sans accès caméra', () => {
    expect(describeCameraError(new CameraUnsupportedError()).message).toBe(MESSAGE_UNSUPPORTED)
  })

  it('retombe sur un message générique avec le détail technique', () => {
    const description = describeCameraError(new TypeError('Cannot read properties of undefined'))
    expect(description.message).toBe(MESSAGE_GENERIC)
    expect(description.technical).toBe('TypeError : Cannot read properties of undefined')
  })

  it('gère les valeurs non typées', () => {
    expect(describeCameraError('boom')).toEqual({ message: MESSAGE_GENERIC, technical: 'boom' })
    expect(describeCameraError(null)).toEqual({ message: MESSAGE_GENERIC, technical: null })
    expect(describeCameraError(42)).toEqual({ message: MESSAGE_GENERIC, technical: null })
  })
})

describe('formatCameraErrorLabel', () => {
  it('ajoute le détail technique entre parenthèses uniquement s’il existe', () => {
    expect(formatCameraErrorLabel(domError('NotAllowedError'))).toBe(MESSAGE_NOT_ALLOWED)
    expect(formatCameraErrorLabel(new RangeError('x'))).toBe(`${MESSAGE_GENERIC} (RangeError : x)`)
  })
})

describe('helpers', () => {
  it('extrait le nom d’une erreur', () => {
    expect(getErrorName(domError('NotFoundError'))).toBe('NotFoundError')
    expect(getErrorName({ name: '  Custom ' })).toBe('Custom')
    expect(getErrorName({ name: 12 })).toBeNull()
    expect(getErrorName(undefined)).toBeNull()
  })

  it('reconnaît les deux noms d’OverconstrainedError', () => {
    expect(isOverconstrainedError(domError('OverconstrainedError'))).toBe(true)
    expect(isOverconstrainedError({ name: 'ConstraintNotSatisfiedError' })).toBe(true)
    expect(isOverconstrainedError(domError('NotAllowedError'))).toBe(false)
  })
})
