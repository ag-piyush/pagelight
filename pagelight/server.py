"""Tiny local web server: serves the reader UI, the PDF, and a streaming /api/ask.

Stdlib only. Binds to 127.0.0.1, checks the Host header (DNS-rebinding guard)
and requires a per-session token on the API, so other sites open in your
browser can't talk to it.
"""

from __future__ import annotations

import json
import mimetypes
import secrets
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import prompts
from .document import Document
from .llm import LLMError
from .retrieval import Retriever

STATIC = Path(__file__).parent / "static"

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")

# Browser-enforced: the page may only load or connect to this server.
CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self' blob:",
        "connect-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ]
)


@dataclass
class App:
    doc: Document
    retriever: Retriever
    client: object
    model: str
    embed_model: str | None
    ctx: int
    start_page: int = 1
    token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    port: int = 0

    def info(self) -> dict:
        emb = self.retriever.embed
        return {
            "title": self.doc.title,
            "file": self.doc.path.name,
            "docId": self.doc.sha[:16],
            "pages": self.doc.n_pages,
            "chars": self.doc.n_chars,
            "outline": self.doc.outline[:400],
            "model": self.model,
            "backend": getattr(self.client, "kind", "?"),
            "embedModel": self.embed_model,
            "retrieval": self.retriever.mode,
            "indexProgress": round(emb.progress, 3) if emb else None,
            "indexError": emb.error if emb else None,
            "ctx": self.ctx,
            "startPage": self.start_page,
        }


def make_handler(app: App):
    allowed_hosts = None

    class Handler(BaseHTTPRequestHandler):
        server_version = "pagelight"
        sys_version = ""

        def log_message(self, fmt, *args):  # quiet
            pass

        # ---------- helpers ----------
        def _host_ok(self) -> bool:
            nonlocal allowed_hosts
            if allowed_hosts is None:
                allowed_hosts = {f"127.0.0.1:{app.port}", f"localhost:{app.port}", f"[::1]:{app.port}"}
            return self.headers.get("Host", "") in allowed_hosts

        def _token_ok(self) -> bool:
            return secrets.compare_digest(self.headers.get("X-Session-Token", ""), app.token)

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json", {"Cache-Control": "no-store"})

        def _deny(self, code=403, msg="forbidden"):
            self._send(code, msg.encode(), "text/plain")

        # ---------- routes ----------
        def do_GET(self):
            if not self._host_ok():
                return self._deny(421, "bad host")
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                html = (STATIC / "index.html").read_text(encoding="utf-8")
                html = html.replace("__SESSION_TOKEN__", app.token)
                return self._send(200, html.encode(), "text/html; charset=utf-8",
                                  {"Content-Security-Policy": CSP, "Cache-Control": "no-store"})
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self._static("favicon.svg")
            if path == "/doc.pdf":
                if not self._token_ok():
                    return self._deny()
                data = app.doc.path.read_bytes()
                return self._send(200, data, "application/pdf", {"Cache-Control": "no-store"})
            if path == "/api/info":
                if not self._token_ok():
                    return self._deny()
                return self._json(200, app.info())
            return self._deny(404, "not found")

        do_HEAD = do_GET

        def _static(self, rel: str):
            target = (STATIC / rel).resolve()
            if STATIC.resolve() not in target.parents or not target.is_file():
                return self._deny(404, "not found")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/"):
                ctype += "; charset=utf-8"
            cache = "public, max-age=86400" if "/vendor/" in f"/{rel}" else "no-cache"
            self._send(200, target.read_bytes(), ctype, {"Cache-Control": cache})

        def do_POST(self):
            if not self._host_ok():
                return self._deny(421, "bad host")
            if urlparse(self.path).path != "/api/ask":
                return self._deny(404, "not found")
            if not self._token_ok():
                return self._deny()
            try:
                n = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(min(n, 2_000_000)) or b"{}")
            except Exception:
                return self._json(400, {"error": "bad json"})
            question = str(req.get("question", "")).strip()
            if not question:
                return self._json(400, {"error": "empty question"})

            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            def emit(obj) -> None:
                self.wfile.write((json.dumps(obj) + "\n").encode())
                self.wfile.flush()

            try:
                built = prompts.build(
                    app.doc,
                    app.retriever,
                    question=question,
                    page=int(req.get("page") or 1),
                    selection=str(req.get("selection") or ""),
                    history=[m for m in req.get("history", []) if m.get("role") in ("user", "assistant")],
                    ctx_tokens=app.ctx,
                )
                emit({"type": "meta", "pages": built.pages_used, "mode": built.mode,
                      "retrieval": app.retriever.mode, "model": app.model})
                for piece in app.client.chat_stream(app.model, built.messages):
                    emit({"type": "delta", "text": piece})
                u = app.client.last_usage
                emit({"type": "done", "tokens": u.tokens, "tps": round(u.tps, 1)})
            except (BrokenPipeError, ConnectionResetError):
                return  # user pressed stop; closing the upstream stream halts generation
            except LLMError as e:
                self._safe_emit(emit, {"type": "error", "message": str(e)})
            except Exception as e:
                self._safe_emit(emit, {"type": "error", "message": f"{type(e).__name__}: {e}"})

        @staticmethod
        def _safe_emit(emit, obj):
            try:
                emit(obj)
            except Exception:
                pass

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(app: App, port: int) -> tuple[Server, threading.Thread]:
    last_err = None
    for p in [port, *range(port + 1, port + 20), 0]:
        try:
            srv = Server(("127.0.0.1", p), make_handler(app))
            break
        except OSError as e:
            last_err = e
    else:  # pragma: no cover
        raise last_err  # type: ignore[misc]
    app.port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, name="http", daemon=True)
    t.start()
    return srv, t
