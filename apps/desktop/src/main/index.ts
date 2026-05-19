import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { loadSettings, saveSettings, ensureDataDir } from './settings'
import {
  initDb,
  createMeeting,
  updateMeetingStatus,
  finalizeMeeting,
  listMeetings,
  getMeeting,
  insertSegments,
  insertEmbeddings,
  renameSpeaker,
  mergeSpeakerAliases,
  updateMeetingTitle,
  deleteMeeting,
  setEmbeddingDim
} from './db'
import { detectSpeakerNames, deleteFrames } from './vision'
import {
  startRecorder,
  stopRecorder,
  listCapturableWindows,
  type RecorderSession
} from './recorder'
import { runPipeline } from './pipeline'
import { summarizeMeeting, embed, chat, chunkSegmentsForRag, EMBED_DIM } from './ai'
import { CallDetector, type DetectedCall } from './callDetector'
import { notifyCallDetected } from './notifications'
import type { Settings, ChatTurn } from '../shared/types'

let mainWindow: BrowserWindow | null = null
const activeRecordings = new Map<string, RecorderSession>()
let callDetector: CallDetector | null = null
let lastCallList: DetectedCall[] = []

/**
 * Runs WhisperX transcription + diarization, then (if an OpenAI key is set)
 * generates summary/action items and embeds segments for RAG. Emits status
 * events for the renderer so the UI can track progress without blocking.
 */
async function processMeeting(meetingId: string, meetingDir: string): Promise<void> {
  const settings = loadSettings()

  // 1) Transcribe + diarize
  let transcript
  try {
    const { events: pEvents, result } = runPipeline({ settings, meetingDir })
    pEvents.on((evt) => emitToRenderer('pipeline:event', { meetingId, ...evt }))
    transcript = await result
  } catch (err) {
    const msg = (err as Error).message
    updateMeetingStatus(meetingId, 'failed', msg)
    emitToRenderer('meeting:status', { meetingId, status: 'failed', error: msg })
    return
  }

  // 2) Persist segments
  const segmentIds = insertSegments(meetingId, transcript.segments)

  // 2b) Vision-based name detection (only if we have frames and an OpenAI key)
  let detectedAliases: Record<string, string> = {}
  if (settings.openaiKey?.trim()) {
    try {
      emitToRenderer('meeting:status', { meetingId, status: 'summarizing' })
      emitToRenderer('pipeline:event', {
        meetingId,
        status: 'detecting_names',
        message: 'Looking for participant names in the meeting window…'
      })
      detectedAliases = await detectSpeakerNames({
        apiKey: settings.openaiKey,
        meetingDir,
        segments: transcript.segments,
        language: transcript.meta.language
      })
      if (Object.keys(detectedAliases).length > 0) {
        mergeSpeakerAliases(meetingId, detectedAliases)
      }
    } catch (err) {
      console.warn('[vision] failed:', (err as Error).message)
    }
    // Clean up frames either way (they're big).
    deleteFrames(meetingDir)
  }

  // 3) Summarize + embed (requires OpenAI key)
  if (!settings.openaiKey?.trim()) {
    finalizeMeeting({
      id: meetingId,
      endedAt: Date.now(),
      duration: transcript.meta.duration,
      language: transcript.meta.language,
      summaryMd: null,
      actionItems: [],
      decisions: [],
      topics: []
    })
    emitToRenderer('meeting:status', {
      meetingId,
      status: 'ready',
      warning: 'OpenAI key not set — saved transcript only.'
    })
    return
  }

  updateMeetingStatus(meetingId, 'summarizing')
  emitToRenderer('meeting:status', { meetingId, status: 'summarizing' })

  // 3a) Summary + action items
  try {
    const post = await summarizeMeeting({
      apiKey: settings.openaiKey,
      language: transcript.meta.language,
      segments: transcript.segments,
      speakerAliases: detectedAliases
    })
    finalizeMeeting({
      id: meetingId,
      endedAt: Date.now(),
      duration: transcript.meta.duration,
      language: transcript.meta.language,
      summaryMd: post.summaryMd,
      actionItems: post.actionItems,
      decisions: post.decisions,
      topics: post.topics
    })
    if (post.title) updateMeetingTitle(meetingId, post.title)
  } catch (err) {
    // Summary failed but transcript is fine — keep the meeting usable.
    const msg = (err as Error).message
    console.warn('[summary] failed for', meetingId, msg)
    finalizeMeeting({
      id: meetingId,
      endedAt: Date.now(),
      duration: transcript.meta.duration,
      language: transcript.meta.language,
      summaryMd: null,
      actionItems: [],
      decisions: [],
      topics: []
    })
    emitToRenderer('meeting:status', {
      meetingId,
      status: 'ready',
      warning: `Summary failed: ${msg}. Transcript is saved.`
    })
  }

  // 3b) Embed chunks for RAG — separate try so failures here don't kill
  // the whole meeting. Without embeddings, global/per-meeting chat won't
  // see this meeting, but the transcript and summary are still usable.
  try {
    const chunks = chunkSegmentsForRag(transcript.segments)
    setEmbeddingDim(EMBED_DIM)
    const vectors = await embed(settings.openaiKey, chunks.map((c) => c.text))
    const segmentRowIds = chunks.map((c) => segmentIds[c.segmentIdx])
    insertEmbeddings(segmentRowIds, vectors)
  } catch (err) {
    const msg = (err as Error).message
    console.warn('[embed] failed for', meetingId, msg)
    emitToRenderer('meeting:status', {
      meetingId,
      status: 'ready',
      warning: `Chat indexing failed: ${msg}. Transcript and summary are saved.`
    })
  }

  emitToRenderer('meeting:status', { meetingId, status: 'ready' })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external links in the OS browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // In dev electron-vite injects ELECTRON_RENDERER_URL; in prod we load the bundle.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function emitToRenderer(event: string, payload: any) {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(event, payload)
  }
}

// -------------------------------------------------------------------- IPC

function registerIpc(): void {
  // ----- settings
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, partial: Partial<Settings>) => {
    const next = saveSettings(partial)
    // React to detection on/off toggle.
    if (next.callDetectionEnabled === false) {
      callDetector?.stop()
      callDetector = null
      lastCallList = []
      emitToRenderer('call:update', { calls: [] })
    } else if (!callDetector) {
      startCallDetector()
    }
    return next
  })

  // ----- meetings
  ipcMain.handle('meetings:list', () => listMeetings())
  ipcMain.handle('meetings:get', (_e, id: string) => getMeeting(id))
  ipcMain.handle('meetings:rename', (_e, id: string, title: string) => {
    updateMeetingTitle(id, title)
    return getMeeting(id)
  })
  ipcMain.handle('meetings:renameSpeaker', (_e, id: string, original: string, displayName: string) => {
    renameSpeaker(id, original, displayName)
    return getMeeting(id)
  })
  ipcMain.handle('meetings:delete', (_e, id: string) => {
    const m = getMeeting(id)
    deleteMeeting(id)
    return m
  })

  // ----- windows enumeration (for the meeting-window picker)
  ipcMain.handle('windows:list', () => listCapturableWindows())

  // ----- call detection
  ipcMain.handle('calls:current', () => lastCallList)
  ipcMain.handle('calls:dismiss', (_e, key: string) => {
    callDetector?.dismiss(key)
    return true
  })

  // ----- recording lifecycle
  ipcMain.handle('recording:start', async (
    _e,
    opts?: { windowId?: number; title?: string; callKey?: string }
  ) => {
    const r = await startRecordingFromCall({
      windowId: opts?.windowId,
      title: opts?.title,
      callKey: opts?.callKey
    })
    return { meetingId: r.meetingId, windowId: opts?.windowId ?? null }
  })

  ipcMain.handle('recording:stop', async (_e, meetingId: string) => {
    const session = activeRecordings.get(meetingId)
    if (!session) {
      // Idempotent — already stopped or never existed. Don't throw, the UI
      // sometimes hits this if the user double-clicks Stop.
      return { ok: true, alreadyStopped: true }
    }
    activeRecordings.delete(meetingId)

    updateMeetingStatus(meetingId, 'transcribing')
    emitToRenderer('meeting:status', { meetingId, status: 'transcribing' })

    // Wait only for the recorder to stop & flush wavs (~instant to 10s).
    // The transcription pipeline runs in the background so the UI returns
    // immediately and the meeting list reflects progress via events.
    await stopRecorder(session)

    // Fire-and-forget the rest of the pipeline.
    void processMeeting(meetingId, session.meetingDir).catch((err) => {
      const msg = (err as Error).message
      updateMeetingStatus(meetingId, 'failed', msg)
      emitToRenderer('meeting:status', { meetingId, status: 'failed', error: msg })
    })

    return { ok: true }
  })

  ipcMain.handle('recording:active', () => Array.from(activeRecordings.keys()))

  // ----- chat
  ipcMain.handle('chat:ask', async (_e, history: ChatTurn[], question: string, meetingId?: string) => {
    const settings = loadSettings()
    if (!settings.openaiKey?.trim()) {
      throw new Error('Set your OpenAI API key in Settings first.')
    }
    return chat({ apiKey: settings.openaiKey, history, question, meetingId })
  })

  // ----- shell utilities
  ipcMain.handle('shell:openFolder', (_e, p: string) => shell.openPath(p))
}

// ----------------------------------------------------------------- bootstrap

function startCallDetector(): void {
  if (callDetector) return
  callDetector = new CallDetector((calls) => {
    lastCallList = calls
    // Suppress while a recording is active — no point offering to start a
    // recording when one is already running.
    const suppressed = activeRecordings.size > 0
    emitToRenderer('call:update', { calls: suppressed ? [] : calls })
  })
  // Fire a native macOS notification on the *first* sighting of each call.
  // The polling cadence prevents duplicates: a call key only fires onNew
  // once per appearance (it's already in `active` after that).
  callDetector.onNew((call) => {
    if (activeRecordings.size > 0) return
    notifyCallDetected(call, {
      onRecord: (c) => {
        void startRecordingFromCall({ windowId: c.windowId, title: c.callerLabel ?? null, callKey: c.key })
      }
    })
  })
  callDetector.start()
}

/**
 * Starts a recording session for a call. Shared between the IPC handler
 * (renderer toast button) and the system-notification click handler.
 */
async function startRecordingFromCall(opts: {
  windowId?: number
  title?: string | null
  callKey?: string
}): Promise<{ meetingId: string }> {
  const settings = loadSettings()
  const dataDir = ensureDataDir(settings)
  const meetingId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const session = startRecorder({ dataDir, meetingId, windowId: opts.windowId })
  activeRecordings.set(meetingId, session)
  const title = opts.title?.trim() || new Date().toLocaleString()
  createMeeting({ id: meetingId, title, meetingDir: session.meetingDir })

  if (opts.callKey) callDetector?.dismiss(opts.callKey)
  lastCallList = []
  emitToRenderer('call:update', { calls: [] })

  session.events.on((evt) => {
    emitToRenderer('recorder:event', { meetingId, ...evt })
  })

  // Tell renderer to navigate to the recording screen.
  emitToRenderer('recording:started', { meetingId, windowId: opts.windowId ?? null })

  return { meetingId }
}

// Force the app display name so macOS notifications say "MeetingAssistant"
// instead of "Electron". Must be set before app.whenReady fires.
app.setName('MeetingAssistant')

app.whenReady().then(() => {
  const settings = loadSettings()
  const dataDir = ensureDataDir(settings)
  initDb(dataDir)
  setEmbeddingDim(EMBED_DIM)
  registerIpc()
  createWindow()
  if (settings.callDetectionEnabled !== false) {
    startCallDetector()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  // Stop any in-flight recorder so we don't leave dangling processes.
  for (const session of activeRecordings.values()) {
    try {
      session.process.kill('SIGINT')
    } catch {
      // ignore
    }
  }
})
