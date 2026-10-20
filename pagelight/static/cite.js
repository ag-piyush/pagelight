// Citation highlighting: when a citation chip is clicked, find the passage on the
// cited page that best matches the sentence the chip belongs to, and highlight it.
//
// Matching is done against pdf.js's text layer (the invisible, selectable spans laid
// over each page), so the highlight lines up with the rendered text.

const STOP = new Set(
  `a an and are as at be been but by can could do does for from had has have how i if in into is it its
  of on or our so such than that the their them then there these they this those to was we were what
  when where which while who why will with would you your about also may more most not only other some
  any each over under between both very just like using used use uses here page pdf`.split(/\s+/),
);

// Same light suffix folding on both sides, so "uses" matches "using" and "rates" matches "rate".
function stem(w) {
  if (w.length <= 3 || /^\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

// Words with their character positions. Hyphens inside words are dropped so that
// "cross-entropy" and "learn-ing" (split across a line) compare equal to their plain forms.
export function words(text) {
  const out = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:[-.,'’][\p{L}\p{N}]+)*/gu)) {
    const raw = m[0].toLowerCase().replace(/[-'’]/g, "");
    out.push({ w: stem(raw), raw, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const isContent = (w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w));

// The sentence a citation chip belongs to, read from the rendered answer.
export function claimFor(btn) {
  const block = btn.closest("p, li, td, th, blockquote, h1, h2, h3, h4, h5") || btn.parentElement;
  if (!block) return "";
  let before = "";
  let after = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        // skip other citation chips and typeset math (its DOM text is noisy)
        return n.classList.contains("cite") || n.classList.contains("katex")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (btn.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) before += n.data;
    else after += n.data;
  }
  before = before.replace(/\s+/g, " ").trim();
  after = after.replace(/\s+/g, " ").trim();

  // The model puts the chip at the end of the sentence it supports ("… text [p. 12].").
  const pieces = before.split(/(?<=[.!?])\s+/).filter(Boolean);
  let claim = pieces.pop() || "";
  if (words(claim).filter((t) => isContent(t.w)).length < 3 && pieces.length) claim = `${pieces.pop()} ${claim}`;
  // A chip at the start of a line ("[p. 3] Regret is …") belongs to what follows it.
  if (words(claim).filter((t) => isContent(t.w)).length < 3) {
    claim = `${claim} ${after.split(/(?<=[.!?])\s+/)[0] || ""}`.trim();
  }
  return claim.split(/\s+/).slice(-60).join(" ");
}

// The leaf spans of a rendered text layer, joined into one string with offsets.
function pageText(layer) {
  const spans = [...layer.querySelectorAll("span")].filter(
    (s) => !s.classList.contains("markedContent") && !s.querySelector("span") && s.textContent.trim(),
  );
  let full = "";
  const ranges = [];
  for (const s of spans) {
    const text = s.textContent;
    // a word broken across lines ("learn-" / "ing") is joined without a space
    if (full && !/-$/.test(full)) full += " ";
    const start = full.length;
    full += text;
    ranges.push({ start, end: full.length, span: s });
  }
  return { full, ranges };
}

// The exact character ranges [start, end) covers, as (span, from, to) pieces.
function segmentsIn(ranges, start, end) {
  return ranges
    .filter((r) => r.end > start && r.start < end)
    .map((r) => ({ span: r.span, from: Math.max(0, start - r.start), to: Math.min(r.end, end) - r.start }));
}

// Exact quote: if the answer quotes the PDF, find that word sequence first.
function findQuote(claim, toks) {
  for (const m of claim.matchAll(/[“"]([^”"]{12,})[”"]/g)) {
    const q = words(m[1]).map((t) => t.w);
    if (q.length < 3) continue;
    outer: for (let i = 0; i + q.length <= toks.length; i++) {
      for (let j = 0; j < q.length; j++) if (toks[i + j].w !== q[j]) continue outer;
      return [toks[i].start, toks[i + q.length - 1].end];
    }
  }
  return null;
}

/**
 * Find the passage on a page that supports `claim`.
 * Returns { segments, score } or null when nothing on the page matches well enough.
 */
export function findPassage(layer, claim) {
  const { full, ranges } = pageText(layer);
  if (!full || !claim) return null;
  const toks = words(full);
  if (!toks.length) return null;

  const quoted = findQuote(claim, toks);
  if (quoted) return { segments: segmentsIn(ranges, quoted[0], quoted[1]), score: 1 };

  const claimToks = words(claim).map((t) => t.w);
  const content = [...new Set(claimToks.filter(isContent))];
  if (content.length < 2) return null;

  // Words that appear all over the page say little about where the claim came from.
  const freq = new Map();
  for (const t of toks) freq.set(t.w, (freq.get(t.w) || 0) + 1);
  const weight = (w) => (/\d/.test(w) ? 2 : 1) * (w.length >= 7 ? 1.3 : 1);
  const rarity = (w) => 1 / (1 + Math.log(freq.get(w) || 1));
  const total = content.reduce((s, w) => s + weight(w), 0);
  const want = new Set(content);
  const contentSeq = claimToks.filter(isContent);
  const bigrams = new Set(contentSeq.slice(1).map((w, i) => `${contentSeq[i]} ${w}`));

  // Score any run of page words [a, b) by how much of the claim it covers.
  const scoreRange = (a, b) => {
    const seen = new Set();
    let s = 0;
    for (let k = a; k < b; k++) {
      const w = toks[k].w;
      if (want.has(w) && !seen.has(w)) {
        seen.add(w);
        s += weight(w) * rarity(w);
      }
    }
    const seq = [];
    for (let k = a; k < b; k++) if (isContent(toks[k].w)) seq.push(toks[k].w);
    let pairs = 0;
    for (let k = 1; k < seq.length; k++) if (bigrams.has(`${seq[k - 1]} ${seq[k]}`)) pairs++;
    // a small cost per word keeps the highlight from swallowing neighbouring text
    return { score: s / total + Math.min(0.25, pairs * 0.06) - (b - a) * 0.0015, matched: seen.size };
  };

  // Pick the best sentence, then add a neighbouring sentence only if the claim clearly
  // spans it too. Very long "sentences" (tables, run-on text) fall back to a word window.
  const sents = sentences(full, toks);
  let best = null;
  for (const [a, b] of sents) {
    let range = [a, b];
    if (b - a > 70) range = bestWindow(a, b, Math.max(12, Math.min(50, Math.round(claimToks.length * 1.4))), scoreRange, toks, want);
    const r = scoreRange(range[0], range[1]);
    if (!best || r.score > best.score) best = { ...r, a: range[0], b: range[1], si: sents.findIndex((x) => x[0] === a) };
  }
  if (!best || best.score < 0.3 || best.matched < 2) return null;
  let { a, b } = best;
  for (let step = 0; step < 2; step++) {
    const prev = sents[best.si - 1];
    const next = sents[best.si + 1];
    const options = [];
    if (prev && a === sents[best.si][0]) options.push({ a: prev[0], b, si: best.si - 1, dir: -1 });
    if (next && b === sents[best.si][1]) options.push({ a, b: next[1], si: best.si + 1, dir: 1 });
    let grown = null;
    for (const o of options) {
      if (o.b - o.a > 90) continue;
      const r = scoreRange(o.a, o.b);
      if (r.score >= best.score + 0.15 && (!grown || r.score > grown.score)) grown = { ...o, ...r };
    }
    if (!grown) break;
    a = grown.a;
    b = grown.b;
    best = { ...best, score: grown.score, matched: grown.matched, si: grown.si };
  }

  let startChar = toks[a].start;
  let endChar = toks[b - 1].end;
  const tail = full.slice(endChar).match(/^[.!?]["”')\]]?/);
  if (tail) endChar += tail[0].length;
  return { segments: segmentsIn(ranges, startChar, endChar), score: best.score };
}

const ABBR = new Set(["e.g", "i.e", "al", "fig", "figs", "eq", "eqs", "vs", "cf", "etc", "no", "sec", "ch", "resp", "approx", "thm", "def", "prop", "lem"]);

// Sentence boundaries as [first word, last word + 1) index pairs.
function sentences(full, toks) {
  const out = [];
  let a = 0;
  for (let k = 0; k < toks.length - 1; k++) {
    const gap = full.slice(toks[k].end, toks[k + 1].start);
    const nextChar = full[toks[k + 1].start];
    const ends = /^[.!?]["”')\]]*\s/.test(gap) || /\n\s*\n/.test(gap);
    if (ends && /[\p{Lu}\p{N}(\[]/u.test(nextChar) && !ABBR.has(toks[k].raw)) {
      out.push([a, k + 1]);
      a = k + 1;
    }
  }
  out.push([a, toks.length]);
  return out;
}

// Best fixed-size window inside [lo, hi), trimmed to the words that matched.
function bestWindow(lo, hi, W, scoreRange, toks, want) {
  let best = null;
  for (let i = lo; i < hi; i += 2) {
    const j = Math.min(hi, i + W);
    const r = scoreRange(i, j);
    if (!best || r.score > best.score) best = { ...r, i, j };
    if (j >= hi) break;
  }
  let i = best.i;
  let j = best.j;
  while (i < j && !want.has(toks[i].w)) i++;
  while (j > i && !want.has(toks[j - 1].w)) j--;
  return i < j ? [i, j] : [best.i, best.j];
}

// ---------------------------------------------------------------- showing it
// The highlight is drawn as boxes over the page (not by styling the text-layer spans),
// so it covers exactly the matched characters even when a sentence starts mid-line.
let active = null;

export function clearHighlight() {
  if (!active) return;
  clearTimeout(active.t1);
  clearTimeout(active.t2);
  active.overlay?.remove();
  active.page?.classList.remove("cite-flash");
  active = null;
}

function boxesFor(segments) {
  const rects = [];
  for (const { span, from, to } of segments) {
    const node = span.firstChild;
    if (!node || node.nodeType !== 3) {
      rects.push(...span.getClientRects());
      continue;
    }
    const range = document.createRange();
    range.setStart(node, Math.min(from, node.length));
    range.setEnd(node, Math.min(to, node.length));
    rects.push(...range.getClientRects());
  }
  // merge pieces that sit on the same line and touch, so each line is one box
  const boxes = [];
  for (const r of rects.filter((r) => r.width > 0.5 && r.height > 0.5).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = boxes[boxes.length - 1];
    if (last && Math.abs(last.top - r.top) < r.height * 0.5 && r.left - last.right < r.height * 0.8) {
      last.right = Math.max(last.right, r.right);
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
    } else {
      boxes.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return boxes;
}

export function flashPassage(found, holdMs = 3200) {
  clearHighlight();
  const pageEl = found.segments[0]?.span.closest(".page");
  if (!pageEl) return false;
  const boxes = boxesFor(found.segments);
  if (!boxes.length) return false;
  const origin = pageEl.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "cite-hl-layer";
  overlay.dataset.text = found.segments.map(({ span, from, to }) => span.textContent.slice(from, to)).join(" ");
  for (const b of boxes) {
    const el = document.createElement("div");
    el.className = "cite-hl";
    el.style.left = `${b.left - origin.left - pageEl.clientLeft - 2}px`;
    el.style.top = `${b.top - origin.top - pageEl.clientTop - 1}px`;
    el.style.width = `${b.right - b.left + 4}px`;
    el.style.height = `${b.bottom - b.top + 2}px`;
    overlay.appendChild(el);
  }
  pageEl.appendChild(overlay);
  overlay.firstChild.scrollIntoView({ block: "center", behavior: "smooth" });
  const t1 = setTimeout(() => overlay.classList.add("out"), holdMs);
  const t2 = setTimeout(clearHighlight, holdMs + 1000);
  active = { overlay, t1, t2 };
  return true;
}

export function flashPage(pageEl) {
  clearHighlight();
  if (!pageEl) return;
  pageEl.classList.add("cite-flash");
  const t1 = setTimeout(() => pageEl.classList.remove("cite-flash"), 1600);
  active = { page: pageEl, t1, t2: null };
}
