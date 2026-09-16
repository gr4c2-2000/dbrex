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
- **DbRex: Copy MCP Setup Command** gives you the one line that connects an agent.
- Passwords are never accepted from an agent: the daemon routes the prompt to
  this window or to a terminal, and only those may answer.

MySQL, ClickHouse, Trino (including SSO) and S3-compatible object stores.

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
dbrex query <conn> -f <file.sql>   run a file, honouring -- @conn / -- @limit
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
- `make verify-run` queries real MySQL, ClickHouse and MinIO.

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

## License

MIT. See [LICENSE](LICENSE).
