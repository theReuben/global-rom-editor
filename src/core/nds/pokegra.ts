/**
 * Gen 4 (D/P/Pt/HGSS) Pokémon sprite display from the pokegra NARC.
 *
 * Per species, six subfiles (pokeheartgold src/pokemon.c
 * GetMonSpriteCharAndPlttNarcIdsEx): species*6 + {0 back♀, 1 back♂,
 * 2 front♀, 3 front♂, 4 normal NCLR, 5 shiny NCLR}. NCGR char data is
 * 160×80 4bpp (two 80×80 frames side by side; the right frame is the
 * standard pose) XOR-scrambled with an LCRNG
 * (seed*1103515245+24691, per pokeheartgold src/pokepic.c): D/P seed
 * from the LAST u16 walking backward, Pt/HGSS from the FIRST u16
 * walking forward. Palettes are 16 BGR555 colors in the TTLP block.
 *
 * Import re-scrambles with the slot's own seed and writes in place —
 * the char data and the 16-color palette both keep their exact
 * footprint, so no NARC repack is needed.
 */
import type { RenderedImage } from '../games/schema'
import type { NarcSubfile } from './nds'
import type { Rom } from '../rom'
import { rgbToBgr555 } from '../tiles'

const ascii = (b: Uint8Array, o: number, n: number) =>
  String.fromCharCode(...b.subarray(o, o + n))
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

function ncgrChar(
  bytes: Uint8Array,
  off: number,
  len: number,
): { data: Uint8Array; tilesX: number; tilesY: number; linear: boolean } | null {
  if (len < 0x30 || ascii(bytes, off, 4) !== 'RGCN') return null
  const chr = off + 0x10
  if (ascii(bytes, chr, 4) !== 'RAHC') return null
  const tilesY = u16(bytes, chr + 8)
  const tilesX = u16(bytes, chr + 10)
  // Flag bit 0 = "scanned": the data is a linear bitmap, not 8×8
  // tiles — the pokegra pics all use it.
  const linear = (u32(bytes, chr + 0x14) & 1) === 1
  const size = u32(bytes, chr + 0x18)
  const data = bytes.slice(chr + 0x20, chr + 0x20 + size)
  if (data.length !== size) return null
  return { data, tilesX, tilesY, linear }
}

function nclrColors(bytes: Uint8Array, off: number, len: number): [number, number, number][] | null {
  if (len < 0x28 || ascii(bytes, off, 4) !== 'RLCN') return null
  const pltt = off + 0x10
  if (ascii(bytes, pltt, 4) !== 'TTLP') return null
  const five = (v: number) => ((v & 31) << 3) | ((v & 31) >> 2)
  const out: [number, number, number][] = []
  for (let i = 0; i < 16; i++) {
    const v = u16(bytes, pltt + 0x18 + i * 2)
    out.push([five(v), five(v >> 5), five(v >> 10)])
  }
  return out
}

/**
 * XOR every u16 with the LCRNG stream, walking the direction the mode
 * implies (nitrogfx gfx.c Decode: mode 1 "back to front" = D/P, mode 2
 * "front to back" = Pt/HGSS). Scrambling and descrambling are the same
 * walk — only where the seed comes from differs — so this one helper
 * is its own inverse for a given seed.
 */
function xorStream(data: Uint8Array, mode: 'dp' | 'pt', seed: number): void {
  const words = data.length >> 1
  const step = (s: number) => (Math.imul(s, 1103515245) + 24691) >>> 0
  let s = seed >>> 0
  if (mode === 'dp') {
    for (let i = words - 1; i >= 0; i--) {
      const v = u16(data, i * 2) ^ (s & 0xffff)
      data[i * 2] = v & 0xff
      data[i * 2 + 1] = (v >> 8) & 0xff
      s = step(s)
    }
  } else {
    for (let i = 0; i < words; i++) {
      const v = u16(data, i * 2) ^ (s & 0xffff)
      data[i * 2] = v & 0xff
      data[i * 2 + 1] = (v >> 8) & 0xff
      s = step(s)
    }
  }
}

/**
 * The seed is the scrambled word the walk starts on — so that word
 * always descrambles to 0, and any sprite written back must keep a
 * zero there (last u16 for D/P, first u16 for Pt/HGSS).
 */
function seedOf(data: Uint8Array, mode: 'dp' | 'pt'): number {
  return mode === 'dp' ? u16(data, ((data.length >> 1) - 1) * 2) : u16(data, 0)
}

function descramble(data: Uint8Array, mode: 'dp' | 'pt'): void {
  xorStream(data, mode, seedOf(data, mode))
}

/** Re-apply the scramble a ROM's loader expects. Inverse of `descramble`. */
export function scramblePokegraChar(
  data: Uint8Array,
  mode: 'dp' | 'pt',
  seed: number,
): void {
  xorStream(data, mode, seed)
}

export { descramble as descramblePokegraChar, seedOf as pokegraCharSeed }

export function buildPokegra(
  rom: Rom,
  subs: NarcSubfile[],
  mode: 'dp' | 'pt',
  speciesCount: number,
): {
  front: (id: number, shiny: boolean) => RenderedImage | null
  back: (id: number, shiny: boolean) => RenderedImage | null
  importFront: (id: number, image: RenderedImage) => string | null
  importBack: (id: number, image: RenderedImage) => string | null
} | null {
  const bytes = rom.bytes
  const byIndex = new Map(subs.map((s) => [s.index, s]))

  /** Male slot first, female fallback (genderless use the male slot). */
  const gfxSub = (id: number, front: boolean): NarcSubfile | undefined => {
    const male = byIndex.get(id * 6 + (front ? 2 : 0) + 1)
    if (male && male.length >= 0x30) return male
    return byIndex.get(id * 6 + (front ? 2 : 0))
  }

  const render = (id: number, front: boolean, shiny: boolean): RenderedImage | null => {
    if (id < 1 || id > speciesCount) return null
    const sub = gfxSub(id, front)
    const pal = byIndex.get(id * 6 + 4 + (shiny ? 1 : 0))
    if (!sub || !pal) return null
    const chr = ncgrChar(bytes, sub.offset, sub.length)
    const colors = nclrColors(bytes, pal.offset, pal.length)
    if (!chr || !colors) return null
    descramble(chr.data, mode)
    // Some NCGRs report -1 dims; the pokegra pics are all 20×10 tiles.
    const tilesX = chr.tilesX > 0 && chr.tilesX < 0x100 ? chr.tilesX : 20
    const tilesY = chr.tilesY > 0 && chr.tilesY < 0x100 ? chr.tilesY : 10
    if (chr.data.length < tilesX * tilesY * 32) return null
    const fullW = tilesX * 8
    // Show the right 80×80 frame (the standard pose) when the image
    // holds two frames side by side.
    const cropX = fullW > 80 ? fullW - 80 : 0
    const width = Math.min(80, fullW)
    const height = tilesY * 8
    const pixels = new Uint8ClampedArray(width * height * 4)
    const put = (px: number, py: number, idx: number) => {
      if (px < 0 || px >= width || py < 0 || py >= height) return
      const o = (py * width + px) * 4
      if (idx === 0) {
        pixels[o] = pixels[o + 1] = pixels[o + 2] = 255
      } else {
        const [r, g, bl] = colors[idx]
        pixels[o] = r
        pixels[o + 1] = g
        pixels[o + 2] = bl
      }
      pixels[o + 3] = 255
    }
    if (chr.linear) {
      for (let py = 0; py < height; py++) {
        for (let fx = 0; fx < fullW; fx++) {
          const b = chr.data[(py * fullW + fx) >> 1]
          put(fx - cropX, py, fx & 1 ? b >> 4 : b & 0x0f)
        }
      }
    } else {
      for (let t = 0; t < tilesX * tilesY; t++) {
        const tx = (t % tilesX) * 8
        const ty = Math.floor(t / tilesX) * 8
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const b = chr.data[t * 32 + y * 4 + (x >> 1)]
            put(tx + x - cropX, ty + y, x & 1 ? b >> 4 : b & 0x0f)
          }
        }
      }
    }
    return { pixels, width, height }
  }

  const importPic = (id: number, front: boolean, image: RenderedImage): string | null => {
    if (id < 1 || id > speciesCount) return 'Unknown species.'
    const sub = gfxSub(id, front)
    // Slot 4 is the normal palette; front and back share it, so the
    // sprite imported last defines the colors of both (slot 5, the
    // shiny palette, is left alone).
    const pal = byIndex.get(id * 6 + 4)
    if (!sub || sub.length < 0x30 || !pal) {
      return 'This species has no sprite slot in the pokegra archive.'
    }
    const chr = ncgrChar(bytes, sub.offset, sub.length)
    if (!chr) return 'The sprite entry looks corrupt.'
    if (!nclrColors(bytes, pal.offset, pal.length) || pal.length < 0x28 + 32) {
      return 'The palette entry looks corrupt.'
    }
    const tilesX = chr.tilesX > 0 && chr.tilesX < 0x100 ? chr.tilesX : 20
    const tilesY = chr.tilesY > 0 && chr.tilesY < 0x100 ? chr.tilesY : 10
    if (chr.data.length < tilesX * tilesY * 32) return 'The sprite entry looks truncated.'
    const fullW = tilesX * 8
    const height = tilesY * 8
    const width = Math.min(80, fullW)
    if (image.width !== width || image.height !== height) {
      return `Sprites must be exactly ${width}×${height} pixels (got ${image.width}×${image.height}).`
    }

    // Quantise to 15 colors + slot 0. Slot 0 is the DS's transparent
    // index, and takes the top-left color as well as transparent pixels
    // (the same rule the GBA importer uses).
    const px = image.pixels
    const bg = px[3] >= 128 ? rgbToBgr555(px[0], px[1], px[2]) : null
    const paletteWords: number[] = [bg ?? 0]
    const indexOf = new Map<number, number>()
    if (bg !== null) indexOf.set(bg, 0)
    const indices = new Uint8Array(width * height)
    for (let p = 0; p < width * height; p++) {
      if (px[p * 4 + 3] < 128) continue // transparent → slot 0
      const word = rgbToBgr555(px[p * 4], px[p * 4 + 1], px[p * 4 + 2])
      let idx = indexOf.get(word)
      if (idx === undefined) {
        if (paletteWords.length >= 16) {
          return 'Too many colors — sprites allow 15 colors plus the transparent background.'
        }
        idx = paletteWords.length
        paletteWords.push(word)
        indexOf.set(word, idx)
      }
      indices[p] = idx
    }
    while (paletteWords.length < 16) paletteWords.push(0)

    // Lay the frame out across the full width — pokegra stores two
    // 80×80 frames side by side and the game animates between them, so
    // both get the imported art.
    const plain = new Uint8Array(chr.data.length)
    const setPixel = (fx: number, py: number, v: number) => {
      if (chr.linear) {
        const o = (py * fullW + fx) >> 1
        plain[o] = fx & 1 ? (plain[o] & 0x0f) | (v << 4) : (plain[o] & 0xf0) | v
      } else {
        const t = Math.floor(py / 8) * tilesX + Math.floor(fx / 8)
        const o = t * 32 + (py % 8) * 4 + ((fx % 8) >> 1)
        plain[o] = fx & 1 ? (plain[o] & 0x0f) | (v << 4) : (plain[o] & 0xf0) | v
      }
    }
    for (let py = 0; py < height; py++) {
      for (let fx = 0; fx < fullW; fx++) {
        setPixel(fx, py, indices[py * width + (fx % width)])
      }
    }

    // The loader takes its seed from the word the walk starts on, so
    // that word must descramble to zero. Force it — it is four corner
    // pixels, and a non-zero anchor would make the game decode the
    // whole sprite as noise.
    const anchor = mode === 'dp' ? plain.length - 2 : 0
    plain[anchor] = 0
    plain[anchor + 1] = 0

    // Reuse the slot's existing seed so an unchanged sprite re-encodes
    // to the original bytes (keeps revert and IPS diffs clean).
    scramblePokegraChar(plain, mode, seedOf(chr.data, mode))
    rom.writeBlock(sub.offset + 0x30, plain)

    const palBytes = new Uint8Array(32)
    paletteWords.forEach((w, i) => {
      palBytes[i * 2] = w & 0xff
      palBytes[i * 2 + 1] = (w >> 8) & 0xff
    })
    rom.writeBlock(pal.offset + 0x28, palBytes)
    return null
  }

  // Only offer the module if a sample of species actually decodes.
  let hits = 0
  for (const id of [1, 4, 7, 25]) {
    if (id <= speciesCount && render(id, true, false)) hits++
  }
  if (hits < 3) return null

  return {
    front: (id, shiny) => render(id, true, shiny),
    back: (id, shiny) => render(id, false, shiny),
    importFront: (id, image) => importPic(id, true, image),
    importBack: (id, image) => importPic(id, false, image),
  }
}
