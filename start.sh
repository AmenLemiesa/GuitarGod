#!/bin/bash
set -e

echo ""
echo "  ♜  GUITAR GOD"
echo ""

if ! command -v python3 &>/dev/null; then
  echo "  Error: python3 not found"; exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
  echo "  Warning: ffmpeg not found — install with: brew install ffmpeg"; echo ""
fi

if [ ! -d ".venv" ]; then
  echo "  Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

if ! python3 -c "import flask, yt_dlp, librosa" &>/dev/null 2>&1; then
  echo "  Installing dependencies..."
  pip install -q -r requirements.txt
fi

export FLASK_ENV=development

echo "  Starting server at http://localhost:5000"
echo ""
python3 server.py
