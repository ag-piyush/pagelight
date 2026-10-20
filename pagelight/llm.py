"""Clients for local LLM runtimes.

* ``ollama``  – Ollama's native API (default, http://127.0.0.1:11434)
* ``openai``  – any OpenAI-compatible local server: llama.cpp's ``llama-server``,
                LM Studio, vLLM, etc. (default http://127.0.0.1:8080/v1)

Every request goes through an opener with proxies disabled, and the base URL is
checked to be loopback (or private LAN with --allow-lan) before anything is sent,
so a misconfigured env var can never route your document to the internet.
"""

from __future__ import annotations

import ipaddress
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterator
from urllib.parse import urlparse

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

EMBED_HINTS = ("embed", "bge", "minilm", "e5-", "gte-", "arctic-embed", "nomic-bert")
PREFERRED_CHAT = ("llama3.1:8b", "llama3.1", "llama3.2:3b", "llama3.2", "llama3:8b", "llama3", "llama3.3")
PREFERRED_EMBED = ("nomic-embed-text", "mxbai-embed-large", "bge-m3", "snowflake-arctic-embed", "all-minilm", "embeddinggemma")


class LLMError(RuntimeError):
    pass


def ensure_local(url: str, allow_lan: bool = False) -> None:
    host = urlparse(url).hostname or ""
    if host in ("localhost",) or host.endswith(".localhost"):
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise LLMError(f"Cannot resolve LLM host {host!r}: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback:
            continue
        if allow_lan and ip.is_private and not ip.is_global:
            continue
        raise LLMError(
            f"Refusing to send your document to {host} ({ip}): it is not on this machine. "
            "pagelight only talks to local model servers (use --allow-lan for a box on your private network)."
        )


def _request(url: str, payload: dict | None = None, timeout: float = 600, method: str | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    try:
        return _OPENER.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        try:
            body = json.loads(body).get("error", body)
            if isinstance(body, dict):
                body = body.get("message", body)
        except Exception:
            pass
        raise LLMError(f"{e.code} from {url}: {body}") from e
    except (urllib.error.URLError, ConnectionError, socket.timeout) as e:
        raise LLMError(f"Cannot reach {url}: {getattr(e, 'reason', e)}") from e


def _json(url: str, payload: dict | None = None, timeout: float = 600) -> dict:
    with _request(url, payload, timeout) as r:
        return json.loads(r.read())


@dataclass
class Usage:
    tokens: int = 0
    seconds: float = 0.0

    @property
    def tps(self) -> float:
        return self.tokens / self.seconds if self.seconds else 0.0


class OllamaClient:
    kind = "ollama"

    def __init__(self, base_url: str, ctx: int = 8192, temperature: float = 0.2):
        self.base = base_url.rstrip("/")
        self.ctx, self.temperature = ctx, temperature
        self.last_usage = Usage()

    def alive(self) -> bool:
        try:
            _json(f"{self.base}/api/version", timeout=2)
            return True
        except LLMError:
            return False

    def models(self) -> list[str]:
        return [m["name"] for m in _json(f"{self.base}/api/tags", timeout=10).get("models", [])]

    def chat_stream(self, model: str, messages: list[dict]) -> Iterator[str]:
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "keep_alive": "30m",
            "options": {"num_ctx": self.ctx, "temperature": self.temperature},
        }
        t0 = time.time()
        with _request(f"{self.base}/api/chat", payload) as r:
            for line in r:
                if not line.strip():
                    continue
                ev = json.loads(line)
                if ev.get("error"):
                    raise LLMError(ev["error"])
                text = (ev.get("message") or {}).get("content") or ""
                if text:
                    yield text
                if ev.get("done"):
                    dur = (ev.get("eval_duration") or 0) / 1e9 or (time.time() - t0)
                    self.last_usage = Usage(ev.get("eval_count") or 0, dur)
                    return

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        try:
            out = _json(f"{self.base}/api/embed", {"model": model, "input": texts, "keep_alive": "30m"})
            return out["embeddings"]
        except LLMError as e:
            if "404" not in str(e):
                raise
        # older Ollama: one text per call
        return [_json(f"{self.base}/api/embeddings", {"model": model, "prompt": t})["embedding"] for t in texts]


class OpenAICompatClient:
    kind = "openai"

    def __init__(self, base_url: str, ctx: int = 8192, temperature: float = 0.2):
        self.base = base_url.rstrip("/")
        if not self.base.endswith("/v1"):
            self.base += "/v1"
        self.ctx, self.temperature = ctx, temperature
        self.last_usage = Usage()

    def alive(self) -> bool:
        try:
            _json(f"{self.base}/models", timeout=2)
            return True
        except LLMError:
            return False

    def models(self) -> list[str]:
        return [m["id"] for m in _json(f"{self.base}/models", timeout=10).get("data", [])]

    def chat_stream(self, model: str, messages: list[dict]) -> Iterator[str]:
        payload = {"model": model, "messages": messages, "stream": True, "temperature": self.temperature}
        t0, n = time.time(), 0
        with _request(f"{self.base}/chat/completions", payload) as r:
            for raw in r:
                line = raw.decode(errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                ev = json.loads(data)
                if ev.get("error"):
                    raise LLMError(str(ev["error"]))
                for ch in ev.get("choices", []):
                    text = (ch.get("delta") or {}).get("content") or ""
                    if text:
                        n += 1
                        yield text
        self.last_usage = Usage(n, time.time() - t0)

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        out = _json(f"{self.base}/embeddings", {"model": model, "input": texts})
        return [d["embedding"] for d in sorted(out["data"], key=lambda d: d.get("index", 0))]


def is_embed_model(name: str) -> bool:
    n = name.lower()
    return any(h in n for h in EMBED_HINTS)


def _match(installed: list[str], wanted: str) -> str | None:
    if wanted in installed:
        return wanted
    for name in installed:  # "llama3.1" matches "llama3.1:latest" / "llama3.1:8b-instruct-q4_K_M"
        if name.split(":")[0] == wanted.split(":")[0] and (":" not in wanted or name.startswith(wanted)):
            return name
    return None


def pick_chat_model(installed: list[str], requested: str | None, strict: bool = True) -> str:
    if requested:
        m = _match(installed, requested)
        if m:
            return m
        if strict:
            raise LLMError(
                f"Model {requested!r} isn't downloaded. Installed: {', '.join(installed) or 'none'}.\n"
                f"  One-time setup (needs internet once):  ollama pull {requested}"
            )
        return requested  # llama-server / LM Studio accept whatever is loaded
    chats = [m for m in installed if not is_embed_model(m)]
    for pref in PREFERRED_CHAT:
        m = _match(chats, pref)
        if m:
            return m
    llamas = [m for m in chats if "llama" in m.lower()]
    if llamas:
        return llamas[0]
    if chats:
        return chats[0]
    raise LLMError("No chat model found on the local server.")


def pick_embed_model(installed: list[str], requested: str | None) -> str | None:
    if requested:
        return _match(installed, requested) or requested
    for pref in PREFERRED_EMBED:
        m = _match(installed, pref)
        if m:
            return m
    return None


def start_ollama_if_needed(client: OllamaClient, log_path: str) -> subprocess.Popen | None:
    """If the Ollama daemon is down but the binary exists, start it for this session."""
    if client.alive():
        return None
    exe = shutil.which("ollama")
    if not exe:
        return None
    host = urlparse(client.base).netloc
    env = dict(os.environ, OLLAMA_HOST=host)
    log = open(log_path, "ab")
    proc = subprocess.Popen([exe, "serve"], stdout=log, stderr=log, env=env, start_new_session=True)
    for _ in range(60):
        if client.alive():
            return proc
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    return proc if client.alive() else None
