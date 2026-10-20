import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { render } from "./md.js";

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
  page: 1,
  selection: "",
  selectionPage: null,
  messages: [],
  busy: false,
  abort: null,
};

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

const zoomLabel = () => { $("zoomLabel").textContent = `${Math.round(viewer.currentScale * 100)}%`; };

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  const start = state.info.startPage || store.get(`pagelight:page:${state.info.docId}`, 1);
  if (start > 1 && start <= viewer.pagesCount) viewer.currentPageNumber = start;
  zoomLabel();
});
eventBus.on("scalechanging", zoomLabel);
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
  $("pageCtx").textContent = `Page ${n}`;
  if (state.info) store.set(`pagelight:page:${state.info.docId}`, n);
}
function goToPage(n) {
  n = Math.max(1, Math.min(viewer.pagesCount || 1, n | 0));
  viewer.currentPageNumber = n;
}

async function openPdf() {
  try {
    const task = pdfjsLib.getDocument({
      url: "/doc.pdf",
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
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    $("pageCount").textContent = pdf.numPages;
  } catch (e) {
    const el = $("viewerError");
    el.hidden = false;
    el.textContent = `Couldn't render this PDF: ${e.message || e}`;
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
$("findInput").addEventListener("input", (e) => {
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

// contents (outline from the server's parse)
function buildToc(outline) {
  if (!outline?.length) return;
  const btn = $("tocBtn"), panel = $("tocPanel");
  btn.hidden = false;
  for (const item of outline) {
    const b = document.createElement("button");
    b.style.paddingLeft = `${8 + (item.level - 1) * 14}px`;
    b.innerHTML = `<span class="t"></span><span class="p">${item.page}</span>`;
    b.querySelector(".t").textContent = item.title;
    b.onclick = () => { goToPage(item.page); panel.hidden = true; };
    panel.appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; };
  document.addEventListener("click", (e) => { if (!panel.contains(e.target)) panel.hidden = true; });
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
  return { text, page, rect: range.getBoundingClientRect() };
}

container.addEventListener("mouseup", () => setTimeout(() => {
  const s = readSelection();
  if (!s) { askPop.hidden = true; pendingSel = null; return; }
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
  if (pendingSel) attachSelection(pendingSel.text, pendingSel.page);
  askPop.hidden = true;
  showChat(true);
  $("input").focus();
};

function attachSelection(text, page) {
  state.selection = text.slice(0, 6000);
  state.selectionPage = page;
  const chip = $("selCtx");
  chip.hidden = false;
  chip.querySelector(".sel-text").textContent = `“${text.slice(0, 90)}${text.length > 90 ? "…" : ""}”`;
  chip.title = text.slice(0, 600);
  updateQuick();
}
function clearSelection() {
  state.selection = ""; state.selectionPage = null;
  $("selCtx").hidden = true;
  updateQuick();
}
$("clearSel").onclick = clearSelection;
function updateQuick() {
  document.querySelectorAll("[data-needs-sel]").forEach((b) => { b.disabled = !state.selection && !pendingSel; });
}

// ---------------------------------------------------------------- chat
const msgsEl = $("messages");
const input = $("input");

function chatKey() { return `pagelight:chat:${state.info.docId}`; }
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
  if (m.error) body.textContent = m.content; else body.innerHTML = render(m.content);
  wrap.appendChild(body);
  if (m.meta) wrap.appendChild(renderMeta(m.meta));
  return wrap;
}

function renderMeta(meta) {
  const d = el("div", "meta");
  if (meta.pages?.length) {
    const p = el("span", "pages");
    p.append(meta.mode === "full-document" ? "Read whole document" : "Context:");
    if (meta.mode !== "full-document") {
      for (const n of meta.pages.slice(0, 14)) {
        const b = el("button"); b.textContent = `p.${n}`; b.dataset.page = n; p.appendChild(b);
      }
      if (meta.pages.length > 14) p.append(` +${meta.pages.length - 14}`);
    }
    d.appendChild(p);
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
  if (b) { goToPage(parseInt(b.dataset.page, 10)); return; }
  const s = e.target.closest("[data-q]");
  if (s) ask(s.dataset.q);
});
document.querySelectorAll(".quick-btn").forEach((b) => b.addEventListener("click", () => {
  if (b.hasAttribute("data-needs-sel") && !state.selection && pendingSel) attachSelection(pendingSel.text, pendingSel.page);
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
  const page = state.selectionPage || state.page;
  const history = state.messages.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content }));

  state.messages.push({ role: "user", content: question, selection: selection ? selection.slice(0, 300) : undefined });
  const reply = { role: "assistant", content: "" };
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
    body.innerHTML = render(reply.content);
    body.classList.add("cursor");
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  };

  try {
    const res = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question, page, selection, history }),
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
        if (ev.type === "meta") reply.meta = { pages: ev.pages, mode: ev.mode };
        else if (ev.type === "delta") { reply.content += ev.text; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === "done") Object.assign(reply.meta ||= {}, { tokens: ev.tokens, tps: ev.tps });
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
});

// ---------------------------------------------------------------- boot
function showInfo(info) {
  $("docTitle").textContent = info.title;
  $("docTitle").title = `${info.title} — ${info.file}`;
  document.title = `${info.title} · pagelight`;
  $("modelChip").textContent = info.model;
  $("modelChip").title = `${info.model} via ${info.backend}, context ${info.ctx} tokens`;
  const chip = $("searchChip");
  if (info.indexError) {
    chip.textContent = "keyword search"; chip.className = "chip warn"; chip.title = `Embedding failed: ${info.indexError}`;
  } else if (info.retrieval.startsWith("bm25 (")) {
    chip.textContent = `indexing ${Math.round((info.indexProgress || 0) * 100)}%`; chip.className = "chip"; chip.title = `Embedding with ${info.embedModel}`;
  } else {
    chip.textContent = info.retrieval === "hybrid" ? "semantic + keyword" : "keyword search";
    chip.className = "chip"; chip.title = info.embedModel ? `Embeddings: ${info.embedModel}` : "Pull an embedding model (e.g. nomic-embed-text) for semantic search";
  }
}

async function boot() {
  state.info = await (await api("/api/info")).json();
  showInfo(state.info);
  buildToc(state.info.outline);
  state.messages = store.get(chatKey(), []);
  renderAll();
  updateQuick();
  await openPdf();
  const poll = setInterval(async () => {
    if (!state.info.retrieval.startsWith("bm25 (")) return clearInterval(poll);
    try { state.info = await (await api("/api/info")).json(); showInfo(state.info); } catch {}
  }, 1500);
}

boot().catch((e) => {
  $("viewerError").hidden = false;
  $("viewerError").textContent = `Couldn't start: ${e.message}`;
});
