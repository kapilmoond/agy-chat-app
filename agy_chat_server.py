"""Agy Chat — a small desktop-style chat app that talks to Google Antigravity CLI (agy).

This is NOT a backend for Aakalan Agent. It is a separate app.
agy --print must be LAST: the next argument is the user's question.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
AGY_BIN = Path(os.environ.get("AGY_BIN", r"C:\Users\LAPTOP PC\AppData\Local\agy\bin\agy.EXE"))
HOST = os.environ.get("AGY_CHAT_HOST", "127.0.0.1")
PORT = int(os.environ.get("AGY_CHAT_PORT", "8768"))
DEFAULT_WORKSPACE = Path(os.environ.get("AGY_CHAT_WORKSPACE", r"C:\Users\LAPTOP PC"))
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "aakalan" / "agy-chat"
STATE_FILE = STATE_DIR / "sessions.json"
PRINT_TIMEOUT = os.environ.get("AGY_PRINT_TIMEOUT", "5m")

_lock = threading.Lock()
_busy = False


def _timeout_seconds(raw: str) -> int:
    value = (raw or "5m").strip().lower()
    if value.endswith("s") and not value.endswith("ms"):
        return max(60, int(float(value[:-1])) + 10)
    if value.endswith("m"):
        return max(60, int(float(value[:-1]) * 60) + 10)
    if value.endswith("h"):
        return max(60, int(float(value[:-1]) * 3600) + 10)
    return 310


def load_state() -> dict:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not STATE_FILE.exists():
        return {"sessions": [], "workspace": str(DEFAULT_WORKSPACE)}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"sessions": [], "workspace": str(DEFAULT_WORKSPACE)}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def list_models() -> list[dict]:
    if not AGY_BIN.exists():
        return []
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            [str(AGY_BIN), "models"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            creationflags=creation,
        )
    except Exception:
        return []
    models = []
    for line in (result.stdout or "").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("fetching"):
            continue
        parts = line.split(None, 1)
        mid = parts[0]
        label = parts[1] if len(parts) > 1 else mid
        models.append({"id": mid, "label": label})
    return models


def _extract_json_text(payload) -> tuple[str, str | None]:
    if isinstance(payload, dict):
        conv = payload.get("conversation_id") or payload.get("conversationId")
        for key in ("response", "result", "text", "content", "message", "output"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip() and key != "conversation_id":
                return value.strip(), str(conv) if conv else None
        if isinstance(payload.get("choices"), list) and payload["choices"]:
            msg = payload["choices"][0]
            if isinstance(msg, dict):
                inner = msg.get("message") or msg
                text = inner.get("content") if isinstance(inner, dict) else None
                if text:
                    return str(text).strip(), None
    return "", None


def run_agy(prompt: str, *, conversation_id: str | None, model: str, workspace: Path) -> tuple[str, str | None]:
    if not AGY_BIN.exists():
        raise FileNotFoundError(f"agy not found: {AGY_BIN}")
    workspace.mkdir(parents=True, exist_ok=True)
    cmd = [str(AGY_BIN), "--output-format", "json", "--print-timeout", PRINT_TIMEOUT]
    if conversation_id:
        cmd.extend(["--conversation", conversation_id])
    if model and model.lower() not in {"agy", "default", ""}:
        cmd.extend(["--model", model])
    # --print MUST be last. The next argument is the question.
    cmd.extend(["--print", prompt])

    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    result = subprocess.run(
        cmd,
        cwd=str(workspace),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_timeout_seconds(PRINT_TIMEOUT),
        creationflags=creation,
    )
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    if not stdout:
        if result.returncode != 0:
            raise RuntimeError(stderr or f"agy exited {result.returncode}")
        raise RuntimeError(stderr or "agy returned no text")

    text = ""
    new_id = conversation_id
    # json mode may print one object or several lines
    for block in (stdout,):
        try:
            parsed = json.loads(block)
            text, found_id = _extract_json_text(parsed)
            if found_id:
                new_id = found_id
        except json.JSONDecodeError:
            for line in block.splitlines():
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                piece, found_id = _extract_json_text(parsed)
                if piece:
                    text = piece
                if found_id:
                    new_id = found_id
    if not text:
        text = stdout
    if text.startswith("{") and '"response"' in text:
        try:
            parsed = json.loads(text)
            piece, found_id = _extract_json_text(parsed)
            if piece:
                text = piece
            if found_id:
                new_id = found_id
        except json.JSONDecodeError:
            pass
    return text, new_id


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, status: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/status":
            state = load_state()
            self._json(
                200,
                {
                    "ok": True,
                    "agy": str(AGY_BIN),
                    "agy_ok": AGY_BIN.exists(),
                    "workspace": state.get("workspace") or str(DEFAULT_WORKSPACE),
                    "busy": _busy,
                    "models": list_models(),
                },
            )
            return
        if path == "/api/sessions":
            self._json(200, load_state())
            return
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        global _busy
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
        except Exception:
            self._json(400, {"error": "Invalid JSON"})
            return

        if path == "/api/workspace":
            folder = Path(str(payload.get("workspace") or "").strip())
            if not folder.exists() or not folder.is_dir():
                self._json(400, {"error": "Folder not found"})
                return
            state = load_state()
            state["workspace"] = str(folder)
            save_state(state)
            self._json(200, {"ok": True, "workspace": str(folder)})
            return

        if path == "/api/new":
            state = load_state()
            session = {
                "id": uuid.uuid4().hex[:12],
                "title": "New chat",
                "conversation_id": None,
                "model": str(payload.get("model") or ""),
                "created": int(time.time()),
                "messages": [],
            }
            state.setdefault("sessions", []).insert(0, session)
            save_state(state)
            self._json(200, session)
            return

        if path != "/api/chat":
            self._json(404, {"error": "Not found"})
            return

        message = str(payload.get("message") or "").strip()
        if not message:
            self._json(400, {"error": "Empty message"})
            return
        session_id = str(payload.get("session_id") or "")
        model = str(payload.get("model") or "")
        with _lock:
            if _busy:
                self._json(409, {"error": "agy is still answering the previous message."})
                return
            _busy = True
        try:
            state = load_state()
            workspace = Path(state.get("workspace") or DEFAULT_WORKSPACE)
            sessions = state.setdefault("sessions", [])
            session = next((item for item in sessions if item.get("id") == session_id), None)
            if session is None:
                session = {
                    "id": uuid.uuid4().hex[:12],
                    "title": message[:48],
                    "conversation_id": None,
                    "model": model,
                    "created": int(time.time()),
                    "messages": [],
                }
                sessions.insert(0, session)
            session.setdefault("messages", []).append({"role": "user", "content": message, "ts": int(time.time())})
            if session.get("title") in {"", "New chat"}:
                session["title"] = message[:48]
            reply, conv_id = run_agy(
                message,
                conversation_id=session.get("conversation_id"),
                model=model or session.get("model") or "",
                workspace=workspace,
            )
            if conv_id:
                session["conversation_id"] = conv_id
            session["messages"].append({"role": "assistant", "content": reply, "ts": int(time.time())})
            save_state(state)
            self._json(200, {"ok": True, "session": session, "reply": reply})
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "agy timed out."})
        except Exception as exc:
            self._json(502, {"error": str(exc)})
        finally:
            _busy = False


def main() -> None:
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Agy Chat  {url}")
    print(f"agy        {AGY_BIN}")
    print(f"workspace  {DEFAULT_WORKSPACE}")
    print("This app is separate from Aakalan Agent.")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
