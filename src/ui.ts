import type { AnimationEntry, ModelEntry } from './types'


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
      ? this.items.filter(item => item.label.toLowerCase().includes(needle))
      : this.items

    if (matches.length === 0) {
      const empty       = document.createElement('div')
      empty.className   = 'popover-empty'
      empty.textContent = 'No matches'
      list.appendChild(empty)
      return
    }

    for (const item of matches) {
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
  }

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
}

export class Toolbar {
  private readonly modelPopover:     Popover
  private readonly animationPopover: Popover
  private models:                    ModelEntry[] = []
  private animations:                AnimationEntry[] = []

  constructor (callbacks: ToolbarCallbacks) {
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
    this.modelPopover.setItems(models.map(model => ({ id: model.url, label: model.name })))
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
