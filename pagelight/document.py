"""PDF loading, text cleanup and page-aligned chunking."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf


@dataclass
class Chunk:
    id: int
    page: int  # 1-based
    text: str


@dataclass
class Document:
    path: Path
    sha: str
    title: str
    pages: list[str]
    outline: list[dict] = field(default_factory=list)
    chunks: list[Chunk] = field(default_factory=list)

    @property
    def n_pages(self) -> int:
        return len(self.pages)

    @property
    def n_chars(self) -> int:
        return sum(len(p) for p in self.pages)

    def page_text(self, page: int) -> str:
        if 1 <= page <= self.n_pages:
            return self.pages[page - 1]
        return ""

    def section_for_page(self, page: int) -> str | None:
        """Deepest outline heading that starts at or before `page`."""
        best = None
        for item in self.outline:
            if item["page"] <= page:
                best = item["title"]
            else:
                break
        return best


_HYPHEN_BREAK = re.compile(r"(\w)-\n(\w)")
_SOFT_BREAK = re.compile(r"(?<![.\n:;!?])\n(?!\n)")
_MULTI_SPACE = re.compile(r"[ \t ]+")
_MULTI_NL = re.compile(r"\n{3,}")


def clean_text(raw: str) -> str:
    t = raw.replace("\r", "")
    t = _HYPHEN_BREAK.sub(r"\1\2", t)  # de-hyphenate words split across lines
    t = _SOFT_BREAK.sub(" ", t)  # join wrapped lines inside a paragraph
    t = _MULTI_SPACE.sub(" ", t)
    t = _MULTI_NL.sub("\n\n", t)
    return t.strip()


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def chunk_pages(pages: list[str], words_per_chunk: int = 180, overlap: int = 40) -> list[Chunk]:
    """Split each page into overlapping word windows. Chunks never cross a page
    boundary, so every chunk maps to exactly one page for citations."""
    chunks: list[Chunk] = []
    step = max(1, words_per_chunk - overlap)
    for pno, text in enumerate(pages, start=1):
        words = text.split()
        if not words:
            continue
        if len(words) <= words_per_chunk + overlap // 2:
            chunks.append(Chunk(len(chunks), pno, " ".join(words)))
            continue
        for start in range(0, len(words), step):
            window = words[start : start + words_per_chunk]
            if len(window) < overlap and start > 0:
                break  # tail already covered by previous window's overlap
            chunks.append(Chunk(len(chunks), pno, " ".join(window)))
    return chunks


def load(path: str | Path) -> Document:
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(p)
    with pymupdf.open(p) as doc:
        if doc.needs_pass:
            raise ValueError("PDF is password-protected; decrypt it first (e.g. `qpdf --decrypt`).")
        pages = [clean_text(page.get_text("text", sort=True)) for page in doc]
        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip() or p.stem
        outline = []
        for level, heading, page in doc.get_toc(simple=True):
            if page >= 1 and heading.strip():
                outline.append({"level": level, "title": heading.strip(), "page": page})
        outline.sort(key=lambda o: o["page"])
    d = Document(path=p, sha=file_sha(p), title=title, pages=pages, outline=outline)
    d.chunks = chunk_pages(pages)
    return d
