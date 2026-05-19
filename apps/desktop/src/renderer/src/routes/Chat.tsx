import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChatTurn } from '../../../shared/types'

function fmtTs(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function ChatPage() {
  const [history, setHistory] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)

  async function send() {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setErr(null)
    const next: ChatTurn[] = [...history, { role: 'user', content: q }]
    setHistory(next)
    setBusy(true)
    try {
      const r = await window.api.chat.ask(history, q)
      setHistory([...next, { role: 'assistant', content: r.answer, citations: r.citations }])
      setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
      }, 50)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 py-4 border-b border-white/5">
        <h1 className="text-xl font-semibold">Chat with your meetings</h1>
        <p className="text-xs text-ink-400 mt-1">
          Asks across every recorded meeting. Answers cite the segments used.
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto px-8 py-6 space-y-6">
        {history.length === 0 && (
          <div className="text-ink-400 text-sm">
            Try: "What action items did I get last week?" or "Did we agree on a release date?"
          </div>
        )}
        {history.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                'max-w-2xl rounded-xl px-4 py-3 ' +
                (t.role === 'user' ? 'bg-accent-500/15 text-ink-100' : 'bg-ink-800/60 text-ink-100')
              }
            >
              <div className="whitespace-pre-wrap leading-relaxed text-sm">{t.content}</div>
              {t.citations && t.citations.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/10 space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-400">
                    Sources
                  </div>
                  {t.citations.map((c, ci) => (
                    <button
                      key={ci}
                      onClick={() => navigate(`/meeting/${c.meetingId}`)}
                      className="w-full text-left text-xs text-ink-300 hover:text-ink-100 hover:bg-white/5 rounded p-1.5"
                    >
                      <span className="text-ink-400 mr-2">[{ci + 1}]</span>
                      <span className="font-medium">{c.meetingTitle}</span>
                      <span className="text-ink-400"> · {c.speaker} @ {fmtTs(c.start)}</span>
                      <div className="text-ink-400 line-clamp-2 mt-0.5">"{c.text}"</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-xl px-4 py-3 bg-ink-800/60 text-ink-400 text-sm">
              Thinking…
            </div>
          </div>
        )}
        {err && (
          <div className="rounded-xl px-4 py-3 bg-red-500/10 border border-red-500/30 text-sm text-red-200">
            {err}
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-4">
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Ask anything about your past meetings…"
            className="flex-1 bg-ink-800/60 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-white/30"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="px-4 py-2 rounded-lg bg-accent-500 hover:bg-accent-400 disabled:opacity-40 text-white text-sm"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
