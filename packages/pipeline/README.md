# pipeline

Python pipeline that takes the two WAV files produced by the Swift recorder
(`mic.wav`, `system.wav`) and produces `transcript.json` with diarized speakers.

## How it's called

The Electron main process spawns:

```bash
MA_PYTHON=/path/to/whisperx-venv/bin/python \
HUGGINGFACE_TOKEN=hf_... \
./run.sh --meeting-dir /path/to/meeting --model large-v3 --device cpu
```

stdout is a stream of newline-delimited JSON status events. The last line has
`"status": "done"`.

## Speaker labeling strategy

- The user's microphone (`mic.wav`) is always labeled `You`. No diarization
  needed there because we know who it is.
- The system audio (`system.wav`) is run through pyannote/speaker-diarization-3.1
  and speakers are clustered into `Speaker_A`, `Speaker_B`, …
- The two streams are merged and sorted by timestamp.

Renaming `Speaker_A` to a real name (e.g. "Maria") happens in the UI and is
stored in the meeting metadata, not here.

## Required Python packages

Already in the user's whisperx-venv:

- `whisperx >= 3.8`
- `pyannote-audio >= 3.1` (we tested with 4.0)
- `torch`, `torchaudio`
- `faster-whisper`, `ctranslate2`

## Hugging Face token

The first time you run diarization, pyannote needs to download the model.
You must:

1. Create a free account at huggingface.co.
2. Visit `pyannote/segmentation-3.0` and `pyannote/speaker-diarization-3.1`
   and click "Agree and access repository".
3. Create a read-token at `https://huggingface.co/settings/tokens`.
4. Either:
   - Set `HUGGINGFACE_TOKEN` env var, or
   - Run `huggingface-cli login` once.

After the first download (~150 MB) the model is cached locally and no token
is needed.
