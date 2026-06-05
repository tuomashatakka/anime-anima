/**
 * Fetch the Open Source Avatars registry (https://github.com/ToxSam/open-source-avatars)
 * and write a flat, app-ready catalog to public/vrm-assets/osa-avatars.json.
 *
 * The avatars are CC0 and hosted on Arweave (which serves
 * `access-control-allow-origin: *`), so the app loads each .vrm directly from
 * its arweave URL at runtime — only this lightweight JSON index lives in the repo.
 *
 * Run with:  npm run fetch-osa
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const RAW  = 'https://raw.githubusercontent.com/ToxSam/open-source-avatars/main/data'
const OUT  = resolve('public/vrm-assets/osa-avatars.json')

interface Project {
  id:               string
  name:             string
  creator_id?:      string
  license?:         string
  avatar_data_file: string
}

interface RawAvatar {
  id?:             string
  name?:           string
  model_file_url?: string
  format?:         string
  thumbnail_url?:  string
}

interface OsaAvatar {
  name:       string
  url:        string
  project:    string
  thumbnail?: string
}

async function getJson<T> (url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json() as Promise<T>
}

async function main () {
  const projects = await getJson<Project[]>(`${RAW}/projects.json`)
  console.log(`Found ${projects.length} collections`)

  const avatars: OsaAvatar[] = []
  const seen = new Set<string>()

  for (const project of projects) {
    if (!project.avatar_data_file)
      continue
    let list: RawAvatar[]
    try {
      list = await getJson<RawAvatar[]>(`${RAW}/${project.avatar_data_file}`)
    }
    catch (error) {
      console.warn(`  skip ${project.id}: ${(error as Error).message}`)
      continue
    }

    let added = 0
    for (const raw of list) {
      const url = raw.model_file_url?.trim()
      // Keep VRM models with a usable URL; de-dupe by URL.
      if (!url || (raw.format && raw.format.toUpperCase() !== 'VRM') || seen.has(url))
        continue
      seen.add(url)
      avatars.push({
        name:      (raw.name ?? 'Avatar').trim(),
        url,
        project:   project.name,
        thumbnail: raw.thumbnail_url?.trim() || undefined,
      })
      added++
    }
    console.log(`  ${project.name}: +${added}`)
  }

  avatars.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name))

  const file = {
    source:      'https://github.com/ToxSam/open-source-avatars',
    license:     'CC0 (per-collection; see source)',
    fetchedAt:   new Date().toISOString(),
    count:       avatars.length,
    avatars,
  }
  await writeFile(OUT, JSON.stringify(file, null, 2))
  console.log(`\nWrote ${avatars.length} avatars → ${OUT}`)
}

void main()
