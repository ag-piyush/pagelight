# Changelog

All notable changes to pagelight are listed here. Versions follow [semantic versioning](https://semver.org).

## 0.2.1

- pagelight is now on PyPI: install with `pipx install pagelight` and update with `pipx upgrade pagelight`.

## 0.2.0

Multiple PDFs.

- Open several PDFs or whole folders at once: `pagelight a.pdf b.pdf ~/papers/` (folders are searched recursively; duplicate files are skipped).
- Answers search across every open PDF and cite the file and page, e.g. `bert notes · p. 11`. Clicking a citation opens that file at that page.
- Switch between PDFs from the title menu, or with `[` and `]`.
- **All N PDFs / Only D1** toggle to answer from every PDF or just the one you're reading.
- Naming a file in a question ("summarize D3", "what does bert-notes say…") restricts the search to it; "compare" and "summarize" questions include each document's opening and section starts.
- Search keeps one file from taking every slot, so comparisons cover each document.
- Terminal mode gains `:docs`, `:d N` and `:scope all|doc`.
- Chat history is remembered per set of PDFs.
- Clicking a citation scrolls to the passage it refers to and highlights it for a few seconds. If nothing on the page matches the cited sentence, the page outline flashes instead.

## 0.1.0

First release.

- PDF reader in the browser (pdf.js) with a chat panel beside it, served from `127.0.0.1`.
- Answers come from a local model through Ollama, or any OpenAI-compatible local server (llama.cpp, LM Studio, vLLM).
- The model knows which page you're on; select text and click **Ask about this** to ask about a passage.
- Answers cite pages as clickable `p. 12` chips.
- Short documents are sent whole; long ones use hybrid search (BM25 + local embeddings, merged with reciprocal-rank fusion). Embeddings are cached per file.
- LaTeX in answers renders with KaTeX.
- Terminal mode (`-t`) for asking without a browser.
- Offline by design: local-only model servers, all assets bundled, Content-Security-Policy, loopback-only server with a per-session token.
