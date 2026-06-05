#!/usr/bin/env node
/**
 * download-vrm-assets.mts
 *
 * Downloads all VRM models + animations from
 * https://github.com/test157t/VRM-Assets-Pack-For-Silly-Tavern
 * into the local project for use with @pixiv/three-vrm.
 *
 * Usage:
 *   node scripts/download-vrm-assets.mts              # download everything (~213 MB)
 *   node scripts/download-vrm-assets.mts --dry-run    # list what would be downloaded
 *   node scripts/download-vrm-assets.mts --only vrm   # filter by extension (vrm|vrma|bvh|fbx)
 *   GITHUB_TOKEN=ghp_xxx node scripts/...             # optional, avoids API rate limits
 *
 * No dependencies — Node ≥ 22 (global fetch + type stripping).
 * Idempotent: already-downloaded files with matching size are skipped.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, extname, basename, join } from 'node:path'

// #region Config

const REPO       = 'test157t/VRM-Assets-Pack-For-Silly-Tavern'
const BRANCH     = 'main'
const DEST_ROOT  = process.env.VRM_ASSETS_DEST ?? 'public/vrm-assets'
const CONCURRENCY = 6
const MAX_RETRIES = 3

/** repo folder → local destination (relative to DEST_ROOT) */
const DESTINATION_BY_SOURCE = new Map([
  [ 'model',                 'models' ],
  [ 'animation',             'animations/bvh' ],
  [ 'animation_nitral-fork', 'animations/vrma' ],
])

const ALLOWED_EXTENSIONS = new Set([ '.vrm', '.vrma', '.bvh', '.fbx' ])

// #endregion

// #region Types

interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
  size?: number
}

interface AssetEntry {
  sourcePath: string
  destinationPath: string
  publicPath: string
  size: number
}

interface DownloadResult {
  asset: AssetEntry
  status: 'downloaded' | 'skipped' | 'failed'
  error?: string
}

// #endregion

// #region Pure helpers

function isWantedAsset (entry: TreeEntry, extensionFilter: Set<string>): boolean {
  if (entry.type !== 'blob')
    return false
  const folder = entry.path.split('/')[0]
  return DESTINATION_BY_SOURCE.has(folder) && extensionFilter.has(extname(entry.path).toLowerCase())
}

function toAssetEntry (entry: TreeEntry): AssetEntry {
  const folder          = entry.path.split('/')[0]
  const fileName        = basename(entry.path)
  const destinationDir  = DESTINATION_BY_SOURCE.get(folder)!
  const destinationPath = join(DEST_ROOT, destinationDir, fileName)
  const publicPath      = '/' + join(destinationPath).split('/').slice(1).join('/') // strip "public/"

  return { sourcePath: entry.path, destinationPath, publicPath, size: entry.size ?? 0 }
}

function rawUrlFor (sourcePath: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${encodeURI(sourcePath)}`
}

function formatBytes (bytes: number): string {
  return bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`
}

// #endregion

// #region IO

async function fetchRepoTree (): Promise<TreeEntry[]> {
  const headers: Record<string, string> = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}

  const response = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, { headers })
  if (!response.ok)
    throw new Error(`GitHub tree API failed: ${response.status} ${response.statusText}`)

  const { tree } = await response.json() as { tree: TreeEntry[] }
  return tree
}

async function alreadyDownloaded (asset: AssetEntry): Promise<boolean> {
  const existing = await stat(asset.destinationPath).catch(() => null)
  return existing !== null && existing.size === asset.size
}

async function downloadAsset (asset: AssetEntry): Promise<DownloadResult> {
  if (await alreadyDownloaded(asset))
    return { asset, status: 'skipped' }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(rawUrlFor(asset.sourcePath))
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`)

      await mkdir(dirname(asset.destinationPath), { recursive: true })
      await writeFile(asset.destinationPath, Buffer.from(await response.arrayBuffer()))

      console.log(`  ✓ ${asset.sourcePath} (${formatBytes(asset.size)})`)
      return { asset, status: 'downloaded' }
    }
    catch (error) {
      if (attempt === MAX_RETRIES)
        return { asset, status: 'failed', error: String(error) }
      await new Promise(resolve => setTimeout(resolve, attempt * 1500))
    }
  }
  return { asset, status: 'failed', error: 'unreachable' }
}

async function runWithConcurrency <T, R> (items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  const queue = [ ...items ]

  async function worker () {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item !== undefined)
        results.push(await task(item))
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

async function writeManifest (assets: AssetEntry[]) {
  const byCategory = (prefix: string) => assets
    .filter(asset => asset.destinationPath.includes(prefix))
    .map(asset => asset.publicPath)
    .sort()

  const manifest = {
    repo:       `https://github.com/${REPO}`,
    fetchedAt:  new Date().toISOString(),
    models:     byCategory('/models/'),
    animations: {
      vrma: byCategory('/vrma/'),
      bvh:  byCategory('/bvh/'),
    },
  }

  const manifestPath = join(DEST_ROOT, 'manifest.json')
  await mkdir(DEST_ROOT, { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\n  manifest → ${manifestPath}`)
}

// #endregion

// #region Main

async function main () {
  const args     = new Set(process.argv.slice(2))
  const isDryRun = args.has('--dry-run')
  const onlyArg  = process.argv[process.argv.indexOf('--only') + 1]
  const extensionFilter = args.has('--only') && onlyArg
    ? new Set([ `.${onlyArg.replace(/^\./, '')}` ])
    : ALLOWED_EXTENSIONS

  console.log(`Fetching file tree of ${REPO}…`)
  const tree   = await fetchRepoTree()
  const assets = tree.filter(entry => isWantedAsset(entry, extensionFilter)).map(toAssetEntry)
  const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0)

  console.log(`Found ${assets.length} assets (${formatBytes(totalSize)}) → ${DEST_ROOT}\n`)

  if (isDryRun) {
    assets.forEach(asset => console.log(`  ${asset.sourcePath}  →  ${asset.destinationPath}`))
    return
  }

  const results    = await runWithConcurrency(assets, CONCURRENCY, downloadAsset)
  const downloaded = results.filter(result => result.status === 'downloaded')
  const skipped    = results.filter(result => result.status === 'skipped')
  const failed     = results.filter(result => result.status === 'failed')

  await writeManifest(assets)

  console.log(`\nDone: ${downloaded.length} downloaded, ${skipped.length} skipped (already present), ${failed.length} failed`)
  failed.forEach(result => console.error(`  ✗ ${result.asset.sourcePath}: ${result.error}`))
  if (failed.length > 0)
    process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

// #endregion
