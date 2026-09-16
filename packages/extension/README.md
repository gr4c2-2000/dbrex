# DbRex

Query databases from `.sql` files in VSCode, and let an AI work the same
connections through MCP.

> **Deep beta.** Early, pre-release software under active development. The
> connection file format and the on-disk layout of `~/.dbrex` can change
> without a migration path.

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

MIT.
