# MeetingAssistant

Local-first meeting recorder, transcriber and assistant for macOS — like Granola + Fathom in one, fully on your own machine.

- 🎙️ Captures **system audio** (anything playing on the Mac — Zoom, Google Meet, Slack huddles, WhatsApp calls…) **and your microphone** on two separate tracks, using **ScreenCaptureKit**. No virtual audio driver to install. The app **never joins your call**.
- 📝 Transcribes locally with **WhisperX** (large-v3, Spanish + English auto-detect).
- 👥 Diarizes "who said what" with **pyannote-audio**. Your mic track is labeled `You` automatically; the other speakers are clustered as `Speaker_A`, `Speaker_B`, … and you can rename them with one click — the rename is remembered.
- 🗂️ Every meeting is stored in a local SQLite database with full-text search and vector embeddings.
- 🧠 Generates a summary, action items, decisions and topics after each call (OpenAI API).
- 💬 Lets you **chat with your meeting history** — RAG over every conversation you've ever recorded, with citations back to the exact segment.

> Audio and raw transcripts never leave your Mac. The OpenAI API is only used for the small text payloads we send for summarization and chat.

## Quick start

```bash
git clone https://github.com/javigildd/MeetingAssistant.git
cd MeetingAssistant
bash scripts/setup.sh        # builds the Swift recorder, installs JS deps, finds whisperx
# edit .env to add OPENAI_API_KEY and (one-time) HUGGINGFACE_TOKEN
npm run dev
```

The first time you press **Record**, macOS will prompt for two permissions:

- **Screen Recording** — needed because ScreenCaptureKit is the only API on macOS that can capture audio coming out of the system without a kernel-level driver.
- **Microphone** — for your own voice.

Grant both, then start a new recording. After the first grant you won't be asked again.

## Architecture

```
┌─── apps/desktop ───── Electron + React + Tailwind ──────────────┐
│  Renderer                                                        │
│   • Home (meeting list, search)                                  │
│   • Recording (start/stop, live duration, mic + system status)   │
│   • Detail (Summary / Transcript / Actions tabs)                 │
│   • Chat (RAG across all meetings with citations)                │
│   • Settings                                                     │
│                                                                  │
│  Main (Node)                                                     │
│   • SQLite (better-sqlite3) + sqlite-vec for embeddings          │
│   • FTS5 for keyword search                                      │
│   • Spawns recorder + pipeline as subprocesses                   │
│   • OpenAI: structured-output summarization, embeddings, chat    │
└──────────┬──────────────────────────────┬────────────────────────┘
           │                              │
┌──────────▼─────────────┐    ┌───────────▼──────────────────────┐
│ apps/recorder-helper   │    │ packages/pipeline                │
│   Swift CLI (marec)    │    │   Python (uses your venv)        │
│                        │    │                                  │
│ • ScreenCaptureKit     │    │ • WhisperX large-v3              │
│ • AVAudioEngine (mic)  │    │ • pyannote speaker-diarization-3.1│
│ • Writes 16 kHz mono   │    │ • Mic track → "You" by design    │
│   PCM16 WAVs:          │    │ • System track → Speaker_A/B/... │
│   - mic.wav            │    │ • Merges + writes transcript.json│
│   - system.wav         │    │                                  │
└────────────────────────┘    └──────────────────────────────────┘
```

## Speaker identification strategy

Granola transcribes well but doesn't tell you *who* said what. Fathom does, but joins your call as a bot. MeetingAssistant gets diarization without ever being a participant by using a 4-layer approach:

1. **Two separate tracks.** The mic and the system audio are recorded to different files. Everything on `mic.wav` is you, period.
2. **Diarize only the system track.** pyannote clusters the *other* voices into `Speaker_A`, `Speaker_B`, … This is much easier than separating a 4-way call mixed into one file.
3. **One-click renaming.** Click any chip in the Transcript view and rename `Speaker_A` to `Maria`. The mapping is stored per-meeting.
4. **(Roadmap)** Voice fingerprinting across meetings — when you label a speaker, save their voice embedding and reuse it to auto-recognize them next time.

## What runs locally vs. what hits the network

| Step | Where |
| --- | --- |
| Audio capture (mic + system) | Local (Swift / ScreenCaptureKit) |
| Speech-to-text (WhisperX) | Local (Python) |
| Speaker diarization (pyannote) | Local (Python, after one-time HF model download) |
| Summary, action items, decisions | OpenAI (`gpt-4o-mini`) |
| Embeddings for RAG | OpenAI (`text-embedding-3-small`) |
| Chat over history | OpenAI (`gpt-4o-mini`) — with retrieved local context |

Audio files and full transcripts never go to OpenAI. We only send the summary prompt (the diarized transcript text once, per meeting) and small chunks for embeddings/chat.

## Folder layout

```
MeetingAssistant/
├── apps/
│   ├── desktop/             Electron + React + Tailwind app
│   │   ├── src/main/        Main process (DB, IPC, OpenAI, lifecycle)
│   │   ├── src/preload/     contextBridge surface for the renderer
│   │   ├── src/renderer/    React app (routes, components)
│   │   └── src/shared/      Types shared between main, preload, renderer
│   └── recorder-helper/     Swift Package — ScreenCaptureKit recorder CLI
├── packages/
│   └── pipeline/            Python: WhisperX + pyannote → transcript.json
├── scripts/
│   └── setup.sh             Idempotent setup helper
└── .env.example             Template for local config
```

## Configuration

Everything lives in `.env` (created from `.env.example` by `scripts/setup.sh`) and in the in-app **Settings** screen. The Settings UI is the source of truth at runtime; `.env` is just convenient for the initial setup.

| Variable | Required | What it does |
| --- | --- | --- |
| `MA_PYTHON` | yes | Path to a Python interpreter with `whisperx` + `pyannote-audio` installed |
| `OPENAI_API_KEY` | for summaries / chat | OpenAI key. If unset, recordings still transcribe but you get no summary or chat |
| `HUGGINGFACE_TOKEN` | once | Needed for pyannote's first model download — clear once cached |
| `MA_WHISPER_MODEL` | no | Default `large-v3`. Other: `medium`, `medium.en`, `small` |
| `MA_COMPUTE_TYPE` | no | `int8` (default), `float16`, `float32` |
| `MA_DATA_DIR` | no | Where audio/DB live. Default `~/MeetingAssistant` |

## Roadmap

- Voice fingerprint enrollment so renamed speakers carry across meetings
- Optional video capture (ScreenCaptureKit can also record the screen — we already build the helper around it)
- Calendar integration: pre-fill participant names from invitees
- Auto-detect when Zoom/Meet/Slack is in a call and offer to start recording
- Export to Markdown, Notion, Linear

## Requirements

- macOS 13+ (ScreenCaptureKit). Tested on macOS 26.
- Xcode Command Line Tools: `xcode-select --install`
- Node 20+
- Python 3.10+ with [WhisperX](https://github.com/m-bain/whisperX) and [pyannote-audio](https://github.com/pyannote/pyannote-audio)
- An OpenAI API key (only used for chat / summaries)
- A Hugging Face account (one-time, to download the pyannote model)
