# Stacks

A personal library, like Calibre but on the web. It **does not host books**. It stores details (title, author, tags, notes, reading status) in a Cloudflare D1 database and links to PDF and ebook files that live somewhere else. It can read PDF and EPUB files in the browser, check your links every 6 hours, and find Wayback Machine copies of broken ones.

Cloudflare's free plan is enough for this (D1: 5 GB; Workers: 100k requests a day).

## What you get

- Shelf, Covers and List views, search across titles, authors, tags and notes, filters for tags, formats and reading status
- Add one book or import many (pasted links, CSV, or a JSON export)
- Look up author, year and cover on Open Library (no key needed)
- "Check address" tells you the file type, size and whether the browser reader can open it
- Link checker runs on a schedule; marks a link broken after 3 failed checks and looks for an archived copy
- Export the whole library as JSON or CSV any time

## Already done for you

The D1 database `stacks` (id in `wrangler.jsonc`) exists in your Cloudflare account and the tables and search index are created, so skip the `d1 create` and `db:remote` steps below. Still to do: set `ADMIN_TOKEN`, deploy, and add the app's address to your proxy's `ALLOWED_ORIGINS`.

## Set it up (terminal)

You need Node 20+ and a free Cloudflare account. Each step has a one-line note you can paste into a log.

```bash
npm install
```
Installs Wrangler (Cloudflare's tool) and TypeScript.

```bash
npx wrangler login
```
Signs the terminal in to your Cloudflare account.

```bash
npx wrangler d1 create stacks
```
Creates the database. Copy the `database_id` it prints into `wrangler.jsonc` in place of `REPLACE_WITH_DATABASE_ID`.

```bash
npm run db:remote
```
Creates the tables and search index in the live database.

```bash
npx wrangler secret put ADMIN_TOKEN
```
Sets your password. Use a long random string (for example the output of `openssl rand -hex 24`). You type it into the Sign in box.

```bash
npm run deploy
```
Publishes the app. Wrangler prints your `*.workers.dev` address.

Open the address, choose **Sign in**, paste the token, then **Add book** or **Import**.

## Set it up (browser only)

1. Put this folder in a GitHub repository.
2. In the Cloudflare dashboard: **Storage & databases > D1 > Create database** named `stacks`. Copy its ID into `wrangler.jsonc`.
3. In the D1 database's **Console**, paste the contents of `migrations/0001_init.sql` and run it.
4. **Workers & Pages > Create > Import a repository**, pick the repo.
5. Open the Worker's **Settings > Variables and secrets** and add a secret named `ADMIN_TOKEN`.

## Try it on your computer first

```bash
cp .dev.vars.example .dev.vars
```
Makes the local settings file (token `dev-token-change-me`).

```bash
npm run db:local
```
Creates the local test database.

```bash
npm run dev
```
Runs the app at http://localhost:8787.

```bash
npm run test:smoke
```
Runs 45 checks against the running app. Needs `python3`.

`.dev.vars` is for your computer only. It sets `ALLOW_PRIVATE_HOSTS=true`, which lets the app fetch `localhost` addresses. **Never set that in production.**

## Settings (`wrangler.jsonc`)

| Name | Default | What it does |
|---|---|---|
| `PUBLIC_READ` | `"false"` | `"true"` lets anyone view the library. Changes always need the token. |
| `PROXY_HOSTS` | `""` | Comma-separated host names the app may fetch on your behalf so the reader can open files that block browsers (CORS). Leave empty to turn the proxy off. |
| `CORS_PROXY` | `"https://proxy.glosse.me"` | Fallback when a source blocks browsers: the reader fetches through this CORS proxy (`?url=` format). That proxy only allows listed origins, so add this app's address to its `ALLOWED_ORIGINS`. Leave empty to turn off. |
| `LINK_CHECK_BATCH` | `"12"` | Books checked per run. Keep it at 12 or lower on the free plan (50 outbound requests per run). |

## API examples

```bash
BASE=https://stacks.YOUR-SUBDOMAIN.workers.dev
TOKEN=your-token

# add a book
curl -X POST "$BASE/api/books" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.org/book.pdf","title":"Example","tags":"medieval, art"}'

# search
curl "$BASE/api/books?q=medieval&format=pdf" -H "Authorization: Bearer $TOKEN"

# import many
curl -X POST "$BASE/api/import" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"url":"https://example.org/a.epub"},{"url":"https://example.org/b.pdf","title":"B"}]}'

# export everything
curl "$BASE/api/export?format=csv" -H "Authorization: Bearer $TOKEN" -o library.csv
```

## Safety notes

- **Keep it private unless you mean otherwise.** Without `PUBLIC_READ`, every request needs the token. For more protection, put the site behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (free for up to 50 users).
- **Rate limit sign-in attempts.** In the dashboard, **Security > WAF > Rate limiting rules**, add a rule for path starting `/api/` limiting to about 60 requests a minute per IP.
- **Outbound fetches are guarded.** Link checks, address checks and the proxy refuse localhost, private network and IP-literal addresses, and only run for signed-in users.
- **Only link to files you have the right to use.** Storing a link is not the same as permission to copy or share the file. If you make the library public, link only to material you are comfortable pointing people to.
- **The reader only works when the source allows it.** Many sites block reading from other sites. Stacks tells you when that happens and offers "Open the source" instead.

## What was and wasn't tested

Tested: the API (45 checks, including search, import, export, link checking and the proxy), and the pages in a headless browser: the shelf, dialogs, the PDF reader and the EPUB reader on local test files.

Not tested: a real Cloudflare deployment, the D1 search index in production (search falls back to plain matching if it fails), and the reader libraries loaded from the jsDelivr CDN (they were substituted with local copies of the same versions during testing).
