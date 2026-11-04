import { z } from 'zod'

import { API_BASE } from '@/lib/api/config'
import http from '@/lib/api/http'
import type { Shop, ShopKind } from '@/types/shop'

const ShopKindSchema = z.enum(['boutique', 'lumiere', 'camera'])

const ShopSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: ShopKindSchema,
  officeCode: z.string().nullish(),
})

const ShopsSchema = z.array(ShopSchema)

export type FetchShopsOptions = {
  signal?: AbortSignal
  kind?: ShopKind
}

export const fetchShops = async ({ signal, kind }: FetchShopsOptions = {}): Promise<Shop[]> => {
  const params = new URLSearchParams()
  if (kind) {
    params.set('kind', kind)
  }

  const query = params.toString()
  const url = query ? `${API_BASE}/shops?${query}` : `${API_BASE}/shops`

  const data = await http(url, { signal })
  const parsed = ShopsSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error('Format de boutiques invalide')
  }
  return parsed.data
}
