import { useEffect, useState } from 'react'
import type { DetectedCall } from '../../../shared/types'

const PLATFORM_LABEL: Record<DetectedCall['platform'], string> = {
  'slack-huddle': 'Slack Huddle',
  zoom: 'Zoom meeting',
  'google-meet': 'Google Meet',
  whatsapp: 'WhatsApp call',
  teams: 'Microsoft Teams',
  facetime: 'FaceTime',
  webex: 'Webex meeting',
  unknown: 'Meeting'
}

const PLATFORM_DOT: Record<DetectedCall['platform'], string> = {
  'slack-huddle': 'bg-purple-400',
  zoom: 'bg-blue-400',
  'google-meet': 'bg-emerald-400',
  whatsapp: 'bg-green-400',
  teams: 'bg-violet-400',
  facetime: 'bg-cyan-400',
  webex: 'bg-orange-400',
  unknown: 'bg-ink-300'
}

export default function Overlay() {
  const [call, setCall] = useState<DetectedCall | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    window.api.calls.current().then((cs) => setCall(cs[0] ?? null))
    const off = window.api.events.onCallUpdate((evt) => {
      setCall(evt.calls[0] ?? null)
    })
    return () => {
      off()
    }
  }, [])

  async function record() {
    if (!call || starting) return
    setStarting(true)
    try {
      await window.api.recording.start({
        windowId: call.windowId,
        title: call.callerLabel ?? PLATFORM_LABEL[call.platform],
        callKey: call.key
      })
    } finally {
      setStarting(false)
    }
  }

  function dismiss() {
    if (!call) return
    window.api.calls.dismiss(call.key)
  }

  if (!call) return null

  const label = call.callerLabel || call.windowTitle || PLATFORM_LABEL[call.platform]

  return (
    <div
      className="h-full w-full flex items-center justify-center p-2"
      // Make the visible card draggable so the user can move the floating
      // overlay around. Buttons override this with no-drag.
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="w-full h-full bg-ink-800/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl flex items-center gap-3 px-4 py-3">
        <div className="flex-shrink-0 relative">
          <div className={`w-9 h-9 rounded-full ${PLATFORM_DOT[call.platform]} flex items-center justify-center`}>
            <span className="text-ink-900 text-base font-semibold">
              {label.charAt(0).toUpperCase()}
            </span>
          </div>
          <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${PLATFORM_DOT[call.platform]} ring-2 ring-ink-800 animate-pulse`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-ink-400">
            {PLATFORM_LABEL[call.platform]}
          </div>
          <div className="text-sm text-ink-100 truncate font-medium">{label}</div>
        </div>

        <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={record}
            disabled={starting}
            className="flex items-center gap-1.5 bg-accent-500 hover:bg-accent-400 disabled:opacity-50 text-white text-xs font-medium px-3 py-2 rounded-lg"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            {starting ? 'Starting…' : 'Record'}
          </button>
          <button
            onClick={dismiss}
            className="text-ink-400 hover:text-ink-100 text-base px-2 py-1.5 rounded hover:bg-white/5"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
