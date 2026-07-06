import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { compileScript, encodeScriptText } from '../src/core/gba/script'
import { findFreeSpaceAtEnd, readGbaPointer } from '../src/core/freespace'
import {
  parseSpeciesInfo,
  numericValue,
  setNumericField,
  prettySpeciesName,
} from '../src/decomp/speciesInfo'
import { makeGen3Rom } from './fixtures'

const load = () => buildAdapter(new Rom('firered.gba', makeGen3Rom())).adapter!

describe('script compiler', () => {
  it('encodes dialogue with line and box breaks', () => {
    const t = encodeScriptText('HI\nTHERE\nBOX2')!
    expect(t[2]).toBe(0xfe) // first break = new line
    expect(t[8]).toBe(0xfb) // later break = new box
    expect(t[t.length - 1]).toBe(0xff)
    expect(encodeScriptText('日本語')).toBeNull()
  })

  it('compiles a full script with resolved text pointers', () => {
    const base = 0x100
    const s = compileScript(
      [
        { kind: 'message', text: 'HELLO' },
        { kind: 'giveItem', item: 13, quantity: 2 },
        { kind: 'setFlag', flag: 0x200 },
      ],
      base,
    )!
    const b = s.bytes
    expect(b[0]).toBe(0x6a) // lock
    expect(b[1]).toBe(0x5a) // faceplayer
    expect(b[2]).toBe(0x0f) // loadword
    const textAddr = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0
    expect(textAddr).toBe(0x08000000 + base + s.codeLength)
    expect(b[8]).toBe(0x09) // callstd
    expect(b[9]).toBe(0x04) // MSGBOX_DEFAULT
    // giveitem: setorcopyvar 0x8000, 13
    expect(Array.from(b.slice(10, 15))).toEqual([0x1a, 0x00, 0x80, 13, 0])
    expect(Array.from(b.slice(15, 20))).toEqual([0x1a, 0x01, 0x80, 2, 0])
    expect(Array.from(b.slice(20, 22))).toEqual([0x09, 0x00]) // STD_OBTAIN_ITEM
    expect(Array.from(b.slice(22, 25))).toEqual([0x29, 0x00, 0x02]) // setflag 0x200
    expect(Array.from(b.slice(25, 27))).toEqual([0x6c, 0x02]) // release, end
    expect(s.codeLength).toBe(27)
  })

  it('rejects empty or unencodable messages', () => {
    expect(compileScript([{ kind: 'message', text: '   ' }], 0)).toBeNull()
  })

  it('compiles yes/no with a bail-out jump to the epilogue', () => {
    const base = 0x2000
    const s = compileScript([{ kind: 'yesNo', question: 'SURE?' }, { kind: 'setFlag', flag: 5 }], base)!
    const b = s.bytes
    expect(b[8]).toBe(0x09) // callstd
    expect(b[9]).toBe(0x05) // MSGBOX_YESNO
    expect(Array.from(b.slice(10, 15))).toEqual([0x21, 0x0d, 0x80, 0x00, 0x00]) // compare VAR_RESULT, NO
    expect(b[15]).toBe(0x06) // goto_if
    expect(b[16]).toBe(0x01) // eq
    const dest = (b[17] | (b[18] << 8) | (b[19] << 16) | (b[20] << 24)) >>> 0
    expect(dest).toBe(0x08000000 + base + s.codeLength - 2) // → release
    expect(b[s.codeLength - 2]).toBe(0x6c)
  })

  it('compiles a trainer battle with both text pointers', () => {
    const base = 0x40
    const s = compileScript([{ kind: 'trainerBattle', trainerId: 261, intro: 'GO!', defeat: 'ARGH!' }], base)!
    const b = s.bytes
    expect(b[2]).toBe(0x5c) // trainerbattle
    expect(b[3]).toBe(0x00) // TRAINER_BATTLE_SINGLE
    expect(b[4] | (b[5] << 8)).toBe(261)
    const intro = (b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)) >>> 0
    const defeat = (b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)) >>> 0
    expect(intro).toBe(0x08000000 + base + s.codeLength)
    expect(defeat).toBe(intro + 4) // "GO!" + terminator = 4 bytes
  })
})

describe('custom areas', () => {
  it('resizes a map, preserving overlap and repointing the layout', () => {
    const a = load()
    const m = a.mapModule!
    expect(m.cell('0.0', 1, 0).blockId).toBe(1)
    expect(m.resize('0.0', 6, 5)).toBe(true)
    const d = m.describe('0.0')
    expect(d.widthBlocks).toBe(6)
    expect(d.heightBlocks).toBe(5)
    expect(m.cell('0.0', 1, 0).blockId).toBe(1) // kept
    expect(m.cell('0.0', 0, 1).permission).toBe(1) // permissions kept
    expect(m.cell('0.0', 5, 4).blockId).toBe(0) // new area filled
    const img = m.render('0.0')
    expect(img.width).toBe(96)
    expect(img.height).toBe(80)
    expect(m.entries[0].label).toContain('6×5')
  })

  it('adds and removes events', () => {
    const a = load()
    const m = a.mapModule!
    expect(m.events('0.0').npcs).toHaveLength(1)
    expect(m.addEvent('0.0', 'npc')).toBe(true)
    let ev = m.events('0.0')
    expect(ev.npcs).toHaveLength(2)
    expect(ev.npcs[0].x).toBe(2) // original NPC intact after relocation
    m.updateEvent('0.0', 'npc', 1, 'x', 5)
    expect(m.events('0.0').npcs[1].x).toBe(5)

    // Signs start at zero — exercises the fresh-array path.
    expect(m.events('0.0').signs).toHaveLength(0)
    expect(m.addEvent('0.0', 'sign')).toBe(true)
    expect(m.events('0.0').signs).toHaveLength(1)

    m.removeEvent('0.0', 'npc', 0)
    ev = m.events('0.0')
    expect(ev.npcs).toHaveLength(1)
    expect(ev.npcs[0].x).toBe(5) // the second NPC shifted down
  })

  it('attaches a compiled script to an NPC', () => {
    const rom = new Rom('firered.gba', makeGen3Rom())
    const a = buildAdapter(rom).adapter!
    const m = a.mapModule!
    expect(m.attachScript('0.0', 'npc', 0, [{ kind: 'message', text: 'HI' }])).toBe(true)
    // NPC script pointer (entry offset 0x312400, script at +16) now targets
    // the compiled blob, which starts with lock/faceplayer.
    const scriptPtr = readGbaPointer(rom.bytes, 0x312400 + 16)!
    expect(scriptPtr).not.toBeNull()
    expect(rom.bytes[scriptPtr]).toBe(0x6a)
    expect(rom.bytes[scriptPtr + 1]).toBe(0x5a)
  })

  it('creates a brand-new map by duplication', () => {
    const a = load()
    const m = a.mapModule!
    expect(m.entries).toHaveLength(2)
    const newKey = m.duplicateMap('0.0')!
    expect(newKey).toBe('0.1')
    expect(m.entries).toHaveLength(3)
    expect(m.entries[1].key).toBe('0.1') // inserted right after bank 0's maps

    // Same terrain, same dimensions, renders identically at a sample pixel.
    const d = m.describe(newKey)
    expect(d.widthBlocks).toBe(4)
    expect(d.heightBlocks).toBe(3)
    expect(m.cell(newKey, 1, 0).blockId).toBe(1)
    const img = m.render(newKey)
    expect(img.width).toBe(64)

    // Fully independent: painting the copy leaves the original alone.
    m.paint(newKey, 1, 0, 0)
    expect(m.cell(newKey, 1, 0).blockId).toBe(0)
    expect(m.cell('0.0', 1, 0).blockId).toBe(1)

    // Starts with no events; adding one uses the fresh-array path.
    expect(m.events(newKey).npcs).toHaveLength(0)
    expect(m.addEvent(newKey, 'npc')).toBe(true)
    expect(m.events(newKey).npcs).toHaveLength(1)
    expect(m.events('0.0').npcs).toHaveLength(1) // original untouched
  })

  it('allocates from the end padding', () => {
    const bytes = new Uint8Array(0x1000).fill(0xaa)
    bytes.fill(0xff, 0x800)
    const off = findFreeSpaceAtEnd(bytes, 0x10)!
    expect(off).toBeGreaterThanOrEqual(0x810)
    expect(off % 4).toBe(0)
    expect(findFreeSpaceAtEnd(bytes, 0x1000)).toBeNull()
  })
})

describe('decomp species parser', () => {
  const SAMPLE = `
const struct SpeciesInfo gSpeciesInfo[] =
{
    [SPECIES_NONE] = {0},

    [SPECIES_BULBASAUR] =
    {
        .baseHP        = 45,
        .baseAttack    = 49,
        .types = { TYPE_GRASS, TYPE_POISON},
        .catchRate = 45,
        .expYield = 64,
        .growthRate = GROWTH_MEDIUM_SLOW,
        .abilities = {ABILITY_OVERGROW, ABILITY_NONE},
    },

    [SPECIES_IVYSAUR] =
    {
        .baseHP        = 60,
        .catchRate = 45,
    },
};
`

  it('parses species blocks with nested braces', () => {
    const entries = parseSpeciesInfo(SAMPLE)
    expect(entries.map((e) => e.species)).toEqual(['BULBASAUR', 'IVYSAUR'])
    const b = entries[0]
    expect(numericValue(b, 'baseHP')).toBe(45)
    expect(numericValue(b, 'catchRate')).toBe(45)
    expect(numericValue(b, 'growthRate')).toBeNull() // constant, not numeric
    expect(b.fields.get('types')).toContain('TYPE_GRASS')
  })

  it('edits a field while preserving formatting', () => {
    const entries = parseSpeciesInfo(SAMPLE)
    const next = setNumericField(SAMPLE, entries[0], 'baseHP', 100)!
    expect(next).toContain('.baseHP        = 100')
    expect(next).toContain('.baseHP        = 60') // Ivysaur untouched
    const reparsed = parseSpeciesInfo(next)
    expect(numericValue(reparsed[0], 'baseHP')).toBe(100)
    expect(numericValue(reparsed[1], 'baseHP')).toBe(60)
  })

  it('prettifies species macro names', () => {
    expect(prettySpeciesName('MR_MIME')).toBe('Mr Mime')
    expect(prettySpeciesName('BULBASAUR')).toBe('Bulbasaur')
  })
})
