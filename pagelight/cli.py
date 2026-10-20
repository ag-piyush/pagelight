"""pagelight — read PDFs and ask a local model about them. Nothing leaves your machine."""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

from . import __version__, prompts
from .document import collect_pdfs, load_many
from .llm import (
    LLMError,
    OllamaClient,
    OpenAICompatClient,
    ensure_local,
    pick_chat_model,
    pick_embed_model,
    start_ollama_if_needed,
)
from .retrieval import Retriever

CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "pagelight"

_tty = sys.stdout.isatty()
DIM, BOLD, GRN, YEL, RED, RST = (("\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[31m", "\033[0m") if _tty
                                 else ("",) * 6)


def _default_url(backend: str) -> str:
    if backend == "openai":
        return "http://127.0.0.1:8080/v1"
    host = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434")
    if "://" not in host:
        host = "http://" + host
    u = urlparse(host)
    hostname = "127.0.0.1" if u.hostname in (None, "", "0.0.0.0", "::") else u.hostname
    return f"{u.scheme}://{hostname}:{u.port or 11434}"


def _size(chars: int) -> str:
    return f"{chars/1000:.0f}k chars" if chars >= 10_000 else f"{chars:,} chars"


def _die(msg: str, code: int = 1):
    print(f"{RED}error:{RST} {msg}", file=sys.stderr)
    sys.exit(code)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        prog="pagelight",
        description="Ask your PDFs anything, completely offline: a local reader with a chat powered by a model on your machine.",
    )
    ap.add_argument("pdf", nargs="+", help="one or more PDFs and/or folders (searched recursively)")
    ap.add_argument("-m", "--model", help="chat model (default: best installed Llama, e.g. llama3.1:8b)")
    ap.add_argument("--backend", choices=["ollama", "openai"], default="ollama",
                    help="ollama (default) or openai = any OpenAI-compatible local server (llama.cpp llama-server, LM Studio)")
    ap.add_argument("--url", help="model server URL (ollama: $OLLAMA_HOST or http://127.0.0.1:11434; openai: http://127.0.0.1:8080/v1)")
    ap.add_argument("--ctx", type=int, default=8192, help="context window in tokens (default 8192)")
    ap.add_argument("--embed-model", help="embedding model for semantic search (default: auto-detect nomic-embed-text etc.)")
    ap.add_argument("--no-embed", action="store_true", help="keyword (BM25) search only")
    ap.add_argument("-p", "--port", type=int, default=7337)
    ap.add_argument("--page", type=int, default=0, help="open the first PDF at this page")
    ap.add_argument("-t", "--terminal", action="store_true", help="ask in the terminal instead of opening the reader")
    ap.add_argument("--no-browser", action="store_true", help="start the reader without opening a browser tab")
    ap.add_argument("--temperature", type=float, default=0.2)
    ap.add_argument("--allow-lan", action="store_true", help="allow a model server on your private network (never the internet)")
    ap.add_argument("-V", "--version", action="version", version=f"pagelight {__version__}")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    url = args.url or _default_url(args.backend)

    # 1) the documents
    paths = collect_pdfs(args.pdf)
    if not paths:
        _die("no PDFs found in " + ", ".join(args.pdf))
    if len(paths) > 1:
        print(f"{DIM}loading {len(paths)} PDFs…{RST}", file=sys.stderr)
    docs, problems = load_many(paths)
    for msg in problems:
        print(f"{YEL}warning:{RST} {msg}", file=sys.stderr)
    if not docs:
        _die("none of the PDFs could be opened")
    for d in docs:
        if d.looks_scanned:
            print(f"{YEL}warning:{RST} {d.path.name} has almost no text layer (scanned?). Answers need text — "
                  f"OCR it offline first:  ocrmypdf \"{d.path.name}\" ocr.pdf", file=sys.stderr)

    # 2) the model server (must be on this machine)
    try:
        ensure_local(url, args.allow_lan)
    except LLMError as e:
        _die(str(e))
    Client = OllamaClient if args.backend == "ollama" else OpenAICompatClient
    client = Client(url, ctx=args.ctx, temperature=args.temperature)
    started = None
    if args.backend == "ollama":
        CACHE.mkdir(parents=True, exist_ok=True)
        started = start_ollama_if_needed(client, str(CACHE / "ollama-serve.log"))
    if not client.alive():
        if args.backend == "ollama":
            _die(f"Ollama isn't running at {url}.\n"
                 f"  Start it with `ollama serve` (or open the Ollama app). Install: https://ollama.com/download\n"
                 f"  Using llama.cpp instead?  pagelight … --backend openai --url http://127.0.0.1:8080")
        _die(f"No OpenAI-compatible server at {url}. Start one, e.g.:\n"
             f"  llama-server -m ~/models/Llama-3.1-8B-Instruct-Q4_K_M.gguf -c {args.ctx} --port 8080")
    try:
        installed = client.models()
        model = pick_chat_model(installed, args.model, strict=args.backend == "ollama")
    except LLMError as e:
        if not (args.model or "").strip() and args.backend == "ollama" and "No chat model" in str(e):
            _die("No models downloaded yet. One-time setup (needs internet once):\n  ollama pull llama3.1:8b\n"
                 "  ollama pull nomic-embed-text   # optional, better search")
        _die(str(e))

    embed_model = None if args.no_embed else pick_embed_model(installed, args.embed_model)
    retriever = Retriever(docs)
    if embed_model:
        retriever.enable_embeddings(lambda texts: client.embed(embed_model, texts), embed_model, CACHE)

    if len(docs) == 1:
        d = docs[0]
        print(f"\n{BOLD}pagelight{RST} · {d.path.name}  {DIM}({d.n_pages} pages, {_size(d.n_chars)}){RST}")
    else:
        total_pages = sum(d.n_pages for d in docs)
        print(f"\n{BOLD}pagelight{RST} · {len(docs)} PDFs  {DIM}({total_pages} pages, {_size(sum(d.n_chars for d in docs))}){RST}")
        for d in docs[:12]:
            print(f"  {DIM}{d.label:>4}{RST}  {d.path.name}  {DIM}{d.n_pages}p{RST}")
        if len(docs) > 12:
            print(f"  {DIM}   … {len(docs) - 12} more{RST}")
    print(f"  {DIM}model {RST}  {model} {DIM}via {client.kind} @ {urlparse(url).netloc}, ctx {args.ctx}{RST}")
    print(f"  {DIM}search{RST}  {'hybrid · ' + embed_model if embed_model else 'keyword (BM25)'}"
          + ("" if embed_model else f"  {DIM}tip: `ollama pull nomic-embed-text` for semantic search{RST}"))
    print(f"  {DIM}offline{RST} {GRN}✓{RST} model server is local, UI assets are bundled, nothing is sent out")

    if args.terminal:
        try:
            return repl(docs, retriever, client, model, args)
        finally:
            if started:
                started.terminate()

    from .server import App, serve

    app = App(docs=docs, retriever=retriever, client=client, model=model, embed_model=embed_model,
              ctx=args.ctx, start_page=max(0, args.page))
    srv, _ = serve(app, args.port)
    link = f"http://127.0.0.1:{app.port}/"
    print(f"  {DIM}reader{RST}  {BOLD}{link}{RST}  {DIM}(Ctrl+C to quit){RST}\n")
    if not args.no_browser:
        webbrowser.open(link)

    def _shutdown(*_):
        print(f"\n{DIM}bye{RST}")
        srv.shutdown()
        if started:
            started.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    while True:
        time.sleep(3600)


def repl(docs, retriever, client, model, args):
    cur, page, scope = 0, max(1, args.page or 1), "all"
    multi = len(docs) > 1
    history: list[dict] = []
    cmds = ":p N (page)" + ("  :d N (switch PDF)  :docs  :scope all|doc" if multi else "") + "  :clear  :q"
    print(f"\n{DIM}Ask anything. Commands: {cmds}{RST}\n")
    while True:
        where = (f"{docs[cur].label} " if multi else "") + f"p{page}"
        try:
            q = input(f"{BOLD}{where} ›{RST} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not q:
            continue
        if q in (":q", ":quit", "exit"):
            return
        if q == ":clear":
            history.clear()
            print(f"{DIM}history cleared{RST}")
            continue
        if q == ":docs":
            for d in docs:
                print(f"  {'›' if d.index == cur else ' '} {d.label:>4}  {d.title}  {DIM}({d.path.name}, {d.n_pages}p){RST}")
            continue
        if q.startswith(":scope"):
            scope = "doc" if q.split()[-1] == "doc" else "all"
            print(f"{DIM}answers now use {'only ' + docs[cur].label if scope == 'doc' else 'all PDFs'}{RST}")
            continue
        if q.startswith((":d ", ":doc ")):
            try:
                cur = max(0, min(len(docs) - 1, int(q.split()[-1].lstrip("Dd")) - 1))
                page = 1
                print(f"{DIM}now reading {docs[cur].label}: {docs[cur].title}{RST}")
            except ValueError:
                print(f"{DIM}usage: :d 2{RST}")
            continue
        if q.startswith((":p", ":page")):
            try:
                page = max(1, min(docs[cur].n_pages, int(q.split()[-1])))
            except ValueError:
                print(f"{DIM}usage: :p 12{RST}")
            continue
        built = prompts.build(docs, retriever, q, page, "", history, args.ctx, doc_index=cur, scope=scope)
        refs = [f"{docs[d].label}:{p}" if built.multi else str(p) for d, p in built.sources]
        print(f"{DIM}context: {built.mode}, {'' if built.multi else 'pages '}{', '.join(refs[:12])}"
              f"{'…' if len(refs) > 12 else ''}{RST}")
        answer = []
        try:
            for piece in client.chat_stream(model, built.messages):
                answer.append(piece)
                print(piece, end="", flush=True)
        except KeyboardInterrupt:
            print(f"\n{DIM}(stopped){RST}")
        except LLMError as e:
            print(f"\n{RED}{e}{RST}")
            continue
        u = client.last_usage
        print(f"\n{DIM}{u.tokens} tok · {u.tps:.1f} tok/s{RST}\n")
        history += [{"role": "user", "content": q}, {"role": "assistant", "content": "".join(answer)}]


if __name__ == "__main__":
    main()
