import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { render } from "./md.js";
import { claimFor, clearHighlight, findPassage, flashPage, flashPassage } from "./cite.js";

globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads the library from the global
const { EventBus, PDFViewer, PDFLinkService, PDFFindController } = await import("./vendor/pdfjs/pdf_viewer.mjs");

const TOKEN = document.querySelector('meta[name="session-token"]').content;
const abs = (p) => new URL(p, location.origin).href;
const $ = (id) => document.getElementById(id);

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { "X-Session-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  info: null,
  docs: [],
  cur: 0, // index of the PDF in the viewer
  page: 1,
  scope: "all", // "all" PDFs or just the current "doc"
  selection: "",
  selectionPage: null,
  selectionDoc: null,
  messages: [],
  busy: false,
  abort: null,
};
const multi = () => state.docs.length > 1;
const curDoc = () => state.docs[state.cur];

// short, human name for citation chips: file name without extension, trimmed
function shortName(d) {
  const base = d.file.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  return base.length > 18 ? `${base.slice(0, 17)}…` : base;
}
const renderCtx = (defaultDoc) => ({ defaultDoc, docs: state.docs.map((d) => ({ short: d.short, title: d.title })) });

// ---------------------------------------------------------------- viewer
pdfjsLib.GlobalWorkerOptions.workerSrc = abs("/static/vendor/pdfjs/pdf.worker.min.mjs");

const container = $("viewerContainer");
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer nofollow" });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container,
  viewer: $("viewer"),
  eventBus,
  linkService,
  findController,
  annotationEditorMode: pdfjsLib.AnnotationEditorType?.DISABLE ?? -1,
  enableHWA: true,
});
linkService.setViewer(viewer);

let pdfDoc = null;
const dispose = (pdf) => { try { pdf?.loadingTask?.destroy?.(); } catch {} };
let pendingPage = null;
let loadSeq = 0;

const zoomLabel = () => { $("zoomLabel").textContent = `${Math.round(viewer.currentScale * 100)}%`; };

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  const start = pendingPage || store.get(`pagelight:page:${curDoc().docId}`, 1);
  pendingPage = null;
  if (start > 1 && start <= viewer.pagesCount) viewer.currentPageNumber = start;
  zoomLabel();
});
eventBus.on("scalechanging", () => { zoomLabel(); clearHighlight(); });
eventBus.on("pagechanging", ({ pageNumber }) => setPage(pageNumber));
eventBus.on("updatefindmatchescount", ({ matchesCount }) => showFindCount(matchesCount));
eventBus.on("updatefindcontrolstate", ({ matchesCount, state: s }) => {
  if (s === 1 /* NOT_FOUND */) $("findCount").textContent = "0";
  else showFindCount(matchesCount);
});
function showFindCount(mc) {
  if (!mc || !$("findInput").value) { $("findCount").textContent = ""; return; }
  $("findCount").textContent = mc.total ? `${mc.current}/${mc.total}` : "0";
}

function setPage(n) {
  state.page = n;
  $("pageInput").value = n;
  updateContextChips();
  if (curDoc()) store.set(`pagelight:page:${curDoc().docId}`, n);
}
function goToPage(n) {
  n = Math.max(1, Math.min(viewer.pagesCount || 1, n | 0));
  viewer.currentPageNumber = n;
}
function goTo(doc, page) {
  if (doc != null && doc !== state.cur && state.docs[doc]) return openDoc(doc, page);
  goToPage(page);
  return Promise.resolve();
}

// Resolves with the page's text layer once pdf.js has rendered it (or null after a timeout).
function textLayerFor(pageNumber, timeout = 6000) {
  const ready = () => {
    const div = viewer.getPageView?.(pageNumber - 1)?.textLayer?.div;
    return div && div.querySelector(".endOfContent") ? div : null;
  };
  return new Promise((resolve) => {
    const now = ready();
    if (now) return resolve(now);
    let timer;
    const done = (v) => { eventBus.off("textlayerrendered", on); clearTimeout(timer); resolve(v); };
    const on = (e) => { if (e.pageNumber === pageNumber && ready()) done(ready()); };
    eventBus.on("textlayerrendered", on);
    timer = setTimeout(() => done(ready()), timeout);
  });
}

// Jump to a citation and highlight the passage on that page that supports it.
let citeSeq = 0;
async function showCitation(doc, page, claim) {
  const seq = ++citeSeq;
  $("toast")?.classList.remove("show");
  await goTo(doc, page);
  const layer = await textLayerFor(page);
  if (seq !== citeSeq) return; // another citation was clicked meanwhile
  const found = layer && findPassage(layer, claim);
  if (!found?.segments.length || !flashPassage(found)) {
    flashPage(layer?.closest(".page") || container.querySelector(`.page[data-page-number="${page}"]`));
    toast(`Couldn't find the exact passage on page ${page}.`);
  }
}

let toastTimer;
function toast(text) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    $("viewerWrap").appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

async function openDoc(i, page = null) {
  const seq = ++loadSeq;
  const d = state.docs[i];
  state.cur = i;
  pendingPage = page;
  store.set(`pagelight:cur:${state.info.libraryId}`, i);
  $("viewerError").hidden = true;
  showDocHeader();
  buildToc(d.outline);
  $("findInput").value = ""; $("findCount").textContent = "";
  askPop.hidden = true; pendingSel = null;
  updateQuick();
  try {
    const task = pdfjsLib.getDocument({
      url: `/doc/${i}.pdf`,
      httpHeaders: { "X-Session-Token": TOKEN },
      cMapUrl: abs("/static/vendor/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: abs("/static/vendor/pdfjs/standard_fonts/"),
      wasmUrl: abs("/static/vendor/pdfjs/wasm/"),
      iccUrl: abs("/static/vendor/pdfjs/iccs/"),
      isEvalSupported: false,
      enableXfa: false,
      disableRange: true,
      disableStream: true,
    });
    const pdf = await task.promise;
    if (seq !== loadSeq) { dispose(pdf); return; } // user already switched again
    const old = pdfDoc;
    pdfDoc = pdf;
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    $("pageCount").textContent = pdf.numPages;
    if (old) dispose(old);
  } catch (e) {
    if (seq !== loadSeq) return;
    const el = $("viewerError");
    el.hidden = false;
    el.textContent = `Couldn't render ${d.file}: ${e.message || e}`;
  }
}

// toolbar
$("prevPage").onclick = () => viewer.previousPage();
$("nextPage").onclick = () => viewer.nextPage();
$("pageInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { goToPage(parseInt(e.target.value, 10)); container.focus(); }
});
$("pageInput").addEventListener("focus", (e) => e.target.select());
$("zoomIn").onclick = () => { viewer.increaseScale(); };
$("zoomOut").onclick = () => { viewer.decreaseScale(); };
$("zoomLabel").onclick = () => { viewer.currentScaleValue = "page-width"; };
$("nightBtn").onclick = (e) => {
  const on = document.body.classList.toggle("night");
  e.currentTarget.setAttribute("aria-pressed", on);
  store.set("pagelight:night", on);
};
if (store.get("pagelight:night", false)) { document.body.classList.add("night"); $("nightBtn").setAttribute("aria-pressed", "true"); }

let findTimer;
$("findInput").addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => dispatchFind("", false), 180);
});
$("findInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") dispatchFind("again", e.shiftKey);
  if (e.key === "Escape") { e.target.value = ""; dispatchFind("", false); container.focus(); }
});
function dispatchFind(type, findPrevious) {
  eventBus.dispatch("find", {
    source: null, type, query: $("findInput").value, caseSensitive: false, entireWord: false,
    highlightAll: true, findPrevious, matchDiacritics: false,
  });
}

// popovers: document switcher + contents
function closePopovers(except) {
  for (const id of ["docPanel", "tocPanel"]) if ($(id) !== except) $(id).hidden = true;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover") && !e.target.closest("#docBtn, #tocBtn")) closePopovers();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopovers(); });

function showDocHeader() {
  const d = curDoc();
  $("docTitle").textContent = d.title;
  $("docBtn").title = multi() ? `${d.title} — ${d.file}\nClick to switch PDF` : `${d.title} — ${d.file}`;
  $("docLabel").hidden = !multi();
  $("docLabel").textContent = d.label;
  document.title = `${d.title} · pagelight`;
  for (const b of $("docPanel").querySelectorAll("button")) b.setAttribute("aria-selected", +b.dataset.doc === state.cur);
  updateContextChips();
}

function buildDocList() {
  const btn = $("docBtn"), panel = $("docPanel");
  if (!multi()) return;
  btn.disabled = false;
  panel.innerHTML = "";
  for (const d of state.docs) {
    const b = document.createElement("button");
    b.dataset.doc = d.index;
    b.setAttribute("role", "option");
    b.innerHTML = `<span class="lbl"></span><span class="info"><span class="t"></span><span class="f"></span></span>`;
    b.querySelector(".lbl").textContent = d.label;
    b.querySelector(".t").textContent = d.title;
    b.querySelector(".f").textContent = `${d.file} · ${d.pages} pages`;
    if (d.scanned) b.querySelector(".f").insertAdjacentHTML("beforeend", ` · <span class="warn">no text layer</span>`);
    b.onclick = () => { panel.hidden = true; if (d.index !== state.cur) openDoc(d.index); };
    panel.appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); closePopovers(panel); panel.hidden = !panel.hidden; };
}

function buildToc(outline) {
  const btn = $("tocBtn"), panel = $("tocPanel");
  panel.innerHTML = "";
  panel.hidden = true;
  btn.hidden = !outline?.length;
  for (const item of outline || []) {
    const b = document.createElement("button");
    b.style.paddingLeft = `${8 + (item.level - 1) * 14}px`;
    b.innerHTML = `<span class="t"></span><span class="p">${item.page}</span>`;
    b.querySelector(".t").textContent = item.title;
    b.onclick = () => { goToPage(item.page); panel.hidden = true; };
    panel.appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); closePopovers(panel); panel.hidden = !panel.hidden; };
}

// ---------------------------------------------------------------- selection → ask
const askPop = $("askSelection");
let pendingSel = null;

function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const pageEl = node?.closest?.(".page");
  const page = pageEl ? parseInt(pageEl.dataset.pageNumber, 10) : state.page;
  return { text, page, doc: state.cur, rect: range.getBoundingClientRect() };
}

container.addEventListener("mouseup", () => setTimeout(() => {
  const s = readSelection();
  if (!s) { askPop.hidden = true; pendingSel = null; updateQuick(); return; }
  pendingSel = s;
  updateQuick();
  const wrap = $("viewerWrap").getBoundingClientRect();
  askPop.style.left = `${Math.min(Math.max(s.rect.left + s.rect.width / 2 - wrap.left, 70), wrap.width - 70)}px`;
  askPop.style.top = `${Math.max(s.rect.top - wrap.top - 40, 8)}px`;
  askPop.hidden = false;
}, 0));
container.addEventListener("scroll", () => { askPop.hidden = true; }, { passive: true });
askPop.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
askPop.onclick = () => {
  if (pendingSel) attachSelection(pendingSel);
  askPop.hidden = true;
  showChat(true);
  $("input").focus();
};

function attachSelection({ text, page, doc }) {
  state.selection = text.slice(0, 6000);
  state.selectionPage = page;
  state.selectionDoc = doc;
  const chip = $("selCtx");
  chip.hidden = false;
  chip.querySelector(".sel-text").textContent = `“${text.slice(0, 90)}${text.length > 90 ? "…" : ""}”`;
  chip.title = text.slice(0, 600);
  updateQuick();
}
function clearSelection() {
  state.selection = ""; state.selectionPage = null; state.selectionDoc = null;
  $("selCtx").hidden = true;
  updateQuick();
}
$("clearSel").onclick = clearSelection;
function updateQuick() {
  document.querySelectorAll("[data-needs-sel]").forEach((b) => { b.disabled = !state.selection && !pendingSel; });
}

// context row: which PDFs + which page
function updateContextChips() {
  if (!curDoc()) return;
  $("pageCtx").textContent = multi() ? `${curDoc().short} · p. ${state.page}` : `Page ${state.page}`;
  const sc = $("scopeChip");
  sc.hidden = !multi();
  sc.textContent = state.scope === "doc" ? `Only ${curDoc().label}` : `All ${state.docs.length} PDFs`;
}
$("scopeChip").onclick = () => {
  state.scope = state.scope === "doc" ? "all" : "doc";
  store.set(`pagelight:scope:${state.info.libraryId}`, state.scope);
  updateContextChips();
  $("input").focus();
};

// ---------------------------------------------------------------- chat
const msgsEl = $("messages");
const input = $("input");

function chatKey() { return `pagelight:chat:${state.info.libraryId}`; }
function save() { store.set(chatKey(), state.messages.slice(-60)); }

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function renderMessage(m) {
  if (m.role === "user") {
    const wrap = el("div", "msg user");
    if (m.selection) { const q = el("div", "quote"); q.textContent = `“${m.selection}”`; wrap.appendChild(q); }
    const b = el("div", "bubble"); b.textContent = m.content; wrap.appendChild(b);
    return wrap;
  }
  const wrap = el("div", `msg assistant${m.error ? " error" : ""}`);
  const body = el("div", "body");
  if (m.error) body.textContent = m.content;
  else body.innerHTML = render(m.content, renderCtx(m.meta?.doc ?? 0));
  wrap.appendChild(body);
  if (m.meta) wrap.appendChild(renderMeta(m.meta));
  return wrap;
}

function renderMeta(meta) {
  const d = el("div", "meta");
  const sources = meta.sources || [];
  if (sources.length) {
    const box = el("span", "pages");
    const docsUsed = [...new Set(sources.map(([di]) => di))];
    if (meta.mode === "full-document") {
      box.append(docsUsed.length > 1 ? `Read all ${docsUsed.length} documents` : "Read whole document");
    } else {
      box.append("Context:");
      let shown = 0;
      for (const di of docsUsed) {
        if (shown >= 16) break;
        const grp = el("span", "grp");
        if (multi()) {
          const dn = el("span", "dn");
          dn.textContent = state.docs[di]?.short ?? `D${di + 1}`;
          grp.appendChild(dn);
        }
        for (const [dj, p] of sources) {
          if (dj !== di || shown >= 16) continue;
          shown++;
          const b = el("button"); b.textContent = `p.${p}`; b.dataset.doc = di; b.dataset.page = p; grp.appendChild(b);
        }
        box.appendChild(grp);
      }
      if (sources.length > 16) box.append(` +${sources.length - 16} more`);
    }
    d.appendChild(box);
  }
  if (meta.tps) d.appendChild(el("span", null, `${meta.tokens} tok · ${meta.tps} tok/s`));
  return d;
}

function renderAll() {
  msgsEl.querySelectorAll(".msg").forEach((n) => n.remove());
  $("emptyState").hidden = state.messages.length > 0;
  for (const m of state.messages) msgsEl.appendChild(renderMessage(m));
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

msgsEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b) {
    const doc = b.dataset.doc != null ? parseInt(b.dataset.doc, 10) : null;
    const page = parseInt(b.dataset.page, 10);
    if (b.classList.contains("cite")) showCitation(doc, page, claimFor(b));
    else goTo(doc, page);
    return;
  }
  const s = e.target.closest("[data-q]");
  if (s) ask(s.dataset.q);
});
document.querySelectorAll(".quick-btn").forEach((b) => b.addEventListener("click", () => {
  if (b.hasAttribute("data-needs-sel") && !state.selection && pendingSel) attachSelection(pendingSel);
  ask(b.dataset.q);
}));

function autosize() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  if (e.key === "Escape" && state.busy) stop();
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) { stop(); return; }
  const q = input.value.trim();
  if (q) ask(q);
});
$("newChat").onclick = () => { if (state.busy) stop(); state.messages = []; save(); renderAll(); input.focus(); };

function stop() { state.abort?.abort(); }

function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle("busy", b);
  $("sendBtn").setAttribute("aria-label", b ? "Stop" : "Send");
}

async function ask(question) {
  if (state.busy || !state.info) return;
  const selection = state.selection;
  const doc = state.selection ? state.selectionDoc : state.cur;
  const page = state.selection ? state.selectionPage : state.page;
  const history = state.messages.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content }));

  state.messages.push({ role: "user", content: question, selection: selection ? selection.slice(0, 300) : undefined });
  const reply = { role: "assistant", content: "", meta: { doc } };
  state.messages.push(reply);
  input.value = ""; autosize();
  pendingSel = null; askPop.hidden = true;
  clearSelection();
  window.getSelection()?.removeAllRanges();
  renderAll();

  const node = msgsEl.lastElementChild;
  const body = node.querySelector(".body");
  body.innerHTML = `<span class="thinking">Reading</span>`;

  setBusy(true);
  state.abort = new AbortController();
  let raf = 0;
  const paint = () => {
    raf = 0;
    const stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
    body.innerHTML = render(reply.content, renderCtx(reply.meta.doc));
    body.classList.add("cursor");
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  };

  try {
    const res = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question, doc, page, selection, history, scope: state.scope }),
      signal: state.abort.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "meta") reply.meta = { sources: ev.sources, mode: ev.mode, multi: ev.multi, doc: ev.doc };
        else if (ev.type === "delta") { reply.content += ev.text; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === "done") Object.assign(reply.meta, { tokens: ev.tokens, tps: ev.tps });
        else if (ev.type === "error") { reply.error = true; reply.content = ev.message; }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") { reply.content += reply.content ? "\n\n_(stopped)_" : "_(stopped)_"; }
    else { reply.error = true; reply.content = `Couldn't reach the local server: ${e.message}`; }
  } finally {
    cancelAnimationFrame(raf);
    setBusy(false);
    state.abort = null;
    if (!reply.content && !reply.error) reply.content = "_(no answer)_";
    node.replaceWith(renderMessage(reply));
    msgsEl.scrollTop = msgsEl.scrollHeight;
    save();
  }
}

// ---------------------------------------------------------------- layout
function showChat(on) {
  document.body.classList.toggle("chat-hidden", !on);
  $("chatToggle").setAttribute("aria-pressed", on);
  store.set("pagelight:chat-open", on);
  requestAnimationFrame(() => { if (viewer.pagesCount) viewer.currentScaleValue = viewer.currentScaleValue; });
}
$("chatToggle").onclick = () => showChat(document.body.classList.contains("chat-hidden"));
showChat(store.get("pagelight:chat-open", true));

const savedW = store.get("pagelight:chat-w", null);
if (savedW) document.documentElement.style.setProperty("--chat-w", `${savedW}px`);
$("resizer").addEventListener("pointerdown", (e) => {
  const r = e.currentTarget; r.setPointerCapture(e.pointerId); r.classList.add("dragging");
  const move = (ev) => {
    const w = Math.max(300, Math.min(window.innerWidth * 0.7, window.innerWidth - ev.clientX));
    document.documentElement.style.setProperty("--chat-w", `${w}px`);
  };
  const up = () => {
    r.classList.remove("dragging"); r.removeEventListener("pointermove", move); r.removeEventListener("pointerup", up);
    store.set("pagelight:chat-w", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--chat-w"), 10));
    if (viewer.pagesCount) viewer.currentScaleValue = viewer.currentScaleValue;
  };
  r.addEventListener("pointermove", move); r.addEventListener("pointerup", up);
});

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("findInput").focus(); $("findInput").select(); return; }
  if (typing) return;
  if (e.key === "/") { e.preventDefault(); showChat(true); input.focus(); }
  else if (e.key === "ArrowRight" && !e.altKey) { viewer.nextPage(); }
  else if (e.key === "ArrowLeft" && !e.altKey) { viewer.previousPage(); }
  else if (multi() && (e.key === "]" || e.key === "[")) {
    const n = state.docs.length;
    openDoc((state.cur + (e.key === "]" ? 1 : n - 1)) % n);
  }
});

// ---------------------------------------------------------------- boot
function showStatus(info) {
  $("modelChip").textContent = info.model;
  $("modelChip").title = `${info.model} via ${info.backend}, context ${info.ctx} tokens`;
  const chip = $("searchChip");
  if (info.retrieval.startsWith("bm25 (")) {
    chip.textContent = `indexing ${Math.round((info.indexProgress || 0) * 100)}%`; chip.className = "chip"; chip.title = `Embedding with ${info.embedModel}`;
  } else if (info.indexError && info.retrieval !== "hybrid") {
    chip.textContent = "keyword search"; chip.className = "chip warn"; chip.title = `Embedding failed: ${info.indexError}`;
  } else {
    chip.textContent = info.retrieval === "hybrid" ? "semantic + keyword" : "keyword search";
    chip.className = info.indexError ? "chip warn" : "chip";
    chip.title = info.indexError ? `Some PDFs use keyword search only: ${info.indexError}`
      : info.embedModel ? `Embeddings: ${info.embedModel}` : "Pull an embedding model (e.g. nomic-embed-text) for semantic search";
  }
}

function setupEmptyState() {
  if (!multi()) return;
  $("input").placeholder = "Ask about these PDFs…  ( / to focus )";
  $("emptyTitle").textContent = `Ask anything about these ${state.docs.length} PDFs`;
  $("emptySub").textContent = "Answers search across every PDF and cite the file and page they came from. Switch PDFs from the title menu, or narrow answers to the one you're reading with the scope chip below.";
  const qs = [
    ["Summarize this page.", "Summarize this page"],
    ["What is each of these documents about? One or two lines each.", "What is each document about?"],
    ["Compare these documents: where do they agree and where do they differ?", "Compare the documents"],
    ["Explain the key terms and concepts on this page.", "Explain key terms here"],
  ];
  $("suggestions").innerHTML = "";
  for (const [q, label] of qs) {
    const b = el("button"); b.dataset.q = q; b.textContent = label; $("suggestions").appendChild(b);
  }
}

async function boot() {
  state.info = await (await api("/api/info")).json();
  state.docs = state.info.docs.map((d) => ({ ...d, short: shortName(d) }));
  state.scope = store.get(`pagelight:scope:${state.info.libraryId}`, "all");
  showStatus(state.info);
  buildDocList();
  setupEmptyState();
  state.messages = store.get(chatKey(), []);
  renderAll();
  updateQuick();
  const startDoc = Math.min(store.get(`pagelight:cur:${state.info.libraryId}`, 0), state.docs.length - 1);
  const startPage = state.info.startPage || null; // --page applies to the first PDF
  await openDoc(startPage ? 0 : startDoc, startPage);
  const poll = setInterval(async () => {
    if (!state.info.retrieval.startsWith("bm25 (")) return clearInterval(poll);
    try { state.info = await (await api("/api/info")).json(); showStatus(state.info); } catch {}
  }, 1500);
}

boot().catch((e) => {
  $("viewerError").hidden = false;
  $("viewerError").textContent = `Couldn't start: ${e.message}`;
});
