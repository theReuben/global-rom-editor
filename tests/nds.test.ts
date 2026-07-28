import { describe, expect, it } from 'vitest'
import { parseMsgBank, rebuildMsgBank, writeMsgEntry } from '../src/core/nds/msgdata'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import {
  parseNdsHeader,
  isNdsRom,
  listNdsFiles,
  findNdsFile,
  parseNarc,
  rebuildNarcWithSubfile,
} from '../src/core/nds/nds'
import {
  descramblePokegraChar,
  pokegraCharSeed,
  scramblePokegraChar,
} from '../src/core/nds/pokegra'
import { buildNarc } from './fixtures'

function put(buf: Uint8Array, off: number, bytes: ArrayLike<number>): void {
  buf.set(Uint8Array.from(bytes as number[]), off)
}
const str = (s: string) => Array.from(s).map((c) => c.charCodeAt(0))
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]

/** Minimal NDS ROM: root dir with "poketool/" holding one NARC file. */
function makeNdsRom(): Uint8Array {
  const rom = new Uint8Array(0x100000)
  put(rom, 0x00, str('POKEMON PL'))
  put(rom, 0x0c, str('CPUE'))
  const fnt = 0x1000
  const fat = 0x2000
  put(rom, 0x40, u32(fnt))
  put(rom, 0x44, u32(0x200))
  put(rom, 0x48, u32(fat))
  put(rom, 0x4c, u32(16)) // 2 files

  // FNT main table: root (0xF000) + dir 0xF001.
  put(rom, fnt, [...u32(0x10), ...u16(0), ...u16(2)]) // root: subtable, firstFile, dirCount
  put(rom, fnt + 8, [...u32(0x20), ...u16(1), ...u16(0xf000)]) // poketool dir
  // Root subtable @fnt+0x10: file "arm9.bin", dir "poketool", end.
  put(rom, fnt + 0x10, [8, ...str('arm9.bin'), 0x80 | 8, ...str('poketool'), ...u16(0xf001), 0])
  // poketool subtable @fnt+0x20... wait: placed at fnt+0x20 only if root subtable fits.
  return rom
}

function makeFullNdsRom(): Uint8Array {
  const rom = new Uint8Array(0x100000)
  put(rom, 0x00, str('POKEMON PL'))
  put(rom, 0x0c, str('CPUE'))
  const fnt = 0x1000
  const fat = 0x2000
  put(rom, 0x40, u32(fnt))
  put(rom, 0x44, u32(0x400))
  put(rom, 0x48, u32(fat))
  put(rom, 0x4c, u32(16)) // 2 files

  put(rom, fnt, [...u32(0x100), ...u16(0), ...u16(2)]) // root
  put(rom, fnt + 8, [...u32(0x200), ...u16(1), ...u16(0xf000)]) // poketool
  put(rom, fnt + 0x100, [8, ...str('arm9.bin'), 0x80 | 8, ...str('poketool'), ...u16(0xf001), 0])
  put(rom, fnt + 0x200, [11, ...str('pl_personal'), 0])

  // FAT: file 0 = arm9.bin, file 1 = the NARC.
  const narcOff = 0x4000
  put(rom, fat, [...u32(0x3000), ...u32(0x3100)])
  put(rom, fat + 8, [...u32(narcOff), ...u32(narcOff + 0x100)])

  // NARC with two 8-byte subfiles.
  put(rom, narcOff, [...str('NARC'), 0xfe, 0xff, 0, 1, ...u32(0x100), ...u16(0x10), ...u16(3)])
  put(rom, narcOff + 0x10, [...str('BTAF'), ...u32(12 + 16), ...u16(2), ...u16(0)])
  put(rom, narcOff + 0x1c, [...u32(0), ...u32(8), ...u32(8), ...u32(16)])
  put(rom, narcOff + 0x2c, [...str('BTNF'), ...u32(16), ...u32(4), ...u16(0), ...u16(1)])
  put(rom, narcOff + 0x3c, [...str('GMIF'), ...u32(8 + 16)])
  put(rom, narcOff + 0x44, [45, 49, 49, 45, 65, 65, 12, 3]) // subfile 0
  put(rom, narcOff + 0x4c, [60, 62, 63, 60, 80, 80, 12, 3]) // subfile 1
  return rom
}

describe('NDS container', () => {
  it('detects and parses the header', () => {
    const rom = makeFullNdsRom()
    expect(isNdsRom(rom)).toBe(true)
    const h = parseNdsHeader(rom)!
    expect(h.gameCode).toBe('CPUE')
    expect(h.title).toBe('POKEMON PL')
    expect(isNdsRom(new Uint8Array(0x1000))).toBe(false)
    expect(isNdsRom(makeNdsRom())).toBe(true) // header-only variant
  })

  it('walks the file system', () => {
    const rom = makeFullNdsRom()
    const files = listNdsFiles(rom, parseNdsHeader(rom)!)
    expect(files.map((f) => f.path)).toEqual(['/arm9.bin', '/poketool/pl_personal'])
    const narc = findNdsFile(files, '/poketool/pl_personal')!
    expect(narc.start).toBe(0x4000)
  })

  it('parses NARC archives with absolute subfile offsets', () => {
    const rom = makeFullNdsRom()
    const narc = findNdsFile(listNdsFiles(rom, parseNdsHeader(rom)!), '/poketool/pl_personal')!
    const subs = parseNarc(rom, narc.start)!
    expect(subs).toHaveLength(2)
    expect(subs[0].length).toBe(8)
    expect(rom[subs[0].offset]).toBe(45) // Bulbasaur-ish HP
    expect(rom[subs[1].offset]).toBe(60)
    expect(parseNarc(rom, 0)).toBeNull()
  })

  it('buildAdapter explains DS ROMs instead of rejecting them blindly', () => {
    const result = buildAdapter(new Rom('platinum.nds', makeFullNdsRom()))
    expect(result.adapter).toBeNull()
    expect(result.reason).toContain('Nintendo DS')
    expect(result.reason).toContain('CPUE')
    expect(result.reason).toContain('2 files')
  })
})

describe('Gen 4 message banks', () => {
  // The scrambling is XOR-symmetric, so encoding == decoding.
  const encodeBank = (messages: number[][], key: number): Uint8Array => {
    const total = 4 + messages.length * 8 + messages.reduce((s, m) => s + m.length * 2, 0)
    const out = new Uint8Array(total)
    const w16 = (o: number, v: number) => {
      out[o] = v & 0xff
      out[o + 1] = (v >> 8) & 0xff
    }
    w16(0, messages.length)
    w16(2, key)
    let off = 4 + messages.length * 8
    messages.forEach((msg, n) => {
      let seed = (key * 765 * (n + 1)) & 0xffff
      seed = ((seed | (seed << 16)) & 0xffffffff) >>> 0
      w16(4 + n * 8, (off ^ seed) & 0xffff)
      w16(6 + n * 8, ((off ^ seed) >>> 16) & 0xffff)
      w16(8 + n * 8, (msg.length ^ seed) & 0xffff)
      w16(10 + n * 8, ((msg.length ^ seed) >>> 16) & 0xffff)
      let charSeed = ((n + 1) * 596947) & 0xffff
      for (const c of msg) {
        w16(off, (c ^ charSeed) & 0xffff)
        charSeed = (charSeed + 18749) & 0xffff
        off += 2
      }
    })
    return out
  }
  // A=0x12B..Z, a=0x145..z per the generated charmap.
  const chars = (text: string) =>
    [...text].map((ch) =>
      ch >= 'A' && ch <= 'Z'
        ? 0x12b + ch.charCodeAt(0) - 65
        : ch >= 'a' && ch <= 'z'
          ? 0x145 + ch.charCodeAt(0) - 97
          : 0x1de,
    )

  it('decrypts and decodes plain entries', () => {
    const bank = encodeBank(
      [[...chars('Bulbasaur'), 0xffff], [...chars('Ivysaur'), 0xffff], [...chars('Venusaur'), 0xffff]],
      0x1e39,
    )
    expect(parseMsgBank(bank, 0, bank.length)).toEqual(['Bulbasaur', 'Ivysaur', 'Venusaur'])
  })

  it('skips control sequences and handles the 9-bit trainer-name coding', () => {
    // "Hi{STRVAR arg}!" — control code 0xFFFE, cmd, 1 arg.
    const withCtrl = [...chars('Hi'), 0xfffe, 0x0100, 1, 0x1234, ...chars('yo'), 0xffff]
    // Trainer names: 0xF100 then 9-bit codes packed into 15-bit words.
    const codes = [...chars('Blue').map((c) => c & 0x1ff), 0x1ff]
    const packed: number[] = [0xf100]
    let acc = 0
    let bits = 0
    for (const c of codes) {
      acc |= c << bits
      bits += 9
      if (bits >= 15) {
        packed.push(acc & 0x7fff)
        acc >>= 15
        bits -= 15
      }
    }
    if (bits > 0) packed.push(acc & 0x7fff)
    const bank = encodeBank([withCtrl, packed], 77)
    const [ctrl, trname] = parseMsgBank(bank, 0, bank.length)
    expect(ctrl).toBe('Hiyo')
    expect(trname).toBe('Blue')
  })
})

describe('Gen 4 message bank writing', () => {
  const chars = (text: string) =>
    [...text].map((ch) =>
      ch >= 'A' && ch <= 'Z'
        ? 0x12b + ch.charCodeAt(0) - 65
        : ch >= 'a' && ch <= 'z'
          ? 0x145 + ch.charCodeAt(0) - 97
          : 0x1de,
    )
  const encodeBank = (messages: number[][], key: number): Uint8Array => {
    const total = 4 + messages.length * 8 + messages.reduce((s, m) => s + m.length * 2, 0)
    const out = new Uint8Array(total)
    const w16 = (o: number, v: number) => {
      out[o] = v & 0xff
      out[o + 1] = (v >> 8) & 0xff
    }
    w16(0, messages.length)
    w16(2, key)
    let off = 4 + messages.length * 8
    messages.forEach((msg, n) => {
      let seed = (key * 765 * (n + 1)) & 0xffff
      seed = ((seed | (seed << 16)) & 0xffffffff) >>> 0
      w16(4 + n * 8, (off ^ seed) & 0xffff)
      w16(6 + n * 8, ((off ^ seed) >>> 16) & 0xffff)
      w16(8 + n * 8, (msg.length ^ seed) & 0xffff)
      w16(10 + n * 8, ((msg.length ^ seed) >>> 16) & 0xffff)
      let charSeed = ((n + 1) * 596947) & 0xffff
      for (const c of msg) {
        w16(off, (c ^ charSeed) & 0xffff)
        charSeed = (charSeed + 18749) & 0xffff
        off += 2
      }
    })
    return out
  }
  const pack = (codes: number[]) => {
    const packed: number[] = [0xf100]
    let acc = 0
    let bits = 0
    for (const c of [...codes, 0x1ff]) {
      acc |= c << bits
      bits += 9
      if (bits >= 15) {
        packed.push(acc & 0x7fff)
        acc >>= 15
        bits -= 15
      }
    }
    if (bits > 0) packed.push(acc & 0x7fff)
    return packed
  }

  it('rewrites plain entries in place (same or shorter only)', () => {
    const bank = encodeBank(
      [[...chars('Bulbasaur'), 0xffff], [...chars('Ivysaur'), 0xffff]],
      0x77aa,
    )
    const rom = new Rom('x.nds', bank)
    expect(writeMsgEntry(rom, 0, bank.length, 0, 'Chikorita')).toBe(true) // same length
    expect(parseMsgBank(rom.bytes, 0, bank.length)).toEqual(['Chikorita', 'Ivysaur'])
    expect(writeMsgEntry(rom, 0, bank.length, 0, 'Mew')).toBe(true) // shorter
    expect(parseMsgBank(rom.bytes, 0, bank.length)).toEqual(['Mew', 'Ivysaur'])
    expect(writeMsgEntry(rom, 0, bank.length, 0, 'Bulbasaur42')).toBe(false) // longer
    expect(writeMsgEntry(rom, 0, bank.length, 1, 'Bad§char')).toBe(false) // unmappable
    expect(parseMsgBank(rom.bytes, 0, bank.length)[1]).toBe('Ivysaur')
  })

  it('rewrites 9-bit packed name entries', () => {
    const bank = encodeBank([pack(chars('Lance')), pack(chars('Clair'))], 3)
    const rom = new Rom('x.nds', bank)
    expect(writeMsgEntry(rom, 0, bank.length, 0, 'Steve')).toBe(true)
    expect(parseMsgBank(rom.bytes, 0, bank.length)).toEqual(['Steve', 'Clair'])
    expect(writeMsgEntry(rom, 0, bank.length, 0, 'MuchLongerName')).toBe(false)
  })

  it('rebuilds a bank around an entry that outgrew its slot', () => {
    const bank = encodeBank(
      [[...chars('Bulbasaur'), 0xffff], [...chars('Ivysaur'), 0xffff], [...chars('Venusaur'), 0xffff]],
      0x77aa,
    )
    const grown = rebuildMsgBank(bank, 0, bank.length, 1, 'IvysaurusMaximus')!
    expect(grown).not.toBeNull()
    expect(grown.length).toBeGreaterThan(bank.length)
    expect(parseMsgBank(grown, 0, grown.length)).toEqual(['Bulbasaur', 'IvysaurusMaximus', 'Venusaur'])
  })

  it('rebuilds packed name entries and keeps the 9-bit coding', () => {
    const bank = encodeBank([pack(chars('Lance')), pack(chars('Clair'))], 3)
    const grown = rebuildMsgBank(bank, 0, bank.length, 0, 'Alexander')!
    expect(parseMsgBank(grown, 0, grown.length)).toEqual(['Alexander', 'Clair'])
  })
})

describe('NARC rebuilding', () => {
  it('replaces a subfile with longer data and repacks 4-byte aligned', () => {
    const narc = buildNarc([
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([4, 5]),
      Uint8Array.from([6, 7, 8, 9]),
    ])
    const bigger = Uint8Array.from({ length: 11 }, (_, i) => 40 + i)
    const out = rebuildNarcWithSubfile(narc, 0, 1, bigger)!
    expect(out).not.toBeNull()
    const subs = parseNarc(out, 0)!
    expect(subs).toHaveLength(3)
    expect([...out.subarray(subs[0].offset, subs[0].offset + subs[0].length)]).toEqual([1, 2, 3])
    expect([...out.subarray(subs[1].offset, subs[1].offset + subs[1].length)]).toEqual([...bigger])
    expect([...out.subarray(subs[2].offset, subs[2].offset + subs[2].length)]).toEqual([6, 7, 8, 9])
    // 4-byte alignment between members, 0xFF padding.
    expect(subs[1].offset % 4).toBe(0)
    expect(subs[2].offset % 4).toBe(0)
    // Total-size field matches the buffer.
    const total = out[8] | (out[9] << 8) | (out[10] << 16) | (out[11] << 24)
    expect(total).toBe(out.length)
  })
})

describe('pokegra sprite scrambling', () => {
  // The LCRNG walk is its own inverse for a given seed; the direction is
  // all that differs between D/P ("back to front") and Pt/HGSS
  // ("front to back") — see nitrogfx gfx.c Decode/Encode.
  const sample = () =>
    Uint8Array.from({ length: 6400 }, (_, i) => (i * 37 + (i >> 3)) & 0xff)

  it('round-trips a scramble through descramble in both modes', () => {
    for (const mode of ['dp', 'pt'] as const) {
      const plain = sample()
      // The anchor word must be zero — the loader recovers its seed there.
      const anchor = mode === 'dp' ? plain.length - 2 : 0
      plain[anchor] = 0
      plain[anchor + 1] = 0

      const scrambled = plain.slice()
      scramblePokegraChar(scrambled, mode, 0x1234)
      expect([...scrambled]).not.toEqual([...plain])
      // The seed lands in the anchor word, exactly where the game reads it.
      expect(pokegraCharSeed(scrambled, mode)).toBe(0x1234)

      const back = scrambled.slice()
      descramblePokegraChar(back, mode)
      expect([...back]).toEqual([...plain])
    }
  })

  it('descrambles any buffer to a zero anchor word', () => {
    for (const mode of ['dp', 'pt'] as const) {
      const data = sample()
      const anchor = mode === 'dp' ? data.length - 2 : 0
      descramblePokegraChar(data, mode)
      expect(data[anchor] | data[anchor + 1]).toBe(0)
    }
  })

  it('re-scrambling with the original seed reproduces the source bytes', () => {
    for (const mode of ['dp', 'pt'] as const) {
      const original = sample()
      const seed = pokegraCharSeed(original, mode)
      const plain = original.slice()
      descramblePokegraChar(plain, mode)
      scramblePokegraChar(plain, mode, seed)
      expect([...plain]).toEqual([...original])
    }
  })
})
