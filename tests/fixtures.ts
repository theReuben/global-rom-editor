/**
 * Synthetic ROM fixtures.
 *
 * These are NOT real game data — they contain just enough correctly-shaped
 * bytes (headers + the public-knowledge signature entries the scanner keys
 * on) to exercise every code path: detection, scanning, reading, writing.
 */
import { gen12Bytes, gen3Bytes } from '../src/core/text'

function put(buf: Uint8Array, off: number, bytes: ArrayLike<number>): void {
  buf.set(Uint8Array.from(bytes as number[]), off)
}

function gbName(text: string, len: number): number[] {
  const out = gen12Bytes(text)
  while (out.length < len) out.push(0x50)
  return out
}

function gen3Name(text: string, len: number): number[] {
  const out = gen3Bytes(text)
  out.push(0xff)
  while (out.length < len) out.push(0xff)
  return out
}

/* --------------------------------------------------------------- Gen 1 */

export function makeGen1Rom(): Uint8Array {
  const rom = new Uint8Array(1024 * 1024)
  // GB header: Nintendo logo start + title.
  put(rom, 0x104, [0xce, 0xed, 0x66, 0x66])
  put(rom, 0x134, Array.from('POKEMON RED').map((c) => c.charCodeAt(0)))

  // Base stats (dex order): Bulbasaur, Ivysaur, rest zeroed.
  const stats = 0x383de
  put(rom, stats, [0x01, 45, 49, 49, 45, 65, 0x16, 0x03, 45, 64])
  put(rom, stats + 15, [33, 45, 0, 0]) // starting moves: Tackle, Growl
  put(rom, stats + 19, [3]) // medium slow
  put(rom, stats + 20, [0b10100100, 0, 0, 0, 0, 0, 0x40]) // some TM/HM flags
  put(rom, stats + 28, [0x02, 60, 62, 63, 60, 80, 0x16, 0x03, 45, 141])
  // Mew, stored separately like real Red/Blue.
  const mew = 0x425b
  put(rom, mew, [0x97, 100, 100, 100, 100, 100, 0x18, 0x18, 45, 64])

  // Internal → dex mapping. Signature entries then Bulbasaur at internal 10.
  const map = 0x41024
  put(rom, map, [0x70, 0x73, 0x20, 0x23, 0x15, 0x64, 0x22, 0x50, 0x02, 0x01])
  put(rom, map + 10, [0x97]) // internal 11 = Mew

  // Names (internal order, 10 bytes each).
  const names = 0x1c21e
  put(rom, names, gbName('RHYDON', 10))
  put(rom, names + 10, gbName('KANGASKHAN', 10))
  put(rom, names + 9 * 10, gbName('BULBASAUR', 10)) // internal 10
  put(rom, names + 10 * 10, gbName('MEW', 10)) // internal 11

  // Move data: Pound, Karate Chop, Doubleslap.
  const moves = 0x38000
  put(rom, moves, [0x01, 0x00, 40, 0x00, 0xff, 35])
  put(rom, moves + 6, [0x02, 0x00, 50, 0x00, 0xff, 25])
  put(rom, moves + 12, [0x03, 0x1d, 15, 0x00, 0xd8, 10])

  // Move names (variable length, 0x50-terminated).
  const moveNames = 0xb0000
  put(rom, moveNames, [
    ...gen12Bytes('POUND'), 0x50,
    ...gen12Bytes('KARATE CHOP'), 0x50,
    ...gen12Bytes('DOUBLESLAP'), 0x50,
  ])

  // TM/HM move list.
  put(rom, 0x13773, [5, 13, 14, 18, 25, 92, 32, 34])
  return rom
}

/* --------------------------------------------------------------- Gen 2 */

export function makeGen2Rom(): Uint8Array {
  const rom = new Uint8Array(2 * 1024 * 1024)
  put(rom, 0x104, [0xce, 0xed, 0x66, 0x66])
  put(rom, 0x134, Array.from('PM_CRYSTAL').map((c) => c.charCodeAt(0)))
  rom[0x143] = 0x80 // GBC flag

  const stats = 0x51424
  // Bulbasaur: dex, stats ×6, types, catch, exp, items, gender, ?, hatch...
  put(rom, stats, [0x01, 45, 49, 49, 45, 65, 65, 0x16, 0x03, 45, 64, 0, 0, 31, 100, 20])
  put(rom, stats + 22, [3]) // growth: medium slow
  put(rom, stats + 23, [(1 << 4) | 7]) // egg groups: Monster / Grass
  put(rom, stats + 24, [0b00000101, 0, 0, 0, 0, 0, 0b00000011, 0])
  put(rom, stats + 32, [0x02, 60, 62, 63, 60, 80, 80, 0x16, 0x03, 45, 141])

  const names = 0x53384
  put(rom, names, gbName('BULBASAUR', 10))
  put(rom, names + 10, gbName('IVYSAUR', 10))

  const moves = 0x41afb
  put(rom, moves, [0x01, 0x00, 40, 0x00, 0xff, 35, 0x00])
  put(rom, moves + 7, [0x02, 0x00, 50, 0x01, 0xff, 25, 0x00])

  const moveNames = 0x1c9f29
  put(rom, moveNames, [...gen12Bytes('POUND'), 0x50, ...gen12Bytes('KARATE CHOP'), 0x50])

  put(rom, 0x1167a, [223, 29, 174, 205, 46, 92, 192, 249])
  return rom
}

/* --------------------------------------------------------------- Gen 3 */

export function makeGen3Rom(): Uint8Array {
  const rom = new Uint8Array(4 * 1024 * 1024)
  rom[0xb2] = 0x96 // GBA fixed header byte
  put(rom, 0xa0, Array.from('POKEMON FIRE').map((c) => c.charCodeAt(0)))
  put(rom, 0xac, Array.from('BPRE').map((c) => c.charCodeAt(0)))

  // Base stats: entry 0 dummy, then Bulbasaur, Ivysaur.
  const stats = 0x2547a0
  const bulba = stats + 28
  put(rom, bulba, [45, 49, 49, 45, 65, 65, 12, 3, 45, 64])
  put(rom, bulba + 10, [0, 1]) // EV yield u16 LE = 0x0100 → Sp. Atk = 1
  put(rom, bulba + 12, [0, 0, 0, 0]) // held items
  put(rom, bulba + 16, [31, 20, 70, 3, 1, 7, 65, 0]) // gender..abilities (65 = Overgrow)
  put(rom, stats + 56, [60, 62, 63, 60, 80, 80, 12, 3, 45, 141])

  const names = 0x245ee0
  put(rom, names + 11, gen3Name('BULBASAUR', 11))
  put(rom, names + 22, gen3Name('IVYSAUR', 11))

  const moves = 0x250c04
  put(rom, moves + 12, [0, 40, 0, 100, 35, 0, 0, 0, 0x33, 0, 0, 0]) // Pound
  put(rom, moves + 24, [44, 50, 1, 100, 25, 0, 0, 0, 0x33, 0, 0, 0]) // Karate Chop

  const moveNames = 0x247111
  put(rom, moveNames + 13, gen3Name('POUND', 13))
  put(rom, moveNames + 26, gen3Name('KARATE CHOP', 13))

  const abilities = 0x24fc40
  put(rom, abilities + 13, gen3Name('STENCH', 13))
  put(rom, abilities + 26, gen3Name('DRIZZLE', 13))
  return rom
}
