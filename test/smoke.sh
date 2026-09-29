#!/usr/bin/env bash
# Smoke test for the Stacks API. Start the app first (npm run dev), then: npm run test:smoke
#
# What it does: adds, searches, edits, imports, exports and deletes books over HTTP, and checks the
# link probe against a throwaway local file server (one path sends CORS headers, one does not).
# Needs ALLOW_PRIVATE_HOSTS=true in .dev.vars so localhost URLs are accepted.
set -u

BASE="${BASE:-http://localhost:8787}"
TOKEN="${TOKEN:-dev-token-change-me}"
FILE_PORT="${FILE_PORT:-8799}"
AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H "Content-Type: application/json")
pass=0
fail=0

check() { # name expected actual
  if [ "$2" == "$3" ]; then pass=$((pass + 1)); echo "  ok    $1"; else fail=$((fail + 1)); echo "  FAIL  $1 (expected '$2', got '$3')"; fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

tmp="$(mktemp -d)"
mkdir -p "$tmp/open" "$tmp/closed"
printf '%%PDF-1.4\n%% smoke test\n' > "$tmp/open/thoth.pdf"
printf '%%PDF-1.4\n%% smoke test\n' > "$tmp/closed/thoth.pdf"
python3 "$(dirname "$0")/cors_server.py" "$FILE_PORT" "$tmp" &
server_pid=$!
trap 'kill $server_pid 2>/dev/null; rm -rf "$tmp"' EXIT
sleep 1

echo "Access"
check "config is public" 200 "$(status "$BASE/api/config")"
check "reading without a token is blocked" 401 "$(status "$BASE/api/books")"
check "reading with a token works" 200 "$(status "${AUTH[@]}" "$BASE/api/books")"
check "writing without a token is blocked" 401 "$(status -X POST "${JSON[@]}" -d '{"url":"https://example.com/a.pdf"}' "$BASE/api/books")"
check "wrong token is blocked" 401 "$(status -H 'Authorization: Bearer nope' "$BASE/api/books")"

echo "Create and read"
created="$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"url":"https://example.org/files/the-book_of-thoth.pdf","author":"Anon","tags":"Egypt, Occult, egypt"}' "$BASE/api/books")"
id="$(echo "$created" | field "d['id']")"
check "title guessed from file name" "The book of thoth" "$(echo "$created" | field "d['title']")"
check "format guessed from extension" "pdf" "$(echo "$created" | field "d['format']")"
check "tags cleaned and de-duplicated" "['egypt', 'occult']" "$(echo "$created" | field "d['tags']")"
check "duplicate URL gives 409" 409 "$(status "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"url":"https://example.org/files/the-book_of-thoth.pdf"}' "$BASE/api/books")"
check "javascript: URL rejected" 400 "$(status "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"url":"javascript:alert(1)"}' "$BASE/api/books")"
check "credentials in URL rejected" 400 "$(status "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"url":"https://user:pw@example.com/a.pdf"}' "$BASE/api/books")"
check "bad status rejected" 400 "$(status "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"url":"https://example.org/x.pdf","status":"lost"}' "$BASE/api/books")"

echo "Search and filters"
check "full-text search finds the book" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?q=thoth" | field "d['total']")"
check "prefix search works" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?q=thot" | field "d['total']")"
check "search on author works" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?q=anon" | field "d['total']")"
check "search with SQL-ish characters is safe" 200 "$(status "${AUTH[@]}" -G --data-urlencode "q=\"'; DROP TABLE books; --" "$BASE/api/books")"
check "tag filter matches" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?tag=occult" | field "d['total']")"
check "tag filter does not match partial tags" 0 "$(curl -s "${AUTH[@]}" "$BASE/api/books?tag=occ" | field "d['total']")"
check "format filter excludes other formats" 0 "$(curl -s "${AUTH[@]}" "$BASE/api/books?format=epub" | field "d['total']")"

echo "Edit"
check "patch changes the title" "Book of Thoth" "$(curl -s "${AUTH[@]}" "${JSON[@]}" -X PATCH -d '{"title":"Book of Thoth","status":"reading","favorite":true,"rating":4}' "$BASE/api/books/$id" | field "d['title']")"
check "search index follows the edit" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?q=Book+of+Thoth" | field "d['total']")"
check "old text is gone from the index" 0 "$(curl -s "${AUTH[@]}" "$BASE/api/books?q=guessedoldword" | field "d['total']")"
check "favorite filter matches" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?favorite=1" | field "d['total']")"
check "empty title rejected" 400 "$(status "${AUTH[@]}" "${JSON[@]}" -X PATCH -d '{"title":""}' "$BASE/api/books/$id")"
check "unknown book gives 404" 404 "$(status "${AUTH[@]}" "$BASE/api/books/999999")"

echo "Import"
imp="$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"items":[{"url":"https://example.org/a.epub"},{"url":"https://example.org/b.pdf","title":"B"},{"url":"https://example.org/a.epub"},{"url":"not a url"}]}' "$BASE/api/import")"
check "import adds new books" 2 "$(echo "$imp" | field "d['added']")"
check "import skips duplicates" 1 "$(echo "$imp" | field "d['skipped']")"
check "import reports invalid rows" 1 "$(echo "$imp" | field "len(d['invalid'])")"
check "epub detected on import" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?format=epub" | field "d['total']")"

echo "Export and sidebar data"
check "json export has all books" 3 "$(curl -s "${AUTH[@]}" "$BASE/api/export" | field "len(d['books'])")"
check "csv export has a header and rows" 4 "$(curl -s "${AUTH[@]}" "$BASE/api/export?format=csv" | awk 'END{print NR}')"
check "tags endpoint counts tags" "egypt" "$(curl -s "${AUTH[@]}" "$BASE/api/tags" | field "d['tags'][0]['tag']")"
check "stats endpoint totals books" 3 "$(curl -s "${AUTH[@]}" "$BASE/api/stats" | field "d['total']")"

echo "Probe and link check"
open_url="http://127.0.0.1:$FILE_PORT/open/thoth.pdf"
closed_url="http://127.0.0.1:$FILE_PORT/closed/thoth.pdf"
check "probe sees CORS headers" True "$(curl -s "${AUTH[@]}" -G --data-urlencode "url=$open_url" "$BASE/api/probe" | field "d['corsOk']")"
check "probe sees missing CORS headers" False "$(curl -s "${AUTH[@]}" -G --data-urlencode "url=$closed_url" "$BASE/api/probe" | field "d['corsOk']")"
check "probe reads the format" pdf "$(curl -s "${AUTH[@]}" -G --data-urlencode "url=$open_url" "$BASE/api/probe" | field "d['format']")"
check "probe needs the admin token" 401 "$(status -G --data-urlencode "url=$open_url" "$BASE/api/probe")"
live="$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST -d "{\"url\":\"$open_url\"}" "$BASE/api/books")"
live_id="$(echo "$live" | field "d['id']")"
checked="$(curl -s "${AUTH[@]}" -X POST "$BASE/api/books/$live_id/check")"
check "check marks a live link ok" ok "$(echo "$checked" | field "d['link_status']")"
check "check records browser access" True "$(echo "$checked" | field "d['cors_ok']")"
gone="$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST -d "{\"url\":\"http://127.0.0.1:$FILE_PORT/open/missing.pdf\"}" "$BASE/api/books")"
gone_id="$(echo "$gone" | field "d['id']")"
curl -s "${AUTH[@]}" -X POST "$BASE/api/books/$gone_id/check" > /dev/null
second="$(curl -s "${AUTH[@]}" -X POST "$BASE/api/books/$gone_id/check")"
check "two 404s mark a link dead" dead "$(echo "$second" | field "d['link_status']")"
check "dead filter finds it" 1 "$(curl -s "${AUTH[@]}" "$BASE/api/books?link=dead" | field "d['total']")"
check "proxy is off by default" 403 "$(status "${AUTH[@]}" -G --data-urlencode "url=$open_url" "$BASE/api/proxy")"

echo "Delete"
check "delete works" 200 "$(status "${AUTH[@]}" -X DELETE "$BASE/api/books/$id")"
check "deleted book is gone" 404 "$(status "${AUTH[@]}" "$BASE/api/books/$id")"
check "deleted book leaves the search index" 0 "$(curl -s "${AUTH[@]}" "$BASE/api/books?q=thoth" | field "len([b for b in d['items'] if b['id']==$id])")"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
