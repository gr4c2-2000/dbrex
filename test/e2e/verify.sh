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

say "PostgreSQL"
check "a SELECT returns rows"            '84210'   "${DBREX[@]}" query postgres "SELECT day, kind, hits FROM events ORDER BY day DESC"
# The tree starts at schemas, not databases: a session cannot query across
# databases, so offering the others would list unreachable tables.
check "browse starts at the schemas"     'public'  "${DBREX[@]}" browse postgres
check "a schema that is not public shows" 'reporting' "${DBREX[@]}" browse postgres
check "browse walks to the tables"       'events'  "${DBREX[@]}" browse postgres public
check "browse walks to the columns"      'hits'    "${DBREX[@]}" browse postgres public events
# Introspection goes through pg_catalog for exactly this: information_schema
# does not list materialized views at all.
check "a materialized view is listed"    'totals'  "${DBREX[@]}" browse postgres reporting
check "and is marked as materialized"    'materialized view' "${DBREX[@]}" browse postgres reporting
check "a plain view is told apart"       'daily'   "${DBREX[@]}" browse postgres reporting
# The identity of the connected database is the server's business, not ours:
# a wrong `database` must fail as a refusal, not as a silent default.
check_message "a bad statement names the relation" 'nope' "${DBREX[@]}" query postgres "SELECT * FROM nope"
refuse "a bad statement exits non-zero"  "${DBREX[@]}" query postgres "SELECT * FROM nope"
# Values the engine formats better than a JS Date can: a jsonb column and a
# timestamp arrive as the server wrote them.
check "a timestamp keeps the server's text" '2026-09-16' "${DBREX[@]}" query postgres "SELECT day FROM events ORDER BY day DESC"
# More rows than one cursor read, so the chunking is exercised rather than
# assumed: 1200 > the 500-row chunk. Asserted on what the daemon stored, not on
# what was printed — the CLI shows at most a thousand rows of any result.
check "a result larger than one chunk arrives whole" '1200 rows' \
  bash -c "${DBREX[*]} query postgres \"SELECT g FROM generate_series(1,1200) g\" >/dev/null && ${DBREX[*]} results 1"

say "SQL Server"
check "a SELECT returns rows"       '84210'   "${DBREX[@]}" query mssql "SELECT kind, hits FROM dbo.events ORDER BY hits DESC"
check "browse lists the schemas"    'reporting' "${DBREX[@]}" browse mssql
check "browse lists the tables"     'events'  "${DBREX[@]}" browse mssql dbo
check "a view is listed too"        'busy'    "${DBREX[@]}" browse mssql dbo
check "browse lists the columns"    'hits'    "${DBREX[@]}" browse mssql dbo events
check "a column carries its type"   'BIGINT|bigint' "${DBREX[@]}" browse mssql dbo events
check "a bracketed name is accepted" '84210'  "${DBREX[@]}" query mssql "SELECT hits FROM [dbo].[events] ORDER BY hits DESC"
check "a non-default schema queries" 'example.com' "${DBREX[@]}" query mssql "SELECT email FROM reporting.users ORDER BY id"
refuse "a bad statement is refused" "${DBREX[@]}" query mssql "SELECT * FROM dbo.nope"
check_message "and names the object" 'nope'   "${DBREX[@]}" query mssql "SELECT * FROM dbo.nope"

say "The row limit SQL Server actually accepts"
# The whole reason LimitSyntax carries a `top` spelling. FETCH FIRST without an
# ORDER BY does not parse in T-SQL, so an unordered SELECT under the default
# limit has to come back with rows rather than a syntax error.
check "an unordered SELECT survives the default limit" 'kind' \
  "${DBREX[@]}" query mssql "SELECT * FROM dbo.events"
# 102993 is the largest, so a respected TOP 1 returns exactly that one row.
check "a statement that limits itself is left alone" '^hits$|102993' \
  "${DBREX[@]}" query mssql "SELECT TOP 1 hits FROM dbo.events ORDER BY hits DESC"
# A TOP would bind to one branch here, so the rewrite declines and the rows are
# bounded on the way out instead.
check "a UNION still returns rows"  'click' \
  "${DBREX[@]}" query mssql "SELECT kind FROM dbo.events UNION SELECT kind FROM dbo.events"
check "DISTINCT keeps its place before TOP" 'click' \
  "${DBREX[@]}" query mssql "SELECT DISTINCT kind FROM dbo.events"
check "a CTE is limited at its outer select" 'click' \
  "${DBREX[@]}" query mssql "WITH c AS (SELECT kind, hits FROM dbo.events) SELECT * FROM c"

say "ClickHouse"
check "a SELECT returns rows"       '84210'    "${DBREX[@]}" query clickhouse "SELECT day, kind, hits FROM events ORDER BY day DESC"
check "browse walks the tree"       'events'   "${DBREX[@]}" browse clickhouse analytics

say "Kafka, before DuckDB exists"
# The split this provider is built around: the tree comes from KafkaJS, which
# is pure JavaScript, so a cluster explores the moment it is configured. The 70
# MB native module is still a decision nobody has made.
check "topics list without DuckDB"       'events'       "${DBREX[@]}" browse bus
check_message "a query says what is missing" 'install-duckdb' \
  "${DBREX[@]}" query bus "SELECT count(*) FROM events"

say "Install DuckDB, the way someone who wants to query would"
check "install-duckdb reports success"   'installed'    "${DBREX[@]}" install-duckdb

say "Kafka"
# The tree is the feature: a cluster explores like a schema does, and expanding
# a topic shows its fields rather than a column of bytes.
check "a topic says how it is spread"    '3 partitions' "${DBREX[@]}" browse bus
check "expanding a topic shows its fields" 'hits'     "${DBREX[@]}" browse bus events
check "and the Kafka metadata alongside" '_offset'    "${DBREX[@]}" browse bus events
# A topic is a table, which is the whole reason the tree can offer a statement
# anyone can read.
# 301: three hundred JSON messages and one that is not JSON at all.
check "a topic queries as a table"       '301'        "${DBREX[@]}" query bus "SELECT count(*) AS n FROM events"
check "the payload is typed, not a blob" '^42$'       bash -c "${DBREX[*]} --format tsv query bus \"SELECT hits FROM events WHERE hits = 42\" | tail -1"
check "metadata columns are there to group by" 'partition' \
  "${DBREX[@]}" query bus "SELECT _partition, count(*) AS n FROM events GROUP BY _partition ORDER BY _partition"
# KafkaJS implements gzip and nothing else. Without our own codecs these four
# fail inside its decoder, one error per topic, nowhere near a provider.
for codec in none gzip snappy lz4 zstd; do
  check "a $codec-compressed topic reads" '^2$' \
    bash -c "${DBREX[*]} --format tsv query bus \"SELECT count(*) FROM 'c-$codec'\" | tail -1"
done
check "a message that is not JSON keeps its body" 'not json at all' \
  "${DBREX[@]}" query bus "SELECT message FROM events WHERE message IS NOT NULL"
check "an empty topic answers instead of failing" '^0$' \
  bash -c "${DBREX[*]} --format tsv query bus \"SELECT count(*) FROM 'empty-topic'\" | tail -1"
check_message "a name that is not a topic says so" 'not a topic' \
  "${DBREX[@]}" query bus "SELECT * FROM nope"
# A query reads a bounded window and never the whole topic. The assertion is
# written as SQL so the check does not have to parse a count out of a table.
check "a small budget bounds what a query reads" 'true' \
  "${DBREX[@]}" query bus-sampled "SELECT count(*) <= 20 AS within_budget FROM events"

say "Elasticsearch, over SQL"
# The free path. Elastic puts the SQL REST API in Basic and the JDBC driver
# behind a paid tier, so this is the surface a JDBC-based tool cannot reach.
check "a SELECT returns rows"            '84210'   "${DBREX[@]}" query es "SELECT kind, hits FROM events ORDER BY hits DESC"
check "an aggregate works"               '3'       "${DBREX[@]}" query es "SELECT count(*) AS n FROM events"
check "a quoted index name is accepted"  '84210'   "${DBREX[@]}" query es 'SELECT hits FROM "events" ORDER BY hits DESC'
check "a full-text predicate works"      'ordinary' "${DBREX[@]}" query es "SELECT note FROM events WHERE MATCH(note, 'ordinary')"
refuse "a bad statement is refused"      "${DBREX[@]}" query es "SELECT * FROM nope"
check_message "and names what was wrong" 'nope|not_found|Unknown index' "${DBREX[@]}" query es "SELECT * FROM nope"

say "Elasticsearch, over Query DSL"
# The path for a cluster whose SQL surface is absent. Written the way Kibana's
# console writes it, because that is where these bodies get copied from.
check "a console-style request runs" '84210' \
  "${DBREX[@]}" query es 'POST /events/_search
{ "size": 10, "sort": [{ "hits": "desc" }] }'
check "the document metadata comes back" '_id' \
  "${DBREX[@]}" query es 'POST /events/_search
{ "size": 1 }'
# No path and no verb: the connection's own index supplies it.
check "a bare body uses the connection index" 'scroll' \
  "${DBREX[@]}" query es-events '{ "query": { "term": { "kind": "scroll" } } }'
check_message "a bare body needs an index to go to" 'needs an index' \
  "${DBREX[@]}" query es '{ "query": { "match_all": {} } }'
check_message "a malformed body says so" 'JSON' \
  "${DBREX[@]}" query es 'POST /events/_search
{ "query": '

say "Elasticsearch schema"
check "indices list as tables"      'events'  "${DBREX[@]}" browse es
check "the mapping lists fields"    'hits'    "${DBREX[@]}" browse es events
# A text field is not aggregatable, so the .keyword multi-field is what a
# GROUP BY actually needs and the tree has to offer it.
check "a multi-field is offered"    'note.keyword' "${DBREX[@]}" browse es events
check "a nested object is flattened to its dotted name" 'client.ip' "${DBREX[@]}" browse es events
# A connection pinned to one index offers only that one, so the tree cannot
# wander onto indices this connection was not meant to reach.
check "a scoped connection browses only its index" 'events' "${DBREX[@]}" browse es-events

say "A local directory, as a tree"
/opt/dbrex/seed-dir.sh /home/dbrex/data >/dev/null
# That browsing needs no DuckDB at all is a unit test; by this point in the run it
# is installed, so claiming it here would be claiming something not being tested.
check "the folder lists its files"       'top.csv'  "${DBREX[@]}" browse files
check "a subdirectory is a container"    'events'   "${DBREX[@]}" browse files
check "it descends"                      'part-0.csv' "${DBREX[@]}" browse files events "day=2026-10-01"
check "a file carries its size"          'B$|KB'    "${DBREX[@]}" browse files
check "the include glob filters"         'top.csv'  "${DBREX[@]}" browse files-csv-only
# README has no .csv extension, so the folder holding it is not in the index and
# must not appear in the tree either.
check "and leaves out what it excludes" '^clean$' \
  bash -c "${DBREX[*]} browse files-csv-only | grep -q docs && echo dirty || echo clean"

say "A local directory, queried"
check "the file index is queryable"      'top.csv'  "${DBREX[@]}" query files "SELECT name, extension, size FROM dbrex_files ORDER BY name"
check "a CSV in the root reads"          '84210'    "${DBREX[@]}" query files "SELECT hits FROM read_csv_auto('/home/dbrex/data/top.csv') ORDER BY hits DESC"
check "a CSV in a subdirectory reads"    '7'        "${DBREX[@]}" query files "SELECT hits FROM read_csv_auto('/home/dbrex/data/events/day=2026-10-01/part-0.csv')"
check "a JSON file reads"                'x'        "${DBREX[@]}" query files "SELECT b FROM read_json_auto('/home/dbrex/data/events/events.ndjson') ORDER BY a"
check "a glob across the folder reads"   '2'        "${DBREX[@]}" query files "SELECT count(DISTINCT kind) FROM read_csv_auto('/home/dbrex/data/*.csv')"
check "the index joins to the data"      'top.csv'  "${DBREX[@]}" query files "SELECT name FROM dbrex_files WHERE extension = 'csv' AND size > 20"

say "The directory is a boundary, not a suggestion"
# DuckDB reads any path it is handed, so this is the property that makes the
# provider safe rather than merely scoped. Verified against the real engine.
refuse "a file outside the root is refused" \
  "${DBREX[@]}" query files "SELECT * FROM read_csv_auto('/home/dbrex/dir-outside/private.csv')"
check_message "and says it was a permission" 'Permission|not allowed|Cannot access' \
  "${DBREX[@]}" query files "SELECT * FROM read_csv_auto('/home/dbrex/dir-outside/private.csv')"
refuse "/etc/passwd is refused" \
  "${DBREX[@]}" query files "SELECT * FROM read_csv('/etc/passwd')"
refuse "a statement cannot widen the allow list" \
  "${DBREX[@]}" query files "SET allowed_directories=['/']"
refuse "a statement cannot re-enable external access" \
  "${DBREX[@]}" query files "SET enable_external_access=true"
# And having tried, the connection still works: the refusal is not a broken session.
check "the session survives a refused escape" 'top.csv' \
  "${DBREX[@]}" query files "SELECT name FROM dbrex_files"

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

say "The interactive shell"
# Driven down a pipe rather than a terminal. Tab cannot travel through a pipe,
# so completion is covered by unit tests; what this proves is the part that
# only breaks against a real server: the session opens, runs, and closes.
check "a shell session runs a statement" '84210' \
  bash -c "printf 'SELECT hits FROM events ORDER BY hits DESC;\n' | ${DBREX[*]} shell mysql"
check "a statement may span several lines" '84210' \
  bash -c "printf 'SELECT hits\nFROM events\nORDER BY hits DESC;\n' | ${DBREX[*]} shell mysql"
check "the format can be changed mid-session" '"hits"' \
  bash -c "printf '\\\\f json\nSELECT hits FROM events LIMIT 1;\n' | ${DBREX[*]} shell mysql"
check "a connection can be changed mid-session" 'now on clickhouse' \
  bash -c "printf '\\\\c clickhouse\nSELECT 1;\n' | ${DBREX[*]} shell mysql"
check "a bad statement does not end the session" '84210' \
  bash -c "printf 'SELECT * FROM nope;\nSELECT hits FROM events ORDER BY hits DESC;\n' | ${DBREX[*]} shell mysql 2>/dev/null"
check "the schema lists from inside the shell" 'events' \
  bash -c "printf '\\\\d analytics\n' | ${DBREX[*]} shell mysql"
check "history is written" 'SELECT 1' \
  bash -c "printf 'SELECT 1;\n' | ${DBREX[*]} shell mysql >/dev/null 2>&1; cat \"$DBREX_HOME/history\""

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

say "History says where a query came from"
# An agent's exploration and a person's own work land in the same list. Without
# this they are indistinguishable once the query has finished.
check "a terminal query is marked cmd" 'cmd' "${DBREX[@]}" results
# grep -E has no negative lookahead, so the absence is checked by a command that
# reports it rather than by a pattern that cannot express it.
check "no origin prints as undefined" '^clean$' \
  bash -c "${DBREX[*]} results | grep -q undefined && echo dirty || echo clean"

say "Results are kept"
check "results lists what ran" 'mysql' "${DBREX[@]}" results

say "Paths stay inside the home it was given"
check "the config directory is the one we set" 'connections.json' ls "$DBREX_HOME"
check "the socket sits under it"               'dbrexd.sock'      ls "$DBREX_HOME/run"
check "the config directory is private"        '^700$'            stat -c '%a' "$DBREX_HOME"

elapsed=$(( $(date +%s) - started ))
printf '\n\033[1m%d passed, %d failed  in %ds\033[0m\n' "$passed" "$failed" "$elapsed"
[ "$failed" -eq 0 ]
