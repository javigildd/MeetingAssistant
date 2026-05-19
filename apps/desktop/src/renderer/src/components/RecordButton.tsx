import { useNavigate } from 'react-router-dom'
import { refreshMeetings, useStore } from '../store'

export default function RecordButton() {
  const navigate = useNavigate()
  const recording = useStore((s) => s.recording)
  const setRecording = useStore((s) => s.setRecording)
  const resetRecording = useStore((s) => s.resetRecording)
  const isRecording = recording.meetingId !== null

  async function start() {
    try {
      const r = await window.api.recording.start()
      setRecording({
        meetingId: r.meetingId,
        startedAt: Date.now(),
        lastStatus: 'starting',
        lastError: null
      })
      navigate('/recording')
    } catch (err) {
      setRecording({ lastError: (err as Error).message })
    }
  }

  async function stop() {
    if (!recording.meetingId) return
    const id = recording.meetingId
    // Snap the UI back immediately. The pipeline keeps running in the
    // background and emits status events that update the sidebar.
    resetRecording()
    navigate(`/meeting/${id}`)
    try {
      await window.api.recording.stop(id)
    } catch (err) {
      console.warn('stop failed:', (err as Error).message)
    }
    await refreshMeetings()
  }

  return isRecording ? (
    <button
      onClick={stop}
      className="no-drag flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-500 text-white rounded-md py-2 text-sm font-medium"
    >
      <span className="w-2 h-2 rounded-full bg-white animate-record"></span>
      Stop recording
    </button>
  ) : (
    <button
      onClick={start}
      className="no-drag flex items-center justify-center gap-2 bg-accent-500 hover:bg-accent-400 text-white rounded-md py-2 text-sm font-medium"
    >
      <span className="w-2 h-2 rounded-full bg-white"></span>
      Record a meeting
    </button>
  )
}
