/**
 * Tiny localStorage helpers for persisting UI state (settings + the active VRM)
 * across reloads. All access is wrapped in try/catch so a disabled or full
 * storage never breaks the app — persistence is best-effort.
 */
const PREFIX = 'anime-anima:'

export function loadJSON<T> (key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw)
      return fallback
    return { ...fallback, ...JSON.parse(raw) as Partial<T> }
  }
  catch {
    return fallback
  }
}

export function saveJSON (key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  }
  catch {
    // Ignore — persistence is best-effort.
  }
}

export function loadString (key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  }
  catch {
    return null
  }
}

export function saveString (key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  }
  catch {
    // Ignore — persistence is best-effort.
  }
}
