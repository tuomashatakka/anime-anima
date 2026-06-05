import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'


export interface WallDeps {
  scene:    THREE.Scene
  camera:   THREE.PerspectiveCamera
  controls: OrbitControls
  canvas:   HTMLCanvasElement
}

/** A single grid-aligned wall span between two snapped nodes. */
interface WallSegment {
  id:   number
  ax:   number
  az:   number
  bx:   number
  bz:   number
  mesh: THREE.Mesh
}

const GRID        = 1.0 // metres per tile — walls snap to this lattice
const WALL_HEIGHT = 2.6
const WALL_THICK  = 0.12
const MAX_RADIUS  = 14
const TAP_SLOP    = 6 // px of movement below which a gesture counts as a tap

const WALL_COLOR    = 0xb8c0cc
const WALL_SELECTED = 0x6ea8fe

/**
 * A Sims-style wall tool. While active it captures pointer gestures (mouse / pen
 * / touch) on the canvas before the orbit + furniture + move handlers see them:
 *
 *  - drag across the floor → draws a run of grid-snapped unit wall segments,
 *    with a live ghost preview;
 *  - tap an existing wall → selects the whole connected run it belongs to
 *    (every wall reachable through shared endpoints — a continuous structure
 *    whose joints bend by ≤180°);
 *  - Delete / Backspace removes the selected run, Escape clears the selection.
 *
 * Listeners live on `window` in the capture phase, so a single stopPropagation
 * cleanly preempts OrbitControls and the other canvas handlers while drawing,
 * yet UI clicks (whose target isn't the canvas) pass straight through.
 */
export class WallTool {
  private readonly scene:  THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly canvas: HTMLCanvasElement

  private readonly group = new THREE.Group()
  private readonly segments: WallSegment[] = []
  private readonly selected = new Set<number>()
  private nextId = 1

  private active = false

  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly hit = new THREE.Vector3()

  // Drag state.
  private drawing = false
  private readonly startNode = new THREE.Vector2()
  private downXY = { x: 0, y: 0 }
  private hitWallAtDown:       WallSegment | null = null
  private ghost:               THREE.Mesh | null = null
  private readonly nodeMarker: THREE.Mesh

  private readonly material = new THREE.MeshStandardMaterial({ color: WALL_COLOR, roughness: 0.85, metalness: 0.0 })
  private readonly selectedMaterial = new THREE.MeshStandardMaterial({ color: WALL_SELECTED, roughness: 0.6, emissive: 0x16335c, emissiveIntensity: 0.8 })

  /** Notified when the tool is toggled, so the toolbar can reflect on/off. */
  onActiveChange: ((active: boolean) => void) | null = null

  constructor (deps: WallDeps) {
    this.scene  = deps.scene
    this.camera = deps.camera
    this.canvas = deps.canvas
    this.scene.add(this.group)

    this.nodeMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 16),
      new THREE.MeshBasicMaterial({ color: WALL_SELECTED, transparent: true, opacity: 0.9, depthTest: false }),
    )
    this.nodeMarker.renderOrder = 999
    this.nodeMarker.visible     = false
    this.scene.add(this.nodeMarker)

    window.addEventListener('keydown', this.onKeyDown)
  }

  // #region Activation

  isActive (): boolean {
    return this.active
  }

  toggle (): boolean {
    if (this.active)
      this.disable()
    else
      this.enable()
    return this.active
  }

  enable (): void {
    if (this.active)
      return
    this.active = true
    window.addEventListener('pointerdown', this.onPointerDown, true)
    window.addEventListener('pointermove', this.onPointerMove, true)
    window.addEventListener('pointerup', this.onPointerUp, true)
    this.onActiveChange?.(true)
  }

  disable (): void {
    if (!this.active)
      return
    this.active = false
    this.endDraw()
    this.nodeMarker.visible = false
    window.removeEventListener('pointerdown', this.onPointerDown, true)
    window.removeEventListener('pointermove', this.onPointerMove, true)
    window.removeEventListener('pointerup', this.onPointerUp, true)
    this.onActiveChange?.(false)
  }

  // #endregion

  // #region Pointer handling

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.target !== this.canvas)
      return // let toolbar / popovers handle their own clicks
    event.stopPropagation()
    event.preventDefault()

    this.downXY = { x: event.clientX, y: event.clientY }
    if (!this.intersectFloor(event.clientX, event.clientY))
      return

    this.hitWallAtDown = this.pickWall(event.clientX, event.clientY)
    this.snapNode(this.hit, this.startNode)
    this.drawing = true
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.active)
      return
    if (!this.intersectFloor(event.clientX, event.clientY)) {
      this.nodeMarker.visible = false
      return
    }

    const node = new THREE.Vector2()
    this.snapNode(this.hit, node)
    this.nodeMarker.position.set(node.x, 0.02, node.y)
    this.nodeMarker.visible = true

    if (this.drawing) {
      event.stopPropagation()
      this.updateGhost(this.startNode, node)
    }
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.drawing)
      return
    event.stopPropagation()
    this.drawing = false

    const moved   = Math.hypot(event.clientX - this.downXY.x, event.clientY - this.downXY.y)
    const endNode = new THREE.Vector2()
    const onFloor = this.intersectFloor(event.clientX, event.clientY)
    if (onFloor)
      this.snapNode(this.hit, endNode)

    this.clearGhost()

    // Tap on an existing wall → select its connected run.
    if (moved <= TAP_SLOP && this.hitWallAtDown) {
      this.selectRun(this.hitWallAtDown)
      return
    }

    // Otherwise commit the drawn run (if it actually spans grid nodes).
    if (onFloor && (endNode.x !== this.startNode.x || endNode.y !== this.startNode.y))
      this.drawRun(this.startNode, endNode)
    else if (moved <= TAP_SLOP)
      this.clearSelection()
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active)
      return
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected.size) {
      event.preventDefault()
      this.removeSelected()
    }
    else if (event.key === 'Escape')
      this.clearSelection()
  }

  private endDraw (): void {
    this.drawing = false
    this.clearGhost()
  }

  // #endregion

  // #region Drawing

  /** Break a straight start→end drag into connected unit segments along the grid. */
  private drawRun (start: THREE.Vector2, end: THREE.Vector2): void {
    const dx    = end.x - start.x
    const dz    = end.y - start.y
    const steps = Math.max(Math.abs(dx), Math.abs(dz)) / GRID
    if (steps < 1)
      return

    // Axis-aligned runs decompose into clean unit segments; a diagonal drag
    // becomes a single sloped segment.
    const axisAligned = dx === 0 || dz === 0
    if (axisAligned) {
      const count = Math.round(steps)
      const stepX = dx / count
      const stepZ = dz / count
      for (let i = 0; i < count; i++)
        this.addSegment(start.x + stepX * i, start.y + stepZ * i, start.x + stepX * (i + 1), start.y + stepZ * (i + 1))
    }
    else
      this.addSegment(start.x, start.y, end.x, end.y)
  }

  private addSegment (ax: number, az: number, bx: number, bz: number): void {
    if (Math.hypot(ax, az) > MAX_RADIUS && Math.hypot(bx, bz) > MAX_RADIUS)
      return
    if (this.segments.some(s => sameSpan(s, ax, az, bx, bz)))
      return

    const length = Math.hypot(bx - ax, bz - az)
    const mesh   = new THREE.Mesh(new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICK), this.material)
    placeWallMesh(mesh, ax, az, bx, bz)
    mesh.castShadow    = true
    mesh.receiveShadow = true

    const segment: WallSegment = { id: this.nextId++, ax, az, bx, bz, mesh }
    mesh.userData.wallId       = segment.id
    this.group.add(mesh)
    this.segments.push(segment)
  }

  private updateGhost (start: THREE.Vector2, end: THREE.Vector2): void {
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (length < 1e-3) {
      this.clearGhost()
      return
    }
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(
        new THREE.BoxGeometry(1, WALL_HEIGHT, WALL_THICK),
        new THREE.MeshBasicMaterial({ color: WALL_SELECTED, transparent: true, opacity: 0.4, depthWrite: false }),
      )
      this.scene.add(this.ghost)
    }
    this.ghost.geometry.dispose()
    this.ghost.geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICK)
    placeWallMesh(this.ghost, start.x, start.y, end.x, end.y)
  }

  private clearGhost (): void {
    if (!this.ghost)
      return
    this.scene.remove(this.ghost)
    this.ghost.geometry.dispose();
    (this.ghost.material as THREE.Material).dispose()
    this.ghost = null
  }

  // #endregion

  // #region Selection + chain walk

  private pickWall (clientX: number, clientY: number): WallSegment | null {
    this.setPointer(clientX, clientY)
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const intersection = this.raycaster.intersectObjects(this.group.children, false)[0]
    if (!intersection)
      return null

    const id = intersection.object.userData.wallId as number | undefined
    return this.segments.find(s => s.id === id) ?? null
  }

  /**
   * Select every wall connected to `seed` through shared grid nodes — the whole
   * continuous run. Joints are followed regardless of bend (any angle ≤180°),
   * so an L, a U or a closed room all select as one structure.
   */
  private selectRun (seed: WallSegment): void {
    this.clearSelection()

    const queue: WallSegment[] = [ seed ]
    const seen                 = new Set<number>([ seed.id ])
    while (queue.length) {
      const current = queue.shift()!
      this.selected.add(current.id)
      current.mesh.material = this.selectedMaterial
      for (const other of this.segments) {
        if (seen.has(other.id))
          continue
        if (sharesNode(current, other)) {
          seen.add(other.id)
          queue.push(other)
        }
      }
    }
  }

  private clearSelection (): void {
    for (const id of this.selected) {
      const segment = this.segments.find(s => s.id === id)
      if (segment)
        segment.mesh.material = this.material
    }
    this.selected.clear()
  }

  removeSelected (): void {
    for (const id of [ ...this.selected ]) {
      const index = this.segments.findIndex(s => s.id === id)
      if (index < 0)
        continue

      const segment = this.segments[index]
      this.group.remove(segment.mesh)
      segment.mesh.geometry.dispose()
      this.segments.splice(index, 1)
    }
    this.selected.clear()
  }

  // #endregion

  // #region Geometry helpers

  private setPointer (clientX: number, clientY: number): void {
    const rect     = this.canvas.getBoundingClientRect()
    this.pointer.x = (clientX - rect.left) / rect.width * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  }

  private intersectFloor (clientX: number, clientY: number): boolean {
    this.setPointer(clientX, clientY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.ray.intersectPlane(this.floor, this.hit) !== null
  }

  private snapNode (point: THREE.Vector3, out: THREE.Vector2): void {
    out.set(Math.round(point.x / GRID) * GRID, Math.round(point.z / GRID) * GRID)
  }

  // #endregion
}

/** Position + orient a wall box to span (ax,az)→(bx,bz) at standing height. */
function placeWallMesh (mesh: THREE.Mesh, ax: number, az: number, bx: number, bz: number): void {
  mesh.position.set((ax + bx) / 2, WALL_HEIGHT / 2, (az + bz) / 2)
  mesh.rotation.y = -Math.atan2(bz - az, bx - ax)
}

function sameSpan (s: WallSegment, ax: number, az: number, bx: number, bz: number): boolean {
  return s.ax === ax && s.az === az && s.bx === bx && s.bz === bz ||
         s.ax === bx && s.az === bz && s.bx === ax && s.bz === az
}

function sharesNode (a: WallSegment, b: WallSegment): boolean {
  const nodes = [[ a.ax, a.az ], [ a.bx, a.bz ]]
  return nodes.some(([ x, z ]) =>
    x === b.ax && z === b.az || x === b.bx && z === b.bz)
}
