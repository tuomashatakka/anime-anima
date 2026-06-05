import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FURNITURE_CATALOG } from './furniture-catalog'
import type { FurnitureItem } from './furniture-catalog'
import { FurnitureStore } from './furniture-store'


export interface FurnitureDeps {
  scene:    THREE.Scene
  camera:   THREE.PerspectiveCamera
  controls: OrbitControls
  canvas:   HTMLCanvasElement
  baseUrl:  string
  store:    FurnitureStore
}

/** Roles a gizmo handle mesh can carry (read from object.userData.role). */
type GizmoRole = 'move' | 'rotate'
type DragMode = 'none' | 'move' | 'rotate' | 'placing'

/** Largest distance from origin a piece may be dragged (keeps it on the stage). */
const MAX_RADIUS = 13

/**
 * VIEW layer for placeable furniture: owns the three.js objects, GLTF loader,
 * template cache, gizmo, pointer handling, ghost preview and lamp spotlights.
 * All persistent state (which pieces exist, where, and what is selected) lives
 * in a FurnitureStore; this class reads/writes that store and keeps a matching
 * three.js object per record.
 *
 * Pointer handling is layered *on top of* the viewer's existing tap-to-move
 * logic without modifying it: the down handler runs in the capture phase so it
 * sees the gesture first, and only calls stopPropagation() when it actually
 * consumes one (a gizmo handle or a piece). Empty-ground taps fall through to
 * the viewer untouched. Everything is driven by pointer events, so mouse, pen
 * and touch all work the same way.
 */
export class FurnitureManager {
  private readonly scene:    THREE.Scene
  private readonly camera:   THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly canvas:   HTMLCanvasElement
  private readonly baseUrl:  string
  private readonly store:    FurnitureStore

  private readonly loader = new GLTFLoader()

  /** Container for every placed piece (kept separate from the avatar/scene). */
  private readonly group = new THREE.Group()

  /** Normalised, floor-snapped templates cloned on each placement. */
  private readonly templates = new Map<string, THREE.Group>()

  /** The three.js object backing each store record, keyed by record id. */
  private readonly objects = new Map<string, THREE.Object3D>()

  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly hitPoint = new THREE.Vector3()

  // Gizmo + handles.
  private readonly gizmo = new THREE.Group()
  private rotKnob!: THREE.Mesh

  // Drag state.
  private mode: DragMode = 'none'
  private readonly dragStartPoint = new THREE.Vector3()
  private readonly dragStartPos = new THREE.Vector3()
  private dragStartRot = 0
  private dragStartAngle = 0

  // Placement state.
  private ghost: THREE.Object3D | null = null
  private placeToken = 0
  private placementReleased = false
  private readonly lastFloorPoint = new THREE.Vector3()
  private hasFloorPoint = false

  /** Notified whenever the selection appears / disappears (drives the UI). */
  onSelectionChange: ((hasSelection: boolean) => void) | null = null

  constructor (deps: FurnitureDeps) {
    this.scene    = deps.scene
    this.camera   = deps.camera
    this.controls = deps.controls
    this.canvas   = deps.canvas
    this.baseUrl  = deps.baseUrl
    this.store    = deps.store

    this.scene.add(this.group)
    this.buildGizmo()
    this.scene.add(this.gizmo)

    // React to selection / removal coming through the store.
    this.store.subscribe(() => this.syncSelection())

    // Capture phase: we see the gesture before the viewer's tap-to-move handler.
    this.canvas.addEventListener('pointerdown', this.onPointerDownCapture, true)
    window.addEventListener('keydown', this.onKeyDown)
  }

  // #region Placement (drag from the palette → drop on the floor)

  /**
   * Begin a press-drag-drop placement gesture (call from the palette item's
   * pointerdown). A translucent ghost follows the pointer across the floor;
   * the next pointerup drops a solid copy where the ghost rests.
   */
  beginPlacement (item: FurnitureItem): void {
    void this.beginPlacementAsync(item)
  }

  private async beginPlacementAsync (item: FurnitureItem): Promise<void> {
    this.cancelPlacement()
    this.store.select(null)

    const token = ++this.placeToken

    this.mode              = 'placing'
    this.placementReleased = false
    this.controls.enabled  = false
    this.addDragListeners()

    const template = await this.loadTemplate(item)
    if (token !== this.placeToken)
      return // superseded by a newer placement

    const ghost         = this.makeGhost(template)
    ghost.userData.item = item
    this.group.add(ghost)
    this.ghost = ghost
    this.positionGhost(this.hasFloorPoint ? this.lastFloorPoint : this.frontOfCamera())

    // The pointer may already have been released while the model loaded.
    if (this.placementReleased)
      this.commitPlacement()
  }

  private positionGhost (point: THREE.Vector3): void {
    if (!this.ghost)
      return

    const clamped = this.clampToStage(point)
    this.ghost.position.set(clamped.x, 0, clamped.z)
  }

  private commitPlacement (): void {
    const ghost = this.ghost
    const item  = ghost?.userData.item as FurnitureItem | undefined
    if (!ghost || !item) {
      this.cancelPlacement()
      return
    }

    const id = this.store.add({
      itemId:    item.id,
      x:         ghost.position.x,
      z:         ghost.position.z,
      rotationY: ghost.rotation.y,
    })

    const template = this.templates.get(item.id)!
    const solid    = this.makeSolid(template, item)
    solid.position.set(ghost.position.x, 0, ghost.position.z)
    solid.userData.recordId = id
    solid.rotation.y        = ghost.rotation.y
    this.group.add(solid)
    this.objects.set(id, solid)

    this.group.remove(ghost)
    disposeObject(ghost)
    this.ghost = null
    this.mode  = 'none'
    this.removeDragListeners()
    this.controls.enabled = true

    this.store.select(id)
  }

  private cancelPlacement (): void {
    if (this.ghost) {
      this.group.remove(this.ghost)
      disposeObject(this.ghost)
      this.ghost = null
    }
    if (this.mode === 'placing') {
      this.mode = 'none'
      this.removeDragListeners()
      this.controls.enabled = true
    }
  }

  // #endregion

  // #region Selection + removal

  hasSelection (): boolean {
    return this.store.getSelected() !== null
  }

  removeSelected (): void {
    const selected = this.store.getSelected()
    if (!selected)
      return

    const object = this.objects.get(selected.id)
    if (object) {
      this.group.remove(object)
      disposeObject(object)
      this.objects.delete(selected.id)
    }
    this.store.remove(selected.id)
  }

  /** The currently-selected three.js object, or null. */
  private selectedObject (): THREE.Object3D | null {
    const selected = this.store.getSelected()
    return selected ? this.objects.get(selected.id) ?? null : null
  }

  /** Reflect the store's selection into the gizmo + UI callback. */
  private syncSelection (): void {
    const object = this.selectedObject()
    if (object) {
      this.layoutGizmo(object)
      this.gizmo.visible = true
      this.onSelectionChange?.(true)
    }
    else {
      this.gizmo.visible = false
      this.onSelectionChange?.(false)
    }
  }

  // #endregion

  // #region Coordinator queries

  /**
   * Circular obstacles the avatar must slide around: every placed record whose
   * catalog item has a non-zero footprint, at its stored world XZ. The avatar's
   * own body is never an obstacle (only furniture appears here).
   */
  obstacles (): { x: number, z: number, radius: number }[] {
    const result: { x: number, z: number, radius: number }[] = []
    for (const record of this.store.getAll()) {
      const item   = catalogItem(record.itemId)
      const radius = item?.footprint ?? 0
      if (radius > 0)
        result.push({ x: record.x, z: record.z, radius })
    }

    return result
  }

  /**
   * World anchors for every placed interactive piece (sofas, beds, tables, …)
   * the coordinator can settle the avatar onto.
   */
  interactables (): {
    id:         string
    x:          number
    z:          number
    rotationY:  number
    type:       'sit' | 'lie'
    seatHeight: number
    faceOut:    boolean
    footprint:  number
  }[] {
    const result = []
    for (const record of this.store.getAll()) {
      const item        = catalogItem(record.itemId)
      const interaction = item?.interaction
      if (!interaction)
        continue
      result.push({
        id:         record.id,
        x:          record.x,
        z:          record.z,
        rotationY:  record.rotationY,
        type:       interaction.type,
        seatHeight: interaction.seatHeight,
        faceOut:    interaction.faceOut ?? false,
        footprint:  item?.footprint ?? 0,
      })
    }

    return result
  }

  // #endregion

  // #region Pointer handling

  private readonly onPointerDownCapture = (event: PointerEvent) => {
    if (this.mode === 'placing')
      return

    this.updatePointer(event.clientX, event.clientY)
    this.raycaster.setFromCamera(this.pointer, this.camera)

    // 1) A gizmo handle on the current selection.
    if (this.store.getSelected() && this.gizmo.visible) {
      const role = this.pickGizmoRole()
      if (role) {
        event.stopPropagation()
        this.beginHandleDrag(role)
        return
      }
    }

    // 2) A placed piece → select and start moving it in the same gesture.
    const root = this.pickFurniture()
    if (root) {
      event.stopPropagation()

      const id = root.userData.recordId as string | undefined
      if (id && id !== this.store.getSelected()?.id)
        this.store.select(id)
      this.beginHandleDrag('move')
      return
    }

    // 3) Empty space. If something was selected, consume the tap to deselect;
    //    otherwise let the gesture fall through to orbit / tap-to-move.
    if (this.store.getSelected()) {
      event.stopPropagation()
      this.store.select(null)
    }
  }

  private beginHandleDrag (role: GizmoRole): void {
    const selected = this.selectedObject()
    if (!selected)
      return
    this.controls.enabled = false
    this.mode             = role
    this.dragStartPos.copy(selected.position)
    this.dragStartRot = selected.rotation.y

    if (this.intersectFloor(this.hitPoint)) {
      this.dragStartPoint.copy(this.hitPoint)
      this.dragStartAngle = Math.atan2(
        this.hitPoint.z - selected.position.z,
        this.hitPoint.x - selected.position.x,
      )
    }
    this.addDragListeners()
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.updatePointer(event.clientX, event.clientY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (!this.intersectFloor(this.hitPoint))
      return
    this.lastFloorPoint.copy(this.hitPoint)
    this.hasFloorPoint = true

    if (this.mode === 'placing') {
      this.positionGhost(this.hitPoint)
      return
    }

    const selected = this.store.getSelected()
    const object   = this.selectedObject()
    if (!selected || !object)
      return

    if (this.mode === 'move') {
      const next = this.clampToStage(new THREE.Vector3(
        this.dragStartPos.x + (this.hitPoint.x - this.dragStartPoint.x),
        0,
        this.dragStartPos.z + (this.hitPoint.z - this.dragStartPoint.z),
      ))
      object.position.set(next.x, object.position.y, next.z)
      this.store.update(selected.id, { x: next.x, z: next.z })
      this.layoutGizmo(object)
    }
    else if (this.mode === 'rotate') {
      const angle = Math.atan2(
        this.hitPoint.z - object.position.z,
        this.hitPoint.x - object.position.x,
      )
      object.rotation.y = this.dragStartRot - (angle - this.dragStartAngle)
      this.store.update(selected.id, { rotationY: object.rotation.y })
      this.updateRotKnob()
    }
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    // We only listen during an active gesture, so always swallow the release to
    // keep the viewer's tap-to-move from firing on the trailing pointerup.
    event.stopPropagation()

    if (this.mode === 'placing') {
      this.placementReleased = true
      if (this.ghost)
        this.commitPlacement()
      return
    }

    this.mode             = 'none'
    this.controls.enabled = true
    this.removeDragListeners()
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.store.getSelected()) {
      event.preventDefault()
      this.removeSelected()
    }
    else if (event.key === 'Escape') {
      this.cancelPlacement()
      this.store.select(null)
    }
  }

  private addDragListeners (): void {
    window.addEventListener('pointermove', this.onPointerMove, true)
    window.addEventListener('pointerup', this.onPointerUp, true)
  }

  private removeDragListeners (): void {
    window.removeEventListener('pointermove', this.onPointerMove, true)
    window.removeEventListener('pointerup', this.onPointerUp, true)
  }

  // #endregion

  // #region Picking helpers

  private updatePointer (clientX: number, clientY: number): void {
    const rect     = this.canvas.getBoundingClientRect()
    this.pointer.x = (clientX - rect.left) / rect.width * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  }

  private intersectFloor (target: THREE.Vector3): boolean {
    return this.raycaster.ray.intersectPlane(this.floor, target) !== null
  }

  private pickGizmoRole (): GizmoRole | null {
    const hit = this.raycaster.intersectObjects(this.gizmo.children, false)[0]
    return (hit?.object.userData.role as GizmoRole | undefined) ?? null
  }

  private pickFurniture (): THREE.Object3D | null {
    const hits = this.raycaster.intersectObjects([ ...this.objects.values() ], true)
    if (!hits.length)
      return null
    return this.findPlacedRoot(hits[0].object)
  }

  private findPlacedRoot (object: THREE.Object3D): THREE.Object3D | null {
    let node: THREE.Object3D | null = object
    while (node && node.parent !== this.group)
      node = node.parent
    return node
  }

  private frontOfCamera (): THREE.Vector3 {
    const target = this.controls.target
    return new THREE.Vector3(target.x, 0, target.z)
  }

  private clampToStage (point: THREE.Vector3): THREE.Vector3 {
    const radius = Math.hypot(point.x, point.z)
    if (radius > MAX_RADIUS)
      return point.clone().multiplyScalar(MAX_RADIUS / radius)
    return point.clone()
  }

  // #endregion

  // #region Model loading + variants

  private async loadTemplate (item: FurnitureItem): Promise<THREE.Group> {
    const cached = this.templates.get(item.id)
    if (cached)
      return cached

    const url  = `${this.baseUrl.replace(/\/$/, '')}/furniture/${item.file}`
    const gltf = await this.loader.loadAsync(url)
    const root = gltf.scene
    root.scale.setScalar(item.scale)

    // Centre on XZ and snap the base to the floor (origins vary across the kit).
    const box    = new THREE.Box3().setFromObject(root)
    const center = box.getCenter(new THREE.Vector3())
    root.position.x -= center.x
    root.position.z -= center.z
    root.position.y -= box.min.y

    const template = new THREE.Group()
    template.add(root)
    this.templates.set(item.id, template)
    return template
  }

  private makeSolid (template: THREE.Group, item: FurnitureItem): THREE.Group {
    const solid                  = template.clone(true)
    solid.userData.furnitureRoot = true
    solid.traverse(object => {
      if ((object as THREE.Mesh).isMesh) {
        object.castShadow    = true
        object.receiveShadow = true
      }
    })
    if (item.light)
      this.attachLamp(solid)
    return solid
  }

  private makeGhost (template: THREE.Group): THREE.Group {
    const ghost = template.clone(true)
    const tint  = (material: THREE.Material): THREE.Material => {
      const clone       = material.clone() as THREE.MeshStandardMaterial
      clone.transparent = true
      clone.opacity     = 0.55
      clone.depthWrite  = false
      if (clone.emissive)
        clone.emissive.setHex(0x224466)
      return clone
    }
    ghost.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh)
        return
      mesh.castShadow    = false
      mesh.receiveShadow = false
      mesh.material      = Array.isArray(mesh.material)
        ? mesh.material.map(tint)
        : tint(mesh.material)
    })
    return ghost
  }

  /** Add a warm spot light (plus a glow bulb) inside a lamp piece. */
  private attachLamp (group: THREE.Group): void {
    const box   = new THREE.Box3().setFromObject(group)
    const bulbY = box.max.y * 0.92
    const color = 0xffd9a0

    const spot = new THREE.SpotLight(color, 30, 9, Math.PI / 3, 0.55, 1.2)
    spot.position.set(0, bulbY, 0)
    spot.target.position.set(0, 0, 0) // pool light on the floor below
    spot.castShadow = true
    spot.shadow.mapSize.set(1024, 1024)
    group.add(spot, spot.target)

    const fill = new THREE.PointLight(color, 6, 5, 2)
    fill.position.set(0, bulbY, 0)
    group.add(fill)

    // Emissive bulb so the bloom / god-rays pass has a bright source to work with.
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 16, 16),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 4 }),
    )
    bulb.position.set(0, bulbY, 0)
    group.add(bulb)
  }

  // #endregion

  // #region Gizmo

  private buildGizmo (): void {
    this.gizmo.visible     = false
    this.gizmo.renderOrder = 999

    const handleMat = (hex: number) => {
      const material = new THREE.MeshBasicMaterial({
        color:       hex,
        transparent: true,
        opacity:     0.85,
        side:        THREE.DoubleSide,
        depthTest:   false,
        depthWrite:  false,
      })
      return material
    }

    // Move pad — a translucent disc + ring you drag across the floor (any XZ dir).
    const move            = handleMat(0x52e0a0)
    const disc            = new THREE.Mesh(new THREE.CircleGeometry(0.34, 48), move)
    disc.material.opacity = 0.35
    disc.rotation.x       = -Math.PI / 2
    disc.userData.role    = 'move'
    disc.renderOrder      = 1000

    const moveRing         = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 48), handleMat(0x52e0a0))
    moveRing.rotation.x    = -Math.PI / 2
    moveRing.userData.role = 'move'
    moveRing.renderOrder   = 1000

    // Rotate ring — a flat torus around the piece; drag tangentially to spin (Y).
    const rotateRing         = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.045, 12, 64), handleMat(0x6ea8fe))
    rotateRing.rotation.x    = Math.PI / 2
    rotateRing.userData.role = 'rotate'
    rotateRing.renderOrder   = 1000

    // A knob on the ring that marks (and lets you grab) the current facing.
    const knob            = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 20), handleMat(0x6ea8fe))
    knob.material.opacity = 1
    knob.userData.role    = 'rotate'
    knob.renderOrder      = 1001
    this.rotKnob          = knob

    this.gizmo.add(disc, moveRing, rotateRing, knob)
  }

  /** Position + size the gizmo to wrap the selected piece. */
  private layoutGizmo (object: THREE.Object3D): void {
    const box   = new THREE.Box3().setFromObject(object)
    const size  = box.getSize(new THREE.Vector3())
    const span  = Math.max(size.x, size.z) * 0.5
    const scale = THREE.MathUtils.clamp(span + 0.35, 0.55, 3.2)

    this.gizmo.position.set(object.position.x, 0.03, object.position.z)
    this.gizmo.scale.setScalar(scale)
    this.gizmo.rotation.y = 0
    this.updateRotKnob()
  }

  /** Park the rotate knob on the ring at the piece's current yaw. */
  private updateRotKnob (): void {
    const selected = this.selectedObject()
    if (!selected)
      return

    const yaw = selected.rotation.y
    // Gizmo isn't rotated, so place the knob in local space at the piece's yaw.
    this.rotKnob.position.set(Math.cos(-yaw) * 0.78, 0, Math.sin(-yaw) * 0.78)
  }

  // #endregion
}

/** Recursively dispose geometries + materials of a detached object. */
function disposeObject (object: THREE.Object3D): void {
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh)
      return
    mesh.geometry?.dispose()

    const materials = Array.isArray(mesh.material) ? mesh.material : [ mesh.material ]
    for (const material of materials)
      (material as THREE.Material | undefined)?.dispose()
  })
}

/** Look up a catalog item by its id. */
function catalogItem (itemId: string): FurnitureItem | undefined {
  return FURNITURE_CATALOG.find(item => item.id === itemId)
}
