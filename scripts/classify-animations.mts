#!/usr/bin/env node
/**
 * classify-animations.mts
 *
 * Programmatically classifies every animation in the asset pack into a pose
 * "stance" (standing / crouching / sitting / lying), detects stance transitions
 * (e.g. stand→crouch, sit→stand), locomotion type (walk/jog/run/crawl) and
 * whether the clip loops smoothly, then writes the result to
 *   public/vrm-assets/classification.json
 *
 * BVH clips are analysed with forward kinematics on their skeleton (the pack's
 * BVH joints use VRM humanoid names). The hips height relative to the rest pose
 * plus torso "uprightness" (how vertical the hips→head vector is) determine the
 * stance at the start and end of the clip. Filenames refine the result.
 *
 * VRMA clips are classified from their filename only (all are standing gestures).
 *
 * Usage: node scripts/classify-animations.mts   (Node >= 22, run from repo root)
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'

// #region Types

type Stance = 'standing' | 'crouching' | 'sitting' | 'lying'
type Locomotion = 'walk' | 'jog' | 'run' | 'crawl'
type Category = 'locomotion' | 'transition' | 'idle' | 'action'

interface PoseMetrics {
  hipsStartRatio: number
  hipsEndRatio:   number
  hipsMinRatio:   number
  uprightStart:   number
  uprightEnd:     number
  travel:         number
  motion:         number
}

interface Classification {
  url:          string
  name:         string
  kind:         'bvh' | 'vrma'
  stance:       Stance
  startStance:  Stance
  endStance:    Stance
  isTransition: boolean
  loopable:     boolean
  locomotion:   Locomotion | null
  category:     Category
  duration:     number
  metrics?:     PoseMetrics
}

// #endregion

const PUBLIC_ROOT  = 'public'
const MANIFEST     = join(PUBLIC_ROOT, 'vrm-assets', 'manifest.json')
const OUTPUT       = join(PUBLIC_ROOT, 'vrm-assets', 'classification.json')

const STANCE_LEVEL: Record<Stance, number> = { lying: 0, sitting: 1, crouching: 2, standing: 3 }
const LEVEL_STANCE: Stance[]                = [ 'lying', 'sitting', 'crouching', 'standing' ]

// #region Filename hints

function prettify (url: string): string {
  let base = (url.split('/').pop() ?? url).replace(/\.[^.]+$/, '')
  base = base.replace(/^(action_|motion_)/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    .trim()
  return base.replace(/\b\w/g, char => char.toUpperCase())
}

function locomotionFromName (name: string): Locomotion | null {
  const lower = name.toLowerCase()
  if (/\bcrawl/.test(lower))
    return 'crawl'
  if (/\brun\b|sprint/.test(lower))
    return 'run'
  if (/\bjog\b|jogging/.test(lower))
    return 'jog'
  if (/\bwalk/.test(lower))
    return 'walk'
  return null
}

/** A coarse stance guess from the filename, or null when the name is neutral. */
function stanceFromName (name: string): Stance | null {
  const lower = name.toLowerCase()
  if (/\bcrawl|laydown|lay |laying|lying|prone|sleep|situp|pushup|headshot|groinhit/.test(lower))
    return 'lying'
  if (/\bsit\b|sit_|seated/.test(lower))
    return 'sitting'
  if (/kneel|crouch|squat|duck|crunch/.test(lower))
    return 'crouching'
  if (/stand|walk|\bjog|\brun\b|jump|dance|neutral|idle|greet|wave|hello|spin|shoot|peace|pose/.test(lower))
    return 'standing'
  return null
}

// #endregion

// #region BVH forward kinematics

interface SkeletonModel {
  root:  THREE.Bone
  byName: Map<string, THREE.Bone>
}

function buildSkeletonModel (skeleton: THREE.Skeleton): SkeletonModel {
  const byName = new Map<string, THREE.Bone>()
  for (const bone of skeleton.bones)
    byName.set(bone.name, bone)
  const root = byName.get('hips') ?? skeleton.bones[0]
  return { root, byName }
}

/** Apply the clip's pose at the given frame index to the skeleton. */
function applyFrame (clip: THREE.AnimationClip, model: SkeletonModel, frame: number): void {
  for (const track of clip.tracks) {
    const dot      = track.name.lastIndexOf('.')
    const boneName = track.name.slice(0, dot)
    const property = track.name.slice(dot + 1)
    const bone     = model.byName.get(boneName)
    if (!bone)
      continue

    if (property === 'quaternion') {
      const i = Math.min(frame, track.values.length / 4 - 1) * 4
      bone.quaternion.set(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3])
    }
    else if (property === 'position' && boneName === 'hips') {
      const i = Math.min(frame, track.values.length / 3 - 1) * 3
      bone.position.set(track.values[i], track.values[i + 1], track.values[i + 2])
    }
  }
  model.root.updateMatrixWorld(true)
}

const tmpHips = new THREE.Vector3()
const tmpHead = new THREE.Vector3()

interface FramePose {
  hipsY:     number
  upright:   number
  hipsXZ:    THREE.Vector2
}

function readPose (model: SkeletonModel): FramePose {
  const head = model.byName.get('head') ?? model.byName.get('neck')
  model.byName.get('hips')!.getWorldPosition(tmpHips)
  head?.getWorldPosition(tmpHead)

  const dy      = tmpHead.y - tmpHips.y
  const dist    = tmpHips.distanceTo(tmpHead) || 1e-6
  const upright = head ? THREE.MathUtils.clamp(dy / dist, -1, 1) : 1

  return { hipsY: tmpHips.y, upright, hipsXZ: new THREE.Vector2(tmpHips.x, tmpHips.z) }
}

function levelFromPose (hipsRatio: number, upright: number): number {
  if (upright < 0.45)
    return STANCE_LEVEL.lying
  if (hipsRatio >= 0.78)
    return STANCE_LEVEL.standing
  if (hipsRatio >= 0.52)
    return STANCE_LEVEL.crouching
  return STANCE_LEVEL.sitting
}

/**
 * Explicit postural transitions, keyed by filename. The pack only has a handful;
 * naming them is far more reliable than inferring direction from noisy frame-0
 * poses. The starting stance of "stand up" is refined from the pose.
 */
function transitionFromName (name: string, startUpright: number, startRatio: number): { from: Stance, to: Stance } | null {
  const lower = name.toLowerCase()
  if (/stand ?up|get ?up/.test(lower)) {
    const from: Stance = startUpright < 0.45 || startRatio < 0.32 ? 'lying' : 'sitting'
    return { from, to: 'standing' }
  }
  if (/lay ?down|lie ?down/.test(lower))
    return { from: 'standing', to: 'lying' }
  if (/sit ?down/.test(lower))
    return { from: 'standing', to: 'sitting' }
  if (/kneel ?down/.test(lower))
    return { from: 'standing', to: 'crouching' }
  if (/^crouch$|squat down/.test(lower))
    return { from: 'standing', to: 'crouching' }
  return null
}

// #endregion

// #region Analysis

function frameCount (clip: THREE.AnimationClip): number {
  let max = 0
  for (const track of clip.tracks)
    max = Math.max(max, track.times.length)
  return max
}

function analyseBVH (clip: THREE.AnimationClip, skeleton: THREE.Skeleton): PoseMetrics {
  const model  = buildSkeletonModel(skeleton)

  // Rest pose (identity rotations as parsed) gives the standing hip height.
  model.root.updateMatrixWorld(true)
  const restHipsY = readPose(model).hipsY || 1

  const frames = frameCount(clip)
  const last   = Math.max(0, frames - 1)
  const samples = 16

  applyFrame(clip, model, 0)
  const start = readPose(model)
  applyFrame(clip, model, last)
  const end = readPose(model)

  let hipsMin = Math.min(start.hipsY, end.hipsY)
  const xzMin = new THREE.Vector2(Infinity, Infinity)
  const xzMax = new THREE.Vector2(-Infinity, -Infinity)
  let motion  = 0
  let prev: FramePose | null = null

  for (let s = 0; s <= samples; s++) {
    const frame = Math.round((s / samples) * last)
    applyFrame(clip, model, frame)
    const pose = readPose(model)
    hipsMin = Math.min(hipsMin, pose.hipsY)
    xzMin.min(pose.hipsXZ)
    xzMax.max(pose.hipsXZ)
    if (prev)
      motion += Math.abs(pose.hipsY - prev.hipsY) + pose.hipsXZ.distanceTo(prev.hipsXZ)
    prev = pose
  }

  const travel = xzMax.distanceTo(xzMin)

  return {
    hipsStartRatio: start.hipsY / restHipsY,
    hipsEndRatio:   end.hipsY / restHipsY,
    hipsMinRatio:   hipsMin / restHipsY,
    uprightStart:   start.upright,
    uprightEnd:     end.upright,
    travel:         travel / restHipsY,
    motion:         motion / restHipsY,
  }
}

function classifyBVH (url: string, clip: THREE.AnimationClip, skeleton: THREE.Skeleton): Classification {
  const name    = prettify(url)
  const lower   = name.toLowerCase()
  const metrics = analyseBVH(clip, skeleton)

  const locomotion = locomotionFromName(name)
  const transition = transitionFromName(name, metrics.uprightStart, metrics.hipsStartRatio)

  // Does the clip end where it began? (Used to decide whether it can loop.)
  const poseDelta = Math.abs(metrics.hipsStartRatio - metrics.hipsEndRatio)
    + Math.abs(metrics.uprightStart - metrics.uprightEnd)

  let startStance: Stance
  let endStance:   Stance
  let isTransition = false
  let loopable:    boolean
  let category:    Category

  if (locomotion) {
    startStance = endStance = locomotion === 'crawl' ? 'lying' : 'standing'
    loopable    = true
    category    = 'locomotion'
  }
  else if (transition) {
    startStance  = transition.from
    endStance    = transition.to
    isTransition = true
    loopable     = false
    category     = 'transition'
  }
  else {
    // A single-stance clip: trust the filename, fall back to the end pose.
    const stance = stanceFromName(name) ?? LEVEL_STANCE[levelFromPose(metrics.hipsEndRatio, metrics.uprightEnd)]
    startStance  = stance
    endStance    = stance
    loopable     = poseDelta < 0.18
    const idle   = /idle/.test(lower) || (loopable && metrics.motion < 0.6 && /neutral|relax|breath/.test(lower))
    category     = idle ? 'idle' : 'action'
  }

  return {
    url,
    name,
    kind:   'bvh',
    stance: endStance,
    startStance,
    endStance,
    isTransition,
    loopable,
    locomotion,
    category,
    duration: clip.duration,
    metrics,
  }
}

function classifyVRMA (url: string): Classification {
  const name       = prettify(url)
  const stance     = stanceFromName(name) ?? 'standing'
  const locomotion = locomotionFromName(name)
  const isIdle     = /idle|pose/.test(name.toLowerCase())
  return {
    url,
    name,
    kind:   'vrma',
    stance,
    startStance: stance,
    endStance:   stance,
    isTransition: false,
    loopable:     isIdle,
    locomotion,
    category:     locomotion ? 'locomotion' : isIdle ? 'idle' : 'action',
    duration:     0,
  }
}

// #endregion

async function main () {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
    animations: { vrma: string[], bvh: string[] }
  }

  const seen = new Set<string>()
  const urls = [ ...manifest.animations.vrma ?? [], ...manifest.animations.bvh ?? [] ]
    .filter(url => (seen.has(url) ? false : (seen.add(url), true)))

  const loader = new BVHLoader()
  const results: Classification[] = []

  for (const url of urls) {
    const lower = url.toLowerCase()
    try {
      if (lower.endsWith('.vrma')) {
        results.push(classifyVRMA(url))
      }
      else if (lower.endsWith('.bvh')) {
        const text       = await readFile(join(PUBLIC_ROOT, url), 'utf8')
        const { clip, skeleton } = loader.parse(text)
        results.push(classifyBVH(url, clip, skeleton))
      }
      // .fbx and anything else is ignored.
    }
    catch (error) {
      console.error(`  ✗ ${url}: ${String(error)}`)
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  await writeFile(OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), animations: results }, null, 2))

  // Summary.
  const by = (key: keyof Classification) => results.reduce<Record<string, number>>((acc, item) => {
    const value = String(item[key])
    acc[value] = (acc[value] ?? 0) + 1
    return acc
  }, {})
  console.log(`Classified ${results.length} animations → ${OUTPUT}`)
  console.log('  by category:', by('category'))
  console.log('  by stance:  ', by('stance'))
  console.log('  transitions:', results.filter(r => r.isTransition).map(r => `${r.name} (${r.startStance}→${r.endStance})`).join(', '))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
