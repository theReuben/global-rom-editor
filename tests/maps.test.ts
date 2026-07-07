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

  it('is absent for Gen 1 ROMs (roadmap)', () => {
    const adapter = buildAdapter(new Rom('red.gb', makeGen1Rom())).adapter!
    expect(adapter.mapModule).toBeNull()
  })
})
