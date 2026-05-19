import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'

export default function Home() {
  const meetings = useStore((s) => s.meetings)
  const recording = useStore((s) => s.recording)
  const navigate = useNavigate()

  return (
    <div className="px-12 py-10 max-w-4xl mx-auto">
      <h1 className="text-3xl font-semibold text-ink-100 mb-2">MeetingAssistant</h1>
      <p className="text-ink-400 mb-8">
        Local recording, transcription with speakers, summary, and chat over your history.
      </p>

      {recording.meetingId && (
        <div
          onClick={() => navigate('/recording')}
          className="mb-6 cursor-pointer rounded-xl border border-accent-500/30 bg-accent-500/10 p-4 flex items-center gap-3"
        >
          <span className="w-3 h-3 rounded-full bg-accent-400 animate-record" />
          <div className="text-sm text-accent-100">
            Recording in progress · click to open
          </div>
        </div>
      )}

      <section className="mb-8">
        <h2 className="text-sm uppercase tracking-wider text-ink-400 mb-3">Recent meetings</h2>
        {meetings.length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-ink-800/50 p-6 text-ink-400">
            No meetings yet. Hit{' '}
            <span className="px-2 py-0.5 rounded bg-accent-500/20 text-accent-300">
              Record a meeting
            </span>{' '}
            in the sidebar to start.
          </div>
        ) : (
          <div className="space-y-2">
            {meetings.slice(0, 8).map((m) => (
              <button
                key={m.id}
                onClick={() => navigate(`/meeting/${m.id}`)}
                className="w-full text-left rounded-lg border border-white/5 bg-ink-800/40 hover:bg-ink-800 p-4 flex items-center justify-between"
              >
                <div>
                  <div className="text-ink-100 font-medium">{m.title}</div>
                  <div className="text-xs text-ink-400 mt-1">
                    {new Date(m.startedAt).toLocaleString()} · {Math.round(m.duration / 60)} min
                    · {m.speakerCount} speakers · {m.language}
                  </div>
                </div>
                <div className="text-xs text-ink-400">
                  {m.status !== 'ready' ? m.status : '→'}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
