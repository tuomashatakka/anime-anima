import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import {
  VRMAnimation,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation'
import { AnimationLibrary } from './library'
import type { AnimationEntry, Locomotion, ModelEntry, Stance } from './types'
import { STANCE_LEVEL } from './types'


interface BVHResult {
  clip:     THREE.AnimationClip
  skeleton: THREE.Skeleton
}

interface PlayOptions {
  fade?:       boolean
  transition?: boolean
}

/** A circular obstacle the avatar must not walk through (world XZ + radius). */
export interface Obstacle {
  x:      number
  z:      number
  radius: number
}

/**
 * Ground travel speed (metres / second) for each gait, for a model with ~0.9 m
 * hips. These match the average backward speed of the planted foot in the
 * (in-place) source clips, so the feet do not slide; they are scaled per-model
 * by hip height at load time.
 */
const LOCOMOTION_SPEED: Record<Locomotion, number> = { walk: 0.82, jog: 1.12, run: 2.3, crawl: 0.44 }

/** Hip height (metres) the LOCOMOTION_SPEED values were measured against. */
const REFERENCE_HIP_HEIGHT = 0.9

/** Order gaits escalate through on repeated taps while standing. */
const GAIT_ESCALATION: Record<Locomotion, Locomotion> = { walk: 'jog', jog: 'run', run: 'run', crawl: 'crawl' }

/** The shape of the three.js AnimationMixer "finished" event we care about. */
type MixerFinishedEvent = { action: THREE.AnimationAction }

/**
 * Owns everything VRM-related: loading models, loading animations (both .vrma
 * and .bvh), crossfading between clips, click-to-move locomotion, and a pose
 * state machine (standing / crouching / sitting / lying) that inserts the
 * correct transition animation between stances and plays random idles when
 * nothing is selected.
 *
 * Both animation formats are compiled into AnimationClips that target the VRM's
 * *normalized* humanoid bones, so a single AnimationMixer drives everything.
 */
export class CharacterController {
  private readonly scene: THREE.Scene

  private readonly gltfLoader = new GLTFLoader()
  private readonly vrmaLoader = new GLTFLoader()
  private readonly bvhLoader = new BVHLoader()

  private currentVRM:    VRM | null = null
  private mixer:         THREE.AnimationMixer | null = null
  private currentAction: THREE.AnimationAction | null = null

  /** Raw, model-agnostic animation data, cached after first download. */
  private readonly vrmaCache = new Map<string, VRMAnimation>()
  private readonly bvhCache = new Map<string, BVHResult>()

  private readonly fadeDuration = 0.45

  // Pose state machine
  private library:           AnimationLibrary | null = null
  private currentStance:     Stance = 'standing'
  private selectedAnimation: AnimationEntry | null = null

  /** Called once when the active (one-shot) clip reaches its end. */
  private onFinishCallback: (() => void) | null = null

  private idleMode = false
  private idleSwitching = false
  private idleHold = 0
  private lastIdleUrl: string | null = null

  // Destination marker shown while the model walks toward a tapped point.
  private readonly marker: THREE.Mesh

  /** Yaw applied at load (0 for VRM1, π for VRM0) — the "facing +Z" baseline. */
  private baseYawValue = 0
  private moveTarget:     THREE.Vector3 | null = null
  private moving = false
  private moveLocomotion: Locomotion | null = null
  private moveSpeed = LOCOMOTION_SPEED.walk
  private gaitPlaying = false

  /** Per-model multiplier on gait speeds, derived from hip height. */
  private speedScale = 1
  private readonly locomotionClips = new Map<Locomotion, THREE.AnimationClip>()
  private readonly turnSpeed = 6 // radians / second
  private readonly arriveRadius = 0.06

  /** Circular obstacles the avatar slides around (set externally). */
  private obstacles: Obstacle[] = []

  /** True while the avatar is seated / lying on a piece of furniture. */
  private interacting = false

  constructor (scene: THREE.Scene) {
    this.scene = scene

    this.gltfLoader.register(parser => new VRMLoaderPlugin(parser))
    this.vrmaLoader.register(parser => new VRMAnimationLoaderPlugin(parser))

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.2, 40),
      new THREE.MeshBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    )
    this.marker.rotation.x = -Math.PI / 2
    this.marker.position.y = 0.02
    this.marker.visible    = false
    this.scene.add(this.marker)
  }

  // #region Public accessors

  get object (): THREE.Object3D | null {
    return this.currentVRM?.scene ?? null
  }

  get position (): THREE.Vector3 {
    return this.currentVRM ? this.currentVRM.scene.position : new THREE.Vector3()
  }

  get isMoving (): boolean {
    return this.moving
  }

  get hasModel (): boolean {
    return this.currentVRM !== null
  }

  get baseYaw (): number {
    return this.baseYawValue
  }

  get stance (): Stance {
    return this.currentStance
  }

  isInteracting (): boolean {
    return this.interacting
  }

  /**
   * Snap the avatar onto a seat: place its root at (point.x, seatHeight,
   * point.z), face it toward `facingYaw`, cancel any movement and drop the pose
   * machine into a sitting idle.
   */
  sitAt (point: THREE.Vector3, facingYaw: number, seatHeight: number): void {
    this.settleOnto(point, facingYaw, seatHeight, 'sitting')
  }

  /** As sitAt, but lying flat on a surface (bed / table top). */
  lieAt (point: THREE.Vector3, facingYaw: number, surfaceHeight: number): void {
    this.settleOnto(point, facingYaw, surfaceHeight, 'lying')
  }

  private settleOnto (point: THREE.Vector3, facingYaw: number, height: number, stance: Stance): void {
    if (!this.currentVRM)
      return

    this.cancelMovement()
    this.selectedAnimation = null
    this.onFinishCallback  = null
    this.idleMode          = false

    const root = this.currentVRM.scene
    root.position.set(point.x, height, point.z)
    // Steering faces +Z at baseYaw; match that convention so the facing reads
    // identically to a walked-in arrival.
    root.rotation.y = facingYaw + this.baseYawValue

    this.interacting   = true
    this.currentStance = stance
    void this.enterIdle(true)
  }

  /** Stand the avatar back up: clear the seated state and reset root height. */
  private leaveInteraction (): void {
    if (!this.interacting)
      return
    this.interacting   = false
    this.currentStance = 'standing'
    if (this.currentVRM)
      this.currentVRM.scene.position.y = 0
  }

  setObstacles (obstacles: Obstacle[]): void {
    this.obstacles = obstacles
  }

  // #endregion

  // #region Model loading

  async loadModel (entry: ModelEntry): Promise<void> {
    const gltf = await this.gltfLoader.loadAsync(entry.url)
    const vrm  = gltf.userData.vrm as VRM

    // Perf housekeeping recommended by three-vrm.
    try {
      VRMUtils.removeUnnecessaryVertices(gltf.scene)
      VRMUtils.combineSkeletons(gltf.scene)
    }
    catch { /* optional optimisation — ignore if unsupported by a model */ }

    // VRM0 models face +Z; rotate them to face the camera. No-op for VRM1.
    VRMUtils.rotateVRM0(vrm)
    this.baseYawValue = vrm.scene.rotation.y

    // Scale gait speeds to this model's proportions so feet stay planted.
    const hipHeight = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? REFERENCE_HIP_HEIGHT
    this.speedScale = THREE.MathUtils.clamp(hipHeight / REFERENCE_HIP_HEIGHT, 0.7, 1.4)

    // Give .vrma look-at tracks a concrete target (avoids a console warning and
    // lets the mixer drive eye direction).
    if (vrm.lookAt) {
      const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
      lookAtProxy.name  = 'VRMLookAtQuaternionProxy'
      vrm.scene.add(lookAtProxy)
    }

    vrm.scene.traverse(object => {
      if ((object as THREE.Mesh).isMesh) {
        object.castShadow    = true
        object.receiveShadow = true
      }
    })

    // Swap out the old model.
    this.disposeCurrentModel()
    this.cancelMovement()
    this.currentVRM = vrm
    this.scene.add(vrm.scene)

    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.mixer.addEventListener('finished', this.onMixerFinished)
    this.currentAction    = null
    this.onFinishCallback = null
    this.currentStance    = 'standing'

    // Pre-build locomotion clips for this rig so the first tap is instant.
    await this.prepareLocomotion(vrm)

    // Re-apply the active selection to the new rig, or fall back to idle.
    if (this.selectedAnimation)
      await this.playAnimation(this.selectedAnimation, { fade: false, transition: false })
    else
      await this.enterIdle(false)
  }

  /** Index the catalog so the state machine can pick idles / transitions / gaits. */
  setAvailableAnimations (animations: AnimationEntry[]): void {
    this.library = new AnimationLibrary(animations)
  }

  private async prepareLocomotion (vrm: VRM): Promise<void> {
    this.locomotionClips.clear()
    if (!this.library)
      return

    for (const type of [ 'walk', 'jog', 'run', 'crawl' ] as Locomotion[]) {
      const entry = this.library.locomotion(type)
      if (!entry)
        continue
      try {
        const clip = await this.buildRawClip(entry, vrm)
        stripHorizontalRootMotion(clip, vrm)
        clip.name = `__loco_${type}`
        this.locomotionClips.set(type, clip)
      }
      catch (error) {
        console.warn(`Could not prepare ${type} animation`, error)
      }
    }
  }

  private disposeCurrentModel () {
    if (!this.currentVRM)
      return
    this.mixer?.removeEventListener('finished', this.onMixerFinished)
    this.mixer?.stopAllAction()
    this.scene.remove(this.currentVRM.scene)
    VRMUtils.deepDispose(this.currentVRM.scene)
    this.currentVRM = null
  }

  // #endregion

  // #region Animation playback

  /**
   * Play a user-selected animation. If it lives in a different stance than the
   * model currently holds and a transition animation exists, the transition is
   * played first; afterwards the clip itself plays (looped, or once then idle).
   */
  async playAnimation (entry: AnimationEntry, options: PlayOptions = {}): Promise<void> {
    const { fade = true, transition = true } = options
    this.cancelMovement()
    this.leaveInteraction()
    this.idleMode          = false
    this.onFinishCallback  = null
    this.selectedAnimation = entry
    if (!this.currentVRM || !this.mixer)
      return

    const meta = entry.meta

    // A transition clip selected directly: play once, then settle into its end.
    if (meta?.isTransition) {
      const clip = await this.buildRawClip(entry, this.currentVRM)
      clip.name  = entry.name
      this.playClip(clip, fade, false)
      this.onFinishCallback = () => {
        this.currentStance     = meta.endStance
        this.selectedAnimation = null
        void this.enterIdle(true)
      }
      return
    }

    const destStance = meta?.stance ?? 'standing'
    if (transition && destStance !== this.currentStance && this.library) {
      const transitionEntry = this.library.findTransition(this.currentStance, destStance)
      if (transitionEntry) {
        const clip = await this.buildRawClip(transitionEntry, this.currentVRM)
        clip.name  = transitionEntry.name
        this.playClip(clip, fade, false)
        this.onFinishCallback = () => {
          this.currentStance = destStance
          void this.playSelectedClip(entry, true)
        }
        return
      }
    }

    this.currentStance = destStance
    await this.playSelectedClip(entry, fade)
  }

  /** Play the entry's own clip — looped if it loops smoothly, else once → idle. */
  private async playSelectedClip (entry: AnimationEntry, fade: boolean): Promise<void> {
    if (!this.currentVRM)
      return

    const clip = await this.buildRawClip(entry, this.currentVRM)
    clip.name  = entry.name

    if (entry.meta?.loopable ?? true) {
      this.playClip(clip, fade, true)
      return
    }

    // One-shot: when it finishes, drop into the ending stance's idle.
    this.playClip(clip, fade, false)
    this.onFinishCallback = () => {
      this.currentStance     = entry.meta?.endStance ?? this.currentStance
      this.selectedAnimation = null
      void this.enterIdle(true)
    }
  }

  /** Clear the selection and start random idles for the current stance. */
  clearSelection (): void {
    this.selectedAnimation = null
    this.onFinishCallback  = null
    this.cancelMovement()
    void this.enterIdle(true)
  }

  private async enterIdle (fade: boolean): Promise<void> {
    this.idleMode = true
    await this.playNextIdle(fade)
  }

  private async playNextIdle (fade: boolean): Promise<void> {
    if (!this.library || !this.currentVRM || this.idleSwitching)
      return

    const pool = this.library.idles(this.currentStance)
    // Schedule the next switch even if the pool is empty/static.
    this.idleHold = 8 + Math.random() * 8
    if (!pool.length)
      return

    let entry = pool[Math.floor(Math.random() * pool.length)]
    if (pool.length > 1 && entry.url === this.lastIdleUrl)
      entry = pool[(pool.indexOf(entry) + 1) % pool.length]
    this.lastIdleUrl = entry.url

    this.idleSwitching = true
    try {
      const clip            = await this.buildRawClip(entry, this.currentVRM)
      clip.name             = entry.name
      this.onFinishCallback = null
      this.playClip(clip, fade, true)
    }
    finally {
      this.idleSwitching = false
    }
  }

  /** Build a playable clip for an entry, zeroing root travel for locomotion clips. */
  private async buildRawClip (entry: AnimationEntry, vrm: VRM): Promise<THREE.AnimationClip> {
    const clip = entry.kind === 'vrma'
      ? await this.buildVRMAClip(entry, vrm)
      : await this.buildBVHClip(entry, vrm)
    if (entry.meta?.category === 'locomotion')
      stripHorizontalRootMotion(clip, vrm)
    return clip
  }

  private playClip (clip: THREE.AnimationClip, fade: boolean, loop: boolean): THREE.AnimationAction {
    const action = this.mixer!.clipAction(clip)
    action.reset()
    if (loop) {
      action.setLoop(THREE.LoopRepeat, Infinity)
      action.clampWhenFinished = false
    }
    else {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    }
    action.enabled = true
    action.setEffectiveTimeScale(1)
    action.setEffectiveWeight(1)
    action.play()

    if (fade && this.currentAction && this.currentAction !== action)
      action.crossFadeFrom(this.currentAction, this.fadeDuration, true)

    this.currentAction = action
    return action
  }

  private readonly onMixerFinished = (event: MixerFinishedEvent) => {
    if (event.action !== this.currentAction || !this.onFinishCallback)
      return

    const callback        = this.onFinishCallback
    this.onFinishCallback = null
    callback()
  }

  private async buildVRMAClip (entry: AnimationEntry, vrm: VRM): Promise<THREE.AnimationClip> {
    let animation = this.vrmaCache.get(entry.url)
    if (!animation) {
      const gltf       = await this.vrmaLoader.loadAsync(entry.url)
      const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined
      if (!animations?.length)
        throw new Error(`No VRM animation found in ${entry.url}`)
      animation = animations[0]
      this.vrmaCache.set(entry.url, animation)
    }
    return createVRMAnimationClip(animation, vrm)
  }

  private async buildBVHClip (entry: AnimationEntry, vrm: VRM): Promise<THREE.AnimationClip> {
    let bvh = this.bvhCache.get(entry.url)
    if (!bvh) {
      bvh = await this.bvhLoader.loadAsync(entry.url) as BVHResult
      this.bvhCache.set(entry.url, bvh)
    }
    return retargetBVHToVRM(bvh, vrm)
  }

  // #endregion

  // #region Click-to-move

  /** Set a destination; the avatar turns toward it then walks/jogs/runs over. */
  moveTo (point: THREE.Vector3): void {
    if (!this.currentVRM || this.locomotionClips.size === 0)
      return

    // A tap while seated stands the avatar up before it walks off.
    this.leaveInteraction()

    this.moveTarget = point
    this.marker.position.set(point.x, 0.02, point.z)
    this.marker.visible   = true
    this.idleMode         = false
    this.onFinishCallback = null

    // Low stances crawl; standing escalates walk → jog → run on repeated taps.
    let gait: Locomotion
    if (STANCE_LEVEL[this.currentStance] <= STANCE_LEVEL.sitting)
      gait = 'crawl'
    else if (!this.moving || !this.moveLocomotion)
      gait = 'walk'
    else
      gait = GAIT_ESCALATION[this.moveLocomotion]

    // Choose the intended gait + speed now, but do NOT start the clip yet: the
    // avatar holds its current idle/clip while turning in place, and only steps
    // once it is actually translating (see updateMovement).
    this.moveLocomotion = gait
    this.moveSpeed      = LOCOMOTION_SPEED[gait] * this.speedScale
    this.moving         = true

    // On a repeated tap that escalates the gait while already stepping, switch
    // the locomotion clip immediately.
    if (this.gaitPlaying)
      this.startGait(gait)
  }

  private startGait (gait: Locomotion) {
    const clip = this.locomotionClips.get(gait) ??
      this.locomotionClips.get('walk') ??
      this.locomotionClips.values().next().value
    if (clip)
      this.playClip(clip, true, true)
  }

  private cancelMovement () {
    this.moveTarget     = null
    this.moving         = false
    this.moveLocomotion = null
    this.gaitPlaying    = false
    this.marker.visible = false
  }

  private updateMovement (delta: number) {
    if (!this.moveTarget || !this.currentVRM)
      return

    const root = this.currentVRM.scene

    const dx       = this.moveTarget.x - root.position.x
    const dz       = this.moveTarget.z - root.position.z
    const distance = Math.hypot(dx, dz)

    if (distance <= this.arriveRadius) {
      this.onArrive()
      return
    }

    // Steer toward the destination (model faces +Z at baseYaw). Turn speed eases
    // off as the model aligns, so it doesn't snap — a smooth, natural turn.
    const desiredYaw = Math.atan2(dx, dz) + this.baseYawValue
    let angle = desiredYaw - root.rotation.y
    angle = Math.atan2(Math.sin(angle), Math.cos(angle))

    const maxTurn = this.turnSpeed * delta
    root.rotation.y += THREE.MathUtils.clamp(angle * 0.5, -maxTurn, maxTurn)

    // Only advance once roughly facing the target: speed scales with alignment
    // (cos of the remaining angle), so the model turns in place first instead of
    // crabbing sideways toward the destination.
    const alignment = Math.max(0, Math.cos(angle))
    const stepLen   = Math.min(this.moveSpeed * alignment * delta, distance)

    let nextX = root.position.x + dx / distance * stepLen
    let nextZ = root.position.z + dz / distance * stepLen

    // Slide around circular obstacles: push the next position back out radially.
    for (const obstacle of this.obstacles) {
      const ox      = nextX - obstacle.x
      const oz      = nextZ - obstacle.z
      const dist    = Math.hypot(ox, oz)
      const minDist = obstacle.radius + 0.2
      if (dist < minDist && dist > 1e-5) {
        const push = minDist / dist
        nextX      = obstacle.x + ox * push
        nextZ      = obstacle.z + oz * push
      }
    }

    const movedX    = nextX - root.position.x
    const movedZ    = nextZ - root.position.z
    root.position.x = nextX
    root.position.z = nextZ

    // Gate the locomotion clip on ACTUAL translation, not on merely having a
    // target: while turning in place alignment≈0 so the step is ~0 and we hold
    // idle, and we drop back to idle the instant we stop.
    const step  = Math.hypot(movedX, movedZ)
    const speed = delta > 0 ? step / delta : 0
    if (speed > 0.06 && !this.gaitPlaying) {
      if (this.moveLocomotion)
        this.startGait(this.moveLocomotion)
      this.gaitPlaying = true
    }
    else if (speed <= 0.06 && this.gaitPlaying) {
      this.gaitPlaying = false
      void this.enterIdle(true) // keeps moveTarget so it keeps steering
    }
  }

  private onArrive () {
    this.cancelMovement()
    // Resume the selection (re-inserting a stance transition if needed) or idle.
    if (this.selectedAnimation)
      void this.playAnimation(this.selectedAnimation)
    else
      void this.enterIdle(true)
  }

  // #endregion

  /** Advance idle timer, movement steering, the mixer and the VRM each frame. */
  update (delta: number): void {
    // Random idle rotation when nothing is selected and the model is at rest.
    if (this.idleMode && !this.moving && !this.onFinishCallback && !this.idleSwitching) {
      this.idleHold -= delta
      if (this.idleHold <= 0)
        void this.playNextIdle(true)
    }

    this.updateMovement(delta)
    this.mixer?.update(delta)
    this.currentVRM?.update(delta)
  }
}

/**
 * Pre-multiply every quaternion key in a flat [x,y,z,w,…] value array by `yaw`,
 * rotating the track's rotations in their parent frame. Used to re-face VRM0
 * hips so the body doesn't animate backwards.
 */
function rotateQuaternionTrackValues (values: number[], yaw: THREE.Quaternion): void {
  const q = new THREE.Quaternion()
  for (let i = 0; i < values.length; i += 4) {
    q.set(values[i], values[i + 1], values[i + 2], values[i + 3]).premultiply(yaw)
    values[i]     = q.x
    values[i + 1] = q.y
    values[i + 2] = q.z
    values[i + 3] = q.w
  }
}

/**
 * Convert a BVH clip into an AnimationClip targeting a VRM's normalized humanoid
 * bones. The SillyTavern BVH pack already names its joints with VRM humanoid
 * bone names and rests in a T-pose identical to the VRM normalized rig, so the
 * local rotations transfer directly; only the hips translation needs rescaling
 * to the target model's proportions (matching how createVRMAnimationClip does
 * it for .vrma files).
 */
function retargetBVHToVRM (bvh: BVHResult, vrm: VRM): THREE.AnimationClip {
  const humanoid      = vrm.humanoid
  const rootBone      = bvh.skeleton.bones.find(bone => bone.name === 'hips') ?? bvh.skeleton.bones[0]
  const restHipsY     = rootBone?.position.y || 1
  const humanoidHipsY = humanoid.normalizedRestPose.hips?.position?.[1] ?? restHipsY
  const hipScale      = humanoidHipsY / restHipsY

  // VRM 0.0 rigs natively face -Z, so VRMUtils.rotateVRM0 rotates vrm.scene by π
  // to make them face +Z like VRM 1.0. The BVH pack's hips track is authored in
  // the canonical +Z-facing humanoid space, so composing it with that scene
  // rotation would face the whole body backwards. Counter-rotate the hips track
  // by π for VRM0 so the net world facing matches VRM1 (the steering logic keys
  // off the same baseYaw = π, so this cancels out cleanly for movement too).
  const isVRM0  = vrm.meta?.metaVersion === '0'
  const hipsYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)

  const tracks: THREE.KeyframeTrack[] = []

  for (const track of bvh.clip.tracks) {
    const dot      = track.name.lastIndexOf('.')
    const boneName = track.name.slice(0, dot)
    const property = track.name.slice(dot + 1)
    const node     = humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)
    if (!node)
      continue

    if (property === 'quaternion') {
      const values = Array.from(track.values)
      if (isVRM0 && boneName === 'hips')
        rotateQuaternionTrackValues(values, hipsYaw)
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${node.name}.quaternion`,
        Array.from(track.times),
        values,
      ))
    }
    else if (property === 'position' && boneName === 'hips')
      tracks.push(new THREE.VectorKeyframeTrack(
        `${node.name}.position`,
        Array.from(track.times),
        Array.from(track.values, value => value * hipScale),
      ))
  }

  return new THREE.AnimationClip(bvh.clip.name || 'bvh', bvh.clip.duration, tracks)
}

/**
 * Zero the horizontal (X/Z) component of a clip's hips translation so the legs
 * cycle in place while the model's *root* is driven programmatically (used for
 * walk-to-tapped-point). The vertical bob is preserved.
 */
function stripHorizontalRootMotion (clip: THREE.AnimationClip, vrm: VRM): void {
  const hipsName = vrm.humanoid.getNormalizedBoneNode('hips')?.name
  if (!hipsName)
    return

  const track = clip.tracks.find(candidate => candidate.name === `${hipsName}.position`)
  if (!track)
    return
  for (let i = 0; i < track.values.length; i += 3) {
    track.values[i]     = 0 // X
    track.values[i + 2] = 0 // Z
  }
}
