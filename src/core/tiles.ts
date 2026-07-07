/**
 * Tile graphics decoding — the rendering layer for map viewing and sprite
 * editing.
 *
 * GB/GBC store 8×8 tiles as 2 bitplanes (16 bytes/tile, 4 colors);
 * GBA stores them as packed 4-bit indices (32 bytes/tile, 16 colors).
 */

/** Decode one GB 2bpp tile (16 bytes) to 64 palette indices (row-major). */
export function decodeTile2bpp(data: Uint8Array, off = 0): Uint8Array {
  const out = new Uint8Array(64)
  for (let y = 0; y < 8; y++) {
    const lo = data[off + y * 2]
    const hi = data[off + y * 2 + 1]
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x
      out[y * 8 + x] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1)
    }
  }
  return out
}

/** Encode 64 palette indices back to a GB 2bpp tile (16 bytes). */
export function encodeTile2bpp(pixels: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(16)
  for (let y = 0; y < 8; y++) {
    let lo = 0
    let hi = 0
    for (let x = 0; x < 8; x++) {
      const p = pixels[y * 8 + x] & 3
      const bit = 7 - x
      lo |= (p & 1) << bit
      hi |= ((p >> 1) & 1) << bit
    }
    out[y * 2] = lo
    out[y * 2 + 1] = hi
  }
  return out
}

/** Decode one GBA 4bpp tile (32 bytes) to 64 palette indices (row-major). */
export function decodeTile4bpp(data: Uint8Array, off = 0): Uint8Array {
  const out = new Uint8Array(64)
  for (let i = 0; i < 32; i++) {
    const b = data[off + i]
    out[i * 2] = b & 0x0f // low nibble = left pixel
    out[i * 2 + 1] = b >> 4
  }
  return out
}

/** Encode 64 palette indices back to a GBA 4bpp tile (32 bytes). */
export function encodeTile4bpp(pixels: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = (pixels[i * 2] & 0x0f) | ((pixels[i * 2 + 1] & 0x0f) << 4)
  }
  return out
}

/** Convert a GBA BGR555 color word to [r, g, b] (0-255 each). */
export function bgr555ToRgb(value: number): [number, number, number] {
  const r = value & 31
  const g = (value >> 5) & 31
  const b = (value >> 10) & 31
  // Expand 5-bit to 8-bit, mapping 31 → 255.
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)]
}

/** Convert [r, g, b] back to a BGR555 color word. */
export function rgbToBgr555(r: number, g: number, b: number): number {
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10)
}

/** Read a 16-color GBA palette (32 bytes) as RGB triples. */
export function readPalette(data: Uint8Array, off: number, colors = 16): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i < colors; i++) {
    out.push(bgr555ToRgb(data[off + i * 2] | (data[off + i * 2 + 1] << 8)))
  }
  return out
}

/**
 * Render a grid of decoded tiles into an RGBA pixel buffer suitable for
 * ImageData. `tiles` are 64-index arrays; palette index 0 is transparent
 * when `transparent0` is set (the GBA convention for sprites).
 */
export function renderTilesRgba(
  tiles: Uint8Array[],
  columns: number,
  palette: [number, number, number][],
  transparent0 = false,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const rows = Math.ceil(tiles.length / columns)
  const width = columns * 8
  const height = rows * 8
  const pixels = new Uint8ClampedArray(width * height * 4)
  tiles.forEach((tile, t) => {
    const tx = (t % columns) * 8
    const ty = Math.floor(t / columns) * 8
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const p = tile[y * 8 + x]
        const o = ((ty + y) * width + tx + x) * 4
        const [r, g, b] = palette[p] ?? [255, 0, 255]
        pixels[o] = r
        pixels[o + 1] = g
        pixels[o + 2] = b
        pixels[o + 3] = transparent0 && p === 0 ? 0 : 255
      }
    }
  })
  return { pixels, width, height }
}
