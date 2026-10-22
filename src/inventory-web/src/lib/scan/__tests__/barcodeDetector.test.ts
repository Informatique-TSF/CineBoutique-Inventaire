import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wasmMocks = vi.hoisted(() => ({
  prepareZXingModule: vi.fn(() => Promise.resolve({})),
  constructorCalls: [] as unknown[],
  detect: vi.fn<(source: unknown) => Promise<{ rawValue: string }[]>>(async () => []),
}))

vi.mock('barcode-detector/ponyfill', () => {
  class FakeWasmDetector {
    constructor(options: unknown) {
      wasmMocks.constructorCalls.push(options)
    }
    static getSupportedFormats = async () => ['ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code']
    detect = wasmMocks.detect
  }
  return {
    BarcodeDetector: FakeWasmDetector,
    prepareZXingModule: wasmMocks.prepareZXingModule,
  }
})

import {
  DEFAULT_FORMATS,
  createBarcodeDetector,
  decodeBarcodeFromFile,
  getBarcodeDetector,
  nativeDetectorSupports,
  normalizeFormats,
  resetBarcodeDetectorCache,
  toDetectorFormats,
} from '@/lib/scan/barcodeDetector'

type NativeCtor = NonNullable<Window['BarcodeDetector']>

const installNativeDetector = (
  supported: string[] | null,
  detect = vi.fn(async () => [{ rawValue: '3017620422003', format: 'ean_13' }]),
) => {
  const constructorCalls: unknown[] = []
  class FakeNativeDetector {
    constructor(options?: unknown) {
      constructorCalls.push(options)
    }
    detect = detect
  }
  const ctor = FakeNativeDetector as unknown as NativeCtor & { getSupportedFormats?: () => Promise<string[]> }
  if (supported) {
    ctor.getSupportedFormats = async () => supported
  }
  vi.stubGlobal('BarcodeDetector', ctor)
  return { ctor, constructorCalls, detect }
}

beforeEach(() => {
  resetBarcodeDetectorCache()
  wasmMocks.constructorCalls.length = 0
  wasmMocks.prepareZXingModule.mockClear()
  wasmMocks.detect.mockReset()
  wasmMocks.detect.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalisation des formats', () => {
  it('retombe sur les formats par défaut et dédoublonne', () => {
    expect(normalizeFormats(undefined)).toEqual([...DEFAULT_FORMATS])
    expect(normalizeFormats([])).toEqual([...DEFAULT_FORMATS])
    expect(normalizeFormats(['EAN_13', 'EAN_13', 'QR_CODE'])).toEqual(['EAN_13', 'QR_CODE'])
  })

  it('convertit vers les identifiants de la Barcode Detection API', () => {
    expect(toDetectorFormats(['EAN_13', 'CODE_128', 'ITF'])).toEqual(['ean_13', 'code_128', 'itf'])
  })
})

describe('sélection du moteur', () => {
  it('retient le détecteur natif lorsqu’il annonce tous les formats demandés', async () => {
    const native = installNativeDetector(['ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code'])

    const detector = await createBarcodeDetector(['EAN_13', 'QR_CODE'])

    expect(detector.engine).toBe('native')
    expect(native.constructorCalls).toEqual([{ formats: ['ean_13', 'qr_code'] }])
    expect(wasmMocks.constructorCalls).toHaveLength(0)
    expect(wasmMocks.prepareZXingModule).not.toHaveBeenCalled()

    const canvas = document.createElement('canvas')
    await expect(detector.detect(canvas)).resolves.toEqual([{ rawValue: '3017620422003', format: 'ean_13' }])
    expect(native.detect).toHaveBeenCalledWith(canvas)
  })

  it('bascule sur WebAssembly lorsque le natif ne couvre pas les formats', async () => {
    installNativeDetector(['qr_code'])

    const detector = await createBarcodeDetector(['EAN_13', 'EAN_8'])

    expect(detector.engine).toBe('wasm')
    expect(wasmMocks.constructorCalls).toEqual([{ formats: ['ean_13', 'ean_8'] }])
  })

  it('bascule sur WebAssembly sans détecteur natif', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)

    const detector = await createBarcodeDetector()

    expect(detector.engine).toBe('wasm')
    expect(wasmMocks.constructorCalls).toEqual([
      { formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code'] },
    ])
  })

  it('ne fait pas confiance à un natif sans getSupportedFormats', async () => {
    const native = installNativeDetector(null)

    await expect(nativeDetectorSupports(native.ctor, ['ean_13'])).resolves.toBe(false)
    const detector = await createBarcodeDetector(['EAN_13'])
    expect(detector.engine).toBe('wasm')
  })

  it('sert le binaire wasm depuis l’application (pas de CDN) et l’instancie immédiatement', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)

    await createBarcodeDetector(['EAN_13'])

    expect(wasmMocks.prepareZXingModule).toHaveBeenCalledTimes(1)
    const [options] = wasmMocks.prepareZXingModule.mock.calls[0] as unknown as [
      { fireImmediately?: boolean; overrides?: { locateFile?: (path: string, prefix: string) => string } },
    ]
    expect(options.fireImmediately).toBe(true)
    const locateFile = options.overrides?.locateFile
    expect(typeof locateFile).toBe('function')
    const wasmPath = locateFile!('zxing_reader.wasm', 'https://fastly.jsdelivr.net/npm/zxing-wasm@3/dist/reader/')
    expect(wasmPath).toMatch(/zxing_reader[^/]*\.wasm$/)
    expect(wasmPath).not.toMatch(/jsdelivr|unpkg|^https?:\/\//)
    expect(locateFile!('other.js', '/prefix/')).toBe('/prefix/other.js')
  })

  it('met en cache un détecteur par combinaison de formats', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)

    const first = getBarcodeDetector(['EAN_13', 'EAN_8'])
    const second = getBarcodeDetector(['EAN_13', 'EAN_8', 'EAN_13'])
    const third = getBarcodeDetector(['QR_CODE'])

    expect(second).toBe(first)
    expect(third).not.toBe(first)
    await Promise.all([first, third])
    expect(wasmMocks.constructorCalls).toHaveLength(2)
  })
})

describe('decodeBarcodeFromFile', () => {
  it('décode la photo via createImageBitmap et renvoie la première valeur', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)
    const close = vi.fn()
    const bitmap = { width: 800, height: 600, close }
    const createImageBitmapMock = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    wasmMocks.detect.mockResolvedValue([{ rawValue: '  4006381333931 ' }, { rawValue: '000' }])

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })
    const value = await decodeBarcodeFromFile(file, ['EAN_13'])

    expect(value).toBe('4006381333931')
    expect(createImageBitmapMock).toHaveBeenCalledWith(file)
    expect(wasmMocks.detect).toHaveBeenCalledWith(bitmap)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('renvoie null quand aucun code n’est lisible', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() })))
    wasmMocks.detect.mockResolvedValue([])

    await expect(decodeBarcodeFromFile(new Blob(['x']))).resolves.toBeNull()
  })

  it('transmet directement le fichier si createImageBitmap est indisponible', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)
    vi.stubGlobal('createImageBitmap', undefined)
    wasmMocks.detect.mockResolvedValue([{ rawValue: '12345678' }])

    const file = new Blob(['x'], { type: 'image/png' })
    await expect(decodeBarcodeFromFile(file)).resolves.toBe('12345678')
    expect(wasmMocks.detect).toHaveBeenCalledWith(file)
  })
})
