"""Context assembly: decides which parts of which PDFs the model sees for a question."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .document import Document
from .retrieval import Retriever

SYSTEM = """You are a reading assistant built into a PDF reader. The user is reading "{title}" ({pages} pages) and is currently on {where}.

Each question comes with text from the PDF, with every page marked like [p. 12]. Answer from that text.

How to answer:
- Start with the answer itself. Don't begin with "According to the document", "Based on the excerpts" or anything similar, and never mention excerpts or context. Write as if you had just read the PDF yourself.
- End each sentence that uses the PDF with its page in square brackets, like this [p. 12]. Use the page marked on the text you took it from, and only cite pages that are marked in the text you were given.
- Use quotation marks only when you copy words exactly as they appear in the PDF. Otherwise, say it in your own words.
- If the user selected text, "this", "here" or "it" usually refers to the selection.
- If the PDF text doesn't answer the question, say so in one sentence. You can then add general knowledge, as long as you say it isn't from the PDF.
- Be direct and concise, and use short paragraphs or bullets. Write math in LaTeX: $...$ inline, $$...$$ for display."""

SYSTEM_MULTI = """You are a reading assistant built into a PDF reader. The user has {n} PDFs open, each with a short id:
{listing}

They are currently reading {cur}, {where}.

Each question comes with text from these PDFs, with every page marked by its PDF id and page number, like [D2 p. 12]. Answer from that text.

How to answer:
- Start with the answer itself. Don't begin with "According to the documents", "Based on the excerpts" or anything similar, and never mention excerpts or context. Write as if you had just read the PDFs yourself.
- End each sentence that uses a PDF with its id and page in square brackets, like this [D2 p. 12]. Use the id and page marked on the text you took it from, and only cite pages that are marked in the text you were given.
- Use quotation marks only when you copy words exactly as they appear in a PDF. Otherwise, say it in your own words.
- "This PDF", "this paper" or "here" means {cur} unless the user names another one. If the user selected text, "this" or "it" usually refers to the selection.
- When comparing PDFs, cover each one and cite each separately.
- If the PDF text doesn't answer the question, say so in one sentence. You can then add general knowledge, as long as you say it isn't from the PDFs.
- Be direct and concise, and use short paragraphs or bullets. Write math in LaTeX: $...$ inline, $$...$$ for display."""

# Repeated after the question on purpose. Small models (3B) follow formatting rules much more
# reliably when the rule comes right before they start writing than when it sits at the top of
# a long prompt, under thousands of tokens of PDF text.
REMINDER = (
    "Start with the answer, put the page like [p. 12] after each sentence that uses the PDF, "
    "and use quotation marks only for exact words from the PDF."
)
REMINDER_MULTI = (
    "Start with the answer, put the PDF id and page like [D2 p. 12] after each sentence that uses a PDF, "
    "and use quotation marks only for exact words from the PDFs."
)

_LOCAL_REF = re.compile(r"\b(this|current|the)\s+(page|section|paragraph|figure|table|equation|passage)\b|\bhere\b", re.I)
_OVERVIEW = re.compile(r"\b(compare|comparison|common|differ|difference|contrast|summar|overview|each of|all of|these|both|which (paper|document|pdf|one))", re.I)
_LABEL = re.compile(r"\bD(\d{1,3})\b")


def approx_tokens(text: str) -> int:
    return len(text) // 4 + 1


@dataclass
class BuiltPrompt:
    messages: list[dict]
    sources: list[tuple[int, int]]  # (doc index, page)
    mode: str  # "full-document" | "retrieval"
    multi: bool  # True when citations carry PDF ids

    @property
    def pages_used(self) -> list[int]:  # convenience for single-PDF callers
        return sorted({p for _, p in self.sources})


def _mentioned_docs(question: str, docs: list[Document]) -> set[int]:
    found = {int(m) - 1 for m in _LABEL.findall(question) if 0 < int(m) <= len(docs)}
    q = question.lower()
    for d in docs:
        names = {d.path.stem.lower(), d.title.lower()}
        if any(len(n) >= 4 and n in q for n in names):
            found.add(d.index)
    return found


def _system(docs: list[Document], cur: Document, page: int, multi: bool) -> str:
    section = cur.section_for_page(page)
    where = f"page {page}" + (f', in the section "{section}"' if section else "")
    if not multi:
        return SYSTEM.format(title=cur.title, pages=cur.n_pages, where=where)
    listing = "\n".join(f'- {d.label}: "{d.title}" ({d.path.name}, {d.n_pages} pages)' for d in docs[:40])
    if len(docs) > 40:
        listing += f"\n- … and {len(docs) - 40} more"
    return SYSTEM_MULTI.format(n=len(docs), listing=listing, cur=cur.label, where=where)


def build(
    docs: list[Document] | Document,
    retriever: Retriever,
    question: str,
    page: int,
    selection: str,
    history: list[dict],
    ctx_tokens: int,
    doc_index: int = 0,
    scope: str = "all",
    answer_reserve: int = 1200,
) -> BuiltPrompt:
    if isinstance(docs, Document):
        docs = [docs]
    doc_index = max(0, min(doc_index, len(docs) - 1))
    cur = docs[doc_index]
    multi = scope != "doc" and len(docs) > 1
    in_scope = docs if multi else [cur]
    page = max(1, min(page or 1, cur.n_pages or 1))
    system = _system(docs, cur, page, multi)
    reminder = REMINDER_MULTI if multi else REMINDER

    # keep the last few turns, newest first, within ~20% of the window
    hist_budget = int(ctx_tokens * 0.2)
    kept: list[dict] = []
    for msg in reversed(history[-12:]):
        cost = approx_tokens(msg.get("content", ""))
        if cost > hist_budget:
            break
        hist_budget -= cost
        kept.insert(0, {"role": msg["role"], "content": msg["content"]})
    while kept and kept[0]["role"] != "user":  # never start history on an orphaned reply
        kept.pop(0)

    selection = (selection or "").strip()[:6000]
    budget = (
        ctx_tokens
        - answer_reserve
        - approx_tokens(system)
        - sum(approx_tokens(m["content"]) for m in kept)
        - approx_tokens(question)
        - approx_tokens(selection)
        - approx_tokens(reminder)
        - 150
    )

    blocks: list[tuple[int, int, str]] = []  # (doc, page, text)
    used = 0

    def add(d: int, p: int, text: str) -> bool:
        nonlocal used
        cost = approx_tokens(text) + 10
        if not text or used + cost > budget:
            return False
        blocks.append((d, p, text))
        used += cost
        return True

    mode = "retrieval"
    total_tokens = sum(approx_tokens(p) for d in in_scope for p in d.pages)
    if total_tokens <= budget * 0.9:
        # everything fits: give the model the full text, in order
        mode = "full-document"
        for d in in_scope:
            for i, t in enumerate(d.pages, start=1):
                if t.strip():
                    add(d.index, i, t)
    else:
        local = bool(_LOCAL_REF.search(question))
        mentioned = _mentioned_docs(question, docs) if multi else set()
        overview = multi and not local and bool(_OVERVIEW.search(question))

        # 1) the page being read (trimmed if huge), unless the question is clearly about other PDFs
        if not mentioned or doc_index in mentioned:
            add(cur.index, page, cur.page_text(page)[: int(budget * (0.5 if local else 0.3)) * 4])
        # 1b) "this page / here / this section": neighbouring pages beat far-away search hits
        if local:
            for nb in (page - 1, page + 1):
                add(cur.index, nb, cur.page_text(nb)[: int(budget * 0.15) * 4])
        # 1c) questions naming PDFs, or comparing/summarising several: their opening page
        #     (title, abstract, intro) plus section openings anchor the answer when keywords won't
        openers = sorted(mentioned) if mentioned else ([d.index for d in in_scope] if overview and len(in_scope) <= 8 else [])
        if not multi and _OVERVIEW.search(question) and not local:
            openers = [cur.index]  # "summarize this document"
        share = int(budget * 0.5 / max(1, len(openers))) if openers else 0
        for di in openers:
            d = docs[di]
            add(di, 1, d.page_text(1)[: max(200, share // 2) * 4])
            if _OVERVIEW.search(question) or di in mentioned:
                tops = [o for o in d.outline if o["level"] == 1 and o["page"] > 1][:6]
                for o in tops:
                    add(di, o["page"], d.page_text(o["page"])[: max(80, share // (2 * max(1, len(tops)))) * 4])

        # 2) retrieved passages
        query = f"{question}\n{selection[:800]}" if selection else question
        if mentioned:
            allowed = mentioned
        elif multi:
            allowed = None
        else:
            allowed = {cur.index}
        k = 4 if local else (14 if multi else 10)  # focused beats exhaustive for small models
        whole = {(d, p) for d, p, _ in blocks}
        balanced = max(2, -(-k // max(1, len(in_scope))) + 1) if overview else None
        for chunk, _ in retriever.search(query, k=k, docs=allowed, per_doc=balanced):
            if (chunk.doc, chunk.page) in whole:
                continue  # that page is already included
            if not add(chunk.doc, chunk.page, chunk.text):
                break

    # merge chunks of the same page; present PDFs and pages in order
    grouped: dict[tuple[int, int], list[str]] = {}
    for d, p, t in blocks:
        texts = grouped.setdefault((d, p), [])
        if t not in texts:
            texts.append(t)
    keys = sorted(grouped)

    # The tag names avoid "excerpts" and "document", since small models tend to echo the
    # label back ("According to the document excerpts...").
    if multi:
        sections = []
        for di in sorted({d for d, _ in keys}):
            doc = docs[di]
            body = "\n\n".join(f"[{doc.label} p. {p}]\n" + "\n…\n".join(grouped[(d, p)]) for d, p in keys if d == di)
            title = doc.title.replace('"', "'")
            sections.append(f'<pdf id="{doc.label}" title="{title}">\n{body}\n</pdf>')
        text = "\n\n".join(sections)
    else:
        text = "\n\n".join(f"[p. {p}]\n" + "\n…\n".join(grouped[(d, p)]) for d, p in keys)

    parts = [f"<pdf_pages>\n{text}\n</pdf_pages>" if text else "<pdf_pages/>"]
    if selection:
        where = f'pdf="{cur.label}" page="{page}"' if multi else f'page="{page}"'
        parts.append(f"<selected_text {where}>\n{selection}\n</selected_text>")
    parts.append(f"Question: {question}")
    parts.append(reminder)

    messages = [{"role": "system", "content": system}, *kept, {"role": "user", "content": "\n\n".join(parts)}]
    return BuiltPrompt(messages=messages, sources=keys, mode=mode, multi=multi)
