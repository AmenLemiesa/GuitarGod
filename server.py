#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from flask import Flask, request, jsonify, send_from_directory, send_file
import librosa
import numpy as np

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 150 * 1024 * 1024  # 150 MB upload limit

# In-memory registry of short-lived fallback audio files: audio_id -> filepath
_audio_store: dict = {}
_audio_lock = threading.Lock()

def _schedule_audio_cleanup(audio_id: str, path: str, delay: int = 7200):
    """Delete a temp mp3 file after `delay` seconds (default 2 h)."""
    def _run():
        time.sleep(delay)
        with _audio_lock:
            _audio_store.pop(audio_id, None)
        try:
            os.remove(path)
        except OSError:
            pass
    threading.Thread(target=_run, daemon=True).start()




MAX_DURATION = 300  # 5 minutes — keeps peak memory under ~250 MB

def generate_chart(audio_path):
    SR = 16000
    HOP = 512

    y, sr = librosa.load(audio_path, sr=SR, mono=True, duration=MAX_DURATION)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # Beat tracking
    tempo_arr, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP)
    tempo = float(np.atleast_1d(tempo_arr)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)

    # RMS noise gate — per-frame energy, used to reject silent / bleed-through regions
    frame_rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms_peak  = float(np.max(frame_rms)) + 1e-9
    # A frame must reach at least 6% of peak RMS to produce a note.
    # This filters demucs bleed-through noise while keeping genuine soft notes.
    NOISE_GATE = 0.06

    # Onset detection
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, aggregate=np.median)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=HOP,
        backtrack=True, units="frames", delta=0.10,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP)
    onset_strengths = onset_env[np.clip(onset_frames, 0, len(onset_env) - 1)]

    # Apply noise gate: drop onsets in silent / near-silent regions
    gate_mask = np.array([
        float(frame_rms[min(f, len(frame_rms) - 1)]) / rms_peak >= NOISE_GATE
        for f in onset_frames
    ])
    onset_frames    = onset_frames[gate_mask]
    onset_times     = onset_times[gate_mask]
    onset_strengths = onset_strengths[gate_mask]

    # Harmonic/percussive separation
    y_harm, y_perc = librosa.effects.hpss(y)
    harm_stft = np.abs(librosa.stft(y_harm, hop_length=HOP))
    perc_stft = np.abs(librosa.stft(y_perc, hop_length=HOP))
    harm_rms = np.sqrt(np.mean(harm_stft ** 2, axis=0))
    perc_rms = np.sqrt(np.mean(perc_stft ** 2, axis=0))

    # Spectral centroid — smoothed with moving average for stable lane mapping
    centroid_raw = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=HOP)[0]
    win = 21
    centroid = np.convolve(centroid_raw, np.ones(win) / win, mode='same')

    # Global 5th–95th percentile range for consistent lane mapping across the song
    c_lo = float(np.percentile(centroid, 5))
    c_hi = float(np.percentile(centroid, 95))

    def centroid_to_lane(frame_idx):
        c = float(centroid[min(frame_idx, len(centroid) - 1)])
        norm = (c - c_lo) / max(c_hi - c_lo, 1.0)
        return int(np.clip(norm * 4, 0, 3))

    # Beat-snap: build 8th-note grid, keep strongest onset per slot
    if len(beat_times) > 1:
        avg_beat = float(np.mean(np.diff(beat_times)))
    else:
        avg_beat = 60.0 / max(tempo, 60.0)
    eighth_dur = avg_beat / 2.0

    t_start = float(onset_times[0]) - avg_beat if len(onset_times) else 0.0
    t_start = max(0.0, t_start)
    grid = np.arange(t_start, duration + eighth_dur, eighth_dur)

    slot_best = {}  # slot_idx -> (strength, onset_time, onset_frame_idx)
    for i, (ot, st) in enumerate(zip(onset_times, onset_strengths)):
        slot = int(np.argmin(np.abs(grid - ot)))
        if slot not in slot_best or st > slot_best[slot][0]:
            slot_best[slot] = (float(st), float(ot), int(onset_frames[i]))

    snapped = sorted(slot_best.values(), key=lambda x: x[1])
    if not snapped:
        return {"bpm": tempo, "duration": duration, "notes": []}

    strength_thresh = float(np.percentile([s[0] for s in snapped], 50))

    # Beat index just before time t
    def beat_index_at(t):
        idx = int(np.searchsorted(beat_times, t, side='right')) - 1
        return max(0, idx)

    def phrase_of(t):
        return beat_index_at(t) // 4

    # Per-phrase average energy → density control
    phrase_strengths = {}
    for st, ot, _ in snapped:
        phrase_strengths.setdefault(phrase_of(ot), []).append(st)
    phrase_avg = {p: float(np.mean(v)) for p, v in phrase_strengths.items()}

    if phrase_avg:
        pvals = list(phrase_avg.values())
        e_lo = float(np.percentile(pvals, 33))
        e_hi = float(np.percentile(pvals, 67))
        def phrase_energy(p):
            e = phrase_avg.get(p, e_lo)
            return 'high' if e > e_hi else ('low' if e < e_lo else 'mid')
    else:
        def phrase_energy(p): return 'mid'

    # Percussive rhythm template: kick feel on D/K, hi-hat feel on F/J
    PERC_PATTERN = [0, 1, 3, 2, 0, 2, 3, 1]

    notes = []
    last_lane_time = [-999.0] * 4
    last_lane_free = [-999.0] * 4
    last_any_time = -999.0
    MIN_LANE_GAP = 0.10
    MIN_GLOBAL_GAP = 0.04
    HOLD_MIN = 0.30

    phrase_note_count = {}

    for strength, onset_time, onset_frame in snapped:
        if strength < strength_thresh:
            continue
        if onset_time - last_any_time < MIN_GLOBAL_GAP:
            continue

        p = phrase_of(onset_time)
        energy = phrase_energy(p)

        # Low-energy phrases: space notes out more
        if energy == 'low' and onset_time - last_any_time < 0.20:
            continue

        # Classify onset as percussive or harmonic
        f = min(onset_frame, len(harm_rms) - 1, len(perc_rms) - 1)
        h_e = float(harm_rms[f])
        p_e = float(perc_rms[f])
        perc_ratio = p_e / (h_e + p_e + 1e-9)
        is_percussive = perc_ratio > 0.55

        pidx = phrase_note_count.get(p, 0)
        if is_percussive:
            # Percussion → fixed rhythm template (kick/snare feel)
            preferred = PERC_PATTERN[pidx % len(PERC_PATTERN)]
        else:
            # Harmonic → spectral centroid maps to lane (bass=0 … treble=3)
            preferred = centroid_to_lane(onset_frame)

        # Try preferred lane, then cycle around — skip lanes occupied by a hold
        chosen = None
        for offset in range(4):
            lane = (preferred + offset) % 4
            if (onset_time - last_lane_time[lane] >= MIN_LANE_GAP
                    and onset_time >= last_lane_free[lane]):
                chosen = lane
                break
        if chosen is None:
            continue

        # Hold detection using harmonic RMS sustain
        hold_dur = 0.0
        onset_f = min(onset_frame, len(harm_rms) - 1)
        look_end_t = min(onset_time + 1.6, duration - 0.05)
        look_end_f = min(
            int(librosa.time_to_frames(look_end_t, sr=sr, hop_length=HOP)),
            len(harm_rms) - 1,
        )
        if look_end_f > onset_f:
            onset_e = float(harm_rms[onset_f]) + 1e-9
            window_rms = harm_rms[onset_f : look_end_f + 1]
            ratio = window_rms / onset_e
            drop_idx = np.where(ratio < 0.30)[0]
            if len(drop_idx):
                end_f = onset_f + int(drop_idx[0])
                candidate = (
                    float(librosa.frames_to_time(end_f, sr=sr, hop_length=HOP))
                    - onset_time
                )
                if candidate >= HOLD_MIN:
                    hold_dur = candidate

        notes.append({
            "time": float(onset_time),
            "lane": int(chosen),
            "duration": float(hold_dur),
            "type": "hold" if hold_dur >= HOLD_MIN else "tap",
        })
        last_lane_time[chosen] = onset_time
        if hold_dur >= HOLD_MIN:
            last_lane_free[chosen] = onset_time + hold_dur + 0.08
        last_any_time = onset_time
        phrase_note_count[p] = pidx + 1

        # Chord note on strong beats in high-energy harmonic phrases
        if energy == 'high' and not is_percussive and hold_dur < HOLD_MIN:
            if len(beat_times) > 0:
                nearest_beat_d = float(np.min(np.abs(beat_times - onset_time)))
                beat_tol = avg_beat * 0.12
                if nearest_beat_d < beat_tol:
                    chord_lane = (chosen + 2) % 4  # spread wide across highway
                    if (onset_time - last_lane_time[chord_lane] >= MIN_LANE_GAP
                            and onset_time >= last_lane_free[chord_lane]):
                        notes.append({
                            "time": float(onset_time),
                            "lane": int(chord_lane),
                            "duration": 0.0,
                            "type": "tap",
                        })
                        last_lane_time[chord_lane] = onset_time

    return {"bpm": tempo, "duration": duration, "notes": notes}


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


@app.route("/audio/<audio_id>")
def serve_audio(audio_id):
    # UUID format only — prevents path traversal
    if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', audio_id):
        return "Not found", 404
    with _audio_lock:
        path = _audio_store.get(audio_id)
    if not path or not os.path.exists(path):
        return "Not found", 404
    return send_file(path, mimetype="audio/mpeg")


@app.route("/analyze", methods=["POST"])
def analyze():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if not f or not f.filename:
        return jsonify({"error": "No file selected"}), 400

    mode = (request.form.get("mode") or "original").strip()
    if mode not in ("original", "vocals", "bass", "drums", "guitar"):
        mode = "original"

    title = re.sub(r'\.[^.]+$', '', f.filename) if f.filename else "Unknown"

    work_dir = tempfile.mkdtemp(prefix="guitargod_")
    audio_id = str(uuid.uuid4())
    mp3_path = os.path.join(work_dir, f"{audio_id}.mp3")

    try:
        ext = os.path.splitext(f.filename)[1].lower() if f.filename else ".bin"
        uploaded_path = os.path.join(work_dir, f"upload{ext}")
        f.save(uploaded_path)

        if mode != "original":
            return jsonify({"error": "Stem modes require a paid server upgrade — use ORIGINAL mode"}), 400

        wav_path = os.path.join(work_dir, "audio.wav")
        # Truncate to MAX_DURATION seconds during conversion to keep memory bounded
        res = subprocess.run(
            ["ffmpeg", "-y", "-i", uploaded_path, "-t", str(MAX_DURATION), wav_path],
            capture_output=True,
        )
        if res.returncode != 0 or not os.path.exists(wav_path):
            return jsonify({"error": "Could not decode audio — unsupported format"}), 400
        full_wav = wav_path

        subprocess.run(
            ["ffmpeg", "-y", "-i", full_wav, "-q:a", "6", "-ac", "2", mp3_path],
            capture_output=True,
        )

        analyze_wav = full_wav

        try:
            chart = generate_chart(analyze_wav)
        except Exception as e:
            return jsonify({"error": f"Analysis failed: {e}"}), 500

    finally:
        final_mp3 = os.path.join(tempfile.gettempdir(), f"guitargod_{audio_id}.mp3")
        if os.path.exists(mp3_path):
            shutil.move(mp3_path, final_mp3)
        shutil.rmtree(work_dir, ignore_errors=True)

    if os.path.exists(final_mp3):
        with _audio_lock:
            _audio_store[audio_id] = final_mp3
        _schedule_audio_cleanup(audio_id, final_mp3, delay=7200)

    chart.update({
        "audioId": audio_id,
        "title": title,
        "uploader": "",
        "mode": mode,
    })
    return jsonify(chart)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") == "development"
    app.run(host="0.0.0.0", port=port, debug=debug)
