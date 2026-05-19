import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import type { Segment } from '../shared/types'

const VISION_MODEL = 'gpt-4o-mini'

/** Pick at most `max` items from `arr`, spaced evenly. Always keeps first and last. */
function sampleEvenly<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr
  const step = (arr.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max; i++) {
    out.push(arr[Math.round(i * step)])
  }
  return out
}

interface FrameRef {
  path: string
  /** Milliseconds since the start of the recording. */
  ms: number
}

function loadFrames(framesDir: string): FrameRef[] {
  if (!fs.existsSync(framesDir)) return []
  const entries = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg'))
  const refs = entries
    .map((f) => {
      const base = path.basename(f, '.jpg')
      const ms = Number(base)
      return Number.isFinite(ms) ? { path: path.join(framesDir, f), ms } : null
    })
    .filter((x): x is FrameRef => !!x)
    .sort((a, b) => a.ms - b.ms)
  return refs
}

interface VisionResult {
  participants: string[]
  /** For each analyzed frame, who was the active speaker (or null). */
  frames: { ms: number; activeSpeaker: string | null }[]
}

async function analyzeFrames(args: {
  apiKey: string
  frames: FrameRef[]
  language: string
}): Promise<VisionResult> {
  const oai = new OpenAI({ apiKey: args.apiKey })

  const langName = args.language === 'es' ? 'Spanish' : 'English'

  const content: any[] = [
    {
      type: 'text',
      text:
        `Below are sequential frames from a video call (Zoom / Google Meet / Slack huddle / WhatsApp / similar). ` +
        `The frames are in chronological order; each has a millisecond timestamp. ` +
        `Task:\n` +
        `1. Identify every distinct participant by their on-screen name label (the small caption under or above each video tile).\n` +
        `2. For each frame, identify which participant is currently speaking. Video apps highlight the active speaker with a colored border, a "speaking" microphone icon, or by enlarging their tile. If you can't tell or no one is speaking, return null for that frame.\n` +
        `3. Ignore the user's own self-view tile (it usually says "You" or shows the user's own name; do NOT include the user in participants unless there's no doubt the name corresponds to another person visible).\n` +
        `4. Return strict JSON. Names should be ${langName} or the original on-screen text. Do not invent names — only use names you can actually read.`
    }
  ]

  for (const f of args.frames) {
    const b64 = fs.readFileSync(f.path).toString('base64')
    content.push({ type: 'text', text: `Frame ms=${f.ms}` })
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' }
    })
  }

  const response = await oai.chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You analyze screenshots of video calls to extract participant names and active speakers. You only report names you can actually read from on-screen labels. You never invent or guess names.'
      },
      { role: 'user', content }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'vision_result',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            participants: {
              type: 'array',
              items: { type: 'string' },
              description: 'All distinct participant names visible across frames.'
            },
            frames: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ms: { type: 'number' },
                  activeSpeaker: {
                    type: ['string', 'null'],
                    description: 'Name of the active speaker in this frame, or null.'
                  }
                },
                required: ['ms', 'activeSpeaker']
              }
            }
          },
          required: ['participants', 'frames']
        }
      }
    }
  })

  const raw = response.choices[0]?.message?.content || '{"participants":[],"frames":[]}'
  return JSON.parse(raw) as VisionResult
}

/**
 * Given diarized segments and a vision timeline of who was speaking when,
 * return a mapping of cluster label ("Speaker_A") to detected real name.
 *
 * Strategy: for each cluster, look at every frame whose ms falls within
 * one of the cluster's segments, count which name appears most often,
 * and assign that name if it's confident enough.
 */
function clustersToNames(
  segments: Segment[],
  vision: VisionResult
): Record<string, string> {
  const counts: Record<string, Record<string, number>> = {}

  for (const frame of vision.frames) {
    if (!frame.activeSpeaker) continue
    const sec = frame.ms / 1000
    // Find which speaker cluster owns this timestamp.
    const seg = segments.find((s) => sec >= s.start && sec <= s.end + 0.5)
    if (!seg) continue
    // We don't auto-rename the user's own track.
    if (seg.speaker === 'You') continue
    counts[seg.speaker] ||= {}
    counts[seg.speaker][frame.activeSpeaker] =
      (counts[seg.speaker][frame.activeSpeaker] || 0) + 1
  }

  const out: Record<string, string> = {}
  for (const cluster of Object.keys(counts)) {
    const byName = counts[cluster]
    const ranked = Object.entries(byName).sort((a, b) => b[1] - a[1])
    if (ranked.length === 0) continue
    const [topName, topCount] = ranked[0]
    const total = ranked.reduce((a, [, n]) => a + n, 0)
    // Require at least 2 votes and >= 50% confidence to assign a name.
    if (topCount >= 2 && topCount / total >= 0.5) {
      out[cluster] = topName
    }
  }

  return out
}

/**
 * Main entry. Reads frames from meetingDir/frames/, calls the vision model,
 * maps speakers to names, and returns the aliases. Returns {} if no frames
 * or if the call fails.
 */
export async function detectSpeakerNames(args: {
  apiKey: string
  meetingDir: string
  segments: Segment[]
  language: string
}): Promise<Record<string, string>> {
  const framesDir = path.join(args.meetingDir, 'frames')
  const allFrames = loadFrames(framesDir)
  if (allFrames.length === 0) return {}

  // Cap at 20 frames to keep cost predictable (~2-3 cents per call).
  const frames = sampleEvenly(allFrames, 20)

  let vision: VisionResult
  try {
    vision = await analyzeFrames({
      apiKey: args.apiKey,
      frames,
      language: args.language
    })
  } catch (err) {
    console.warn('[vision] analysis failed:', (err as Error).message)
    return {}
  }

  const aliases = clustersToNames(args.segments, vision)
  return aliases
}

/** Best-effort cleanup. Frames are big and we don't need them after vision. */
export function deleteFrames(meetingDir: string): void {
  const framesDir = path.join(meetingDir, 'frames')
  if (!fs.existsSync(framesDir)) return
  try {
    fs.rmSync(framesDir, { recursive: true, force: true })
  } catch (err) {
    console.warn('[vision] could not delete frames:', (err as Error).message)
  }
}
