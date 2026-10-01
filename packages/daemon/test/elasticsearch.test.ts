import { describe, expect, it } from 'vitest';
import { DbRexError } from '@dbrex/core';
import {
  ELASTICSEARCH_CAPABILITIES,
  classifyStatus,
  elasticError,
  elasticsearchProvider,
  isDsl,
  parseDsl,
  paths,
  quoteIdent,
  readClusterInfo,
  readSearchPage,
  readSqlPage,
} from '../src/providers/elasticsearch';

describe('telling the two forks apart', () => {
  it('reads OpenSearch from its distribution field', () => {
    expect(readClusterInfo({ version: { number: '3.9.0', distribution: 'opensearch' } }))
      .toEqual({ flavour: 'opensearch', version: '3.9.0' });
  });

  it('treats a root response with no distribution as Elasticsearch', () => {
    expect(readClusterInfo({ version: { number: '9.5.4' } }))
      .toEqual({ flavour: 'elasticsearch', version: '9.5.4' });
  });

  it('is not confused by the case of the distribution', () => {
    expect(readClusterInfo({ version: { distribution: 'OpenSearch' } }).flavour).toBe('opensearch');
  });

  it('survives a root response that says nothing useful', () => {
    expect(readClusterInfo({})).toEqual({ flavour: 'elasticsearch', version: 'unknown' });
    expect(readClusterInfo(null)).toEqual({ flavour: 'elasticsearch', version: 'unknown' });
  });
});

describe('endpoint paths', () => {
  it('uses the plugin prefix for OpenSearch', () => {
    expect(paths('opensearch')).toEqual({
      sql: '/_plugins/_sql',
      close: '/_plugins/_sql/close',
      translate: '/_plugins/_sql/_explain',
    });
  });

  it('uses the bare paths for Elasticsearch', () => {
    expect(paths('elasticsearch')).toEqual({
      sql: '/_sql',
      close: '/_sql/close',
      translate: '/_sql/translate',
    });
  });
});

describe('deciding whether a statement is SQL or Query DSL', () => {
  it('reads a body starting with a brace as DSL', () => {
    expect(isDsl('{ "query": { "match_all": {} } }')).toBe(true);
  });

  it('reads a console-style request as DSL', () => {
    expect(isDsl('POST /my-index/_search\n{}')).toBe(true);
    expect(isDsl('GET /my-index/_search')).toBe(true);
  });

  it('is not fooled by leading whitespace', () => {
    expect(isDsl('\n  { "query": {} }')).toBe(true);
  });

  it('reads anything else as SQL', () => {
    expect(isDsl('SELECT * FROM logs')).toBe(false);
    expect(isDsl('DESCRIBE "logs-2026.10.01"')).toBe(false);
  });

  it('does not mistake a SQL string literal for a verb line', () => {
    expect(isDsl("SELECT * FROM logs WHERE method = 'POST /x'")).toBe(false);
  });
});

describe('splitting a Query DSL statement', () => {
  it('takes the path from the verb line and the body from the rest', () => {
    expect(parseDsl('POST /logs/_search\n{ "size": 1 }', undefined))
      .toEqual({ path: '/logs/_search', body: '{ "size": 1 }' });
  });

  it('adds the leading slash when the path lacks one', () => {
    expect(parseDsl('POST logs/_search\n{}', undefined).path).toBe('/logs/_search');
  });

  it('defaults an empty body to an empty object', () => {
    expect(parseDsl('GET /logs/_search', undefined).body).toBe('{}');
  });

  it('uses the connection index for a bare body', () => {
    expect(parseDsl('{ "size": 1 }', 'logs'))
      .toEqual({ path: '/logs/_search', body: '{ "size": 1 }' });
  });

  it('refuses a bare body when no index is configured', () => {
    // Searching every index by accident is expensive on a real cluster, so this
    // asks rather than guesses.
    expect(() => parseDsl('{ "size": 1 }', undefined)).toThrow(/needs an index/);
  });

  it('keeps a multi-line body intact', () => {
    const body = '{\n  "query": {\n    "match_all": {}\n  }\n}';
    expect(parseDsl(`POST /logs/_search\n${body}`, undefined).body).toBe(body);
  });
});

describe('reading a SQL page', () => {
  it('reads the Elasticsearch shape', () => {
    expect(readSqlPage({
      columns: [{ name: 'host', type: 'keyword' }, { name: 'bytes', type: 'long' }],
      rows: [['a', 1], ['b', 2]],
      cursor: 'abc',
    })).toEqual({
      columns: [{ name: 'host', type: 'keyword' }, { name: 'bytes', type: 'long' }],
      rows: [['a', 1], ['b', 2]],
      cursor: 'abc',
    });
  });

  it('reads the OpenSearch jdbc shape, which names the same things differently', () => {
    expect(readSqlPage({
      schema: [{ name: 'host', type: 'keyword' }],
      datarows: [['a']],
    })).toEqual({
      columns: [{ name: 'host', type: 'keyword' }],
      rows: [['a']],
      cursor: undefined,
    });
  });

  it('treats an empty cursor as no cursor, so paging stops', () => {
    expect(readSqlPage({ rows: [], cursor: '' }).cursor).toBeUndefined();
  });

  it('reports no columns on a continuation page, which carries none', () => {
    expect(readSqlPage({ rows: [['a']], cursor: 'x' }).columns).toBeUndefined();
  });

  it('survives a page with neither shape', () => {
    expect(readSqlPage({})).toEqual({ columns: undefined, rows: [], cursor: undefined });
  });

  it('defaults a column with no declared type rather than dropping it', () => {
    expect(readSqlPage({ columns: [{ name: 'x' }], rows: [] }).columns)
      .toEqual([{ name: 'x', type: 'unknown' }]);
  });
});

describe('reading a search page', () => {
  const page = {
    hits: {
      total: { value: 42 },
      hits: [
        { _index: 'logs', _id: '1', _score: 1.5, _source: { host: 'a', bytes: 10 } },
        { _index: 'logs', _id: '2', _score: 0.5, _source: { host: 'b', method: 'GET' } },
      ],
    },
  };

  it('puts the document metadata first, then the fields', () => {
    expect(readSearchPage(page).columns.map(c => c.name))
      .toEqual(['_index', '_id', '_score', 'host', 'bytes', 'method']);
  });

  it('takes the shape from the union of the page, in first-seen order', () => {
    const rows = readSearchPage(page).rows;
    expect(rows[0]).toEqual(['logs', '1', 1.5, 'a', 10, null]);
    expect(rows[1]).toEqual(['logs', '2', 0.5, 'b', null, 'GET']);
  });

  it('reads the total so truncation can be reported', () => {
    expect(readSearchPage(page).total).toBe(42);
  });

  it('accepts a bare numeric total, as older clusters send', () => {
    expect(readSearchPage({ hits: { total: 7, hits: [] } }).total).toBe(7);
  });

  it('falls back to the row count when there is no total', () => {
    expect(readSearchPage({ hits: { hits: [{ _source: {} }] } }).total).toBe(1);
  });

  it('handles a document with no source at all', () => {
    const read = readSearchPage({ hits: { hits: [{ _index: 'i', _id: '1' }] } });
    expect(read.columns.map(c => c.name)).toEqual(['_index', '_id', '_score']);
    expect(read.rows).toEqual([['i', '1', null]]);
  });

  it('keeps a nested object as a value rather than inventing columns', () => {
    const read = readSearchPage({ hits: { hits: [{ _source: { user: { id: 1 } } }] } });
    expect(read.columns.map(c => c.name)).toEqual(['_index', '_id', '_score', 'user']);
    expect(read.rows[0]?.[3]).toEqual({ id: 1 });
  });

  it('survives a response that is not a search result', () => {
    // Still the metadata columns, so a caller gets a shape rather than nothing.
    expect(readSearchPage({})).toEqual({
      columns: [
        { name: '_index', type: 'keyword' },
        { name: '_id', type: 'keyword' },
        { name: '_score', type: 'float' },
      ],
      rows: [],
      total: 0,
    });
  });
});

describe('classifying a failure', () => {
  it('calls 401 an auth problem and 403 a permission one', () => {
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(403)).toBe('forbidden');
  });

  it('calls a missing index not_found, whatever the status', () => {
    expect(classifyStatus(400, 'index_not_found_exception')).toBe('not_found');
    expect(classifyStatus(404)).toBe('not_found');
  });

  it('calls a rejected statement a SQL problem', () => {
    expect(classifyStatus(400)).toBe('sql');
    expect(classifyStatus(422)).toBe('sql');
  });

  it('calls a server failure network, because repeating it may work', () => {
    expect(classifyStatus(500)).toBe('network');
    expect(classifyStatus(503)).toBe('network');
  });

  it('calls a gateway timeout a timeout', () => {
    expect(classifyStatus(504)).toBe('timeout');
    expect(classifyStatus(408)).toBe('timeout');
  });
});

describe('the message a failure carries', () => {
  it('keeps the engine reason rather than the status code', () => {
    const e = elasticError(400, {
      error: { type: 'parsing_exception', reason: "line 1:8: mismatched input 'FORM'" },
    }, 'es');
    expect(e.message).toBe("line 1:8: mismatched input 'FORM'");
    expect(e.code).toBe('sql');
    expect(e.details.nativeCode).toBe('parsing_exception');
  });

  it('keeps the error when it is a bare string', () => {
    expect(elasticError(400, { error: 'no handler found for uri [/_sql]' }, 'es').message)
      .toBe('no handler found for uri [/_sql]');
  });

  it('says something useful when the body carries nothing', () => {
    expect(elasticError(502, undefined, 'es').message).toBe('Elasticsearch answered 502');
  });

  it('hints at the credentials on a 401', () => {
    expect(elasticError(401, {}, 'es').details.hint).toMatch(/user and password/);
  });

  it('marks a server failure retryable and a bad statement not', () => {
    expect(elasticError(503, {}, 'es').details.retryable).toBe(true);
    expect(elasticError(400, {}, 'es').details.retryable).toBe(false);
  });

  it('names the connection, so a multi-connection file is debuggable', () => {
    expect(elasticError(400, {}, 'logs-prod').details.connection).toBe('logs-prod');
  });

  it('is a DbRexError, so shared code can read its code', () => {
    expect(DbRexError.is(elasticError(400, {}, 'es'))).toBe(true);
  });
});

describe('identifiers', () => {
  it('quotes a dated index, which cannot be written bare', () => {
    expect(quoteIdent('logs-2026.10.01')).toBe('"logs-2026.10.01"');
  });

  it('doubles an embedded quote', () => {
    expect(quoteIdent('odd"name')).toBe('"odd""name"');
  });
});

describe('what the provider declares', () => {
  it('is addressed by host and port, which is what earns it SSH tunnelling', () => {
    const names = elasticsearchProvider.fields.map(f => f.name);
    expect(names).toContain('host');
    expect(names).toContain('port');
  });

  it('defaults to the usual port and plain http', () => {
    const field = (name: string) => elasticsearchProvider.fields.find(f => f.name === name);
    expect(field('port')?.default).toBe(9200);
    expect(field('protocol')?.default).toBe('http');
  });

  it('does not require a user, because a cluster may have security disabled', () => {
    expect(elasticsearchProvider.fields.find(f => f.name === 'user')?.required).toBeUndefined();
  });

  it('claims a row limit, streaming, and validation without scanning', () => {
    expect(ELASTICSEARCH_CAPABILITIES.limit).toBe('limit');
    expect(ELASTICSEARCH_CAPABILITIES.streams).toBe(true);
    expect(ELASTICSEARCH_CAPABILITIES.validate).toBe(true);
    expect(ELASTICSEARCH_CAPABILITIES.explain).toBe('validate');
  });

  it('claims only transport cancellation, because there is no synchronous cancel', () => {
    expect(ELASTICSEARCH_CAPABILITIES.cancel).toBe('transport');
  });

  it('serves one provider id for both forks', () => {
    expect(elasticsearchProvider.id).toBe('elasticsearch');
    expect(elasticsearchProvider.displayName).toContain('OpenSearch');
  });
});
