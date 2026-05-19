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
  updateMeetingTitle,
  deleteMeeting,
  setEmbeddingDim
} from './db'
import { startRecorder, stopRecorder, type RecorderSession } from './recorder'
import { runPipeline } from './pipeline'
import { summarizeMeeting, embed, chat, chunkSegmentsForRag, EMBED_DIM } from './ai'
import type { Settings, ChatTurn } from '../shared/types'

let mainWindow: BrowserWindow | null = null
const activeRecordings = new Map<string, RecorderSession>()

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

  try {
    const post = await summarizeMeeting({
      apiKey: settings.openaiKey,
      language: transcript.meta.language,
      segments: transcript.segments
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

    // 4) Embed chunks for RAG
    const chunks = chunkSegmentsForRag(transcript.segments)
    setEmbeddingDim(EMBED_DIM)
    const vectors = await embed(
      settings.openaiKey,
      chunks.map((c) => c.text)
    )
    const segmentRowIds = chunks.map((c) => segmentIds[c.segmentIdx])
    insertEmbeddings(segmentRowIds, vectors)

    emitToRenderer('meeting:status', { meetingId, status: 'ready' })
  } catch (err) {
    const msg = (err as Error).message
    updateMeetingStatus(meetingId, 'failed', msg)
    emitToRenderer('meeting:status', { meetingId, status: 'failed', error: msg })
  }
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
  ipcMain.handle('settings:save', (_e, partial: Partial<Settings>) => saveSettings(partial))

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

  // ----- recording lifecycle
  ipcMain.handle('recording:start', async () => {
    const settings = loadSettings()
    const dataDir = ensureDataDir(settings)
    const meetingId = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const session = startRecorder({ dataDir, meetingId })
    activeRecordings.set(meetingId, session)
    const title = new Date().toLocaleString()
    createMeeting({ id: meetingId, title, meetingDir: session.meetingDir })

    session.events.on((evt) => {
      emitToRenderer('recorder:event', { meetingId, ...evt })
    })

    return { meetingId }
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

app.whenReady().then(() => {
  const settings = loadSettings()
  const dataDir = ensureDataDir(settings)
  initDb(dataDir)
  setEmbeddingDim(EMBED_DIM)
  registerIpc()
  createWindow()

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
