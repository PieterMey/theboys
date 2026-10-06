"""DEAD AIR speech-to-text sidecar: faster-whisper large-v3-turbo on the host GPU.

HTTP on 127.0.0.1:$STT_PORT (default 3100), stdlib only on the HTTP side.

  GET  /health
       -> {ok, device, compute, model, warm, loading, error, langs, queue, loadMs, warmMs, versions}
  POST /transcribe?langs=en,nl&hotwords=Alpha%20Six,Bravo%20Two
       body: raw PCM16LE mono 16 kHz (a 16-bit PCM WAV at any rate is also accepted, for curl debugging)
       -> {text, lang, langProb, langProbs, avgLogprob, durationMs, speechMs, ms, queueMs,
           stages:{vadMs, langMs, asrMs}, segments, dropped}

Pipeline per request (one GPU worker thread, requests queue up in order):
  1. Silero VAD (faster-whisper's own, i.e. what vad_filter=True runs). No speech -> empty text,
     no decoding at all. That kills most "Thank you." hallucinations on silence.
  2. Language: Whisper's language head over the speech-only audio, restricted to `langs` and
     renormalised. One language in `langs` skips detection.
  3. Greedy decode (beam 1, temperature 0, condition_on_previous_text=False) of the
     speech-only audio with that language. vad_filter is not re-run inside transcribe()
     because step 1 already removed the non-speech audio.
  4. Drop segments with avg_logprob < -0.6 or compression_ratio > 2.4, and known hallucinations.

Transcripts are never logged unless STT_LOG_TEXT=1 (they are players' private speech).

CLI:
  python server.py             run the server
  python server.py --check     CUDA DLL/device smoke test (no model load); exit 1 if CUDA unusable
  python server.py --download  fetch the model into HF_HOME (services/stt/models) and exit

Env: STT_PORT (3100), STT_HOST (127.0.0.1), STT_MODEL (large-v3-turbo), STT_LANGS (en,nl),
     STT_DEVICE (auto|cuda|cpu), STT_COMPUTE (force one compute type), STT_MIN_LOGPROB (-0.6),
     STT_MAX_COMPRESSION (2.4), STT_MAX_SECONDS (60), STT_QUEUE_MAX (16), STT_TIMEOUT_S (30),
     STT_CPU_THREADS (8), STT_LOG_TEXT (0), STT_ENCODER_REUSE (1), HF_HOME (services/stt/models).
"""

from __future__ import annotations

import glob
import json
import os
import re
import site
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))

# --- environment defaults (before huggingface_hub / faster_whisper are imported) -----------------
os.environ.setdefault("HF_HOME", os.path.join(HERE, "models"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:  # pragma: no cover - non-standard streams
    pass


def log(msg: str) -> None:
    print(f"[stt] {msg}", flush=True)


# --- Windows: make pip's nvidia-* DLLs (cuBLAS, NVRTC) findable BEFORE importing ctranslate2 --------
_DLL_HANDLES = []  # keep the add_dll_directory cookies alive for the process lifetime
DLL_DIRS: list[str] = []


def _setup_cuda_dll_path() -> None:
    if sys.platform != "win32":
        return
    roots = []
    for p in list(sys.path) + list(site.getsitepackages()):
        if p and os.path.isdir(os.path.join(p, "nvidia")) and p not in roots:
            roots.append(p)
    for root in roots:
        for bin_dir in sorted(glob.glob(os.path.join(root, "nvidia", "*", "bin"))):
            if bin_dir in DLL_DIRS:
                continue
            try:
                _DLL_HANDLES.append(os.add_dll_directory(bin_dir))
            except OSError:
                continue
            DLL_DIRS.append(bin_dir)
    if DLL_DIRS:
        os.environ["PATH"] = os.pathsep.join(DLL_DIRS + [os.environ.get("PATH", "")])


_setup_cuda_dll_path()

import numpy as np  # noqa: E402

# --- configuration -------------------------------------------------------------------------------
SAMPLE_RATE = 16000
MODEL_NAME = os.environ.get("STT_MODEL", "large-v3-turbo")
HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "3100"))
DEFAULT_LANGS = [s.strip().lower() for s in os.environ.get("STT_LANGS", "en,nl").split(",") if s.strip()]
MIN_LOGPROB = float(os.environ.get("STT_MIN_LOGPROB", "-0.6"))
MAX_COMPRESSION = float(os.environ.get("STT_MAX_COMPRESSION", "2.4"))
MAX_SECONDS = float(os.environ.get("STT_MAX_SECONDS", "60"))
MAX_BYTES = int(MAX_SECONDS * SAMPLE_RATE * 2) + 4096
QUEUE_MAX = int(os.environ.get("STT_QUEUE_MAX", "16"))
REQUEST_TIMEOUT_S = float(os.environ.get("STT_TIMEOUT_S", "30"))
CPU_THREADS = int(os.environ.get("STT_CPU_THREADS", str(min(8, os.cpu_count() or 4))))
LOG_TEXT = os.environ.get("STT_LOG_TEXT", "0") == "1"
MAX_HOTWORDS = 40
MAX_HOTWORDS_CHARS = 400

# Known Whisper hallucinations on silence/noise (matched against the normalised segment text).
BLOCK_EXACT = {
    "",
    "you",
    "thank you",
    "thank you very much",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching bye",
    "please subscribe",
    "ondertiteling",
    "ondertiteld door",
    "ondertitels",
    "bedankt voor het kijken",
    "bedankt voor het kijken en tot de volgende keer",
}
BLOCK_PATTERNS = [
    re.compile(p)
    for p in (
        r"ondertitel",  # "Ondertiteling door de Amara.org gemeenschap", "Ondertiteld door ..."
        r"amara\s*\.?\s*org",
        r"\bsubtitles?\s+(by|from)\b",
        r"\bcaptions?\s+by\b",
        r"\bthanks?\s+(you\s+)?for\s+watching\b",
        r"\bbedankt\s+voor\s+het\s+kijken\b",
        r"\bplease\s+subscribe\b",
        r"\babonneer\b",
        r"\btv\s+gelderland\b",
    )
]


def normalise(text: str) -> str:
    t = text.lower().strip()
    t = re.sub(r"[^\w\s'.]", " ", t)  # keep dots for "amara.org"
    t = re.sub(r"\.(?!\w)", " ", t)  # ...but drop sentence dots
    return re.sub(r"\s+", " ", t).strip()


def is_hallucination(text: str) -> bool:
    n = normalise(text)
    if n in BLOCK_EXACT:
        return True
    return any(p.search(n) for p in BLOCK_PATTERNS)


# --- model state ---------------------------------------------------------------------------------
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.model = None
        self.device = None
        self.compute = None
        self.warm = False
        self.loading = True
        self.error = None
        self.attempts: list[dict] = []
        self.load_ms = None
        self.warm_ms = None
        self.pending = 0
        self.started = time.time()
        self.versions: dict = {}
        self.supported_langs: set[str] = set()
        self.reuse = None  # EncoderReuse, set once the model is loaded


STATE = State()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt-gpu")  # the single worker queue


class EncoderReuse:
    """One-shot cache so transcribe() reuses the encoder pass already run for language detection.

    WhisperModel.transcribe() always re-encodes the first 30 s window (it passes no encoder output to
    generate_segments), which costs about 45 ms on the 5090. This wrapper shadows model.encode on the
    instance: if the next encode() gets exactly the primed window it returns the primed output,
    otherwise it encodes normally, so a miss is only slower, never wrong. Used by the single GPU
    worker thread only.
    """

    def __init__(self, model) -> None:
        self._encode = model.encode
        self._key = None
        self._val = None
        self.hits = 0
        model.encode = self

    def prime(self, window: np.ndarray, encoder_output) -> None:
        self._key, self._val = window, encoder_output

    def clear(self) -> None:
        self._key = self._val = None

    def __call__(self, features: np.ndarray):
        key, val = self._key, self._val
        self._key = self._val = None
        if key is not None and features.shape == key.shape and np.array_equal(features, key):
            self.hits += 1
            return val
        return self._encode(features)


def _vad_options():
    from faster_whisper.vad import VadOptions

    return VadOptions()  # faster-whisper defaults (what vad_filter=True uses)


def resolve_model_path(name: str, allow_download: bool) -> str:
    from faster_whisper.utils import download_model

    if os.path.isdir(name):
        return name
    try:
        return download_model(name, local_files_only=True)
    except Exception:
        if not allow_download:
            raise
        log(f"model {name} not in HF_HOME={os.environ['HF_HOME']}; downloading (about 1.6 GB)")
        return download_model(name)


def _candidates() -> list[tuple[str, str]]:
    import ctranslate2

    want_dev = os.environ.get("STT_DEVICE", "auto").lower()
    want_ct = os.environ.get("STT_COMPUTE")
    cands = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
    try:
        n_cuda = ctranslate2.get_cuda_device_count()
    except Exception:
        n_cuda = 0
    if n_cuda == 0:
        log("no CUDA device visible to CTranslate2; using CPU")
        cands = [c for c in cands if c[0] == "cpu"]
    if want_dev in ("cuda", "cpu"):
        cands = [c for c in cands if c[0] == want_dev] or [(want_dev, "float16" if want_dev == "cuda" else "int8")]
    if want_ct:
        cands = [(cands[0][0] if cands else "cuda", want_ct)]
    return cands


def _warm_up(model) -> None:
    from faster_whisper.vad import get_speech_timestamps

    silence = np.zeros(SAMPLE_RATE, dtype=np.float32)  # 1 s
    # Exercise the full GPU path (encoder + decoder + cuBLAS); VAD would skip decoding on silence.
    segs, _ = model.transcribe(
        silence,
        language="en",
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=False,
    )
    list(segs)
    model.detect_language(silence)  # language head
    get_speech_timestamps(silence, _vad_options())  # loads the Silero VAD ONNX session


def load_model() -> None:
    """Runs on the GPU worker thread: load with fallbacks, then warm up."""
    import ctranslate2
    import faster_whisper
    from faster_whisper import WhisperModel

    STATE.versions = {"fasterWhisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__}
    try:
        path = resolve_model_path(MODEL_NAME, allow_download=True)
    except Exception as e:  # pragma: no cover - network/cache failure
        STATE.error = f"model unavailable: {e!r}"
        STATE.loading = False
        log(STATE.error)
        return

    for device, compute in _candidates():
        t0 = time.perf_counter()
        try:
            model = WhisperModel(
                path,
                device=device,
                compute_type=compute,
                cpu_threads=CPU_THREADS if device == "cpu" else 0,
                num_workers=1,
            )
            t1 = time.perf_counter()
            _warm_up(model)
            t2 = time.perf_counter()
        except Exception as e:
            msg = f"{device}/{compute} failed: {type(e).__name__}: {e}"
            STATE.attempts.append({"device": device, "compute": compute, "error": str(e)[:300]})
            log(msg)
            continue
        actual = getattr(model.model, "compute_type", None) or compute
        if os.environ.get("STT_ENCODER_REUSE", "1") != "0":  # kill-switch for the internal hook
            STATE.reuse = EncoderReuse(model)
        STATE.model = model
        STATE.device = device
        STATE.compute = actual
        STATE.load_ms = round((t1 - t0) * 1000)
        STATE.warm_ms = round((t2 - t1) * 1000)
        STATE.supported_langs = set(model.supported_languages)
        STATE.warm = True
        STATE.loading = False
        STATE.error = None
        fallback = "" if (device, compute) == ("cuda", "float16") else "  (FALLBACK)"
        log(
            f"model {MODEL_NAME} loaded on {device} compute={actual} "
            f"(requested {compute}) in {STATE.load_ms} ms, warm-up {STATE.warm_ms} ms{fallback}"
        )
        return
    STATE.loading = False
    STATE.error = "all device/compute candidates failed"
    log(STATE.error)


# --- request processing --------------------------------------------------------------------------
class BadRequest(Exception):
    pass


def _resample_fft(x: np.ndarray, rate: int) -> np.ndarray:
    """Band-limited FFT resampling to 16 kHz. Only for the WAV debugging path (e.g. 48 kHz fixtures)."""
    n_out = int(round(len(x) * SAMPLE_RATE / rate))
    if n_out <= 0 or len(x) == 0:
        return np.zeros(0, dtype=np.float32)
    spec = np.fft.rfft(x)
    out = np.zeros(n_out // 2 + 1, dtype=np.complex128)
    k = min(len(spec), len(out))
    out[:k] = spec[:k]
    return (np.fft.irfft(out, n_out) * (n_out / len(x))).astype(np.float32)


def decode_body(body: bytes) -> np.ndarray:
    if body[:4] == b"RIFF" and body[8:12] == b"WAVE":
        import io
        import wave

        try:
            with wave.open(io.BytesIO(body), "rb") as w:
                ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
                raw = w.readframes(n)
        except (wave.Error, EOFError) as e:
            raise BadRequest(f"unreadable WAV: {e}")
        if width != 2:
            raise BadRequest(f"WAV must be 16-bit PCM (got {width * 8}-bit); send raw PCM16LE instead")
        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if ch > 1:
            pcm = pcm[: len(pcm) // ch * ch].reshape(-1, ch).mean(axis=1)
        if rate != SAMPLE_RATE:
            pcm = _resample_fft(pcm, rate)
        return pcm.astype(np.float32)
    if len(body) % 2:
        raise BadRequest("PCM16LE body must have an even number of bytes")
    return np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0


def parse_langs(raw: str | None) -> list[str]:
    if not raw:
        return list(DEFAULT_LANGS)
    out = []
    for code in raw.split(","):
        c = code.strip().lower()
        if c and (not STATE.supported_langs or c in STATE.supported_langs) and c not in out:
            out.append(c)
    return out or list(DEFAULT_LANGS)


def parse_hotwords(raw: str | None) -> str | None:
    if not raw:
        return None
    words = []
    for w in raw.split(","):
        w = re.sub(r"\s+", " ", w).strip()
        if w and w not in words:
            words.append(w[:40])
        if len(words) >= MAX_HOTWORDS:
            break
    s = ", ".join(words)[:MAX_HOTWORDS_CHARS]
    return s or None


def detect_language(model, speech: np.ndarray, langs: list[str]) -> tuple[str, float, dict]:
    """Whisper's language head over the first 30 s window of speech, restricted to `langs`.

    The window is built exactly like generate_segments() builds its first one (all frames but the
    last, padded to 30 s), so the encoder output can be handed to the decode via EncoderReuse.
    """
    from faster_whisper.audio import pad_or_trim

    fe = model.feature_extractor
    feats = fe(speech)
    window = pad_or_trim(feats[:, : min(fe.nb_max_frames, feats.shape[-1] - 1)])
    enc = model.encode(window)
    if STATE.reuse is not None:
        STATE.reuse.prime(window, enc)
    results = model.model.detect_language(enc)[0]  # [("<|en|>", p), ...] sorted by p
    raw = {tok[2:-2]: float(p) for tok, p in results}
    sub = {lang: raw.get(lang, 0.0) for lang in langs}
    total = sum(sub.values())
    if total <= 0:
        return langs[0], 0.0, {k: 0.0 for k in sub}
    probs = {k: round(v / total, 4) for k, v in sub.items()}
    best = max(probs, key=probs.get)
    return best, probs[best], probs


def transcribe_job(body: bytes, langs: list[str], hotwords: str | None, t_recv: float) -> dict:
    from faster_whisper.vad import collect_chunks, get_speech_timestamps

    t_start = time.perf_counter()
    model = STATE.model
    audio = decode_body(body)
    duration_ms = round(len(audio) * 1000 / SAMPLE_RATE)
    result = {
        "text": "",
        "lang": None,
        "langProb": 0.0,
        "langProbs": {},
        "avgLogprob": None,
        "durationMs": duration_ms,
        "speechMs": 0,
        "segments": 0,
        "dropped": 0,
    }
    stages = {"vadMs": 0.0, "langMs": 0.0, "asrMs": 0.0}

    # 1. VAD
    chunks = get_speech_timestamps(audio, _vad_options()) if len(audio) else []
    t_vad = time.perf_counter()
    stages["vadMs"] = round((t_vad - t_start) * 1000, 1)
    if chunks:
        speech = np.concatenate(collect_chunks(audio, chunks)[0], axis=0)
    else:
        speech = np.zeros(0, dtype=np.float32)
    result["speechMs"] = round(len(speech) * 1000 / SAMPLE_RATE)

    if len(speech) >= SAMPLE_RATE // 10:  # at least 100 ms of speech
        # 2. language over the allowed set
        if len(langs) == 1:
            lang, lang_prob, lang_probs = langs[0], 1.0, {langs[0]: 1.0}
        else:
            lang, lang_prob, lang_probs = detect_language(model, speech, langs)
        t_lang = time.perf_counter()
        stages["langMs"] = round((t_lang - t_vad) * 1000, 1)
        result.update(lang=lang, langProb=round(lang_prob, 4), langProbs=lang_probs)

        # 3. greedy decode of the speech-only audio (reuses the detection encoder pass when primed)
        try:
            segments, _info = model.transcribe(
                speech,
                language=lang,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                without_timestamps=True,
                vad_filter=False,  # VAD already applied in step 1 (same Silero VAD as vad_filter=True)
                hotwords=hotwords,
            )
            segments = list(segments)
        finally:
            if STATE.reuse is not None:
                STATE.reuse.clear()
        stages["asrMs"] = round((time.perf_counter() - t_lang) * 1000, 1)

        # 4. filter
        kept, dropped = [], 0
        for s in segments:
            if s.avg_logprob < MIN_LOGPROB or s.compression_ratio > MAX_COMPRESSION or is_hallucination(s.text):
                dropped += 1
            else:
                kept.append(s)
        basis = kept or segments
        n_tok = sum(max(1, len(s.tokens)) for s in basis)
        if basis:
            result["avgLogprob"] = round(sum(s.avg_logprob * max(1, len(s.tokens)) for s in basis) / n_tok, 4)
        text = " ".join(s.text.strip() for s in kept).strip()
        if text and is_hallucination(text):
            dropped += len(kept)
            text = ""
        result.update(text=text, segments=len(segments), dropped=dropped)

    done = time.perf_counter()
    result["ms"] = round((done - t_recv) * 1000, 1)
    result["queueMs"] = round((t_start - t_recv) * 1000, 1)
    result["stages"] = stages
    msg = (
        f"{duration_ms / 1000:.2f}s audio ({result['speechMs'] / 1000:.2f}s speech) -> {result['ms']} ms "
        f"(vad {stages['vadMs']}, lang {stages['langMs']}, asr {stages['asrMs']}) "
        f"{result['lang']} p={result['langProb']} chars={len(result['text'])} dropped={result['dropped']}"
    )
    if LOG_TEXT:
        msg += f" text={result['text']!r}"
    log(msg)
    return result


def health() -> dict:
    return {
        "ok": bool(STATE.warm and STATE.model is not None and not STATE.error),
        "device": STATE.device,
        "compute": STATE.compute,
        "model": MODEL_NAME,
        "warm": STATE.warm,
        "loading": STATE.loading,
        "error": STATE.error,
        "attempts": STATE.attempts,
        "langs": DEFAULT_LANGS,
        "queue": STATE.pending,
        "loadMs": STATE.load_ms,
        "warmMs": STATE.warm_ms,
        "versions": STATE.versions,
        "encoderReuseHits": STATE.reuse.hits if STATE.reuse is not None else 0,
        "uptimeS": round(time.time() - STATE.started),
    }


# --- HTTP ------------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "dead-air-stt/1"
    protocol_version = "HTTP/1.1"  # keep-alive: the Node bridge reuses one connection

    def log_message(self, fmt, *args):  # quiet: per-request lines come from transcribe_job
        pass

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(200, health())
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/transcribe":
            self.close_connection = True
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0:
            self.close_connection = True
            self._json(411 if length == 0 and "Content-Length" not in self.headers else 400,
                       {"error": "body must be raw PCM16LE mono 16 kHz with a Content-Length"})
            return
        if length > MAX_BYTES:
            self.close_connection = True
            self._json(413, {"error": f"audio longer than {MAX_SECONDS:g} s"})
            return
        body = self.rfile.read(length)
        t_recv = time.perf_counter()
        if not STATE.warm:
            self._json(503, {"error": "loading" if STATE.loading else (STATE.error or "not ready")})
            return
        qs = parse_qs(url.query)
        langs = parse_langs((qs.get("langs") or [None])[0])
        hotwords = parse_hotwords((qs.get("hotwords") or [None])[0])
        with STATE.lock:
            if STATE.pending >= QUEUE_MAX:
                busy = True
            else:
                busy = False
                STATE.pending += 1
        if busy:
            self._json(503, {"error": "busy"})
            return
        fut = EXECUTOR.submit(transcribe_job, body, langs, hotwords, t_recv)
        fut.add_done_callback(_release_slot)
        try:
            res = fut.result(timeout=REQUEST_TIMEOUT_S)
        except FutureTimeout:
            self._json(504, {"error": "timeout"})
            return
        except BadRequest as e:
            self._json(400, {"error": str(e)})
            return
        except Exception as e:  # pragma: no cover - model/runtime failure
            log(f"transcribe failed: {type(e).__name__}: {e}")
            self._json(500, {"error": f"{type(e).__name__}: {e}"[:300]})
            return
        self._json(200, res)


def _release_slot(_fut) -> None:
    with STATE.lock:
        STATE.pending -= 1


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second instance silently share the port; demand exclusivity.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


# --- CLI ---------------------------------------------------------------------------------------------
def cmd_check() -> int:
    import ctypes

    import ctranslate2

    info = {
        "python": sys.version.split()[0],
        "ctranslate2": ctranslate2.__version__,
        "dllDirs": [os.path.relpath(d, HERE) for d in DLL_DIRS],
        "cudaDevices": 0,
        "cudaComputeTypes": [],
        "cublas": False,
    }
    try:
        info["cudaDevices"] = ctranslate2.get_cuda_device_count()
        if info["cudaDevices"]:
            info["cudaComputeTypes"] = sorted(ctranslate2.get_supported_compute_types("cuda"))
    except Exception as e:
        info["cudaError"] = str(e)
    if sys.platform == "win32":
        try:
            ctypes.WinDLL("cublas64_12.dll")
            info["cublas"] = True
        except OSError as e:
            info["cublasError"] = str(e)
    else:
        info["cublas"] = None
    print(json.dumps(info, indent=1))
    ok = info["cudaDevices"] > 0 and info["cublas"] is not False and "float16" in info["cudaComputeTypes"]
    return 0 if ok else 1


def cmd_download() -> int:
    path = resolve_model_path(MODEL_NAME, allow_download=True)
    # A cheap online re-check that every file is present (no-op when complete; skipped offline).
    try:
        from faster_whisper.utils import download_model

        path = download_model(MODEL_NAME)
    except Exception as e:
        log(f"online verification skipped ({type(e).__name__}); using the cached copy")
    files = sorted(os.listdir(path))
    log(f"model ready at {os.path.relpath(path, HERE)}: {', '.join(files)}")
    return 0 if "model.bin" in files else 1


def main() -> int:
    if "--check" in sys.argv:
        return cmd_check()
    if "--download" in sys.argv:
        return cmd_download()

    import logging

    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as e:
        log(f"cannot listen on {HOST}:{PORT} ({e}). Is the sidecar already running? Try GET http://{HOST}:{PORT}/health")
        return 2
    log(f"listening on http://{HOST}:{PORT} (model loading; GET /health reports warm=true when ready)")
    EXECUTOR.submit(load_model)
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        httpd.server_close()
        EXECUTOR.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
