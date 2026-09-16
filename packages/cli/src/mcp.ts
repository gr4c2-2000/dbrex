/**
 * MCP bridge.
 *
 * An agent talks MCP over stdio to this process, which talks the daemon
 * protocol over the socket. Three consequences, all deliberate:
 *
 * - No HTTP listener and no bearer token. The old design put an HTTP server in
 *   every window plus a router daemon holding a shared token in a file, and any
 *   local process that could read that token could drive it. Here the agent's
 *   own client spawns this bridge, and the socket's file permissions are the
 *   access control.
 * - The agent works with no editor open. The bridge starts the daemon if it is
 *   not running, so "is VSCode open?" stops being a precondition for an agent
 *   to query a database.
 * - The bridge connects with the `agent` role, so the daemon will not offer it
 *   a password prompt. It declines secret interactions explicitly rather than
 *   waiting out the timeout, and relays login URLs, which are public and
 *   single-use, to the human on the other side of the conversation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DbRexClient, ensureDaemon } from '@dbrex/client';
import { DbRexError, messageOf, type ConnectionInfo } from '@dbrex/core';
import { daemonPath, socketPath } from './paths';

/**
 * How to add a chart, told to the agent at initialize.
 *
 * Written out in full because the contract changed from the previous generation
 * of this tool: an agent working from memory will reach for ECharts and
 * `ctx.setOption`, write a file that cannot run, and have no way to find out
 * why — view code runs in a sandbox with no network and no console the agent
 * can read.
 */
const CHART_GUIDE = [
  'CHARTS. A query file gets charts from sibling files you write next to it:',
  '  queries/sales.sql',
  '  queries/sales.chart.js        -> a tab called "chart"',
  '  queries/sales.view.weekly.js  -> a tab called "weekly"',
  '  queries/sales.config.json     -> optional: {"views":[{"name","file","label"}],"defaultView","css"}',
  'Each file defines: function render(data, ctx) { ... }',
  '',
  'data = { columns: string[], types: string[], rows: unknown[][] }',
  '  columns are NAMES, not objects. rows are positional, matching columns.',
  '',
  'ctx = {',
  '  chart(spec) -> draws and returns an <svg>,',
  '  container   -> the root HTMLElement, yours to build DOM in,',
  '  records()   -> a FUNCTION returning rows as objects keyed by column name,',
  '}',
  '',
  'spec = {',
  "  type: 'line' | 'bar' | 'scatter',",
  '  x?: string | number,              // column name or index; defaults to the first column',
  '  y?: (string | number)[],          // columns to plot; defaults to every numeric column but x',
  '  title?: string,',
  '}',
  '',
  'Minimal example:',
  '  function render(data, ctx) {',
  "    ctx.chart({ type: 'bar', x: 'day', y: ['clicks', 'impressions'], title: 'Traffic' });",
  '  }',
  '',
  'Constraints, all deliberate:',
  '  - There is no ECharts and no ctx.setOption. Anything the spec cannot draw,',
  '    build yourself as DOM or SVG inside ctx.container.',
  '  - The view runs in a sandboxed frame with no network access, so it cannot',
  '    load a library from a CDN. Everything must be in the file.',
  '  - A view sees the first 500 rows only. Aggregate in SQL, not in JavaScript.',
  '  - A file whose name does not match the query is simply not picked up; check',
  '    the base name matches the .sql exactly.',
].join('\n');

/** Rows returned inline with a query result before the agent has to page. */
const PREVIEW_ROWS = 20;
const MAX_TIMEOUT_SECONDS = 600;

export interface BridgeOptions {
  readonly version: string;
  readonly workspace?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runMcpBridge(options: BridgeOptions): Promise<void> {
  const env = options.env ?? process.env;
  const socket = socketPath(env);
  const ensure = (): Promise<void> =>
    ensureDaemon({ socketPath: socket, daemonPath: daemonPath(env), env });
  await ensure();

  const server = new McpServer(
    { name: 'dbrex', version: options.version },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: [
        'DbRex gives you the same database sessions the human is using, through a',
        'local daemon. Call list_connections first: each connection carries a',
        '"reference" field describing what lives in it, and its capabilities tell',
        'you what the engine supports.',
        'execute_query stores the full result and returns a preview; use',
        'read_result to page through the rest instead of re-running the query,',
        'and inject_result to put a stored result on the human\'s screen.',
        'You cannot be given a password. If a connection needs one, a human is',
        'asked in their editor or terminal, and your call completes once they',
        'answer.',
        '',
        CHART_GUIDE,
      ].join('\n'),
    },
  );

  /** Login URLs seen while a call was in flight, so a failure can mention them. */
  const pendingLogins = new Map<string, string>();

  const client = await DbRexClient.connect(
    {
      socketPath: socket,
      role: 'agent',
      client: 'dbrex-mcp',
      // This process outlives any single daemon: the daemon exits when idle and
      // is replaced on every upgrade, while the agent keeps this bridge open for
      // the length of a conversation. Without starting it again on reconnect,
      // the first restart ends the session's database access for good.
      ensure,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    },
    {
      onInteraction: async ({ connection, detail }) => {
        if (detail.kind !== 'browser') {
          // Declining immediately lets the daemon ask a client that may
          // legitimately answer, instead of stalling until the timeout.
          return undefined;
        }
        pendingLogins.set(connection, detail.url);
        await server.server.sendLoggingMessage({
          level: 'info',
          data: `DbRex: "${connection}" needs a browser login. Open: ${detail.url}`,
        }).catch(() => { /* the client may not have subscribed to logging */ });
        return true;
      },
    },
  );

  const describe = (connections: readonly ConnectionInfo[]): string =>
    connections.length === 0
      ? 'No connections are configured. Add one in ~/.dbrex/connections.json.'
      : connections
          .map(c => [
            `- ${c.name} (${c.kind}, ${c.origin})`,
            c.reference ? `  reference: ${c.reference}` : undefined,
            `  ready: ${c.ready}; supports limit: ${c.capabilities.limit}; ` +
              `browse: ${c.capabilities.browse}; validate: ${c.capabilities.validate}`,
          ].filter(Boolean).join('\n'))
          .join('\n');

  server.registerTool('list_connections', {
    title: 'List database connections',
    description:
      'Connections this workspace can reach, with the free-text reference that ' +
      'explains what each one holds and the capabilities of its engine.',
  }, async () => {
    const { connections } = await client.call({ op: 'listConnections' });
    return {
      content: [{ type: 'text', text: describe(connections) }],
      structuredContent: { connections },
    };
  });

  server.registerTool('execute_query', {
    title: 'Run one SQL statement',
    description:
      'Runs one statement and stores the full result. Returns the first ' +
      `${PREVIEW_ROWS} rows plus a resultId for read_result. The row limit is ` +
      'pushed into the SQL when the dialect allows it, so it also bounds the work ' +
      'the server does.',
    inputSchema: {
      connection: z.string().describe('Connection name from list_connections'),
      sql: z.string().describe('One statement, without a trailing semicolon'),
      rowLimit: z.number().int().positive().optional()
        .describe('Stop after this many rows'),
      timeoutSeconds: z.number().int().positive().max(MAX_TIMEOUT_SECONDS).optional()
        .describe(`Give up after this long (max ${MAX_TIMEOUT_SECONDS})`),
      settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe('Engine settings passthrough, for engines that accept one'),
    },
  }, async ({ connection, sql, rowLimit, timeoutSeconds, settings }) => {
    try {
      const result = await client.query({
        op: 'query',
        connection,
        sql,
        ...(rowLimit === undefined ? {} : { rowLimit }),
        ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }),
        ...(settings === undefined ? {} : { settings }),
      });
      pendingLogins.delete(connection);

      const preview = await client.call({
        op: 'readRows',
        resultId: result.resultId,
        offset: 0,
        limit: PREVIEW_ROWS,
      });

      const header = [
        `resultId: ${result.resultId}`,
        `rows: ${result.rowCount}${result.stats.truncated ? ' (truncated)' : ''}`,
        `elapsed: ${result.stats.elapsedMs}ms`,
        `columns: ${result.columns.map(c => `${c.name} ${c.type}`).join(', ')}`,
      ].join('\n');

      return {
        content: [{
          type: 'text',
          text: `${header}\n\n${JSON.stringify(preview.rows)}${
            result.rowCount > preview.rows.length
              ? `\n\n${result.rowCount - preview.rows.length} more rows — read_result with this resultId.`
              : ''
          }`,
        }],
        structuredContent: {
          resultId: result.resultId,
          rowCount: result.rowCount,
          columns: result.columns,
          stats: result.stats,
          rows: preview.rows,
        },
      };
    } catch (e) {
      return { content: [{ type: 'text', text: explain(e, pendingLogins.get(connection)) }], isError: true };
    }
  });

  server.registerTool('read_result', {
    title: 'Page through a stored result',
    description: 'Reads rows from a result execute_query already stored. Cheaper and ' +
      'more reliable than running the query again.',
    inputSchema: {
      resultId: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(5_000).default(500),
    },
  }, async ({ resultId, offset, limit }) => {
    const page = await client.call({ op: 'readRows', resultId, offset, limit });
    return {
      content: [{
        type: 'text',
        text: `rows ${page.offset}..${page.offset + page.rows.length} of ${page.total}\n${JSON.stringify(page.rows)}`,
      }],
      structuredContent: { ...page },
    };
  });

  server.registerTool('list_results', {
    title: 'List stored results',
    description: 'Recent query results, newest first, with their SQL and row counts.',
    inputSchema: { limit: z.number().int().positive().max(200).default(20) },
  }, async ({ limit }) => {
    const { results } = await client.call({ op: 'listResults', limit });
    return {
      content: [{
        type: 'text',
        text: results.length === 0
          ? 'No stored results.'
          : results.map(r => `${r.resultId}  ${r.connection}  ${r.rowCount} rows  ${r.createdAt}  ${oneLine(r.sql)}`).join('\n'),
      }],
      structuredContent: { results },
    };
  });

  server.registerTool('pin_result', {
    title: 'Pin or unpin a result',
    description: 'Pinned results are never evicted when the cache reaches its size cap.',
    inputSchema: { resultId: z.string(), pinned: z.boolean().default(true) },
  }, async ({ resultId, pinned }) => {
    await client.call({ op: 'pinResult', resultId, pinned });
    return { content: [{ type: 'text', text: `${resultId} ${pinned ? 'pinned' : 'unpinned'}` }] };
  });

  server.registerTool('inject_result', {
    title: 'Show a stored result to the human',
    description:
      'Opens a result you already ran in the human\'s editor panel, so you can ' +
      'point at what you found instead of pasting it into the conversation. ' +
      'Does nothing if nobody has an editor open.',
    inputSchema: { resultId: z.string() },
  }, async ({ resultId }) => {
    const { shown } = await client.call({ op: 'showResult', resultId });
    return {
      content: [{
        type: 'text',
        text: shown > 0
          ? `Shown in ${shown} open editor${shown === 1 ? '' : 's'}.`
          : 'Nobody has an editor attached right now; the result is stored and stays available.',
      }],
    };
  });

  server.registerTool('browse', {
    title: 'Browse a connection\'s schema',
    description:
      'Children of a path in the connection tree. An empty path lists databases or ' +
      'catalogs; each level down narrows to schemas, tables and columns. Use this ' +
      'instead of guessing table names.',
    inputSchema: {
      connection: z.string(),
      path: z.array(z.string()).default([]).describe('e.g. [] or ["analytics"] or ["analytics","events"]'),
    },
  }, async ({ connection, path }) => {
    try {
      const { nodes } = await client.call({ op: 'browse', connection, path });
      return {
        content: [{
          type: 'text',
          text: nodes.length === 0
            ? 'nothing here'
            : nodes.map(n => `${n.kind}\t${n.name}${n.detail ? `\t${n.detail}` : ''}`).join('\n'),
        }],
        structuredContent: { nodes },
      };
    } catch (e) {
      return { content: [{ type: 'text', text: explain(e, pendingLogins.get(connection)) }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

/**
 * Turn a failure into something an agent can act on.
 *
 * The hint and the error code carry the difference between "your SQL is wrong",
 * "nobody is at the keyboard" and "the server is unreachable" — which the old
 * design flattened into one stringified message.
 */
function explain(error: unknown, loginUrl?: string): string {
  const lines: string[] = [];
  if (DbRexError.is(error)) {
    lines.push(`${error.code}: ${error.message}`);
    if (error.details.hint) lines.push(error.details.hint);
    if (error.code === 'auth_interaction_required') {
      lines.push('Ask the person you are working with to answer the prompt in their editor, or to run `dbrex unlock`.');
    }
  } else {
    lines.push(messageOf(error));
  }
  if (loginUrl) lines.push(`A browser login is pending — open: ${loginUrl}`);
  return lines.join('\n');
}

function oneLine(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
}
