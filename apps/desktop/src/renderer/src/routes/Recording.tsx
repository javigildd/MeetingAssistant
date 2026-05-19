import { useEffect, useState } from 'react'
import { useStore } from '../store'

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function Recording() {
  const recording = useStore((s) => s.recording)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(i)
  }, [])

  const elapsed = recording.startedAt ? (Date.now() - recording.startedAt) / 1000 : 0

  return (
    <div className="px-12 py-10 max-w-3xl mx-auto">
      {!recording.meetingId ? (
        <div className="text-ink-300">No active recording. Press the Record button in the sidebar.</div>
      ) : (
        <div className="space-y-8">
          <div className="text-center pt-12">
            <div className="inline-flex items-center gap-3 mb-3">
              <span className="w-3 h-3 rounded-full bg-accent-400 animate-record" />
              <span className="text-sm text-accent-300 uppercase tracking-wider">Recording</span>
            </div>
            <div className="text-6xl font-light text-ink-100 font-mono tabular-nums">
              {fmtDuration(elapsed)}
            </div>
            <div className="text-sm text-ink-400 mt-2">
              MeetingAssistant captures your microphone and the audio coming out of this Mac on
              two separate tracks.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-white/5 bg-ink-800/40 p-4">
              <div className="text-xs uppercase tracking-wider text-ink-400 mb-2">Microphone</div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    'w-2 h-2 rounded-full ' +
                    (recording.micStarted ? 'bg-green-400' : 'bg-ink-400 animate-pulse')
                  }
                />
                <span className="text-sm">{recording.micStarted ? 'Active' : 'Initializing…'}</span>
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-ink-800/40 p-4">
              <div className="text-xs uppercase tracking-wider text-ink-400 mb-2">System audio</div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    'w-2 h-2 rounded-full ' +
                    (recording.systemStarted ? 'bg-green-400' : 'bg-ink-400 animate-pulse')
                  }
                />
                <span className="text-sm">
                  {recording.systemStarted
                    ? 'Active (ScreenCaptureKit)'
                    : 'Waiting for permission…'}
                </span>
              </div>
            </div>
          </div>

          {recording.lastError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
              {recording.lastError}
            </div>
          )}

          <div className="text-xs text-ink-400 leading-relaxed">
            First time? macOS will ask for <strong>Screen Recording</strong> and{' '}
            <strong>Microphone</strong> permission. Grant both, then start a new recording — once
            permissions are granted you won't be asked again.
          </div>
        </div>
      )}
    </div>
  )
}
