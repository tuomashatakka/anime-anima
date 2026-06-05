import type { AnimationEntry, Locomotion, Stance } from './types'
import { STANCE_LEVEL } from './types'

/**
 * Indexes the classified animation catalog and answers the queries the pose
 * state machine needs: idle pools per stance, locomotion clips, and the best
 * transition animation between two stances.
 */
export class AnimationLibrary {
  private readonly idleByStance = new Map<Stance, AnimationEntry[]>()
  private readonly locomotionByType = new Map<Locomotion, AnimationEntry>()
  private readonly transitions: AnimationEntry[] = []

  constructor (private readonly animations: AnimationEntry[]) {
    for (const entry of animations) {
      const meta = entry.meta
      if (!meta)
        continue

      if (meta.category === 'idle') {
        const pool = this.idleByStance.get(meta.stance) ?? []
        pool.push(entry)
        this.idleByStance.set(meta.stance, pool)
      }

      if (meta.locomotion && !this.locomotionByType.has(meta.locomotion))
        this.locomotionByType.set(meta.locomotion, entry)

      if (meta.isTransition)
        this.transitions.push(entry)
    }
  }

  /** Idle clips for a stance, falling back to standing, then any loopable clip. */
  idles (stance: Stance): AnimationEntry[] {
    const direct = this.idleByStance.get(stance)
    if (direct?.length)
      return direct
    if (stance !== 'standing') {
      const standing = this.idleByStance.get('standing')
      if (standing?.length)
        return standing
    }
    return this.animations.filter(entry => entry.meta?.loopable && entry.meta.stance === stance)
  }

  locomotion (type: Locomotion): AnimationEntry | null {
    return this.locomotionByType.get(type) ?? null
  }

  /**
   * Best transition animation to get from one stance to another, or null for a
   * direct crossfade. Going up to standing reuses any "stand up"; going down
   * from standing uses the matching descent (crouch/laydown).
   */
  findTransition (from: Stance, to: Stance): AnimationEntry | null {
    if (from === to)
      return null

    const exact = this.transitions.find(entry => entry.meta!.startStance === from && entry.meta!.endStance === to)
    if (exact)
      return exact

    const goingUp = STANCE_LEVEL[to] > STANCE_LEVEL[from]
    if (goingUp && to === 'standing')
      return this.transitions.find(entry => entry.meta!.endStance === 'standing') ?? null
    if (!goingUp && from === 'standing')
      return this.transitions.find(entry => entry.meta!.startStance === 'standing' && entry.meta!.endStance === to) ?? null

    return null
  }
}
