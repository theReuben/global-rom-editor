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
 */
import type { RenderedImage } from '../games/schema'
import type { NarcSubfile } from './nds'

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

function descramble(data: Uint8Array, mode: 'dp' | 'pt'): void {
  const words = data.length >> 1
  const step = (s: number) => (Math.imul(s, 1103515245) + 24691) >>> 0
  if (mode === 'dp') {
    let seed = u16(data, (words - 1) * 2)
    for (let i = words - 1; i >= 0; i--) {
      const v = u16(data, i * 2) ^ (seed & 0xffff)
      data[i * 2] = v & 0xff
      data[i * 2 + 1] = (v >> 8) & 0xff
      seed = step(seed)
    }
  } else {
    let seed = u16(data, 0)
    for (let i = 0; i < words; i++) {
      const v = u16(data, i * 2) ^ (seed & 0xffff)
      data[i * 2] = v & 0xff
      data[i * 2 + 1] = (v >> 8) & 0xff
      seed = step(seed)
    }
  }
}

export function buildPokegra(
  bytes: Uint8Array,
  subs: NarcSubfile[],
  mode: 'dp' | 'pt',
  speciesCount: number,
): {
  front: (id: number, shiny: boolean) => RenderedImage | null
  back: (id: number, shiny: boolean) => RenderedImage | null
} | null {
  const byIndex = new Map(subs.map((s) => [s.index, s]))

  const render = (id: number, front: boolean, shiny: boolean): RenderedImage | null => {
    if (id < 1 || id > speciesCount) return null
    // Male slot first, female fallback (genderless use the male slot).
    let sub = byIndex.get(id * 6 + (front ? 2 : 0) + 1)
    if (!sub || sub.length < 0x30) sub = byIndex.get(id * 6 + (front ? 2 : 0))
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

  // Only offer the module if a sample of species actually decodes.
  let hits = 0
  for (const id of [1, 4, 7, 25]) {
    if (id <= speciesCount && render(id, true, false)) hits++
  }
  if (hits < 3) return null

  return {
    front: (id, shiny) => render(id, true, shiny),
    back: (id, shiny) => render(id, false, shiny),
  }
}
