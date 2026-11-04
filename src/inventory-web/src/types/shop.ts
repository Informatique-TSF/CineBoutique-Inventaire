export type ShopKind = 'boutique' | 'lumiere' | 'camera'

export type Shop = {
  id: string
  name: string
  kind: ShopKind
  /** Code « office » MCS utilisé dans le fichier d'import de stock (ex. MTP). */
  officeCode?: string | null
}
