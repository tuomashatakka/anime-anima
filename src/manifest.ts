import type { AnimationEntry, AnimationKind, AnimationMeta, AssetManifest, ClassificationFile, ModelEntry, OsaAvatarsFile } from './types'


const BASE               = import.meta.env.BASE_URL
const MANIFEST_URL       = `${BASE}vrm-assets/manifest.json`
const CLASSIFICATION_URL = `${BASE}vrm-assets/classification.json`
const OSA_URL            = `${BASE}vrm-assets/osa-avatars.json`

// Manifest paths are absolute ("/vrm-assets/…"); prefix them with the app base
//  so they resolve correctly when hosted under a sub-path (e.g. GitHub Pages).
function withBase (path: string): string {
  return BASE.replace(/\/$/, '') + path
}

/** Turn "action_attention_seeking.bvh" into "Attention Seeking". */
function prettify (url: string, stripPrefixes: string[] = []): string {
  let base = url.split('/').pop() ?? url
  base = base.replace(/\.[^.]+$/, '')
  for (const prefix of stripPrefixes)
    if (base.toLowerCase().startsWith(prefix))
      base = base.slice(prefix.length)
  base = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    .trim()
  return base.replace(/\b\w/g, char => char.toUpperCase())
}

function kindOf (url: string): AnimationKind | null {
  if (url.toLowerCase().endsWith('.vrma'))
    return 'vrma'
  if (url.toLowerCase().endsWith('.bvh'))
    return 'bvh'
  return null
}

export interface AssetCatalog {
  models:     ModelEntry[]
  animations: AnimationEntry[]
}

/** Load the pose classification (best-effort) keyed by raw manifest URL. */
async function loadClassification (): Promise<Map<string, AnimationMeta>> {
  const meta = new Map<string, AnimationMeta>()
  try {
    const response = await fetch(CLASSIFICATION_URL)
    if (!response.ok)
      return meta

    const file = await response.json() as ClassificationFile
    for (const item of file.animations) {
      const { url, name: _name, kind: _kind, ...rest } = item
      meta.set(url, rest)
    }
  }
  catch {
    // Classification is optional; fall back to undefined meta.
  }
  return meta
}

/**
 * Open Source Avatars (https://github.com/ToxSam/open-source-avatars): a large
 * CC0 registry hosted on Arweave (CORS-enabled), loaded straight from the
 * committed index and streamed per-VRM at runtime. Best-effort: a missing file
 * just means no external avatars.
 */
async function loadOsaModels (): Promise<ModelEntry[]> {
  try {
    const response = await fetch(OSA_URL)
    if (!response.ok)
      return []

    const file = await response.json() as OsaAvatarsFile
    return file.avatars.map(avatar => ({
      name:      avatar.name,
      url:       avatar.url,
      group:     avatar.project,
      thumbnail: avatar.thumbnail,
    }))
  }
  catch {
    return []
  }
}

export async function loadCatalog (): Promise<AssetCatalog> {
  const response = await fetch(MANIFEST_URL)
  if (!response.ok)
    throw new Error(`Could not load asset manifest (${response.status}). Run \`npm run download-assets\` first.`)

  const manifest  = await response.json() as AssetManifest
  const metaByUrl = await loadClassification()

  // Bundled VRM1 models first (instant load), then the external OSA catalog.
  const local: ModelEntry[] = (manifest.models ?? [])
    .map(url => ({ name: prettify(url), url: withBase(url), group: 'Bundled' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const models: ModelEntry[] = [ ...local, ...await loadOsaModels() ]

  // The download script routes every file in `animation_nitral-fork` into the
  // `vrma` bucket regardless of its real extension, so classify by extension
  // rather than trusting the bucket name. De-dupe by URL.
  const seen                         = new Set<string>()
  const animations: AnimationEntry[] = [
    ...manifest.animations?.vrma ?? [],
    ...manifest.animations?.bvh ?? [],
  ]
    .filter(url => {
      if (seen.has(url))
        return false
      seen.add(url)
      return true
    })
    .map((url): AnimationEntry | null => {
      const kind = kindOf(url)
      return kind
        ? { name: prettify(url, [ 'action_', 'motion_' ]), url: withBase(url), kind, meta: metaByUrl.get(url) }
        : null
    })
    .filter((entry): entry is AnimationEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return { models, animations }
}
