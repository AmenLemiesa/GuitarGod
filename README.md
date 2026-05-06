# Guitar God

Paste any YouTube URL → get a playable Guitar Hero–style chart generated from the audio. Supports 5 modes (Original, Vocals, Bass, Drums, Guitar) and 4 difficulty levels.

## Play

Live at: _coming soon_

## Run locally

**Requirements:** Python 3.11+, ffmpeg

```bash
brew install ffmpeg        # macOS
./start.sh                 # creates venv, installs deps, starts server
# open http://localhost:5000
```

Stem modes (Vocals / Bass / Drums / Guitar) require Demucs:

```bash
source .venv/bin/activate
pip install demucs torchcodec
```

First use of a stem mode downloads the Demucs model (~80 MB) and takes 3–10 minutes to separate audio. Results are cached — subsequent plays are instant.

## Deploy (Render)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service → connect repo
3. Render detects `render.yaml` and configures everything automatically
4. First deploy takes ~5 minutes (Docker build)

## Stack

- **Backend:** Python · Flask · yt-dlp · librosa · Demucs
- **Frontend:** Vanilla JS · HTML5 Canvas · YouTube IFrame API
- **Audio analysis:** onset detection · beat tracking · harmonic/percussive separation · spectral centroid lane mapping
