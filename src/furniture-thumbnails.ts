import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'


/**
 * Renders small preview images of furniture GLBs off-screen, so the palette can
 * show real thumbnails instead of glyphs. One tiny dedicated renderer is reused
 * for every model; results are cached as data-URLs keyed by url.
 *
 * Usage: `await thumbnailFor(url, scale)` → a PNG data-URL string (or null on
 * failure, so callers can fall back to a placeholder).
 */
export class ThumbnailRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera:   THREE.PerspectiveCamera
  private readonly loader = new GLTFLoader()
  private readonly cache = new Map<string, string>()

  constructor (size = 132) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setSize(size, size)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x404654, 2.2)
    const key  = new THREE.DirectionalLight(0xffffff, 2.4)
    key.position.set(3, 5, 4)

    const fill = new THREE.DirectionalLight(0x9ab4ff, 0.8)
    fill.position.set(-4, 2, -2)
    this.scene.add(hemi, key, fill)
  }

  /** Render (or return cached) a thumbnail data-URL for a furniture GLB. */
  async render (url: string, scale = 1): Promise<string | null> {
    const cached = this.cache.get(url)
    if (cached)
      return cached

    let gltf
    try {
      gltf = await this.loader.loadAsync(url)
    }
    catch {
      return null
    }

    const model = gltf.scene
    model.scale.setScalar(scale)

    // Centre the model at the origin and frame the camera to its bounding sphere
    // from a flattering 3/4 angle.
    const box    = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    model.position.sub(center)
    this.scene.add(model)

    const radius   = sphere.radius || 1
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.15
    this.camera.position.set(distance * 0.7, distance * 0.55, distance * 0.8)
    this.camera.lookAt(0, 0, 0)

    this.renderer.render(this.scene, this.camera)

    const dataUrl = this.renderer.domElement.toDataURL('image/png')

    this.scene.remove(model)
    disposeModel(model)
    this.cache.set(url, dataUrl)
    return dataUrl
  }

  dispose (): void {
    this.renderer.dispose()
    this.cache.clear()
  }
}

function disposeModel (object: THREE.Object3D): void {
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
