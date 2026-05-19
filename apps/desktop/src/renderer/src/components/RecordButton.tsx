import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { refreshMeetings, useStore } from '../store'
import WindowPicker from './WindowPicker'

export default function RecordButton() {
  const navigate = useNavigate()
  const recording = useStore((s) => s.recording)
  const setRecording = useStore((s) => s.setRecording)
  const resetRecording = useStore((s) => s.resetRecording)
  const isRecording = recording.meetingId !== null
  const [pickerOpen, setPickerOpen] = useState(false)

  async function startWithWindow(windowId: number | null) {
    setPickerOpen(false)
    try {
      const r = await window.api.recording.start(windowId ? { windowId } : undefined)
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

  function start() {
    setPickerOpen(true)
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

  return (
    <>
      {isRecording ? (
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
      )}
      <WindowPicker
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onPick={startWithWindow}
      />
    </>
  )
}
