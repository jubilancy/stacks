// Stacks front end. Plain ES module, no build step.
// DOM is built with h() and textContent, never innerHTML, so book data can't inject markup.

const $ = (sel, root = document) => root.querySelector(sel);
const TOKEN_KEY = "stacks.token";
const VIEW_KEY = "stacks.view";
const PAGE = 120;

const state = {
  config: { publicRead: false, writable: false, proxyHosts: [], formats: [] },
  admin: false,
  canRead: false,
  view: "shelf",
  q: "",
  sort: "",
  filters: { tag: "", format: "", status: "", link: "", favorite: "", series: "" },
  items: [],
  total: 0,
  loading: false,
  editing: null, // book being edited, or null when adding
  loadToken: 0,
};

/* ---------- helpers ---------- */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
};
const setToken = (t) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

const SPINES = [
  ["#7d2233", "#fbeef0"], ["#2f7069", "#eefaf7"], ["#c8973a", "#20160a"], ["#5c2b73", "#f6ecfb"],
  ["#26407f", "#eef2ff"], ["#37552f", "#f0f8ec"], ["#a8506b", "#fff0f4"], ["#3a3748", "#f0eef8"],
];

function look(book) {
  const n = hash(book.title + book.id);
  const [bg, fg] = SPINES[n % SPINES.length];
  const len = Math.min(book.title.length, 34);
  const height = Math.min(214, 132 + len * 2.4 + (n >> 9) % 14);
  return { bg, fg, width: (len > 16 ? 50 : 40) + (n >> 4) % 14, height: Math.round(height) };
}

function fmtSize(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = b;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

const isReadable = (b) => b.format === "pdf" || b.format === "epub";
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const readerHref = (b) => `/reader.html?id=${b.id}`;

/* ---------- loading ---------- */

function query(offset) {
  const p = new URLSearchParams({ limit: PAGE, offset });
  if (state.q) p.set("q", state.q);
  if (state.sort) p.set("sort", state.sort);
  for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
  return p;
}

async function load(reset = true) {
  const mine = ++state.loadToken;
  state.loading = true;
  try {
    const data = await api(`/api/books?${query(reset ? 0 : state.items.length)}`);
    if (mine !== state.loadToken) return;
    state.items = reset ? data.items : state.items.concat(data.items);
    state.total = data.total;
    render();
  } catch (e) {
    if (mine !== state.loadToken) return;
    if (e.status === 401) { showLocked(); return; }
    $("#content").replaceChildren(h("p", { class: "form-error", text: e.message }));
  } finally {
    state.loading = false;
  }
}

async function loadIndex() {
  if (!state.canRead) { $("#index").replaceChildren(); return; }
  try {
    const [stats, tags] = await Promise.all([api("/api/stats"), api("/api/tags")]);
    renderIndex(stats, tags.tags);
  } catch { /* the shelf still works without the sidebar */ }
}

/* ---------- rendering ---------- */

function activeFilterCount() {
  return Object.values(state.filters).filter(Boolean).length + (state.q ? 1 : 0);
}

function clearAll() {
  state.q = "";
  $("#q").value = "";
  for (const k of Object.keys(state.filters)) state.filters[k] = "";
  load();
  loadIndex();
}

function render() {
  const box = $("#content");
  const n = state.total;
  const s = $("#summary");
  s.replaceChildren(`${n} ${n === 1 ? "book" : "books"}`);
  if (activeFilterCount()) {
    s.append(" match. ", h("button", { type: "button", onclick: clearAll, text: "Clear filters" }));
  }

  if (!state.items.length) {
    box.replaceChildren(emptyState());
  } else if (state.view === "list") {
    box.replaceChildren(h("ul", { class: "list" }, state.items.map(listRow)));
  } else if (state.view === "covers") {
    box.replaceChildren(h("div", { class: "covers" }, state.items.map(coverCard)));
  } else {
    box.replaceChildren(h("div", { class: "shelf" }, state.items.map(spine)));
  }
  $("#more").hidden = state.items.length >= state.total;
  for (const b of document.querySelectorAll(".view-btn")) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
}

function emptyState() {
  if (activeFilterCount()) {
    return h("div", { class: "empty" },
      h("h2", { text: "Nothing on this shelf" }),
      h("p", { text: "No books match the search and filters you picked." }),
      h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: clearAll, text: "Clear filters" })));
  }
  return h("div", { class: "empty" },
    h("h2", { text: "Your shelf is empty" }),
    h("p", { text: "Stacks keeps links to books, not the books themselves. Add a web address to a PDF or ebook and it appears here." }),
    state.admin
      ? h("div", { class: "row" },
          h("button", { class: "btn btn-primary", type: "button", onclick: () => openBook(null), text: "Add a book" }),
          h("button", { class: "btn", type: "button", onclick: openImport, text: "Import a list" }))
      : null);
}

function spine(b) {
  const l = look(b);
  return h("div", { class: "slot" },
    h("button", {
      class: "spine", type: "button",
      style: `--spine-bg:${l.bg};--spine-fg:${l.fg};width:${l.width}px;height:${l.height}px`,
      "data-status": b.status, "data-fav": b.favorite ? "1" : "0", "data-link": b.link_status,
      "aria-label": `${b.title}${b.author ? ", " + b.author : ""}`,
      title: `${b.title}${b.author ? " — " + b.author : ""}`,
      onclick: () => openBook(b),
    },
      h("span", { class: "spine-title", text: b.title }),
      h("span", { class: "spine-format", text: b.format })));
}

function coverImg(b, cls) {
  const l = look(b);
  if (b.cover_url) {
    const img = h("img", { src: b.cover_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.replaceWith(fallbackCover(b, l)));
    return img;
  }
  return fallbackCover(b, l);
}

function fallbackCover(b, l = look(b)) {
  return h("div", { class: "fallback-cover", style: `background:${l.bg};color:${l.fg}` },
    h("span", { text: b.title }), h("small", { text: b.author || b.format }));
}

function coverCard(b) {
  const l = look(b);
  return h("button", { class: "cover-card", type: "button", onclick: () => openBook(b) },
    h("span", { class: "cover-frame", style: `--spine-bg:${l.bg};--spine-fg:${l.fg}` },
      coverImg(b),
      b.link_status === "dead" ? h("span", { class: "cover-flag", text: "Link broken" }) : null),
    h("span", { class: "cover-title", text: b.title }),
    b.author ? h("span", { class: "cover-author", text: b.author }) : null);
}

function listRow(b) {
  const status = { unread: "Unread", reading: "Reading", read: "Read" }[b.status];
  return h("li", {},
    h("button", { class: "row-btn", type: "button", onclick: () => openBook(b) },
      h("span", { class: "row-title" }, b.title, b.link_status === "dead" ? h("span", { class: "tag-dead", text: "Link broken" }) : null),
      h("span", { class: "row-meta author-col", text: b.author || "" }),
      h("span", { class: "row-meta", text: b.format }),
      h("span", { class: "row-meta status-col", text: status })));
}

function indexButton(label, n, group, value) {
  const on = state.filters[group] === value;
  return h("li", {},
    h("button", {
      class: "index-btn", type: "button", "aria-pressed": String(on),
      onclick: () => { state.filters[group] = on ? "" : value; load(); loadIndex(); },
    }, h("span", { text: label }), n !== undefined ? h("span", { class: "n", text: n }) : null));
}

function renderIndex(stats, tags) {
  const groups = [];
  const st = { unread: "Unread", reading: "Reading", read: "Read" };
  groups.push(section("Shelves", [
    ...(stats.favorites ? [indexButton("Favorites", stats.favorites, "favorite", "1")] : []),
    ...stats.statuses.map((s) => indexButton(st[s.k] || s.k, s.n, "status", s.k)),
    ...(stats.dead ? [indexButton("Broken links", stats.dead, "link", "dead")] : []),
  ]));
  groups.push(section("Formats", stats.formats.map((f) => indexButton(f.k, f.n, "format", f.k))));
  if (tags.length) groups.push(section("Tags", tags.slice(0, 40).map((t) => indexButton(t.tag, t.n, "tag", t.tag))));
  $("#index").replaceChildren(...groups.filter(Boolean));
}

function section(title, items) {
  if (!items.length) return null;
  return h("div", { class: "index-group" }, h("h3", { text: title }), h("ul", { class: "index-list" }, items));
}

/* ---------- access ---------- */

function showLocked() {
  state.items = []; state.total = 0;
  $("#summary").textContent = "";
  $("#more").hidden = true;
  $("#content").replaceChildren(h("div", { class: "empty" },
    h("h2", { text: "This library is private" }),
    h("p", { text: "Enter your access token to see the books." }),
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "button", onclick: openLogin, text: "Sign in" }))));
}

function applyAccess() {
  $("#btn-add").hidden = !state.admin;
  $("#btn-import").hidden = !state.admin;
  $("#btn-menu").hidden = !state.canRead;
  $("#btn-signin").hidden = state.admin || !state.config.writable;
  buildMenu();
}

function buildMenu() {
  const items = [];
  const item = (label, fn) => items.push(h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); fn(); }, text: label }));
  if (state.admin) {
    item("Match missing covers", matchCovers);
    item("Check links on this page", checkPage);
  }
  item("Export as JSON", () => download("json"));
  item("Export as CSV", () => download("csv"));
  if (state.admin) item("Sign out", signOut);
  $("#menu").replaceChildren(...items);
}

function closeMenu() { $("#menu").hidden = true; $("#btn-menu").setAttribute("aria-expanded", "false"); }

async function refreshSession() {
  state.config = await api("/api/config");
  try {
    const s = await api("/api/session");
    state.admin = s.admin; state.canRead = s.canRead;
  } catch { state.admin = false; state.canRead = state.config.publicRead; }
  applyAccess();
  if (!state.canRead) { showLocked(); $("#btn-signin").hidden = false; return; }
  await Promise.all([load(), loadIndex()]);
}

function signOut() {
  setToken("");
  refreshSession();
}

async function download(format) {
  try {
    const headers = getToken() ? { authorization: `Bearer ${getToken()}` } : {};
    const res = await fetch(`/api/export?format=${format}`, { headers });
    if (!res.ok) throw new Error("Export failed.");
    const url = URL.createObjectURL(await res.blob());
    const a = h("a", { href: url, download: `stacks-${new Date().toISOString().slice(0, 10)}.${format}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { toast(e.message); }
}

/* ---------- login ---------- */

function openLogin() {
  $("#login-token").value = "";
  $("#login-error").hidden = true;
  $("#dlg-login").showModal();
  $("#login-token").focus();
}

async function submitLogin(e) {
  e.preventDefault();
  const t = $("#login-token").value.trim();
  if (!t) return;
  setToken(t);
  try {
    const s = await api("/api/session");
    if (!s.admin) throw new Error("That token wasn't accepted.");
    $("#dlg-login").close();
    await refreshSession();
    toast("Signed in.");
  } catch (err) {
    setToken("");
    const box = $("#login-error");
    box.textContent = err.message; box.hidden = false;
  }
}

/* ---------- book dialog ---------- */

const bookForm = () => $("#book-form");
const fieldsOf = () => bookForm().elements;

function fillFormats() {
  const sel = fieldsOf().format;
  if (sel.options.length) return;
  for (const f of ["", ...(state.config.formats || [])]) sel.append(h("option", { value: f, text: f || "Detect automatically" }));
}

function openBook(book) {
  state.editing = book;
  fillFormats();
  const f = fieldsOf();
  const admin = state.admin;
  $("#book-heading").textContent = book ? book.title : "Add book";
  $("#btn-save").textContent = book ? "Save changes" : "Add to library";
  $("#btn-save").hidden = !admin;
  $("#btn-delete").hidden = !(admin && book);
  $("#btn-probe").hidden = !admin;
  $("#lookup").hidden = !admin;
  $("#book-fields").disabled = !admin;
  $("#book-error").hidden = true;
  $("#probe-result").textContent = "";
  $("#lookup-results").replaceChildren();
  $("#lookup-msg").textContent = "";
  $("#lookup").open = false;

  const v = book || { url: "", title: "", author: "", series: "", series_index: null, format: "", year: null, isbn: "", language: "", publisher: "", cover_url: "", tags: [], description: "", notes: "", status: "unread", rating: 0, favorite: false };
  f.url.value = v.url; f.title.value = v.title; f.author.value = v.author || ""; f.series.value = v.series || "";
  f.series_index.value = v.series_index ?? ""; f.format.value = book ? v.format : ""; f.year.value = v.year ?? "";
  f.isbn.value = v.isbn || ""; f.language.value = v.language || ""; f.publisher.value = v.publisher || "";
  f.cover_url.value = v.cover_url || ""; f.tags.value = (v.tags || []).join(", ");
  f.description.value = v.description || ""; f.notes.value = v.notes || "";
  f.status.value = v.status; f.rating.value = String(v.rating || 0); f.favorite.checked = !!v.favorite;
  $("#lookup-q").value = book ? [book.title, book.author].filter(Boolean).join(" ") : "";

  renderBookSide(book);
  $("#dlg-book").showModal();
  if (!book && admin) f.url.focus();
}

function renderBookSide(book) {
  const cover = $("#book-cover");
  const acts = $("#book-actions");
  const info = $("#link-info");
  cover.replaceChildren(book ? coverImg(book) : h("div", { class: "fallback-cover", style: "background:var(--panel-2);color:var(--ink-soft)" }, h("span", { text: "No cover yet" })));
  acts.replaceChildren();
  info.replaceChildren();
  if (!book) return;

  if (isReadable(book)) acts.append(h("a", { class: "btn btn-primary", href: readerHref(book), text: "Read here" }));
  acts.append(h("a", { class: "btn", href: book.url, target: "_blank", rel: "noopener noreferrer", text: "Open the source" }));
  if (book.archive_url) acts.append(h("a", { class: "btn", href: book.archive_url, target: "_blank", rel: "noopener noreferrer", text: "Open archived copy" }));
  if (state.admin) {
    acts.append(h("button", { class: "btn", type: "button", onclick: checkOne, text: "Check link now" }));
    if (book.link_status === "dead" && !book.archive_url) acts.append(h("button", { class: "btn", type: "button", onclick: findArchive, text: "Find an archived copy" }));
  }

  const label = { ok: "Link works", dead: "Link is broken", unknown: "Not checked yet" }[book.link_status];
  info.append(h("span", { class: `state-${book.link_status}`, text: label }));
  info.append(h("span", { text: hostOf(book.url) }));
  if (book.size_bytes) info.append(h("span", { text: `Size ${fmtSize(book.size_bytes)}` }));
  if (book.cors_ok === false && isReadable(book)) info.append(h("span", { text: "The source blocks in-browser reading. Use “Open the source”." }));
  if (book.link_checked_at) info.append(h("span", { text: `Checked ${book.link_checked_at.slice(0, 10)}` }));
}

function replaceInState(updated) {
  const i = state.items.findIndex((x) => x.id === updated.id);
  if (i >= 0) state.items[i] = updated;
  state.editing = updated;
  render();
}

async function checkOne() {
  const b = state.editing;
  try {
    toast("Checking the link…");
    const updated = await api(`/api/books/${b.id}/check`, { method: "POST" });
    replaceInState(updated);
    renderBookSide(updated);
    loadIndex();
  } catch (e) { toast(e.message); }
}

async function findArchive() {
  const b = state.editing;
  try {
    toast("Looking in the Wayback Machine…");
    const r = await api(`/api/books/${b.id}/archive`, { method: "POST" });
    if (!r.archive_url) { toast("No archived copy was found."); return; }
    replaceInState(r.book);
    renderBookSide(r.book);
  } catch (e) { toast(e.message); }
}

function formBody() {
  const f = fieldsOf();
  const num = (x) => (x.value === "" ? null : Number(x.value));
  const body = {
    url: f.url.value.trim(), title: f.title.value.trim(), author: f.author.value.trim(),
    series: f.series.value.trim(), series_index: num(f.series_index), year: num(f.year),
    isbn: f.isbn.value.trim(), language: f.language.value.trim(), publisher: f.publisher.value.trim(),
    cover_url: f.cover_url.value.trim(), tags: f.tags.value, description: f.description.value,
    notes: f.notes.value, status: f.status.value, rating: Number(f.rating.value), favorite: f.favorite.checked,
  };
  if (f.format.value) body.format = f.format.value;
  if (!body.title) delete body.title; // let the server guess from the file name
  return body;
}

async function saveBook(e) {
  e.preventDefault();
  const err = $("#book-error");
  err.hidden = true;
  const body = formBody();
  if (!body.url) { err.textContent = "Add the web address of the book."; err.hidden = false; return; }
  const btn = $("#btn-save");
  btn.disabled = true;
  try {
    if (state.editing) await api(`/api/books/${state.editing.id}`, { method: "PATCH", body });
    else await api("/api/books", { method: "POST", body });
    $("#dlg-book").close();
    toast(state.editing ? "Saved." : "Added to your library.");
    await Promise.all([load(), loadIndex()]);
  } catch (e2) {
    err.textContent = e2.message; err.hidden = false;
  } finally { btn.disabled = false; }
}

async function deleteBook() {
  const b = state.editing;
  if (!b || !confirm(`Remove “${b.title}” from your library? The file at its source is not touched.`)) return;
  try {
    await api(`/api/books/${b.id}`, { method: "DELETE" });
    $("#dlg-book").close();
    toast("Removed.");
    await Promise.all([load(), loadIndex()]);
  } catch (e) { const err = $("#book-error"); err.textContent = e.message; err.hidden = false; }
}

async function probe() {
  const f = fieldsOf();
  const out = $("#probe-result");
  const url = f.url.value.trim();
  if (!url) { out.textContent = "Add a web address first."; return; }
  out.textContent = "Checking…";
  try {
    const r = await api(`/api/probe?url=${encodeURIComponent(url)}`);
    if (!r.ok) { out.textContent = r.error || `The source answered ${r.status}.`; return; }
    if (!f.title.value.trim() && r.title) f.title.value = r.title;
    if (!f.format.value && r.format) f.format.value = r.format;
    const bits = ["Link works"];
    if (r.size) bits.push(fmtSize(r.size));
    if (r.format) bits.push(r.format);
    bits.push(r.corsOk === false ? "the source blocks in-browser reading" : r.corsOk ? "can be read here" : "");
    out.textContent = bits.filter(Boolean).join(", ") + ".";
  } catch (e) { out.textContent = e.message; }
}

function candidateApply(c) {
  const f = fieldsOf();
  const set = (el, v) => { if (v !== "" && v !== null && v !== undefined) el.value = v; };
  set(f.title, c.title); set(f.author, c.author); set(f.year, c.year); set(f.isbn, c.isbn);
  set(f.publisher, c.publisher); set(f.language, c.language); set(f.cover_url, c.cover_url);
  if (!f.tags.value.trim() && c.subjects.length) f.tags.value = c.subjects.slice(0, 5).join(", ");
  $("#lookup-msg").textContent = "Details filled in. Review them, then save.";
  if (c.cover_url) $("#book-cover").replaceChildren(h("img", { src: c.cover_url, alt: "", referrerpolicy: "no-referrer" }));
}

async function lookup() {
  const q = $("#lookup-q").value.trim();
  const msg = $("#lookup-msg");
  const list = $("#lookup-results");
  list.replaceChildren();
  if (!q) { msg.textContent = "Enter a title, author or ISBN."; return; }
  msg.textContent = "Searching…";
  try {
    const { candidates } = await api(`/api/lookup?q=${encodeURIComponent(q)}`);
    msg.textContent = candidates.length ? "Pick the closest match." : "Nothing found. Try fewer words.";
    for (const c of candidates) {
      list.append(h("li", {},
        h("button", { class: "candidate", type: "button", onclick: () => candidateApply(c) },
          c.cover_url ? h("img", { src: c.cover_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "noimg" }),
          h("span", {}, h("strong", { text: c.title }), h("span", { text: [c.author, c.year].filter(Boolean).join(", ") })))));
    }
  } catch (e) { msg.textContent = e.message; }
}

/* ---------- bulk actions ---------- */

async function matchCovers() {
  const targets = state.items.filter((b) => !b.cover_url);
  if (!targets.length) { toast("Every book on this page already has a cover."); return; }
  let done = 0, matched = 0;
  for (const b of targets) {
    toast(`Matching covers… ${done + 1} of ${targets.length}`);
    try {
      const { candidates } = await api(`/api/lookup?q=${encodeURIComponent([b.title, b.author].filter(Boolean).join(" "))}`);
      const c = candidates.find((x) => x.cover_url);
      if (c) {
        const body = { cover_url: c.cover_url };
        if (!b.author && c.author) body.author = c.author;
        if (!b.year && c.year) body.year = c.year;
        if (!b.isbn && c.isbn) body.isbn = c.isbn;
        await api(`/api/books/${b.id}`, { method: "PATCH", body });
        matched++;
      }
    } catch { /* skip and move on */ }
    done++;
    await new Promise((r) => setTimeout(r, 250));
  }
  toast(`Matched ${matched} of ${targets.length}. Check them, since matches are guesses.`);
  load();
}

async function checkPage() {
  const targets = state.items.slice(0, 40);
  if (!targets.length) return;
  let dead = 0;
  for (let i = 0; i < targets.length; i++) {
    toast(`Checking links… ${i + 1} of ${targets.length}`);
    try {
      const u = await api(`/api/books/${targets[i].id}/check`, { method: "POST" });
      if (u.link_status === "dead") dead++;
    } catch { /* skip */ }
  }
  toast(dead ? `${dead} broken ${dead === 1 ? "link" : "links"} found.` : "All checked links work.");
  load(); loadIndex();
}

/* ---------- import ---------- */

function openImport() {
  $("#import-urls").value = ""; $("#import-file").value = ""; $("#import-tags").value = "";
  $("#import-result").textContent = ""; $("#import-progress").hidden = true;
  $("#dlg-import").showModal();
  $("#import-urls").focus();
}

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = ""; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...rest] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  const keys = head.map((k) => k.trim().toLowerCase());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").replace(/^'(?=[=+\-@])/, "")])));
}

function itemsFromText(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bar = line.lastIndexOf("|");
    if (bar > 0) items.push({ title: line.slice(0, bar).trim(), url: line.slice(bar + 1).trim() });
    else items.push({ url: line });
  }
  return items;
}

async function runImport(e) {
  e.preventDefault();
  const out = $("#import-result");
  const btn = $("#btn-run-import");
  let items = itemsFromText($("#import-urls").value);
  const file = $("#import-file").files[0];
  try {
    if (file) {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        const data = JSON.parse(text);
        items = items.concat(Array.isArray(data) ? data : data.books || []);
      } else items = items.concat(parseCsv(text));
    }
  } catch { out.textContent = "That file could not be read. Use a CSV or a JSON export from Stacks."; return; }

  items = items.filter((i) => i && i.url);
  if (!items.length) { out.textContent = "Add at least one web address."; return; }
  const extra = $("#import-tags").value.trim();
  items = items.map((i) => {
    const clean = {};
    for (const k of ["url", "title", "author", "series", "series_index", "format", "year", "isbn", "language", "publisher", "cover_url", "description", "notes", "status", "rating", "favorite"]) {
      if (i[k] !== undefined && i[k] !== "" && i[k] !== null) clean[k] = i[k];
    }
    const tags = [Array.isArray(i.tags) ? i.tags.join(",") : i.tags, extra].filter(Boolean).join(",");
    if (tags) clean.tags = tags;
    return clean;
  });

  btn.disabled = true;
  const bar = $("#import-progress");
  bar.hidden = false; bar.max = items.length; bar.value = 0;
  let added = 0, skipped = 0, invalid = 0;
  try {
    for (let i = 0; i < items.length; i += 100) {
      const r = await api("/api/import", { method: "POST", body: { items: items.slice(i, i + 100) } });
      added += r.added; skipped += r.skipped; invalid += r.invalid.length;
      bar.value = Math.min(items.length, i + 100);
    }
    out.textContent = `Added ${added}. Already in your library: ${skipped}. Not valid: ${invalid}.`;
    await Promise.all([load(), loadIndex()]);
  } catch (err) { out.textContent = err.message; }
  finally { btn.disabled = false; }
}

/* ---------- wiring ---------- */

function init() {
  try { state.view = localStorage.getItem(VIEW_KEY) || "shelf"; } catch { /* ignore */ }

  const narrow = matchMedia("(max-width: 860px)");
  if (narrow.matches) $("#filters").open = false;

  $("#search-form").addEventListener("submit", (e) => e.preventDefault());
  $("#q").addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); load(); }, 250));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) {
      e.preventDefault(); $("#q").focus();
    }
  });

  for (const b of document.querySelectorAll(".view-btn")) {
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* ignore */ }
      render();
    });
  }
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; load(); });
  $("#more").addEventListener("click", () => load(false));

  $("#btn-add").addEventListener("click", () => openBook(null));
  $("#btn-import").addEventListener("click", openImport);
  $("#btn-signin").addEventListener("click", openLogin);
  $("#btn-menu").addEventListener("click", () => {
    const m = $("#menu");
    m.hidden = !m.hidden;
    $("#btn-menu").setAttribute("aria-expanded", String(!m.hidden));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => {
      if (e.target === d || e.target.closest("[data-close]")) d.close();
    });
  }

  $("#book-form").addEventListener("submit", saveBook);
  $("#btn-delete").addEventListener("click", deleteBook);
  $("#btn-probe").addEventListener("click", probe);
  $("#btn-lookup").addEventListener("click", lookup);
  $("#lookup-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } });
  $("#import-form").addEventListener("submit", runImport);
  $("#login-form").addEventListener("submit", submitLogin);

  refreshSession().catch((e) => toast(e.message));
}

init();
