import type { AnimationEntry, ModelEntry } from './types'
import { LIGHTING_PRESETS } from './viewer'
import type { LightingPreset } from './viewer'


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
    this.lightingPopover.setActive('studio', 'Studio')

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

export interface SettingsState {
  fps:        boolean
  post:       boolean
  resolution: number
}

export interface SettingsCallbacks {
  onFps:        (on: boolean) => void
  onPost:       (on: boolean) => void
  onResolution: (scale: number) => void
}

const RESOLUTION_OPTIONS = [ 0.2, 0.33, 0.5, 0.67, 1 ]

/** Modal settings dialog opened from the toolbar's gear button. */
export class SettingsDialog {
  private readonly overlay: HTMLDivElement
  private readonly state:   SettingsState = { fps: false, post: false, resolution: 1 }

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
  }

  private buildPanel (): HTMLElement {
    const panel     = document.createElement('div')
    panel.className = 'dialog'
    panel.addEventListener('click', event => event.stopPropagation())
    panel.innerHTML = '<header class="dialog-title">Settings</header>'

    panel.appendChild(this.toggleRow('Display FPS', this.state.fps, on => {
      this.state.fps = on
      this.callbacks.onFps(on)
    }))
    panel.appendChild(this.toggleRow('Post-processing', this.state.post, on => {
      this.state.post = on
      this.callbacks.onPost(on)
    }))
    panel.appendChild(this.resolutionRow())

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
