#!/bin/sh
#
# A folder to point a `dir` connection at.
#
# Shapes chosen so the readers are actually exercised: a CSV at the top, one in
# a subdirectory, a JSON file, and a file that is deliberately outside the root
# so the confinement has something real to refuse.
set -eu

ROOT="${1:?root}"
rm -rf "$ROOT"
mkdir -p "$ROOT/events/day=2026-10-01" "$ROOT/docs"

printf 'day,kind,hits\n2026-09-16,click,84210\n2026-09-15,view,102993\n' > "$ROOT/top.csv"
printf 'day,kind,hits\n2026-10-01,scroll,7\n' > "$ROOT/events/day=2026-10-01/part-0.csv"
printf '{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n' > "$ROOT/events/events.ndjson"
printf 'not data\n' > "$ROOT/docs/README"

# Outside the root on purpose: nothing in the connection may reach this.
mkdir -p "$ROOT/../dir-outside"
printf 'secret\n42\n' > "$ROOT/../dir-outside/private.csv"

echo "seeded $(find "$ROOT" -type f | wc -l) files"
