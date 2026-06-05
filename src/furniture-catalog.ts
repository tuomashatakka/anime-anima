/**
 * Catalog of placeable furniture, backed by CC0 GLB models from the Kenney
 * "Furniture Kit" (https://kenney.nl/assets/furniture-kit, public domain).
 *
 * The kit is modelled at a "toy" scale that varies per piece, so each entry
 * carries an explicit `scale` tuned to read correctly next to a ~1.6 m VRM
 * avatar. `light: true` pieces get a real spot light source attached on
 * placement (see FurnitureManager.attachLamp).
 */

/**
 * Describes how the avatar uses a piece when it rests next to it. `seatHeight`
 * is the world-space height (metres, after scale) of the surface the avatar
 * settles onto. `faceOut` makes the avatar face the same direction the piece
 * faces (i.e. away from a seat back) rather than toward its centre.
 */
export interface FurnitureInteraction {
  type:       'sit' | 'lie'
  seatHeight: number
  faceOut?:   boolean
}

export interface FurnitureItem {

  /** Stable id (also the loader cache key). */
  id: string

  /** Display name shown in the palette. */
  name: string

  /** GLB filename under public/furniture/. */
  file: string

  /** Emoji glyph used as the palette thumbnail. */
  icon: string

  /** Uniform scale applied at load so the piece reads at human scale. */
  scale: number

  /** Attach a spot light source inside the model when placed (foot lamps). */
  light?: boolean

  /** How the avatar interacts with the piece when resting near it. */
  interaction?: FurnitureInteraction

  /** Collision radius in metres; omit/0 means non-colliding (e.g. the rug). */
  footprint?: number
}

export const FURNITURE_CATALOG: FurnitureItem[] = [
  { id: 'sofa', name: 'Sofa', file: 'loungeSofa.glb', icon: '🛋️', scale: 2.0, footprint: 0.9, interaction: { type: 'sit', seatHeight: 0.42, faceOut: true }},
  { id: 'lounge-chair', name: 'Lounge Chair', file: 'loungeChair.glb', icon: '💺', scale: 2.0, footprint: 0.5, interaction: { type: 'sit', seatHeight: 0.4, faceOut: true }},
  { id: 'armchair', name: 'Armchair', file: 'chairModernCushion.glb', icon: '🪑', scale: 1.9, footprint: 0.5, interaction: { type: 'sit', seatHeight: 0.45, faceOut: true }},
  { id: 'dinner-table', name: 'Dinner Table', file: 'table.glb', icon: '🍽️', scale: 2.2, footprint: 0.8, interaction: { type: 'lie', seatHeight: 0.62 }},
  { id: 'coffee-table', name: 'Coffee Table', file: 'tableCoffee.glb', icon: '☕', scale: 2.0, footprint: 0.6 },
  { id: 'side-table', name: 'Side Table', file: 'sideTable.glb', icon: '🗄️', scale: 1.9, footprint: 0.4 },
  { id: 'bookcase', name: 'Bookcase', file: 'bookcaseOpen.glb', icon: '📚', scale: 2.0, footprint: 0.5 },
  { id: 'tv-stand', name: 'TV Stand', file: 'cabinetTelevision.glb', icon: '🗃️', scale: 2.0, footprint: 0.5 },
  { id: 'television', name: 'Television', file: 'televisionModern.glb', icon: '📺', scale: 2.0, footprint: 0.5 },
  { id: 'bed', name: 'Double Bed', file: 'bedDouble.glb', icon: '🛏️', scale: 1.1, footprint: 1.1, interaction: { type: 'lie', seatHeight: 0.45 }},
  { id: 'stool', name: 'Bar Stool', file: 'stoolBar.glb', icon: '🪑', scale: 1.8, footprint: 0.3, interaction: { type: 'sit', seatHeight: 0.55, faceOut: true }},
  { id: 'plant', name: 'Potted Plant', file: 'pottedPlant.glb', icon: '🪴', scale: 2.0, footprint: 0.3 },
  { id: 'rug', name: 'Round Rug', file: 'rugRound.glb', icon: '🟫', scale: 2.6, footprint: 0 },
  { id: 'foot-lamp', name: 'Foot Lamp', file: 'lampRoundFloor.glb', icon: '💡', scale: 1.8, light: true, footprint: 0.2 },
  { id: 'floor-lamp', name: 'Floor Lamp', file: 'lampSquareFloor.glb', icon: '🔦', scale: 1.8, light: true, footprint: 0.2 },
]
