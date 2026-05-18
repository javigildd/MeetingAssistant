# MeetingAssistant

Local-first meeting recorder, transcriber and assistant for macOS — like Granola + Fathom in one, fully on your machine.

- Captures system audio (Zoom / Meet / Slack / WhatsApp / anything playing) **and** your microphone, on two separate tracks, using **ScreenCaptureKit** — no virtual audio driver to install.
- Transcribes locally with **WhisperX** (large-v3, Spanish + English auto-detect).
- Diarizes ("who said what") with **pyannote-audio**. Your mic track is labeled `You` automatically; the other speakers are clustered and you can rename them once.
- Stores every meeting in a local SQLite database with full-text search and vector embeddings.
- Generates summary + action items + decisions after each call (OpenAI API).
- Lets you **chat with your meeting history** — RAG over every conversation you've ever recorded.

> The app **never joins a call**. It just listens to what your Mac is already playing/recording, post-processes when you press *Stop*, and shows you the result.

## Requirements

- macOS 13+ (ScreenCaptureKit). Tested on macOS 26.
- Xcode Command Line Tools (`xcode-select --install`)
- Node 20+ and npm
- Python 3.10+ with [WhisperX](https://github.com/m-bain/whisperX) installed in a virtualenv
- An OpenAI API key (only used for chat / summaries — audio never leaves your machine)

## Setup

```bash
# 1. Install JS deps
npm install

# 2. Build the Swift recorder helper
npm run build:recorder

# 3. Point the app to your WhisperX venv and OpenAI key
cp .env.example .env
# edit .env

# 4. Run in dev
npm run dev
```

## Architecture

```
┌─────────── Electron + React + Tailwind ───────────┐
│  Renderer                                          │
│   • Home (meeting list, search)                    │
│   • Recording (start/stop, live duration)          │
│   • Detail (transcript with speaker chips, summary)│
│   • Chat (RAG across all meetings)                 │
└─────────────────┬──────────────────────────────────┘
                  │ IPC
┌─────────────────▼──────────────────────────────────┐
│  Main process (Node)                               │
│   • Orchestrates lifecycles                        │
│   • SQLite (better-sqlite3 + vec extension)        │
│   • Spawns recorder + pipeline as subprocesses     │
└────┬──────────────────────────────┬────────────────┘
     │                              │
┌────▼────────────────┐   ┌─────────▼────────────────┐
│ Swift recorder      │   │ Python pipeline          │
│ • ScreenCaptureKit  │   │ • WhisperX large-v3      │
│ • mic.wav 16k mono  │   │ • pyannote diarization   │
│ • system.wav 16k    │   │ • merge → transcript.json│
│                     │   │ • OpenAI summary/actions │
└─────────────────────┘   │ • OpenAI embeddings → vec│
                          └──────────────────────────┘
```

## Folder layout

```
apps/
  desktop/             Electron app (main + preload + renderer)
  recorder-helper/     Swift Package — ScreenCaptureKit recorder CLI
packages/
  pipeline/            Python scripts (transcribe, diarize, summarize, embed)
scripts/               Setup helpers
```

## License

Personal project. Not for redistribution yet.
