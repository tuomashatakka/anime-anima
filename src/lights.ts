import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { LightStore } from './light-store'
import type { LightRecord } from './light-store'


export interface LightDeps {
  scene:    THREE.Scene
  camera:   THREE.PerspectiveCamera
  controls: OrbitControls
  canvas:   HTMLCanvasElement
  store:    LightStore
}

/** Which gizmo target the TransformControls drives: the light or its aim point. */
export type LightMode = 'move' | 'aim'

/** The three.js objects backing one light record. */
interface LightView {
  rig:          THREE.Group // positioned at the light; holds the spot + handle
  spot:         THREE.SpotLight
  lightHandle:  THREE.Mesh // clickable glowing dot at the light
  targetHandle: THREE.Mesh // clickable marker at the aim point (spot.target)
  helper:       THREE.SpotLightHelper
}

/** A fresh spotlight: overhead-front, aimed at the stage centre, warm-white. */
const DEFAULT_LIGHT: Omit<LightRecord, 'id'> = {
  x:         2.4,
  y:         5,
  z:         3,
  aimX:      0,
  aimY:      1,
  aimZ:      0,
  color:     0xffffff,
  intensity: 18,
  angle:     Math.PI / 8,
  penumbra:  0.6,
  distance:  30,
}

const HANDLE_GEO = new THREE.SphereGeometry(0.14, 16, 12)
const TARGET_GEO = new THREE.OctahedronGeometry(0.16)

/**
 * VIEW layer for user-placed, freely movable/aimable spotlights. Owns a
 * three.js SpotLight (+ clickable handles and a cone helper) per LightStore
 * record and drives a shared TransformControls gizmo for full-3D move / aim.
 *
 * Editing is a toggleable tool (like WallTool): when inactive the lights still
 * illuminate the scene, but the handles, helpers and gizmo hide and pointer
 * input is ignored. When active it listens in the *window* capture phase — a
 * step above the canvas — so a consumed gesture (handle click / deselect) is
 * stopped before the furniture manager or OrbitControls (which live on the
 * canvas) ever see it. Clicks on the gizmo axes fall through to the
 * TransformControls' own canvas listeners untouched.
 */
export class LightManager {
  private readonly scene:    THREE.Scene
  private readonly camera:   THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly canvas:   HTMLCanvasElement
  private readonly store:    LightStore

  private readonly views = new Map<string, LightView>()
  private readonly control: TransformControls
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()

  private mode: LightMode = 'move'
  private active = false

  /** Fired when the selection appears / disappears (drives the settings panel). */
  onSelectionChange: ((selected: LightRecord | null) => void) | null = null

  /** Fired when the editing tool is toggled (drives the toolbar button state). */
  onActiveChange: ((active: boolean) => void) | null = null

  /** Fired when the move/aim mode changes (drives the mode buttons). */
  onModeChange: ((mode: LightMode) => void) | null = null

  constructor (deps: LightDeps) {
    this.scene    = deps.scene
    this.camera   = deps.camera
    this.controls = deps.controls
    this.canvas   = deps.canvas
    this.store    = deps.store

    this.control = new TransformControls(this.camera, this.canvas)
    this.control.setMode('translate')
    // Freeze the orbit camera while a gizmo drag is in progress.
    this.control.addEventListener('dragging-changed', event => {
      this.controls.enabled = !event.value
    })
    this.control.addEventListener('objectChange', () => this.onControlChange())
    // r169+: add the returned helper to the scene, not the control itself.
    this.scene.add(this.control.getHelper())

    this.store.subscribe(() => this.sync())
    window.addEventListener('pointerdown', this.onPointerDownCapture, true)
    window.addEventListener('keydown', this.onKeyDown)

    this.sync()
    this.setActive(false)
  }

  // #region Public API

  /** Add a spotlight at the default pose, select it and enter editing mode. */
  addSpotlight (): string {
    const id = this.store.add({ ...DEFAULT_LIGHT })
    if (!this.active)
      this.setActive(true)
    this.store.select(id)
    return id
  }

  removeSelected (): void {
    const selected = this.store.getSelected()
    if (selected)
      this.store.remove(selected.id)
  }

  getSelected (): LightRecord | null {
    return this.store.getSelected()
  }

  /** Patch the selected light's params (called from the settings sliders). */
  updateSelected (partial: Partial<Omit<LightRecord, 'id'>>): void {
    const selected = this.store.getSelected()
    if (selected)
      this.store.update(selected.id, partial)
  }

  getMode (): LightMode {
    return this.mode
  }

  setMode (mode: LightMode): void {
    if (this.mode === mode)
      return
    this.mode = mode
    this.attachControl()
    this.onModeChange?.(mode)
  }

  isActive (): boolean {
    return this.active
  }

  toggle (): void {
    this.setActive(!this.active)
  }

  setActive (active: boolean): void {
    this.active          = active
    this.control.enabled = active
    for (const view of this.views.values()) {
      view.lightHandle.visible  = active
      view.targetHandle.visible = active
      if (!active)
        view.helper.visible = false
    }
    if (active)
      this.syncSelection()
    else {
      this.control.detach()
      this.control.getHelper().visible = false
    }
    this.onActiveChange?.(active)
  }

  // #endregion

  // #region Store → scene reconciliation

  /** Reconcile the scene's light views with the store, then refresh selection. */
  private sync (): void {
    const records = this.store.getAll()
    const live    = new Set(records.map(record => record.id))

    for (const [ id, view ] of this.views)
      if (!live.has(id)) {
        this.disposeView(view)
        this.views.delete(id)
      }

    for (const record of records) {
      let view = this.views.get(record.id)
      if (!view) {
        view = this.createView(record)
        this.views.set(record.id, view)
      }
      this.applyRecord(view, record)
    }

    this.syncSelection()
  }

  private createView (record: LightRecord): LightView {
    const spot      = new THREE.SpotLight(record.color, record.intensity, record.distance, record.angle, record.penumbra, 1.2)
    spot.castShadow = true
    spot.shadow.mapSize.set(1024, 1024)

    const rig = new THREE.Group()
    rig.add(spot) // spot sits at the rig's local origin, so rig.position == light

    const lightHandle    = new THREE.Mesh(HANDLE_GEO, new THREE.MeshBasicMaterial({ color: record.color }))
    lightHandle.userData = { lightId: record.id, kind: 'light' }
    rig.add(lightHandle)
    this.scene.add(rig)

    const targetHandle    = new THREE.Mesh(TARGET_GEO, new THREE.MeshBasicMaterial({ color: 0x88ccff, wireframe: true }))
    targetHandle.userData = { lightId: record.id, kind: 'target' }
    this.scene.add(targetHandle)
    spot.target = targetHandle

    const helper = new THREE.SpotLightHelper(spot)
    this.scene.add(helper)

    return { rig, spot, lightHandle, targetHandle, helper }
  }

  private applyRecord (view: LightView, record: LightRecord): void {
    view.rig.position.set(record.x, record.y, record.z)
    view.targetHandle.position.set(record.aimX, record.aimY, record.aimZ)
    view.spot.color.set(record.color)
    view.spot.intensity = record.intensity
    view.spot.angle     = record.angle
    view.spot.penumbra  = record.penumbra
    view.spot.distance  = record.distance;
    (view.lightHandle.material as THREE.MeshBasicMaterial).color.set(record.color)
    view.rig.updateMatrixWorld()
    view.targetHandle.updateMatrixWorld()
    view.helper.update()
  }

  private disposeView (view: LightView): void {
    this.scene.remove(view.rig, view.targetHandle, view.helper)
    view.spot.dispose();
    (view.lightHandle.material as THREE.Material).dispose();
    (view.targetHandle.material as THREE.Material).dispose()
    view.helper.dispose()
  }

  /** Reflect the store's selection into the gizmo, handle highlight and helper. */
  private syncSelection (): void {
    const selected = this.store.getSelected()
    for (const [ id, view ] of this.views) {
      const on            = this.active && selected?.id === id
      view.helper.visible = on
      view.lightHandle.scale.setScalar(on ? 1.6 : 1)
    }

    if (this.active && selected)
      this.attachControl()
    else {
      this.control.detach()
      this.control.getHelper().visible = false
    }
    this.onSelectionChange?.(selected)
  }

  /** Attach the gizmo to the selected light's rig (move) or target (aim). */
  private attachControl (): void {
    const selected = this.store.getSelected()
    const view     = selected ? this.views.get(selected.id) : null
    if (!view || !this.active) {
      this.control.detach()
      return
    }

    const object = this.mode === 'move' ? view.rig : view.targetHandle
    if (this.control.object !== object)
      this.control.attach(object)
    this.control.getHelper().visible = true
  }

  /** Write the gizmo's live transform back into the store during a drag. */
  private onControlChange (): void {
    const selected = this.store.getSelected()
    const view     = selected ? this.views.get(selected.id) : null
    if (!selected || !view)
      return
    if (this.mode === 'move')
      this.store.update(selected.id, { x: view.rig.position.x, y: view.rig.position.y, z: view.rig.position.z })
    else
      this.store.update(selected.id, { aimX: view.targetHandle.position.x, aimY: view.targetHandle.position.y, aimZ: view.targetHandle.position.z })
    view.helper.update()
  }

  // #endregion

  // #region Pointer + keyboard

  private readonly onPointerDownCapture = (event: PointerEvent) => {
    if (!this.active)
      return

    // Over a gizmo axis → let the TransformControls' own listeners drive it.
    if (this.control.axis)
      return

    this.updatePointer(event.clientX, event.clientY)
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const handles: THREE.Object3D[] = []
    for (const view of this.views.values())
      handles.push(view.lightHandle, view.targetHandle)

    const hit = this.raycaster.intersectObjects(handles, false)[0]
    if (hit) {
      // Consume in the capture phase so furniture / orbit (on the canvas) skip it.
      event.stopPropagation()

      const id   = hit.object.userData.lightId as string
      const kind = hit.object.userData.kind as string
      if (this.store.getSelected()?.id !== id)
        this.store.select(id)
      this.setMode(kind === 'target' ? 'aim' : 'move')
      // A re-selected same light won't re-fire setMode; force the gizmo to follow.
      this.attachControl()
      return
    }

    // Empty space: drop the selection but let the gesture fall through to orbit.
    if (this.store.getSelected())
      this.store.select(null)
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active || !this.store.getSelected())
      return
    if (event.key === 'Delete' || event.key === 'Backspace')
      this.removeSelected()
    else if (event.key === 'Escape')
      this.store.select(null)
    else if (event.key === 'm' || event.key === 'M')
      this.setMode('move')
    else if (event.key === 't' || event.key === 'T')
      this.setMode('aim')
  }

  private updatePointer (clientX: number, clientY: number): void {
    const rect     = this.canvas.getBoundingClientRect()
    this.pointer.x = (clientX - rect.left) / rect.width * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  }

  // #endregion
}
