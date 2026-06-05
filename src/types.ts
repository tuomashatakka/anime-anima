export type AnimationKind = 'vrma' | 'bvh'

export interface ModelEntry {

  /** Human-friendly display name. */
  name: string

  /** Public URL to the .vrm file. */
  url: string
}

export interface AnimationEntry {

  /** Human-friendly display name. */
  name: string

  /** Public URL to the .vrma / .bvh file. */
  url: string

  /** Detected from the file extension, not the manifest bucket. */
  kind: AnimationKind
}

/** Shape of public/vrm-assets/manifest.json produced by scripts/download-vrm-assets.mts */
export interface AssetManifest {
  repo:       string
  fetchedAt:  string
  models:     string[]
  animations: {
    vrma: string[]
    bvh:  string[]
  }
}
