import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js'
import { LUTPass } from 'three/examples/jsm/postprocessing/LUTPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js'
import { CharacterController } from './character'
import { FurnitureManager } from './furniture'
import { FurnitureStore } from './furniture-store'
import { WallTool } from './walls'
import { createCinematicLUT } from './lut'
import { AshParticles } from './ash'
import { ColorGradeShader, DEFAULT_GRADE } from './grade'
import type { ColorGrade } from './grade'
import type { AnimationEntry, ModelEntry } from './types'


export type LightingPreset = 'dramatic' | 'studio' | 'soft' | 'neon' | 'sunset'

interface LightingConfig {
  background: number
  exposure:   number
  fog:        [number, number]
  hemi:       [number, number, number] // sky, ground, intensity
  key:        [number, number, [number, number, number]] // colour, intensity, position
  rim:        [number, number, [number, number, number]]
  accent:     [number, number, [number, number, number]]

  /** Optional narrow theatrical spotlight: colour, intensity, position, cone angle (rad). */
  spot?: [number, number, [number, number, number], number]

  /** Optional pair of visible cone-shaped beams converging on the stage: colour, intensity. */
  beams?: [number, number]
}

export const LIGHTING_PRESETS: { id: LightingPreset, label: string }[] = [
  { id: 'dramatic', label: 'Dramatic' },
  { id: 'studio', label: 'Studio' },
  { id: 'soft', label: 'Soft' },
  { id: 'neon', label: 'Neon Night' },
  { id: 'sunset', label: 'Sunset' },
]

const LIGHTING_CONFIG: Record<LightingPreset, LightingConfig> = {
  // Mostly black, with two crossing volumetric beams pooling on the stage.
  dramatic: {
    background: 0x040507,
    exposure:   1.18,
    fog:        [ 9, 30 ],
    hemi:       [ 0x222d40, 0x040507, 0.16 ],
    key:        [ 0xfff0d8, 0.7, [ 5, 9, 5 ]],
    rim:        [ 0x3a5cff, 1.4, [ -6, 5, -6 ]],
    accent:     [ 0xffffff, 0, [ -5, 4, 4 ]],
    beams:      [ 0xfff1de, 160 ],
  },
  studio: {
    background: 0x0b0e16,
    exposure:   1.18,
    fog:        [ 8, 30 ],
    hemi:       [ 0x6f7ea8, 0x10131c, 0.62 ],
    key:        [ 0xffe6c4, 3.1, [ 5, 8, 4 ]],
    rim:        [ 0x4f7bff, 2.7, [ -6, 5, -6 ]],
    accent:     [ 0xff2e7e, 38, [ -5, 4, 4 ]],
    spot:       [ 0xfff2dc, 65, [ 1.6, 6.5, 2.6 ], Math.PI / 13 ],
  },
  soft: {
    background: 0x262b35,
    exposure:   1.22,
    fog:        [ 12, 36 ],
    hemi:       [ 0xc8d2ec, 0x4a505e, 1.15 ],
    key:        [ 0xfff4e8, 2.7, [ 4, 7, 5 ]],
    rim:        [ 0xbfd0ff, 1.2, [ -4, 4, -5 ]],
    accent:     [ 0xffffff, 0, [ -5, 4, 4 ]],
  },
  neon: {
    background: 0x0a0814,
    exposure:   1.38,
    fog:        [ 6, 24 ],
    hemi:       [ 0x303060, 0x0a0814, 0.45 ],
    key:        [ 0x00e5ff, 2.8, [ 5, 6, 4 ]],
    rim:        [ 0xff00aa, 3.1, [ -6, 5, -5 ]],
    accent:     [ 0x9b5cff, 54, [ -4, 4, 5 ]],
    spot:       [ 0x00e5ff, 105, [ -1.8, 6.5, 2.2 ], Math.PI / 16 ],
  },
  sunset: {
    background: 0x1d1018,
    exposure:   1.4,
    fog:        [ 9, 32 ],
    hemi:       [ 0x8a647e, 0x241016, 0.82 ],
    key:        [ 0xffb066, 3.8, [ 6, 5, 3 ]],
    rim:        [ 0xff5e8a, 2.2, [ -5, 4, -6 ]],
    accent:     [ 0x4060ff, 19, [ -5, 5, 5 ]],
    spot:       [ 0xffcaa0, 75, [ 2.2, 6, 2.4 ], Math.PI / 13 ],
  },
}

/**
 * Owns the three.js scene, renderer, camera and post-processing stack. Avatar
 * loading, animation and click-to-move locomotion live in a CharacterController;
 * the viewer drives it from the render loop and feeds it tapped destinations.
 */
export class VRMViewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera:   THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly clock = new THREE.Clock()

  private readonly character: CharacterController

  // #region Rendering / lighting / settings
  private hemi!:   THREE.HemisphereLight
  private key!:    THREE.DirectionalLight
  private rim!:    THREE.DirectionalLight
  private accent!: THREE.SpotLight
  private spot!:   THREE.SpotLight
  private beams!:  THREE.SpotLight[]
  private cones!:  THREE.Mesh[]
  private ash:     AshParticles | null = null

  private composer:       EffectComposer | null = null
  private bloomPass:      UnrealBloomPass | null = null
  private godRaysPass:    ShaderPass | null = null
  private gradePass:      ShaderPass | null = null
  private readonly grade: ColorGrade = { ...DEFAULT_GRADE }
  private postEnabled = false
  private resolutionScale = 1

  // #region Camera follow
  /** Vertical aim height of the followed model (its bbox centre). */
  private modelCenterY = 1.0
  private followEnabled = true
  private readonly followTmp = new THREE.Vector3()
  // #endregion
  private fpsVisible = false
  private fpsElement: HTMLElement | null = document.getElementById('fps')
  private fpsAccum = 0
  private fpsFrames = 0
  // #endregion

  // #region Click-to-move (tap detection only; locomotion lives in the character)
  private readonly canvas: HTMLCanvasElement
  private ground!:         THREE.Mesh
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private pointerDown = { x: 0, y: 0, time: 0 }
  // #endregion

  constructor (canvas: HTMLCanvasElement) {
    this.canvas   = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace  = THREE.SRGBColorSpace
    // Cinematic tone mapping for punchier, dramatic contrast.
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15

    this.scene.background = new THREE.Color(0x05060a)
    this.scene.fog        = new THREE.Fog(0x05060a, 6, 26)

    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100)
    this.camera.position.set(0, 1.25, 3.4)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 1.0, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance   = 1.2
    this.controls.maxDistance   = 12
    this.controls.maxPolarAngle = Math.PI * 0.95
    // Camera follows the avatar: rotation + zoom only, never panning.
    this.controls.enablePan = false

    this.character = new CharacterController(this.scene)

    this.buildEnvironment()
    window.addEventListener('resize', this.onResize)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    this.renderer.setAnimationLoop(this.tick)
  }

  // #region Environment

  /** Create the lights (a preset configures their colours / intensities). */
  private buildLighting () {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1)
    this.scene.add(this.hemi)

    this.key            = new THREE.DirectionalLight(0xffffff, 1)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.camera.near   = 0.5
    this.key.shadow.camera.far    = 30
    this.key.shadow.camera.left   = -3.5
    this.key.shadow.camera.right  = 3.5
    this.key.shadow.camera.top    = 4
    this.key.shadow.camera.bottom = -1
    this.key.shadow.bias          = -0.0004
    this.key.shadow.radius        = 3
    this.scene.add(this.key)

    this.rim = new THREE.DirectionalLight(0xffffff, 1)
    this.scene.add(this.rim)

    this.accent = new THREE.SpotLight(0xffffff, 0, 18, Math.PI / 5, 0.7, 1.5)
    this.accent.target.position.set(0, 1, 0)
    this.scene.add(this.accent, this.accent.target)

    // A narrow, hard-edged theatrical spotlight (≈13° cone) some presets enable.
    this.spot            = new THREE.SpotLight(0xffffff, 0, 30, Math.PI / 14, 0.25, 1.2)
    this.spot.castShadow = true
    this.spot.shadow.mapSize.set(1024, 1024)
    this.spot.target.position.set(0, 0.9, 0)
    this.scene.add(this.spot, this.spot.target)

    // Two crossing beams + their visible volumetric cones (the "valokiilat"),
    // pooling on the stage centre — toggled on by presets that set `beams`.
    const beamPositions: [number, number, number][] = [[ -3.6, 7.6, 3.4 ], [ 3.6, 7.6, 3.4 ]]
    const target                                    = new THREE.Vector3(0, 0.55, 0)
    this.beams                                      = []
    this.cones                                      = []
    for (const pos of beamPositions) {
      const beam      = new THREE.SpotLight(0xffffff, 0, 26, Math.PI / 12, 0.45, 1.3)
      beam.position.set(...pos)
      beam.target.position.copy(target)
      beam.castShadow = true
      beam.shadow.mapSize.set(1024, 1024)
      this.scene.add(beam, beam.target)
      this.beams.push(beam)

      const cone   = makeLightCone(new THREE.Vector3(...pos), target)
      cone.visible = false
      this.scene.add(cone)
      this.cones.push(cone)
    }

    this.attachLensflare()
    this.setLighting('dramatic')
  }

  /**
   * A strong, procedurally-textured lens flare riding on the key light. The
   * flare sprites are screen-space and occlusion-tested, so they bloom in only
   * when the light is actually visible — pairs with the god-rays pass.
   */
  private attachLensflare (): void {
    const main = makeFlareMain(512)
    const ring = makeFlareRing(256)
    const hex  = makeFlareGhost(128)

    const flare = new Lensflare()
    // Bright burst + halo ring at the light itself.
    flare.addElement(new LensflareElement(main, 360, 0, this.key.color))
    flare.addElement(new LensflareElement(ring, 130, 0))
    // Faint, varied hexagonal aperture ghosts spread along the optical axis,
    // with subtle chromatic shifts — the hallmark of a real lens flare.
    flare.addElement(new LensflareElement(hex, 44, 0.22, new THREE.Color(0x6fb0ff)))
    flare.addElement(new LensflareElement(hex, 30, 0.40, new THREE.Color(0xffd6a0)))
    flare.addElement(new LensflareElement(hex, 66, 0.58, new THREE.Color(0x8fffe0)))
    flare.addElement(new LensflareElement(hex, 24, 0.72, new THREE.Color(0xffffff)))
    flare.addElement(new LensflareElement(hex, 84, 0.92, new THREE.Color(0xff95c4)))
    flare.addElement(new LensflareElement(hex, 40, 1.18, new THREE.Color(0xa593ff)))
    flare.addElement(new LensflareElement(ring, 120, 1.45, new THREE.Color(0x9fc0ff)))
    this.key.add(flare)
  }

  /** Apply a named lighting preset (background, fog, exposure and all lights). */
  setLighting (preset: LightingPreset): void {
    const c = LIGHTING_CONFIG[preset];
    (this.scene.background as THREE.Color).set(c.background);
    (this.scene.fog as THREE.Fog).color.set(c.background);
    (this.scene.fog as THREE.Fog).near = c.fog[0];
    (this.scene.fog as THREE.Fog).far  = c.fog[1]
    this.renderer.toneMappingExposure  = c.exposure

    this.hemi.color.set(c.hemi[0])
    this.hemi.groundColor.set(c.hemi[1])
    this.hemi.intensity = c.hemi[2]

    this.key.color.set(c.key[0]); this.key.intensity          = c.key[1]; this.key.position.set(...c.key[2])
    this.rim.color.set(c.rim[0]); this.rim.intensity          = c.rim[1]; this.rim.position.set(...c.rim[2])
    this.accent.color.set(c.accent[0]); this.accent.intensity = c.accent[1]; this.accent.position.set(...c.accent[2])

    if (c.spot) {
      this.spot.color.set(c.spot[0])
      this.spot.intensity = c.spot[1]
      this.spot.position.set(...c.spot[2])
      this.spot.angle     = c.spot[3]
    }
    else
      this.spot.intensity = 0

    // Visible crossing beams + their cone meshes.
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i]
      const cone = this.cones[i]
      if (c.beams) {
        beam.color.set(c.beams[0]); beam.intensity = c.beams[1]
        cone.visible                               = true;
        ((cone.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).set(c.beams[0])
      }
      else {
        beam.intensity = 0
        cone.visible   = false
      }
    }
  }

  private buildEnvironment () {
    this.buildLighting()

    // Reflective floor (real planar reflections) for a polished, dramatic stage.
    const dpr   = Math.min(window.devicePixelRatio, 2)
    const floor = new Reflector(new THREE.CircleGeometry(16, 80), {
      clipBias:      0.003,
      textureWidth:  Math.min(2048, Math.floor(window.innerWidth * dpr)),
      textureHeight: Math.min(2048, Math.floor(window.innerHeight * dpr)),
      color:         0x252b36,
    })
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)
    this.ground = floor

    // A separate shadow-catcher just above the mirror (Reflector can't receive
    // shadows itself), kept subtle so reflections still read through.
    const shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(16, 80),
      new THREE.ShadowMaterial({ opacity: 0.45 }),
    )
    shadowCatcher.rotation.x    = -Math.PI / 2
    shadowCatcher.position.y    = 0.002
    shadowCatcher.receiveShadow = true
    this.scene.add(shadowCatcher)

    const grid                                    = new THREE.GridHelper(32, 64, 0x3a4a6a, 0x1a2236);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity     = 0.18
    grid.position.y                               = 0.004
    this.scene.add(grid)

    // Ash drifting down, thick at the edges, clear in the middle.
    this.ash = new AshParticles()
    this.scene.add(this.ash.points)
  }

  // #endregion

  // #region Model + animation (delegated to the character controller)

  async loadModel (entry: ModelEntry): Promise<void> {
    await this.character.loadModel(entry)
    this.frameCamera()
  }

  /** Index the catalog so the state machine can pick idles / transitions / gaits. */
  setAvailableAnimations (animations: AnimationEntry[]): void {
    this.character.setAvailableAnimations(animations)
  }

  async playAnimation (entry: AnimationEntry): Promise<void> {
    await this.character.playAnimation(entry)
  }

  clearSelection (): void {
    this.character.clearSelection()
  }

  /** Frame the camera around the avatar's bounding box. */
  private frameCamera () {
    const object = this.character.object
    if (!object)
      return

    const box    = new THREE.Box3().setFromObject(object)
    const size   = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    const height      = size.y || 1.5
    this.modelCenterY = center.y
    this.controls.target.set(center.x, center.y, center.z)
    this.camera.position.set(center.x, center.y + height * 0.1, center.z + height * 1.9)
    this.controls.update()
  }

  // #endregion

  // #region Click-to-move (tap detection)

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
    if (!this.character.hasModel)
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

    this.character.moveTo(point)
  }

  // #endregion

  private readonly tick = () => {
    const delta = this.clock.getDelta()

    this.character.update(delta)
    this.ash?.update(this.clock.getElapsedTime())
    this.updateFollow()
    this.controls.update()

    if (this.postEnabled && this.composer) {
      this.updateGodRays()
      this.composer.render()
    }
    else
      this.renderer.render(this.scene, this.camera)

    this.updateFps(delta)
  }

  // #region Settings / rendering controls

  setResolutionScale (scale: number): void {
    this.resolutionScale = scale
    this.applySize()
  }

  setPostProcessing (enabled: boolean): void {
    this.postEnabled = enabled
    if (enabled && !this.composer)
      this.buildComposer()
    this.applySize()
  }

  setFpsVisible (visible: boolean): void {
    this.fpsVisible = visible
    this.fpsElement?.classList.toggle('visible', visible)
  }

  private buildComposer () {
    // A non-multisampled HDR target: the Lensflare's occlusion read
    // (copyFramebufferToTexture) is invalid against a multisampled framebuffer,
    // which would spam GL_INVALID_OPERATION every frame once post is enabled.
    const drawingSize  = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const renderTarget = new THREE.WebGLRenderTarget(drawingSize.x, drawingSize.y, {
      type:    THREE.HalfFloatType,
      samples: 0,
    })
    const composer = new EffectComposer(this.renderer, renderTarget)
    composer.addPass(new RenderPass(this.scene, this.camera))

    // Bloom: gentle glow with a long, soft radius. Threshold kept fairly high so
    // only genuine highlights bloom (a low threshold blew the lit model out).
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.16, 0.85, 0.85,
    )
    composer.addPass(bloom)

    // God rays — screen-space radial light scattering from the key light.
    const godRays                   = new ShaderPass(GodRaysShader)
    godRays.uniforms.exposure.value = 0.5
    godRays.uniforms.decay.value    = 0.95
    godRays.uniforms.density.value  = 0.92
    godRays.uniforms.weight.value   = 0.5
    composer.addPass(godRays)

    // Strong, animated film grain.
    const film = new FilmPass(0.6, false)
    composer.addPass(film)

    // Cinematic colour grade (teal/orange split-tone, mild contrast + saturation).
    const lut       = new LUTPass({ lut: createCinematicLUT(33), intensity: 0.9 })
    composer.addPass(lut)

    // User-adjustable brightness / contrast / gamma / saturation.
    const grade    = new ShaderPass(ColorGradeShader)
    composer.addPass(grade)
    this.gradePass = grade
    this.applyGrade()

    composer.addPass(new OutputPass())
    this.composer    = composer
    this.bloomPass   = bloom
    this.godRaysPass = godRays
  }

  /** Push the current colour-grade values into the grade pass uniforms. */
  private applyGrade (): void {
    if (!this.gradePass)
      return

    const u            = this.gradePass.uniforms
    u.brightness.value = this.grade.brightness
    u.contrast.value   = this.grade.contrast
    u.gamma.value      = this.grade.gamma
    u.saturation.value = this.grade.saturation
  }

  /** Update one or more colour-grade adjustments (from the settings dialog). */
  setColorGrade (grade: Partial<ColorGrade>): void {
    Object.assign(this.grade, grade)
    this.applyGrade()
  }

  /**
   * Project the key light into screen space each frame and feed the god-rays
   * pass. The rays fade out as the light leaves the frustum or slips behind the
   * camera, so they never streak from a phantom off-screen point.
   */
  private updateGodRays (): void {
    if (!this.godRaysPass)
      return

    const screen   = this.followTmp.copy(this.key.position).project(this.camera)
    const onScreen =
      screen.z < 1 &&
      screen.x > -1.3 && screen.x < 1.3 &&
      screen.y > -1.3 && screen.y < 1.3
    const uniforms = this.godRaysPass.uniforms;
    (uniforms.lightScreen.value as THREE.Vector2).set(screen.x * 0.5 + 0.5, screen.y * 0.5 + 0.5)
    uniforms.weight.value = onScreen ? 0.5 : 0.0
  }

  /**
   * Keep the orbit rig glued to the avatar. We translate the target *and* the
   * camera by the same smoothed delta so the user's chosen orbit angle and zoom
   * are preserved while the whole rig tracks the model across the floor.
   */
  private updateFollow (): void {
    if (!this.followEnabled || !this.character.hasModel)
      return

    const p = this.character.position
    this.followTmp.set(p.x, this.modelCenterY, p.z).sub(this.controls.target)
      .multiplyScalar(0.12)
    this.controls.target.add(this.followTmp)
    this.camera.position.add(this.followTmp)
  }

  /**
   * Build a furniture manager wired to this viewer's scene, camera, controls and
   * canvas. Kept here so those internals stay private to the viewer.
   */
  createFurnitureManager (): FurnitureManager {
    return new FurnitureManager({
      scene:    this.scene,
      camera:   this.camera,
      controls: this.controls,
      canvas:   this.canvas,
      baseUrl:  import.meta.env.BASE_URL,
      store:    new FurnitureStore(),
    })
  }

  /** A grid-snapped wall drawing tool wired to this viewer's scene + input. */
  createWallTool (): WallTool {
    return new WallTool({
      scene:    this.scene,
      camera:   this.camera,
      controls: this.controls,
      canvas:   this.canvas,
    })
  }

  /** The avatar controller, exposed for the furniture-interaction coordinator. */
  getCharacter (): CharacterController {
    return this.character
  }

  private applySize () {
    const width  = window.innerWidth
    const height = window.innerHeight
    const dpr    = Math.min(window.devicePixelRatio, 2) * this.resolutionScale

    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(width, height)
    this.composer?.setPixelRatio(dpr)
    this.composer?.setSize(width, height)
    this.bloomPass?.setSize(width, height)
  }

  private updateFps (delta: number) {
    if (!this.fpsVisible || !this.fpsElement)
      return
    this.fpsAccum += delta
    this.fpsFrames++
    if (this.fpsAccum >= 0.4) {
      this.fpsElement.textContent = `${Math.round(this.fpsFrames / this.fpsAccum)} fps`
      this.fpsAccum               = 0
      this.fpsFrames              = 0
    }
  }

  // #endregion

  private readonly onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.applySize()
  }
}

/**
 * Screen-space radial light-scattering ("god rays" / crepuscular rays). Marches
 * a fixed number of samples from each pixel toward the light's screen position,
 * accumulating only the bright parts of the frame (the sun flare, emissive lamp
 * bulbs, bloom) so light appears to stream through the scene. Strong defaults.
 */
const GodRaysShader = {
  name:     'GodRaysShader',
  uniforms: {
    tDiffuse:    { value: null as THREE.Texture | null },
    lightScreen: { value: new THREE.Vector2(0.5, 0.7) },
    exposure:    { value: 0.5 },
    decay:       { value: 0.95 },
    density:     { value: 0.92 },
    weight:      { value: 0.5 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */`
    #define SAMPLES 64
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 lightScreen;
    uniform float exposure;
    uniform float decay;
    uniform float density;
    uniform float weight;

    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      vec2 texCoord = vUv;
      vec2 delta = ( vUv - lightScreen ) * density / float( SAMPLES );
      float illuminationDecay = 1.0;
      vec3 rays = vec3( 0.0 );

      for ( int i = 0; i < SAMPLES; i++ ) {
        texCoord -= delta;
        vec3 sampleColor = texture2D( tDiffuse, texCoord ).rgb;
        float lum = dot( sampleColor, vec3( 0.299, 0.587, 0.114 ) );
        sampleColor *= smoothstep( 0.55, 1.0, lum );
        rays += sampleColor * illuminationDecay * weight;
        illuminationDecay *= decay;
      }

      gl_FragColor = vec4( base.rgb + rays * exposure, base.a );
    }
  `,
}

/**
 * Build a soft radial-gradient sprite for lens-flare elements: an opaque (or
 * hollow, for ghosts) warm core fading to transparent. Generated on a canvas so
 * no texture assets need shipping.
 */
type FlareCanvasReturnType = { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, half: number }

function flareCanvas (size: number): FlareCanvasReturnType {
  const canvas  = document.createElement('canvas')
  canvas.width  = size
  canvas.height = size
  return { canvas, ctx: canvas.getContext('2d')!, half: size / 2 }
}

function flareTexture (canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture      = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** The main burst: a tight white core, warm halo, faint starburst + anamorphic streak. */
function makeFlareMain (size: number): THREE.CanvasTexture {
  const { canvas, ctx, half } = flareCanvas(size)
  const glow                  = ctx.createRadialGradient(half, half, 0, half, half, half)
  glow.addColorStop(0, 'rgba(255,255,255,1)')
  glow.addColorStop(0.05, 'rgba(255,249,233,0.95)')
  glow.addColorStop(0.16, 'rgba(255,228,188,0.30)')
  glow.addColorStop(0.45, 'rgba(255,216,170,0.05)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 12; i++) {
    const angle     = i / 12 * Math.PI * 2
    ctx.strokeStyle = `rgba(255,246,226,${i % 3 === 0 ? 0.3 : 0.14})`
    ctx.lineWidth   = i % 3 === 0 ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(half, half)
    ctx.lineTo(half + Math.cos(angle) * half * 0.96, half + Math.sin(angle) * half * 0.96)
    ctx.stroke()
  }

  const streak = ctx.createLinearGradient(0, half, size, half)
  streak.addColorStop(0, 'rgba(150,190,255,0)')
  streak.addColorStop(0.5, 'rgba(170,205,255,0.5)')
  streak.addColorStop(1, 'rgba(150,190,255,0)')
  ctx.fillStyle = streak
  ctx.fillRect(0, half - size * 0.012, size, size * 0.024)

  return flareTexture(canvas)
}

/** A thin halo ring (anamorphic / aperture diffraction halo). */
function makeFlareRing (size: number): THREE.CanvasTexture {
  const { canvas, ctx, half } = flareCanvas(size)
  const ring                  = ctx.createRadialGradient(half, half, half * 0.62, half, half, half * 0.96)
  ring.addColorStop(0, 'rgba(255,255,255,0)')
  ring.addColorStop(0.5, 'rgba(190,215,255,0.5)')
  ring.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = ring
  ctx.fillRect(0, 0, size, size)
  return flareTexture(canvas)
}

/** A soft hexagonal aperture ghost. */
function makeFlareGhost (size: number): THREE.CanvasTexture {
  const { canvas, ctx, half } = flareCanvas(size)
  const r                     = half * 0.72
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + i * Math.PI / 3
    const x     = half + Math.cos(angle) * r
    const y     = half + Math.sin(angle) * r
    if (i === 0)
      ctx.moveTo(x, y)
    else
      ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.clip()

  const fill = ctx.createRadialGradient(half, half, 0, half, half, r)
  fill.addColorStop(0, 'rgba(255,255,255,0.5)')
  fill.addColorStop(0.7, 'rgba(255,255,255,0.16)')
  fill.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, size, size)
  return flareTexture(canvas)
}

/**
 * A visible volumetric light cone (additive) from `from` to `to`: bright near
 * the apex, soft silhouette via a view-angle rim term. Double-sided so the
 * overlapping front/back faces read as a soft shaft of light.
 */
function makeLightCone (from: THREE.Vector3, to: THREE.Vector3): THREE.Mesh {
  const height   = from.distanceTo(to)
  const radius   = height * 0.16
  const geometry = new THREE.ConeGeometry(radius, height, 40, 1, true)
  geometry.translate(0, -height / 2, 0)

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
    side:        THREE.DoubleSide,
    uniforms:    {
      uColor:  { value: new THREE.Color(0xffffff) },
      uHeight: { value: height },
    },
    vertexShader: /* glsl */`
      varying float vT;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      uniform float uHeight;
      void main() {
        vT = -position.y / uHeight;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vT;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      uniform vec3 uColor;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.5);
        float vertical = pow(1.0 - clamp(vT, 0.0, 1.0), 1.15);
        // Additive: keep alpha = 1 and put all brightness in rgb (avoids an a^2 falloff).
        float a = vertical * (0.16 + 0.6 * rim);
        gl_FragColor = vec4(uColor * a * 1.7, 1.0);
      }
    `,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(from)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from)
    .normalize())
  mesh.renderOrder   = 3
  mesh.frustumCulled = false
  return mesh
}
