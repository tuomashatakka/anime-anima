/**
 * Pure STATE for user-placed spotlights — no three.js objects. Holds the set of
 * light records and the current selection, notifies subscribers on any change,
 * and (unlike FurnitureStore) persists itself to localStorage so a lighting rig
 * survives reloads. The view layer (LightManager) mirrors this into the scene.
 */
import { loadJSON, saveJSON } from './storage'


/** A single user spotlight: its pose, aim and cone parameters. */
export interface LightRecord {

  /** Unique id for this light (counter-derived; never Math.random). */
  id: string

  /** World position of the light (metres). */
  x: number
  y: number
  z: number

  /** World position the cone is aimed at (the SpotLight.target). */
  aimX: number
  aimY: number
  aimZ: number

  /** Light colour as a packed 0xRRGGBB integer. */
  color: number

  /** Radiant intensity. */
  intensity: number

  /** Cone half-angle in radians. */
  angle: number

  /** Soft-edge fraction 0..1. */
  penumbra: number

  /** Maximum range (0 = infinite). */
  distance: number
}

/** Shape persisted to localStorage under the `lights` key. */
interface PersistedLights {
  records: LightRecord[]
  nextId:  number
}

type Listener = () => void

export class LightStore {
  private readonly records = new Map<string, LightRecord>()
  private selectedId: string | null = null
  private nextId = 1
  private readonly listeners = new Set<Listener>()

  constructor () {
    const saved = loadJSON<PersistedLights>('lights', { records: [], nextId: 1 })
    for (const record of saved.records)
      this.records.set(record.id, record)
    this.nextId = saved.nextId
  }

  /** Add a light; returns its generated unique id. */
  add (record: Omit<LightRecord, 'id'>): string {
    const id = `light-${this.nextId++}`
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

  /** Patch a record's pose / aim / cone params (used while dragging + from sliders). */
  update (id: string, partial: Partial<Omit<LightRecord, 'id'>>): void {
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

  getAll (): LightRecord[] {
    return [ ...this.records.values() ]
  }

  get (id: string): LightRecord | null {
    return this.records.get(id) ?? null
  }

  getSelected (): LightRecord | null {
    return this.selectedId ? this.records.get(this.selectedId) ?? null : null
  }

  /** Subscribe to any change; returns an unsubscribe function. */
  subscribe (listener: Listener): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  private emit (): void {
    this.persist()
    for (const listener of this.listeners)
      listener()
  }

  private persist (): void {
    saveJSON('lights', { records: this.getAll(), nextId: this.nextId })
  }
}
