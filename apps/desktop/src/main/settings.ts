import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Settings } from '../shared/types'

const SETTINGS_FILE = 'settings.json'

const DEFAULTS: Settings = {
  openaiKey: '',
  pythonPath: '',
  whisperModel: 'large-v3',
  computeType: 'int8',
  language: 'auto',
  hfToken: '',
  dataDir: path.join(os.homedir(), 'MeetingAssistant')
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/** Find the repo root and parse its .env if present. Used to seed settings
 * on first run so users don't have to retype what's already in .env. */
function loadDotEnv(): Record<string, string> {
  const candidates = [
    path.resolve(app.getAppPath(), '..', '..', '.env'),
    path.resolve(app.getAppPath(), '.env')
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      const out: Record<string, string> = {}
      for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        // Strip surrounding quotes if any.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        if (key) out[key] = value
      }
      return out
    } catch {
      // ignore
    }
  }
  return {}
}

function fromEnv(env: Record<string, string>): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (env.MA_PYTHON) out.pythonPath = env.MA_PYTHON
  if (env.OPENAI_API_KEY) out.openaiKey = env.OPENAI_API_KEY
  if (env.HUGGINGFACE_TOKEN) out.hfToken = env.HUGGINGFACE_TOKEN
  if (env.MA_WHISPER_MODEL) out.whisperModel = env.MA_WHISPER_MODEL
  if (env.MA_COMPUTE_TYPE) out.computeType = env.MA_COMPUTE_TYPE
  if (env.MA_DATA_DIR) out.dataDir = env.MA_DATA_DIR
  return out
}

export function loadSettings(): Settings {
  const file = settingsPath()
  const fromDisk: Partial<Settings> = (() => {
    if (!fs.existsSync(file)) return {}
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>
    } catch {
      return {}
    }
  })()
  const envSeed = fromEnv({ ...loadDotEnv(), ...(process.env as any) })
  // Disk > env > defaults, but for empty disk strings, fall through to env.
  const merged: Settings = { ...DEFAULTS, ...envSeed, ...fromDisk }
  // If a stored field is empty, prefer the env value.
  for (const k of Object.keys(envSeed) as (keyof Settings)[]) {
    if (!merged[k] && envSeed[k]) (merged as any)[k] = envSeed[k]
  }
  return merged
}

export function saveSettings(next: Partial<Settings>): Settings {
  const current = loadSettings()
  const merged = { ...current, ...next }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2))
  return merged
}

export function ensureDataDir(s: Settings): string {
  const dir = s.dataDir || DEFAULTS.dataDir
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'meetings'), { recursive: true })
  return dir
}

export function defaultsForUI(): Settings {
  return { ...DEFAULTS }
}
