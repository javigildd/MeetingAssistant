import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { refreshSettings, useStore } from '../store'

export default function SettingsPage() {
  const settings = useStore((s) => s.settings)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings && !draft) setDraft(settings)
  }, [settings, draft])

  if (!draft) return <div className="px-12 py-10 text-ink-400">Loading…</div>

  async function save() {
    await window.api.settings.save(draft!)
    await refreshSettings()
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  function update<K extends keyof Settings>(k: K, v: Settings[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d))
  }

  return (
    <div className="px-12 py-10 max-w-2xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-400 mt-1">
          Everything is stored locally on this Mac. OpenAI is only contacted for summaries and
          chat.
        </p>
      </header>

      <Section title="OpenAI">
        <Field
          label="API Key"
          hint="Used for summary, action items, embeddings and chat. Audio never leaves your Mac."
        >
          <input
            type="password"
            placeholder="sk-..."
            value={draft.openaiKey}
            onChange={(e) => update('openaiKey', e.target.value)}
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </Field>
      </Section>

      <Section title="Transcription">
        <Field
          label="Python interpreter"
          hint="Path to a Python binary that has whisperx + pyannote-audio installed."
        >
          <input
            value={draft.pythonPath}
            onChange={(e) => update('pythonPath', e.target.value)}
            placeholder="/path/to/whisperx-venv/bin/python"
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm font-mono"
          />
        </Field>
        <Field label="Whisper model">
          <select
            value={draft.whisperModel}
            onChange={(e) => update('whisperModel', e.target.value)}
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="large-v3">large-v3 (best, slower)</option>
            <option value="medium">medium</option>
            <option value="medium.en">medium.en (English only, faster)</option>
            <option value="small">small (fastest, lower quality)</option>
          </select>
        </Field>
        <Field label="Compute type">
          <select
            value={draft.computeType}
            onChange={(e) => update('computeType', e.target.value)}
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="int8">int8 (recommended on Apple Silicon CPU)</option>
            <option value="float16">float16</option>
            <option value="float32">float32</option>
          </select>
        </Field>
        <Field label="Language">
          <select
            value={draft.language}
            onChange={(e) => update('language', e.target.value as Settings['language'])}
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="auto">Auto-detect (es/en)</option>
            <option value="es">Spanish</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field
          label="Hugging Face token"
          hint="Only required the first time pyannote downloads the diarization model. After that, leave blank."
        >
          <input
            type="password"
            value={draft.hfToken}
            onChange={(e) => update('hfToken', e.target.value)}
            placeholder="hf_..."
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </Field>
      </Section>

      <Section title="Storage">
        <Field
          label="Data directory"
          hint="Where audio, transcripts and the SQLite DB live. Leave default unless you have a reason."
        >
          <input
            value={draft.dataDir}
            onChange={(e) => update('dataDir', e.target.value)}
            className="w-full bg-ink-900 border border-white/10 rounded px-3 py-2 text-sm font-mono"
          />
        </Field>
      </Section>

      <div className="flex justify-end gap-2 items-center">
        {saved && <span className="text-xs text-green-400">Saved</span>}
        <button
          onClick={save}
          className="px-4 py-2 rounded bg-accent-500 hover:bg-accent-400 text-white text-sm"
        >
          Save settings
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs uppercase tracking-wider text-ink-400">{title}</h2>
      <div className="space-y-4 rounded-xl border border-white/5 bg-ink-800/40 p-5">{children}</div>
    </section>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm text-ink-200">{label}</label>
      {children}
      {hint && <div className="text-xs text-ink-400">{hint}</div>}
    </div>
  )
}
