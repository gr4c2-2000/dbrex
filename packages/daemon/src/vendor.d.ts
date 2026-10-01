/**
 * Types for dependencies that ship none.
 *
 * Only the entry points this daemon calls. Writing out a fuller surface than is
 * used would be inventing a contract on the library's behalf.
 *
 * Not named after the module that uses them: a `foo.d.ts` sitting beside a
 * `foo.ts` is read as that file's own declarations and ignored.
 */

declare module 'snappyjs' {
  export function uncompress(buffer: Uint8Array): Uint8Array;
  export function compress(buffer: Uint8Array): Uint8Array;
}

declare module 'lz4js' {
  export function decompress(buffer: Uint8Array): Uint8Array;
  export function compress(buffer: Uint8Array): Uint8Array;
}
