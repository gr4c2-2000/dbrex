#!/bin/sh
#
# One index, documents that disagree about which fields they have.
#
# A mounted script rather than an inline compose entrypoint because `_bulk`
# needs real newlines, and a YAML folded block turns them into spaces.
set -eu

ES="${ES:-http://elasticsearch:9200}"

# Fields chosen to exercise the tree as much as the query: a text field with a
# .keyword multi-field, because text is not aggregatable and the keyword is what
# a GROUP BY needs; and an object, because its fields have to flatten to dotted
# names.
curl -sf -XPUT "$ES/events" -H 'content-type: application/json' -d '{
  "mappings": {
    "properties": {
      "day":    { "type": "date" },
      "kind":   { "type": "keyword" },
      "hits":   { "type": "long" },
      "note":   { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "client": { "properties": { "ip": { "type": "ip" } } }
    }
  }
}' > /dev/null

# The third document has no `note` and the second has no `client`, so a search
# page has a union to take its shape from rather than one fixed row.
curl -sf -XPOST "$ES/events/_bulk?refresh=wait_for" \
  -H 'content-type: application/x-ndjson' --data-binary @- > /dev/null <<'NDJSON'
{"index":{"_id":"1"}}
{"day":"2026-09-16","kind":"click","hits":84210,"note":"ordinary","client":{"ip":"10.0.0.1"}}
{"index":{"_id":"2"}}
{"day":"2026-09-15","kind":"view","hits":102993,"client":{"ip":"10.0.0.2"}}
{"index":{"_id":"3"}}
{"day":"2026-09-14","kind":"scroll","hits":7,"note":"日本語のテキスト"}
NDJSON

echo "seeded $(curl -sf "$ES/events/_count" | sed 's/.*"count":\([0-9]*\).*/\1/') documents"
