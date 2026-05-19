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

export function loadSettings(): Settings {
  const file = settingsPath()
  if (!fs.existsSync(file)) {
    return { ...DEFAULTS }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
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
