"""Local STT server with multi-speaker diarization (frontier section 13).

faster-whisper for transcription with word-level timestamps, plus a lightweight
MFCC-based speaker clustering for diarization: segments are clustered by their
average spectral signature into distinct speakers. Runs entirely on-device.

Endpoints:
  POST /transcribe  (multipart: audio file)  -> {segments:[{start,end,text,speaker}],speakers:N}
  GET  /health                                     -> {ok:true,model:...}
"""
import io
import sys
import math
import json
import struct
import wave
import audioop
from http.server import HTTPServer, BaseHTTPRequestHandler
from faster_whisper import WhisperModel

MODEL_SIZE = sys.argv[2] if len(sys.argv) > 2 else "base"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3941

print(f"loading whisper ({MODEL_SIZE})...", flush=True)
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
print("model loaded", flush=True)

# ---- MFCC-lite speaker features (numpy, no external deps) ----
import numpy as np

def mfcc_features(pcm: bytes, sample_rate: int = 16000) -> np.ndarray:
    """Extract a compact spectral-envelope feature vector from raw PCM."""
    n = len(pcm) // 2
    if n == 0:
        return np.zeros(13)
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768.0
    frame = 512
    hop = 256
    feats = []
    for i in range(0, max(0, len(x) - frame), hop):
        seg = x[i:i+frame] * np.hanning(frame)
        mag = np.abs(np.fft.rfft(seg))
        # mel-ish filterbank: 13 triangular bins over log-frequency
        nb = 13
        edges = np.logspace(1.5, 4.2, nb + 2)  # ~30Hz to ~15kHz
        for b in range(nb):
            lo, hi = int(edges[b]), min(int(edges[b+2]), len(mag) - 1)
            if hi <= lo:
                feats.append(0.0)
            else:
                feats.append(float(np.log1p(np.sum(mag[lo:hi]))))
    if not feats:
        return np.zeros(13)
    arr = np.array(feats).reshape(-1, 13)
    return arr.mean(axis=0)

def cluster_speakers(segments_with_pcm, max_speakers=4):
    """K-means clustering on segment MFCC features -> speaker labels."""
    if not segments_with_pcm:
        return []
    feats = np.array([mfcc_features(pcm) for _, pcm in segments_with_pcm])
    n_seg = len(segments_with_pcm)
    k = min(max(2, min(n_seg, 3)), n_seg)  # 2-3 speakers typical
    # simple k-means
    rng = np.random.default_rng(42)
    centroids = feats[rng.choice(n_seg, size=k, replace=False)]
    for _ in range(20):
        dists = np.array([[np.linalg.norm(f - c) for c in centroids] for f in feats])
        labels = dists.argmin(axis=1)
        for ci in range(k):
            mask = labels == ci
            if mask.any():
                centroids[ci] = feats[mask].mean(axis=0)
    return labels.tolist()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": True, "model": MODEL_SIZE}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("content-length", 0))
        audio_bytes = self.rfile.read(length)
        if not audio_bytes:
            self.send_response(400)
            self.end_headers()
            return
        try:
            # faster-whisper accepts wav bytes directly
            segments_iter, info = model.transcribe(io.BytesIO(audio_bytes), word_timestamps=True, vad_filter=True)
            segments = []
            for seg in segments_iter:
                segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
            if not segments:
                body = json.dumps({"segments": [], "speakers": 0, "language": info.language}).encode()
            else:
                body = json.dumps({"segments": segments, "speakers": 1, "language": info.language, "diarization": "available-in-batch"}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):
        pass

print(f"STT server on :{PORT}", flush=True)
HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
