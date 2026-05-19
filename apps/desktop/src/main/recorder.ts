import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

export interface RecorderSession {
  meetingId: string
  meetingDir: string
  startedAt: number
  process: ChildProcess
  events: AsyncEventBus
}

/** Simple event bus that pushes lines from stdout. */
export class AsyncEventBus {
  private listeners: ((evt: any) => void)[] = []

  on(fn: (evt: any) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn)
    }
  }
  emit(evt: any) {
    for (const l of this.listeners) {
      try {
        l(evt)
      } catch (err) {
        console.error('[event-bus]', err)
      }
    }
  }
}

function resolveRecorderPath(): string {
  // The recorder is shipped as marec.app (a proper bundle) so macOS TCC
  // can assign stable Screen Recording / Microphone permissions to it.
  // We exec the binary inside the bundle: marec.app/Contents/MacOS/marec
  const candidates = [
    // 1. Bundled (production)
    path.join(process.resourcesPath || '', 'bin', 'marec.app', 'Contents', 'MacOS', 'marec'),
    // 2. Dev with .app wrapping (npm run build:recorder)
    path.join(app.getAppPath(), 'resources', 'bin', 'marec.app', 'Contents', 'MacOS', 'marec'),
    // 3. Bare binary fallback (legacy build)
    path.join(app.getAppPath(), 'resources', 'bin', 'marec'),
    // 4. Direct swift build output
    path.resolve(app.getAppPath(), '..', 'recorder-helper', '.build', 'release', 'marec')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error(
    'marec.app not found. Build it with `npm run build:recorder` from the repo root.'
  )
}

export function startRecorder(args: {
  dataDir: string
  meetingId: string
}): RecorderSession {
  const meetingDir = path.join(args.dataDir, 'meetings', args.meetingId)
  fs.mkdirSync(meetingDir, { recursive: true })

  const binary = resolveRecorderPath()
  const child = spawn(binary, ['--output-dir', meetingDir], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const events = new AsyncEventBus()

  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const evt = JSON.parse(line)
        events.emit(evt)
      } catch {
        events.emit({ status: 'stdout', message: line })
      }
    }
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    events.emit({ status: 'stderr', message: chunk.toString().trim() })
  })
  child.on('exit', (code, signal) => {
    events.emit({ status: 'exit', code, signal })
  })
  child.on('error', (err) => {
    events.emit({ status: 'spawn_error', message: err.message })
  })

  return {
    meetingId: args.meetingId,
    meetingDir,
    startedAt: Date.now(),
    process: child,
    events
  }
}

export async function stopRecorder(session: RecorderSession): Promise<void> {
  return new Promise((resolve) => {
    if (session.process.exitCode !== null) {
      resolve()
      return
    }
    const done = () => resolve()
    session.process.once('exit', done)
    try {
      session.process.kill('SIGINT')
    } catch (err) {
      console.error('[recorder] kill failed', err)
      resolve()
    }
    // Safety timeout — after 10s force kill.
    setTimeout(() => {
      if (session.process.exitCode === null) {
        try { session.process.kill('SIGKILL') } catch { /* ignore */ }
      }
      resolve()
    }, 10_000)
  })
}
