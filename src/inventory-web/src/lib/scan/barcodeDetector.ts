import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

/**
 * Pipeline de détection unique pour l’application.
 *
 * - Si le navigateur expose un `BarcodeDetector` natif qui annonce tous les formats
 *   demandés (Chrome Android), on l’utilise : il est rapide et gratuit en bande passante.
 * - Sinon (Safari iOS, Firefox, Chrome sans Google Play Services…), on charge le
 *   ponyfill `barcode-detector` qui s’appuie sur ZXing-C++ compilé en WebAssembly.
 *   Le binaire `.wasm` est servi par l’application elle-même (import Vite `?url`),
 *   jamais depuis un CDN : les téléphones de la boutique n’ont pas accès à Internet.
 */

export type SupportedFormat = 'EAN_13' | 'EAN_8' | 'CODE_128' | 'CODE_39' | 'ITF' | 'QR_CODE'
export type DetectorFormat = 'ean_13' | 'ean_8' | 'code_128' | 'code_39' | 'itf' | 'qr_code'
export type DetectorEngine = 'native' | 'wasm'

export type DetectedCode = {
  rawValue: string
  format?: string
}

export interface ScanDetector {
  readonly engine: DetectorEngine
  detect: (source: ImageBitmapSource) => Promise<DetectedCode[]>
}

export const DEFAULT_FORMATS: readonly SupportedFormat[] = [
  'EAN_13',
  'EAN_8',
  'CODE_128',
  'CODE_39',
  'ITF',
  'QR_CODE',
]

export const DETECTOR_FORMATS: Record<SupportedFormat, DetectorFormat> = {
  EAN_13: 'ean_13',
  EAN_8: 'ean_8',
  CODE_128: 'code_128',
  CODE_39: 'code_39',
  ITF: 'itf',
  QR_CODE: 'qr_code',
}

/** Largeur maximale (en px) d’une photo envoyée au décodeur : au-delà on la réduit. */
const MAX_PHOTO_DIMENSION = 1600

export const normalizeFormats = (formats?: readonly SupportedFormat[]): SupportedFormat[] => {
  const source = formats && formats.length > 0 ? formats : DEFAULT_FORMATS
  return Array.from(new Set(source))
}

export const toDetectorFormats = (formats: readonly SupportedFormat[]): DetectorFormat[] =>
  formats.map((format) => DETECTOR_FORMATS[format])

type NativeDetectorConstructor = NonNullable<Window['BarcodeDetector']>

const getNativeConstructor = (): NativeDetectorConstructor | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const ctor = window.BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

/**
 * Le détecteur natif n’est retenu que s’il annonce explicitement tous les formats
 * demandés. Sans `getSupportedFormats` (ou si la liste est vide, cas de Chrome sans
 * services Google), on préfère l’implémentation WebAssembly, déterministe.
 */
export const nativeDetectorSupports = async (
  ctor: NativeDetectorConstructor,
  formats: readonly DetectorFormat[],
): Promise<boolean> => {
  if (typeof ctor.getSupportedFormats !== 'function') {
    return false
  }
  try {
    const supported = new Set(await ctor.getSupportedFormats())
    return formats.every((format) => supported.has(format))
  } catch {
    return false
  }
}

type WasmModule = typeof import('barcode-detector/ponyfill')

let wasmModulePromise: Promise<WasmModule> | null = null

const loadWasmModule = (): Promise<WasmModule> => {
  if (!wasmModulePromise) {
    wasmModulePromise = import('barcode-detector/ponyfill').then(async (mod) => {
      // Instanciation immédiate : le premier `detect()` n’attend pas le téléchargement.
      await mod.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? wasmUrl : `${prefix}${path}`,
        },
        fireImmediately: true,
      })
      return mod
    })
    wasmModulePromise.catch(() => {
      wasmModulePromise = null
    })
  }
  return wasmModulePromise
}

export const createBarcodeDetector = async (
  formats?: readonly SupportedFormat[],
): Promise<ScanDetector> => {
  const detectorFormats = toDetectorFormats(normalizeFormats(formats))
  const nativeCtor = getNativeConstructor()

  if (nativeCtor && (await nativeDetectorSupports(nativeCtor, detectorFormats))) {
    try {
      const native = new nativeCtor({ formats: detectorFormats })
      return {
        engine: 'native',
        detect: (source) => native.detect(source),
      }
    } catch {
      // Constructeur natif défaillant : on bascule sur le wasm.
    }
  }

  const { BarcodeDetector } = await loadWasmModule()
  const wasm = new BarcodeDetector({ formats: detectorFormats })
  return {
    engine: 'wasm',
    detect: (source) => wasm.detect(source),
  }
}

const detectorCache = new Map<string, Promise<ScanDetector>>()

/** Retourne (et mémorise) un détecteur pour cette combinaison de formats. */
export const getBarcodeDetector = (formats?: readonly SupportedFormat[]): Promise<ScanDetector> => {
  const normalized = normalizeFormats(formats)
  const key = normalized.join(',')
  const cached = detectorCache.get(key)
  if (cached) {
    return cached
  }
  const created = createBarcodeDetector(normalized)
  detectorCache.set(key, created)
  created.catch(() => {
    detectorCache.delete(key)
  })
  return created
}

/** Réservé aux tests : vide le cache de détecteurs. */
export const resetBarcodeDetectorCache = () => {
  detectorCache.clear()
  wasmModulePromise = null
}

const downscaleBitmap = (bitmap: ImageBitmap): ImageBitmapSource => {
  const largest = Math.max(bitmap.width, bitmap.height)
  if (!largest || largest <= MAX_PHOTO_DIMENSION) {
    return bitmap
  }
  const scale = MAX_PHOTO_DIMENSION / largest
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      return bitmap
    }
    context.drawImage(bitmap, 0, 0, width, height)
    return canvas
  } catch {
    return bitmap
  }
}

/**
 * Décode une photo (prise via `<input type="file" capture>`) avec le même détecteur
 * que le flux vidéo. Retourne la première valeur lue, ou `null`.
 */
export const decodeBarcodeFromFile = async (
  file: Blob,
  formats?: readonly SupportedFormat[],
): Promise<string | null> => {
  const detector = await getBarcodeDetector(formats)
  let bitmap: ImageBitmap | null = null
  let source: ImageBitmapSource = file
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file)
      source = downscaleBitmap(bitmap)
    } catch {
      source = file
    }
  }
  try {
    const results = await detector.detect(source)
    const match = results.find((result) => result.rawValue && result.rawValue.trim())
    return match ? match.rawValue.trim() : null
  } finally {
    bitmap?.close?.()
  }
}
