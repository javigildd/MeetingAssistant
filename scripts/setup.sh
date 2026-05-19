#!/usr/bin/env bash
# One-shot setup helper. Idempotent.
#
# Detects an existing whisperx Python venv, builds the Swift recorder, installs
# JS deps, and writes a starter .env if you don't have one. Run from the repo
# root: bash scripts/setup.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

say() { printf "\033[1;36m▸\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
ok() { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# 1. Check tools ------------------------------------------------------------
say "Checking required tools"
command -v swift >/dev/null 2>&1 || fail "swift not found. Install Xcode Command Line Tools: xcode-select --install"
command -v node >/dev/null 2>&1 || fail "node not found. Install Node 20+."
command -v npm >/dev/null 2>&1 || fail "npm not found."
ok "swift $(swift --version | head -1 | sed 's/swift-driver version: //')"
ok "node $(node --version)"

# 2. Try to find a Python with whisperx -------------------------------------
say "Looking for a Python interpreter with WhisperX installed"
PYTHON=""
CANDIDATES=()
# Common venv locations users might have:
for p in \
  "$HOME/Library/Application Support/whisperx-venv/bin/python" \
  "$HOME/Library/Application Support/jg-aescripts/whisperx-venv/bin/python" \
  "$HOME/.whisperx/bin/python" \
  "$HOME/whisperx/bin/python" \
  "$HOME/.venv/whisperx/bin/python"
do
  if [[ -x "$p" ]]; then
    CANDIDATES+=("$p")
  fi
done
# Also try whisperx on PATH.
if command -v whisperx >/dev/null 2>&1; then
  # The interpreter that ships whisperx
  PY_VIA_WHISPERX="$(head -1 "$(command -v whisperx)" | sed 's|^#!||')"
  if [[ -x "$PY_VIA_WHISPERX" ]]; then
    CANDIDATES+=("$PY_VIA_WHISPERX")
  fi
fi

for cand in "${CANDIDATES[@]}"; do
  if "$cand" -c "import whisperx" >/dev/null 2>&1; then
    PYTHON="$cand"
    break
  fi
done

if [[ -n "$PYTHON" ]]; then
  ok "Found WhisperX at: $PYTHON"
else
  warn "No interpreter with whisperx found. You'll need to set MA_PYTHON in"
  warn ".env or the app's Settings screen. See packages/pipeline/README.md."
fi

# 3. Build the Swift recorder ----------------------------------------------
say "Building the Swift recorder (marec)"
npm run build:recorder >/dev/null
ok "Recorder built at apps/desktop/resources/bin/marec"

# 4. Install JS deps --------------------------------------------------------
say "Installing JS dependencies (this can take a minute the first time)"
npm install >/dev/null
ok "JS deps installed"

# 5. Seed .env if missing ---------------------------------------------------
if [[ ! -f "$ROOT/.env" ]]; then
  say "Writing starter .env"
  cp "$ROOT/.env.example" "$ROOT/.env"
  if [[ -n "$PYTHON" ]]; then
    # Use a different sed for portability — print to a temp file.
    sed -i.bak "s|^MA_PYTHON=.*|MA_PYTHON=$PYTHON|" "$ROOT/.env"
    rm -f "$ROOT/.env.bak"
  fi
  ok ".env created (edit it to add your OpenAI key)"
else
  warn ".env already exists — leaving it alone"
fi

echo
ok "Setup complete!"
echo
echo "Next steps:"
echo "  1. Open .env and set OPENAI_API_KEY=sk-..."
echo "  2. (One-time) Get a Hugging Face token and accept the user conditions for:"
echo "       https://huggingface.co/pyannote/speaker-diarization-3.1"
echo "       https://huggingface.co/pyannote/segmentation-3.0"
echo "     Then set HUGGINGFACE_TOKEN= in .env."
echo "  3. npm run dev"
echo "  4. The first recording will trigger macOS permission prompts for"
echo "     Screen Recording and Microphone. Grant both and try again."
