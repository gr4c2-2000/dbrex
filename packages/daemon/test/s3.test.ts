import { describe, expect, it } from 'vitest';
import {
  DbRexError,
  validateOptions,
  type ErrorCode,
  type FieldSpec,
  type InteractionRequest,
  type ProviderIo,
  type SecretPurpose,
} from '@dbrex/core';
import {
  baseName,
  bucketNodes,
  classifyDuckdbError,
  classifyS3Error,
  daemonConfigDir,
  describeS3Failure,
  duckReaderFor,
  duckdbError,
  explainDuckdbError,
  humanSize,
  joinPrefix,
  listLevel,
  normalizeValue,
  objectPageOf,
  redactSecret,
  s3Error,
  s3Provider,
  s3ReadTemplate,
  s3SetupSql,
  type ObjectLister,
  type ObjectPage,
  type S3Settings,
} from '../src/providers/s3';

/** Two representative on-prem configs, minus the `kind` the registry strips off. */
const CDN = {
  endpoint: 'cdn.example.net',
  user: 'AKIAIOSFODNN7EXAMPLE',
  pathStyle: true,
  useSsl: true,
  region: 'us-east-1',
};

const CEPH = {
  endpoint: 'ceph.example.net',
  user: 'IHAVENOIDEAWHATIMDOING',
  pathStyle: true,
  useSsl: false,
  region: 'us-east-1',
};

function field(name: string): FieldSpec | undefined {
  return s3Provider.fields.find(f => f.name === name);
}

function settings(over: Partial<S3Settings> = {}): S3Settings {
  return {
    region: 'us-east-1',
    endpoint: 'ceph.example.net',
    pathStyle: true,
    useSsl: true,
    accessKeyId: 'AKIA',
    secretAccessKey: 'shhh',
    ...over,
  };
}

class FakeLister implements ObjectLister {
  readonly calls: { bucket: string; prefix: string; token: string | undefined }[] = [];

  constructor(
    private readonly pages: readonly ObjectPage[],
    private readonly names: readonly string[] = [],
  ) {}

  async buckets(): Promise<readonly string[]> {
    return this.names;
  }

  async objects(bucket: string, prefix: string, token: string | undefined): Promise<ObjectPage> {
    this.calls.push({ bucket, prefix, token });
    const page = this.pages[this.calls.length - 1];
    if (page === undefined) throw new Error(`unexpected extra listing call for ${prefix}`);
    return page;
  }
}

function page(over: Partial<ObjectPage> = {}): ObjectPage {
  return { prefixes: [], objects: [], nextToken: undefined, ...over };
}

function fakeIo(secret: string, asked: SecretPurpose[] = []): ProviderIo {
  return {
    secret: async (purpose: SecretPurpose) => {
      asked.push(purpose);
      return secret;
    },
    storedSecret: async () => secret,
    rememberSecret: async () => {},
    interactive: async (_request: InteractionRequest) => {},
    log: () => {},
  };
}

describe('field declarations', () => {
  it('validates the live wphcdn config with no problems', () => {
    expect(validateOptions(CDN, s3Provider.fields)).toEqual([]);
  });

  it('validates the live ceph config with no problems', () => {
    expect(validateOptions(CEPH, s3Provider.fields)).toEqual([]);
  });

  it('declares exactly the options this provider reads', () => {
    expect(s3Provider.fields.map(f => f.name).sort())
      .toEqual(['bucket', 'caCertPath', 'endpoint', 'pathStyle', 'region', 'useSsl', 'user']);
  });

  it('requires the access key id and substitutes $user/$env into it', () => {
    expect(field('user')?.required).toBe(true);
    expect(field('user')?.substitute).toBe(true);
  });

  it('defaults the region and https, and leaves pathStyle to the endpoint', () => {
    expect(field('region')?.default).toBe('us-east-1');
    expect(field('useSsl')?.default).toBe(true);
    expect(field('pathStyle')?.default).toBeUndefined();
  });

  it('describes every field for the wizard', () => {
    for (const f of s3Provider.fields) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.prompt).toBe(true);
    }
  });

  it('rejects an unknown option and a mistyped one', () => {
    expect(validateOptions({ ...CDN, password: 'hunter2' }, s3Provider.fields))
      .toEqual([{ field: 'password', message: 'unknown option "password"' }]);
    expect(validateOptions({ ...CDN, pathStyle: 'yes' }, s3Provider.fields))
      .toEqual([{ field: 'pathStyle', message: 'option "pathStyle" must be a boolean, got string' }]);
  });

  it('accepts a bucket-scoped config', () => {
    expect(validateOptions({ ...CEPH, bucket: 'analytics' }, s3Provider.fields)).toEqual([]);
  });
});

describe('capabilities', () => {
  const caps = s3Provider.capabilities;

  it('does not claim to stream, because run() materialises the whole result', () => {
    expect(caps.streams).toBe(false);
  });

  it('does not claim cancellation, because node-api has no interrupt', () => {
    expect(caps.cancel).toBe('none');
  });

  it('claims LIMIT, plan-only EXPLAIN and browsing, but no validate or settings', () => {
    expect(caps.limit).toBe('limit');
    expect(caps.explain).toBe('plan');
    expect(caps.browse).toBe(true);
    expect(caps.validate).toBe(false);
    expect(caps.settings).toBe(false);
  });

  it('offers DuckDB keywords, readers included', () => {
    expect(caps.keywords).toContain('SELECT');
    expect(caps.keywords).toContain('read_parquet');
    expect(caps.keywords).toContain('QUALIFY');
  });
});

describe('httpfs setup SQL', () => {
  it('installs httpfs and points it at the endpoint', () => {
    expect(s3SetupSql(settings())).toEqual([
      'INSTALL httpfs;',
      'LOAD httpfs;',
      "SET s3_region='us-east-1';",
      "SET s3_endpoint='ceph.example.net';",
      "SET s3_url_style='path';",
      'SET s3_use_ssl=true;',
      "SET s3_access_key_id='AKIA';",
      "SET s3_secret_access_key='shhh';",
    ]);
  });

  it('turns SSL off for a plain-http gateway', () => {
    expect(s3SetupSql(settings({ useSsl: false }))).toContain('SET s3_use_ssl=false;');
  });

  it('uses vhost addressing when pathStyle is off', () => {
    expect(s3SetupSql(settings({ pathStyle: false }))).toContain("SET s3_url_style='vhost';");
  });

  it('omits the endpoint entirely for real AWS', () => {
    expect(s3SetupSql(settings({ endpoint: undefined })).some(s => s.includes('s3_endpoint'))).toBe(false);
  });

  it('omits credentials that were never configured', () => {
    const sql = s3SetupSql(settings({ accessKeyId: undefined, secretAccessKey: undefined }));
    expect(sql.some(s => s.includes('s3_access_key_id'))).toBe(false);
    expect(sql.some(s => s.includes('s3_secret_access_key'))).toBe(false);
  });

  it("escapes a quote in the secret so it cannot end the literal", () => {
    const sql = s3SetupSql(settings({ secretAccessKey: "ab'; DROP TABLE t; --" }));
    expect(sql).toContain("SET s3_secret_access_key='ab''; DROP TABLE t; --';");
  });
});

describe('reader selection', () => {
  it('reads parquet as parquet', () => {
    expect(duckReaderFor('events/day=1/part-0.parquet')).toBe('read_parquet');
    expect(duckReaderFor('EVENTS.PQ')).toBe('read_parquet');
  });

  it('reads json, ndjson and jsonl as json', () => {
    expect(duckReaderFor('a.json')).toBe('read_json_auto');
    expect(duckReaderFor('a.ndjson')).toBe('read_json_auto');
    expect(duckReaderFor('a.JSONL')).toBe('read_json_auto');
  });

  it('lets DuckDB sniff anything else', () => {
    expect(duckReaderFor('a.csv')).toBe('read_csv_auto');
    expect(duckReaderFor('a.tsv.gz')).toBe('read_csv_auto');
    expect(duckReaderFor('logs/no-extension')).toBe('read_csv_auto');
  });
});

describe('insert template', () => {
  it('builds a runnable SELECT over the s3 url', () => {
    expect(s3ReadTemplate('analytics', 'events/day=1/part-0.parquet'))
      .toBe("SELECT * FROM read_parquet('s3://analytics/events/day=1/part-0.parquet') LIMIT 100");
  });

  it('escapes a quote in the key', () => {
    expect(s3ReadTemplate('b', "o'clock.csv"))
      .toBe("SELECT * FROM read_csv_auto('s3://b/o''clock.csv') LIMIT 100");
  });
});

describe('human sizes', () => {
  it('stays in bytes below a kilobyte', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1023)).toBe('1023 B');
  });

  it('climbs one unit at a time', () => {
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(humanSize(3 * 1024 ** 4)).toBe('3.0 TB');
  });

  it('stops at terabytes rather than running off the unit list', () => {
    expect(humanSize(4096 * 1024 ** 4)).toBe('4096.0 TB');
  });
});

describe('names and prefixes', () => {
  it('takes the basename of a key', () => {
    expect(baseName('events/day=1/part-0.parquet')).toBe('part-0.parquet');
    expect(baseName('top.csv')).toBe('top.csv');
  });

  it('ignores the trailing slash of a common prefix', () => {
    expect(baseName('events/day=1/')).toBe('day=1');
    expect(baseName('events/')).toBe('events');
  });

  it('rebuilds an S3 prefix from the tree path', () => {
    expect(joinPrefix([])).toBe('');
    expect(joinPrefix(['events'])).toBe('events/');
    expect(joinPrefix(['events', 'day=1'])).toBe('events/day=1/');
  });
});

describe('list response translation', () => {
  it('reads the fields of a realistic ListObjectsV2 response', () => {
    expect(objectPageOf({
      CommonPrefixes: [{ Prefix: 'events/day=1/' }, { Prefix: 'events/day=2/' }],
      Contents: [{ Key: 'events/manifest.json', Size: 2048 }],
      IsTruncated: true,
      NextContinuationToken: 'tok',
    })).toEqual({
      prefixes: ['events/day=1/', 'events/day=2/'],
      objects: [{ key: 'events/manifest.json', size: 2048 }],
      nextToken: 'tok',
    });
  });

  it('treats a complete page as the end of the listing', () => {
    expect(objectPageOf({ Contents: [{ Key: 'a.csv', Size: 1 }], IsTruncated: false }).nextToken)
      .toBeUndefined();
  });

  it('stops rather than looping when a truncated page carries no token', () => {
    expect(objectPageOf({ IsTruncated: true }).nextToken).toBeUndefined();
  });

  it('survives a response with nothing in it', () => {
    expect(objectPageOf({})).toEqual({ prefixes: [], objects: [], nextToken: undefined });
  });
});

describe('listing one level', () => {
  it('follows the continuation token until the listing ends', async () => {
    const lister = new FakeLister([
      page({ prefixes: ['events/day=1/'], nextToken: 'tok-1' }),
      page({ objects: [{ key: 'events/part-0.parquet', size: 1024 }] }),
    ]);

    const nodes = await listLevel(lister, 'analytics', 'events/');

    expect(lister.calls).toEqual([
      { bucket: 'analytics', prefix: 'events/', token: undefined },
      { bucket: 'analytics', prefix: 'events/', token: 'tok-1' },
    ]);
    expect(nodes.map(n => n.name)).toEqual(['day=1', 'part-0.parquet']);
  });

  it('skips the zero-length directory marker for the prefix itself', async () => {
    const lister = new FakeLister([
      page({ objects: [{ key: 'events/', size: 0 }, { key: 'events/a.csv', size: 10 }] }),
    ]);

    const nodes = await listLevel(lister, 'analytics', 'events/');

    expect(nodes.map(n => n.name)).toEqual(['a.csv']);
  });

  it('shapes a sub-prefix as an expandable container', async () => {
    const lister = new FakeLister([page({ prefixes: ['events/day=1/'] })]);

    expect(await listLevel(lister, 'analytics', 'events/')).toEqual([
      { kind: 'container', name: 'day=1', hasChildren: true },
    ]);
  });

  it('shapes an object with its size and a ready-to-run SELECT', async () => {
    const lister = new FakeLister([page({ objects: [{ key: 'events/part-0.parquet', size: 2048 }] })]);

    expect(await listLevel(lister, 'analytics', 'events/')).toEqual([
      {
        kind: 'object',
        name: 'part-0.parquet',
        detail: '2.0 KB',
        hasChildren: false,
        insert: 's3://analytics/events/part-0.parquet',
        query: "SELECT * FROM read_parquet('s3://analytics/events/part-0.parquet') LIMIT 100",
      },
    ]);
  });

  it('omits the detail line when the listing gave no size', async () => {
    const lister = new FakeLister([page({ objects: [{ key: 'a.csv', size: undefined }] })]);
    const [node] = await listLevel(lister, 'analytics', '');

    expect(node?.detail).toBeUndefined();
  });

  it('roots buckets as expandable databases', () => {
    expect(bucketNodes(['analytics', 'backups'])).toEqual([
      { kind: 'database', name: 'analytics', hasChildren: true },
      { kind: 'database', name: 'backups', hasChildren: true },
    ]);
  });
});

describe('value normalisation', () => {
  it('narrows a bigint to a number while it stays exact', () => {
    expect(normalizeValue(42n)).toBe(42);
    expect(normalizeValue(-7n)).toBe(-7);
  });

  it('keeps an oversized bigint as a string rather than losing digits', () => {
    expect(normalizeValue(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('unwraps the { items } shape node-api gives a LIST', () => {
    expect(normalizeValue({ items: [1n, 2n, 3n] })).toEqual([1, 2, 3]);
  });

  it('recurses through nested lists', () => {
    expect(normalizeValue({ items: [{ items: [1n] }, { items: [] }] })).toEqual([[1], []]);
    expect(normalizeValue([1n, { items: [2n] }])).toEqual([1, [2]]);
  });

  it('leaves plain JSON values alone', () => {
    expect(normalizeValue('a')).toBe('a');
    expect(normalizeValue(1.5)).toBe(1.5);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeUndefined();
  });

  it('falls back to a stable string for a struct', () => {
    expect(normalizeValue({ toString: () => 'STRUCT(a := 1)' })).toBe('STRUCT(a := 1)');
  });
});

describe('S3 error classification', () => {
  const cases: readonly (readonly [string, unknown, ErrorCode])[] = [
    ['a denied ListBuckets', { name: 'AccessDenied', message: 'Access Denied', $metadata: { httpStatusCode: 403 } }, 'auth'],
    ['a wrong access key', { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } }, 'auth'],
    ['a wrong secret', { name: 'SignatureDoesNotMatch', $metadata: { httpStatusCode: 403 } }, 'auth'],
    ['no credentials at all', { name: 'CredentialsProviderError', message: 'Could not load credentials' }, 'auth'],
    ['a missing bucket', { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'not_found'],
    ['a head on a missing key', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }, 'not_found'],
    ['a DNS failure', { name: 'Error', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND ceph.example.net' }, 'network'],
    ['a refused connection', { name: 'Error', code: 'ECONNREFUSED' }, 'network'],
    ['a certificate for the wrong host', { name: 'Error', code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'network'],
    ['a socket timeout', { name: 'TimeoutError', message: 'socket timed out' }, 'network'],
    ['a gateway that fell over', { name: 'InternalError', $metadata: { httpStatusCode: 500 } }, 'network'],
    ['a wrong region', { name: 'AuthorizationHeaderMalformed', $metadata: { httpStatusCode: 400 } }, 'config'],
    ['an abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'cancelled'],
  ];

  for (const [what, error, code] of cases) {
    it(`maps ${what} to ${code}`, () => {
      expect(classifyS3Error(error)).toBe(code);
    });
  }

  it('keeps the S3 error name and names the connection', () => {
    const wrapped = s3Error({ name: 'NoSuchBucket', message: 'The specified bucket does not exist', $metadata: { httpStatusCode: 404 } }, 'lake');

    expect(wrapped.code).toBe('not_found');
    expect(wrapped.message).toBe('The specified bucket does not exist');
    expect(wrapped.details.connection).toBe('lake');
    expect(wrapped.details.nativeCode).toBe('NoSuchBucket');
  });

  it('marks a transport failure retryable and hints at the endpoint', () => {
    const wrapped = s3Error({ name: 'Error', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND ceph' }, 'lake');

    expect(wrapped.code).toBe('network');
    expect(wrapped.details.retryable).toBe(true);
    expect(wrapped.details.hint).toContain('endpoint');
  });

  it('passes a DbRexError through untouched', () => {
    const original = new DbRexError('auth', 'already classified');
    expect(s3Error(original, 'lake')).toBe(original);
  });
});

describe('DuckDB error classification', () => {
  const cases: readonly (readonly [string, ErrorCode])[] = [
    ['Parser Error: syntax error at or near "selct"', 'sql'],
    ['Catalog Error: Table with name events does not exist!', 'sql'],
    ['Binder Error: Referenced column "day" not found in FROM clause!', 'sql'],
    ["HTTP Error: HTTP GET error on 's3://b/k.parquet' (HTTP 403 Forbidden)", 'auth'],
    ['IO Error: Unable to connect to URL: 404 (HTTP 404)', 'not_found'],
    ['IO Error: Connection error for HTTP HEAD to s3://b/k', 'network'],
  ];

  for (const [message, code] of cases) {
    it(`maps "${message.slice(0, 40)}..." to ${code}`, () => {
      expect(classifyDuckdbError(new Error(message))).toBe(code);
    });
  }

  it('reports an abort as a cancellation', () => {
    expect(classifyDuckdbError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('cancelled');
  });

  it('lets a DbRexError from loadDuckDB through unchanged', () => {
    const missing = new DbRexError('config', 'DuckDB is not installed', { hint: 'run `dbrex install-duckdb`' });
    expect(duckdbError(missing, 'lake', 'shhh')).toBe(missing);
  });
});

describe('the secret access key never escapes', () => {
  const secret = "s3cr3t'key";

  it('is stripped from a DuckDB error that echoes the statement back', () => {
    // DuckDB quotes the offending line in parser errors, and one of the lines
    // this provider runs is the one carrying the key.
    const echoed = new Error(
      `Parser Error: syntax error at or near ";"\nLINE 1: SET s3_secret_access_key='s3cr3t''key';\n`,
    );

    const wrapped = duckdbError(echoed, 'lake', secret);

    expect(wrapped.message).not.toContain(secret);
    expect(wrapped.message).not.toContain("s3cr3t''key");
    expect(wrapped.message).toContain('***');
  });

  it('is stripped whichever way it is spelled', () => {
    expect(redactSecret(`raw ${secret} and escaped s3cr3t''key`, secret)).toBe('raw *** and escaped ***');
  });

  it('leaves a message alone when there is no secret to hide', () => {
    expect(redactSecret('Parser Error', undefined)).toBe('Parser Error');
    expect(redactSecret('Parser Error', '')).toBe('Parser Error');
  });
});

describe('opening a session', () => {
  const spec = (options: Record<string, unknown>) => ({ name: 'lake', kind: 's3', options });
  const nowhere = { host: '', port: 0 };

  it('asks for the secret access key once, as a password', async () => {
    const asked: SecretPurpose[] = [];
    const session = await s3Provider.open(spec(CDN), nowhere, fakeIo('shhh', asked));

    expect(asked).toEqual([{ kind: 'password' }]);
    await session.close();
  });

  it('offers no diagnostics, because DuckDB parses only on execution', async () => {
    const session = await s3Provider.open(spec(CEPH), nowhere, fakeIo('shhh'));

    expect(await session.validate('SELECT 1')).toEqual([]);
    await session.close();
  });

  it('rejects an endpoint that carries a scheme and says what to write instead', async () => {
    const open = s3Provider.open(spec({ ...CEPH, endpoint: 'https://ceph.example.net' }), nowhere, fakeIo('shhh'));

    await expect(open).rejects.toMatchObject({ code: 'config' });
    await expect(open).rejects.toMatchObject({ details: { hint: expect.stringContaining('ceph.example.net') } });
  });

  it('refuses a connection with no access key id', async () => {
    const open = s3Provider.open(spec({ endpoint: 'ceph.example.net' }), nowhere, fakeIo('shhh'));

    await expect(open).rejects.toMatchObject({ code: 'config' });
  });

  it('closes cleanly when nothing was ever opened', async () => {
    const session = await s3Provider.open(spec(CDN), nowhere, fakeIo('shhh'));

    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe('the DuckDB config directory', () => {
  it('honours DBREX_HOME', () => {
    expect(daemonConfigDir({ DBREX_HOME: '/srv/dbrex' })).toBe('/srv/dbrex');
  });

  it('falls back to ~/.dbrex like the rest of the daemon', () => {
    expect(daemonConfigDir({})).toMatch(/\/\.dbrex$/);
  });
});

describe('a private certificate authority', () => {
  const base = {
    region: 'us-east-1',
    endpoint: 'ceph.example',
    pathStyle: true,
    accessKeyId: 'AKIA',
    secretAccessKey: 'shhh',
  };

  it('points DuckDB at the bundle and turns verification on', () => {
    // A corporate object store is fronted by a certificate from the company's
    // own authority, which is in nobody's default trust store; without this the
    // connection dies at the handshake with "unable to get local issuer
    // certificate" and never reaches S3 at all.
    const sql = s3SetupSql({ ...base, useSsl: true, caCertPath: '/home/marc/corp-root.cer' }).join('\n');
    expect(sql).toContain("SET ca_cert_file='/home/marc/corp-root.cer';");
    expect(sql).toContain('SET enable_server_cert_verification=true;');
  });

  it('says nothing about certificates on a plain HTTP endpoint', () => {
    const sql = s3SetupSql({ ...base, useSsl: false, caCertPath: '/home/marc/corp-root.cer' }).join('\n');
    expect(sql).not.toContain('ca_cert_file');
  });

  it('says nothing when no bundle is configured', () => {
    expect(s3SetupSql({ ...base, useSsl: true }).join('\n')).not.toContain('ca_cert_file');
  });

  it('is declared as a substitutable field, so ~ and $home work in it', () => {
    const field = s3Provider.fields.find(f => f.name === 'caCertPath');
    expect(field).toBeDefined();
    expect(field?.substitute).toBe(true);
  });

  it('accepts a real connection that names one', () => {
    expect(validateOptions({
      endpoint: 'wphcdn.example',
      user: 'AKIA',
      pathStyle: true,
      useSsl: true,
      region: 'us-east-1',
      caCertPath: '~/corp-root.cer',
    }, s3Provider.fields)).toEqual([]);
  });
});

describe('a gateway that answers without saying why', () => {
  it('reports the HTTP status when the SDK has no message', () => {
    // Ceph RGW answers some requests in a way the SDK files as a bare
    // `UnknownError` with an empty message, which told the user nothing at all.
    const bare = Object.assign(new Error(''), {
      name: 'UnknownError',
      $metadata: { httpStatusCode: 403 },
    });
    expect(describeS3Failure(bare)).toBe('the server answered HTTP 403 (UnknownError)');
  });

  it('keeps a real message when there is one', () => {
    const real = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
    expect(describeS3Failure(real)).toBe('The specified bucket does not exist');
  });

  it('still says something without any metadata', () => {
    expect(describeS3Failure(Object.assign(new Error(''), { name: 'UnknownError' })))
      .toBe('the server refused the request (UnknownError)');
  });
});

describe('picking a reader for a file', () => {
  it('reads avro as avro, not as CSV', () => {
    // Guessing CSV for a binary format produces DuckDB's least useful error: a
    // complaint that the file is not UTF-8, with a suggestion to set the
    // encoding — for a file that was never text.
    expect(duckReaderFor('features/part-2023-10-01.avro')).toBe('read_avro');
  });

  it('looks past the compression suffix', () => {
    expect(duckReaderFor('events/day.json.gz')).toBe('read_json_auto');
    expect(duckReaderFor('events/day.parquet.zst')).toBe('read_parquet');
    expect(duckReaderFor('events/day.avro.gz')).toBe('read_avro');
    expect(duckReaderFor('events/day.csv.gz')).toBe('read_csv_auto');
  });

  it('still falls back to CSV for anything unrecognised', () => {
    expect(duckReaderFor('dump/data.txt')).toBe('read_csv_auto');
    expect(duckReaderFor('dump/no-extension')).toBe('read_csv_auto');
  });

  it('is not fooled by the extension appearing mid-name', () => {
    expect(duckReaderFor('avro-exports/report.csv')).toBe('read_csv_auto');
  });
});

describe('engine errors that describe the symptom and not the cause', () => {
  it('explains the snappy allocation failure as an empty Avro file', () => {
    // Verified on a real 204-byte file: valid Avro, codec snappy, zero records.
    // The block decompresses to nothing, the Avro C library reads a NULL
    // allocation as failure, and the user is told about memory — on a file
    // smaller than this comment.
    const explanation = explainDuckdbError(
      'Invalid Input Error: Cannot decode file block: Cannot allocate memory for snappy',
    );
    expect(explanation).toMatch(/no records/);
    expect(explanation).toMatch(/not about memory or file size/);
  });

  it('explains a UTF-8 complaint as a binary file read as CSV', () => {
    expect(explainDuckdbError('Invalid unicode (byte sequence mismatch) detected'))
      .toMatch(/read as CSV/);
  });

  it('says nothing about errors it does not recognise', () => {
    expect(explainDuckdbError('Binder Error: Referenced column "x" not found')).toBeUndefined();
  });

  it('keeps the engine message itself intact for searching', () => {
    const error = duckdbError(
      new Error('Invalid Input Error: Cannot decode file block: Cannot allocate memory for snappy'),
      'lake',
      undefined,
    );
    expect(error.message).toContain('Cannot allocate memory for snappy');
    expect(error.details.hint).toMatch(/no records/);
  });
});
