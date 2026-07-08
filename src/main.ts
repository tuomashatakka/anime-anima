import './style.css'
import { VRMViewer } from './viewer'
import { InteractionCoordinator } from './interaction'
import { FurniturePanel, LightPanel, SettingsDialog, Toolbar } from './ui'
import { loadCatalog } from './manifest'
import { loadString, saveString } from './storage'
import type { AnimationEntry, ModelEntry } from './types'
import * as s from 'threejs-scenes'

// @ts-expect-error debug
window.__scenes = s


const loadingEl = document.getElementById('loading')!
let pending = 0

function setBusy (busy: boolean) {
  pending = Math.max(0, pending + (busy ? 1 : -1))
  loadingEl.classList.toggle('visible', pending > 0)
}

async function main () {
  const canvas = document.getElementById('scene') as HTMLCanvasElement
  const viewer = new VRMViewer(canvas)

  const toolbar = new Toolbar({
    onModelPick:      entry => void selectModel(entry),
    onAnimationPick:  entry => void selectAnimation(entry),
    onAnimationClear: () => {
      toolbar.setActiveAnimation(null)
      viewer.clearSelection()
    },
    onLightingPick: preset => viewer.setLighting(preset),
  })

  // Reflect the persisted lighting preset the viewer restored on construction.
  toolbar.setActiveLighting(viewer.getLighting())


  new SettingsDialog({
    onFps:        on => viewer.setFpsVisible(on),
    onPost:       on => viewer.setPostProcessing(on),
    onResolution: scale => viewer.setResolutionScale(scale),
    onGrade:      grade => viewer.setColorGrade(grade),
  })

  // Resolution / post-processing defaults (0.67×, post on) are applied by the
  // SettingsDialog from persisted localStorage state, so no hardcoded setup here.

  // Furniture: a drag-and-drop placement system with on-floor move/rotate gizmos.
  const furniture             = viewer.createFurnitureManager()
  const removeBtn             = document.getElementById('furniture-remove') as HTMLButtonElement
  furniture.onSelectionChange = has => removeBtn.classList.toggle('visible', has)
  removeBtn.addEventListener('click', () => furniture.removeSelected())

  // Furniture <-> avatar coordinator: feeds the avatar furniture footprints as
  // collision obstacles and settles it onto seats / beds when it rests nearby.
  const coordinator = new InteractionCoordinator(viewer.getCharacter(), furniture)
  coordinator.start()

  new FurniturePanel(
    document.getElementById('btn-furniture') as HTMLButtonElement,
    item => furniture.beginPlacement(item),
  )

  // Wall tool: toggled from the toolbar; draws grid-snapped walls and selects
  // connected runs. Keep the toolbar button's pressed-state + label in sync.
  const wallTool          = viewer.createWallTool()
  const wallButton        = document.getElementById('btn-walls') as HTMLButtonElement
  const wallLabel         = document.getElementById('current-walls')!
  wallTool.onActiveChange = active => {
    wallButton.setAttribute('aria-pressed', String(active))
    wallLabel.textContent = active ? 'On' : 'Off'
  }
  wallButton.addEventListener('click', event => {
    event.stopPropagation()
    wallTool.toggle()
  })

  // Movable / aimable spotlights: a toggleable editor driving a TransformControls
  // gizmo. While it's active the furniture manager goes dormant so the two
  // pointer editors never fight over the same gesture.
  const lights      = viewer.createLightManager()
  const lightButton = document.getElementById('btn-lights') as HTMLButtonElement
  const lightLabel  = document.getElementById('current-lights')!
  const lightPanel  = new LightPanel({
    onAdd:    () => lights.addSpotlight(),
    onRemove: () => lights.removeSelected(),
    onMode:   mode => lights.setMode(mode),
    onChange: partial => lights.updateSelected(partial),
  })
  lights.onActiveChange = active => {
    lightButton.setAttribute('aria-pressed', String(active))
    lightLabel.textContent       = active ? 'On' : 'Off'
    furniture.interactionEnabled = !active
    lightPanel.setActive(active)
  }
  lights.onSelectionChange = record => lightPanel.setSelected(record)
  lights.onModeChange      = mode => lightPanel.setMode(mode)
  lightButton.addEventListener('click', event => {
    event.stopPropagation()
    lights.toggle()
  })
  lightPanel.setMode(lights.getMode())

  async function selectModel (entry: ModelEntry) {
    toolbar.setActiveModel(entry)
    saveString('model', entry.url)
    setBusy(true)
    try {
      await viewer.loadModel(entry)
    }
    catch (error) {
      console.error('Failed to load model', entry, error)
    }
    finally {
      setBusy(false)
    }
  }

  async function selectAnimation (entry: AnimationEntry) {
    toolbar.setActiveAnimation(entry)
    setBusy(true)
    try {
      await viewer.playAnimation(entry)
    }
    catch (error) {
      console.error('Failed to load animation', entry, error)
    }
    finally {
      setBusy(false)
    }
  }

  setBusy(true)
  try {
    const catalog = await loadCatalog()
    toolbar.setModels(catalog.models)
    toolbar.setAnimations(catalog.animations)
    viewer.setAvailableAnimations(catalog.animations)

    // Restore the last-used model if it's still in the catalog, else the first.
    // Animation is left deselected so the model plays random idles automatically.
    const savedUrl   = loadString('model')
    const firstModel = catalog.models.find(model => model.url === savedUrl) ?? catalog.models[0]
    if (firstModel)
      await selectModel(firstModel)
    toolbar.setActiveAnimation(null)
  }
  catch (error) {
    console.error(error)
    loadingEl.textContent = error instanceof Error ? error.message : 'Failed to load assets'
    loadingEl.classList.add('visible')
    return
  }
  finally {
    setBusy(false)
  }
}

void main()
