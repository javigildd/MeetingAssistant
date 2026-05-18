#!/usr/bin/env python3
"""
MeetingAssistant transcription + diarization pipeline.

Reads:
    <meeting-dir>/mic.wav      (the user's microphone, labeled as "You")
    <meeting-dir>/system.wav   (the other participants — what came out of the Mac)

Writes:
    <meeting-dir>/transcript.json
        {
          "meta": { "duration": float, "language": "es"|"en", "model": str },
          "speakers": ["You", "Speaker_A", "Speaker_B", ...],
          "segments": [
            { "start": 0.42, "end": 3.10, "speaker": "You",
              "text": "...", "language": "es" },
            ...
          ]
        }

Status / progress is reported as newline-delimited JSON on stdout so the
Electron host can show a progress bar. Final line is { "status": "done", ... }.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional


def emit(payload: dict) -> None:
    """Print a status line as JSON for the parent process."""
    payload["ts"] = time.time()
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message: str, code: int = 1):
    emit({"status": "error", "message": message})
    sys.exit(code)


# --------------------------------------------------------------------- helpers

@dataclass
class Segment:
    start: float
    end: float
    speaker: str
    text: str
    language: str

    def to_dict(self) -> dict:
        return asdict(self)


def wav_duration(path: Path) -> float:
    """Read WAV duration from header without loading samples."""
    import wave
    try:
        with wave.open(str(path), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            return frames / float(rate) if rate else 0.0
    except Exception:
        return 0.0


def has_audio(path: Path, min_duration: float = 0.5) -> bool:
    """Cheap check that a WAV file has at least some real audio."""
    if not path.exists():
        return False
    if path.stat().st_size < 1024:
        return False
    return wav_duration(path) >= min_duration


# --------------------------------------------------------------- transcription

def transcribe_file(
    wav: Path,
    *,
    model_name: str,
    device: str,
    compute_type: str,
    language: Optional[str],
    batch_size: int,
) -> dict:
    """Run WhisperX transcription + alignment on a single wav. Returns the
    aligned WhisperX result dict.
    """
    import whisperx

    emit({"status": "loading_whisper", "model": model_name, "device": device})
    asr = whisperx.load_model(
        model_name,
        device=device,
        compute_type=compute_type,
        language=language,  # None = auto-detect
    )

    emit({"status": "loading_audio", "path": str(wav)})
    audio = whisperx.load_audio(str(wav))

    emit({"status": "transcribing", "path": str(wav)})
    result = asr.transcribe(audio, batch_size=batch_size)

    detected_lang = result.get("language") or language or "en"
    emit({"status": "language_detected", "language": detected_lang})

    # Word-level alignment for accurate timestamps (needed for clean diarization
    # merge later).
    try:
        emit({"status": "aligning"})
        model_a, metadata = whisperx.load_align_model(language_code=detected_lang, device=device)
        result = whisperx.align(
            result["segments"],
            model_a,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        result["language"] = detected_lang
    except Exception as e:
        # Alignment is best-effort; fall back to chunk-level timestamps.
        emit({"status": "align_skipped", "message": str(e)})
        result["language"] = detected_lang

    return result


# ----------------------------------------------------------------- diarization

def diarize_file(wav: Path, *, device: str, hf_token: Optional[str]) -> "list[tuple[float, float, str]]":
    """Run pyannote speaker diarization on a single wav. Returns
    [(start, end, label)] sorted by start time."""
    emit({"status": "loading_diarizer"})

    # pyannote.audio Pipeline. Works with pyannote-audio >= 3.1, including 4.x.
    from pyannote.audio import Pipeline
    import torch

    pipe = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )
    if pipe is None:
        raise RuntimeError(
            "pyannote pipeline returned None. The model probably hasn't been "
            "downloaded yet. Set HUGGINGFACE_TOKEN env var to a token that has "
            "accepted the pyannote/speaker-diarization-3.1 user conditions, "
            "then re-run."
        )

    # Move to device if possible (MPS not officially supported by pyannote,
    # so we use cpu by default on Mac).
    try:
        pipe.to(torch.device(device))
    except Exception:
        pass

    emit({"status": "diarizing", "path": str(wav)})
    diarization = pipe(str(wav))

    turns: list[tuple[float, float, str]] = []
    # Stable label ordering: rename SPEAKER_00 → Speaker_A etc.
    label_map: dict[str, str] = {}
    next_letter = 0
    for turn, _, raw_label in diarization.itertracks(yield_label=True):
        if raw_label not in label_map:
            label_map[raw_label] = f"Speaker_{chr(ord('A') + next_letter)}"
            next_letter += 1
        turns.append((float(turn.start), float(turn.end), label_map[raw_label]))
    turns.sort(key=lambda t: t[0])
    return turns


def assign_speakers(segments: list[dict], turns: "list[tuple[float, float, str]]") -> list[dict]:
    """For each WhisperX segment, attach the speaker whose turn overlaps it
    the most.
    """
    for seg in segments:
        s, e = float(seg["start"]), float(seg["end"])
        best_label = "Speaker_A"  # safe default if no turns at all
        best_overlap = 0.0
        for ts, te, label in turns:
            if te < s:
                continue
            if ts > e:
                break
            overlap = max(0.0, min(e, te) - max(s, ts))
            if overlap > best_overlap:
                best_overlap = overlap
                best_label = label
        seg["speaker"] = best_label
    return segments


# ----------------------------------------------------------------------- merge

def whisperx_to_segments(
    result: dict,
    *,
    speaker: Optional[str],
    language: str,
) -> list[Segment]:
    """Convert WhisperX result dict to our internal Segment list."""
    out: list[Segment] = []
    for seg in result.get("segments", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        spk = speaker or seg.get("speaker") or "Speaker_A"
        out.append(Segment(
            start=float(seg.get("start", 0.0)),
            end=float(seg.get("end", 0.0)),
            speaker=spk,
            text=text,
            language=language,
        ))
    return out


# ------------------------------------------------------------------------ main

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--meeting-dir", required=True,
                        help="Directory containing mic.wav and/or system.wav")
    parser.add_argument("--model", default=os.environ.get("MA_WHISPER_MODEL", "large-v3"))
    parser.add_argument("--device", default="cpu",
                        help="Device for WhisperX (cpu recommended on Apple Silicon)")
    parser.add_argument("--compute-type", default=os.environ.get("MA_COMPUTE_TYPE", "int8"))
    parser.add_argument("--language", default=None,
                        help="Force language code ('es', 'en'). Default: auto-detect.")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--skip-diarization", action="store_true",
                        help="Skip pyannote diarization (faster, but speakers in"
                             " system audio won't be separated).")
    args = parser.parse_args()

    meeting_dir = Path(args.meeting_dir).expanduser().resolve()
    mic = meeting_dir / "mic.wav"
    system = meeting_dir / "system.wav"

    if not has_audio(mic) and not has_audio(system):
        fail(f"No usable audio found in {meeting_dir} (mic.wav and system.wav are both empty or missing).")

    emit({"status": "started",
          "meeting_dir": str(meeting_dir),
          "has_mic": has_audio(mic),
          "has_system": has_audio(system)})

    hf_token = os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")
    all_segments: list[Segment] = []
    detected_language = args.language or "en"

    # --- 1) Transcribe the user's mic — they are always "You", no diarization
    if has_audio(mic):
        try:
            mic_result = transcribe_file(
                mic,
                model_name=args.model,
                device=args.device,
                compute_type=args.compute_type,
                language=args.language,
                batch_size=args.batch_size,
            )
            detected_language = mic_result.get("language", detected_language)
            mic_segs = whisperx_to_segments(mic_result, speaker="You", language=detected_language)
            all_segments.extend(mic_segs)
            emit({"status": "mic_done", "segments": len(mic_segs)})
        except Exception as e:
            emit({"status": "mic_failed", "message": str(e)})

    # --- 2) Transcribe the system track and diarize it
    if has_audio(system):
        try:
            sys_result = transcribe_file(
                system,
                model_name=args.model,
                device=args.device,
                compute_type=args.compute_type,
                language=args.language or detected_language,
                batch_size=args.batch_size,
            )
            sys_lang = sys_result.get("language", detected_language)
            detected_language = sys_lang

            if args.skip_diarization:
                sys_segs = whisperx_to_segments(sys_result, speaker="Speaker_A", language=sys_lang)
            else:
                try:
                    turns = diarize_file(system, device="cpu", hf_token=hf_token)
                    assigned = assign_speakers(sys_result.get("segments", []), turns)
                    sys_result["segments"] = assigned
                    sys_segs = whisperx_to_segments(sys_result, speaker=None, language=sys_lang)
                except Exception as e:
                    emit({"status": "diarize_failed", "message": str(e)})
                    sys_segs = whisperx_to_segments(sys_result, speaker="Speaker_A", language=sys_lang)
            all_segments.extend(sys_segs)
            emit({"status": "system_done", "segments": len(sys_segs)})
        except Exception as e:
            emit({"status": "system_failed", "message": str(e)})

    # --- 3) Merge: sort by start time
    all_segments.sort(key=lambda s: s.start)

    duration = max(
        (s.end for s in all_segments), default=0.0
    )
    if duration == 0.0:
        duration = max(wav_duration(mic), wav_duration(system))

    speakers = []
    for s in all_segments:
        if s.speaker not in speakers:
            speakers.append(s.speaker)

    out_payload = {
        "meta": {
            "duration": duration,
            "language": detected_language,
            "model": args.model,
            "diarized": not args.skip_diarization,
            "created_at": time.time(),
        },
        "speakers": speakers,
        "segments": [s.to_dict() for s in all_segments],
    }

    out_path = meeting_dir / "transcript.json"
    out_path.write_text(json.dumps(out_payload, ensure_ascii=False, indent=2))

    emit({
        "status": "done",
        "transcript": str(out_path),
        "segments": len(all_segments),
        "duration": duration,
        "language": detected_language,
        "speakers": speakers,
    })


if __name__ == "__main__":
    main()
