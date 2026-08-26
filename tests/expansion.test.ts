/**
 * pokeemerald-expansion adapter.
 *
 * The fixture's species stride (0x120) and pointer-block offset are
 * deliberately not the ones the reference ROM used, so these tests fail
 * if discovery is ever replaced by an assumption.
 */
import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import type { ScriptStep } from '../src/core/games/schema'
import { buildAdapter } from '../src/core/games'
import { findSpeciesTable, findMoveTable, voteTable } from '../src/core/gba/expansion'
import { makeGen3ExpansionRom, makeGen3Rom } from './fixtures'

function adapter() {
  const rom = new Rom('expansion.gba', makeGen3ExpansionRom())
  const { adapter } = buildAdapter(rom)
  if (!adapter) throw new Error('no adapter built')
  return { rom, a: adapter }
}

describe('expansion discovery', () => {
  it('discovers the species table base, stride and count', () => {
    const table = findSpeciesTable(makeGen3ExpansionRom())
    expect(table).not.toBeNull()
    expect(table!.base).toBe(0x010000)
    expect(table!.stride).toBe(0x120)
    expect(table!.count).toBe(160)
    expect(table!.pointerBlock).toBe(160)
  })

  it('discovers the move table by its name pointers', () => {
    const table = findMoveTable(makeGen3ExpansionRom())
    expect(table).not.toBeNull()
    expect(table!.base).toBe(0x020000)
    expect(table!.stride).toBe(68)
    expect(table!.count).toBe(200)
  })

  it('does not mistake a vanilla Gen 3 ROM for an expansion one', () => {
    expect(findSpeciesTable(makeGen3Rom())).toBeNull()
  })

  it('still builds the vanilla adapter for a vanilla ROM', () => {
    const { adapter } = buildAdapter(new Rom('fire.gba', makeGen3Rom()))
    expect(adapter?.gameName).not.toContain('expansion')
  })

  it('needs two agreeing anchor pairs before trusting a table', () => {
    // A single anchor implies no pair at all, so nothing is returned.
    expect(voteTable([{ index: 1, offsets: [0x1000] }], { minStride: 4, maxStride: 0x400 })).toBeNull()
    // Two anchors agree on exactly one pair — still short of the bar.
    const two = voteTable(
      [
        { index: 1, offsets: [0x1000] },
        { index: 2, offsets: [0x1100] },
      ],
      { minStride: 4, maxStride: 0x400 },
    )
    expect(two).toBeNull()
    // Three collinear anchors give three agreeing pairs.
    const three = voteTable(
      [
        { index: 1, offsets: [0x1000] },
        { index: 2, offsets: [0x1100] },
        { index: 3, offsets: [0x1200] },
      ],
      { minStride: 4, maxStride: 0x400 },
    )
    expect(three).toEqual({ base: 0x0f00, stride: 0x100, votes: 3 })
  })
})

describe('expansion adapter', () => {
  it('reads the widened species fields', () => {
    const { a } = adapter()
    expect(a.species[0].name).toBe('Bulbasaur')
    expect(a.species.length).toBe(160)
    const s = a.readSpecies(1)
    expect(s.hp).toBe(45)
    expect(s.type1).toBe(13) // the expansion's Type enum is 1-based
    expect(s.expYield).toBe(64) // u16, not vanilla's u8
    expect(s.abilityHidden).toBe(34) // third ability slot
    expect(s.evSat).toBe(1)
  })

  it('labels types and abilities with names read from the ROM', () => {
    const { a } = adapter()
    expect(a.typeOptions[13].label).toBe('Grass')
    expect(a.typeOptions[1].label).toBe('Normal')
    const ability = a.speciesFields.find((f) => f.key === 'ability1')
    expect(ability?.options?.[65].label).toBe('Overgrow')
    expect(a.itemOptions?.[4].label).toBe('Master Ball')
  })

  it('writes 16-bit species fields and reverts them', () => {
    const { a } = adapter()
    a.writeSpeciesField(1, 'expYield', 1234)
    a.writeSpeciesField(1, 'abilityHidden', 300)
    expect(a.readSpecies(1).expYield).toBe(1234)
    expect(a.readSpecies(1).abilityHidden).toBe(300)
    a.revertSpecies(1)
    expect(a.readSpecies(1).expYield).toBe(64)
    expect(a.readSpecies(1).abilityHidden).toBe(34)
  })

  it('sets one EV yield without disturbing the others', () => {
    const { a } = adapter()
    a.writeSpeciesField(1, 'evSdf', 3)
    expect(a.readSpecies(1).evSdf).toBe(3)
    expect(a.readSpecies(1).evSat).toBe(1)
  })

  it('renames a species in its inline name field', () => {
    const { a } = adapter()
    expect(a.setSpeciesName(1, 'Testmon')).toBe(true)
    expect(a.species[0].name).toBe('Testmon')
    a.revertSpecies(1)
    expect(a.species[0].name).toBe('Bulbasaur')
  })

  it('reads move names through their pointers', () => {
    const { a } = adapter()
    expect(a.moves[0].name).toBe('Pound')
    expect(a.moves[1].name).toBe('Karate Chop')
    expect(a.moves[84].name).toBe('Thunderbolt')
  })

  it('packs move bitfields without corrupting their neighbours', () => {
    const { a } = adapter()
    const before = a.readMove(85)
    expect(before).toMatchObject({ type: 14, category: 1, power: 90, accuracy: 100, target: 1 })
    a.writeMoveField(85, 'power', 511) // 9 bits, more than vanilla could hold
    expect(a.readMove(85)).toMatchObject({ power: 511, type: 14, category: 1 })
    a.writeMoveField(85, 'accuracy', 55)
    expect(a.readMove(85)).toMatchObject({ accuracy: 55, target: 1 })
    a.writeMoveField(85, 'priority', -6) // 4-bit signed
    expect(a.readMove(85).priority).toBe(-6)
    a.revertMove(85)
    expect(a.readMove(85)).toEqual(before)
  })

  it('reads per-species learnsets, egg moves and evolutions', () => {
    const { a } = adapter()
    expect(a.learnsets?.read(1)).toEqual([
      { level: 1, move: 33 },
      { level: 1, move: 45 },
      { level: 3, move: 22 },
    ])
    expect(a.eggMoves?.read(1)).toEqual([34, 35])
    expect(a.evolutions?.read(1)).toEqual([{ method: 1, param: 16, target: 2 }])
  })

  it('rewrites a learnset in place when it shrinks', () => {
    const { rom, a } = adapter()
    const before = rom.changedByteCount
    expect(a.learnsets?.write(1, [{ level: 5, move: 99 }])).toBe(true)
    expect(a.learnsets?.read(1)).toEqual([{ level: 5, move: 99 }])
    expect(rom.changedByteCount).toBeGreaterThan(before)
  })

  it('relocates a grown learnset and repoints only that species', () => {
    const { a } = adapter()
    const other = a.learnsets!.read(2)
    const grown = [...a.learnsets!.read(1), { level: 40, move: 7 }, { level: 50, move: 8 }]
    expect(a.learnsets?.write(1, grown)).toBe(true)
    expect(a.learnsets?.read(1)).toEqual(grown)
    // Species 2 shares the original blob in this fixture; it must be
    // left pointing at the untouched original.
    expect(a.learnsets?.read(2)).toEqual(other)
  })

  it('grows an egg move list without clobbering the learnset it follows', () => {
    const { a } = adapter()
    const grownLearnset = [...a.learnsets!.read(1), { level: 40, move: 7 }]
    expect(a.learnsets?.write(1, grownLearnset)).toBe(true)
    expect(a.eggMoves?.write(1, [34, 35, 36, 37])).toBe(true)
    expect(a.eggMoves?.read(1)).toEqual([34, 35, 36, 37])
    expect(a.learnsets?.read(1)).toEqual(grownLearnset)
  })

  it('edits an existing evolution entry and reverts it', () => {
    const { a } = adapter()
    a.evolutions?.write(1, 0, 'param', 22)
    a.evolutions?.write(1, 0, 'target', 3)
    expect(a.evolutions?.read(1)).toEqual([{ method: 1, param: 22, target: 3 }])
    a.evolutions?.revert(1)
    expect(a.evolutions?.read(1)).toEqual([{ method: 1, param: 16, target: 2 }])
  })

  it('reads time-of-day wild encounters and writes them back', () => {
    const { a } = adapter()
    const w = a.wildModule
    expect(w).not.toBeNull()
    const key = w!.entries[0].key
    const groups = w!.groups(key)
    expect(groups.map((g) => g.name)).toEqual([
      'Morning — Land',
      'Day — Land',
      'Evening — Land',
      'Night — Land',
    ])
    expect(groups[0].rate).toBe(20)
    expect(groups[0].slots).toHaveLength(12)
    w!.setSlot(key, 0, 0, 'species', 25)
    w!.setRate(key, 0, 42)
    expect(w!.groups(key)[0].slots[0].species).toBe(25)
    expect(w!.groups(key)[0].rate).toBe(42)
    w!.revert(key)
    expect(w!.groups(key)[0]).toEqual(groups[0])
  })

  it('renders smol-compressed sprites with their raw palettes', () => {
    const { a } = adapter()
    const front = a.speciesSprite?.(1)
    expect(front).toMatchObject({ width: 64, height: 64 })
    expect(a.speciesSpriteBack?.(1)).toMatchObject({ width: 64, height: 64 })
    expect(a.hasShinySprites).toBe(true)
    // The fixture's palette opens with 0x10 — the LZ77 magic byte — so
    // this also pins the Roselia bug: a raw palette must not be taken
    // for a compressed one and lose the sprite.
    const px = front!.pixels
    let opaque = 0
    for (let i = 0; i < 64 * 64; i++) if (px[i * 4 + 3] === 255) opaque++
    expect(opaque).toBeGreaterThan(0)
    // Shiny uses the other palette, so at least one pixel differs.
    const shiny = a.speciesSprite?.(1, true)!
    expect(Array.from(shiny.pixels)).not.toEqual(Array.from(px))
  })

  it('imports a sprite into a smol ROM by writing LZ77', () => {
    const { rom, a } = adapter()
    const pixels = new Uint8ClampedArray(64 * 64 * 4)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4
        const band = ((x >> 3) + (y >> 3)) % 8
        pixels[i] = band * 32
        pixels[i + 1] = 255 - band * 32
        pixels[i + 2] = 128
        pixels[i + 3] = 255
      }
    }
    expect(a.importSpeciesSprite?.(1, { pixels, width: 64, height: 64 })).toBeNull()
    expect(rom.changedByteCount).toBeGreaterThan(0)
    // Reading it back goes through the LZ77 branch now, not smol.
    const back = a.speciesSprite?.(1)
    expect(back).toMatchObject({ width: 64, height: 64 })
    let close = 0
    for (let i = 0; i < 64 * 64; i++) {
      if (Math.abs(back!.pixels[i * 4] - pixels[i * 4]) < 12) close++
    }
    expect(close).toBeGreaterThan(64 * 64 * 0.9)
    // A different species still decodes from its untouched smol stream.
    expect(a.speciesSprite?.(2)).toMatchObject({ width: 64, height: 64 })
  })

  it('enables map editing now that expansion tilesets decode', () => {
    const { a } = adapter()
    expect(a.mapModule).not.toBeNull()
    expect(a.warnings.join(' ')).not.toContain('tilesets')
    const key = a.mapModule!.entries[0].key
    expect(a.mapModule!.render(key).width).toBeGreaterThan(0)
  })

  it('names maps from the region-map table', () => {
    const { a } = adapter()
    // The fixture's map header points at region-map section 1.
    // Labels are title-cased for display; the raw stored name stays put.
    expect(a.mapModule!.entries[0].label).toContain('Viridian City')
    expect(a.mapModule!.entries[0].areaName).toBe('VIRIDIAN CITY')
  })

  it('reads trainers, their classes and their parties', () => {
    const { a } = adapter()
    const t = a.trainerModule
    expect(t).not.toBeNull()
    expect(t!.entries.length).toBe(60)
    const first = t!.read(0)
    expect(first.name).toBe('SAWYER')
    expect(first.partySize).toBe(1)
    expect(first.aiFlags).toBe(7)
    expect(t!.party(0)).toEqual([
      { species: 1, level: 5, iv: null, ivs: [31, 0, 15, 1, 20, 7], item: 0, moves: [0, 0, 0, 0] },
    ])
    // Class names must survive an accented character; 'POKéMANIAC'
    // truncated the class table when the text check was a byte range.
    expect(t!.classOptions?.[7].label).toBe('POKéMANIAC')
    expect(t!.classOptions!.length).toBe(40)
  })

  it('edits one IV without disturbing the others or the unused bits', () => {
    const { a, rom } = adapter()
    const t = a.trainerModule!
    const mon = () => t.party(0)[0]
    const ivWord = () => rom.readU16LE(0x062008) | (rom.readU16LE(0x06200a) << 16)
    const before = ivWord()

    t.writePartyField(0, 0, 'iv1', 31)
    expect(mon().ivs).toEqual([31, 31, 15, 1, 20, 7])
    // Bit 31 is not part of any IV and must survive the write.
    expect(ivWord() >>> 31).toBe(1)

    // Out-of-range values clamp rather than bleeding into the next stat.
    t.writePartyField(0, 0, 'iv2', 99)
    expect(mon().ivs).toEqual([31, 31, 31, 1, 20, 7])

    t.writePartyField(0, 0, 'iv1', 0)
    t.writePartyField(0, 0, 'iv2', 15)
    expect(ivWord()).toBe(before)
    expect(rom.changedByteCount).toBe(0)
  })

  it('grows a trainer party past its original size by moving it', () => {
    const { a, rom } = adapter()
    const t = a.trainerModule!
    const before = t.read(0).partySize
    expect(before).toBeLessThan(6)

    t.write(0, 'partySize', 6)
    expect(t.read(0).partySize).toBe(6)
    // The party moved, so the new slots must be real, editable mons and
    // not whatever bytes happened to follow the original block.
    const party = t.party(0)
    expect(party).toHaveLength(6)
    expect(party[5].species).toBeGreaterThan(0)
    t.writePartyField(0, 5, 'species', 25)
    expect(t.party(0)[5].species).toBe(25)
    // The mons that were already there must survive the move.
    expect(t.party(0)[0].species).toBe(1)

    t.revert(0)
    expect(t.read(0).partySize).toBe(before)
    // Reverting has to reclaim the relocated block too, or the ROM keeps
    // bytes nothing points at.
    expect(rom.changedByteCount).toBe(0)
  })

  it('reads an attached script back for editing, and refuses foreign ones', () => {
    const { a } = adapter()
    const maps = a.mapModule!
    const key = maps.entries[0].key

    // The fixture's NPC has a hand-written script this builder cannot
    // represent; approximating it would silently lose the real one.
    expect(maps.readScript(key, 'npc', 1).kind).toBe('foreign')

    const steps: ScriptStep[] = [
      { kind: 'message', text: 'HELLO!' },
      { kind: 'giveItem', item: 13, quantity: 2 },
      { kind: 'trainerBattle', trainerId: 3, intro: 'FIGHT!', defeat: 'YOU WIN!' },
    ]
    expect(maps.attachScript(key, 'npc', 0, steps)).toBe(true)
    const back = maps.readScript(key, 'npc', 0)
    expect(back.kind).toBe('steps')
    if (back.kind === 'steps') expect(back.steps).toEqual(steps)
  })

  it('labels wild encounter maps with their area name', () => {
    const { a } = adapter()
    const wild = a.wildModule!
    // Without the region-map name a wild entry reads only as "Map 0.0",
    // which says nothing about where the encounters actually are.
    expect(wild.entries[0].label).toBe('0.0 — Viridian City')
  })

  it('links a map trainer to its trainer entry through the script', () => {
    const { a } = adapter()
    const spots = a.trainerLocations!.get(3)!
    // The fixture's trainer NPC stands at (1,2) on both banks' shared map.
    expect(spots.map((s) => `${s.mapKey}@${s.x},${s.y}`)).toContain('0.0@1,2')
    expect(spots[0].eventIndex).toBe(1)
    // The plain NPC on the same map carries no trainerType and must not
    // be mistaken for a trainer.
    expect([...a.trainerLocations!.values()].flat().every((s) => s.eventIndex === 1)).toBe(true)
  })

  it('leaves a trainer unlinked rather than guessing when no id is in the script', () => {
    const { a } = adapter()
    // Only trainer 3 is placed; every other trainer has no fixed spot.
    expect(a.trainerLocations!.has(3)).toBe(true)
    expect(a.trainerLocations!.has(4)).toBe(false)
  })

  it('finds the trainer sprite table by its counting tag, not its shape', () => {
    const { a } = adapter()
    const img = a.trainerSprite!(0)
    expect(img).not.toBeNull()
    expect(img!.width).toBe(64)
    expect(img!.height).toBe(64)
    // The decoy run is twice as long but its tags never count, so a
    // longest-run-wins scan without the tag check would pick it and
    // return sprites for indices the real table does not have.
    expect(a.trainerSprite!(29)).not.toBeNull()
    expect(a.trainerSprite!(30)).toBeNull()
  })

  it('keeps a trainer with no name at all in the table', () => {
    // 30 of the reference ROM's 854 trainers are unnamed, and rejecting
    // those cut discovery off at entry 21.
    const { a } = adapter()
    expect(a.trainerModule!.read(21).name).toBe('')
    expect(a.trainerModule!.entries.length).toBeGreaterThan(21)
  })

  it('edits trainer fields that share a byte, and reverts', () => {
    const { rom, a } = adapter()
    const t = a.trainerModule!
    const before = t.read(0)
    const party = t.party(0)
    t.write(0, 'music', 9)
    t.write(0, 'gender', 1)
    expect(t.read(0)).toMatchObject({ music: 9, gender: 1 })
    t.write(0, 'trainerClass', 5)
    t.write(0, 'aiFlags', 0x1234)
    expect(t.read(0)).toMatchObject({ trainerClass: 5, aiFlags: 0x1234 })
    t.setName(0, 'ZED')
    expect(t.entries[0].name).toBe('ZED')
    t.writePartyField(0, 0, 'species', 25)
    t.writePartyField(0, 0, 'level', 55)
    t.writePartyField(0, 0, 'move0', 85)
    expect(t.party(0)[0]).toMatchObject({ species: 25, level: 55, moves: [85, 0, 0, 0] })
    t.revert(0)
    expect(t.read(0)).toEqual(before)
    expect(t.party(0)).toEqual(party)
    expect(rom.changedByteCount).toBe(0)
  })

  it('edits item data, including the widened 32-bit price', () => {
    const { a } = adapter()
    const it = a.itemModule
    expect(it).not.toBeNull()
    expect(it!.entries[4].name).toBe('Master Ball')
    it!.write(4, 'price', 123456) // more than vanilla's u16 could hold
    expect(it!.read(4).price).toBe(123456)
    const before = it!.read(4).importance
    it!.write(4, 'pocket', 3)
    expect(it!.read(4)).toMatchObject({ pocket: 3, importance: before })
  })

  it('never renames a second item that shares one name string', () => {
    const { a } = adapter()
    const it = a.itemModule!
    const other = it.entries[3].name
    expect(it.setName(4, 'Test Ball')).toBe(true)
    expect(it.entries[4].name).toBe('Test Ball')
    expect(it.entries[3].name).toBe(other)
  })

  it('relocates a description shared by two items instead of editing in place', () => {
    const { a } = adapter()
    const it = a.itemModule!
    // The fixture points items 3 and 4 at one string.
    expect(it.description(3)).toBe(it.description(4))
    expect(it.setDescription(4, 'Only mine.')).toBe(true)
    expect(it.description(4)).toBe('Only mine.')
    expect(it.description(3)).toBe('A shared blurb.')
  })

  it('reverts an item including its pointed-at name and description', () => {
    const { rom, a } = adapter()
    const it = a.itemModule!
    const name = it.entries[28].name
    const desc = it.description(28)
    it.write(28, 'flingPower', 99)
    it.setName(28, 'Elixir')
    it.setDescription(28, 'Short.')
    it.revert(28)
    expect(it.entries[28].name).toBe(name)
    expect(it.description(28)).toBe(desc)
    expect(rom.changedByteCount).toBe(0)
  })
})
