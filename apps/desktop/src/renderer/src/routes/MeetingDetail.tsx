import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Meeting } from '../../../shared/types'
import TranscriptView from '../components/TranscriptView'
import SpeakerChip from '../components/SpeakerChip'
import Markdown from '../components/Markdown'
import { refreshMeetings, useStore } from '../store'

type Tab = 'summary' | 'transcript' | 'actions'

export default function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [tab, setTab] = useState<Tab>('summary')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const pipelineStatus = useStore((s) => s.pipelineStatus)
  const navigate = useNavigate()

  useEffect(() => {
    let cancel = false
    async function load() {
      if (!id) return
      const m = await window.api.meetings.get(id)
      if (!cancel) setMeeting(m)
    }
    load()
    return () => {
      cancel = true
    }
  }, [id, pipelineStatus?.stage])

  if (!meeting) {
    return <div className="px-12 py-10 text-ink-400">Loading…</div>
  }

  const isProcessing =
    meeting.status === 'transcribing' ||
    meeting.status === 'summarizing' ||
    meeting.status === 'recording'

  async function renameSpeaker(orig: string, name: string) {
    if (!id) return
    const m = await window.api.meetings.renameSpeaker(id, orig, name)
    if (m) setMeeting(m)
  }
  async function commitTitle() {
    if (!id) return
    const next = titleDraft.trim() || meeting!.title
    const m = await window.api.meetings.rename(id, next)
    if (m) setMeeting(m)
    await refreshMeetings()
    setEditingTitle(false)
  }
  async function del() {
    if (!id) return
    if (!confirm('Delete this meeting and all its data?')) return
    await window.api.meetings.delete(id)
    await refreshMeetings()
    navigate('/')
  }

  return (
    <div className="px-12 py-8 max-w-4xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              onBlur={commitTitle}
              className="w-full bg-transparent text-2xl font-semibold border-b border-white/20 outline-none focus:border-white/50 pb-1"
            />
          ) : (
            <h1
              className="text-2xl font-semibold text-ink-100 cursor-text"
              onClick={() => {
                setTitleDraft(meeting.title)
                setEditingTitle(true)
              }}
              title="Click to rename"
            >
              {meeting.title}
            </h1>
          )}
          <div className="text-xs text-ink-400 mt-1 flex flex-wrap gap-3">
            <span>{new Date(meeting.startedAt).toLocaleString()}</span>
            <span>· {Math.round(meeting.duration / 60)} min</span>
            <span>· {meeting.language}</span>
            <span>· {meeting.segments.length} segments</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => window.api.shell.openFolder(meeting.meetingDir)}
            className="text-xs px-2 py-1 rounded hover:bg-white/5 text-ink-300"
            title="Show in Finder"
          >
            📁
          </button>
          <button
            onClick={del}
            className="text-xs px-2 py-1 rounded hover:bg-red-500/20 text-ink-300 hover:text-red-300"
            title="Delete"
          >
            🗑
          </button>
        </div>
      </header>

      {isProcessing && (
        <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
          <div className="font-medium mb-1">Processing…</div>
          <div className="text-yellow-300/80 text-xs">
            {pipelineStatus?.stage || meeting.status}
            {pipelineStatus?.message ? ` — ${pipelineStatus.message}` : ''}
          </div>
        </div>
      )}
      {meeting.status === 'failed' && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          <div className="font-medium mb-1">Failed</div>
          <div className="text-red-300/80 text-xs whitespace-pre-wrap">
            {meeting.errorMessage || 'Unknown error'}
          </div>
        </div>
      )}

      <nav className="flex gap-1 mb-6 border-b border-white/5">
        {(['summary', 'transcript', 'actions'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'px-3 py-2 text-sm capitalize border-b-2 -mb-px ' +
              (tab === t
                ? 'border-accent-500 text-ink-100'
                : 'border-transparent text-ink-400 hover:text-ink-200')
            }
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'summary' && (
        <div className="space-y-6">
          {meeting.topics.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-400 mb-2">Topics</div>
              <div className="flex flex-wrap gap-2">
                {meeting.topics.map((t, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-1 rounded bg-white/5 text-ink-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {meeting.summaryMd ? (
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-400 mb-2">Summary</div>
              <Markdown source={meeting.summaryMd} />
            </div>
          ) : (
            <div className="text-ink-400 text-sm">
              No summary yet. Set your OpenAI key in Settings to enable summaries and chat.
            </div>
          )}
          {meeting.decisions.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-400 mb-2">Decisions</div>
              <ul className="space-y-1 text-ink-200">
                {meeting.decisions.map((d, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-ink-400">·</span>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === 'transcript' && (
        <TranscriptView meeting={meeting} onRename={renameSpeaker} />
      )}

      {tab === 'actions' && (
        <div className="space-y-3">
          {meeting.actionItems.length === 0 ? (
            <div className="text-ink-400 text-sm">No action items detected.</div>
          ) : (
            meeting.actionItems.map((a, i) => (
              <div
                key={i}
                className="rounded-lg border border-white/5 bg-ink-800/40 p-3 flex gap-3 items-start"
              >
                <span className="text-accent-400 mt-0.5">▢</span>
                <div className="flex-1">
                  <div className="text-ink-100">{a.text}</div>
                  <div className="mt-1 flex gap-2 text-xs text-ink-400">
                    {a.owner && (
                      <span>
                        Owner: <SpeakerChip speaker={a.owner} alias={meeting.speakerAliases[a.owner]} />
                      </span>
                    )}
                    {a.due && <span>· Due: {a.due}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
