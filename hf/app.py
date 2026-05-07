import os
import sys
import shutil
import subprocess
import tempfile
import uuid

from flask import Flask, request, jsonify, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024

STEM_NAMES = {"vocals": "vocals", "bass": "bass", "drums": "drums", "guitar": "other"}
MAX_DURATION = 300


@app.after_request
def cors(r):
    r.headers["Access-Control-Allow-Origin"]  = "*"
    r.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return r


@app.route("/separate", methods=["OPTIONS"])
def preflight():
    return "", 204


@app.route("/separate", methods=["POST"])
def separate():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f    = request.files["file"]
    mode = (request.form.get("mode") or "").strip()
    if mode not in STEM_NAMES:
        return jsonify({"error": "Invalid mode"}), 400

    work_dir = tempfile.mkdtemp(prefix="gg_")
    out_mp3  = os.path.join(work_dir, "stem.mp3")

    try:
        ext = os.path.splitext(f.filename or "")[1].lower() or ".bin"
        src = os.path.join(work_dir, f"upload{ext}")
        f.save(src)

        wav = os.path.join(work_dir, "audio.wav")
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-t", str(MAX_DURATION), wav],
            capture_output=True,
        )
        if r.returncode != 0 or not os.path.exists(wav):
            return jsonify({"error": "Cannot decode audio"}), 400

        tmp_out = os.path.join(work_dir, "dtmp")
        track   = os.path.splitext(os.path.basename(wav))[0]
        r = subprocess.run(
            [sys.executable, "-m", "demucs", "-n", "htdemucs",
             "--segment", "8", "--overlap", "0.1",
             "--out", tmp_out, wav],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return jsonify({"error": (r.stderr or r.stdout or "")[-400:]}), 500

        stem_wav = os.path.join(tmp_out, "htdemucs", track, f"{STEM_NAMES[mode]}.wav")
        if not os.path.exists(stem_wav):
            return jsonify({"error": "Stem file not produced"}), 500

        subprocess.run(
            ["ffmpeg", "-y", "-i", stem_wav, "-q:a", "4", "-ac", "2", out_mp3],
            capture_output=True,
        )
        if not os.path.exists(out_mp3):
            return jsonify({"error": "MP3 conversion failed"}), 500

        return send_file(out_mp3, mimetype="audio/mpeg", as_attachment=False)

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7860)
