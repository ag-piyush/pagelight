# Changelog

All notable changes to pagelight are listed here. Versions follow [semantic versioning](https://semver.org).

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
