import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import type { Settings, Segment } from '../shared/types'
import { AsyncEventBus } from './recorder'

export interface TranscriptFile {
  meta: { duration: number; language: string; model: string; diarized: boolean }
  speakers: string[]
  segments: Segment[]
}

function resolvePipelineScript(): string {
  // Dev path: <repo>/packages/pipeline/run.py
  const candidates = [
    path.resolve(app.getAppPath(), '..', '..', 'packages', 'pipeline', 'run.py'),
    path.resolve(process.resourcesPath || '', 'pipeline', 'run.py')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error(`pipeline run.py not found in any of: ${candidates.join(', ')}`)
}

/**
 * Spawn the Python transcription/diarization pipeline.
 * Returns the parsed transcript when the pipeline reports "done".
 */
export function runPipeline(args: {
  settings: Settings
  meetingDir: string
}): { events: AsyncEventBus; result: Promise<TranscriptFile> } {
  const events = new AsyncEventBus()

  const pythonPath = args.settings.pythonPath?.trim() || 'python3'
  const script = resolvePipelineScript()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MA_WHISPER_MODEL: args.settings.whisperModel,
    MA_COMPUTE_TYPE: args.settings.computeType,
    HUGGINGFACE_TOKEN: args.settings.hfToken || process.env.HUGGINGFACE_TOKEN || ''
  }

  const cliArgs = [
    script,
    '--meeting-dir',
    args.meetingDir,
    '--model',
    args.settings.whisperModel,
    '--compute-type',
    args.settings.computeType
  ]
  if (args.settings.language !== 'auto') {
    cliArgs.push('--language', args.settings.language)
  }

  const child = spawn(pythonPath, cliArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] })

  let buf = ''
  let stderrBuf = ''
  let finalEvent: any = null

  const result = new Promise<TranscriptFile>((resolve, reject) => {
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
          if (evt.status === 'done') finalEvent = evt
        } catch {
          events.emit({ status: 'stdout', message: line })
        }
      }
    })

    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      stderrBuf += chunk
      events.emit({ status: 'stderr', message: chunk.toString().trim() })
    })

    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      if (code !== 0 || !finalEvent) {
        reject(new Error(`pipeline failed (exit ${code}): ${stderrBuf.slice(-500)}`))
        return
      }
      const transcriptPath = path.join(args.meetingDir, 'transcript.json')
      try {
        const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) as TranscriptFile
        resolve(data)
      } catch (err) {
        reject(new Error(`could not read transcript.json: ${(err as Error).message}`))
      }
    })
  })

  return { events, result }
}
