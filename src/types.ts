export type AnimationKind = 'vrma' | 'bvh'

export type Stance = 'standing' | 'crouching' | 'sitting' | 'lying'
export type Locomotion = 'walk' | 'jog' | 'run' | 'crawl'
export type AnimationCategory = 'locomotion' | 'transition' | 'idle' | 'action'

/** Numeric ordering of stances: standing highest, lying lowest. */
export const STANCE_LEVEL: Record<Stance, number> = { lying: 0, sitting: 1, crouching: 2, standing: 3 }

/** Pose classification for an animation (from public/vrm-assets/classification.json). */
export interface AnimationMeta {
  stance:       Stance
  startStance:  Stance
  endStance:    Stance
  isTransition: boolean
  loopable:     boolean
  locomotion:   Locomotion | null
  category:     AnimationCategory
}

export interface ModelEntry {

  /** Human-friendly display name. */
  name: string

  /** URL to the .vrm file (local under BASE, or an absolute external URL). */
  url: string

  /** Collection / source label shown as a tag in the picker. */
  group?: string

  /** Optional preview image URL. */
  thumbnail?: string
}

/** Shape of public/vrm-assets/external-models.json — curated externally-hosted VRMs. */
export interface ExternalModelsFile {
  note?:  string
  models: { name: string, url: string, group?: string, thumbnail?: string }[]
}

export interface AnimationEntry {

  /** Human-friendly display name. */
  name: string

  /** Public URL to the .vrma / .bvh file. */
  url: string

  /** Detected from the file extension, not the manifest bucket. */
  kind: AnimationKind

  /** Pose classification, attached from classification.json when available. */
  meta?: AnimationMeta
}

/** Shape of public/vrm-assets/classification.json produced by scripts/classify-animations.mts */
export interface ClassificationFile {
  generatedAt: string
  animations:  (AnimationMeta & { url: string, name: string, kind: AnimationKind })[]
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
