/**
 * Pure STATE for placed furniture — no three.js objects. Holds an array of
 * placement records and the current selection, and notifies subscribers on any
 * change. The view layer (FurnitureManager) mirrors this state into the scene.
 */

/** A single placed piece: its identity, source catalog item, and floor pose. */
export interface FurnitureRecord {

  /** Unique id for this placement (counter-derived; never Math.random). */
  id: string

  /** Catalog FurnitureItem.id this placement was created from. */
  itemId: string

  /** Floor position (metres). */
  x: number
  z: number

  /** Rotation about the vertical axis (radians). */
  rotationY: number
}

type Listener = () => void

export class FurnitureStore {
  private readonly records = new Map<string, FurnitureRecord>()
  private selectedId: string | null = null
  private nextId = 1
  private readonly listeners = new Set<Listener>()

  /** Add a placement; returns its generated unique id. */
  add (record: Omit<FurnitureRecord, 'id'>): string {
    const id = `furniture-${this.nextId++}`
    this.records.set(id, { ...record, id })
    this.emit()
    return id
  }

  remove (id: string): void {
    if (!this.records.delete(id))
      return
    if (this.selectedId === id)
      this.selectedId = null
    this.emit()
  }

  /** Patch a record's position / rotation (used while dragging). */
  update (id: string, partial: Partial<Omit<FurnitureRecord, 'id'>>): void {
    const record = this.records.get(id)
    if (!record)
      return
    Object.assign(record, partial)
    this.emit()
  }

  select (id: string | null): void {
    if (this.selectedId === id)
      return
    this.selectedId = id
    this.emit()
  }

  getAll (): FurnitureRecord[] {
    return [ ...this.records.values() ]
  }

  get (id: string): FurnitureRecord | null {
    return this.records.get(id) ?? null
  }

  getSelected (): FurnitureRecord | null {
    return this.selectedId ? this.records.get(this.selectedId) ?? null : null
  }

  /** Subscribe to any change; returns an unsubscribe function. */
  subscribe (listener: Listener): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  private emit (): void {
    for (const listener of this.listeners)
      listener()
  }
}
