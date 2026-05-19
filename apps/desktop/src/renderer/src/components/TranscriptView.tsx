import { useMemo, useState } from 'react'
import type { Meeting, Segment } from '../../../shared/types'
import SpeakerChip from './SpeakerChip'

function fmtTs(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function groupSegments(segments: Segment[]): Segment[][] {
  const out: Segment[][] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (last && last[0].speaker === s.speaker && s.start - last[last.length - 1].end < 8) {
      last.push(s)
    } else {
      out.push([s])
    }
  }
  return out
}

export default function TranscriptView({
  meeting,
  onRename
}: {
  meeting: Meeting
  onRename: (orig: string, name: string) => void
}) {
  const groups = useMemo(() => groupSegments(meeting.segments), [meeting.segments])
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const aliases = meeting.speakerAliases

  function startRename(spk: string) {
    setEditing(spk)
    setDraft(aliases[spk] || '')
  }
  function commit() {
    if (editing) onRename(editing, draft)
    setEditing(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-ink-400">Speakers:</span>
        {meeting.speakers.map((s) => (
          <button
            key={s}
            onClick={() => startRename(s)}
            className="no-drag"
            title="Click to rename"
          >
            <SpeakerChip speaker={s} alias={aliases[s]} />
          </button>
        ))}
      </div>

      {editing && (
        <div className="flex items-center gap-2 bg-ink-800/60 border border-white/10 rounded p-2">
          <span className="text-xs text-ink-400">Rename {editing} to:</span>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(null)
            }}
            className="flex-1 bg-ink-900 border border-white/10 rounded px-2 py-1 text-sm"
            placeholder="e.g. Maria"
          />
          <button
            onClick={commit}
            className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(null)}
            className="text-xs px-2 py-1 rounded hover:bg-white/5"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="space-y-5">
        {groups.map((g, gi) => (
          <div key={gi} className="flex gap-3">
            <div className="w-16 flex-shrink-0 text-[11px] text-ink-400 font-mono pt-1">
              {fmtTs(g[0].start)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="mb-1">
                <SpeakerChip speaker={g[0].speaker} alias={aliases[g[0].speaker]} />
              </div>
              <div className="text-ink-100 leading-relaxed">
                {g.map((s, i) => (
                  <span key={i}>
                    {s.text}
                    {i < g.length - 1 ? ' ' : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
