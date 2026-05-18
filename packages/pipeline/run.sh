#!/usr/bin/env bash
# Invoke the Python pipeline with the right interpreter.
# The interpreter path is read from $MA_PYTHON (set in .env or the Electron
# main process). Falls back to `python3` on PATH.
set -euo pipefail

PY="${MA_PYTHON:-python3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$PY" "$SCRIPT_DIR/run.py" "$@"
