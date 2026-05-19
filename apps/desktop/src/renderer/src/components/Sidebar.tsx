import { NavLink, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import RecordButton from './RecordButton'

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

const statusBadge = {
  recording: { label: 'rec', cls: 'bg-accent-500/20 text-accent-400' },
  transcribing: { label: 'transcribing…', cls: 'bg-yellow-500/20 text-yellow-300' },
  summarizing: { label: 'summarizing…', cls: 'bg-blue-500/20 text-blue-300' },
  ready: { label: '', cls: '' },
  failed: { label: 'failed', cls: 'bg-red-500/20 text-red-300' }
}

export default function Sidebar() {
  const meetings = useStore((s) => s.meetings)
  const navigate = useNavigate()
  return (
    <aside className="w-64 flex-shrink-0 border-r border-white/5 bg-ink-800/80 flex flex-col">
      <div className="h-9 drag flex-shrink-0" />
      <div className="px-4 py-3 flex flex-col gap-2 no-drag">
        <RecordButton />
        <button
          onClick={() => navigate('/chat')}
          className="text-sm text-ink-300 hover:text-ink-100 text-left px-2 py-1.5 rounded hover:bg-white/5"
        >
          💬 Chat with all meetings
        </button>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            'text-sm text-left px-2 py-1.5 rounded ' +
            (isActive ? 'bg-white/10 text-ink-100' : 'text-ink-300 hover:text-ink-100 hover:bg-white/5')
          }
        >
          ⚙️ Settings
        </NavLink>
      </div>
      <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wider text-ink-400">
        Meetings
      </div>
      <nav className="flex-1 overflow-auto px-2 pb-3">
        {meetings.length === 0 && (
          <div className="px-2 py-6 text-sm text-ink-400">
            No meetings yet.
            <br />
            Press <span className="text-ink-200">Record</span> to start.
          </div>
        )}
        {meetings.map((m) => {
          const badge = statusBadge[m.status as keyof typeof statusBadge]
          return (
            <NavLink
              key={m.id}
              to={`/meeting/${m.id}`}
              className={({ isActive }) =>
                'block rounded px-2 py-2 mb-0.5 text-sm ' +
                (isActive ? 'bg-white/10' : 'hover:bg-white/5')
              }
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-ink-100">{m.title}</div>
                {badge?.label && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>
                    {badge.label}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-ink-400 mt-0.5">
                {fmtRelative(m.startedAt)} · {Math.round(m.duration / 60)} min · {m.speakerCount}{' '}
                spk
              </div>
            </NavLink>
          )
        })}
      </nav>
    </aside>
  )
}
