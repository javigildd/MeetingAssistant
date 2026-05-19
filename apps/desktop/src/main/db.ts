import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import path from 'node:path'
import fs from 'node:fs'
import type { Meeting, MeetingSummary, Segment, ActionItem } from '../shared/types'

let db: Database.Database | null = null
let vecAvailable = false
let vecDim = 1536 // text-embedding-3-small dimensions

export function initDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'meetings.sqlite')
  const handle = new Database(dbPath)
  handle.pragma('journal_mode = WAL')
  handle.pragma('foreign_keys = ON')

  // Try to load sqlite-vec — gracefully degrade to in-memory similarity if missing.
  try {
    sqliteVec.load(handle)
    const row = handle.prepare('SELECT vec_version() AS v').get() as { v: string }
    vecAvailable = !!row.v
  } catch (err) {
    vecAvailable = false
    console.warn('[db] sqlite-vec not available, RAG will use in-memory cosine:', (err as Error).message)
  }

  handle.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration REAL NOT NULL DEFAULT 0,
      language TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL DEFAULT 'recording',
      meeting_dir TEXT NOT NULL,
      summary_md TEXT,
      action_items_json TEXT,
      decisions_json TEXT,
      topics_json TEXT,
      speaker_aliases_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      start REAL NOT NULL,
      "end" REAL NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      language TEXT,
      UNIQUE(meeting_id, idx)
    );

    CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments(meeting_id);

    CREATE TABLE IF NOT EXISTS embeddings (
      segment_id INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
      vector BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
      text, content='segments', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
      INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
      INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `)

  if (vecAvailable) {
    handle.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_segments USING vec0(
        segment_id INTEGER PRIMARY KEY,
        embedding FLOAT[${vecDim}]
      );
    `)
  }

  db = handle
  return handle
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb first')
  return db
}

export function setEmbeddingDim(n: number) {
  vecDim = n
}

export function isVecAvailable(): boolean {
  return vecAvailable
}

// ----------------------------------------------------------------- meetings

export function createMeeting(args: {
  id: string
  title: string
  meetingDir: string
}): void {
  getDb()
    .prepare(`
      INSERT INTO meetings (id, title, started_at, meeting_dir, status)
      VALUES (?, ?, ?, ?, 'recording')
    `)
    .run(args.id, args.title, Date.now(), args.meetingDir)
}

export function updateMeetingStatus(id: string, status: string, errorMessage?: string): void {
  getDb()
    .prepare(`UPDATE meetings SET status=?, error_message=? WHERE id=?`)
    .run(status, errorMessage ?? null, id)
}

export function finalizeMeeting(args: {
  id: string
  endedAt: number
  duration: number
  language: string
  summaryMd: string | null
  actionItems: ActionItem[]
  decisions: string[]
  topics: string[]
}): void {
  getDb()
    .prepare(`
      UPDATE meetings
      SET ended_at=?, duration=?, language=?, summary_md=?,
          action_items_json=?, decisions_json=?, topics_json=?, status='ready', error_message=NULL
      WHERE id=?
    `)
    .run(
      args.endedAt,
      args.duration,
      args.language,
      args.summaryMd,
      JSON.stringify(args.actionItems),
      JSON.stringify(args.decisions),
      JSON.stringify(args.topics),
      args.id
    )
}

export function deleteMeeting(id: string): void {
  getDb().prepare(`DELETE FROM meetings WHERE id=?`).run(id)
}

export function listMeetings(): MeetingSummary[] {
  const rows = getDb()
    .prepare(`
      SELECT m.id, m.title, m.started_at AS startedAt, m.duration, m.language, m.status,
             (SELECT COUNT(DISTINCT speaker) FROM segments s WHERE s.meeting_id = m.id) AS speakerCount
      FROM meetings m
      ORDER BY m.started_at DESC
    `)
    .all() as MeetingSummary[]
  return rows
}

export function getMeeting(id: string): Meeting | null {
  const row = getDb()
    .prepare(`SELECT * FROM meetings WHERE id=?`)
    .get(id) as any
  if (!row) return null
  const segments = getDb()
    .prepare(`
      SELECT start, "end" AS "end", speaker, text, language
      FROM segments
      WHERE meeting_id=?
      ORDER BY idx ASC
    `)
    .all(id) as Segment[]
  const speakers: string[] = []
  for (const s of segments) {
    if (!speakers.includes(s.speaker)) speakers.push(s.speaker)
  }
  const aliases = row.speaker_aliases_json ? JSON.parse(row.speaker_aliases_json) : {}
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    duration: row.duration,
    language: row.language,
    status: row.status,
    meetingDir: row.meeting_dir,
    summaryMd: row.summary_md,
    actionItems: row.action_items_json ? JSON.parse(row.action_items_json) : [],
    decisions: row.decisions_json ? JSON.parse(row.decisions_json) : [],
    topics: row.topics_json ? JSON.parse(row.topics_json) : [],
    segments,
    speakers,
    speakerAliases: aliases,
    errorMessage: row.error_message ?? null
  }
}

export function renameSpeaker(meetingId: string, original: string, displayName: string): void {
  const row = getDb().prepare(`SELECT speaker_aliases_json FROM meetings WHERE id=?`).get(meetingId) as any
  const aliases: Record<string, string> = row?.speaker_aliases_json
    ? JSON.parse(row.speaker_aliases_json)
    : {}
  if (displayName.trim() === '') {
    delete aliases[original]
  } else {
    aliases[original] = displayName.trim()
  }
  getDb()
    .prepare(`UPDATE meetings SET speaker_aliases_json=? WHERE id=?`)
    .run(JSON.stringify(aliases), meetingId)
}

export function updateMeetingTitle(meetingId: string, title: string): void {
  getDb().prepare(`UPDATE meetings SET title=? WHERE id=?`).run(title, meetingId)
}

// ----------------------------------------------------------------- segments

export function insertSegments(meetingId: string, segments: Segment[]): number[] {
  const insert = getDb().prepare(`
    INSERT INTO segments (meeting_id, idx, start, "end", speaker, text, language)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const ids: number[] = []
  const tx = getDb().transaction(() => {
    segments.forEach((s, idx) => {
      const info = insert.run(meetingId, idx, s.start, s.end, s.speaker, s.text, s.language)
      ids.push(Number(info.lastInsertRowid))
    })
  })
  tx()
  return ids
}

// --------------------------------------------------------------- embeddings

function float32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

function bufferToFloat32(b: Buffer): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

export function insertEmbeddings(segmentIds: number[], vectors: number[][]): void {
  if (segmentIds.length !== vectors.length) {
    throw new Error('embeddings count mismatch')
  }
  const stmt = getDb().prepare(`INSERT OR REPLACE INTO embeddings (segment_id, vector) VALUES (?, ?)`)
  let vecStmt: Database.Statement | null = null
  if (vecAvailable) {
    vecStmt = getDb().prepare(`INSERT OR REPLACE INTO vec_segments (segment_id, embedding) VALUES (?, ?)`)
  }
  const tx = getDb().transaction(() => {
    for (let i = 0; i < segmentIds.length; i++) {
      const f32 = Float32Array.from(vectors[i])
      stmt.run(segmentIds[i], float32ToBuffer(f32))
      if (vecStmt) {
        vecStmt.run(segmentIds[i], float32ToBuffer(f32))
      }
    }
  })
  tx()
}

export interface RetrievalHit {
  segmentId: number
  meetingId: string
  meetingTitle: string
  start: number
  end: number
  speaker: string
  text: string
  distance: number
  segmentIndex: number
}

export function retrieveSimilar(queryVec: number[], k = 8, meetingId?: string): RetrievalHit[] {
  const f32 = Float32Array.from(queryVec)
  if (vecAvailable) {
    // vec0 MATCH doesn't compose well with WHERE filters on joined tables in
    // some sqlite-vec versions, so over-fetch then filter in JS.
    const overK = meetingId ? Math.max(k * 6, 50) : k
    const rows = getDb().prepare(`
      SELECT s.id AS segmentId, s.meeting_id AS meetingId, m.title AS meetingTitle,
             s.start, s."end" AS "end", s.speaker, s.text, s.idx AS segmentIndex,
             v.distance AS distance
      FROM vec_segments v
      JOIN segments s ON s.id = v.segment_id
      JOIN meetings m ON m.id = s.meeting_id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance ASC
      LIMIT ?
    `).all(float32ToBuffer(f32), overK) as RetrievalHit[]
    const filtered = meetingId ? rows.filter((r) => r.meetingId === meetingId) : rows
    return filtered.slice(0, k)
  }

  // Fallback: brute-force cosine over all embeddings.
  const rows = (meetingId
    ? getDb().prepare(`
        SELECT e.segment_id AS segmentId, e.vector AS vector,
               s.meeting_id AS meetingId, m.title AS meetingTitle,
               s.start, s."end" AS "end", s.speaker, s.text, s.idx AS segmentIndex
        FROM embeddings e
        JOIN segments s ON s.id = e.segment_id
        JOIN meetings m ON m.id = s.meeting_id
        WHERE s.meeting_id = ?
      `).all(meetingId)
    : getDb().prepare(`
        SELECT e.segment_id AS segmentId, e.vector AS vector,
               s.meeting_id AS meetingId, m.title AS meetingTitle,
               s.start, s."end" AS "end", s.speaker, s.text, s.idx AS segmentIndex
        FROM embeddings e
        JOIN segments s ON s.id = e.segment_id
        JOIN meetings m ON m.id = s.meeting_id
      `).all()) as any[]

  const qNorm = norm(f32)
  const scored = rows.map((r) => {
    const v = bufferToFloat32(r.vector as Buffer)
    const sim = dot(f32, v) / (qNorm * norm(v) + 1e-9)
    return { ...r, distance: 1 - sim } as RetrievalHit
  })
  scored.sort((a, b) => a.distance - b.distance)
  return scored.slice(0, k)
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
function norm(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s)
}

// ----------------------------------------------------------------------- FTS

export function searchText(query: string, k = 8, meetingId?: string): RetrievalHit[] {
  // Sanitize fts5 query — escape stray quotes.
  const safe = query.replace(/"/g, '""')
  const sql = meetingId
    ? `
      SELECT s.id AS segmentId, s.meeting_id AS meetingId, m.title AS meetingTitle,
             s.start, s."end" AS "end", s.speaker, s.text, s.idx AS segmentIndex,
             bm25(segments_fts) AS distance
      FROM segments_fts
      JOIN segments s ON s.id = segments_fts.rowid
      JOIN meetings m ON m.id = s.meeting_id
      WHERE segments_fts MATCH ? AND s.meeting_id = ?
      ORDER BY distance ASC
      LIMIT ?
    `
    : `
      SELECT s.id AS segmentId, s.meeting_id AS meetingId, m.title AS meetingTitle,
             s.start, s."end" AS "end", s.speaker, s.text, s.idx AS segmentIndex,
             bm25(segments_fts) AS distance
      FROM segments_fts
      JOIN segments s ON s.id = segments_fts.rowid
      JOIN meetings m ON m.id = s.meeting_id
      WHERE segments_fts MATCH ?
      ORDER BY distance ASC
      LIMIT ?
    `
  const stmt = getDb().prepare(sql)
  const rows = (meetingId
    ? stmt.all(`"${safe}"`, meetingId, k)
    : stmt.all(`"${safe}"`, k)) as RetrievalHit[]
  return rows
}
