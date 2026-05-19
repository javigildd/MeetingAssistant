// Types shared between main, preload, and renderer.

export interface MeetingSummary {
  id: string
  title: string
  startedAt: number
  duration: number
  language: string
  status: 'recording' | 'transcribing' | 'summarizing' | 'ready' | 'failed'
  speakerCount: number
}

export interface Segment {
  start: number
  end: number
  speaker: string
  text: string
  language: string
}

export interface ActionItem {
  text: string
  owner?: string
  due?: string
}

export interface Meeting {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  duration: number
  language: string
  status: MeetingSummary['status']
  meetingDir: string
  summaryMd: string | null
  actionItems: ActionItem[]
  decisions: string[]
  topics: string[]
  segments: Segment[]
  speakers: string[]
  speakerAliases: Record<string, string>
  errorMessage?: string | null
}

export interface ChatCitation {
  meetingId: string
  meetingTitle: string
  segmentIndex: number
  start: number
  end: number
  speaker: string
  text: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  citations?: ChatCitation[]
}

export interface Settings {
  openaiKey: string
  pythonPath: string
  whisperModel: string
  computeType: string
  language: 'auto' | 'es' | 'en'
  hfToken: string
  dataDir: string
  /** When true, a toast appears in the corner when a call is detected. */
  callDetectionEnabled: boolean
}

export type RecorderEvent =
  | { type: 'starting'; meetingId: string }
  | { type: 'recording'; meetingId: string }
  | { type: 'pipeline-progress'; meetingId: string; stage: string; message?: string }
  | { type: 'ready'; meetingId: string }
  | { type: 'failed'; meetingId: string; message: string }

export interface CapturableWindow {
  id: number
  app: string
  title: string
  bundleId: string
  width: number
  height: number
  isLikelyMeeting: boolean
}

export interface DetectedCall {
  key: string
  windowId: number
  platform:
    | 'slack-huddle'
    | 'zoom'
    | 'google-meet'
    | 'whatsapp'
    | 'teams'
    | 'facetime'
    | 'webex'
    | 'unknown'
  appName: string
  windowTitle: string
  callerLabel: string | null
  firstSeenAt: number
}
