/**
 * Stacks: a URL-first personal library.
 *
 * Like Calibre, but the files stay where they are. Each book is a row in D1 (title, author,
 * tags, cover, reading status...) plus the URL of a PDF or ebook hosted elsewhere.
 *
 * Routes (all under /api, everything else is served from public/):
 *   GET    /api/config                public settings for the frontend
 *   GET    /api/session               is this token valid?
 *   GET    /api/books                 list + search + filter
 *   POST   /api/books                 add one book
 *   GET    /api/books/:id             one book
 *   PATCH  /api/books/:id             edit a book
 *   DELETE /api/books/:id             remove a book
 *   POST   /api/books/:id/check       check the link now
 *   POST   /api/books/:id/archive     find a Wayback Machine copy
 *   POST   /api/import                add up to 100 books at once
 *   GET    /api/export                download the whole catalog (json or csv)
 *   GET    /api/tags | /api/stats     sidebar data
 *   GET    /api/lookup?q=             Open Library metadata search
 *   GET    /api/probe?url=            check a URL: format, size, browser-readable?
 *   GET    /api/proxy?url=            stream a file from an allowlisted host (optional)
 */

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secret. Bearer token that unlocks writes (and reads, unless PUBLIC_READ is "true"). */
  ADMIN_TOKEN?: string;
  PUBLIC_READ?: string;
  PROXY_HOSTS?: string;
  CORS_PROXY?: string;
  LINK_CHECK_BATCH?: string;
  /** Local development only. Lets the app add and probe localhost URLs. */
  ALLOW_PRIVATE_HOSTS?: string;
}

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const FORMATS = ['pdf', 'epub', 'mobi', 'azw3', 'djvu', 'cbz', 'cbr', 'txt', 'html', 'docx', 'other'] as const;
type Format = (typeof FORMATS)[number];

const STATUSES = ['unread', 'reading', 'read'] as const;
type Status = (typeof STATUSES)[number];

type LinkStatus = 'unknown' | 'ok' | 'dead';

const UA = 'StacksLibrary/1.0 (personal link checker)';

/** Columns a client may set. Order matters: it is the order of the INSERT below. */
const BOOK_FIELDS = [
  'title', 'author', 'series', 'series_index', 'url', 'format', 'cover_url', 'isbn', 'year',
  'publisher', 'language', 'description', 'notes', 'tags', 'status', 'rating', 'favorite',
] as const;
type BookField = (typeof BOOK_FIELDS)[number];
type FieldValue = string | number | null;
type ParsedBook = Partial<Record<BookField, FieldValue>>;

interface BookRow {
  id: number;
  title: string;
  author: string;
  series: string;
  series_index: number | null;
  url: string;
  format: Format;
  size_bytes: number | null;
  cover_url: string;
  isbn: string;
  year: number | null;
  publisher: string;
  language: string;
  description: string;
  notes: string;
  tags: string;
  status: Status;
  rating: number;
  favorite: number;
  cors_ok: number | null;
  link_status: LinkStatus;
  link_checked_at: string | null;
  http_status: number | null;
  fail_count: number;
  archive_url: string;
  added_at: string;
  updated_at: string;
}

const INSERT_SQL = `INSERT INTO books (${BOOK_FIELDS.join(', ')}) VALUES (${BOOK_FIELDS.map(() => '?').join(', ')})`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** An error that becomes an HTTP response with a message the frontend can show. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Trim, cap length and strip control characters. Non-strings become ''. */
function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function optInt(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function optNum(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

/** Compare secrets without leaking length or position through timing. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token !== '' && (await safeEqual(token, env.ADMIN_TOKEN));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 1_000_000) throw new HttpError(413, 'Request body is too large (1 MB max).');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
  return data as Record<string, unknown>;
}

function isUniqueError(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

// ---------------------------------------------------------------------------
// URL and field validation
// ---------------------------------------------------------------------------

/** Block hosts the Worker must never be pointed at (internal names and private IP ranges). */
function isPrivateHost(host: string, allowPrivate: boolean): boolean {
  if (allowPrivate) return false;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[')) return true; // IPv6 literals
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  return false;
}

function normUrl(v: unknown, allowPrivate: boolean): string {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'A url is required.');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new HttpError(400, `Not a valid URL: ${v.slice(0, 80)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http and https URLs are supported.');
  if (u.username || u.password) throw new HttpError(400, 'URLs with a username or password are not allowed.');
  if (isPrivateHost(u.hostname, allowPrivate)) throw new HttpError(400, 'That host is not allowed.');
  u.hash = ''; // #page=3 style fragments would make duplicates
  const out = u.toString();
  if (out.length > 2048) throw new HttpError(400, 'That URL is too long (2048 characters max).');
  return out;
}

const EXT_RE = /\.(pdf|epub\d?|mobi|azw3?|djvu?|cbz|cbr|txt|html?|docx)(\.[a-z0-9]+)*$/i;
const EXT_MAP: Record<string, Format> = {
  pdf: 'pdf', epub: 'epub', epub3: 'epub', mobi: 'mobi', azw: 'azw3', azw3: 'azw3', djvu: 'djvu', djv: 'djvu',
  cbz: 'cbz', cbr: 'cbr', txt: 'txt', htm: 'html', html: 'html', docx: 'docx',
};

function guessFormat(url: string, contentType = ''): Format {
  try {
    const m = new URL(url).pathname.match(EXT_RE);
    if (m) return EXT_MAP[m[1].toLowerCase()] ?? 'other';
  } catch {
    /* fall through to content type */
  }
  const ct = contentType.toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('epub')) return 'epub';
  if (ct.includes('text/html')) return 'html';
  if (ct.startsWith('text/plain')) return 'txt';
  return 'other';
}

/** A readable placeholder title from a file name: "the-book_of-thoth.pdf" -> "The book of thoth". */
function guessTitle(url: string): string {
  const u = new URL(url);
  let seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* keep the raw segment */
  }
  seg = seg.replace(EXT_RE, '').replace(/[_+.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!seg) return u.hostname;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

function normTags(v: unknown): string {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const clean = list
    .map((t) => String(t).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter((t) => t !== '');
  const unique = [...new Set(clean)].slice(0, 30);
  return unique.length ? `,${unique.join(',')},` : '';
}

function parseField(field: BookField, v: unknown, allowPrivate: boolean): FieldValue {
  switch (field) {
    case 'title': return str(v, 500);
    case 'author': return str(v, 300);
    case 'series': return str(v, 200);
    case 'series_index': return optNum(v, 0, 10000);
    case 'url': return normUrl(v, allowPrivate);
    case 'format': {
      const s = str(v, 10).toLowerCase();
      return (FORMATS as readonly string[]).includes(s) ? s : 'other';
    }
    case 'cover_url': {
      const s = str(v, 2048);
      if (!s) return '';
      try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
      } catch {
        return '';
      }
    }
    case 'isbn': return str(v, 20).replace(/[^0-9Xx-]/g, '');
    case 'year': return optInt(v, 0, 3000);
    case 'publisher': return str(v, 200);
    case 'language': return str(v, 40);
    case 'description': return str(v, 4000);
    case 'notes': return str(v, 4000);
    case 'tags': return normTags(v);
    case 'status': {
      if (v === undefined || v === null || v === '') return 'unread';
      const s = String(v);
      if (!(STATUSES as readonly string[]).includes(s)) throw new HttpError(400, 'status must be unread, reading or read.');
      return s;
    }
    case 'rating': return optInt(v, 0, 5) ?? 0;
    case 'favorite': return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
  }
}

/** Validate a request body. 'create' fills every field; 'patch' only the ones sent. */
function parseBook(raw: Record<string, unknown>, mode: 'create' | 'patch', allowPrivate: boolean): ParsedBook {
  const out: ParsedBook = {};
  for (const f of BOOK_FIELDS) {
    if (mode === 'patch' && !(f in raw)) continue;
    out[f] = parseField(f, raw[f], allowPrivate);
  }
  if (mode === 'create') {
    const url = out.url as string;
    if (!out.title) out.title = guessTitle(url);
    if (out.format === 'other') out.format = guessFormat(url);
  } else if ('title' in raw && !out.title) {
    throw new HttpError(400, 'A title cannot be empty.');
  }
  return out;
}

function toApi(r: BookRow) {
  return {
    ...r,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
    favorite: r.favorite === 1,
    cors_ok: r.cors_ok === null ? null : r.cors_ok === 1,
  };
}

const allowPrivateHosts = (env: Env) => env.ALLOW_PRIVATE_HOSTS === 'true';

// ---------------------------------------------------------------------------
// Listing and search
// ---------------------------------------------------------------------------

const SORTS: Record<string, string> = {
  added: 'b.added_at DESC, b.id DESC',
  title: 'b.title COLLATE NOCASE ASC',
  author: 'b.author COLLATE NOCASE ASC, b.series COLLATE NOCASE ASC, b.series_index ASC, b.title COLLATE NOCASE ASC',
  year: 'b.year DESC, b.title COLLATE NOCASE ASC',
  rating: 'b.rating DESC, b.title COLLATE NOCASE ASC',
};

/** "medieval alch" -> "medieval"* "alch"* (safe for FTS5: only letters and numbers survive). */
function ftsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.slice(0, 8).map((t) => `"${t}"*`).join(' ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

interface BuiltQuery {
  sql: string;
  countSql: string;
  args: (string | number)[];
}

function buildListQuery(p: URLSearchParams, q: string, mode: 'fts' | 'like' | 'none'): BuiltQuery {
  const where: string[] = [];
  const args: (string | number)[] = [];
  let from = 'books b';
  let order = SORTS.added;

  if (q && mode === 'fts') {
    from = 'books_fts JOIN books b ON b.id = books_fts.rowid';
    where.push('books_fts MATCH ?');
    args.push(ftsQuery(q));
    order = 'books_fts.rank';
  } else if (q && mode === 'like') {
    const like = `%${escapeLike(q)}%`;
    const cols = ['b.title', 'b.author', 'b.series', 'b.tags', 'b.description', 'b.notes'];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < cols.length; i++) args.push(like);
  }

  const format = p.get('format');
  if (format && (FORMATS as readonly string[]).includes(format)) {
    where.push('b.format = ?');
    args.push(format);
  }
  const status = p.get('status');
  if (status && (STATUSES as readonly string[]).includes(status)) {
    where.push('b.status = ?');
    args.push(status);
  }
  const link = p.get('link');
  if (link === 'dead' || link === 'ok' || link === 'unknown') {
    where.push('b.link_status = ?');
    args.push(link);
  }
  const tag = normTags(p.get('tag') ?? '').replace(/^,|,$/g, '');
  if (tag) {
    where.push('instr(b.tags, ?) > 0');
    args.push(`,${tag},`);
  }
  const series = str(p.get('series'), 200);
  if (series) {
    where.push('b.series = ?');
    args.push(series);
  }
  if (p.get('favorite') === '1') where.push('b.favorite = 1');

  const sort = p.get('sort') ?? '';
  if (SORTS[sort]) order = SORTS[sort];

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = optInt(p.get('limit'), 1, 200) ?? 60;
  const offset = optInt(p.get('offset'), 0, 1_000_000) ?? 0;
  return {
    sql: `SELECT b.* FROM ${from} ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    countSql: `SELECT COUNT(*) AS n FROM ${from} ${whereSql}`,
    args,
    // limit and offset are validated integers, so they are safe to inline
  };
}

async function listBooks(env: Env, p: URLSearchParams): Promise<Response> {
  const q = str(p.get('q'), 200);
  const run = async (mode: 'fts' | 'like' | 'none') => {
    const built = buildListQuery(p, q, mode);
    const [rows, count] = await Promise.all([
      env.DB.prepare(built.sql).bind(...built.args).all<BookRow>(),
      env.DB.prepare(built.countSql).bind(...built.args).first<{ n: number }>(),
    ]);
    return { items: rows.results.map(toApi), total: count?.n ?? 0 };
  };

  let result: { items: ReturnType<typeof toApi>[]; total: number };
  if (q && ftsQuery(q)) {
    try {
      result = await run('fts');
    } catch (e) {
      console.warn('FTS query failed, falling back to LIKE:', errMsg(e));
      result = await run('like');
    }
  } else {
    result = await run(q ? 'like' : 'none');
  }
  return json(result);
}

// ---------------------------------------------------------------------------
// Create, update, delete, import, export
// ---------------------------------------------------------------------------

async function createBook(env: Env, raw: Record<string, unknown>): Promise<Response> {
  const parsed = parseBook(raw, 'create', allowPrivateHosts(env));
  try {
    const row = await env.DB.prepare(`${INSERT_SQL} RETURNING *`)
      .bind(...BOOK_FIELDS.map((f) => parsed[f] ?? null))
      .first<BookRow>();
    if (!row) throw new HttpError(500, 'The book could not be saved.');
    // Note an existing Wayback Machine snapshot right away (one quick lookup; skipped for local testing).
    if (!allowPrivateHosts(env)) {
      const archive = await findArchive(row.url);
      if (archive) {
        await env.DB.prepare('UPDATE books SET archive_url = ? WHERE id = ?').bind(archive, row.id).run();
        row.archive_url = archive;
      }
    }
    return json(toApi(row), 201);
  } catch (e) {
    if (isUniqueError(e)) {
      const existing = await env.DB.prepare('SELECT id, title FROM books WHERE url = ?').bind(parsed.url).first<{ id: number; title: string }>();
      return json({ error: 'That URL is already in your library.', existing }, 409);
    }
    throw e;
  }
}

async function updateBook(env: Env, id: number, raw: Record<string, unknown>): Promise<Response> {
  const parsed = parseBook(raw, 'patch', allowPrivateHosts(env));
  const sets: string[] = [];
  const vals: FieldValue[] = [];
  for (const f of BOOK_FIELDS) {
    const v = parsed[f];
    if (v === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(v);
  }
  if (parsed.url !== undefined) {
    // A new URL means everything we knew about the old link is stale.
    sets.push("link_status = 'unknown'", 'fail_count = 0', 'link_checked_at = NULL', 'http_status = NULL', 'cors_ok = NULL', 'size_bytes = NULL', "archive_url = ''");
  }
  if (sets.length === 0) throw new HttpError(400, 'Nothing to update.');
  try {
    const row = await env.DB.prepare(`UPDATE books SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? RETURNING *`)
      .bind(...vals, id)
      .first<BookRow>();
    if (!row) throw new HttpError(404, 'Book not found.');
    return json(toApi(row));
  } catch (e) {
    if (isUniqueError(e)) return errorResponse(409, 'Another book already uses that URL.');
    throw e;
  }
}

async function deleteBook(env: Env, id: number): Promise<Response> {
  const res = await env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'Book not found.');
  return json({ deleted: id });
}

async function importBooks(env: Env, raw: Record<string, unknown>): Promise<Response> {
  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new HttpError(400, 'Send between 1 and 100 items per request.');
  }
  const statements: D1PreparedStatement[] = [];
  const invalid: { index: number; reason: string }[] = [];
  const insertIgnore = INSERT_SQL.replace('INSERT INTO', 'INSERT OR IGNORE INTO');

  items.forEach((item: unknown, index: number) => {
    try {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new HttpError(400, 'Each item must be an object.');
      const parsed = parseBook(item as Record<string, unknown>, 'create', allowPrivateHosts(env));
      statements.push(env.DB.prepare(insertIgnore).bind(...BOOK_FIELDS.map((f) => parsed[f] ?? null)));
    } catch (e) {
      invalid.push({ index, reason: e instanceof HttpError ? e.message : 'Invalid item.' });
    }
  });

  let added = 0;
  if (statements.length) {
    // Count before and after: it is the most reliable way to know how many were new.
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM books').first<{ n: number }>();
    await env.DB.batch(statements);
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM books').first<{ n: number }>();
    added = (after?.n ?? 0) - (before?.n ?? 0);
  }
  return json({ added, skipped: statements.length - added, invalid });
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet apps from running formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportBooks(env: Env, p: URLSearchParams): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM books ORDER BY id').all<BookRow>();
  const stamp = new Date().toISOString().slice(0, 10);
  if (p.get('format') === 'csv') {
    const cols = ['id', ...BOOK_FIELDS, 'size_bytes', 'link_status', 'archive_url', 'added_at'] as const;
    const lines = [cols.join(',')];
    for (const r of results) lines.push(cols.map((c) => csvCell(c === 'tags' ? r.tags.split(',').filter(Boolean).join('; ') : r[c])).join(','));
    return new Response(lines.join('\n'), {
      headers: { ...BASE_HEADERS, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="stacks-${stamp}.csv"` },
    });
  }
  return json({ exported_at: new Date().toISOString(), books: results.map(toApi) }, 200, {
    'content-disposition': `attachment; filename="stacks-${stamp}.json"`,
  });
}

async function tagCounts(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT tags FROM books WHERE tags != ''").all<{ tags: string }>();
  const counts = new Map<string, number>();
  for (const r of results) for (const t of r.tags.split(',').filter(Boolean)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
  return json({ tags });
}

async function stats(env: Env): Promise<Response> {
  const [byFormat, byStatus, totals] = await Promise.all([
    env.DB.prepare('SELECT format AS k, COUNT(*) AS n FROM books GROUP BY format ORDER BY n DESC').all<{ k: string; n: number }>(),
    env.DB.prepare('SELECT status AS k, COUNT(*) AS n FROM books GROUP BY status').all<{ k: string; n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(link_status = 'dead') AS dead, SUM(favorite) AS favorites FROM books")
      .first<{ total: number; dead: number | null; favorites: number | null }>(),
  ]);
  return json({
    total: totals?.total ?? 0,
    dead: totals?.dead ?? 0,
    favorites: totals?.favorites ?? 0,
    formats: byFormat.results,
    statuses: byStatus.results,
  });
}

// ---------------------------------------------------------------------------
// Metadata lookup (Open Library, no API key needed)
// ---------------------------------------------------------------------------

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  cover_i?: number;
  subject?: string[];
  publisher?: string[];
  language?: string[];
}

async function lookup(q: string): Promise<Response> {
  if (!q) throw new HttpError(400, 'Add a title, author or ISBN to search for.');
  const compact = q.replace(/[\s-]/g, '');
  const params = new URLSearchParams({
    fields: 'key,title,author_name,first_publish_year,isbn,cover_i,subject,publisher,language',
    limit: '8',
  });
  if (/^\d{9}[\dXx]$|^\d{13}$/.test(compact)) params.set('isbn', compact);
  else params.set('q', q);

  let res: Response;
  try {
    res = await fetch(`https://openlibrary.org/search.json?${params}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch (e) {
    throw new HttpError(502, `Could not reach Open Library: ${errMsg(e)}`);
  }
  if (!res.ok) throw new HttpError(502, `Open Library answered with ${res.status}.`);
  const data = (await res.json()) as { docs?: OpenLibraryDoc[] };
  const candidates = (data.docs ?? []).map((d) => ({
    key: d.key ?? '',
    title: d.title ?? '',
    author: (d.author_name ?? []).slice(0, 3).join(', '),
    year: d.first_publish_year ?? null,
    isbn: d.isbn?.find((i) => i.length === 13) ?? d.isbn?.[0] ?? '',
    publisher: d.publisher?.[0] ?? '',
    language: d.language?.[0] ?? '',
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '',
    subjects: (d.subject ?? []).slice(0, 8),
  }));
  return json({ candidates });
}

// ---------------------------------------------------------------------------
// Link probing, checking and archive lookup
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  status: number | null;
  contentType: string;
  size: number | null;
  /** True if the source lets this site read the file in a browser. null = not tested. */
  corsOk: boolean | null;
  error: string;
}

/**
 * Ask the source server about a URL. Tries HEAD first, then a 1-byte ranged GET because
 * many file hosts reject HEAD. Sending our own Origin lets us see if the browser reader
 * would be allowed to fetch the file (CORS).
 */
async function probeUrl(target: string, origin: string | null): Promise<ProbeResult> {
  const headers: Record<string, string> = { 'user-agent': UA, accept: '*/*' };
  if (origin) headers.origin = origin;

  let res: Response | null = null;
  let error = '';
  try {
    res = await fetch(target, { method: 'HEAD', headers, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  } catch (e) {
    error = errMsg(e);
  }
  if (!res || res.status >= 400) {
    try {
      const ranged = await fetch(target, {
        method: 'GET',
        headers: { ...headers, range: 'bytes=0-0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      void ranged.body?.cancel(); // we only wanted the headers
      res = ranged;
      error = '';
    } catch (e) {
      if (!res) error = error || errMsg(e);
    }
  }
  if (!res) return { ok: false, status: null, contentType: '', size: null, corsOk: null, error };

  const range = res.headers.get('content-range')?.match(/\/(\d+)$/);
  const length = res.headers.get('content-length');
  const size = range ? Number(range[1]) : length && res.status !== 206 ? Number(length) : null;
  const acao = res.headers.get('access-control-allow-origin');
  return {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    size: size !== null && Number.isFinite(size) ? size : null,
    corsOk: origin ? acao === '*' || acao === origin : null,
    error: '',
  };
}

/** Closest Wayback Machine snapshot for a URL, or '' if there is none. */
async function findArchive(target: string): Promise<string> {
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = (await res.json()) as { archived_snapshots?: { closest?: { available?: boolean; url?: string } } };
    const closest = data.archived_snapshots?.closest;
    return closest?.available && closest.url ? closest.url.replace(/^http:\/\//, 'https://') : '';
  } catch {
    return '';
  }
}

/** Ask the Wayback Machine to take a new snapshot ("Save Page Now"), then return its address or ''. */
async function saveSnapshot(target: string): Promise<string> {
  try {
    const res = await fetch(`https://web.archive.org/save/${target}`, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
    if (res.status >= 400) return '';
    return (await findArchive(target)) || (res.url.includes('/web/') ? res.url.replace(/^http:\/\//, 'https://') : '');
  } catch {
    return '';
  }
}

/** Probe one book's link and save the result. Three failures in a row mark it dead. */
async function checkBook(env: Env, book: BookRow, origin: string | null): Promise<BookRow> {
  const r = await probeUrl(book.url, origin);
  let fails = book.fail_count;
  let status: LinkStatus = book.link_status;
  if (r.ok) {
    fails = 0;
    status = 'ok';
  } else {
    fails += r.status === 404 || r.status === 410 ? 2 : 1; // a hard "gone" counts double
    if (fails >= 3) status = 'dead';
  }
  let archive = book.archive_url;
  if (status === 'dead' && !archive) archive = await findArchive(book.url);

  const updated = await env.DB.prepare(
    `UPDATE books SET link_status = ?, link_checked_at = datetime('now'), http_status = ?, fail_count = ?,
       archive_url = ?, size_bytes = COALESCE(?, size_bytes), cors_ok = COALESCE(?, cors_ok), updated_at = datetime('now')
     WHERE id = ? RETURNING *`,
  )
    .bind(status, r.status, fails, archive, r.size, r.corsOk === null ? null : r.corsOk ? 1 : 0, book.id)
    .first<BookRow>();
  return updated ?? book;
}

/** Cron job: re-check the links that have gone longest without a check. */
async function runLinkChecks(env: Env): Promise<void> {
  // Each book can use up to 4 subrequests (HEAD, GET, Wayback, D1). The free plan allows 50 per run.
  const batch = Math.min(25, Math.max(1, Number(env.LINK_CHECK_BATCH) || 12));
  const { results } = await env.DB.prepare("SELECT * FROM books ORDER BY COALESCE(link_checked_at, '') ASC, id ASC LIMIT ?")
    .bind(batch)
    .all<BookRow>();
  for (let i = 0; i < results.length; i += 4) {
    const settled = await Promise.allSettled(results.slice(i, i + 4).map((b) => checkBook(env, b, null)));
    for (const s of settled) if (s.status === 'rejected') console.error('Link check failed:', errMsg(s.reason));
  }
  console.log(`Link check finished: ${results.length} books`);
}

// ---------------------------------------------------------------------------
// Optional reader proxy (allowlisted hosts only)
// ---------------------------------------------------------------------------

function proxyHosts(env: Env): string[] {
  return (env.PROXY_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

/**
 * Streams a file from an allowlisted host so the in-app reader can open it even when the host
 * sends no CORS headers. Redirects are followed by hand so every hop is checked against the
 * allowlist. The response is served as a download with a locked-down CSP, so a file can never
 * run as a page on this site.
 */
async function proxy(request: Request, env: Env, target: string | null): Promise<Response> {
  const allowed = proxyHosts(env);
  if (allowed.length === 0) throw new HttpError(403, 'The reader proxy is turned off. Set PROXY_HOSTS to enable it.');
  let current = normUrl(target, allowPrivateHosts(env));

  for (let hop = 0; hop < 5; hop++) {
    if (!hostAllowed(new URL(current).hostname, allowed)) {
      throw new HttpError(403, `${new URL(current).hostname} is not in PROXY_HOSTS.`);
    }
    const headers = new Headers({ 'user-agent': UA });
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    const upstream = await fetch(current, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual' });

    const location = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      void upstream.body?.cancel();
      current = normUrl(new URL(location, current).toString(), allowPrivateHosts(env));
      continue;
    }
    const out = new Headers({
      ...BASE_HEADERS,
      'cache-control': 'private, max-age=3600',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'attachment',
    });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
  throw new HttpError(508, 'Too many redirects.');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const p = url.searchParams;

  if (path === '/api/config' && method === 'GET') {
    return json({
      publicRead: env.PUBLIC_READ === 'true',
      writable: Boolean(env.ADMIN_TOKEN),
      proxyHosts: proxyHosts(env),
      corsProxy: env.CORS_PROXY ?? '',
      formats: FORMATS,
    });
  }

  const admin = await isAdmin(request, env);
  const canRead = admin || env.PUBLIC_READ === 'true';

  if (path === '/api/session' && method === 'GET') return json({ admin, canRead });

  if (method === 'GET' || method === 'HEAD') {
    if (!canRead) throw new HttpError(401, 'Enter your access token to view this library.');
    if (path === '/api/books') return listBooks(env, p);
    if (path === '/api/tags') return tagCounts(env);
    if (path === '/api/stats') return stats(env);
    if (path === '/api/export') return exportBooks(env, p);
    if (path === '/api/proxy') return proxy(request, env, p.get('url'));
    const one = path.match(/^\/api\/books\/(\d+)$/);
    if (one) {
      const row = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(Number(one[1])).first<BookRow>();
      if (!row) throw new HttpError(404, 'Book not found.');
      return json(toApi(row));
    }
    // lookup and probe make outbound requests, so they need the admin token
    if (path === '/api/lookup' || path === '/api/probe') {
      if (!admin) throw new HttpError(401, 'Enter your access token to do that.');
      if (path === '/api/lookup') return lookup(str(p.get('q'), 200));
      const target = normUrl(p.get('url'), allowPrivateHosts(env));
      const r = await probeUrl(target, url.origin);
      return json({
        ok: r.ok,
        status: r.status,
        format: guessFormat(target, r.contentType),
        contentType: r.contentType,
        size: r.size,
        corsOk: r.corsOk,
        title: guessTitle(target),
        error: r.error,
      });
    }
    throw new HttpError(404, 'Unknown endpoint.');
  }

  // Everything below changes data.
  if (!env.ADMIN_TOKEN) throw new HttpError(503, 'Changes are off: ADMIN_TOKEN is not set on this Worker.');
  if (!admin) throw new HttpError(401, 'Enter your access token to make changes.');

  if (path === '/api/books' && method === 'POST') return createBook(env, await readJson(request));
  if (path === '/api/import' && method === 'POST') return importBooks(env, await readJson(request));

  const m = path.match(/^\/api\/books\/(\d+)(?:\/(check|archive))?$/);
  if (m) {
    const id = Number(m[1]);
    const action = m[2];
    if (!action && method === 'PATCH') return updateBook(env, id, await readJson(request));
    if (!action && method === 'DELETE') return deleteBook(env, id);
    if (action && method === 'POST') {
      const row = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(id).first<BookRow>();
      if (!row) throw new HttpError(404, 'Book not found.');
      if (action === 'check') return json(toApi(await checkBook(env, row, url.origin)));
      let archive = await findArchive(row.url);
      if (!archive && p.get('save') === '1') archive = await saveSnapshot(row.url);
      if (!archive) return json({ archive_url: '', book: toApi(row) });
      const updated = await env.DB.prepare("UPDATE books SET archive_url = ?, updated_at = datetime('now') WHERE id = ? RETURNING *")
        .bind(archive, id)
        .first<BookRow>();
      return json({ archive_url: archive, book: toApi(updated ?? row) });
    }
  }
  throw new HttpError(404, 'Unknown endpoint.');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.status, e.message);
      console.error('Unhandled error:', e);
      return errorResponse(500, 'Something went wrong on the server. Check the Worker logs.');
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runLinkChecks(env));
  },
} satisfies ExportedHandler<Env>;
