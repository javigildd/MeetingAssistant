import OpenAI from 'openai'
import type { ActionItem, Segment, ChatTurn, ChatCitation } from '../shared/types'
import { retrieveSimilar, searchText, type RetrievalHit } from './db'

const SUMMARY_MODEL = 'gpt-4o-mini'
const CHAT_MODEL = 'gpt-4o-mini'
const EMBED_MODEL = 'text-embedding-3-small'
export const EMBED_DIM = 1536

function client(apiKey: string): OpenAI {
  return new OpenAI({ apiKey })
}

// --------------------------------------------------------------- summarize

export interface PostProcessResult {
  title: string
  summaryMd: string
  actionItems: ActionItem[]
  decisions: string[]
  topics: string[]
}

function transcriptAsText(segments: Segment[], maxChars = 60_000): string {
  const lines: string[] = []
  let total = 0
  for (const s of segments) {
    const line = `[${formatTs(s.start)}] ${s.speaker}: ${s.text}`
    if (total + line.length > maxChars) {
      lines.push('… [transcript truncated for summarization] …')
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n')
}

function formatTs(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export async function summarizeMeeting(args: {
  apiKey: string
  language: string
  segments: Segment[]
  /** Optional map of cluster label → real name. Applied before building
   * the transcript so the LLM sees "María said..." instead of "Speaker_A said...". */
  speakerAliases?: Record<string, string>
}): Promise<PostProcessResult> {
  const oai = client(args.apiKey)
  const labeled = args.speakerAliases
    ? args.segments.map((s) => ({ ...s, speaker: args.speakerAliases![s.speaker] || s.speaker }))
    : args.segments
  const transcript = transcriptAsText(labeled)
  const lang = args.language === 'es' ? 'Spanish' : 'English'

  const system = [
    `You are a meeting assistant. You will receive a transcript of a meeting that has been speaker-diarized.`,
    `"You" is the user who recorded the meeting. The other speakers are labeled Speaker_A, Speaker_B, etc.`,
    `Generate a concise meeting summary in ${lang}, plus action items, decisions, and topics.`,
    `When writing action items, attribute owners using the speaker labels you see. If unknown, leave owner empty.`,
    `Be terse and concrete — no fluff, no greetings. Output strictly valid JSON conforming to the requested schema.`
  ].join(' ')

  const user = `Here is the diarized transcript (timestamps are MM:SS):\n\n${transcript}`

  const response = await oai.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'meeting_summary',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'A short title for this meeting (≤ 70 chars).' },
            summary_md: { type: 'string', description: 'Markdown summary, 4-10 bullet points.' },
            action_items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  text: { type: 'string' },
                  owner: { type: 'string' },
                  due: { type: 'string' }
                },
                required: ['text', 'owner', 'due']
              }
            },
            decisions: { type: 'array', items: { type: 'string' } },
            topics: { type: 'array', items: { type: 'string' } }
          },
          required: ['title', 'summary_md', 'action_items', 'decisions', 'topics']
        }
      }
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })

  const raw = response.choices[0]?.message?.content || '{}'
  const parsed = JSON.parse(raw) as {
    title: string
    summary_md: string
    action_items: ActionItem[]
    decisions: string[]
    topics: string[]
  }

  return {
    title: parsed.title?.trim() || `Meeting ${new Date().toLocaleString()}`,
    summaryMd: parsed.summary_md || '',
    actionItems: (parsed.action_items || []).map((a) => ({
      text: a.text,
      owner: a.owner || undefined,
      due: a.due || undefined
    })),
    decisions: parsed.decisions || [],
    topics: parsed.topics || []
  }
}

// --------------------------------------------------------------- embeddings

export async function embed(apiKey: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const oai = client(apiKey)
  // OpenAI batch up to ~2048 inputs, but text length matters. Chunk at 100.
  const out: number[][] = []
  const chunkSize = 96
  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize)
    const r = await oai.embeddings.create({
      model: EMBED_MODEL,
      input: chunk,
      dimensions: EMBED_DIM
    })
    for (const item of r.data) {
      out.push(item.embedding as number[])
    }
  }
  return out
}

/** Build searchable chunks from segments: group adjacent same-speaker
 * segments and chunk every ~80 words to balance recall and locality. */
export function chunkSegmentsForRag(segments: Segment[]): {
  text: string
  segmentIdx: number  // anchor segment for citation
}[] {
  const out: { text: string; segmentIdx: number }[] = []
  if (segments.length === 0) return out

  let curSpeaker = segments[0].speaker
  let curStartIdx = 0
  let curWords = 0
  const flush = (endIdx: number) => {
    const slice = segments.slice(curStartIdx, endIdx + 1)
    const text = slice.map((s) => `${s.speaker}: ${s.text}`).join(' ')
    out.push({ text, segmentIdx: curStartIdx })
  }
  const MAX_WORDS = 80
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const w = s.text.split(/\s+/).length
    const sameSpeaker = s.speaker === curSpeaker
    if (!sameSpeaker || curWords + w > MAX_WORDS) {
      flush(i - 1)
      curStartIdx = i
      curSpeaker = s.speaker
      curWords = w
    } else {
      curWords += w
    }
  }
  flush(segments.length - 1)
  return out
}

// ---------------------------------------------------------------------- chat

function turnsToHits(hits: RetrievalHit[]): ChatCitation[] {
  return hits.map((h) => ({
    meetingId: h.meetingId,
    meetingTitle: h.meetingTitle,
    segmentIndex: h.segmentIndex,
    start: h.start,
    end: h.end,
    speaker: h.speaker,
    text: h.text
  }))
}

export async function chat(args: {
  apiKey: string
  history: ChatTurn[]
  question: string
  /** If set, retrieval is scoped to a single meeting (per-meeting Q&A). */
  meetingId?: string
}): Promise<{ answer: string; citations: ChatCitation[] }> {
  const oai = client(args.apiKey)

  // 1) Embed question and retrieve. Scope to a meeting if requested.
  const [qVec] = await embed(args.apiKey, [args.question])
  const dense = retrieveSimilar(qVec, 8, args.meetingId)
  const sparse = searchText(args.question, 4, args.meetingId).filter(
    (r) => !dense.some((d) => d.segmentId === r.segmentId)
  )
  const hits = [...dense, ...sparse].slice(0, 10)

  // 2) Build context string.
  const ctx = hits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.meetingTitle} — ${h.speaker} @ ${formatTs(h.start)}:\n"${h.text}"`
    )
    .join('\n\n')

  const scopeLine = args.meetingId
    ? 'You are answering questions about ONE specific meeting whose context is below.'
    : `You answer questions about the user's past meetings.`

  const system = `${scopeLine}
The user is the "You" speaker. Other speakers are Speaker_A/B/... unless the user has renamed them.
Always answer concisely. Cite the segments you used with [1], [2], etc. matching the numbered context blocks below.
If the answer is not in the provided context, say so. Do not invent quotes.`

  const messages: any[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Context:\n\n${ctx || '(no matching context found)'}\n\nQuestion: ${args.question}`
    }
  ]
  // Add prior conversation turns (last 4)
  const prior = args.history.slice(-8)
  for (const t of prior) {
    messages.splice(messages.length - 1, 0, { role: t.role, content: t.content })
  }

  const response = await oai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    messages
  })

  const answer = response.choices[0]?.message?.content || ''
  return { answer, citations: turnsToHits(hits) }
}
