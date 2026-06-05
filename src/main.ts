import './style.css'
import { VRMViewer } from './viewer'
import { Toolbar } from './ui'
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
    onModelPick: entry => void selectModel(entry),
    onAnimationPick: entry => void selectAnimation(entry),
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
      await viewer.applyAnimation(entry)
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

    // Pick a sensible default model + a friendly default animation.
    const firstModel = catalog.models[0]
    if (firstModel) await selectModel(firstModel)

    const defaultAnimation =
      catalog.animations.find(a => /idle|greeting|hello|stand/i.test(a.name)) ??
      catalog.animations[0]
    if (defaultAnimation) await selectAnimation(defaultAnimation)
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
