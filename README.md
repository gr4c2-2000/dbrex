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

MySQL, PostgreSQL, SQL Server, ClickHouse, Trino (including SSO), S3-compatible
object stores, Kafka, and Elasticsearch with OpenSearch.

Several engines need no connector of their own, because they already speak one
of these wires. RisingWave serves the PostgreSQL protocol, so `kind: postgres`
on port 4566 is the whole of it. Azure SQL, Synapse and Fabric are all
`kind: mssql`. StarRocks and Apache Doris speak the MySQL protocol, so
`kind: mysql` reaches them on port 9030. Amazon Redshift answers a
PostgreSQL-derived wire on 5439 and `kind: postgres` connects in practice —
though AWS does not document that path and steers you to its own drivers, so
treat it as working rather than supported.

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

## The Connections view

Named for what it holds. It lists connections and expands into whatever each one
has underneath — databases and tables for a relational engine, buckets and
objects for a store, topics for Kafka, indices for Elasticsearch. "Schema" was
accurate for the first two engines and wrong for the rest.

The view's title bar adds a connection, searches, and refreshes. Each connection
row carries three actions:

- **Add Password** stores a credential in the daemon's vault
- **Change a Setting** asks the provider which options it accepts and edits the
  one you choose, in the file the connection came from
- **Delete Connection** removes the entry, after a confirmation naming the file

A connection declared inside a `.sql` file by its own `-- @kind` directives has
no entry to edit or delete; the statement that defines it is the place to change
it, and the view says so rather than failing.

**Add Connection** builds its form from what the daemon says each provider
accepts, so choosing a kind asks for that engine's own fields and a provider
added later needs no wizard of its own. It asks where the connection should
live — `~/.dbrex/connections.json` for just you, or the workspace's
`.dbrex/connections.json` which you can commit — then opens the file it wrote.

## Workspaces

A workspace decides which connections exist. The wrong one does not fail — it
makes the right connection *missing*, which reads as though DbRex lost a
database.

**DbRex: Select Workspace** offers the folders this window has open together
with the workspaces the daemon is already serving for other windows and agents,
and says how many connections each one reaches. The choice applies at once and
survives the daemon idling out; it is deliberately not remembered across a
window reload, because which environment a window points at should not come back
unasked.

An agent gets the same choice through `list_workspaces` and `use_workspace`, so
one MCP bridge can be pointed at a different checkout mid-session instead of
being restarted. `.claude/skills/dbrex/SKILL.md` tells it to ask rather than
assume.

## Two lanes in the results panel

An agent and a person share one results panel. They no longer share one slot:
the panel has a **Mine** and an **Agent** tab, and a query one of them runs
cannot replace what the other is reading. A result arriving in the lane you are
not looking at marks its tab rather than pulling you to it. Running a query
yourself does switch to your own lane, because that is what you just asked to
see.

The tabs stay hidden until an agent has actually run something.

## Where a result came from

Every stored result records which kind of client ran it, so one history written
by three clients stays legible:

```bash
$ dbrex results
8f2a…  pin  mcp     1 203 rows  prod  SELECT day, count(*) FROM events …
41b9…       vscode     18 rows  prod  SELECT * FROM users WHERE id = 1
c7d0…       cmd           1 row  prod  SELECT version()
```

The same label appears in the Results view in the editor, with the client's own
name in the tooltip.

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

### SQL Server, Azure SQL, Synapse and Fabric

One `kind: mssql` for all four: the same TDS wire, the same T-SQL, the same
`INFORMATION_SCHEMA`.

```json
{
  "name": "warehouse",
  "kind": "mssql",
  "secret": { "from": "vault" },
  "options": {
    "host": "sql.example",
    "port": 1433,
    "user": "$user",
    "database": "analytics",
    "encrypt": true
  }
}
```

**Fabric and Entra-only servers cannot use a password.** Microsoft's own
documentation says SQL authentication is unsupported there. Set `auth` to
`token` and let the secret source produce one, which makes the Azure CLI the
whole of the credential:

```json
{
  "name": "fabric",
  "kind": "mssql",
  "secret": {
    "from": "command",
    "argv": ["az", "account", "get-access-token",
             "--resource", "https://database.windows.net/",
             "--query", "accessToken", "-o", "tsv"]
  },
  "options": {
    "host": "xxx.datawarehouse.fabric.microsoft.com",
    "database": "mywarehouse",
    "auth": "token"
  }
}
```

For a local container, `trustServerCertificate: true` accepts a self-signed
certificate. Do not set it against a managed service — it turns off the check
that the server is the one you meant.

The default row limit is appended as `SELECT TOP n`, not `FETCH FIRST n ROWS
ONLY`. T-SQL only allows `FETCH` after an `OFFSET`, and `OFFSET` only after an
`ORDER BY`, so the standard clause would be a syntax error on an unordered
statement rather than a smaller result. A statement with `UNION`, `EXCEPT` or
`INTERSECT` is left alone and the rows are bounded on the way out instead: a
`TOP` would bind to one branch and quietly limit the wrong thing.

### Elasticsearch and OpenSearch

One `kind: elasticsearch` for both. Which fork a cluster is comes from asking it
at connect, not from declaring it: OpenSearch serves its SQL on
`/_plugins/_sql` and answers in a different shape, and a user who has to get
that right by hand will sometimes get it wrong.

```json
{
  "name": "logs",
  "kind": "elasticsearch",
  "secret": { "from": "vault" },
  "options": {
    "host": "elastic.example",
    "port": 9200,
    "protocol": "https",
    "user": "$user"
  }
}
```

Leave `user` out for a cluster with security disabled; no credential is sent and
nothing prompts. Set `index` to pin a connection to one index — it is then the
only one browsed, and a Query DSL body needs no path.

Statements come in two kinds and the right one is chosen by looking at them.

```sql
-- SQL, on any cluster whose SQL surface is enabled
SELECT kind, count(*) AS n
FROM "logs-2026.10.01"
GROUP BY kind
```

```
POST /logs-2026.10.01/_search
{ "query": { "match": { "message": "timeout" } }, "size": 50 }
```

Anything starting with `{`, `GET` or `POST` is a Query DSL request, written the
way Kibana's console writes it. Everything else is SQL. The DSL path needs
nothing installed, which is the path for a cluster too old for SQL or without
the plugin.

**On licensing.** Elastic puts "Elasticsearch SQL APIs & CLI" in the free Basic
tier and its JDBC and ODBC drivers behind a paid one, so DbRex reaches SQL over
HTTP on clusters where a JDBC-based tool cannot. OpenSearch gates nothing: its
SQL plugin is Apache-2.0 and ships in every distribution but the minimal one.

Documents become rows by taking the union of the fields a page actually has, in
first-seen order, with `_index`, `_id` and `_score` in front. A nested object
stays a value rather than being flattened into invented columns. The schema tree
reads the mapping, so it works on a cluster with no SQL at all, and it offers
`.keyword` multi-fields because `text` is not aggregatable and the keyword is
what a `GROUP BY` needs.

Elasticsearch SQL is a small dialect: no joins, and one index or pattern per
statement. A statement it rejects comes back with the engine's own reason.

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
