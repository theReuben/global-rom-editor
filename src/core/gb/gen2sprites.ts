/**
 * Gen 2 (G/S/C) Pokémon sprite display.
 *
 * PokemonPicPointers (pokecrystal/pokegold data/pokemon/pic_pointers.asm):
 * 6 bytes per species — front {bank, ptr u16} then back {bank, ptr u16},
 * lz3-compressed 2bpp tiles in column-major order. The stored bank byte
 * is game-specific nonsense (Crystal subtracts PICS_FIX=0x36 and maps
 * through a bank list; Gold stores it raw with three remapped values),
 * so instead of replicating each game's FixPicBank we resolve banks by
 * content: the right bank is the one where the pic lz3-decompresses to
 * exactly tiles×16 bytes (front size from the stats dimensions byte,
 * backs are always 6×6). A delta between stored and real bank is voted
 * across species and per-stored-bank exceptions are searched and cached.
 *
 * PokemonPalettes: 8 bytes per species {normal c1, c2, shiny c1, c2}
 * as RGB555 — colors 0/3 are implicit white/black. Located by anchor
 * majority vote (rows for dex 1/25/131, byte-identical in built Gold
 * and Crystal).
 */
import type { Rom } from '../rom'
import type { RenderedImage } from '../games/schema'
import { decodeTile2bpp } from '../tiles'
import { lz3Decompress, lz3TryDecompress } from './lz3'
import { findByVote } from '../scan'

const PAL_ANCHORS = [
  { index: 1, pattern: [236, 47, 95, 25, 148, 47, 95, 25] },
  { index: 25, pattern: [93, 23, 218, 0, 63, 2, 84, 44] },
  { index: 131, pattern: [188, 54, 8, 114, 191, 125, 112, 125] },
]

function toFile(bank: number, local: number): number {
  return bank * 0x4000 + local - 0x4000
}

export function buildGen2Sprites(
  rom: Rom,
  statsOff: number,
  statsEntry: number,
  count: number,
): {
  front: (id: number, shiny: boolean) => RenderedImage | null
  back: (id: number, shiny: boolean) => RenderedImage | null
  hasPalettes: boolean
  tableOff: number
} | null {
  const bytes = rom.bytes
  const romBanks = Math.max(2, Math.floor(bytes.length / 0x4000))

  const dimsOf = (id: number) => bytes[statsOff + (id - 1) * statsEntry + 17]
  const frontTiles = (id: number) => {
    const d = dimsOf(id)
    return (d >> 4) * (d & 0x0f)
  }

  // Crystal front pics decompress to the base sprite PLUS animation
  // frame tiles, so "decodes to at least tiles×16" is the size check;
  // rendering uses the first tiles×16 bytes (frame 0). The strict
  // decoder demands a real LZ_END terminator — zero-filled banks
  // "decompress" to plausible sizes by running off the end otherwise.
  const decodesTo = (off: number, tiles: number): boolean => {
    if (off < 0 || off + 2 > bytes.length || tiles < 1 || tiles > 64) return false
    // Cap garbage decodes early — no real pic (base + animation frames)
    // comes close to 16× its base size.
    const out = lz3TryDecompress(bytes, off, tiles * 16 * 16)
    return out !== null && out.length >= tiles * 16 && out.length % 16 === 0
  }

  // 1. Table candidates: `count` 6-byte entries of two bank-local
  //    pointers each (cheap structural prefilter). A few 0xFF filler
  //    entries are allowed — Unown's pics live in their own table and
  //    its slot here is blank.
  const isFiller = (off: number) =>
    bytes[off] === 0xff && bytes[off + 1] === 0xff && bytes[off + 2] === 0xff
  const candidates: number[] = []
  outer: for (let o = 0; o + count * 6 <= bytes.length; o++) {
    let fillers = 0
    for (let i = 0; i < count * 2; i++) {
      if (isFiller(o + i * 3)) {
        if (++fillers > 8) continue outer
        continue
      }
      const p = rom.readU16LE(o + i * 3 + 1)
      if (p < 0x4000 || p >= 0x8000 || bytes[o + i * 3] > 0x60) continue outer
    }
    candidates.push(o)
    if (candidates.length > 8) break
  }

  // 2. Confirm by voting for a stored→real bank delta over the first
  //    species' front pics (sizes must match the stats dims byte).
  let tableOff = -1
  let delta = 0
  for (const T of candidates) {
    const votes = new Map<number, number>()
    let considered = 0
    for (let id = 1; id <= Math.min(count, 24); id++) {
      const tiles = frontTiles(id)
      if (tiles < 1 || tiles > 64) continue
      considered++
      const stored = bytes[T + (id - 1) * 6]
      const ptr = rom.readU16LE(T + (id - 1) * 6 + 1)
      for (let b = 1; b < romBanks; b++) {
        if (decodesTo(toFile(b, ptr), tiles)) {
          votes.set(b - stored, (votes.get(b - stored) ?? 0) + 1)
        }
      }
    }
    for (const [d, n] of votes) {
      if (n >= considered * 0.6 && n >= 8) {
        tableOff = T
        delta = d
        break
      }
    }
    if (tableOff >= 0) break
  }
  if (tableOff < 0) return null

  // Per-stored-bank exceptions (Gold remaps three values): resolved by
  // scanning all banks once and cached.
  const bankCache = new Map<number, number>()
  const resolveBank = (stored: number, ptr: number, tiles: number): number => {
    if (decodesTo(toFile(stored + delta, ptr), tiles)) return stored + delta
    const hit = bankCache.get(stored)
    if (hit !== undefined && decodesTo(toFile(hit, ptr), tiles)) return hit
    for (let b = 1; b < romBanks; b++) {
      if (decodesTo(toFile(b, ptr), tiles)) {
        bankCache.set(stored, b)
        return b
      }
    }
    return -1
  }

  // 3. Palettes by anchor vote (row = dex*8, row 0 is the 000 dummy).
  const palOff = findByVote(bytes, PAL_ANCHORS, 8)
  const colors = (id: number, shiny: boolean): [number, number, number][] => {
    const shades: [number, number, number][] = [
      [255, 255, 255],
      [170, 170, 170],
      [85, 85, 85],
      [0, 0, 0],
    ]
    if (palOff === null) return shades
    const row = palOff + id * 8 + (shiny ? 4 : 0)
    for (const [slot, off] of [[1, row], [2, row + 2]] as const) {
      const v = rom.readU16LE(off)
      const five = (x: number) => ((x & 31) << 3) | ((x & 31) >> 2)
      shades[slot] = [five(v), five(v >> 5), five(v >> 10)]
    }
    return shades
  }

  const render = (id: number, front: boolean, shiny: boolean): RenderedImage | null => {
    if (id < 1 || id > count) return null
    const entry = tableOff + (id - 1) * 6 + (front ? 0 : 3)
    if (isFiller(entry)) return null // Unown's slot is blank here
    const d = front ? dimsOf(id) : 0x66 // backs are always 6×6
    const w = d >> 4
    const h = d & 0x0f
    const tiles = w * h
    const bank = resolveBank(bytes[entry], rom.readU16LE(entry + 1), tiles)
    if (bank < 0) return null
    let data: Uint8Array
    try {
      data = lz3Decompress(bytes, toFile(bank, rom.readU16LE(entry + 1)))
    } catch {
      return null
    }
    const pal = colors(id, shiny)
    const width = w * 8
    const height = h * 8
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let t = 0; t < tiles; t++) {
      // Column-major: tile t sits at column t/h, row t%h.
      const tx = Math.floor(t / h) * 8
      const ty = (t % h) * 8
      const tile = decodeTile2bpp(data, t * 16)
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = ((ty + y) * width + tx + x) * 4
          const [r, g, b] = pal[tile[y * 8 + x]]
          pixels[o] = r
          pixels[o + 1] = g
          pixels[o + 2] = b
          pixels[o + 3] = 255
        }
      }
    }
    return { pixels, width, height }
  }

  return {
    front: (id, shiny) => render(id, true, shiny),
    back: (id, shiny) => render(id, false, shiny),
    hasPalettes: palOff !== null,
    tableOff,
  }
}
