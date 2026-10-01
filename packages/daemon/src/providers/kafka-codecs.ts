/**
 * Decompression for the batch formats KafkaJS does not implement.
 *
 * KafkaJS ships gzip and nothing else: snappy, lz4 and zstd each throw
 * `KafkaJSNotImplemented` the moment a fetch returns a compressed batch. Since
 * every producer worth the name compresses, a reader without these can list a
 * cluster's topics and then fail to read a single message out of any of them —
 * which is how this was found, against a container, rather than in a test.
 *
 * Decompression only. Nothing here produces, so the compress half refuses
 * rather than pretending: a codec that silently wrote uncompressed batches
 * would be a worse surprise than an error.
 *
 * All three implementations are pure JavaScript (or Node's own zlib), because
 * the alternative is a native module, and the whole point of browsing a cluster
 * through KafkaJS is that it costs nothing to install.
 */

import * as zlib from 'node:zlib';
import { CompressionCodecs, CompressionTypes } from 'kafkajs';
import { uncompress as snappyUncompress } from 'snappyjs';
import * as lz4 from 'lz4js';
import { DbRexError } from '@dbrex/core';

/**
 * Xerial's framing, which is what Kafka's snappy actually is.
 *
 * The Java client has always written snappy through the `xerial` library, whose
 * stream format is a magic header, two version words, and then length-prefixed
 * blocks. Handing that to a raw snappy decoder produces a corrupt-input error
 * that says nothing about framing. Raw blocks still occur, so the header is
 * tested for rather than assumed.
 */
const XERIAL_MAGIC = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]);
const XERIAL_HEADER_BYTES = 16;

export function decompressSnappy(buffer: Buffer): Buffer {
  if (!buffer.subarray(0, XERIAL_MAGIC.length).equals(XERIAL_MAGIC)) {
    return Buffer.from(snappyUncompress(buffer));
  }

  const blocks: Buffer[] = [];
  let at = XERIAL_HEADER_BYTES;
  while (at + 4 <= buffer.length) {
    const size = buffer.readUInt32BE(at);
    at += 4;
    if (size === 0) continue;
    if (at + size > buffer.length) {
      throw new DbRexError('internal', 'a snappy block claims more bytes than the batch holds');
    }
    blocks.push(Buffer.from(snappyUncompress(buffer.subarray(at, at + size))));
    at += size;
  }
  return Buffer.concat(blocks);
}

export function decompressLz4(buffer: Buffer): Buffer {
  return Buffer.from(lz4.decompress(buffer));
}

/**
 * Zstd, when the runtime has it.
 *
 * Node grew zstd in its own zlib in v22.15. Below that there is no pure
 * JavaScript decoder worth depending on, so this says which Node would read the
 * topic instead of failing as a corrupt batch.
 */
export type ZstdDecompressor = (buffer: Buffer) => Buffer;

/** Node's own zstd, if this Node has it. Separate so the absence can be tested. */
export function zstdFromNode(): ZstdDecompressor | undefined {
  const decompress = (zlib as unknown as { zstdDecompressSync?: ZstdDecompressor }).zstdDecompressSync;
  return typeof decompress === 'function' ? decompress : undefined;
}

/**
 * The lookup is the seam, not the function it returns: a default parameter is
 * applied to an explicit `undefined` as well, so a test could never say "this
 * runtime has no zstd" by passing one.
 */
export function decompressZstd(buffer: Buffer, lookup = zstdFromNode): Buffer {
  const decompress = lookup();
  if (decompress === undefined) {
    throw new DbRexError('config', 'this topic is zstd-compressed and this Node cannot read it', {
      hint: `zstd arrived in Node 22.15; this daemon runs ${process.version}`,
    });
  }
  return decompress(buffer);
}

function refuseToCompress(codec: string): () => never {
  return () => {
    throw new DbRexError('internal', `dbrex never produces to Kafka, so it has no ${codec} compressor`);
  };
}

/**
 * Teach KafkaJS the three codecs it is missing.
 *
 * Idempotent, because every session builds a client and the registry is global
 * to the module. Called from the provider rather than at import time so that
 * nothing happens in a process that never opens a Kafka connection.
 */
export function registerKafkaCodecs(): void {
  CompressionCodecs[CompressionTypes.Snappy] = () => ({
    compress: refuseToCompress('snappy'),
    decompress: (buffer: Buffer) => Promise.resolve(decompressSnappy(buffer)),
  });
  CompressionCodecs[CompressionTypes.LZ4] = () => ({
    compress: refuseToCompress('lz4'),
    decompress: (buffer: Buffer) => Promise.resolve(decompressLz4(buffer)),
  });
  CompressionCodecs[CompressionTypes.ZSTD] = () => ({
    compress: refuseToCompress('zstd'),
    decompress: (buffer: Buffer) => Promise.resolve(decompressZstd(buffer)),
  });
}
