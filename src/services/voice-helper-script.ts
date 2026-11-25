/**
 * Python source of the voice helper, run with Hermes's own interpreter as
 * `python -I -c <source> <hermes-root>`.
 *
 * It depends on exactly two Hermes functions (the same ones Hermes Desktop's
 * /api/audio routes use): tools.voice_mode.transcribe_recording and
 * tools.tts_tool.text_to_speech_tool. Protocol: JSON lines over stdio.
 *   startup  -> {"type":"ready"} | {"type":"unavailable","reason","detail"}
 *   request  <- {"id","op":"transcribe","audio":<base64>,"ext":".webm"}
 *               {"id","op":"speak","text"}
 *   response -> {"id","ok":true,"transcript"} | {"id","ok":true,"audio","mime"}
 *               {"id","ok":false,"error"}
 * The helper exits when stdin closes.
 */
export const VOICE_HELPER_SCRIPT = String.raw`
import base64, json, os, sys, tempfile, threading
from concurrent.futures import ThreadPoolExecutor

_out = sys.stdout
sys.stdout = sys.stderr  # Hermes imports may print; keep the protocol stream clean
_lock = threading.Lock()

def send(msg):
    with _lock:
        _out.write(json.dumps(msg) + "\n")
        _out.flush()

for _k in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
    os.environ.pop(_k, None)

try:
    sys.path.insert(0, sys.argv[1])
    sys._hermes_pin_default_home = True
    import hermes_bootstrap  # noqa: F401  (same bootstrap as the hermes launcher)
    if not os.environ.get("HERMES_HOME"):
        from hermes_constants import get_default_hermes_root
        os.environ["HERMES_HOME"] = str(get_default_hermes_root())
    from tools.voice_mode import transcribe_recording
    from tools.tts_tool import text_to_speech_tool
except BaseException as exc:
    send({"type": "unavailable", "reason": "Hermes voice tools could not be loaded.",
          "detail": "%s: %s" % (type(exc).__name__, exc)})
    sys.exit(0)

_MIME = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg",
         ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4"}

def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass

def transcribe(req):
    ext = req.get("ext") or ".webm"
    if ext not in (".webm", ".ogg", ".wav", ".mp3", ".m4a", ".mp4", ".flac"):
        ext = ".webm"
    fd, path = tempfile.mkstemp(prefix="agent-client-voice-", suffix=ext)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(base64.b64decode(req["audio"]))
        result = transcribe_recording(path)
    finally:
        _unlink(path)
    if not result.get("success"):
        err = str(result.get("error") or "Transcription failed")
        if "empty transcript" in err.lower():  # silence, not an error
            return {"transcript": ""}
        raise RuntimeError(err)
    return {"transcript": str(result.get("transcript") or "").strip()}

def speak(req):
    fd, path = tempfile.mkstemp(prefix="agent-client-voice-", suffix=".mp3")
    os.close(fd)
    written = None
    try:
        raw = text_to_speech_tool(text=req["text"], output_path=path)
        result = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(result, dict) or not result.get("success"):
            detail = result.get("error") if isinstance(result, dict) else ""
            raise RuntimeError(str(detail or "Speech synthesis failed"))
        written = result.get("file_path") or path
        with open(written, "rb") as fh:
            data = fh.read()
    finally:
        _unlink(path)
        if written and os.path.abspath(written) != os.path.abspath(path):
            _unlink(written)
    ext = os.path.splitext(written)[1].lower()
    return {"audio": base64.b64encode(data).decode("ascii"), "mime": _MIME.get(ext, "audio/mpeg")}

_OPS = {"transcribe": transcribe, "speak": speak}

def handle(req):
    rid = req.get("id")
    try:
        send(dict(_OPS[req["op"]](req), id=rid, ok=True))
    except BaseException as exc:
        send({"id": rid, "ok": False, "error": str(exc) or type(exc).__name__})

send({"type": "ready"})
_pool = ThreadPoolExecutor(max_workers=3)
for _line in sys.stdin.buffer:
    _line = _line.strip()
    if not _line:
        continue
    try:
        _req = json.loads(_line.decode("utf-8"))
    except ValueError:
        continue
    _pool.submit(handle, _req)
_pool.shutdown(wait=True)
`;
