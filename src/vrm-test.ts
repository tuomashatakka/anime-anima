import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'
import { retargetBVHToVRM } from './character'
import type { BVHResult } from './character'

/**
 * Headless parity test: load a VRM0 model and a VRM1 model, apply the SAME
 * animation to both, and at several frames compare where the limbs end up and
 * which way the body faces. Comparison is done from joint WORLD POSITIONS only
 * (no quaternion conventions), so it catches both a 180° facing flip and a
 * left/right mirror. Results render to the page and to window.__vrmTest.
 */

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

const MODELS = {
  vrm1: `${BASE}/vrm-assets/models/Aera.vrm`,
  vrm0: `${BASE}/vrm-assets/models/Ella Rosa.vrm`,
}

interface AnimSpec { name: string, kind: 'vrma' | 'bvh', url: string }

const ANIMATIONS: AnimSpec[] = [
  { name: 'Shoot (vrma)', kind: 'vrma', url: `${BASE}/vrm-assets/animations/vrma/shoot.vrma` },
  { name: 'Joy (bvh)', kind: 'bvh', url: `${BASE}/vrm-assets/animations/bvh/joy.bvh` },
  { name: 'Crouch (bvh)', kind: 'bvh', url: `${BASE}/vrm-assets/animations/bvh/action_crouch.bvh` },
  { name: 'Kneel (bvh)', kind: 'bvh', url: `${BASE}/vrm-assets/animations/bvh/kneel_idle.bvh` },
]

const SAMPLE_FRACTIONS = [ 0, 0.25, 0.5, 0.75 ]

/** Bones whose world position we sample. */
const BONES: VRMHumanBoneName[] = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
]

/** Parent→child bone segments whose WORLD direction we compare across rigs. */
const SEGMENTS: [VRMHumanBoneName, VRMHumanBoneName][] = [
  [ 'hips', 'spine' ], [ 'spine', 'chest' ], [ 'chest', 'neck' ], [ 'neck', 'head' ],
  [ 'chest', 'leftUpperArm' ], [ 'leftUpperArm', 'leftLowerArm' ], [ 'leftLowerArm', 'leftHand' ],
  [ 'chest', 'rightUpperArm' ], [ 'rightUpperArm', 'rightLowerArm' ], [ 'rightLowerArm', 'rightHand' ],
  [ 'hips', 'leftUpperLeg' ], [ 'leftUpperLeg', 'leftLowerLeg' ], [ 'leftLowerLeg', 'leftFoot' ],
  [ 'hips', 'rightUpperLeg' ], [ 'rightUpperLeg', 'rightLowerLeg' ], [ 'rightLowerLeg', 'rightFoot' ],
]

/** PASS thresholds. */
const MAX_FACING_DEG = 18
const MAX_JOINT_DEG  = 12 // per-segment world-direction difference (degrees)

const out = document.getElementById('out')!

interface Sampled {

  /** Bone world positions keyed by bone name. */
  pos: Map<VRMHumanBoneName, THREE.Vector3>

  /** Geometry-derived body frame (all unit, horizontal forward/right). */
  right:   THREE.Vector3
  up:      THREE.Vector3
  forward: THREE.Vector3
}

async function loadVRM (url: string): Promise<VRM> {
  const loader = new GLTFLoader()
  loader.register(parser => new VRMLoaderPlugin(parser))

  const gltf = await loader.loadAsync(url)
  const vrm  = gltf.userData.vrm as VRM
  // Mirror the app's load step: face VRM0 the same way as VRM1 (+Z).
  VRMUtils.rotateVRM0(vrm)
  return vrm
}

async function buildClip (spec: AnimSpec, vrm: VRM): Promise<THREE.AnimationClip> {
  if (spec.kind === 'vrma') {
    const loader = new GLTFLoader()
    loader.register(parser => new VRMAnimationLoaderPlugin(parser))

    const gltf = await loader.loadAsync(spec.url)
    const anim = (gltf.userData.vrmAnimations as { length: number }[])?.[0]
    return createVRMAnimationClip(anim as never, vrm)
  }

  const bvh = await new BVHLoader().loadAsync(spec.url) as BVHResult
  return retargetBVHToVRM(bvh, vrm)
}

function boneNode (vrm: VRM, name: VRMHumanBoneName): THREE.Object3D | null {
  return vrm.humanoid.getRawBoneNode(name) ?? vrm.humanoid.getNormalizedBoneNode(name)
}

function sample (vrm: VRM): Sampled {
  vrm.scene.updateMatrixWorld(true)

  const pos = new Map<VRMHumanBoneName, THREE.Vector3>()
  for (const bone of BONES) {
    const node = boneNode(vrm, bone)
    if (node)
      pos.set(bone, node.getWorldPosition(new THREE.Vector3()))
  }

  const hips = pos.get('hips')!
  const head = pos.get('head') ?? pos.get('neck')!
  const up   = head.clone().sub(hips)
    .normalize()
  // Right = from left hip to right hip (model's own right side).
  const right = pos.get('rightUpperLeg')!.clone().sub(pos.get('leftUpperLeg')!)
    .normalize()
  // Forward = right × up, flattened to horizontal.
  const forward = new THREE.Vector3().crossVectors(right, up)
  forward.y     = 0
  forward.normalize()

  return { pos, right, up, forward }
}

/** Sample a model at a fraction of the clip, returning the body geometry. */
function sampleAt (vrm: VRM, mixer: THREE.AnimationMixer, time: number): Sampled {
  mixer.setTime(time)
  vrm.update(0)
  return sample(vrm)
}

interface BoneRow { bone: string, jointDeg: number }
interface AnimResult {
  name:        string
  facingDeg:   number
  maxJointDeg: number
  worstBone:   string
  rows:        BoneRow[]
  pass:        boolean
}

type CompareFrameReturnType = { facingDeg: number, rows: BoneRow[] }

function compareFrame (a: Sampled, b: Sampled): CompareFrameReturnType {
  const facingDeg = THREE.MathUtils.radToDeg(a.forward.angleTo(b.forward))

  // Bone-segment WORLD directions: each limb segment must point the same way in
  // the world on both rigs. This is proportion-independent (directions, not
  // positions) and representation-independent (works regardless of how the clip
  // encodes the bone-local rotation), so it captures genuine pose + facing errors.
  const rows: BoneRow[] = []
  for (const [ parent, child ] of SEGMENTS) {
    const pa = a.pos.get(parent),
      ca     = a.pos.get(child)
    const pb = b.pos.get(parent),
      cb     = b.pos.get(child)
    if (pa && ca && pb && cb) {
      const da = ca.clone().sub(pa)
        .normalize()
      const db = cb.clone().sub(pb)
        .normalize()
      rows.push({ bone: `${parent}→${child}`, jointDeg: THREE.MathUtils.radToDeg(da.angleTo(db)) })
    }
  }
  return { facingDeg, rows }
}

async function runAnimation (spec: AnimSpec, vrm1: VRM, vrm0: VRM): Promise<AnimResult> {
  const clip1  = await buildClip(spec, vrm1)
  const clip0  = await buildClip(spec, vrm0)
  const mixer1 = new THREE.AnimationMixer(vrm1.scene)
  const mixer0 = new THREE.AnimationMixer(vrm0.scene)
  mixer1.clipAction(clip1).play()
  mixer0.clipAction(clip0).play()

  const duration = Math.min(clip1.duration, clip0.duration) || 1
  let facingDeg   = 0
  let maxJointDeg = 0
  let worstBone   = ''
  const agg        = new Map<string, number>()

  for (const frac of SAMPLE_FRACTIONS) {
    const t                       = frac * duration
    const s1                      = sampleAt(vrm1, mixer1, t)
    const s0                      = sampleAt(vrm0, mixer0, t)
    const { facingDeg: fd, rows } = compareFrame(s1, s0)
    facingDeg = Math.max(facingDeg, fd)
    for (const row of rows) {
      agg.set(row.bone, Math.max(agg.get(row.bone) ?? 0, row.jointDeg))
      if (row.jointDeg > maxJointDeg) {
        maxJointDeg = row.jointDeg
        worstBone   = row.bone
      }
    }
  }

  const rows = [ ...agg.entries() ].map(([ bone, jointDeg ]) => ({ bone, jointDeg }))
  const pass = facingDeg <= MAX_FACING_DEG && maxJointDeg <= MAX_JOINT_DEG
  return { name: spec.name, facingDeg, maxJointDeg, worstBone, rows, pass }
}

function render (results: AnimResult[]): void {
  const overall = results.every(r => r.pass)
  let html = `<div class="summary ${overall ? 'pass' : 'fail'}">OVERALL: ${overall ? 'PASS' : 'FAIL'} — VRM0 ${overall ? 'matches' : 'DIVERGES FROM'} VRM1</div>`
  for (const r of results) {
    html += `<h2 class="${r.pass ? 'pass' : 'fail'}">${r.name}: ${r.pass ? 'PASS' : 'FAIL'} `
    html += `(facing Δ ${r.facingDeg.toFixed(1)}°, worst joint Δ ${r.maxJointDeg.toFixed(1)}° @ ${r.worstBone})</h2>`
    html += '<table><tr><th>bone</th><th>joint Δ (deg)</th></tr>'
    for (const row of r.rows.sort((x, y) => y.jointDeg - x.jointDeg))
      html += `<tr class="${row.jointDeg > MAX_JOINT_DEG ? 'fail' : 'pass'}"><td>${row.bone}</td><td>${row.jointDeg.toFixed(1)}</td></tr>`
    html += '</table>'
  }
  out.innerHTML = html
}

async function main (): Promise<void> {
  try {
    const [ vrm1, vrm0 ]        = await Promise.all([ loadVRM(MODELS.vrm1), loadVRM(MODELS.vrm0) ])
    const results: AnimResult[] = []
    for (const spec of ANIMATIONS)
      results.push(await runAnimation(spec, vrm1, vrm0))

    render(results)

    // Diagnostic: dump rest rotations + a post-Joy normalized local rotation so
    // we can see WHY the BVH poses diverge between the two rig versions.
    const probe = [ 'leftUpperArm', 'leftLowerArm', 'leftHand' ] as VRMHumanBoneName[]
    const fmt   = (q?: number[] | THREE.Quaternion) => {
      if (!q)
        return null

      const a = Array.isArray(q) ? q : [ q.x, q.y, q.z, q.w ]
      return a.map(n => +n.toFixed(3))
    }
    const dump = (vrm: VRM) => Object.fromEntries(probe.map(b => [ b, {
      normRest:     fmt(vrm.humanoid.normalizedRestPose[b]?.rotation),
      rawRest:      fmt(vrm.humanoid.rawRestPose[b]?.rotation),
      normNodeRest: fmt(vrm.humanoid.getNormalizedBoneNode(b)?.quaternion),
    }]));
    (window as unknown as { __vrmTest: unknown }).__vrmTest = {
      overall: results.every(r => r.pass),
      results: results.map(r => ({ name: r.name, pass: r.pass, facingDeg: +r.facingDeg.toFixed(1), maxJointDeg: +r.maxJointDeg.toFixed(1), worstBone: r.worstBone })),
      debug:   { vrm1: dump(vrm1), vrm0: dump(vrm0) },
    }
  }
  catch (error) {
    out.textContent                                         = `Test error: ${error instanceof Error ? error.message : String(error)}`;
    (window as unknown as { __vrmTest: unknown }).__vrmTest = { error: String(error) }
  }
}

void main()
