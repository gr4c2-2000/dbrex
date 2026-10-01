import { describe, expect, it } from 'vitest';
import { DbRexError, validateOptions, type ErrorCode, type FieldSpec } from '@dbrex/core';
import {
  MESSAGE_FORMATS,
  SASL_MECHANISMS,
  START_POSITIONS,
  classifyKafkaError,
  columnNodes,
  duckError,
  emptyTableSql,
  envelope,
  inferColumns,
  kafkaError,
  kafkaProvider,
  kafkaReadTemplate,
  materializeSql,
  parseBrokers,
  quoteKafkaIdent,
  quoteKafkaLiteral,
  gatherWithin,
  topicNodes,
  topicsInSql,
  widen,
  windowFor,
  foldCaseCollisions,} from '../src/providers/kafka';
import { builtinProviders } from '../src/providers/builtin';

function field(name: string): FieldSpec | undefined {
  return kafkaProvider.fields.find(f => f.name === name);
}

const record = {
  partition: 2,
  offset: '41',
  timestamp: '1790838338080',
  key: 'k-1',
  value: '{"user_id":7,"url":"https://x/7"}',
};

describe('registration', () => {
  it('ships in the build under a kind a connection file can name', () => {
    expect(builtinProviders().map(p => p.id)).toContain('kafka');
  });
});

describe('field declarations', () => {
  it('declares every option the provider reads', () => {
    expect(kafkaProvider.fields.map(f => f.name).sort())
      .toEqual(['brokers', 'format', 'sampleMessages', 'saslMechanism', 'ssl', 'startPosition', 'user']);
  });

  it('requires only the brokers: an unauthenticated cluster is the normal case', () => {
    expect(field('brokers')?.required).toBe(true);
    expect(field('user')?.required).toBeUndefined();
    expect(field('ssl')?.default).toBe(false);
  });

  it('defaults to the latest thousand messages, read as json', () => {
    expect(field('sampleMessages')?.default).toBe(1000);
    expect(field('startPosition')?.default).toBe('latest');
    expect(field('format')?.default).toBe('json');
  });

  it('declares no host or port, which is what stops the daemon tunnelling it', () => {
    // A tunnel to one broker cannot work: the cluster answers metadata with its
    // own advertised listeners and the client goes there next.
    expect(field('host')).toBeUndefined();
    expect(field('port')).toBeUndefined();
  });

  it('describes every field for the wizard', () => {
    for (const f of kafkaProvider.fields) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.prompt).toBe(true);
    }
  });

  it('accepts a well-formed options bag and rejects anything else', () => {
    const fields = kafkaProvider.fields;
    expect(validateOptions({ brokers: 'a:9092', ssl: true, sampleMessages: 10 }, fields)).toEqual([]);
    expect(validateOptions({ brokers: 'a:9092', topic: 'events' }, fields))
      .toEqual([{ field: 'topic', message: 'unknown option "topic"' }]);
    expect(validateOptions({ brokers: 'a:9092', ssl: 'yes' }, fields))
      .toEqual([{ field: 'ssl', message: 'option "ssl" must be a boolean, got string' }]);
  });
});

describe('capabilities', () => {
  const caps = kafkaProvider.capabilities;

  it('admits it neither streams nor cancels, because DuckDB does neither', () => {
    expect(caps.streams).toBe(false);
    expect(caps.cancel).toBe('none');
  });

  it('browses but does not validate: a topic is a table only once it is read', () => {
    expect(caps.browse).toBe(true);
    expect(caps.validate).toBe(false);
    expect(caps.explain).toBe('none');
  });

  it('completes DuckDB SQL, not Kafka DDL', () => {
    expect(caps.keywords).toContain('SELECT');
    expect(caps.keywords).toContain('EPOCH_MS');
    expect(caps.keywords).not.toContain('CREATE SOURCE');
  });
});

describe('brokers', () => {
  it('splits a list and trims it', () => {
    expect(parseBrokers('a:9092, b:9092 ,c:9092')).toEqual(['a:9092', 'b:9092', 'c:9092']);
  });

  it('refuses a list with nothing in it', () => {
    expect(() => parseBrokers('  ,  ')).toThrow(DbRexError);
  });
});

describe('quoting', () => {
  it('doubles quotes in an identifier, so a topic with a dash stays addressable', () => {
    expect(quoteKafkaIdent('order-events')).toBe('"order-events"');
    expect(quoteKafkaIdent('odd"name')).toBe('"odd""name"');
  });

  it('doubles apostrophes in a literal', () => {
    expect(quoteKafkaLiteral("/tmp/o'clock.ndjson")).toBe("'/tmp/o''clock.ndjson'");
  });

  it('offers a statement that reads, not a name', () => {
    expect(kafkaReadTemplate('order-events')).toBe('SELECT *\nFROM "order-events"\nLIMIT 100');
  });
});

describe('which topics a statement needs', () => {
  const known = ['events', 'orders', 'url'];

  it('finds a plain FROM', () => {
    expect(topicsInSql('SELECT * FROM events', known)).toEqual(['events']);
  });

  it('finds a single-quoted name, which DuckDB also accepts', () => {
    // The normal spelling for a topic whose name cannot be written bare.
    expect(topicsInSql("SELECT count(*) FROM 'events'", known)).toEqual(['events']);
  });

  it('finds a quoted name and a join', () => {
    expect(topicsInSql('SELECT * FROM "events" e JOIN orders o ON o.id = e.id', known).sort())
      .toEqual(['events', 'orders']);
  });

  it('ignores a column that shares its name with a topic', () => {
    // `url` is a topic on this cluster and a field in another topic. Reading a
    // whole topic because a column was selected would be a silent cost.
    expect(topicsInSql('SELECT url FROM events', known)).toEqual(['events']);
  });

  it('ignores a name no topic claims', () => {
    expect(topicsInSql('SELECT * FROM nope', known)).toEqual([]);
  });

  it('does not repeat a topic named twice', () => {
    expect(topicsInSql('SELECT * FROM events UNION ALL SELECT * FROM events', known)).toEqual(['events']);
  });
});

describe('the window read from each partition', () => {
  const marks = [
    { partition: 0, low: '0', high: '1000' },
    { partition: 1, low: '900', high: '1000' },
    { partition: 2, low: '5', high: '5' },  // empty
  ];

  it('skips partitions holding nothing', () => {
    expect(windowFor(marks, 100, 'latest').map(w => w.partition)).toEqual([0, 1]);
  });

  it('reads the tail for latest, which is what a person debugging wants', () => {
    const [first] = windowFor(marks, 100, 'latest');
    expect(first).toEqual({ partition: 0, from: '950', through: '999', quota: 50 });
  });

  it('reads from the start of the partition for earliest', () => {
    const [first] = windowFor(marks, 100, 'earliest');
    expect(first).toMatchObject({ partition: 0, from: '0', quota: 50 });
  });

  it('never asks for more than a partition holds', () => {
    const [, second] = windowFor(marks, 1000, 'latest');
    expect(second).toEqual({ partition: 1, from: '900', through: '999', quota: 100 });
  });

  it('spreads the budget when every partition can use its share', () => {
    expect(windowFor(marks, 100, 'latest').map(w => w.quota)).toEqual([50, 50]);
  });

  it('gives a hot partition what the quiet ones cannot use', () => {
    // Kafka partitions by key, so this is the normal shape of a topic. An
    // equal split would return 150 messages and call it "the last thousand".
    const skewed = [
      { partition: 0, low: '0', high: '1000' },
      { partition: 1, low: '0', high: '3' },
      { partition: 2, low: '0', high: '2' },
    ];
    const window = windowFor(skewed, 100, 'latest');
    expect(window.map(w => w.quota)).toEqual([95, 3, 2]);
    expect(window.reduce((n, w) => n + w.quota, 0)).toBe(100);
  });

  it('reads fewer partitions than it has, rather than more messages than asked', () => {
    // A budget smaller than the partition count cannot cover them all. Which
    // partitions miss out is not worth pinning down; never exceeding the
    // budget is.
    const many = Array.from({ length: 5 }, (_, i) => ({ partition: i, low: '0', high: '100' }));
    const window = windowFor(many, 2, 'latest');
    expect(window).toHaveLength(2);
    expect(window.reduce((n, w) => n + w.quota, 0)).toBe(2);
  });

  it('has nothing to read from an empty topic', () => {
    expect(windowFor([{ partition: 0, low: '0', high: '0' }], 100, 'latest')).toEqual([]);
  });

  it('survives offsets past what a number can hold', () => {
    const huge = [{ partition: 0, low: '0', high: '9007199254740999' }];
    expect(windowFor(huge, 10, 'latest')[0]).toMatchObject({ from: '9007199254740989', quota: 10 });
  });
});

describe('a message as a line of NDJSON', () => {
  it('merges the payload at the top level, so SELECT url works', () => {
    expect(JSON.parse(envelope(record, 'json'))).toEqual({
      _partition: 2,
      _offset: 41,
      _timestamp: '2026-10-01T07:05:38.080Z',
      _key: 'k-1',
      user_id: 7,
      url: 'https://x/7',
    });
  });

  it('keeps the body whole when text was asked for', () => {
    expect(JSON.parse(envelope(record, 'text'))).toMatchObject({ message: record.value });
  });

  it('keeps a body that is not a JSON object as a message', () => {
    expect(JSON.parse(envelope({ ...record, value: 'not json at all' }, 'json')))
      .toMatchObject({ message: 'not json at all' });
    expect(JSON.parse(envelope({ ...record, value: '[1,2,3]' }, 'json')))
      .toMatchObject({ message: '[1,2,3]' });
  });

  it('lets the payload win a collision, because it is the user data', () => {
    expect(JSON.parse(envelope({ ...record, value: '{"_offset":"theirs"}' }, 'json'))._offset)
      .toBe('theirs');
  });

  it('records a missing key as null rather than dropping the column', () => {
    expect(JSON.parse(envelope({ ...record, key: undefined }, 'json'))._key).toBeNull();
  });
});

describe('inferring the fields of a topic', () => {
  it('names a type per field', () => {
    const lines = [
      JSON.stringify({ id: 1, ratio: 0.5, ok: true, name: 'x', nested: { a: 1 } }),
      JSON.stringify({ id: 2, ratio: 1.5, ok: false, name: 'y', nested: { a: 2 } }),
    ];
    expect(inferColumns(lines)).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'ratio', type: 'DOUBLE' },
      { name: 'ok', type: 'BOOLEAN' },
      { name: 'name', type: 'VARCHAR' },
      { name: 'nested', type: 'JSON' },
    ]);
  });

  it('takes the union across messages of different shapes', () => {
    const lines = [JSON.stringify({ a: 1 }), JSON.stringify({ b: 'two' })];
    expect(inferColumns(lines).map(c => c.name)).toEqual(['a', 'b']);
  });

  it('ignores a line that is not an object', () => {
    expect(inferColumns(['not json', '[1,2]', JSON.stringify({ a: 1 })]).map(c => c.name)).toEqual(['a']);
  });

  it('widens a field that arrived as several shapes', () => {
    expect(widen(new Set(['BIGINT']))).toBe('BIGINT');
    expect(widen(new Set(['BIGINT', 'null']))).toBe('BIGINT');
    expect(widen(new Set(['null']))).toBe('VARCHAR');
    expect(widen(new Set(['BIGINT', 'VARCHAR']))).toBe('VARCHAR');
    expect(widen(new Set(['JSON', 'VARCHAR']))).toBe('JSON');
  });
});

describe('gathering what the tree would like but can do without', () => {
  it('runs the work and keeps every answer', async () => {
    const done = await gatherWithin([1, 2, 3], async n => n * 10, { concurrency: 2, budgetMs: 1000 });
    expect([...done.entries()]).toEqual([[1, 10], [2, 20], [3, 30]]);
  });

  it('runs several at once rather than one after another', async () => {
    // 515 topics at one round trip each took 89 seconds on a real cluster.
    let inFlight = 0;
    let peak = 0;
    await gatherWithin(Array.from({ length: 20 }, (_, i) => i), async n => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return n;
    }, { concurrency: 8, budgetMs: 1000 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('stops when the budget is spent and returns what it has', async () => {
    let clock = 0;
    const done = await gatherWithin([1, 2, 3, 4], async n => { clock += 10; return n; }, {
      concurrency: 1,
      budgetMs: 25,
      now: () => clock,
    });
    // Three ticks of ten fit inside twenty-five; the fourth is never started.
    expect([...done.keys()]).toEqual([1, 2, 3]);
  });

  it('drops a single failure instead of losing the whole listing', async () => {
    const done = await gatherWithin([1, 2, 3], async n => {
      if (n === 2) throw new Error('this broker will not say');
      return n;
    }, { concurrency: 2, budgetMs: 1000 });
    expect([...done.keys()]).toEqual([1, 3]);
  });

  it('has nothing to do with nothing to do', async () => {
    expect((await gatherWithin([], async () => 1, { concurrency: 4, budgetMs: 10 })).size).toBe(0);
  });
});

describe('tree nodes', () => {
  it('shows what a topic holds and hands over a statement that runs', () => {
    expect(topicNodes([{ name: 'events', partitions: 3, messages: 1200 }])).toEqual([{
      kind: 'table',
      name: 'events',
      detail: '3 partitions, 1200 messages',
      hasChildren: true,
      insert: '"events"',
      query: 'SELECT *\nFROM "events"\nLIMIT 100',
    }]);
  });

  it('says partition, singular, when there is one', () => {
    expect(topicNodes([{ name: 'a', partitions: 1, messages: 1 }])[0]?.detail)
      .toBe('1 partition, 1 message');
  });

  it('leaves the count out when the cluster would not say', () => {
    expect(topicNodes([{ name: 'a', partitions: 2 }])[0]?.detail).toBe('2 partitions');
  });

  it('sorts topics, because a cluster lists them in no order anyone wants', () => {
    expect(topicNodes([
      { name: 'orders', partitions: 1 },
      { name: 'events', partitions: 1 },
    ]).map(n => n.name)).toEqual(['events', 'orders']);
  });

  it('shapes fields as leaves carrying their type', () => {
    expect(columnNodes([{ name: 'user_id', type: 'BIGINT' }])).toEqual([{
      kind: 'column', name: 'user_id', detail: 'BIGINT', hasChildren: false, insert: '"user_id"',
    }]);
  });
});

describe('turning a window into a table', () => {
  it('reads the spooled file by name and widens mismatched shapes', () => {
    const sql = materializeSql('events', '/tmp/x/events.ndjson', 'json');
    expect(sql).toMatch(/CREATE OR REPLACE TABLE "events" AS/);
    expect(sql).toMatch(/read_json\('\/tmp\/x\/events\.ndjson', format = 'newline_delimited', union_by_name = true/);
  });

  it('pins the columns for text, where there is nothing to infer', () => {
    expect(materializeSql('events', '/tmp/x.ndjson', 'text')).toMatch(/columns = \{.*message: 'VARCHAR'\}/);
  });

  it('quotes a topic whose name would not parse bare', () => {
    expect(materializeSql('order-events', '/tmp/x.ndjson', 'json')).toMatch(/TABLE "order-events"/);
  });

  it('gives an empty topic a table anyway, so a SELECT answers instead of failing', () => {
    expect(emptyTableSql('events', [{ name: 'user_id', type: 'BIGINT' }]))
      .toBe('CREATE OR REPLACE TABLE "events" (_partition INTEGER, _offset BIGINT, _timestamp TIMESTAMP, _key VARCHAR, "user_id" BIGINT)');
  });

  it('does not declare a metadata column twice', () => {
    const sql = emptyTableSql('events', [{ name: '_offset', type: 'BIGINT' }, { name: 'a', type: 'VARCHAR' }]);
    expect(sql.match(/_offset/g)).toHaveLength(1);
  });
});

describe('error classification', () => {
  const cases: readonly [string, unknown, ErrorCode][] = [
    ['a rejected SASL exchange', Object.assign(new Error('x'), { name: 'KafkaJSSASLAuthenticationError' }), 'auth'],
    ['a topic the ACLs hide', Object.assign(new Error('x'), { type: 'TOPIC_AUTHORIZATION_FAILED' }), 'auth'],
    ['a mechanism the cluster refuses', Object.assign(new Error('x'), { type: 'UNSUPPORTED_SASL_MECHANISM' }), 'auth'],
    ['a topic that is not there', Object.assign(new Error('x'), { type: 'UNKNOWN_TOPIC_OR_PARTITION' }), 'not_found'],
    ['a broker that hung up', Object.assign(new Error('x'), { name: 'KafkaJSConnectionError' }), 'network'],
    ['retries run out', Object.assign(new Error('x'), { name: 'KafkaJSNumberOfRetriesExceeded' }), 'network'],
    ['nothing listening', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'network'],
    ['a request that timed out', Object.assign(new Error('x'), { name: 'KafkaJSRequestTimeoutError' }), 'timeout'],
    ['the broker saying it timed out', Object.assign(new Error('x'), { type: 'REQUEST_TIMED_OUT' }), 'timeout'],
    ['something else entirely', new Error('x'), 'internal'],
  ];

  for (const [name, error, expected] of cases) {
    it(`maps ${name} to ${expected}`, () => {
      expect(classifyKafkaError(error)).toBe(expected);
    });
  }
});

describe('error wrapping', () => {
  it('names the connection, keeps the protocol type and marks a network failure retryable', () => {
    const wrapped = kafkaError(Object.assign(new Error('no route'), { name: 'KafkaJSConnectionError' }), 'bus');
    expect(wrapped.code).toBe('network');
    expect(wrapped.details.connection).toBe('bus');
    expect(wrapped.details.retryable).toBe(true);
    expect(wrapped.details.hint).toMatch(/brokers/);
  });

  it('points an auth failure at the mechanism as well as the password', () => {
    const wrapped = kafkaError(Object.assign(new Error('nope'), { type: 'SASL_AUTHENTICATION_FAILED' }), 'bus');
    expect(wrapped.code).toBe('auth');
    expect(wrapped.details.nativeCode).toBe('SASL_AUTHENTICATION_FAILED');
    expect(wrapped.details.hint).toMatch(/saslMechanism/);
  });

  it('passes a DbRexError through untouched', () => {
    const original = new DbRexError('forbidden', 'no');
    expect(kafkaError(original, 'bus')).toBe(original);
  });

  it('turns a missing table into advice about the tree', () => {
    const wrapped = duckError(new Error('Catalog Error: Table with name nope does not exist!'), 'bus');
    expect(wrapped.code).toBe('sql');
    expect(wrapped.details.hint).toMatch(/"nope" is not a topic/);
  });

  it('leaves an ordinary statement error without an invented hint', () => {
    expect(duckError(new Error('Parser Error: syntax error'), 'bus').details.hint).toBeUndefined();
  });
});

describe('the closed sets a connection file is checked against', () => {
  it('lists the mechanisms, formats and positions the provider accepts', () => {
    expect([...SASL_MECHANISMS]).toEqual(['plain', 'scram-sha-256', 'scram-sha-512']);
    expect([...MESSAGE_FORMATS]).toEqual(['json', 'text']);
    expect([...START_POSITIONS]).toEqual(['latest', 'earliest']);
  });
});

describe('fields that differ only in case', () => {
  const fold = (objects: readonly unknown[]) =>
    foldCaseCollisions(objects.map(o => JSON.stringify(o)));

  const parsed = (result: { lines: string[] }) =>
    result.lines.map(l => JSON.parse(l) as Record<string, unknown>);

  it('leaves a field nobody spells two ways exactly as it is', () => {
    const result = fold([{ isWifi: true }, { isWifi: false }]);
    expect(parsed(result)).toEqual([{ isWifi: true }, { isWifi: false }]);
    expect(result.unified).toEqual([]);
  });

  it('unifies two spellings across messages, first seen winning', () => {
    const result = fold([{ isWiFi: 1 }, { isWifi: 2 }]);
    expect(parsed(result)).toEqual([{ isWiFi: 1 }, { isWiFi: 2 }]);
    expect(result.unified).toEqual(['isWiFi']);
  });

  it('keeps every value, only renaming the key', () => {
    const result = fold([{ a: 1, isWifi: true }, { ISWIFI: false, b: 2 }]);
    expect(parsed(result)).toEqual([{ a: 1, isWifi: true }, { isWifi: false, b: 2 }]);
  });

  it('reaches inside nested objects', () => {
    const result = fold([{ p: { isWiFi: 1 } }, { p: { iswifi: 2 } }]);
    expect(parsed(result)).toEqual([{ p: { isWiFi: 1 } }, { p: { isWiFi: 2 } }]);
    expect(result.unified).toEqual(['p.isWiFi']);
  });

  it('reaches inside arrays of objects', () => {
    const result = fold([{ xs: [{ isWiFi: 1 }] }, { xs: [{ ISWIFI: 2 }] }]);
    expect(parsed(result)).toEqual([{ xs: [{ isWiFi: 1 }] }, { xs: [{ isWiFi: 2 }] }]);
  });

  it('scopes a name to its path, so unrelated fields do not drag each other', () => {
    // `meta.ID` must not be renamed because `payload.id` was seen first.
    const result = fold([{ payload: { id: 1 }, meta: { ID: 2 } }]);
    expect(parsed(result)).toEqual([{ payload: { id: 1 }, meta: { ID: 2 } }]);
    expect(result.unified).toEqual([]);
  });

  it('reports the field when one message carries both spellings', () => {
    // One value has to go, the same loss JSON takes on a repeated key. What
    // matters is that it is named rather than folded in silence.
    const result = fold([{ isWifi: 1, isWiFi: 2 }]);
    expect(result.unified).toEqual(['isWifi']);
    expect(parsed(result)).toEqual([{ isWifi: 2 }]);
  });

  it('passes a line that is not JSON straight through', () => {
    expect(foldCaseCollisions(['not json at all']).lines).toEqual(['not json at all']);
  });

  it('leaves nulls, numbers and strings alone', () => {
    const result = fold([{ a: null, b: 1, c: 'x', d: [1, 2] }]);
    expect(parsed(result)).toEqual([{ a: null, b: 1, c: 'x', d: [1, 2] }]);
  });

  it('handles an empty window', () => {
    expect(foldCaseCollisions([])).toEqual({ lines: [], unified: [] });
  });
});
