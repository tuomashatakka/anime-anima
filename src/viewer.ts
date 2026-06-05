import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
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

/** Ground travel speed (metres / second) for each gait. */
const LOCOMOTION_SPEED: Record<Locomotion, number> = { walk: 1.3, jog: 2.4, run: 3.4, crawl: 0.6 }

/** Order gaits escalate through on repeated taps while standing. */
const GAIT_ESCALATION: Record<Locomotion, Locomotion> = { walk: 'jog', jog: 'run', run: 'run', crawl: 'crawl' }

/** The shape of the three.js AnimationMixer "finished" event we care about. */
type MixerFinishedEvent = { action: THREE.AnimationAction }

/**
 * Owns the three.js scene and everything VRM-related: loading models, loading
 * animations (both .vrma and .bvh), crossfading between clips, click-to-move
 * locomotion, and a pose state machine (standing / crouching / sitting / lying)
 * that inserts the correct transition animation between stances and plays random
 * idles when nothing is selected.
 *
 * Both animation formats are compiled into AnimationClips that target the VRM's
 * *normalized* humanoid bones, so a single AnimationMixer drives everything.
 */
export class VRMViewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera:   THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly clock = new THREE.Clock()

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

  // #region Pose state machine
  private library:           AnimationLibrary | null = null
  private currentStance:     Stance = 'standing'
  private selectedAnimation: AnimationEntry | null = null

  /** Called once when the active (one-shot) clip reaches its end. */
  private onFinishCallback: (() => void) | null = null

  private idleMode = false
  private idleSwitching = false
  private idleHold = 0
  private lastIdleUrl: string | null = null
  // #endregion

  // #region Click-to-move state
  private readonly canvas: HTMLCanvasElement
  private ground!:         THREE.Mesh
  private marker!:         THREE.Mesh
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private pointerDown = { x: 0, y: 0, time: 0 }

  /** Yaw applied at load (0 for VRM1, π for VRM0) — the "facing +Z" baseline. */
  private baseYaw = 0
  private moveTarget:     THREE.Vector3 | null = null
  private isMoving = false
  private moveLocomotion: Locomotion | null = null
  private moveSpeed = LOCOMOTION_SPEED.walk
  private readonly locomotionClips = new Map<Locomotion, THREE.AnimationClip>()
  private readonly turnSpeed = 9 // radians / second
  private readonly arriveRadius = 0.08
  // #endregion

  constructor (canvas: HTMLCanvasElement) {
    this.canvas   = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace  = THREE.SRGBColorSpace

    this.scene.background = new THREE.Color(0x0e1117)
    this.scene.fog        = new THREE.Fog(0x0e1117, 8, 22)

    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100)
    this.camera.position.set(0, 1.25, 3.4)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 1.0, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance   = 1.2
    this.controls.maxDistance   = 12
    this.controls.maxPolarAngle = Math.PI * 0.95

    this.gltfLoader.register(parser => new VRMLoaderPlugin(parser))
    this.vrmaLoader.register(parser => new VRMAnimationLoaderPlugin(parser))

    this.buildEnvironment()
    window.addEventListener('resize', this.onResize)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    this.renderer.setAnimationLoop(this.tick)
  }

  // #region Environment

  private buildEnvironment () {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x32384a, 1.6)
    this.scene.add(hemi)

    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(3, 6, 4)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near   = 0.5
    key.shadow.camera.far    = 25
    key.shadow.camera.left   = -5
    key.shadow.camera.right  = 5
    key.shadow.camera.top    = 5
    key.shadow.camera.bottom = -5
    key.shadow.bias          = -0.0005
    this.scene.add(key)

    const rim = new THREE.DirectionalLight(0x6ea8fe, 0.8)
    rim.position.set(-4, 3, -4)
    this.scene.add(rim)

    // Ground plane.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.95, metalness: 0.0 }),
    )
    ground.rotation.x    = -Math.PI / 2
    ground.receiveShadow = true
    this.ground          = ground
    this.scene.add(ground)

    const grid                                    = new THREE.GridHelper(28, 56, 0x2c3550, 0x222a3d);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity     = 0.5
    grid.position.y                               = 0.001
    this.scene.add(grid)

    // Destination marker shown while the model walks toward a tapped point.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.2, 40),
      new THREE.MeshBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    )
    this.marker.rotation.x = -Math.PI / 2
    this.marker.position.y = 0.02
    this.marker.visible    = false
    this.scene.add(this.marker)
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
    this.baseYaw = vrm.scene.rotation.y

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

    this.frameCamera(vrm)

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

  private frameCamera (vrm: VRM) {
    const box    = new THREE.Box3().setFromObject(vrm.scene)
    const size   = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    const height = size.y || 1.5
    this.controls.target.set(center.x, center.y, center.z)
    this.camera.position.set(center.x, center.y + height * 0.1, center.z + height * 1.9)
    this.controls.update()
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

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    // Treat as a tap only if the pointer barely moved and was quick — otherwise
    // it was an OrbitControls drag.
    const moved   = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y)
    const elapsed = performance.now() - this.pointerDown.time
    if (moved > 6 || elapsed > 600)
      return
    this.handleTap(event.clientX, event.clientY)
  }

  private handleTap (clientX: number, clientY: number) {
    if (!this.currentVRM || this.locomotionClips.size === 0)
      return

    const rect     = this.canvas.getBoundingClientRect()
    this.pointer.x = (clientX - rect.left) / rect.width * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const hit = this.raycaster.intersectObject(this.ground, false)[0]
    if (!hit)
      return

    // Keep the destination inside the ground disc.
    const point     = hit.point.clone()
    const radius    = Math.hypot(point.x, point.z)
    const maxRadius = 13
    if (radius > maxRadius)
      point.multiplyScalar(maxRadius / radius)
    point.y = 0

    this.setMoveTarget(point)
  }

  private setMoveTarget (point: THREE.Vector3) {
    this.moveTarget = point
    this.marker.position.set(point.x, 0.02, point.z)
    this.marker.visible   = true
    this.idleMode         = false
    this.onFinishCallback = null

    // Low stances crawl; standing escalates walk → jog → run on repeated taps.
    let gait: Locomotion
    if (STANCE_LEVEL[this.currentStance] <= STANCE_LEVEL.sitting)
      gait = 'crawl'
    else if (!this.isMoving || !this.moveLocomotion)
      gait = 'walk'
    else
      gait = GAIT_ESCALATION[this.moveLocomotion]

    this.startGait(gait)
    this.isMoving = true
  }

  private startGait (gait: Locomotion) {
    if (this.isMoving && this.moveLocomotion === gait)
      return

    this.moveLocomotion = gait
    this.moveSpeed      = LOCOMOTION_SPEED[gait]

    const clip = this.locomotionClips.get(gait) ??
      this.locomotionClips.get('walk') ??
      this.locomotionClips.values().next().value
    if (clip)
      this.playClip(clip, true, true)
  }

  private cancelMovement () {
    this.moveTarget     = null
    this.isMoving       = false
    this.moveLocomotion = null
    if (this.marker)
      this.marker.visible = false
  }

  private updateMovement (delta: number) {
    if (!this.moveTarget || !this.currentVRM)
      return

    const root = this.currentVRM.scene

    const dx       = this.moveTarget.x - root.position.x
    const dz       = this.moveTarget.z - root.position.z
    const distance = Math.hypot(dx, dz)

    // Smoothly steer toward the destination (model faces +Z at baseYaw).
    const desiredYaw = Math.atan2(dx, dz) + this.baseYaw
    let diff = desiredYaw - root.rotation.y
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))

    const maxTurn = this.turnSpeed * delta
    root.rotation.y += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn)

    if (distance <= this.arriveRadius) {
      this.onArrive()
      return
    }

    const step = Math.min(this.moveSpeed * delta, distance)
    root.position.x += dx / distance * step
    root.position.z += dz / distance * step
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

  private readonly tick = () => {
    const delta = this.clock.getDelta()

    // Random idle rotation when nothing is selected and the model is at rest.
    if (this.idleMode && !this.isMoving && !this.onFinishCallback && !this.idleSwitching) {
      this.idleHold -= delta
      if (this.idleHold <= 0)
        void this.playNextIdle(true)
    }

    this.updateMovement(delta)
    this.mixer?.update(delta)
    this.currentVRM?.update(delta)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  private readonly onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
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

  const tracks: THREE.KeyframeTrack[] = []

  for (const track of bvh.clip.tracks) {
    const dot      = track.name.lastIndexOf('.')
    const boneName = track.name.slice(0, dot)
    const property = track.name.slice(dot + 1)
    const node     = humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)
    if (!node)
      continue

    if (property === 'quaternion')
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${node.name}.quaternion`,
        Array.from(track.times),
        Array.from(track.values),
      ))
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
