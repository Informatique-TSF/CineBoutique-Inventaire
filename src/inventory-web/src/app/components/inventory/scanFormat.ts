/** « 1 pièce », « 3 pièces ». */
export const formatPieces = (count: number) => `${count} pièce${count > 1 ? 's' : ''}`
