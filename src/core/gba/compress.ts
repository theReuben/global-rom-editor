/**
 * Codec dispatch for GBA graphics.
 *
 * Vanilla Gen 3 compresses graphics with LZ77; pokeemerald-expansion
 * hacks may use their own `smol` codec instead. The two never collide
 * with EACH OTHER — LZ77's first byte is 0x10, whose low nibble is
 * `MODE_LZ77` — so one reader can serve both kinds of ROM.
 *
 * What they do collide with is UNCOMPRESSED data. Neither format has a
 * real magic number, so arbitrary bytes can open like either one, and
 * both misreads have already happened here: a raw palette starting
 * 0x93 0x6a parsed as a plausible `smol` header, and Roselia's raw
 * palette starting 0x10 parsed as LZ77. Only call these on data the
 * surrounding struct says is actually compressed; where the format
 * says "raw", read it raw and do not sniff.
 *
 * Writing stays LZ77-only, and that is a deliberate choice rather than a
 * gap: the expansion's own decompressor dispatches on the same header
 * byte, so an LZ77 stream written into a `smol` ROM is decompressed
 * correctly by the game. Sprite importing therefore works on those ROMs
 * without this editor having to implement a `smol` COMPRESSOR.
 */
import { lz77CompressedSize, lz77Decompress } from './lz77'
import { isSmol, smolCompressedSize, smolDecompress } from './smol'

/** True when `off` holds an LZ77 stream. */
export function isLz77(bytes: Uint8Array, off: number): boolean {
  return off >= 0 && off < bytes.length && bytes[off] === 0x10
}

/** True when `off` holds graphics this editor can decode at all. */
export function isKnownCodec(bytes: Uint8Array, off: number): boolean {
  return isLz77(bytes, off) || isSmol(bytes, off)
}

/**
 * Decompress LZ77 or `smol` graphics. Throws for LZ77 (as it always
 * has) and returns null for a `smol` variant we don't decode, so
 * callers keep their existing try/catch behaviour.
 */
export function decompressGraphics(bytes: Uint8Array, off: number): Uint8Array | null {
  if (isLz77(bytes, off)) return lz77Decompress(bytes, off)
  if (isSmol(bytes, off)) return smolDecompress(bytes, off)
  return null
}

/** Byte length of the compressed stream at `off`, whichever codec. */
export function compressedSize(bytes: Uint8Array, off: number): number {
  if (isLz77(bytes, off)) return lz77CompressedSize(bytes, off)
  if (isSmol(bytes, off)) return smolCompressedSize(bytes, off)
  return 0
}
