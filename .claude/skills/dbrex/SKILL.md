---
name: dbrex
description: Query MySQL, PostgreSQL, SQL Server, ClickHouse, Trino, Kafka, Elasticsearch and S3-compatible object stores through the DbRex daemon over MCP. Use when asked to inspect a schema, run SQL, read query results, or find which database holds something. Covers choosing the right workspace first, and not disturbing results a person is reading.
---

# DbRex

One local daemon owns the connections, the credentials and the stored results.
You reach it over MCP; a person reaches the same daemon from their editor and
from a terminal at the same time. Two consequences shape everything below: the
connections you can see depend on a workspace, and the panel you can write to is
being read by someone.

## Choose the workspace before the first query

A workspace scopes which connections exist. The wrong one does not produce an
error — it makes the right connection *missing*, and the honest-looking
conclusion is "that database is not configured", which is wrong.

1. Call `list_workspaces`. It marks which one is in effect and how many
   connections each one reaches.
2. If more than one is listed and none is obviously right, **show the list and
   ask which one**. Do not choose for them.
3. Call `use_workspace` with the chosen path. It takes effect at once; nothing
   needs restarting.

Skip the question only when `list_workspaces` returns a single entry, or when
the user has already named the workspace in this conversation.

Never infer the workspace from a file path you happen to have read. A checkout
on disk is not evidence that its connections are the ones wanted.

## Read the connection before querying it

`list_connections` returns a free-text `reference` for each connection, written
by whoever configured it: what the database holds, which schema docs to read,
what not to touch. Read it. It is the cheapest context available and it is there
because the schema alone does not say what the data means.

It also returns each engine's capabilities. They differ in ways that change what
you should write — some engines have no joins, some cannot cancel a query, some
limit rows with a clause you would not guess. Do not assume a dialect.

## Do not disturb what someone is reading

The results panel has two lanes. Yours is labelled "Agent" and is separate from
the person's, so a query you run no longer replaces what they are looking at.
This holds as long as you use `execute_query` and `inject_result` normally.

Still: `inject_result` puts something on their screen. Use it when it helps them
see what you found, not to narrate your progress.

## Running statements

- One statement per `execute_query`. No trailing semicolon.
- A row limit is pushed into the SQL when the dialect allows it, so it bounds
  what the *server* does, not just what you receive. Set `rowLimit` when you
  only need a sample; do not rely on reading fewer rows to make a big query
  cheap.
- `execute_query` returns a preview plus a `resultId`. Use `read_result` to page
  the rest rather than re-running the query.
- `browse` walks the schema tree one level at a time. Prefer it to
  `SELECT * FROM information_schema...`: it works the same way on an object
  store, a Kafka topic and an Elasticsearch index, none of which has an
  information schema.

## Never ask for a password

The daemon will not give you one and will not route a credential prompt to you —
by design, because a secret typed into a chat lands in a transcript. If a
connection needs a human to unlock something, say so and stop. Do not look for
the credential elsewhere, and do not suggest putting it in a file you can read.

## When a query fails

The error carries the engine's own message, a code, and often a hint. Read all
three before changing the statement. In particular:

- `not_found` means the object does not exist in *this* workspace's connection —
  which may mean the workspace is wrong, not the name.
- `auth` means a human has to act. Report it; do not retry.
- A statement carrying a `-- @conn:` directive in its middle is refused rather
  than run, because the directive is not in effect there. Put the statement in
  its own statement.
