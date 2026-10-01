#!/usr/bin/env bash
#
# The claim this script exists to check: RisingWave needs no provider of its
# own, because it speaks the PostgreSQL wire protocol and serves pg_catalog.
#
# That claim is cheap to make and easy to get wrong. The introspection SQL is
# deliberately written to the subset both engines implement — pg_namespace,
# pg_class, pg_attribute, pg_type, and no server-side function such as
# format_type — and nothing but a real RisingWave can prove it still holds.
#
# Separate from verify.sh, behind the `risingwave` compose profile, because the
# image is 11 GB. `make verify` has to stay affordable.
set -uo pipefail

SRC=/src
BUILD=/home/dbrex/build
export DBREX_HOME="${DBREX_HOME:-/home/dbrex/.dbrex}"

passed=0
failed=0
started=$(date +%s)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
pass() { passed=$((passed + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() {
  failed=$((failed + 1))
  printf '  \033[31m✗\033[0m %s\n' "$1"
  [ $# -gt 1 ] && printf '      %s\n' "$2"
}

check() {
  local name="$1" pattern="$2"; shift 2
  local out status
  out="$("$@" 2>&1)"; status=$?
  if [ "$status" -ne 0 ]; then
    fail "$name" "exit $status: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  elif ! printf '%s' "$out" | grep -qE "$pattern"; then
    fail "$name" "no match for /$pattern/ in: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  else
    pass "$name"
  fi
}

check_message() {
  local name="$1" pattern="$2"; shift 2
  local out
  out="$("$@" 2>&1)"
  if printf '%s' "$out" | grep -qE "$pattern"; then
    pass "$name"
  else
    fail "$name" "no match for /$pattern/ in: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  fi
}

say "Build"
cp -r "$SRC" "$BUILD" 2>/dev/null
rm -rf "$BUILD/node_modules" "$BUILD"/packages/*/node_modules "$BUILD/.git"
cd "$BUILD" || exit 1

if npm install --no-audit --no-fund >/tmp/install.log 2>&1; then
  pass "npm install on a cold tree"
else
  fail "npm install on a cold tree" "$(tail -5 /tmp/install.log | tr '\n' ' ')"
  exit 1
fi

if npm run build >/tmp/build.log 2>&1; then
  pass "npm run build"
else
  fail "npm run build" "$(tail -5 /tmp/build.log | tr '\n' ' ')"
  exit 1
fi

DBREX=(node "$BUILD/packages/cli/dist/dbrex.js")
export DBREX_DAEMON="$BUILD/packages/cli/dist/dbrexd.js"

mkdir -p "$DBREX_HOME"
chmod 700 "$DBREX_HOME"
cp /opt/dbrex/connections.json "$DBREX_HOME/connections.json"
chmod 600 "$DBREX_HOME/connections.json"

say "Seed RisingWave through dbrex itself"
# The image ships no psql, which turns out to be useful: seeding through our own
# CLI means the DDL path is exercised before anything reads it back. A
# materialized view is not decoration here — it is what RisingWave is for.
cat > /tmp/seed.sql <<'SEED'
CREATE TABLE events (day DATE, kind VARCHAR, hits BIGINT);
INSERT INTO events VALUES
  ('2026-09-16', 'click', 84210),
  ('2026-09-15', 'view', 102993),
  ('2026-09-14', 'NULL', 7);
FLUSH;
CREATE MATERIALIZED VIEW totals AS SELECT kind, sum(hits) AS hits FROM events GROUP BY kind;
SEED
if "${DBREX[@]}" query risingwave -f /tmp/seed.sql >/tmp/seed.log 2>&1; then
  pass "a table, an insert and a materialized view all run"
else
  fail "a table, an insert and a materialized view all run" "$(tail -3 /tmp/seed.log | tr '\n' ' ')"
  echo; echo "nothing below can run"; exit 1
fi

say "RisingWave over the postgres provider"
check "a SELECT returns rows"              '84210'  "${DBREX[@]}" query risingwave "SELECT day, kind, hits FROM events"
check "browse starts at the schemas"       'public' "${DBREX[@]}" browse risingwave
# rw_catalog is RisingWave's own metadata and is filtered out with pg_catalog.
check "the engine's own catalog is hidden" 'clean' \
  bash -c "${DBREX[*]} browse risingwave | grep -qv rw_catalog && echo clean"
check "browse walks to the tables"         'events' "${DBREX[@]}" browse risingwave public
check "a materialized view is listed"      'totals' "${DBREX[@]}" browse risingwave public
check "and is marked as materialized"      'materialized view' "${DBREX[@]}" browse risingwave public
check "browse walks to the columns"        'hits'   "${DBREX[@]}" browse risingwave public events
check "a column keeps its engine type"     'int8|bigint' "${DBREX[@]}" browse risingwave public events
check "the materialized view can be read"  '84210'  "${DBREX[@]}" query risingwave "SELECT kind, hits FROM totals"
check_message "a bad statement is refused" '.' "${DBREX[@]}" query risingwave "SELECT * FROM nope"

say "Streaming and limits"
# Asserted on what the daemon stored: the CLI prints at most a thousand rows.
check "a result larger than one chunk arrives whole" '1200 rows' \
  bash -c "${DBREX[*]} query risingwave \"SELECT g FROM generate_series(1,1200) g\" >/dev/null && ${DBREX[*]} results 1"
printf -- '-- @limit: 2\nSELECT g FROM generate_series(1,1200) g;\n' > /tmp/limited.sql
check "a directive limit stops short"      '^2$' \
  bash -c "${DBREX[*]} --format tsv query risingwave -f /tmp/limited.sql | tail -n +2 | wc -l"

say "A connection the file carries itself"
# The password is here because leaving it out means "ask a human", and nothing
# in this container can answer. RisingWave accepts any password for root, which
# is also why the connections file can point at it with a value it never reads.
cat > /tmp/inline.sql <<'INLINE'
-- @kind: postgres
-- @host: risingwave
-- @port: 4566
-- @user: root
-- @password: unused-by-risingwave
-- @database: dev

SELECT kind, hits FROM totals;
INLINE
check "no name on the command line is needed" '84210' "${DBREX[@]}" query -f /tmp/inline.sql

elapsed=$(( $(date +%s) - started ))
printf '\n\033[1m%d passed, %d failed in %ds\033[0m\n' "$passed" "$failed" "$elapsed"
[ "$failed" -eq 0 ] || exit 1
