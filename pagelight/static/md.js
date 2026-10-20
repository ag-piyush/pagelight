// Small, safe markdown renderer for model answers: escapes all HTML first,
// renders LaTeX with the bundled KaTeX, and turns [p. 12] / [D2 p. 5] into page links.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderMath(tex, display) {
  const k = globalThis.katex;
  if (!k) return esc(display ? `$$${tex}$$` : `$${tex}$`);
  try {
    return k.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

// Citations: [p. 12], [pp. 3-4], [p. 3, 5], (p. 12), [D2 p. 5], [D2, p. 5; D3 p. 9] …
// ctx = { defaultDoc, docs: [{ short, title }] } — doc names are shown when several PDFs are open.
function parseCites(inner, defaultDoc, nDocs) {
  if (!/\bpp?\.|\bpp?\s*\d|\bpages?\b/i.test(inner)) return null; // must mention a page
  const out = [];
  let doc = defaultDoc;
  for (const part of inner.split(/\s*(?:;|,|&|\band\b)\s*/i).filter(Boolean)) {
    const m = part.match(/^(?:(?:D|doc(?:ument)?\s*)(\d{1,3})\b\s*:?\s*)?(?:(?:pp?|pages?)\.?\s*)?(\d+)?(?:\s*[–-]\s*(\d+))?$/i);
    if (!m || (!m[1] && !m[2])) return null;
    if (m[1]) {
      doc = +m[1] - 1;
      if (doc < 0 || doc >= nDocs) return null;
    }
    if (m[2]) out.push({ doc, page: +m[2], end: m[3] ? +m[3] : null });
  }
  return out.length ? out : null;
}

function citeButtons(cites, ctx) {
  const multi = ctx.docs.length > 1;
  return cites.map(({ doc, page, end }) => {
    const pages = end ? `p. ${page}–${end}` : `p. ${page}`;
    const d = ctx.docs[doc];
    const label = multi && d ? `${esc(d.short)} · ${pages}` : pages;
    const title = d ? `${esc(d.title)} — page ${page}` : `Go to page ${page}`;
    return `<button class="cite" data-doc="${doc}" data-page="${page}" title="${title}">${label}</button>`;
  }).join("");
}

function inline(text, stash, ctx) {
  let s = esc(text).replace(/\n/g, "<br>");
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/[\[(]([^\[\]()\n]{1,120})[\])]/g, (whole, inner) => {
    const cites = parseCites(inner, ctx.defaultDoc, Math.max(1, ctx.docs.length));
    return cites ? citeButtons(cites, ctx) : whole;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

export function render(src, ctx = {}) {
  ctx = { defaultDoc: ctx.defaultDoc ?? 0, docs: ctx.docs ?? [] };
  const stash = [];
  const put = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let text = src.replace(/\r/g, "");

  // fenced code blocks first, then math, then inline code — all stashed
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) =>
    put(`<pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(code.replace(/\n$/, ""))}</code></pre>`));
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(renderMath(t.trim(), true)));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(renderMath(t.trim(), true)));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(renderMath(t.trim(), false)));
  text = text.replace(/(^|[^\\$\w])\$(?=[^\s$])([^$\n]+?[^\s\\])\$(?![\d$])/g, (_, pre, t) => pre + put(renderMath(t, false)));
  text = text.replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`));

  const lines = text.split("\n");
  const out = [];
  let para = [];
  let list = null; // {type, items}
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("\n"), stash, ctx)}</p>`); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i, stash, ctx)}</li>`).join("")}</${list.type}>`); list = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    if (/^\u0000\d+\u0000$/.test(line.trim()) && stash[+line.trim().slice(1, -1)].startsWith("<pre")) {
      flushPara(); flushList(); out.push(stash[+line.trim().slice(1, -1)]); continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      const lvl = Math.min(4, m[1].length + 1);
      out.push(`<h${lvl}>${inline(m[2], stash, ctx)}</h${lvl}>`); continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1], stash, ctx)}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, stash, ctx)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, stash, ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if ((m = line.match(/^\s*(?:[-*+•])\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
      list.items.push(m[1]); continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}
