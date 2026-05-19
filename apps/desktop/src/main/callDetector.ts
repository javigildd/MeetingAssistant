import { listCapturableWindows, type CapturableWindow } from './recorder'

export interface DetectedCall {
  /** Stable identifier for de-duplication: window id + platform. */
  key: string
  windowId: number
  platform: 'slack-huddle' | 'zoom' | 'google-meet' | 'whatsapp' | 'teams' | 'facetime' | 'webex' | 'unknown'
  appName: string
  windowTitle: string
  /** Best-effort guess of the other party / meeting name from the window title. */
  callerLabel: string | null
  /** When this call was first observed. */
  firstSeenAt: number
}

/** Heuristics that classify a window as a video call. Order matters — first match wins. */
interface Pattern {
  platform: DetectedCall['platform']
  bundleIdMatch: RegExp
  titleMatch: RegExp
  /** Pull a human label (caller / meeting name) out of the title. */
  extractLabel: (title: string) => string | null
}

const PATTERNS: Pattern[] = [
  // ---- Slack Huddle ----
  {
    platform: 'slack-huddle',
    bundleIdMatch: /com\.tinyspeck\.slackmacgap/i,
    // "Huddle in #marketing" / "Huddle with Carlos Pérez" / "<name> is calling you on Slack"
    titleMatch: /huddle|is calling you/i,
    extractLabel: (title) => {
      const withMatch = title.match(/huddle\s+with\s+(.+?)(?:\s*[-–—|]\s*Slack)?$/i)
      if (withMatch) return withMatch[1].trim()
      const inMatch = title.match(/huddle\s+in\s+(#?[^\s|]+)/i)
      if (inMatch) return `Huddle in ${inMatch[1].trim()}`
      const callingMatch = title.match(/^(.+?)\s+is calling you/i)
      if (callingMatch) return callingMatch[1].trim()
      return null
    }
  },
  // ---- Zoom ----
  {
    platform: 'zoom',
    bundleIdMatch: /us\.zoom\.xos/i,
    titleMatch: /zoom meeting|meeting in progress/i,
    extractLabel: (title) => {
      // "Zoom Meeting - Project sync"
      const m = title.match(/zoom meeting\s*[-–—:]\s*(.+)$/i)
      return m ? m[1].trim() : null
    }
  },
  // ---- Google Meet (browser tab) ----
  {
    platform: 'google-meet',
    bundleIdMatch: /chrome|safari|arc|brave|edge|firefox|vivaldi/i,
    // Chrome titles tabs like "Meet — xyz-abcd-efg" or "Meet – Project sync"
    titleMatch: /\bmeet\b\s*[—–-]/i,
    extractLabel: (title) => {
      const m = title.match(/\bmeet\b\s*[—–-]\s*(.+?)(?:\s*[-–—|]\s*(?:Google Chrome|Safari|Arc|Brave|Edge|Firefox))?$/i)
      if (!m) return null
      const label = m[1].trim()
      // Skip generic codes like "abc-defg-hij"
      if (/^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$/i.test(label)) return null
      return label
    }
  },
  // ---- Microsoft Teams ----
  {
    platform: 'teams',
    bundleIdMatch: /com\.microsoft\.teams/i,
    titleMatch: /meeting|calling|call with/i,
    extractLabel: (title) => {
      const m = title.match(/call with\s+(.+?)(?:\s*[-–—|].*)?$/i)
      return m ? m[1].trim() : null
    }
  },
  // ---- WhatsApp ----
  {
    platform: 'whatsapp',
    bundleIdMatch: /whatsapp/i,
    titleMatch: /\bcall\b|llamada/i,
    extractLabel: (title) => {
      // "Call with John" / "Voice call - John" / "Llamada con Juan"
      const m =
        title.match(/(?:call with|llamada con|voice call\s*[-–—:]?\s*|video call\s*[-–—:]?\s*)(.+?)(?:\s*[-–—|].*)?$/i)
      return m ? m[1].trim() : null
    }
  },
  // ---- Webex ----
  {
    platform: 'webex',
    bundleIdMatch: /com\.webex/i,
    titleMatch: /webex meeting|meeting/i,
    extractLabel: () => null
  },
  // ---- FaceTime ----
  {
    platform: 'facetime',
    bundleIdMatch: /com\.apple\.FaceTime/i,
    titleMatch: /facetime/i,
    extractLabel: (title) => {
      const m = title.match(/facetime\s*[-–—:]\s*(.+)$/i)
      return m ? m[1].trim() : null
    }
  }
]

function classify(w: CapturableWindow): DetectedCall | null {
  for (const p of PATTERNS) {
    if (!p.bundleIdMatch.test(w.bundleId || '')) continue
    if (!p.titleMatch.test(w.title || '')) continue
    return {
      key: `${p.platform}:${w.id}`,
      windowId: w.id,
      platform: p.platform,
      appName: w.app,
      windowTitle: w.title,
      callerLabel: p.extractLabel(w.title || ''),
      firstSeenAt: Date.now()
    }
  }
  return null
}

/**
 * Polls macOS windows periodically and emits onChange when the set of active
 * calls changes. Calls that the user dismissed are suppressed until they end
 * and reappear.
 */
export class CallDetector {
  private intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private active: Map<string, DetectedCall> = new Map()
  private dismissed: Set<string> = new Set()
  private onUpdate: (calls: DetectedCall[]) => void

  constructor(onUpdate: (calls: DetectedCall[]) => void, intervalMs = 8_000) {
    this.intervalMs = intervalMs
    this.onUpdate = onUpdate
  }

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Mark a detected call as dismissed by the user; won't surface again until it disappears. */
  dismiss(key: string): void {
    this.dismissed.add(key)
    this.active.delete(key)
    this.emit()
  }

  /** Force a re-scan now (e.g. right after a recording stops). */
  refreshNow(): void {
    this.tick()
  }

  private tick(): void {
    let windows: CapturableWindow[] = []
    try {
      windows = listCapturableWindows()
    } catch {
      return
    }

    const seenKeys = new Set<string>()
    const newCalls: DetectedCall[] = []

    for (const w of windows) {
      const c = classify(w)
      if (!c) continue
      seenKeys.add(c.key)
      if (!this.active.has(c.key) && !this.dismissed.has(c.key)) {
        this.active.set(c.key, c)
        newCalls.push(c)
      }
    }

    // Remove calls whose windows are gone, and clear their dismissal so they can fire again next time.
    for (const key of [...this.active.keys()]) {
      if (!seenKeys.has(key)) {
        this.active.delete(key)
        this.dismissed.delete(key)
      }
    }
    for (const key of [...this.dismissed]) {
      if (!seenKeys.has(key)) {
        this.dismissed.delete(key)
      }
    }

    if (newCalls.length > 0) {
      this.emit()
    }
  }

  private emit(): void {
    this.onUpdate(Array.from(this.active.values()))
  }
}
