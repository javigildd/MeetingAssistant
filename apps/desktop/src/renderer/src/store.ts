import { create } from 'zustand'
import type { MeetingSummary, Settings } from '../../shared/types'

interface RecordingState {
  meetingId: string | null
  startedAt: number | null
  micStarted: boolean
  systemStarted: boolean
  lastStatus: string
  lastError: string | null
}

interface AppState {
  meetings: MeetingSummary[]
  settings: Settings | null
  recording: RecordingState
  pipelineStatus: { meetingId: string; stage: string; message?: string } | null

  setMeetings(m: MeetingSummary[]): void
  setSettings(s: Settings): void
  setRecording(r: Partial<RecordingState>): void
  resetRecording(): void
  setPipeline(p: AppState['pipelineStatus']): void
}

const emptyRecording: RecordingState = {
  meetingId: null,
  startedAt: null,
  micStarted: false,
  systemStarted: false,
  lastStatus: '',
  lastError: null
}

export const useStore = create<AppState>((set) => ({
  meetings: [],
  settings: null,
  recording: emptyRecording,
  pipelineStatus: null,

  setMeetings: (m) => set({ meetings: m }),
  setSettings: (s) => set({ settings: s }),
  setRecording: (r) => set((s) => ({ recording: { ...s.recording, ...r } })),
  resetRecording: () => set({ recording: emptyRecording }),
  setPipeline: (p) => set({ pipelineStatus: p })
}))

export async function refreshMeetings() {
  const list = await window.api.meetings.list()
  useStore.getState().setMeetings(list)
}

export async function refreshSettings() {
  const s = await window.api.settings.get()
  useStore.getState().setSettings(s)
}
