import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadFile, extractFileName } from './download'

describe('extractFileName', () => {
  it('préfère le nom encodé (filename*)', () => {
    expect(
      extractFileName("attachment; filename=import.csv; filename*=UTF-8''import-stock-MTP-cineboutique-montpellier-20261219.csv", 'secours.csv'),
    ).toBe('import-stock-MTP-cineboutique-montpellier-20261219.csv')
  })

  it('lit le nom simple, avec ou sans guillemets', () => {
    expect(extractFileName('attachment; filename="recap.xlsx"', 'secours.xlsx')).toBe('recap.xlsx')
    expect(extractFileName('attachment; filename=recap.xlsx', 'secours.xlsx')).toBe('recap.xlsx')
  })

  it('retombe sur le nom de secours', () => {
    expect(extractFileName(null, 'secours.csv')).toBe('secours.csv')
    expect(extractFileName('attachment', 'secours.csv')).toBe('secours.csv')
  })
})

describe('downloadFile', () => {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:export')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    vi.restoreAllMocks()
  })

  it('télécharge le fichier sous le nom annoncé par l’API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('office;item_id;loc_total_invent;locd_trans_date;locd_trans_cost\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': "attachment; filename*=UTF-8''import-stock-MTP.csv",
        },
      }),
    )
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const fileName = await downloadFile('/api/shops/shop-1/reports/inventory/stock-import.csv', 'import-stock.csv')

    expect(fileName).toBe('import-stock-MTP.csv')
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/shops/shop-1/reports/inventory/stock-import.csv',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('remonte le message de l’API quand le fichier est refusé', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: 'Inventaire non terminé',
          detail: 'Le fichier d’import MCS sera disponible quand l’inventaire sera terminé. Comptages 1 et 2 à terminer : E01 (C2).',
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    )

    await expect(downloadFile('/api/shops/shop-1/reports/inventory/stock-import.csv', 'import-stock.csv')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('E01 (C2)'),
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('donne un message lisible quand la réponse d’erreur n’est pas du JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))

    await expect(downloadFile('/api/x', 'x.csv')).rejects.toMatchObject({
      status: 502,
      message: 'Téléchargement impossible (HTTP 502).',
    })
  })
})
