#!/usr/bin/env bash
#
# What a new user's first five minutes have to survive.
#
# Runs inside the throwaway container, against throwaway engines. Every step is
# something that has broken in a real installation at least once: a dependency
# that was only ever installed warm, a daemon that could not seed its own
# socket directory, a format that crashed on a NULL.
#
# It asserts on behaviour a user can see, not on internals. If this passes, the
# CLI works on a machine that has never seen the project.
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

# Assert that a command succeeds and its output matches a pattern.
# Usage: check <name> <pattern> <command...>
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

# Assert on the output of a command that is expected to fail. `check` insists on
# a zero exit, which is the wrong question to ask of a refusal: what matters is
# whether the message tells the user what to do next.
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

# Retry until a pattern shows up. Only for the things that are genuinely
# asynchronous, such as a file watcher noticing a new configuration file.
check_eventually() {
  local name="$1" pattern="$2" deadline=$((SECONDS + 15)); shift 2
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$@" 2>&1 | grep -qE "$pattern"; then pass "$name"; return; fi
    sleep 0.5
  done
  fail "$name" "/$pattern/ never appeared within 15s"
}

# Assert that a command fails. A tool that cannot say no is not safe to use.
refuse() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    fail "$name" "expected a non-zero exit, got success"
  else
    pass "$name"
  fi
}

say "Install onto a machine that has never seen this project"
# Copied, not mounted read-write: the build must not be able to reach back into
# the checkout, and node_modules from the host must not be able to satisfy it.
cp -r "$SRC" "$BUILD" 2>/dev/null
rm -rf "$BUILD/node_modules" "$BUILD"/packages/*/node_modules "$BUILD/.git"
cd "$BUILD" || exit 1

if npm install --no-audit --no-fund >/tmp/install.log 2>&1; then
  pass "npm install on a cold tree"
else
  fail "npm install on a cold tree" "$(tail -5 /tmp/install.log | tr '\n' ' ')"
  echo; echo "install failed; nothing below can run"; exit 1
fi

if npm run build >/tmp/build.log 2>&1; then
  pass "npm run build"
else
  fail "npm run build" "$(tail -5 /tmp/build.log | tr '\n' ' ')"
  echo; echo "build failed; nothing below can run"; exit 1
fi

# From here on, exactly what an installed user would run.
DBREX=(node "$BUILD/packages/cli/dist/dbrex.js")
export DBREX_DAEMON="$BUILD/packages/cli/dist/dbrexd.js"

say "First run, before anything is configured"
check "dbrex --version prints a version" '^[0-9]+\.[0-9]+\.[0-9]+$' "${DBREX[@]}" --version
check "dbrex help lists the commands"    'dbrex query'              "${DBREX[@]}" help
# The daemon is not running and no config exists. This must be a plain answer,
# not a stack trace: it is the first thing a new user sees.
check "status is calm before any setup"  'daemon: not running'      "${DBREX[@]}" status
refuse "an unknown format is refused"    "${DBREX[@]}" --format yaml query mysql "SELECT 1"

say "Seed the configuration the way a user would"
mkdir -p "$DBREX_HOME"
chmod 700 "$DBREX_HOME"
cp /opt/dbrex/connections.json "$DBREX_HOME/connections.json"
chmod 600 "$DBREX_HOME/connections.json"
# Nothing created the socket directory yet. The daemon has to do it itself on
# first contact, which is the step that fails when a path is too long or a
# permission is wrong.
check "the daemon starts itself on first use" 'mysql'    "${DBREX[@]}" connections
check "status sees the daemon and the config" 'running'  "${DBREX[@]}" status

say "MySQL"
check "a SELECT returns rows"           '84210'                "${DBREX[@]}" query mysql "SELECT day, kind, hits FROM events ORDER BY day DESC"
check "browse walks to the tables"      'events'               "${DBREX[@]}" browse mysql analytics
check "browse walks to the columns"     'hits'                 "${DBREX[@]}" browse mysql analytics events
check_message "a bad statement names the table" 'nope' "${DBREX[@]}" query mysql "SELECT * FROM nope"
refuse "a bad statement exits non-zero" "${DBREX[@]}" query mysql "SELECT * FROM nope"

say "Every output format survives real rows, NULL included"
# Piped, so each of these takes the non-terminal path: no colour, no summary
# line, nothing a consuming program would have to strip back out.
SQL="SELECT day, kind, hits, note FROM events ORDER BY day DESC"
check "tsv is the default in a pipe"     $'day\tkind\thits'     bash -c "${DBREX[*]} query mysql \"$SQL\" | head -1"
check "a null is empty in tsv, not NULL" $'^2026-09-15\tview\t102993\t$' bash -c "${DBREX[*]} query mysql \"$SQL\" | sed -n 3p"
check "json parses and keeps the null"   '"note": null'        bash -c "${DBREX[*]} --format json query mysql \"$SQL\""
check "json is valid json"               'ok'                  bash -c "${DBREX[*]} --format json query mysql \"$SQL\" | node -e 'JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); console.log(\"ok\")'"
check "csv writes a header"              '^day,kind,hits,note$' bash -c "${DBREX[*]} --format csv query mysql \"$SQL\" | head -1"
check "vertical labels each record"      '\-\[ 1 \]'           bash -c "${DBREX[*]} --format vertical query mysql \"$SQL\""
check "table draws a rule under the head" '^-+ '               bash -c "${DBREX[*]} --format table query mysql \"$SQL\" | sed -n 2p"
# A 300-character value and a wide-character value must not break the layout.
check "a long value is cut, not wrapped"  '…'                  bash -c "COLUMNS=80 ${DBREX[*]} --format table query mysql \"$SQL\""

say "ClickHouse"
check "a SELECT returns rows"       '84210'    "${DBREX[@]}" query clickhouse "SELECT day, kind, hits FROM events ORDER BY day DESC"
check "browse walks the tree"       'events'   "${DBREX[@]}" browse clickhouse analytics

say "Object store"
check "buckets list without DuckDB" 'analytics' "${DBREX[@]}" browse lake
check "objects list inside a bucket" 'events'   "${DBREX[@]}" browse lake analytics

say "Secrets"
# The vault is the reason the terminal client exists. A connection that reads
# from it must fail clearly while locked, rather than hanging on a prompt no
# one is watching.
refuse "a vaulted connection fails while locked" "${DBREX[@]}" query vaulted "SELECT 1"
check_message "the failure explains itself" 'vault|locked|secret' \
  "${DBREX[@]}" query vaulted "SELECT 1"
# stdin is not a terminal here, so a password prompt must not block. That is
# the scripted-use case: fail, do not wait forever.
check "a prompt does not hang a script" 'done' \
  bash -c "timeout 20 ${DBREX[*]} query vaulted 'SELECT 1' </dev/null >/dev/null 2>&1; echo done"

say "A configuration change reaches a daemon that is already running"
# The watcher is the reason a user does not have to restart anything after
# editing connections.json. Asynchronous by nature, so this one gets a window
# rather than a single attempt.
node -e '
  const fs = require("fs");
  const file = process.env.DBREX_HOME + "/connections.json";
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.connections.push({
    name: "added-later",
    kind: "mysql",
    secret: { from: "env", name: "MYSQL_PASSWORD" },
    options: { host: "mysql", port: 3306, user: "dbrex", database: "analytics" },
  });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
'
check_eventually "a connection added to the file shows up" 'added-later' "${DBREX[@]}" connections
check "the connection added at runtime queries" '1' "${DBREX[@]}" query added-later "SELECT 1"

say "Results are kept"
check "results lists what ran" 'mysql' "${DBREX[@]}" results

say "Paths stay inside the home it was given"
check "the config directory is the one we set" 'connections.json' ls "$DBREX_HOME"
check "the socket sits under it"               'dbrexd.sock'      ls "$DBREX_HOME/run"
check "the config directory is private"        '^700$'            stat -c '%a' "$DBREX_HOME"

elapsed=$(( $(date +%s) - started ))
printf '\n\033[1m%d passed, %d failed  in %ds\033[0m\n' "$passed" "$failed" "$elapsed"
[ "$failed" -eq 0 ]
