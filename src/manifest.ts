import type { AnimationEntry, AnimationKind, AssetManifest, ModelEntry } from './types'

const MANIFEST_URL = `${import.meta.env.BASE_URL}vrm-assets/manifest.json`

/** Turn "action_attention_seeking.bvh" into "Attention Seeking". */
function prettify (url: string, stripPrefixes: string[] = []): string {
  let base = url.split('/').pop() ?? url
  base = base.replace(/\.[^.]+$/, '')
  for (const prefix of stripPrefixes)
    if (base.toLowerCase().startsWith(prefix))
      base = base.slice(prefix.length)
  base = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return base.replace(/\b\w/g, char => char.toUpperCase())
}

function kindOf (url: string): AnimationKind | null {
  if (url.toLowerCase().endsWith('.vrma')) return 'vrma'
  if (url.toLowerCase().endsWith('.bvh')) return 'bvh'
  return null
}

export interface AssetCatalog {
  models: ModelEntry[]
  animations: AnimationEntry[]
}

export async function loadCatalog (): Promise<AssetCatalog> {
  const response = await fetch(MANIFEST_URL)
  if (!response.ok)
    throw new Error(`Could not load asset manifest (${response.status}). Run \`npm run download-assets\` first.`)

  const manifest = await response.json() as AssetManifest

  const models: ModelEntry[] = (manifest.models ?? [])
    .map(url => ({ name: prettify(url), url }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // The download script routes every file in `animation_nitral-fork` into the
  // `vrma` bucket regardless of its real extension, so classify by extension
  // rather than trusting the bucket name. De-dupe by URL.
  const seen = new Set<string>()
  const animations: AnimationEntry[] = [
    ...(manifest.animations?.vrma ?? []),
    ...(manifest.animations?.bvh ?? []),
  ]
    .filter(url => {
      if (seen.has(url)) return false
      seen.add(url)
      return true
    })
    .map(url => {
      const kind = kindOf(url)
      return kind ? { name: prettify(url, ['action_', 'motion_']), url, kind } : null
    })
    .filter((entry): entry is AnimationEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return { models, animations }
}
