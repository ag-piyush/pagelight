"""Context assembly: decides what part of the PDF the model sees for a question."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .document import Document
from .retrieval import Retriever

SYSTEM = """You are a reading assistant built into a PDF reader. The user is reading "{title}" ({pages} pages) and is currently on page {page}{section}.

Each question comes with text from the PDF, with every page marked like [p. 12]. Answer from that text.

How to answer:
- Start with the answer itself. Don't begin with "According to the document", "Based on the excerpts" or anything similar, and never mention excerpts or context. Write as if you had just read the PDF yourself.
- End each sentence that uses the PDF with its page in square brackets, like this [p. 12]. Use the page marked on the text you took it from, and only cite pages that are marked in the text you were given.
- Use quotation marks only when you copy words exactly as they appear in the PDF. Otherwise, say it in your own words.
- If the user selected text, "this", "here" or "it" usually refers to the selection.
- If the PDF text doesn't answer the question, say so in one sentence. You can then add general knowledge, as long as you say it isn't from the PDF.
- Be direct and concise, and use short paragraphs or bullets. Write math in LaTeX: $...$ inline, $$...$$ for display."""

# Repeated after the question on purpose. Small models (3B) follow formatting rules much more
# reliably when the rule comes right before they start writing than when it sits at the top of
# a long prompt, under thousands of tokens of PDF text.
REMINDER = (
    "Start with the answer, put the page like [p. 12] after each sentence that uses the PDF, "
    "and use quotation marks only for exact words from the PDF."
)


_LOCAL_REF = re.compile(r"\b(this|current|the)\s+(page|section|paragraph|figure|table|equation|passage)\b|\bhere\b", re.I)


def approx_tokens(text: str) -> int:
    return len(text) // 4 + 1


@dataclass
class BuiltPrompt:
    messages: list[dict]
    pages_used: list[int]
    mode: str  # "full-document" | "retrieval"


def build(
    doc: Document,
    retriever: Retriever,
    question: str,
    page: int,
    selection: str,
    history: list[dict],
    ctx_tokens: int,
    answer_reserve: int = 1200,
) -> BuiltPrompt:
    page = max(1, min(page or 1, doc.n_pages or 1))
    section = doc.section_for_page(page)
    system = SYSTEM.format(
        title=doc.title,
        pages=doc.n_pages,
        page=page,
        section=f', in the section "{section}"' if section else "",
    )

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
        - 150
    )

    blocks: list[tuple[int, str]] = []  # (page, text)
    mode = "retrieval"
    total_tokens = sum(approx_tokens(p) for p in doc.pages)
    if total_tokens <= budget * 0.9:
        # short document: give the model everything, in order
        mode = "full-document"
        blocks = [(i + 1, t) for i, t in enumerate(doc.pages) if t.strip()]
    else:
        used = 0
        local = bool(_LOCAL_REF.search(question))
        # 1) the page being read (trimmed if huge)
        cur = doc.page_text(page)
        if cur:
            cur = cur[: int(budget * (0.5 if local else 0.35)) * 4]
            blocks.append((page, cur))
            used += approx_tokens(cur)
        # 1b) "this page / here / this section" → the surrounding pages matter more than search hits
        if local:
            for nb in (page - 1, page + 1):
                t = doc.page_text(nb)[: int(budget * 0.15) * 4]
                if t and used + approx_tokens(t) < budget:
                    blocks.append((nb, t))
                    used += approx_tokens(t)
        # 2) retrieved passages from anywhere in the doc
        query = f"{question}\n{selection[:800]}" if selection else question
        k = 4 if local else 10  # focused beats exhaustive for small models
        for chunk, _ in retriever.search(query, k=k):
            if chunk.page == page or (local and chunk.page in (page - 1, page + 1)):
                continue  # already included in full
            cost = approx_tokens(chunk.text) + 8
            if used + cost > budget:
                break
            blocks.append((chunk.page, chunk.text))
            used += cost

    # merge chunks of the same page, present in page order
    by_page: dict[int, list[str]] = {}
    for p, t in blocks:
        by_page.setdefault(p, [])
        if t not in by_page[p]:
            by_page[p].append(t)
    excerpt = "\n\n".join(f"[p. {p}]\n" + "\n…\n".join(ts) for p, ts in sorted(by_page.items()))

    # The tag name avoids "excerpts" and "document", since small models tend to echo the
    # label back ("According to the document excerpts...").
    parts = [f"<pdf_pages>\n{excerpt}\n</pdf_pages>" if excerpt else "<pdf_pages/>"]
    if selection:
        parts.append(f'<selected_text page="{page}">\n{selection}\n</selected_text>')
    parts.append(f"Question: {question}")
    parts.append(REMINDER)

    messages = [{"role": "system", "content": system}, *kept, {"role": "user", "content": "\n\n".join(parts)}]
    return BuiltPrompt(messages=messages, pages_used=sorted(by_page), mode=mode)