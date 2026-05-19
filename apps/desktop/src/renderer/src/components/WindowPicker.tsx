import { useEffect, useState } from 'react'
import type { CapturableWindow } from '../../../shared/types'

interface Props {
  open: boolean
  onCancel: () => void
  onPick: (windowId: number | null) => void
}

export default function WindowPicker({ open, onCancel, onPick }: Props) {
  const [windows, setWindows] = useState<CapturableWindow[]>([])
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.api.windows
      .list()
      .then((w) => setWindows(w))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const meetingLike = windows.filter((w) => w.isLikelyMeeting)
  const others = windows.filter((w) => !w.isLikelyMeeting)
  const visible = showAll ? [...meetingLike, ...others] : meetingLike

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-ink-800 border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-ink-100">
            Which window has the meeting?
          </h2>
          <p className="text-xs text-ink-400 mt-1">
            We'll capture this window's video at low FPS to identify participant names. The
            window doesn't need to be in focus — works in the background. Nothing is visible to
            the other participants.
          </p>
        </div>

        <div className="overflow-auto px-3 py-3 flex-1">
          {loading && <div className="text-sm text-ink-400 px-3 py-4">Listing windows…</div>}

          {!loading && meetingLike.length === 0 && !showAll && (
            <div className="px-3 py-4 text-sm text-ink-400">
              No obvious meeting window detected. Click{' '}
              <button
                className="text-ink-100 underline"
                onClick={() => setShowAll(true)}
              >
                show all windows
              </button>{' '}
              to pick one manually.
            </div>
          )}

          {visible.map((w) => (
            <button
              key={w.id}
              onClick={() => onPick(w.id)}
              className="w-full text-left rounded-lg px-3 py-2.5 mb-1 hover:bg-white/5 flex items-center gap-3"
            >
              <span
                className={
                  'w-2 h-2 rounded-full flex-shrink-0 ' +
                  (w.isLikelyMeeting ? 'bg-accent-400' : 'bg-ink-400')
                }
              />
              <div className="flex-1 min-w-0">
                <div className="text-ink-100 text-sm truncate">{w.app}</div>
                <div className="text-xs text-ink-400 truncate">{w.title || '(no title)'}</div>
              </div>
              <div className="text-[10px] text-ink-400 font-mono">
                {w.width}×{w.height}
              </div>
            </button>
          ))}

          {!loading && others.length > 0 && (
            <button
              className="w-full text-left text-xs text-ink-400 hover:text-ink-200 px-3 py-2 mt-2"
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll ? '↑ hide other windows' : `↓ show ${others.length} other window(s)…`}
            </button>
          )}
        </div>

        <div className="px-6 py-3 border-t border-white/5 flex items-center justify-between gap-2">
          <button
            onClick={() => onPick(null)}
            className="text-xs text-ink-300 hover:text-ink-100 px-3 py-1.5 rounded hover:bg-white/5"
          >
            Audio only (no name detection)
          </button>
          <button
            onClick={onCancel}
            className="text-xs text-ink-300 hover:text-ink-100 px-3 py-1.5 rounded hover:bg-white/5"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
