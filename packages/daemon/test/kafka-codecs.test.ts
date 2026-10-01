import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import { CompressionCodecs, CompressionTypes } from 'kafkajs';
import { compress as snappyCompress } from 'snappyjs';
import * as lz4 from 'lz4js';
import { DbRexError } from '@dbrex/core';
import {
  decompressLz4,
  decompressSnappy,
  decompressZstd,
  registerKafkaCodecs,
  zstdFromNode,
} from '../src/providers/kafka-codecs';

/** A batch worth compressing: repetitive enough that every codec shrinks it. */
const BODY = Buffer.from(
  Array.from({ length: 200 }, (_, i) => JSON.stringify({ user_id: i, url: `https://example/${i}` })).join('\n'),
);

/**
 * Xerial's stream framing, which is what the Java producer writes.
 *
 * Built here rather than taken from a fixture so the test says what the format
 * is: a magic header, two version words, then length-prefixed snappy blocks.
 */
function xerial(blocks: readonly Buffer[]): Buffer {
  const header = Buffer.concat([
    Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(1, 0); b.writeUInt32BE(1, 4); return b; })(),
  ]);
  const framed = blocks.flatMap(block => {
    const compressed = Buffer.from(snappyCompress(block));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(compressed.length, 0);
    return [size, compressed];
  });
  return Buffer.concat([header, ...framed]);
}

describe('snappy', () => {
  it('reads a raw block', () => {
    expect(decompressSnappy(Buffer.from(snappyCompress(BODY)))).toEqual(BODY);
  });

  it('reads the xerial framing the Java producer writes', () => {
    expect(decompressSnappy(xerial([BODY]))).toEqual(BODY);
  });

  it('joins several framed blocks back into one batch', () => {
    const half = BODY.length >> 1;
    expect(decompressSnappy(xerial([BODY.subarray(0, half), BODY.subarray(half)]))).toEqual(BODY);
  });

  it('skips an empty block rather than failing on it', () => {
    const framed = xerial([BODY]);
    const zero = Buffer.alloc(4);
    expect(decompressSnappy(Buffer.concat([framed, zero]))).toEqual(BODY);
  });

  it('refuses a frame claiming more bytes than the batch holds', () => {
    const framed = xerial([BODY]);
    framed.writeUInt32BE(0xffff, 16);
    expect(() => decompressSnappy(framed)).toThrow(DbRexError);
  });
});

describe('lz4', () => {
  it('reads a frame back to the bytes that went in', () => {
    expect(decompressLz4(Buffer.from(lz4.compress(BODY)))).toEqual(BODY);
  });
});

describe('zstd', () => {
  it('reads a frame back to the bytes that went in', () => {
    const compressed = (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(BODY);
    expect(decompressZstd(compressed)).toEqual(BODY);
  });

  it('is what this Node offers, when it offers one', () => {
    expect(zstdFromNode()).toBeTypeOf('function');
  });

  it('says which Node would read the topic when this one cannot', () => {
    // The branch that matters on an older runtime, which this one is not.
    try {
      decompressZstd(Buffer.alloc(4), () => undefined);
      expect.unreachable('should have refused');
    } catch (e) {
      expect((e as DbRexError).code).toBe('config');
      expect((e as DbRexError).message).toMatch(/zstd/);
      expect((e as DbRexError).details.hint).toMatch(/22\.15/);
    }
  });
});

interface Codec {
  compress(payload: { buffer: Buffer }): unknown;
  decompress(buffer: Buffer): Promise<Buffer>;
}

/** KafkaJS types its registry as a fixed shape, so reaching one needs a cast. */
function snappyCodec(): Codec {
  const codecs = CompressionCodecs as unknown as Record<number, () => Codec>;
  return codecs[CompressionTypes.Snappy]!();
}

describe('registration with KafkaJS', () => {
  it('fills in the three codecs KafkaJS leaves unimplemented', () => {
    registerKafkaCodecs();
    const codecs = CompressionCodecs as unknown as Record<number, unknown>;
    for (const type of [CompressionTypes.Snappy, CompressionTypes.LZ4, CompressionTypes.ZSTD]) {
      expect(typeof codecs[type]).toBe('function');
    }
  });

  it('is safe to call for every session', () => {
    registerKafkaCodecs();
    registerKafkaCodecs();
    expect(typeof snappyCodec().decompress).toBe('function');
  });

  it('decompresses through the registered codec', async () => {
    registerKafkaCodecs();
    await expect(snappyCodec().decompress(xerial([BODY]))).resolves.toEqual(BODY);
  });

  it('refuses to compress instead of quietly writing plaintext', () => {
    registerKafkaCodecs();
    // dbrex never produces. A codec that answered this call would be writing a
    // batch the cluster would then hand to a reader expecting snappy.
    expect(() => snappyCodec().compress({ buffer: BODY })).toThrow(/never produces/);
  });
});
