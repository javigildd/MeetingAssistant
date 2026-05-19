import { useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import CallToast from './components/CallToast'
import Home from './routes/Home'
import Recording from './routes/Recording'
import MeetingDetail from './routes/MeetingDetail'
import ChatPage from './routes/Chat'
import SettingsPage from './routes/Settings'
import { refreshMeetings, refreshSettings, useStore } from './store'

export default function App() {
  const setRecording = useStore((s) => s.setRecording)
  const setPipeline = useStore((s) => s.setPipeline)
  const navigate = useNavigate()

  useEffect(() => {
    refreshSettings()
    refreshMeetings()
  }, [])

  useEffect(() => {
    const offRec = window.api.events.onRecorderEvent((evt) => {
      if (evt.status === 'mic_started') setRecording({ micStarted: true })
      if (evt.status === 'system_started') setRecording({ systemStarted: true })
      if (evt.status === 'recording') setRecording({ lastStatus: 'recording' })
      if (evt.status === 'stopping') setRecording({ lastStatus: 'stopping' })
      if (evt.status === 'error') setRecording({ lastError: evt.message })
      if (evt.status === 'system_start_failed')
        setRecording({ lastError: `System audio failed: ${evt.message}` })
    })
    const offPipe = window.api.events.onPipelineEvent((evt) => {
      setPipeline({ meetingId: evt.meetingId, stage: evt.status, message: evt.message })
    })
    const offStatus = window.api.events.onMeetingStatus((evt) => {
      refreshMeetings()
      if (evt.status === 'ready') {
        setPipeline(null)
        navigate(`/meeting/${evt.meetingId}`)
      }
    })
    // Recording started from outside the renderer (system notification).
    const offRecStarted = window.api.events.onRecordingStarted((evt) => {
      setRecording({
        meetingId: evt.meetingId,
        startedAt: Date.now(),
        lastStatus: 'starting',
        lastError: null,
        micStarted: false,
        systemStarted: false
      })
      navigate('/recording')
      refreshMeetings()
    })
    return () => {
      offRec()
      offPipe()
      offStatus()
      offRecStarted()
    }
  }, [setRecording, setPipeline, navigate])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink-900 text-ink-100">
      <Sidebar />
      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="h-9 drag flex-shrink-0" />
        <div className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/recording" element={<Recording />} />
            <Route path="/meeting/:id" element={<MeetingDetail />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
      <CallToast />
    </div>
  )
}
