import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { retargetBVHToVRM } from './character'
import type { BVHResult } from './character'
import type { VRM } from '@pixiv/three-vrm'

/**
 * Unit tests for the VRM0 BVH retarget fix.
 *
 * VRM 0.0 humanoid bones are authored facing -Z while VRM 1.0 / the BVH pack
 * face +Z, so every VRM0 bone-local rotation must be mirrored across the Y axis
 * (conjugated by a 180° Y rotation, which negates the quaternion's x and z).
 * Without this the limbs splay — the bug these tests lock down. VRM1 rigs must
 * be left untouched. This mirrors what three-vrm's createVRMAnimationClip does
 * internally for `.vrma` clips.
 */

const QUAT = [ 0.1, 0.2, 0.3, 0.927 ] // [x, y, z, w]
const POS  = [ 1, 2, 3 ] // hips [x, y, z]

/** Minimal BVH stand-in: one hips bone with a rotation + translation track. */
function makeBVH (): BVHResult {
  const hips = new THREE.Bone()
  hips.name  = 'hips' // rest position is (0,0,0) → restHipsY falls back to 1
  return {
    skeleton: new THREE.Skeleton([ hips ]),
    clip:     new THREE.AnimationClip('test', 1, [
      new THREE.QuaternionKeyframeTrack('hips.quaternion', [ 0 ], [ ...QUAT ]),
      new THREE.VectorKeyframeTrack('hips.position', [ 0 ], [ ...POS ]),
    ]),
  }
}

/** Minimal VRM stand-in exposing only what retargetBVHToVRM reads. */
function makeVRM (metaVersion: '0' | '1'): VRM {
  return {
    meta:     { metaVersion },
    humanoid: {
      getNormalizedBoneNode: (name: string) => ({ name: `norm_${name}` }),
      normalizedRestPose:    { hips: { position: [ 0, 1, 0 ]}}, // hipScale = 1/1 = 1
    },
  } as unknown as VRM
}

function track (clip: THREE.AnimationClip, name: string): number[] {
  return Array.from(clip.tracks.find(t => t.name === name)!.values)
}

describe('retargetBVHToVRM — VRM0 facing correction', () => {
  it('mirrors VRM0 bone rotations across Y (negates x and z)', () => {
    const clip = retargetBVHToVRM(makeBVH(), makeVRM('0'))
    const rot  = track(clip, 'norm_hips.quaternion')
    expect(rot[0]).toBeCloseTo(-QUAT[0], 5) // x negated
    expect(rot[1]).toBeCloseTo(QUAT[1], 5) // y kept
    expect(rot[2]).toBeCloseTo(-QUAT[2], 5) // z negated
    expect(rot[3]).toBeCloseTo(QUAT[3], 5) // w kept
  })

  it('mirrors VRM0 hips translation across Y (negates x and z, keeps y)', () => {
    const clip = retargetBVHToVRM(makeBVH(), makeVRM('0'))
    const pos  = track(clip, 'norm_hips.position')
    expect(pos[0]).toBeCloseTo(-POS[0], 5)
    expect(pos[1]).toBeCloseTo(POS[1], 5)
    expect(pos[2]).toBeCloseTo(-POS[2], 5)
  })

  it('leaves VRM1 rotations and translation untouched', () => {
    const clip = retargetBVHToVRM(makeBVH(), makeVRM('1'))
    expect(track(clip, 'norm_hips.quaternion')).toEqual(QUAT.map(v => Math.fround(v)))
    expect(track(clip, 'norm_hips.position')).toEqual(POS.map(v => Math.fround(v)))
  })

  it('the (-x, y, -z, w) mirror equals conjugation by a 180° Y rotation', () => {
    const yaw  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
    const base = new THREE.Quaternion(QUAT[0], QUAT[1], QUAT[2], QUAT[3]).normalize()
    const conj = yaw.clone().multiply(base)
      .multiply(yaw.clone().invert())
    expect(conj.x).toBeCloseTo(-base.x, 5)
    expect(conj.y).toBeCloseTo(base.y, 5)
    expect(conj.z).toBeCloseTo(-base.z, 5)
    expect(conj.w).toBeCloseTo(base.w, 5)
  })
})
