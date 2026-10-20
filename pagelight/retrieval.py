"""Hybrid retrieval: BM25 always, local embeddings when an embedding model is
available, fused with reciprocal-rank fusion."""

from __future__ import annotations

import json
import math
import os
import re
import threading
from collections import Counter
from pathlib import Path
from typing import Callable

from .document import Chunk, Document

_TOKEN = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")
_STOP = frozenset(
    """a an and are as at be been but by can do does for from had has have how i if in into is it its
    of on or our so such than that the their them then there these they this to was we were what when
    where which who why will with would you your about also may more most not only other some any each
    """.split()
)


def _stem(t: str) -> str:
    """Light, consistent suffix folding (use/uses/used/using -> 'us') so BM25
    matches word forms without pulling in a stemmer dependency."""
    if len(t) <= 2 or t.isdigit():
        return t
    if t.endswith("ies") and len(t) > 4:
        t = t[:-3] + "y"
    elif t.endswith(("sses", "xes", "ches", "shes", "zes")):
        t = t[:-2]
    elif t.endswith("s") and not t.endswith(("ss", "us", "is", "as")) and len(t) > 3:
        t = t[:-1]
    elif t.endswith("ing") and len(t) >= 5:
        t = t[:-3]
    elif t.endswith("ed") and len(t) >= 4:
        t = t[:-2]
    if len(t) >= 3 and t.endswith("e"):
        t = t[:-1]
    if len(t) > 3 and t[-1] == t[-2] and t[-1] not in "aeiou":
        t = t[:-1]
    return t


def tokenize(text: str) -> list[str]:
    out = []
    for t in _TOKEN.findall(text.lower()):
        if t in _STOP or (len(t) < 2 and not t.isdigit()):
            continue
        out.append(_stem(t))
    return out


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.4, b: float = 0.75):
        self.k1, self.b = k1, b
        self.tfs = [Counter(tokenize(d)) for d in docs]
        self.lens = [sum(tf.values()) for tf in self.tfs]
        self.avgdl = (sum(self.lens) / len(self.lens)) if self.lens else 0.0
        df: Counter = Counter()
        for tf in self.tfs:
            df.update(tf.keys())
        n = len(docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def scores(self, query: str) -> list[float]:
        q = tokenize(query)
        out = []
        for tf, dl in zip(self.tfs, self.lens):
            s = 0.0
            for t in q:
                f = tf.get(t)
                if f:
                    s += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1)))
            out.append(s)
        return out


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class EmbeddingIndex:
    """Embeds chunks once (in a background thread) and caches vectors on disk,
    keyed by file hash + model, so re-opening a PDF is instant."""

    def __init__(self, doc: Document, embed_fn: Callable[[list[str]], list[list[float]]], model: str, cache_dir: Path):
        self.doc, self.embed_fn, self.model = doc, embed_fn, model
        safe_model = re.sub(r"[^A-Za-z0-9_.-]", "_", model)
        self.cache_path = cache_dir / f"{doc.sha[:20]}-{safe_model}.json"
        self.vectors: list[list[float]] | None = None
        self.progress = 0.0
        self.error: str | None = None
        self._np = None
        try:
            import numpy as np  # optional speed-up

            self._np = np
        except Exception:
            pass
        self._matrix = None

    @property
    def ready(self) -> bool:
        return self.vectors is not None

    def build_async(self) -> None:
        threading.Thread(target=self._build, name="embed-index", daemon=True).start()

    def _build(self) -> None:
        try:
            if self.cache_path.is_file():
                data = json.loads(self.cache_path.read_text())
                if data.get("n") == len(self.doc.chunks):
                    self._set(data["vectors"])
                    return
            texts = [c.text for c in self.doc.chunks]
            vecs: list[list[float]] = []
            batch = 32
            for i in range(0, len(texts), batch):
                vecs.extend(self.embed_fn(texts[i : i + batch]))
                self.progress = min(1.0, (i + batch) / max(1, len(texts)))
            vecs = [_normalize(v) for v in vecs]
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"n": len(vecs), "model": self.model, "vectors": vecs}))
            os.replace(tmp, self.cache_path)
            self._set(vecs)
        except Exception as e:  # retrieval silently degrades to BM25-only
            self.error = f"{type(e).__name__}: {e}"

    def _set(self, vecs: list[list[float]]) -> None:
        if self._np is not None:
            self._matrix = self._np.asarray(vecs, dtype="float32")
        self.vectors = vecs
        self.progress = 1.0

    def scores(self, query: str) -> list[float]:
        q = _normalize(self.embed_fn([query])[0])
        if self._matrix is not None:
            return (self._matrix @ self._np.asarray(q, dtype="float32")).tolist()
        return [sum(a * b for a, b in zip(v, q)) for v in self.vectors or []]


class Retriever:
    def __init__(self, doc: Document, embed_index: EmbeddingIndex | None = None):
        self.doc = doc
        self.bm25 = BM25([c.text for c in doc.chunks]) if doc.chunks else None
        self.embed = embed_index

    @property
    def mode(self) -> str:
        if self.embed and self.embed.ready:
            return "hybrid"
        if self.embed and not self.embed.error:
            return "bm25 (embedding…)"
        return "bm25"

    def search(self, query: str, k: int = 8) -> list[tuple[Chunk, float]]:
        if not self.doc.chunks or not query.strip():
            return []
        rankings: list[list[int]] = []
        if self.bm25:
            s = self.bm25.scores(query)
            rankings.append([i for i in sorted(range(len(s)), key=lambda i: -s[i]) if s[i] > 0])
        if self.embed and self.embed.ready:
            try:
                s = self.embed.scores(query)
                rankings.append(sorted(range(len(s)), key=lambda i: -s[i]))
            except Exception:
                pass
        fused: dict[int, float] = {}
        for ranking in rankings:
            for rank, idx in enumerate(ranking[:100]):
                fused[idx] = fused.get(idx, 0.0) + 1.0 / (60 + rank)
        top = sorted(fused.items(), key=lambda kv: -kv[1])[:k]
        return [(self.doc.chunks[i], score) for i, score in top]
