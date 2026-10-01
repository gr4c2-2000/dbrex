# DbRex

Query databases from `.sql` files in VSCode, and let an AI work the same
connections through MCP.

> **Deep beta.** This is early, pre-release software under active development.
> Interfaces, the connection file format and the on-disk layout of `~/.dbrex`
> can all change without a migration path. There is no published release yet —
> you build it from source. Do not point it at anything you cannot afford to
> have a query run against.

Connections, credentials and results live in a small local daemon (`dbrexd`), not
in the editor. The editor is one client; a terminal is another; an AI agent over
MCP is a third. Closing the window closes a display, not the machinery — an
agent keeps working.

- `Ctrl+Enter` runs the statement under the cursor, `Ctrl+Shift+Enter` the file.
- `-- @conn: name` and `-- @limit: n` steer individual statements.
- `-- @kind: mysql` and friends let a file carry a whole connection, for a
  database that is not worth a config entry.
- **DbRex: Copy MCP Setup Command** gives you the one line that connects an agent.
- Passwords are never accepted from an agent: the daemon routes the prompt to
  this window or to a terminal, and only those may answer.

MySQL, PostgreSQL, ClickHouse, Trino (including SSO), S3-compatible object
stores and Kafka. RisingWave needs no connector of its own: it speaks the
PostgreSQL wire protocol, so `kind: postgres` on port 4566 is the whole of it.

Buckets browse out of the box over plain HTTPS. *Querying* files needs DuckDB,
which is a 70 MB native component, so it is not bundled — run `dbrex
install-duckdb` once if you want it.

## Install

```bash
curl -sSL https://raw.githubusercontent.com/gr4c2-2000/dbrex/main/install.sh | sh
```

Checks for a Node 18 or newer, builds from source, installs the `dbrex` command
into `~/.dbrex/bin` and links it into `~/.local/bin`, then installs the VSCode
extension if it finds an editor. `--cli-only` skips the extension.

The CLI half needs no editor. That is deliberate: the daemon is meant to outlive
the editor, so it has to be installable without one.

From a clone:

```bash
./install.sh
```

## Layout

```
packages/core        shared types, connection specs, SQL statement splitting
packages/daemon      dbrexd — sessions, providers, secret vault, result store
packages/client      the protocol clients speak to the daemon
packages/cli         dbrex — terminal client and the MCP stdio bridge
packages/extension   the VSCode extension, which ships the daemon and the CLI
                     (its `webview/` holds the result panel front-end)
```

## Build

```bash
npm install
npm run typecheck
npm test
npm run build
```

Package the extension:

```bash
cd packages/extension
npx @vscode/vsce package --no-dependencies --allow-missing-repository --out dbrex.vsix
code --install-extension dbrex.vsix
```

## CLI

```
dbrex shell [conn]                 interactive session; Tab completes from the server
dbrex status                       is the daemon up, is the vault unlocked
dbrex connections                  list connections and what they are for
dbrex query <conn> <sql>           run one statement and print the rows
dbrex query [conn] -f <file.sql>   run a file; the name is optional when the
                                   file defines its own connection
dbrex browse <conn> [path...]      walk the schema tree
dbrex unlock                       unlock the secret vault for this daemon
dbrex set-password <conn>          store a password for a connection
dbrex results [n]                  recent stored results
dbrex install-duckdb               add DuckDB, needed to query object stores
dbrex mcp                          serve MCP over stdio (for AI agents)
dbrex stop                         stop the daemon
```

## Output

A terminal gets a table sized to it, with numbers right-aligned and NULL dimmed
so it cannot be mistaken for the string `"NULL"`. A pipe gets TSV and no summary
line, because the next thing in the pipe is a program. `--format` overrides
either: `table`, `json`, `csv`, `tsv` or `vertical`.

```bash
dbrex query prod "SELECT ..." --format json | jq '.[0].hits'
dbrex query prod "SELECT ..." --format vertical    # one field per line
```

A table that does not fit shrinks its widest columns and marks what it cut. It
never drops a column: a missing column reads as "the query returned no such
column", which is not a thing a database tool may imply.

## Verifying an installation

`npm test` proves the code is self-consistent. `make verify` proves two things
it cannot, in containers that have never seen dbrex:

- `make verify-install` runs `install.sh` on a machine with no build and nothing
  on PATH, then checks that `dbrex` answers — including after its build
  directory is deleted, and when it is installed a second time.
- `make verify-run` queries real MySQL, PostgreSQL, ClickHouse, Redpanda and
  MinIO. The Kafka half reads one topic per compression codec, because that is
  where a reader actually breaks.
- `make verify-risingwave` does the same against RisingWave, which shares the
  PostgreSQL provider. Opt-in, and not part of `make verify`, because the image
  is 11 GB — but it is the only thing that can prove the shared introspection
  still works on both engines.

They are separate because a working build is no evidence that an installation
works. Requires Docker; everything they start is thrown away afterwards.

```bash
make verify
```

## Configuration

Connections live in `~/.dbrex/connections.json`, or in a workspace's own
`.dbrex/connections.json`. Passwords do not: they go to the daemon's encrypted
vault, an environment variable, or a command (`op read ...`), whichever the
connection declares.

### PostgreSQL and RisingWave

One provider serves both. What that costs is written into the introspection:
it stays on `pg_catalog` and calls no server-side function, because that is the
subset both engines implement. `information_schema` would have been the more
standard choice and is the wrong one — PostgreSQL omits materialized views from
it entirely, and in RisingWave a materialized view is the main thing anyone
wants to look at.

The browse tree starts at schemas rather than databases. A PostgreSQL session
is bound to one database and cannot join across them, so a tree offering the
others would list tables that session cannot query.

```json
{ "name": "warehouse", "kind": "postgres",
  "host": "db.internal", "port": 5432, "user": "analyst",
  "database": "analytics", "sslmode": "verify-full",
  "secret": { "from": "command", "argv": ["op", "read", "op://work/warehouse/password"] } }
```

`sslmode` takes the `libpq` spellings: `disable` (the default, for a container
on localhost), `require` to encrypt without judging the certificate, `verify-ca`
to check the chain, `verify-full` to check the hostname as well. Through an SSH
tunnel the name verified is still the real one, not the local end.

For RisingWave the only differences are the port and the database name:

```json
{ "name": "stream", "kind": "postgres",
  "host": "localhost", "port": 4566, "user": "root", "database": "dev" }
```

Materialized views appear in the tree marked as such, and `CREATE MATERIALIZED
VIEW`, `CREATE SOURCE` and `CREATE SINK` are offered by completion.

### Kafka

A cluster explores like a schema: topics at the top, and expanding one shows
its fields, worked out from a sample of its messages. Clicking a topic gives
you a statement you can read.

```json
{ "name": "bus", "kind": "kafka", "brokers": "kafka-1:9092,kafka-2:9092" }
```

```sql
SELECT *
FROM "order-events"
LIMIT 100
```

A topic is a table. The messages a statement needs are pulled into DuckDB and
the statement then runs verbatim, so a JSON payload arrives as typed columns
rather than as bytes:

```sql
SELECT _partition, count(*) AS n, max(_offset) AS latest
FROM order_events
GROUP BY _partition;
```

Every message carries `_partition`, `_offset`, `_timestamp` and `_key` beside
its own fields. A payload field of the same name wins — it is your data.

Browsing needs nothing installed: the tree comes from KafkaJS, which is pure
JavaScript. Querying needs DuckDB, the same 70 MB as the object store, and the
same `dbrex install-duckdb`.

A topic's window is read once per session: the first query on a topic pays for
the read, the next one answers from what is already there. Expanding a topic in
the tree pays separately, for a smaller sample.

On a cluster of more than 64 topics the listing shows partitions but no message
counts. Kafka has no bulk size call — it is one round trip per topic, and a
real cluster of 515 answered 29 counts a second however hard it was asked, so
counting them all cost twenty seconds of a sidebar. Below that threshold the
counts are there, which is where "0 messages" is worth seeing.

What this is **not** is a streaming consumer. Every query reads a bounded
window — by default the last 1000 messages of the topic, spread across its
partitions so one hot partition does not eat the whole budget — and nothing is
kept between sessions. Nothing is ever committed: offsets come from seeking to
a computed position, never from a consumer group's memory.

| Option | |
|---|---|
| `brokers` | `host:9092,host2:9092`. Required |
| `user` + password | SASL. Omit both for an unauthenticated cluster |
| `saslMechanism` | `plain`, `scram-sha-256`, `scram-sha-512` |
| `ssl` | TLS. `SASL_SSL` is this plus a user |
| `format` | `json` infers the fields; `text` keeps the body in one column |
| `startPosition` | `latest` reads the tail, `earliest` the head |
| `sampleMessages` | How many messages a query pulls per topic. Default 1000 |

Compressed topics read: gzip, snappy, lz4 and zstd. KafkaJS implements only
gzip, so the other three are decompressed here, in pure JavaScript — except
zstd, which uses Node's own and therefore needs Node 22.15 or newer.

A tunnel does not apply to this kind, and the daemon says so rather than
pretending: a cluster answers metadata with its own advertised listeners, and
the client goes there next.

For a topic that has to land somewhere durable and keep up, this is the wrong
tool and an engine built for it is the right one — RisingWave's `CREATE TABLE
... WITH (connector = 'kafka')`, reachable through the postgres provider above.

### A connection the file carries itself

A container you started this morning and will throw away this afternoon does not
deserve an entry in a config file. `-- @kind:` says the comments above a
statement describe a connection, and every other directive that is not `@conn`,
`@limit` or `@password` is an option of that kind:

```sql
-- @kind: mysql
-- @host: 127.0.0.1
-- @port: 3306
-- @user: root
-- @password: $env:MYSQL_ROOT_PASSWORD
-- @database: app

SELECT id, email FROM users ORDER BY id DESC;
```

Running that works in the editor and from the terminal, where the name on the
command line becomes optional:

```bash
dbrex query -f scratch.sql
```

The options each kind accepts are the ones `dbrex connections` documents for it,
and a mistake is reported as a config error before anything connects, listing
every bad option at once. Without `-- @conn:` the connection is named after
where it points — `mysql/127.0.0.1:3306` — which is what shows up in the results
history; add `-- @conn: docker` to name it yourself.

Nothing about it is written anywhere. It belongs to the workspace the file is
in — this window, a terminal in the same repository and an agent working on it
all see it, so "run this file for me" needs no configuration on the agent's side;
`list_connections` shows it the same as any other. It is forgotten once the last
client for that workspace disconnects, and its password never reaches the vault.
Editing the directives and running again reconnects; running again unchanged
keeps the session it already had.

A few things worth knowing before putting a password in a file:

- Whoever can read the .sql file can read the password, and `git` is very good
  at remembering files. `$env:NAME` is read from the daemon's environment and
  keeps the secret out of the file.
- An agent may use a connection the workspace defined, and may define one
  itself, but it may never supply the password for one — the same rule as
  everywhere else. What it never gets is the password's value: it queries
  through the daemon, which holds the credential the file gave it.
- Leave `@password` out and the daemon asks this window or a terminal for one,
  exactly as it would for a configured connection.

## License

MIT. See [LICENSE](LICENSE).
