import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { discoverMaps } from '../src/core/gba/mapscan'
import { makeGen1Rom, makeGen3Rom } from './fixtures'

const loadModule = () => {
  const adapter = buildAdapter(new Rom('firered.gba', makeGen3Rom())).adapter!
  expect(adapter.mapModule).not.toBeNull()
  return adapter.mapModule!
}

const px = (img: { pixels: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const o = (y * img.width + x) * 4
  return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]]
}

describe('structural map discovery', () => {
  it('finds the bank table, groups and headers bottom-up', () => {
    const index = discoverMaps(makeGen3Rom())!
    expect(index).not.toBeNull()
    expect(index.banks).toHaveLength(2)
    expect(index.banks[0]).toHaveLength(1)
    expect(index.banks[1]).toHaveLength(1)
    expect(index.bankTableOffset).toBe(0x313100)
  })

  it('finds nothing in a ROM without map structures', () => {
    expect(discoverMaps(makeGen1Rom())).toBeNull()
  })
})

describe('Gen 3 map module', () => {
  it('lists maps with dimensions', () => {
    const m = loadModule()
    expect(m.entries).toHaveLength(2)
    expect(m.entries[0].label).toContain('4×3')
    expect(m.describe('0.0')).toEqual({ widthBlocks: 4, heightBlocks: 3, blockCount: 1024 })
  })

  it('renders blocks through both tilesets, palettes and LZ77', () => {
    const m = loadModule()
    const img = m.render('0.0')
    expect(img.width).toBe(64)
    expect(img.height).toBe(48)
    expect(px(img, 8, 8)).toEqual([255, 0, 0]) // block 0: primary tile, palette 0
    expect(px(img, 24, 8)).toEqual([0, 255, 0]) // block 1: primary tile, palette 1
    expect(px(img, 56, 8)).toEqual([0, 0, 255]) // block 640: secondary tileset, palette 7
  })

  it('renders the block picker', () => {
    const m = loadModule()
    const strip = m.renderBlocks('0.0', 8)
    expect(strip.count).toBe(1024)
    expect(strip.width).toBe(128)
    expect(px(strip, 24, 8)).toEqual([0, 255, 0]) // block 1 in slot (1,0)
  })

  it('paints blocks while preserving movement permissions', () => {
    const m = loadModule()
    expect(m.cell('0.0', 0, 1)).toEqual({ blockId: 0, permission: 1 })
    m.paint('0.0', 0, 1, 1)
    expect(m.cell('0.0', 0, 1)).toEqual({ blockId: 1, permission: 1 })
    const img = m.render('0.0')
    expect(px(img, 8, 24)).toEqual([0, 255, 0])
  })

  it('edits movement permissions while preserving the block', () => {
    const m = loadModule()
    m.setPermission('0.0', 1, 0, 5)
    expect(m.cell('0.0', 1, 0)).toEqual({ blockId: 1, permission: 5 })
  })

  it('reverts block-grid edits', () => {
    const m = loadModule()
    m.paint('0.0', 0, 0, 640)
    expect(m.cell('0.0', 0, 0).blockId).toBe(640)
    m.revertBlocks('0.0')
    expect(m.cell('0.0', 0, 0).blockId).toBe(0)
  })

  it('reads NPC, warp and sign events', () => {
    const m = loadModule()
    const ev = m.events('0.0')
    expect(ev.npcs).toEqual([{ x: 2, y: 1, elevation: 3, graphicsId: 5, movementType: 1 }])
    expect(ev.warps).toEqual([
      { x: 3, y: 2, elevation: 0, warpId: 1, targetMap: 0, targetBank: 1 },
    ])
    expect(ev.signs).toEqual([])
  })

  it('edits event fields in place', () => {
    const m = loadModule()
    m.updateEvent('0.0', 'npc', 0, 'x', 3)
    m.updateEvent('0.0', 'npc', 0, 'graphicsId', 12)
    m.updateEvent('0.0', 'warp', 0, 'targetBank', 0)
    const ev = m.events('0.0')
    expect(ev.npcs[0].x).toBe(3)
    expect(ev.npcs[0].graphicsId).toBe(12)
    expect(ev.warps[0].targetBank).toBe(0)
  })

})

describe('Gen 1 maps', () => {
  const loadGen1 = async () => {
    const { makeGen1Rom } = await import('./fixtures')
    return buildAdapter(new Rom('red.gb', makeGen1Rom())).adapter!
  }

  it('discovers headers, banks and tilesets structurally', async () => {
    const a = await loadGen1()
    const m = a.mapModule!
    expect(m).not.toBeNull()
    expect(m.entries).toHaveLength(160)
    expect(m.entries[0].label).toBe('Pallet Town')
    expect(m.describe(m.entries[0].key)).toMatchObject({ widthBlocks: 5, heightBlocks: 4 })
  })

  it('renders 2bpp blocks and paints in place', async () => {
    const a = await loadGen1()
    const m = a.mapModule!
    const key = m.entries[0].key
    const img = m.render(key)
    expect(img.width).toBe(5 * 32)
    expect(img.height).toBe(4 * 32)
    // Block (0,0) is block 0 (lightest); block (1,0) is block 1 (darkest).
    expect(img.pixels[0]).toBe(232)
    expect(img.pixels[(0 * img.width + 32) * 4]).toBe(28)
    expect(m.cell(key, 1, 0).blockId).toBe(1)

    m.paint(key, 0, 1, 1)
    expect(m.cell(key, 0, 1).blockId).toBe(1)
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    expect(re.mapModule!.cell(key, 0, 1).blockId).toBe(1)
    m.revertBlocks(key)
    expect(m.cell(key, 0, 1).blockId).toBe(0)
    expect(a.rom.changedByteCount).toBe(0)

    const strip = m.renderBlocks(key, 8)
    expect(strip.count).toBeGreaterThanOrEqual(2)
    expect(strip.perRow).toBe(8)
  })

  it('reads and edits warps, signs and NPCs', async () => {
    const a = await loadGen1()
    const m = a.mapModule!
    const key = m.entries[0].key
    const ev = m.events(key)
    expect(ev.warps).toHaveLength(1)
    expect(ev.warps[0]).toMatchObject({ x: 5, y: 5, warpId: 1, targetMap: 40 })
    expect(ev.signs[0]).toMatchObject({ x: 13, y: 13, kind: 4 })
    expect(ev.npcs).toHaveLength(2) // trainer extras must not desync the walk
    expect(ev.npcs[0]).toMatchObject({ x: 8, y: 5, graphicsId: 7, movementType: 1 })
    expect(ev.npcs[1]).toMatchObject({ x: 3, y: 6, graphicsId: 9 })

    m.updateEvent(key, 'npc', 0, 'x', 12)
    m.updateEvent(key, 'warp', 0, 'targetMap', 7)
    m.updateEvent(key, 'sign', 0, 'kind', 9)
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    const rev = re.mapModule!.events(key)
    expect(rev.npcs[0].x).toBe(12)
    expect(rev.warps[0].targetMap).toBe(7)
    expect(rev.signs[0].kind).toBe(9)
  })
})

describe('Gen 2 maps', () => {
  const loadGen2 = async () => {
    const { makeGen2Rom } = await import('./fixtures')
    return buildAdapter(new Rom('crystal.gbc', makeGen2Rom())).adapter!
  }

  it('discovers groups, attributes and tilesets structurally', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    expect(m).not.toBeNull()
    expect(m.entries).toHaveLength(26 * 4) // 26 groups sharing a 4-map array
    expect(m.entries.some((e) => e.key === '3.2')).toBe(true)
    expect(m.describe('1.1')).toMatchObject({ widthBlocks: 4, heightBlocks: 3 })
  })

  it('renders lz3 tilesets in CGB colors and paints in place', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    const img = m.render('1.1')
    expect(img.width).toBe(4 * 32)
    expect(img.height).toBe(3 * 32)
    // Palette map says tile 0 = GRAY, tile 1 = BROWN; the fixture maps
    // are TOWN so the outdoor day palettes apply.
    expect(img.pixels[0]).toBe(222) // GRAY color 0 = RGB5 27,31,27
    expect(img.pixels[32 * 4]).toBe(57) // block (1,0) → tile 1 color 3 = BROWN dark
    m.paint('1.1', 0, 1, 1)
    expect(m.cell('1.1', 0, 1).blockId).toBe(1)
    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    expect(re.mapModule!.cell('1.1', 0, 1).blockId).toBe(1)
    m.revertBlocks('1.1')
    expect(a.rom.changedByteCount).toBe(0)
  })

  it('reads and edits warps, signs and NPCs', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    const ev = m.events('1.1')
    expect(ev.warps).toHaveLength(2)
    expect(ev.warps[0]).toMatchObject({ x: 5, y: 5, warpId: 1, targetBank: 13, targetMap: 2 })
    expect(ev.warps[1]).toMatchObject({ x: 12, y: 11, targetBank: 1, targetMap: 3 })
    expect(ev.signs).toHaveLength(1)
    expect(ev.signs[0]).toMatchObject({ x: 7, y: 9, kind: 0 })
    expect(ev.npcs).toHaveLength(2)
    expect(ev.npcs[0]).toMatchObject({ x: 3, y: 8, graphicsId: 2, movementType: 0 })
    expect(ev.npcs[1]).toMatchObject({ x: 12, y: 14, graphicsId: 5, movementType: 6 })

    m.updateEvent('1.1', 'npc', 0, 'x', 9)
    m.updateEvent('1.1', 'warp', 1, 'targetMap', 4)
    m.updateEvent('1.1', 'sign', 0, 'kind', 2)
    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    const rev = re.mapModule!.events('1.1')
    expect(rev.npcs[0].x).toBe(9)
    expect(rev.warps[1].targetMap).toBe(4)
    expect(rev.signs[0].kind).toBe(2)
  })
})
