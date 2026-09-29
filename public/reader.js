// Reader: fetches the book from its source (directly, or through the optional proxy) and renders it in the browser.
const $ = (s) => document.querySelector(s);
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/";
const JSZIP = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const EPUBJS = "https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js";

const params = new URLSearchParams(location.search);
const id = Number(params.get("id"));
const token = (() => { try { return localStorage.getItem("stacks.token") || ""; } catch { return ""; } })();
const auth = token ? { authorization: `Bearer ${token}` } : {};

function say(msg) { const s = $("#status"); s.textContent = msg; s.hidden = !msg; }
function notice(msg, link) {
  const n = $("#notice");
  n.textContent = msg + " ";
  if (link) { const a = document.createElement("a"); a.href = link.href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = link.text; n.append(a); }
  n.hidden = false;
}
function script(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load the reader library."));
    document.head.append(s);
  });
}
function store(key, val) { try { val === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch { /* ignore */ } }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

async function main() {
  if (!id) return say("No book was chosen. Go back to the library and pick one.");
  const cfg = await (await fetch("/api/config")).json();
  const res = await fetch(`/api/books/${id}`, { headers: auth });
  if (!res.ok) return say(res.status === 401 ? "Sign in on the library page first." : "That book wasn't found.");
  const book = await res.json();
  document.title = `${book.title} · Stacks`;
  $("#title").textContent = book.title;

  const src = { href: book.url, text: "Open the source in a new tab." };
  const host = new URL(book.url).hostname;
  const proxied = (cfg.proxyHosts || []).includes(host);
  const viaCors = cfg.corsProxy ? `${cfg.corsProxy}?url=${encodeURIComponent(book.url)}` : "";

  async function get(kind) {
    const r = kind === "own"
      ? await fetch(`/api/proxy?url=${encodeURIComponent(book.url)}`, { headers: auth })
      : kind === "cors"
        ? await fetch(viaCors)
        : await fetch(book.url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) throw new Error(`The source answered ${r.status}.`);
    return r.arrayBuffer();
  }

  // Order: our own proxy for allowlisted hosts, direct if the source allows it, then the CORS proxy.
  const order = proxied ? ["own"] : book.cors_ok === false ? [] : ["direct"];
  if (viaCors) order.push("cors");
  if (!order.length) {
    say("");
    return notice("This source doesn't allow reading in another site's page, so it can't open here.", src);
  }

  say("Downloading the book…");
  let buf, lastErr;
  for (const kind of order) {
    try { buf = await get(kind); break; } catch (e) { lastErr = e; }
  }
  if (!buf) {
    say("");
    return notice(`Couldn't fetch the file (${lastErr.message}). Many hosts block reading from other sites.`, src);
  }

  say("");
  if (book.format === "pdf") await pdf(buf, book);
  else if (book.format === "epub") await epub(buf, book);
  else notice("This format can't be read in the browser.", src);

  if (book.status === "unread") {
    fetch(`/api/books/${id}`, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ status: "reading" }) }).catch(() => {});
  }
}

async function pdf(buf, book) {
  await script(`${PDFJS}pdf.min.js`);
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
  const doc = await lib.getDocument({ data: buf }).promise;
  $("#pdf-tools").hidden = false; $("#pdf-stage").hidden = false;
  $("#pages").textContent = `of ${doc.numPages}`;
  $("#page").max = doc.numPages;

  const key = `stacks.pdf.${book.id}`;
  let page = Math.min(doc.numPages, Math.max(1, Number(recall(key)) || 1));
  let scale = 0; // 0 = fit width
  let token = 0;

  async function show() {
    const mine = ++token;
    const p = await doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    const s = scale || Math.min(3, ($("#pdf-stage").clientWidth - 40) / base.width);
    const vp = p.getViewport({ scale: s });
    const canvas = document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
    canvas.style.width = `${Math.floor(vp.width)}px`; canvas.style.height = `${Math.floor(vp.height)}px`;
    await p.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
    if (mine !== token) return;
    $("#pdf-pages").replaceChildren(canvas);
    $("#page").value = page;
    $("#pdf-stage").scrollTop = 0;
    store(key, page);
  }
  const go = (n) => { page = Math.min(doc.numPages, Math.max(1, n)); show(); };
  $("#prev").onclick = () => go(page - 1);
  $("#next").onclick = () => go(page + 1);
  $("#page").onchange = (e) => go(Number(e.target.value) || 1);
  $("#zoom-in").onclick = () => { scale = (scale || 1) * 1.2; show(); };
  $("#zoom-out").onclick = () => { scale = (scale || 1) / 1.2; show(); };
  $("#fit").onclick = () => { scale = 0; show(); };
  document.addEventListener("keydown", (e) => {
    if (/^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") go(page + 1);
    if (e.key === "ArrowLeft" || e.key === "PageUp") go(page - 1);
  });
  window.addEventListener("resize", () => { if (!scale) show(); });
  await show();
}

async function epub(buf, book) {
  await script(JSZIP);
  await script(EPUBJS);
  $("#epub-tools").hidden = false; $("#epub-stage").hidden = false;
  const stage = $("#epub-stage");
  stage.style.height = "calc(100dvh - 120px)";
  const b = window.ePub(buf);
  const rendition = b.renderTo("epub-view", { width: "100%", height: "100%", flow: "paginated", spread: "none" });
  const key = `stacks.epub.${book.id}`;
  let size = Number(recall(`${key}.size`)) || 100;
  const apply = () => rendition.themes.fontSize(`${size}%`);
  apply();
  await rendition.display(recall(key) || undefined);
  rendition.on("relocated", (loc) => store(key, loc.start.cfi));

  const nav = await b.loaded.navigation;
  const toc = $("#toc");
  toc.append(new Option("Chapters", ""));
  for (const item of nav.toc) toc.append(new Option(item.label.trim(), item.href));
  toc.onchange = () => toc.value && rendition.display(toc.value);
  $("#e-prev").onclick = () => rendition.prev();
  $("#e-next").onclick = () => rendition.next();
  $("#f-up").onclick = () => { size = Math.min(220, size + 10); store(`${key}.size`, size); apply(); };
  $("#f-down").onclick = () => { size = Math.max(70, size - 10); store(`${key}.size`, size); apply(); };
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight") rendition.next();
    if (e.key === "ArrowLeft") rendition.prev();
  });
}

main().catch((e) => { say(""); notice(`Something went wrong: ${e.message}`); });
