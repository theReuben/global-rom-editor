/**
 * Item editing for pokeemerald-expansion.
 *
 * `struct ItemInfo` happens to be 44 bytes like vanilla's, but nothing
 * inside matches: the name and description are POINTERS rather than
 * inline fixed-width text, and there is no self-identifying `itemId`
 * field for gba/items.ts to lock onto. Layout (verified against a built
 * ROM — Poké Ball 200/Ultra Ball 800/Master Ball 0, Potion's hold-effect
 * value 20 and fling power 30, all matching the tree):
 *
 *   +0x00 u32 price
 *   +0x04 u16 secondaryId
 *   +0x08 ItemUseFunc fieldUseFunc
 *   +0x0C const u8 *description
 *   +0x10 const u8 *effect
 *   +0x14 const u8 *name
 *   +0x18 const u8 *pluralName
 *   +0x1C u8  holdEffect
 *   +0x1D u8  holdEffectParam
 *   +0x1E u8  importance:2 | notConsumed:1 | pocket:5
 *   +0x1F u8  sortType
 *   +0x20 u8  type
 *   +0x21 u8  battleUsage
 *   +0x22 u8  flingPower
 *   +0x24 const u32 *iconPic
 *   +0x28 const u16 *iconPalette
 */
import type { Rom } from '../rom'
import {
  GEN3_HOLD_EFFECTS,
  GEN3_ITEM_BATTLE_USE,
  GEN3_ITEM_SORT_TYPES,
  GEN3_ITEM_USE_TYPES,
  symbolOptions,
} from '../games/gen3-symbols'
import type { EntryHandle, FieldSpec, ItemModule, SelectOption } from '../games/schema'
import { findFreeSpaceAtEnd, readGbaPointer, writeGbaPointer } from '../freespace'
import { gen3DecodeText, gen3EncodeText } from '../text'

export const ITEM_ENTRY = 44
export const IT = {
  price: 0x00,
  secondaryId: 0x04,
  description: 0x0c,
  name: 0x14,
  pluralName: 0x18,
  holdEffect: 0x1c,
  holdEffectParam: 0x1d,
  packed: 0x1e, // importance:2 | notConsumed:1 | pocket:5
  sortType: 0x1f,
  type: 0x20,
  battleUsage: 0x21,
  flingPower: 0x22,
} as const

const MAX_NAME = 24
const MAX_DESCRIPTION = 256

/** `enum Pocket`. */
const POCKETS: SelectOption[] = [
  { value: 0, label: 'Items' },
  { value: 1, label: 'Poké Balls' },
  { value: 2, label: 'TMs & HMs' },
  { value: 3, label: 'Berries' },
  { value: 4, label: 'Key Items' },
]

export interface ExpansionItems {
  module: ItemModule
  offset: number
  count: number
  /** id → name, for the held-item dropdowns elsewhere. */
  options: SelectOption[]
}

function textAt(bytes: Uint8Array, off: number, max: number): string {
  return gen3DecodeText(bytes.subarray(off, Math.min(off + max, bytes.length)))
}

/**
 * Rewrite a pointed-at string. In place when it fits and no OTHER entry
 * shares the string — placeholder items commonly all point at the same
 * "????????", and editing one must not rename the rest.
 */
function writeSharedText(
  rom: Rom,
  ptrField: number,
  text: string,
  maxLen: number,
  shared: (target: number) => boolean,
): boolean {
  const encoded = gen3EncodeText(text)
  if (!encoded || encoded.length === 0 || encoded.length > maxLen) return false
  const target = readGbaPointer(rom.bytes, ptrField)
  if (target === null) return false
  const room = rom.bytes.subarray(target, Math.min(target + maxLen + 1, rom.bytes.length)).indexOf(0xff)
  if (room >= 0 && encoded.length <= room && !shared(target)) {
    rom.writeBytes(target, [...encoded, 0xff])
    return true
  }
  const dest = findFreeSpaceAtEnd(rom.bytes, encoded.length + 1)
  if (dest === null) return false
  rom.writeBytes(dest, [...encoded, 0xff])
  writeGbaPointer(rom, ptrField, dest)
  return true
}

export function buildExpansionItems(rom: Rom, table: { offset: number; count: number }): ExpansionItems {
  const bytes = rom.bytes
  const { offset, count } = table
  const entryAt = (id: number) => offset + id * ITEM_ENTRY

  const nameOf = (id: number): string => {
    const p = readGbaPointer(bytes, entryAt(id) + IT.name)
    return p === null ? '' : textAt(bytes, p, MAX_NAME)
  }

  const entries: EntryHandle[] = []
  const refresh = (id: number) => {
    const name = nameOf(id) || `Item #${id}`
    entries[id] = { id, label: `#${String(id).padStart(3, '0')} ${name}`, name }
  }
  for (let i = 0; i < count; i++) refresh(i)

  /** Is this string pointed at by more than one item? */
  const sharedText = (field: number) => (target: number) => {
    let hits = 0
    for (let i = 0; i < count; i++) {
      if (readGbaPointer(bytes, entryAt(i) + field) === target && ++hits > 1) return true
    }
    return false
  }

  const fields: FieldSpec[] = [
    { key: 'price', label: 'Price', kind: 'number', min: 0, max: 0xffffffff, group: 'shop', help: 'The expansion widened this to 32 bits.' },
    { key: 'holdEffect', label: 'Hold effect', kind: 'select', options: symbolOptions(GEN3_HOLD_EFFECTS), group: 'battle' },
    { key: 'holdEffectParam', label: 'Hold effect value', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'flingPower', label: 'Fling power', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'battleUsage', label: 'Battle usage', kind: 'select', options: [{ value: 0, label: 'Not usable in battle' }, ...symbolOptions(GEN3_ITEM_BATTLE_USE)], group: 'battle' },
    { key: 'pocket', label: 'Pocket', kind: 'select', options: POCKETS, group: 'bag' },
    {
      key: 'importance',
      label: 'Importance',
      kind: 'select',
      options: [
        { value: 0, label: 'Normal' },
        { value: 1, label: 'Key item' },
        { value: 2, label: 'HM / unsellable' },
      ],
      group: 'bag',
    },
    { key: 'notConsumed', label: 'Not consumed on use', kind: 'select', options: [{ value: 0, label: 'No' }, { value: 1, label: 'Yes' }], group: 'bag' },
    { key: 'type', label: 'Field use type', kind: 'select', options: symbolOptions(GEN3_ITEM_USE_TYPES), group: 'bag' },
    { key: 'secondaryId', label: 'Secondary id', kind: 'number', min: 0, max: 65535, group: 'bag', help: 'Ball id, TM number, or berry id depending on the item.' },
    { key: 'sortType', label: 'Sort type', kind: 'select', options: symbolOptions(GEN3_ITEM_SORT_TYPES), group: 'bag' },
  ]

  const module: ItemModule = {
    entries,
    fields,
    nameLength: MAX_NAME,

    read(id) {
      const o = entryAt(id)
      const packed = bytes[o + IT.packed]
      return {
        price:
          (bytes[o + IT.price] |
            (bytes[o + IT.price + 1] << 8) |
            (bytes[o + IT.price + 2] << 16) |
            (bytes[o + IT.price + 3] << 24)) >>> 0,
        secondaryId: rom.readU16LE(o + IT.secondaryId),
        holdEffect: bytes[o + IT.holdEffect],
        holdEffectParam: bytes[o + IT.holdEffectParam],
        importance: packed & 0x3,
        notConsumed: (packed >> 2) & 0x1,
        pocket: (packed >> 3) & 0x1f,
        sortType: bytes[o + IT.sortType],
        type: bytes[o + IT.type],
        battleUsage: bytes[o + IT.battleUsage],
        flingPower: bytes[o + IT.flingPower],
      }
    },

    write(id, key, value) {
      if (typeof value !== 'number') return
      const o = entryAt(id)
      const packed = bytes[o + IT.packed]
      switch (key) {
        case 'price':
          rom.writeU16LE(o + IT.price, value & 0xffff)
          rom.writeU16LE(o + IT.price + 2, (value >>> 16) & 0xffff)
          return
        case 'secondaryId':
          return rom.writeU16LE(o + IT.secondaryId, value)
        case 'holdEffect':
          return rom.writeU8(o + IT.holdEffect, value)
        case 'holdEffectParam':
          return rom.writeU8(o + IT.holdEffectParam, value)
        case 'importance':
          return rom.writeU8(o + IT.packed, (packed & ~0x3) | (value & 0x3))
        case 'notConsumed':
          return rom.writeU8(o + IT.packed, (packed & ~0x4) | ((value & 1) << 2))
        case 'pocket':
          return rom.writeU8(o + IT.packed, (packed & 0x7) | ((value & 0x1f) << 3))
        case 'sortType':
          return rom.writeU8(o + IT.sortType, value)
        case 'type':
          return rom.writeU8(o + IT.type, value)
        case 'battleUsage':
          return rom.writeU8(o + IT.battleUsage, value)
        case 'flingPower':
          return rom.writeU8(o + IT.flingPower, value)
      }
    },

    setName(id, name) {
      if (!writeSharedText(rom, entryAt(id) + IT.name, name, MAX_NAME, sharedText(IT.name))) return false
      refresh(id)
      return true
    },

    description(id) {
      const p = readGbaPointer(bytes, entryAt(id) + IT.description)
      return p === null ? '' : textAt(bytes, p, MAX_DESCRIPTION)
    },

    setDescription(id, text) {
      return writeSharedText(rom, entryAt(id) + IT.description, text, MAX_DESCRIPTION, sharedText(IT.description))
    },

    revert(id) {
      // Name and description live behind pointers, so reverting the
      // 44-byte entry alone would leave edited text in place. Restore
      // the text the ORIGINAL pointers referred to as well; if a string
      // was relocated instead, reverting the entry restores the old
      // pointer and the original text is still intact behind it.
      for (const field of [IT.name, IT.description] as const) {
        const original = readGbaPointer(rom.original, entryAt(id) + field)
        if (original === null) continue
        const max = field === IT.name ? MAX_NAME : MAX_DESCRIPTION
        const term = rom.original.subarray(original, Math.min(original + max + 1, rom.original.length)).indexOf(0xff)
        if (term >= 0) rom.revertRange(original, term + 1)
      }
      rom.revertRange(entryAt(id), ITEM_ENTRY)
      refresh(id)
    },
  }

  const options: SelectOption[] = [{ value: 0, label: '— none —' }]
  for (let i = 1; i < count; i++) {
    const name = entries[i]?.name ?? ''
    options.push({ value: i, label: name && !/\?{3,}/.test(name) ? name : `Item #${i}` })
  }

  return { module, offset, count, options }
}
