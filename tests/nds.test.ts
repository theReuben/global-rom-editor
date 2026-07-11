import { describe, expect, it } from 'vitest'
import { parseMsgBank } from '../src/core/nds/msgdata'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { parseNdsHeader, isNdsRom, listNdsFiles, findNdsFile, parseNarc } from '../src/core/nds/nds'

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
