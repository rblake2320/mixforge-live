"""MixForge local stem-separation engine.

Self-hosted replacement for the external StemSplit provider: a FastAPI job
service that runs Demucs-class source separation on a local NVIDIA GPU and
speaks the same job vocabulary MixForge already maps (PENDING / PROCESSING /
COMPLETED / FAILED, outputs keyed by stem name).

Run:
    python -m uvicorn engine:app --host 127.0.0.1 --port 9077

Environment:
    STEM_ENGINE_MODEL      demucs model name (default: htdemucs; htdemucs_ft = higher quality, ~4x slower)
    STEM_ENGINE_DATA       work dir for inputs/outputs (default: ./data next to this file)
    STEM_ENGINE_API_KEY    if set, requests must send X-API-Key
    STEM_ENGINE_PUBLIC_URL base URL used in output links (default: http://127.0.0.1:9077)
    STEM_ENGINE_MAX_BYTES  max upload/download size (default 200MB)
"""

import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

MODEL_NAME = os.environ.get("STEM_ENGINE_MODEL", "htdemucs")
DATA_ROOT = Path(os.environ.get("STEM_ENGINE_DATA", Path(__file__).parent / "data"))
API_KEY = os.environ.get("STEM_ENGINE_API_KEY", "")
PUBLIC_URL = os.environ.get("STEM_ENGINE_PUBLIC_URL", "http://127.0.0.1:9077").rstrip("/")
MAX_BYTES = int(os.environ.get("STEM_ENGINE_MAX_BYTES", 200 * 1024 * 1024))
ALLOWED_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".webm"}

app = FastAPI(title="mixforge-stem-engine", version="0.1.0")

# One GPU -> one separation at a time. Queued jobs wait their turn.
_executor = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_separator = None
_separator_lock = threading.Lock()
_device = "unknown"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _get_separator():
    """Load the Demucs model once, on first use (weights download on first run)."""
    global _separator, _device
    with _separator_lock:
        if _separator is None:
            import torch
            from demucs import api as demucs_api

            _device = "cuda" if torch.cuda.is_available() else "cpu"
            _separator = demucs_api.Separator(model=MODEL_NAME, device=_device)
        return _separator


def _require_key(x_api_key: str | None):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key.")


def _job_public(job: dict) -> dict:
    return {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "outputs": job["outputs"],
        "analysis": job["analysis"],
        "createdAt": job["createdAt"],
        "completedAt": job["completedAt"],
        "errorMessage": job["errorMessage"],
        "model": MODEL_NAME,
        "device": _device,
        "durationSeconds": job.get("durationSeconds"),
        "separationSeconds": job.get("separationSeconds"),
    }


def _set(job_id: str, **fields):
    with _jobs_lock:
        _jobs[job_id].update(fields)
        job_dir = DATA_ROOT / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "manifest.json").write_text(json.dumps(_jobs[job_id], indent=2))


def _analyze(audio_path: Path) -> dict:
    """Tempo and key estimate — powers MixForge's BPM-sync / key-match promise."""
    import librosa

    y, sr = librosa.load(str(audio_path), mono=True, duration=120)
    tempo = librosa.feature.tempo(y=y, sr=sr)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    pitch_classes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    # Krumhansl-Schmuckler style correlation against major/minor profiles.
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    scores = []
    for shift in range(12):
        rolled = np.roll(chroma, -shift)
        scores.append(("maj", shift, float(np.corrcoef(rolled, major)[0, 1])))
        scores.append(("min", shift, float(np.corrcoef(rolled, minor)[0, 1])))
    mode, shift, _ = max(scores, key=lambda s: s[2])
    key = f"{pitch_classes[shift]}{'maj' if mode == 'maj' else 'm'}"
    return {
        "bpm": round(float(tempo[0]), 1) if len(tempo) else None,
        "key": key,
        "durationSeconds": round(float(len(y) / sr), 2),
    }


def _run_job(job_id: str, input_path: Path):
    started = time.perf_counter()
    try:
        _set(job_id, status="PROCESSING", progress=10)
        analysis = {}
        try:
            analysis = _analyze(input_path)
        except Exception as error:  # analysis is best-effort; separation is the product
            analysis = {"error": f"analysis failed: {error}"}
        _set(job_id, progress=25, analysis=analysis, durationSeconds=analysis.get("durationSeconds"))

        separator = _get_separator()
        _set(job_id, progress=35)
        _origin, separated = separator.separate_audio_file(str(input_path))
        _set(job_id, progress=85)

        from demucs import api as demucs_api

        out_dir = DATA_ROOT / job_id / "stems"
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = {}
        for stem, tensor in separated.items():
            stem_file = out_dir / f"{stem}.wav"
            demucs_api.save_audio(tensor, str(stem_file), samplerate=separator.samplerate)
            outputs[stem] = {
                "url": f"{PUBLIC_URL}/v1/outputs/{job_id}/{stem}.wav",
                "expiresAt": None,
            }
        _set(
            job_id,
            status="COMPLETED",
            progress=100,
            outputs=outputs,
            completedAt=_now_iso(),
            separationSeconds=round(time.perf_counter() - started, 2),
        )
    except Exception as error:
        _set(
            job_id,
            status="FAILED",
            errorMessage=str(error),
            completedAt=_now_iso(),
            separationSeconds=round(time.perf_counter() - started, 2),
        )


def _create_job(input_path: Path) -> dict:
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "PENDING",
        "progress": 0,
        "outputs": None,
        "analysis": None,
        "createdAt": _now_iso(),
        "completedAt": None,
        "errorMessage": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    _set(job_id)  # persist manifest
    _executor.submit(_run_job, job_id, input_path)
    return job


class UrlJobRequest(BaseModel):
    sourceUrl: str
    metadata: dict | None = None


@app.get("/health")
def health():
    import torch

    return {
        "ok": True,
        "service": "mixforge-stem-engine",
        "version": "0.1.0",
        "model": MODEL_NAME,
        "cudaAvailable": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "jobs": len(_jobs),
    }


@app.post("/v1/jobs")
async def create_job_upload(audio: UploadFile = File(...), x_api_key: str | None = Header(default=None)):
    _require_key(x_api_key)
    suffix = Path(audio.filename or "upload.wav").suffix.lower() or ".wav"
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"Unsupported audio type: {suffix}")
    body = await audio.read()
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Audio exceeds the engine size limit.")
    job_id_dir = DATA_ROOT / "incoming"
    job_id_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_id_dir / f"{uuid.uuid4().hex}{suffix}"
    input_path.write_bytes(body)
    return _job_public(_create_job(input_path))


@app.post("/v1/jobs/url")
def create_job_url(payload: UrlJobRequest, x_api_key: str | None = Header(default=None)):
    """Direct http(s) audio links only — the engine never rips streaming sites."""
    _require_key(x_api_key)
    if not payload.sourceUrl.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="sourceUrl must be http(s).")
    suffix = Path(payload.sourceUrl.split("?")[0]).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="sourceUrl must point directly at an audio file (wav/mp3/flac/ogg/m4a/aac/opus/webm).",
        )
    request = Request(payload.sourceUrl, headers={"User-Agent": "mixforge-stem-engine/0.1"})
    with urlopen(request, timeout=60) as response:  # noqa: S310 - scheme validated above
        body = response.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Audio exceeds the engine size limit.")
    incoming = DATA_ROOT / "incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    input_path = incoming / f"{uuid.uuid4().hex}{suffix}"
    input_path.write_bytes(body)
    return _job_public(_create_job(input_path))


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, x_api_key: str | None = Header(default=None)):
    _require_key(x_api_key)
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        manifest = DATA_ROOT / job_id / "manifest.json"
        if manifest.exists():
            job = json.loads(manifest.read_text())
            with _jobs_lock:
                _jobs[job_id] = job
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return _job_public(job)


@app.get("/v1/outputs/{job_id}/{stem_file}")
def get_output(job_id: str, stem_file: str):
    # Serve separated stems. Path segments are validated, never joined raw.
    if "/" in stem_file or "\\" in stem_file or ".." in job_id or ".." in stem_file:
        raise HTTPException(status_code=400, detail="Invalid path.")
    path = (DATA_ROOT / job_id / "stems" / stem_file).resolve()
    if not str(path).startswith(str(DATA_ROOT.resolve())) or not path.exists():
        raise HTTPException(status_code=404, detail="Output not found.")
    return FileResponse(path, media_type="audio/wav")
