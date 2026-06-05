import './style.css'
import { VRMViewer } from './viewer'
import { SettingsDialog, Toolbar } from './ui'
import { loadCatalog } from './manifest'
import type { AnimationEntry, ModelEntry } from './types'


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


  new SettingsDialog({
    onFps:        on => viewer.setFpsVisible(on),
    onPost:       on => viewer.setPostProcessing(on),
    onResolution: scale => viewer.setResolutionScale(scale),
  })

  async function selectModel (entry: ModelEntry) {
    toolbar.setActiveModel(entry)
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

    // Load a default model; leave the animation deselected so the model plays
    // random idles automatically (loadModel starts idle when nothing is selected).
    const firstModel = catalog.models[0]
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
