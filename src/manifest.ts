import type { AnimationEntry, AnimationKind, AssetManifest, ModelEntry } from './types'


const BASE         = import.meta.env.BASE_URL
const MANIFEST_URL = `${BASE}vrm-assets/manifest.json`

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

export async function loadCatalog (): Promise<AssetCatalog> {
  const response = await fetch(MANIFEST_URL)
  if (!response.ok)
    throw new Error(`Could not load asset manifest (${response.status}). Run \`npm run download-assets\` first.`)

  const manifest = await response.json() as AssetManifest

  const models: ModelEntry[] = (manifest.models ?? [])
    .map(url => ({ name: prettify(url), url: withBase(url) }))
    .sort((a, b) => a.name.localeCompare(b.name))

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
    .map(url => {
      const kind = kindOf(url)
      return kind ? { name: prettify(url, [ 'action_', 'motion_' ]), url: withBase(url), kind } : null
    })
    .filter((entry): entry is AnimationEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return { models, animations }
}
