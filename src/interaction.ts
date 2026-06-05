import * as THREE from 'three'
import type { CharacterController } from './character'
import type { FurnitureManager } from './furniture'


/** Distance the avatar must close to engage an interactive piece. */
const ENGAGE_MARGIN = 0.45

/** How far onto the cushion a 'sit' anchor is nudged from the piece centre. */
const SIT_OFFSET = 0.18

/**
 * Per-frame coordinator that links the placed furniture to the avatar:
 *
 *  - feeds the avatar the furniture footprints as collision obstacles so it
 *    can't walk through pieces, and
 *  - when the avatar comes to rest near an interactive piece (a chair, sofa,
 *    bed or table) it settles the avatar onto it — sitting on seats, lying on
 *    beds / tables. The pose persists until the user taps elsewhere or picks an
 *    animation (both clear the seated state inside the CharacterController).
 *
 * The viewer drives the avatar's own render loop privately, so this runs its
 * own requestAnimationFrame loop purely for the coordination logic; it never
 * renders and never advances the mixer.
 */
export class InteractionCoordinator {
  private readonly character: CharacterController
  private readonly furniture: FurnitureManager
  private readonly anchor = new THREE.Vector3()
  private running = false
  private frame = 0

  constructor (character: CharacterController, furniture: FurnitureManager) {
    this.character = character
    this.furniture = furniture
  }

  start (): void {
    if (this.running)
      return
    this.running = true
    this.frame   = requestAnimationFrame(this.tick)
  }

  stop (): void {
    this.running = false
    cancelAnimationFrame(this.frame)
  }

  private readonly tick = () => {
    if (!this.running)
      return
    this.step()
    this.frame = requestAnimationFrame(this.tick)
  }

  private step (): void {
    // Always keep the avatar's collision set in sync with the placed pieces.
    this.character.setObstacles(this.furniture.obstacles())

    // Only engage when the avatar is at rest, free, and actually present.
    if (!this.character.hasModel || this.character.isMoving || this.character.isInteracting())
      return

    const target = this.nearest()
    if (!target)
      return

    // Piece-forward in the steering convention (atan2(dx, dz)): +Z at yaw 0.
    const forwardX = Math.sin(target.rotationY)
    const forwardZ = Math.cos(target.rotationY)

    if (target.type === 'sit') {
      // A seated avatar faces the same way the seat faces (away from the back)
      // and lands slightly forward of the centre, onto the cushion.
      const facingYaw = target.faceOut ? target.rotationY : target.rotationY + Math.PI
      this.anchor.set(
        target.x + forwardX * SIT_OFFSET,
        0,
        target.z + forwardZ * SIT_OFFSET,
      )
      this.character.sitAt(this.anchor, facingYaw, target.seatHeight)
    }
    else {
      // Lie flat on the piece centre, oriented along the piece.
      this.anchor.set(target.x, 0, target.z)
      this.character.lieAt(this.anchor, target.rotationY, target.seatHeight)
    }
  }

  /** The closest interactive piece within its engage radius, or null. */
  private nearest (): ReturnType<FurnitureManager['interactables']>[number] | null {
    const position = this.character.position
    let best:        ReturnType<FurnitureManager['interactables']>[number] | null = null
    let bestDistance                                                              = Infinity

    for (const piece of this.furniture.interactables()) {
      const distance = Math.hypot(piece.x - position.x, piece.z - position.z)
      const engage   = piece.footprint + ENGAGE_MARGIN
      if (distance < engage && distance < bestDistance) {
        best         = piece
        bestDistance = distance
      }
    }

    return best
  }
}
