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
      throw new Error(`No active recording for ${meetingId}`)
    }
    activeRecordings.delete(meetingId)

    updateMeetingStatus(meetingId, 'transcribing')
    emitToRenderer('meeting:status', { meetingId, status: 'transcribing' })

    await stopRecorder(session)

    const settings = loadSettings()

    // -- Run pipeline (transcribe + diarize)
    let transcript
    try {
      const { events: pEvents, result } = runPipeline({
        settings,
        meetingDir: session.meetingDir
      })
      pEvents.on((evt) => {
        emitToRenderer('pipeline:event', { meetingId, ...evt })
      })
      transcript = await result
    } catch (err) {
      const msg = (err as Error).message
      updateMeetingStatus(meetingId, 'failed', msg)
      emitToRenderer('meeting:status', { meetingId, status: 'failed', error: msg })
      return { ok: false, error: msg }
    }

    // -- Persist segments
    const segmentIds = insertSegments(meetingId, transcript.segments)

    // -- Summarize + embed (requires OpenAI key)
    updateMeetingStatus(meetingId, 'summarizing')
    emitToRenderer('meeting:status', { meetingId, status: 'summarizing' })
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
      return { ok: true, transcript }
    }

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

      // -- Embed chunks for RAG
      const chunks = chunkSegmentsForRag(transcript.segments)
      setEmbeddingDim(EMBED_DIM)
      const vectors = await embed(
        settings.openaiKey,
        chunks.map((c) => c.text)
      )
      const segmentRowIds = chunks.map((c) => segmentIds[c.segmentIdx])
      insertEmbeddings(segmentRowIds, vectors)

      emitToRenderer('meeting:status', { meetingId, status: 'ready' })
      return { ok: true, transcript }
    } catch (err) {
      const msg = (err as Error).message
      updateMeetingStatus(meetingId, 'failed', msg)
      emitToRenderer('meeting:status', { meetingId, status: 'failed', error: msg })
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('recording:active', () => Array.from(activeRecordings.keys()))

  // ----- chat
  ipcMain.handle('chat:ask', async (_e, history: ChatTurn[], question: string) => {
    const settings = loadSettings()
    if (!settings.openaiKey?.trim()) {
      throw new Error('Set your OpenAI API key in Settings first.')
    }
    return chat({ apiKey: settings.openaiKey, history, question })
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
