import type { AnimationEntry, ModelEntry } from './types'
import { LIGHTING_PRESETS } from './viewer'
import type { LightingPreset } from './viewer'
import { FURNITURE_CATALOG } from './furniture-catalog'
import type { FurnitureItem } from './furniture-catalog'
import { ThumbnailRenderer } from './furniture-thumbnails'
import { loadJSON, saveJSON } from './storage'
import { DEFAULT_GRADE } from './grade'
import type { ColorGrade } from './grade'
import type { LightRecord } from './light-store'
import type { LightMode } from './lights'


/** Shared, lazily-created off-screen renderer for furniture palette previews. */
let thumbnailRenderer: ThumbnailRenderer | null = null
function furnitureThumbnailUrl (item: FurnitureItem): Promise<string | null> {
  thumbnailRenderer ??= new ThumbnailRenderer()

  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  return thumbnailRenderer.render(`${base}/furniture/${item.file}`, item.scale)
}


interface PopoverItem {
  id:    string
  label: string
  tag?:  string
}

/**
 * A toolbar button + searchable popover list. Generic over the kind of entry it
 * lists; emits a callback when the user picks an item.
 */
class Popover {
  private element:  HTMLDivElement | null = null
  private items:    PopoverItem[] = []
  private activeId: string | null = null

  constructor (
    private readonly button: HTMLButtonElement,
    private readonly currentLabel: HTMLElement,
    private readonly onPick: (id: string) => void,
  ) {
    this.button.addEventListener('click', event => {
      event.stopPropagation()
      if (this.element)
        this.close()
      else
        this.open()
    })
  }

  setItems (items: PopoverItem[]) {
    this.items = items
    if (this.element)
      this.renderList()
  }

  setActive (id: string, label: string) {
    this.activeId                 = id
    this.currentLabel.textContent = label
    if (this.element)
      this.renderList()
  }

  private open () {
    this.button.setAttribute('aria-expanded', 'true')

    const popover     = document.createElement('div')
    popover.className = 'popover'

    const rect         = this.button.getBoundingClientRect()
    popover.style.left = `${Math.max(12, rect.left)}px`

    const search       = document.createElement('input')
    search.className   = 'popover-search'
    search.type        = 'search'
    search.placeholder = 'Filter…'
    search.addEventListener('input', () => this.renderList(search.value))
    search.addEventListener('click', event => event.stopPropagation())

    const list     = document.createElement('div')
    list.className = 'popover-list'

    popover.append(search, list)
    popover.addEventListener('click', event => event.stopPropagation())
    document.getElementById('app')!.appendChild(popover)
    this.element = popover

    this.renderList()
    search.focus()
    document.addEventListener('click', this.onDocumentClick)
    document.addEventListener('keydown', this.onKeydown)
  }

  private close () {
    this.element?.remove()
    this.element = null
    this.button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', this.onDocumentClick)
    document.removeEventListener('keydown', this.onKeydown)
  }

  private renderList (filter = '') {
    if (!this.element)
      return

    const list     = this.element.querySelector('.popover-list') as HTMLDivElement
    list.innerHTML = ''

    const needle  = filter.trim().toLowerCase()
    const matches = needle
      ? this.items.filter(item =>
        item.label.toLowerCase().includes(needle) || (item.tag?.toLowerCase().includes(needle) ?? false))
      : this.items

    if (matches.length === 0) {
      const empty       = document.createElement('div')
      empty.className   = 'popover-empty'
      empty.textContent = 'No matches'
      list.appendChild(empty)
      return
    }

    // Cap the DOM size for huge catalogs (thousands of avatars); searching narrows it.
    const visible = matches.slice(0, Popover.MAX_RENDER)
    for (const item of visible) {
      const button     = document.createElement('button')
      button.className = 'popover-item' + (item.id === this.activeId ? ' active' : '')

      const label       = document.createElement('span')
      label.textContent = item.label
      button.appendChild(label)

      if (item.tag) {
        const tag       = document.createElement('span')
        tag.className   = 'tag'
        tag.textContent = item.tag
        button.appendChild(tag)
      }

      button.addEventListener('click', () => {
        this.close()
        this.onPick(item.id)
      })
      list.appendChild(button)
    }

    if (matches.length > visible.length) {
      const more       = document.createElement('div')
      more.className   = 'popover-empty'
      more.textContent = `Showing ${visible.length} of ${matches.length} — type to filter`
      list.appendChild(more)
    }
  }

  private static readonly MAX_RENDER = 150

  private readonly onDocumentClick = () => this.close()
  private readonly onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape')
      this.close()
  }
}

/** Sentinel id for the "no animation — auto idle" popover item. */
const NONE_ID = '__none__'

export interface ToolbarCallbacks {
  onModelPick:      (entry: ModelEntry) => void
  onAnimationPick:  (entry: AnimationEntry) => void
  onAnimationClear: () => void
  onLightingPick:   (preset: LightingPreset) => void
}

export class Toolbar {
  private readonly modelPopover:     Popover
  private readonly animationPopover: Popover
  private readonly lightingPopover:  Popover
  private models:                    ModelEntry[] = []
  private animations:                AnimationEntry[] = []

  constructor (callbacks: ToolbarCallbacks) {
    this.lightingPopover = new Popover(
      document.getElementById('btn-lighting') as HTMLButtonElement,
      document.getElementById('current-lighting')!,
      id => callbacks.onLightingPick(id as LightingPreset),
    )
    this.lightingPopover.setItems(LIGHTING_PRESETS.map(p => ({ id: p.id, label: p.label })))
    this.lightingPopover.setActive('dramatic', 'Dramatic')

    this.modelPopover = new Popover(
      document.getElementById('btn-models') as HTMLButtonElement,
      document.getElementById('current-model')!,
      id => {
        const entry = this.models.find(model => model.url === id)
        if (entry)
          callbacks.onModelPick(entry)
      },
    )

    this.animationPopover = new Popover(
      document.getElementById('btn-animations') as HTMLButtonElement,
      document.getElementById('current-animation')!,
      id => {
        if (id === NONE_ID) {
          callbacks.onAnimationClear()
          return
        }

        const entry = this.animations.find(animation => animation.url === id)
        if (entry)
          callbacks.onAnimationPick(entry)
      },
    )
  }

  setModels (models: ModelEntry[]) {
    this.models = models
    this.modelPopover.setItems(models.map(model => ({ id: model.url, label: model.name, tag: model.group })))
  }

  setAnimations (animations: AnimationEntry[]) {
    this.animations = animations
    this.animationPopover.setItems([
      { id: NONE_ID, label: 'None — auto idle' },
      ...animations.map(animation => ({ id: animation.url, label: animation.name, tag: animation.meta?.category ?? animation.kind })),
    ])
  }

  /** Reflect the active lighting preset in the toolbar (e.g. restored on load). */
  setActiveLighting (preset: LightingPreset) {
    const match = LIGHTING_PRESETS.find(p => p.id === preset)
    this.lightingPopover.setActive(preset, match?.label ?? preset)
  }

  setActiveModel (entry: ModelEntry) {
    this.modelPopover.setActive(entry.url, entry.name)
  }

  setActiveAnimation (entry: AnimationEntry | null) {
    if (entry)
      this.animationPopover.setActive(entry.url, entry.name)
    else
      this.animationPopover.setActive(NONE_ID, 'Auto idle')
  }
}

/**
 * The furniture toolbar button + a grid popover of placeable pieces. Pressing a
 * tile starts a drag-and-drop placement: `onPlace` is fired on pointerdown and
 * the panel closes immediately so the live ghost preview is visible while the
 * user drags onto the floor (works with mouse, pen and touch).
 */
export class FurniturePanel {
  private element: HTMLDivElement | null = null

  constructor (
    private readonly button: HTMLButtonElement,
    private readonly onPlace: (item: FurnitureItem) => void,
  ) {
    this.button.addEventListener('click', event => {
      event.stopPropagation()
      if (this.element)
        this.close()
      else
        this.open()
    })
  }

  private open () {
    this.button.setAttribute('aria-expanded', 'true')

    const popover     = document.createElement('div')
    popover.className = 'popover furniture-popover'

    const rect         = this.button.getBoundingClientRect()
    popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 320))}px`

    const grid     = document.createElement('div')
    grid.className = 'furniture-grid'

    for (const item of FURNITURE_CATALOG) {
      const tile     = document.createElement('button')
      tile.className = 'furniture-tile'

      const thumb     = document.createElement('span')
      thumb.className = 'furniture-thumb'

      const name       = document.createElement('span')
      name.className   = 'furniture-name'
      name.textContent = item.name
      tile.append(thumb, name)

      // Render the real model preview lazily; cached after the first open.
      void furnitureThumbnailUrl(item).then(dataUrl => {
        if (dataUrl)
          thumb.style.backgroundImage = `url(${dataUrl})`
      })

      // pointerdown (not click) so the placement drag begins on press.
      tile.addEventListener('pointerdown', event => {
        event.preventDefault()
        event.stopPropagation()
        this.close()
        this.onPlace(item)
      })
      grid.appendChild(tile)
    }

    popover.appendChild(grid)
    popover.addEventListener('click', event => event.stopPropagation())
    document.getElementById('app')!.appendChild(popover)
    this.element = popover

    document.addEventListener('click', this.onDocumentClick)
    document.addEventListener('keydown', this.onKeydown)
  }

  private close () {
    this.element?.remove()
    this.element = null
    this.button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', this.onDocumentClick)
    document.removeEventListener('keydown', this.onKeydown)
  }

  private readonly onDocumentClick = () => this.close()
  private readonly onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape')
      this.close()
  }
}

export interface SettingsState {
  fps:        boolean
  post:       boolean
  resolution: number
  grade:      ColorGrade
}

export interface SettingsCallbacks {
  onFps:        (on: boolean) => void
  onPost:       (on: boolean) => void
  onResolution: (scale: number) => void
  onGrade:      (grade: ColorGrade) => void
}

const RESOLUTION_OPTIONS = [ 0.2, 0.33, 0.5, 0.67, 1 ]

interface GradeControl { key: keyof ColorGrade, label: string, min: number, max: number }

const GRADE_CONTROLS: GradeControl[] = [
  { key: 'brightness', label: 'Brightness', min: 0.3, max: 1.6 },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 2.0 },
  { key: 'gamma', label: 'Gamma', min: 0.5, max: 2.2 },
  { key: 'saturation', label: 'Saturation', min: 0.0, max: 2.0 },
]

/** Defaults applied the first time, before anything is persisted. */
const DEFAULT_SETTINGS: SettingsState = { fps: false, post: true, resolution: 0.67, grade: { ...DEFAULT_GRADE }}

/** Modal settings dialog opened from the toolbar's gear button. */
export class SettingsDialog {
  private readonly overlay: HTMLDivElement
  private readonly state:   SettingsState = loadJSON('settings', DEFAULT_SETTINGS)

  constructor (private readonly callbacks: SettingsCallbacks) {
    this.overlay           = document.createElement('div')
    this.overlay.className = 'dialog-overlay'
    this.overlay.addEventListener('click', event => {
      if (event.target === this.overlay)
        this.close()
    })
    this.overlay.appendChild(this.buildPanel())
    document.getElementById('app')!.appendChild(this.overlay)

    document.getElementById('btn-settings')!.addEventListener('click', event => {
      event.stopPropagation()
      this.open()
    })

    // Apply the persisted (or default) settings to the viewer on startup.
    this.callbacks.onFps(this.state.fps)
    this.callbacks.onPost(this.state.post)
    this.callbacks.onResolution(this.state.resolution)
    this.callbacks.onGrade(this.state.grade)
  }

  private persist (): void {
    saveJSON('settings', this.state)
  }

  private buildPanel (): HTMLElement {
    const panel     = document.createElement('div')
    panel.className = 'dialog'
    panel.addEventListener('click', event => event.stopPropagation())
    panel.innerHTML = '<header class="dialog-title">Settings</header>'

    panel.appendChild(this.toggleRow('Display FPS', this.state.fps, on => {
      this.state.fps = on
      this.callbacks.onFps(on)
      this.persist()
    }))
    panel.appendChild(this.toggleRow('Post-processing', this.state.post, on => {
      this.state.post = on
      this.callbacks.onPost(on)
      this.persist()
    }))
    panel.appendChild(this.resolutionRow())
    for (const control of GRADE_CONTROLS)
      panel.appendChild(this.sliderRow(control))

    const close       = document.createElement('button')
    close.className   = 'dialog-close'
    close.textContent = 'Done'
    close.addEventListener('click', () => this.close())
    panel.appendChild(close)
    return panel
  }

  private toggleRow (label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
    const row     = document.createElement('label')
    row.className = 'dialog-row'
    row.innerHTML = `<span>${label}</span>`

    const input     = document.createElement('input')
    input.type      = 'checkbox'
    input.className = 'switch'
    input.checked   = initial
    input.addEventListener('change', () => onChange(input.checked))
    row.appendChild(input)
    return row
  }

  private sliderRow (control: GradeControl): HTMLElement {
    const row     = document.createElement('div')
    row.className = 'dialog-row'
    row.innerHTML = `<span>${control.label}</span>`

    const wrap     = document.createElement('div')
    wrap.className = 'slider-wrap'

    const input     = document.createElement('input')
    input.type      = 'range'
    input.className = 'slider'
    input.min       = String(control.min)
    input.max       = String(control.max)
    input.step      = '0.01'
    input.value     = String(this.state.grade[control.key])

    const value       = document.createElement('span')
    value.className   = 'slider-value'
    value.textContent = this.state.grade[control.key].toFixed(2)

    input.addEventListener('input', () => {
      const v                       = parseFloat(input.value)
      this.state.grade[control.key] = v
      value.textContent             = v.toFixed(2)
      this.callbacks.onGrade(this.state.grade)
      this.persist()
    })
    wrap.append(input, value)
    row.appendChild(wrap)
    return row
  }

  private resolutionRow (): HTMLElement {
    const row     = document.createElement('div')
    row.className = 'dialog-row'
    row.innerHTML = '<span>Resolution scale</span>'

    const group     = document.createElement('div')
    group.className = 'seg'
    for (const value of RESOLUTION_OPTIONS) {
      const button       = document.createElement('button')
      button.textContent = `${value}×`
      button.className   = value === this.state.resolution ? 'active' : ''
      button.addEventListener('click', () => {
        this.state.resolution = value
        this.callbacks.onResolution(value)
        this.persist()
        for (const child of group.children)
          child.classList.toggle('active', child === button)
      })
      group.appendChild(button)
    }
    row.appendChild(group)
    return row
  }

  private open () {
    this.overlay.classList.add('open')
  }

  private close () {
    this.overlay.classList.remove('open')
  }
}

/** Callbacks the light panel drives back into the LightManager. */
export interface LightPanelCallbacks {
  onAdd:    () => void
  onRemove: () => void
  onMode:   (mode: LightMode) => void
  onChange: (partial: Partial<Omit<LightRecord, 'id'>>) => void
}

/** A numeric spotlight parameter and how it maps to the slider (display units). */
interface LightControl {
  label:        string
  key:          'intensity' | 'angle' | 'penumbra' | 'distance'
  min:          number
  max:          number
  step:         number
  unit?:        string
  toDisplay?:   (value: number) => number
  fromDisplay?: (value: number) => number
}

const RAD2DEG                        = 180 / Math.PI
const LIGHT_CONTROLS: LightControl[] = [
  { label: 'Intensity', key: 'intensity', min: 0, max: 200, step: 1 },
  {
    label:       'Cone angle',
    key:         'angle',
    min:         5,
    max:         80,
    step:        1,
    unit:        '°',
    toDisplay:   radians => radians * RAD2DEG,
    fromDisplay: degrees => degrees / RAD2DEG,
  },
  { label: 'Penumbra', key: 'penumbra', min: 0, max: 1, step: 0.01 },
  { label: 'Distance', key: 'distance', min: 0, max: 60, step: 1 },
]

/**
 * A floating card for editing spotlights, shown while the light tool is active.
 * With nothing selected it offers "Add spotlight"; selecting a light reveals a
 * move/aim toggle, a colour picker and sliders for intensity / cone angle /
 * penumbra / distance. Every edit is pushed straight to the LightManager via
 * `onChange`, which patches the store (and persists it).
 */
export class LightPanel {
  private readonly root:       HTMLDivElement
  private readonly params:     HTMLDivElement
  private readonly modeButtons = new Map<LightMode, HTMLButtonElement>()
  private readonly sliders = new Map<LightControl['key'], { input: HTMLInputElement, value: HTMLSpanElement }>()
  private readonly colorInput: HTMLInputElement
  private current:             LightRecord | null = null

  constructor (private readonly callbacks: LightPanelCallbacks) {
    this.root           = document.createElement('div')
    this.root.className = 'light-panel'
    this.root.innerHTML = '<header class="light-panel-title">Spotlights</header>'

    const add       = document.createElement('button')
    add.className   = 'light-add'
    add.textContent = '+ Add spotlight'
    add.addEventListener('click', () => this.callbacks.onAdd())
    this.root.appendChild(add)

    this.params           = document.createElement('div')
    this.params.className = 'light-params'
    this.params.appendChild(this.modeRow())
    this.params.appendChild(this.colorRow())
    for (const control of LIGHT_CONTROLS)
      this.params.appendChild(this.sliderRow(control))

    const remove       = document.createElement('button')
    remove.className   = 'dialog-close'
    remove.textContent = '✕ Remove light'
    remove.addEventListener('click', () => this.callbacks.onRemove())
    this.params.appendChild(remove)

    this.colorInput = this.params.querySelector('input[type=color]')!
    this.root.appendChild(this.params)
    document.getElementById('app')!.appendChild(this.root)
  }

  /** Show / hide the whole panel with the editing tool. */
  setActive (active: boolean): void {
    this.root.classList.toggle('open', active)
  }

  /** Reflect the current move/aim mode in the segmented control. */
  setMode (mode: LightMode): void {
    for (const [ key, button ] of this.modeButtons)
      button.classList.toggle('active', key === mode)
  }

  /** Populate (or hide) the parameter controls for the selected light. */
  setSelected (record: LightRecord | null): void {
    this.current = record
    this.params.classList.toggle('visible', record !== null)
    if (!record)
      return

    for (const control of LIGHT_CONTROLS) {
      const row             = this.sliders.get(control.key)!
      const display         = control.toDisplay ? control.toDisplay(record[control.key]) : record[control.key]
      row.input.value       = String(display)
      row.value.textContent = this.format(control, display)
    }
    this.colorInput.value = `#${record.color.toString(16).padStart(6, '0')}`
  }

  private format (control: LightControl, display: number): string {
    const rounded = control.step < 1 ? display.toFixed(2) : Math.round(display).toString()
    return control.unit ? `${rounded}${control.unit}` : rounded
  }

  private modeRow (): HTMLElement {
    const row     = document.createElement('div')
    row.className = 'dialog-row'
    row.innerHTML = '<span>Gizmo</span>'

    const group     = document.createElement('div')
    group.className = 'seg'

    const modes: { mode: LightMode, label: string }[] = [
      { mode: 'move', label: 'Move' },
      { mode: 'aim', label: 'Aim' },
    ]
    for (const { mode, label } of modes) {
      const button       = document.createElement('button')
      button.textContent = label
      button.addEventListener('click', () => {
        this.setMode(mode)
        this.callbacks.onMode(mode)
      })
      this.modeButtons.set(mode, button)
      group.appendChild(button)
    }
    row.appendChild(group)
    return row
  }

  private colorRow (): HTMLElement {
    const row     = document.createElement('label')
    row.className = 'dialog-row'
    row.innerHTML = '<span>Colour</span>'

    const input     = document.createElement('input')
    input.type      = 'color'
    input.className = 'color-input'
    input.addEventListener('input', () => {
      if (this.current)
        this.callbacks.onChange({ color: parseInt(input.value.slice(1), 16) })
    })
    row.appendChild(input)
    return row
  }

  private sliderRow (control: LightControl): HTMLElement {
    const row     = document.createElement('div')
    row.className = 'dialog-row'
    row.innerHTML = `<span>${control.label}</span>`

    const wrap     = document.createElement('div')
    wrap.className = 'slider-wrap'

    const input     = document.createElement('input')
    input.type      = 'range'
    input.className = 'slider'
    input.min       = String(control.min)
    input.max       = String(control.max)
    input.step      = String(control.step)

    const value     = document.createElement('span')
    value.className = 'slider-value'

    input.addEventListener('input', () => {
      if (!this.current)
        return

      const display     = parseFloat(input.value)
      const stored      = control.fromDisplay ? control.fromDisplay(display) : display
      value.textContent = this.format(control, display)
      this.callbacks.onChange({ [control.key]: stored })
    })

    wrap.append(input, value)
    row.appendChild(wrap)
    this.sliders.set(control.key, { input, value })
    return row
  }
}
