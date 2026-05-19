import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DetectedCall } from '../../../shared/types'
import { refreshMeetings, useStore } from '../store'

const PLATFORM_LABEL: Record<DetectedCall['platform'], string> = {
  'slack-huddle': 'Slack Huddle',
  zoom: 'Zoom',
  'google-meet': 'Google Meet',
  whatsapp: 'WhatsApp call',
  teams: 'Microsoft Teams',
  facetime: 'FaceTime',
  webex: 'Webex',
  unknown: 'Meeting'
}

const PLATFORM_ICON: Record<DetectedCall['platform'], string> = {
  'slack-huddle': '💬',
  zoom: '🎦',
  'google-meet': '🟢',
  whatsapp: '💚',
  teams: '🟣',
  facetime: '🟦',
  webex: '🟧',
  unknown: '🎙'
}

export default function CallToast() {
  const [calls, setCalls] = useState<DetectedCall[]>([])
  const recording = useStore((s) => s.recording)
  const setRecording = useStore((s) => s.setRecording)
  const navigate = useNavigate()

  useEffect(() => {
    window.api.calls.current().then(setCalls)
    const off = window.api.events.onCallUpdate((evt) => setCalls(evt.calls))
    return () => {
      off()
    }
  }, [])

  if (recording.meetingId) return null
  if (calls.length === 0) return null

  async function startFromCall(c: DetectedCall) {
    const niceTitle = c.callerLabel ? c.callerLabel : `${PLATFORM_LABEL[c.platform]}`
    try {
      const r = await window.api.recording.start({
        windowId: c.windowId,
        title: niceTitle,
        callKey: c.key
      })
      setRecording({
        meetingId: r.meetingId,
        startedAt: Date.now(),
        lastStatus: 'starting',
        lastError: null
      })
      navigate('/recording')
      await refreshMeetings()
    } catch (err) {
      console.error('start from call failed:', err)
    }
  }

  function dismiss(c: DetectedCall) {
    window.api.calls.dismiss(c.key)
    setCalls((cs) => cs.filter((x) => x.key !== c.key))
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 space-y-2 max-w-sm">
      {calls.map((c) => (
        <div
          key={c.key}
          className="bg-ink-800/95 backdrop-blur border border-accent-500/30 rounded-xl shadow-2xl p-3 flex items-start gap-3 animate-[fadeIn_0.2s]"
        >
          <div className="text-xl flex-shrink-0">{PLATFORM_ICON[c.platform]}</div>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wider text-accent-300 mb-0.5">
              {PLATFORM_LABEL[c.platform]} detected
            </div>
            <div className="text-sm text-ink-100 truncate">
              {c.callerLabel || c.windowTitle || c.appName}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => startFromCall(c)}
                className="text-xs px-2.5 py-1 rounded bg-accent-500 hover:bg-accent-400 text-white"
              >
                ● Record this call
              </button>
              <button
                onClick={() => dismiss(c)}
                className="text-xs px-2.5 py-1 rounded text-ink-300 hover:bg-white/5 hover:text-ink-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
