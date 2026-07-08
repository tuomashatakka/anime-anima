import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js'
import { LUTPass } from 'three/examples/jsm/postprocessing/LUTPass.js'
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js'
import { applyEnvironment, createComposer, createEmitter } from 'threejs-scenes/raster'
import type { LightingConfig as LibLightingConfig, ComposerHandle, Emitter } from 'threejs-scenes/raster'
import { makeFlareGhost, makeFlareMain, makeFlareRing, makeLightCone } from './lighting-helpers'
import { CharacterController } from './character'
import { FurnitureManager } from './furniture'
import { FurnitureStore } from './furniture-store'
import { LightManager } from './lights'
import { LightStore } from './light-store'
import { WallTool } from './walls'
import { createCinematicLUT } from './lut'
import { ColorGradeShader, DEFAULT_GRADE } from './grade'
import type { ColorGrade } from './grade'
import { loadString, saveString } from './storage'
import type { AnimationEntry, ModelEntry } from './types'


export type LightingPreset =
  | 'dramatic' | 'studio' | 'soft' | 'neon' | 'sunset' |
  'moonlight' | 'noir' | 'candle' | 'cyber'

/** The library's preset shape plus an optional IBL (environment) intensity. */
interface LightingConfig extends LibLightingConfig {

  /** Image-based-lighting strength for this preset (scene.environmentIntensity). */
  env?: number
}

export const LIGHTING_PRESETS: { id: LightingPreset, label: string }[] = [
  { id: 'dramatic', label: 'Dramatic' },
  { id: 'studio', label: 'Studio' },
  { id: 'soft', label: 'Soft' },
  { id: 'neon', label: 'Neon Night' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'moonlight', label: 'Moonlight' },
  { id: 'noir', label: 'Film Noir' },
  { id: 'candle', label: 'Candlelit' },
  { id: 'cyber', label: 'Cyberpunk' },
]

const LIGHTING_CONFIG: Record<LightingPreset, LightingConfig> = {
  // Mostly black, with two crossing volumetric beams pooling on the stage.
  dramatic: {
    background: 0x040507,
    exposure:   1.18,
    env:        0.12,
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
    env:        0.55,
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
    env:        0.85,
    fog:        [ 12, 36 ],
    hemi:       [ 0xc8d2ec, 0x4a505e, 1.15 ],
    key:        [ 0xfff4e8, 2.7, [ 4, 7, 5 ]],
    rim:        [ 0xbfd0ff, 1.2, [ -4, 4, -5 ]],
    accent:     [ 0xffffff, 0, [ -5, 4, 4 ]],
  },
  neon: {
    background: 0x0a0814,
    exposure:   1.38,
    env:        0.2,
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
    env:        0.45,
    fog:        [ 9, 32 ],
    hemi:       [ 0x8a647e, 0x241016, 0.82 ],
    key:        [ 0xffb066, 3.8, [ 6, 5, 3 ]],
    rim:        [ 0xff5e8a, 2.2, [ -5, 4, -6 ]],
    accent:     [ 0x4060ff, 19, [ -5, 5, 5 ]],
    spot:       [ 0xffcaa0, 75, [ 2.2, 6, 2.4 ], Math.PI / 13 ],
  },
  // Cool moonlit night — soft blue key from high overhead, gentle fill.
  moonlight: {
    background: 0x070b16,
    exposure:   1.28,
    env:        0.25,
    fog:        [ 8, 30 ],
    hemi:       [ 0x2a3a66, 0x060810, 0.5 ],
    key:        [ 0xbcd0ff, 1.8, [ 3, 10, 4 ]],
    rim:        [ 0x4a6cff, 1.6, [ -5, 6, -6 ]],
    accent:     [ 0x8fb4ff, 12, [ -4, 5, 4 ]],
    spot:       [ 0xcfe0ff, 45, [ 0.5, 7, 2.5 ], Math.PI / 12 ],
  },
  // High-contrast theatrical black-and-near-white: one hard key + crossing beams.
  noir: {
    background: 0x020203,
    exposure:   1.1,
    env:        0.08,
    fog:        [ 7, 26 ],
    hemi:       [ 0x14161c, 0x000000, 0.1 ],
    key:        [ 0xf6f2ea, 2.2, [ 4, 9, 3 ]],
    rim:        [ 0x9fb0c8, 1.8, [ -5, 5, -5 ]],
    accent:     [ 0xffffff, 0, [ -5, 4, 4 ]],
    spot:       [ 0xfff6e6, 38, [ 1.2, 7, 2.2 ], Math.PI / 16 ],
    beams:      [ 0xeef0f4, 55 ],
  },
  // Warm, dim, cosy candlelight pooling low and close.
  candle: {
    background: 0x140b06,
    exposure:   1.42,
    env:        0.15,
    fog:        [ 6, 22 ],
    hemi:       [ 0x4a2c14, 0x0a0603, 0.35 ],
    key:        [ 0xff9d4a, 2.0, [ 2.5, 4.5, 2.5 ]],
    rim:        [ 0xff6a2a, 1.1, [ -3, 3, -4 ]],
    accent:     [ 0xffb060, 22, [ -3, 3.5, 3 ]],
    spot:       [ 0xffbf80, 40, [ 1.0, 4.5, 1.8 ], Math.PI / 11 ],
  },
  // Punchy magenta/cyan neon over near-black — with converging coloured beams.
  cyber: {
    background: 0x080312,
    exposure:   1.45,
    env:        0.3,
    fog:        [ 6, 24 ],
    hemi:       [ 0x2a0a4a, 0x03060a, 0.4 ],
    key:        [ 0xff2ec4, 3.0, [ 5, 6, 4 ]],
    rim:        [ 0x18e0ff, 3.4, [ -6, 5, -5 ]],
    accent:     [ 0x8a2eff, 42, [ -4, 4, 5 ]],
    spot:       [ 0x18e0ff, 48, [ -1.6, 6.5, 2.2 ], Math.PI / 14 ],
    beams:      [ 0xff2ec4, 80 ],
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
  private frame = 0

  private readonly character: CharacterController

  // #region Rendering / lighting / settings
  private hemi!:           THREE.HemisphereLight
  private key!:            THREE.DirectionalLight
  private rim!:            THREE.DirectionalLight
  private accent!:         THREE.SpotLight
  private spot!:           THREE.SpotLight
  private beams!:          THREE.SpotLight[]
  private cones!:          THREE.Mesh[]
  private currentLighting: LightingPreset = 'dramatic'
  private ash:             Emitter | null = null

  private composer:       ComposerHandle | null = null
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

    this.buildBeams()
    this.attachLensflare()

    // Restore the last-used preset, falling back to the default if none/invalid.
    const saved = loadString('lighting') as LightingPreset | null
    this.setLighting(saved && saved in LIGHTING_CONFIG ? saved : 'dramatic')
  }

  /**
   * Two crossing beams + their visible volumetric cones (the "valokiilat"),
   * pooling on the stage centre — toggled on by presets that set `beams`.
   */
  private buildBeams () {
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
  /** The currently-applied lighting preset (persisted across reloads). */
  getLighting (): LightingPreset {
    return this.currentLighting
  }

  setLighting (preset: LightingPreset): void {
    const c              = LIGHTING_CONFIG[preset]
    this.currentLighting = preset
    saveString('lighting', preset);
    (this.scene.background as THREE.Color).set(c.background);
    (this.scene.fog as THREE.Fog).color.set(c.background);
    (this.scene.fog as THREE.Fog).near = c.fog[0];
    (this.scene.fog as THREE.Fog).far  = c.fog[1]
    this.renderer.toneMappingExposure  = c.exposure
    this.scene.environmentIntensity    = c.env ?? 0.3

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

    // Image-based ambient lighting (RoomEnvironment PMREM) from the scene library.
    // Per-preset strength is driven via scene.environmentIntensity in setLighting.
    applyEnvironment(this.scene, this.renderer, { intensity: 0.3 })

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

    // Ash drifting down a 16-unit column. Ported from a bespoke shader (which
    // faded particles by world-space radial distance, keeping the centre clear
    // and the rim dense) to the shared library's lifetime-based emitter, which
    // has no equivalent for a world-space gradient — traded for age-based
    // fade-in/out instead. Speed is negative (falling) with no gravity/damping
    // decay, matching the original's constant per-particle fall speed.
    this.ash = createEmitter({
      capacity:   14000,
      shape:      { kind: 'disc', radius: 16 },
      speed:      [ -1.5, -0.4 ],
      gravity:    [ 0, 0, 0 ],
      damping:    1,
      lifetime:   [ 16 / 1.5, 16 / 0.4 ],
      color:      [[ 0, '#b9b2a6' ], [ 1, '#b9b2a6' ]],
      alphaCurve: [[ 0, 0 ], [ 0.15, 0.7 ], [ 0.85, 0.7 ], [ 1, 0 ]],
      size:       0.03,
      blending:   'normal',
      texture:    null,
      seed:       1,
    })
    this.ash.object.position.y = 16
    this.scene.add(this.ash.object)
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
    const delta   = this.clock.getDelta()
    const elapsed = this.clock.getElapsedTime()
    this.frame++

    this.character.update(delta)
    this.ash?.tick({ delta, elapsed, frame: this.frame })
    this.updateFollow()
    this.controls.update()

    if (this.postEnabled && this.composer) {
      this.updateGodRays()
      this.composer.composer.render()
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
    const composer = createComposer({
      renderer:       this.renderer,
      scene:          this.scene,
      camera:         this.camera,
      width:          window.innerWidth,
      height:         window.innerHeight,
      // Never wired scene depth; none of film/LUT/grade/godRays consume it.
      withDepth:      false,
      // Gentle glow with a long, soft radius. Threshold kept fairly high so
      // only genuine highlights bloom (a low threshold blew the lit model out).
      withBloom:      true,
      bloomStrength:  0.04,
      bloomRadius:    1.15,
      bloomThreshold: 0.92,
    })

    // God rays — screen-space radial light scattering from the key light.
    const godRays                   = new ShaderPass(GodRaysShader)
    godRays.uniforms.exposure.value = 0.35
    godRays.uniforms.decay.value    = 0.5
    godRays.uniforms.density.value  = 2.0
    godRays.uniforms.weight.value   = 0.5
    // composer.addPassBeforeOutput(godRays)

    // Strong, animated film grain.
    const film = new FilmPass(0.6, false)
    composer.addPassBeforeOutput(film)

    // Cinematic colour grade (teal/orange split-tone, mild contrast + saturation).
    const lut = new LUTPass({ lut: createCinematicLUT(33), intensity: 0.49 })
    composer.addPassBeforeOutput(lut)

    // User-adjustable brightness / contrast / gamma / saturation.
    const grade    = new ShaderPass(ColorGradeShader)
    composer.addPassBeforeOutput(grade)
    this.gradePass = grade
    this.applyGrade()

    this.composer    = composer
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

  /** A movable / aimable spotlight editor wired to this viewer's scene + input. */
  createLightManager (): LightManager {
    return new LightManager({
      scene:    this.scene,
      camera:   this.camera,
      controls: this.controls,
      canvas:   this.canvas,
      store:    new LightStore(),
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
    this.composer?.composer.setPixelRatio(dpr)
    this.composer?.setSize(width, height)
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
