import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { VRM, VRMLoaderPlugin, VRMUtils, type VRMHumanBoneName } from '@pixiv/three-vrm'
import {
  VRMAnimation,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation'
import type { AnimationEntry, ModelEntry } from './types'

interface BVHResult {
  clip: THREE.AnimationClip
  skeleton: THREE.Skeleton
}

/**
 * Owns the three.js scene and everything VRM-related: loading models, loading
 * animations (both .vrma and .bvh), and crossfading between animation clips.
 *
 * Both animation formats are compiled into AnimationClips that target the VRM's
 * *normalized* humanoid bones, so a single AnimationMixer drives everything and
 * transitions are a simple `crossFadeFrom` tween.
 */
export class VRMViewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly clock = new THREE.Clock()

  private readonly gltfLoader = new GLTFLoader()
  private readonly vrmaLoader = new GLTFLoader()
  private readonly bvhLoader = new BVHLoader()

  private currentVRM: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private currentAction: THREE.AnimationAction | null = null
  private currentAnimation: AnimationEntry | null = null

  /** Raw, model-agnostic animation data, cached after first download. */
  private readonly vrmaCache = new Map<string, VRMAnimation>()
  private readonly bvhCache = new Map<string, BVHResult>()

  private readonly fadeDuration = 0.45

  constructor (canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = new THREE.Color(0x0e1117)
    this.scene.fog = new THREE.Fog(0x0e1117, 8, 22)

    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100)
    this.camera.position.set(0, 1.25, 3.4)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 1.0, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 1.2
    this.controls.maxDistance = 12
    this.controls.maxPolarAngle = Math.PI * 0.95

    this.gltfLoader.register(parser => new VRMLoaderPlugin(parser))
    this.vrmaLoader.register(parser => new VRMAnimationLoaderPlugin(parser))

    this.buildEnvironment()
    window.addEventListener('resize', this.onResize)
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
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 25
    key.shadow.camera.left = -5
    key.shadow.camera.right = 5
    key.shadow.camera.top = 5
    key.shadow.camera.bottom = -5
    key.shadow.bias = -0.0005
    this.scene.add(key)

    const rim = new THREE.DirectionalLight(0x6ea8fe, 0.8)
    rim.position.set(-4, 3, -4)
    this.scene.add(rim)

    // Ground plane.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.95, metalness: 0.0 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)

    const grid = new THREE.GridHelper(28, 56, 0x2c3550, 0x222a3d)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.5
    grid.position.y = 0.001
    this.scene.add(grid)
  }

  // #endregion

  // #region Model loading

  async loadModel (entry: ModelEntry): Promise<void> {
    const gltf = await this.gltfLoader.loadAsync(entry.url)
    const vrm = gltf.userData.vrm as VRM

    // Perf housekeeping recommended by three-vrm.
    try {
      VRMUtils.removeUnnecessaryVertices(gltf.scene)
      VRMUtils.combineSkeletons(gltf.scene)
    }
    catch { /* optional optimisation — ignore if unsupported by a model */ }

    // VRM0 models face +Z; rotate them to face the camera. No-op for VRM1.
    VRMUtils.rotateVRM0(vrm)

    // Give .vrma look-at tracks a concrete target (avoids a console warning and
    // lets the mixer drive eye direction).
    if (vrm.lookAt) {
      const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
      lookAtProxy.name = 'VRMLookAtQuaternionProxy'
      vrm.scene.add(lookAtProxy)
    }

    vrm.scene.traverse(object => {
      if ((object as THREE.Mesh).isMesh) {
        object.castShadow = true
        object.receiveShadow = true
      }
    })

    // Swap out the old model.
    this.disposeCurrentModel()
    this.currentVRM = vrm
    this.scene.add(vrm.scene)

    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.currentAction = null

    this.frameCamera(vrm)

    // Re-apply the active animation to the new model (no crossfade — fresh rig).
    if (this.currentAnimation)
      await this.applyAnimation(this.currentAnimation, false)
  }

  private disposeCurrentModel () {
    if (!this.currentVRM) return
    this.mixer?.stopAllAction()
    this.scene.remove(this.currentVRM.scene)
    VRMUtils.deepDispose(this.currentVRM.scene)
    this.currentVRM = null
  }

  private frameCamera (vrm: VRM) {
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    const height = size.y || 1.5
    this.controls.target.set(center.x, center.y, center.z)
    this.camera.position.set(center.x, center.y + height * 0.1, center.z + height * 1.9)
    this.controls.update()
  }

  // #endregion

  // #region Animation loading & playback

  async applyAnimation (entry: AnimationEntry, fade = true): Promise<void> {
    this.currentAnimation = entry
    if (!this.currentVRM || !this.mixer) return

    const clip = entry.kind === 'vrma'
      ? await this.buildVRMAClip(entry, this.currentVRM)
      : await this.buildBVHClip(entry, this.currentVRM)
    clip.name = entry.name

    const action = this.mixer.clipAction(clip)
    action.reset()
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.enabled = true
    action.setEffectiveTimeScale(1)
    action.setEffectiveWeight(1)
    action.play()

    if (fade && this.currentAction && this.currentAction !== action)
      action.crossFadeFrom(this.currentAction, this.fadeDuration, true)

    this.currentAction = action
  }

  private async buildVRMAClip (entry: AnimationEntry, vrm: VRM): Promise<THREE.AnimationClip> {
    let animation = this.vrmaCache.get(entry.url)
    if (!animation) {
      const gltf = await this.vrmaLoader.loadAsync(entry.url)
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

  private frameId = 0

  private readonly tick = () => {
    const delta = this.clock.getDelta()
    this.mixer?.update(delta)
    this.currentVRM?.update(delta)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.frameId++
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
  const humanoid = vrm.humanoid
  const rootBone = bvh.skeleton.bones.find(bone => bone.name === 'hips') ?? bvh.skeleton.bones[0]
  const restHipsY = rootBone?.position.y || 1
  const humanoidHipsY = humanoid.normalizedRestPose.hips?.position?.[1] ?? restHipsY
  const hipScale = humanoidHipsY / restHipsY

  const tracks: THREE.KeyframeTrack[] = []

  for (const track of bvh.clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const boneName = track.name.slice(0, dot)
    const property = track.name.slice(dot + 1)
    const node = humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)
    if (!node) continue

    if (property === 'quaternion') {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${node.name}.quaternion`,
        Array.from(track.times),
        Array.from(track.values),
      ))
    }
    else if (property === 'position' && boneName === 'hips') {
      tracks.push(new THREE.VectorKeyframeTrack(
        `${node.name}.position`,
        Array.from(track.times),
        Array.from(track.values, value => value * hipScale),
      ))
    }
  }

  return new THREE.AnimationClip(bvh.clip.name || 'bvh', bvh.clip.duration, tracks)
}
