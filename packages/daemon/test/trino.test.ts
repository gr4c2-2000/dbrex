import { describe, expect, it } from 'vitest';
import { DbRexError } from '@dbrex/core';
import type { Chunk } from '@dbrex/core';
import {
  diagnosticFrom,
  encodeSessionHeader,
  httpFailure,
  offsetOf,
  pageFailure,
  parseAuthChallenge,
  parseSessionProperties,
  parseTokenBody,
  quoteIdent,
  quoteString,
  takeRows,
  validationDiagnostic,
  transportFailure,
  trinoProvider,
  walkPages,
  type PageWalk,
  type TrinoPage,
  icebergScanHint,
} from '../src/providers/trino';

/**
 * Drive `walkPages` over a canned chain of pages. This is the whole point of
 * the seam: the protocol's decisions are testable without a coordinator.
 */
async function walk(
  pages: readonly TrinoPage[],
  options: { rowLimit?: number; signal?: AbortSignal } = {},
): Promise<{ chunks: Chunk[]; stats: PageWalk; deleted: string[] }> {
  const [first, ...rest] = pages;
  const queue = [...rest];
  const deleted: string[] = [];
  const chunks: Chunk[] = [];

  const generator = walkPages(
    first!,
    async () => {
      const page = queue.shift();
      if (page === undefined) throw new Error('fetched past the end of the canned chain');
      return page;
    },
    uri => { deleted.push(uri); },
    { connection: 'trino-test', ...options },
  );

  for (;;) {
    const step = await generator.next();
    if (step.done === true) return { chunks, stats: step.value, deleted };
    chunks.push(step.value);
  }
}

const PAGE = (over: Partial<TrinoPage> = {}): TrinoPage => ({
  id: '20240101_120000_00001_abcde',
  columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }],
  ...over,
});

describe('parseAuthChallenge', () => {
  it('reads both urls out of a single Bearer challenge', () => {
    const header =
      'Bearer x_redirect_server="https://trino.example/oauth2/token/initiate/abc", ' +
      'x_token_server="https://trino.example/oauth2/token/abc"';
    expect(parseAuthChallenge(header)).toEqual({
      redirectServer: 'https://trino.example/oauth2/token/initiate/abc',
      tokenServer: 'https://trino.example/oauth2/token/abc',
    });
  });

  it('joins repeated headers, which node delivers as an array', () => {
    expect(parseAuthChallenge([
      'Basic realm="Trino"',
      'Bearer x_redirect_server="https://idp/login", x_token_server="https://trino/token/1"',
    ])).toEqual({ redirectServer: 'https://idp/login', tokenServer: 'https://trino/token/1' });
  });

  it('returns null when the header is missing entirely', () => {
    expect(parseAuthChallenge(undefined)).toBeNull();
  });

  it('returns null when only one half of the challenge is present', () => {
    expect(parseAuthChallenge('Bearer x_redirect_server="https://idp/login"')).toBeNull();
    expect(parseAuthChallenge('Bearer x_token_server="https://trino/token/1"')).toBeNull();
  });

  it('returns null for a plain Basic challenge', () => {
    expect(parseAuthChallenge('Basic realm="Trino"')).toBeNull();
  });
});

describe('parseTokenBody', () => {
  it('reports the JWT when the login finished', () => {
    expect(parseTokenBody('{"token":"eyJhbGciOi.J9.sig"}')).toEqual({
      status: 'ready',
      token: 'eyJhbGciOi.J9.sig',
    });
  });

  it('reports pending for an empty body, which is how waiting looks', () => {
    expect(parseTokenBody('')).toEqual({ status: 'pending' });
    expect(parseTokenBody('{}')).toEqual({ status: 'pending' });
  });

  it('reports failure so the poll loop stops instead of waiting out the deadline', () => {
    expect(parseTokenBody('{"error":"Authentication has been rejected"}')).toEqual({
      status: 'failed',
      message: 'Authentication has been rejected',
    });
  });

  it('recovers a token from a body that is not valid JSON', () => {
    expect(parseTokenBody('garbage "token": "abc123" trailing')).toEqual({ status: 'ready', token: 'abc123' });
  });

  it('treats an empty token string as still pending', () => {
    expect(parseTokenBody('{"token":""}')).toEqual({ status: 'pending' });
  });
});

describe('session properties', () => {
  it('encodes values so a comma inside one cannot split the header', () => {
    expect(encodeSessionHeader({ query_max_run_time: '10m', hint: 'a,b' }))
      .toBe('query_max_run_time=10m, hint=a%2Cb');
  });

  it('stringifies numbers and booleans', () => {
    expect(encodeSessionHeader({ join_distribution_type: 'BROADCAST', hash_partition_count: 8, spill_enabled: true }))
      .toBe('join_distribution_type=BROADCAST, hash_partition_count=8, spill_enabled=true');
  });

  it('sends no header when there is nothing to send', () => {
    expect(encodeSessionHeader({})).toBeUndefined();
  });

  it('parses the connection-level knob, tolerating whitespace and junk entries', () => {
    expect(parseSessionProperties(' query_max_run_time = 10m , spill_enabled=true , =bad , alone '))
      .toEqual({ query_max_run_time: '10m', spill_enabled: 'true' });
  });

  it('parses an unset knob as no properties', () => {
    expect(parseSessionProperties(undefined)).toEqual({});
  });

  it('keeps a value containing an equals sign intact', () => {
    expect(parseSessionProperties('filter=a=b')).toEqual({ filter: 'a=b' });
  });
});

describe('walkPages', () => {
  it('carries columns on the first chunk only', async () => {
    const { chunks, stats } = await walk([
      PAGE({ data: [[1, 'a']], nextUri: 'https://trino/next/1' }),
      PAGE({ data: [[2, 'b']] }),
    ]);
    expect(chunks).toEqual([
      { columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }], rows: [[1, 'a']] },
      { rows: [[2, 'b']] },
    ]);
    expect(stats).toEqual({ rowsRead: 2, truncated: false, nativeQueryId: '20240101_120000_00001_abcde' });
  });

  it('announces columns even when the result has no rows', async () => {
    const { chunks, stats } = await walk([PAGE({ data: [] })]);
    expect(chunks).toEqual([{
      columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }],
      rows: [],
    }]);
    expect(stats.rowsRead).toBe(0);
  });

  it('yields nothing for queued pages that carry neither columns nor rows', async () => {
    const { chunks } = await walk([
      { id: 'q', nextUri: 'https://trino/next/1', stats: { state: 'QUEUED' } },
      PAGE({ data: [[1, 'a']] }),
    ]);
    expect(chunks).toEqual([{
      columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }],
      rows: [[1, 'a']],
    }]);
  });

  it('surfaces an error on the FIRST page (regression: the old adapter reported an empty success)', async () => {
    const failure = walk([{
      id: 'q',
      error: {
        message: "line 1:8: Column 'nope' cannot be resolved",
        errorCode: 47,
        errorName: 'COLUMN_NOT_FOUND',
        errorType: 'USER_ERROR',
      },
    }]);
    await expect(failure).rejects.toThrow(DbRexError);
    await failure.catch((e: DbRexError) => {
      expect(e.code).toBe('sql');
      expect(e.details.nativeCode).toBe('COLUMN_NOT_FOUND');
      expect(e.message).toContain('cannot be resolved');
    });
  });

  it('surfaces an error that only appears on a later page', async () => {
    const failure = walk([
      PAGE({ data: [[1, 'a']], nextUri: 'https://trino/next/1' }),
      { id: 'q', error: { message: 'Query exceeded distributed memory limit', errorName: 'EXCEEDED_GLOBAL_MEMORY_LIMIT' } },
    ]);
    await expect(failure).rejects.toMatchObject({ code: 'sql', details: { nativeCode: 'EXCEEDED_GLOBAL_MEMORY_LIMIT' } });
  });

  it('truncates across a page boundary and cancels the query server-side', async () => {
    const { chunks, stats, deleted } = await walk([
      PAGE({ data: [[1, 'a'], [2, 'b']], nextUri: 'https://trino/next/1' }),
      PAGE({ data: [[3, 'c'], [4, 'd']], nextUri: 'https://trino/next/2' }),
      PAGE({ data: [[5, 'e']] }),
    ], { rowLimit: 3 });

    expect(chunks.map(c => c.rows)).toEqual([[[1, 'a'], [2, 'b']], [[3, 'c']]]);
    expect(stats).toMatchObject({ rowsRead: 3, truncated: true });
    // The DELETE goes to the nextUri of the page we stopped on, which is the
    // handle the coordinator is still holding the query open for.
    expect(deleted).toEqual(['https://trino/next/2']);
  });

  it('stops on the page boundary when the limit lands exactly on it', async () => {
    const { stats, deleted } = await walk([
      PAGE({ data: [[1, 'a'], [2, 'b']], nextUri: 'https://trino/next/1' }),
      PAGE({ data: [[3, 'c']] }),
    ], { rowLimit: 2 });
    expect(stats).toMatchObject({ rowsRead: 2, truncated: true });
    expect(deleted).toEqual(['https://trino/next/1']);
  });

  it('is not truncated when the limit is never reached', async () => {
    const { stats, deleted } = await walk([PAGE({ data: [[1, 'a']] })], { rowLimit: 10 });
    expect(stats.truncated).toBe(false);
    expect(deleted).toEqual([]);
  });

  it('cancels server-side and throws cancelled when the signal aborts mid-chain', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = walk([
      PAGE({ data: [[1, 'a']], nextUri: 'https://trino/next/1' }),
      PAGE({ data: [[2, 'b']] }),
    ], { signal: controller.signal });

    await expect(failure).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('takeRows', () => {
  it('passes everything through when there is no limit', () => {
    expect(takeRows([[1], [2]], 5, undefined)).toEqual([[1], [2]]);
  });

  it('cuts the page at the remaining room', () => {
    expect(takeRows([[1], [2], [3]], 1, 2)).toEqual([[1]]);
  });

  it('returns nothing once the limit is already spent', () => {
    expect(takeRows([[1]], 2, 2)).toEqual([]);
  });
});

describe('error classification', () => {
  it('maps a rejected credential to auth', () => {
    expect(httpFailure(401, 'Unauthorized', 'c')).toMatchObject({ code: 'auth' });
    expect(httpFailure(403, 'Forbidden', 'c')).toMatchObject({ code: 'auth' });
  });

  it('maps a coordinator that could not answer to network, and says it is retryable', () => {
    const e = httpFailure(503, 'Service Unavailable', 'c');
    expect(e.code).toBe('network');
    expect(e.details.retryable).toBe(true);
  });

  it('maps a refused connection to network', () => {
    expect(transportFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'c'))
      .toMatchObject({ code: 'network' });
  });

  it('points a certificate failure at caCertPath', () => {
    const e = transportFailure(
      Object.assign(new Error('unable to verify the first certificate'), { code: 'CERT_UNTRUSTED' }),
      'c',
    );
    expect(e.code).toBe('network');
    expect(e.details.hint).toContain('caCertPath');
  });

  it('leaves an DbRexError we raised ourselves alone', () => {
    const original = new DbRexError('cancelled', 'query cancelled');
    expect(transportFailure(original, 'c')).toBe(original);
  });

  it('keeps the Trino error name verbatim for the user to search for', () => {
    const e = pageFailure({ message: 'Table does not exist', errorName: 'TABLE_NOT_FOUND', errorCode: 46 }, 'prod');
    expect(e.code).toBe('sql');
    expect(e.details).toEqual({ connection: 'prod', nativeCode: 'TABLE_NOT_FOUND' });
  });
});

describe('diagnostics', () => {
  it('turns a Trino line/column into a byte offset', () => {
    const sql = 'SELECT a,\n       nope\nFROM t';
    expect(offsetOf(sql, 2, 8)).toBe(17);
    expect(sql.slice(17, 21)).toBe('nope');
  });

  it('gives up on a line past the end of the statement', () => {
    expect(offsetOf('SELECT 1', 4, 1)).toBeUndefined();
  });

  it('builds a positioned diagnostic', () => {
    expect(diagnosticFrom('SELECT nope FROM t', {
      message: "line 1:8: Column 'nope' cannot be resolved",
      errorName: 'COLUMN_NOT_FOUND',
      errorLocation: { lineNumber: 1, columnNumber: 8 },
    })).toEqual({
      message: "line 1:8: Column 'nope' cannot be resolved",
      offset: 7,
      severity: 'error',
    });
  });

  it('shifts a first-line validate error back past the EXPLAIN wrapper', () => {
    const sql = 'SELECT nope FROM t';
    // 'EXPLAIN (TYPE VALIDATE) ' is 24 characters, so column 32 of the wrapped
    // statement is column 8 — the start of `nope` — in the user's text.
    const d = validationDiagnostic(sql, {
      message: "Column 'nope' cannot be resolved",
      errorLocation: { lineNumber: 1, columnNumber: 32 },
    });
    expect(d.offset).toBe(7);
    expect(sql.slice(7, 11)).toBe('nope');
  });

  it('leaves a later line alone: the wrapper only lengthens the first one', () => {
    const sql = 'SELECT a\nFROM nosuch';
    const d = validationDiagnostic(sql, {
      message: 'Table does not exist',
      errorLocation: { lineNumber: 2, columnNumber: 6 },
    });
    expect(d.offset).toBe(14);
    expect(sql.slice(14)).toBe('nosuch');
  });

  it('omits the offset when Trino reported no location', () => {
    expect(diagnosticFrom('SELECT 1', { message: 'boom' })).toEqual({ message: 'boom', severity: 'error' });
  });
});

describe('identifier quoting', () => {
  it('doubles embedded quotes rather than letting them close the identifier', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteString("o'brien")).toBe("'o''brien'");
  });
});

describe('provider declaration', () => {
  it('declares the capabilities the implementation actually backs', () => {
    expect(trinoProvider.capabilities).toMatchObject({
      limit: 'limit',
      streams: true,
      cancel: 'server',
      // Trino has both: EXPLAIN ANALYZE really runs the query and reports
      // timings, and EXPLAIN (TYPE VALIDATE) plans without scanning. They are
      // different capabilities — the plan-only check is what `validate: true`
      // means, so `explain` names the strongest EXPLAIN the engine offers.
      explain: 'analyze',
      browse: true,
      validate: true,
      settings: true,
    });
  });

  it('marks the fields where $user and ~ must expand', () => {
    const substituted = trinoProvider.fields.filter(f => f.substitute === true).map(f => f.name);
    expect(substituted).toEqual(['user', 'caCertPath']);
  });

  it('declares every option the provider reads', () => {
    expect(trinoProvider.fields.map(f => f.name)).toEqual([
      'host', 'port', 'user', 'catalog', 'schema', 'authMode', 'caCertPath', 'sessionProperties',
    ]);
    expect(trinoProvider.fields.find(f => f.name === 'port')?.default).toBe(443);
  });
});

describe('icebergScanHint', () => {
  it('warns about an unbounded extreme over Iceberg', () => {
    expect(icebergScanHint('SELECT max(ts) FROM iceberg.loghost.events'))
      .toMatch(/scans every partition/);
    expect(icebergScanHint('SELECT min(ts) FROM "iceberg".loghost.events')).not.toBeNull();
  });

  it('stays quiet once there is a predicate', () => {
    expect(icebergScanHint(
      "SELECT max(ts) FROM iceberg.loghost.events WHERE day >= current_date - INTERVAL '2' DAY",
    )).toBeNull();
  });

  it('stays quiet for other catalogs and other aggregates', () => {
    expect(icebergScanHint('SELECT max(ts) FROM hive.loghost.events')).toBeNull();
    expect(icebergScanHint('SELECT count(*) FROM iceberg.loghost.events')).toBeNull();
  });
});
