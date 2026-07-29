/**
 * Gen 3 item data (`gItems`).
 *
 * 44-byte entries, layout verified against built Emerald + FireRed (the
 * two are identical) rather than read off the header:
 *
 *   0  name[14]      14 itemId u16     16 price u16
 *   18 holdEffect    19 holdEffectParam
 *   20 description*  24 importance     25 registrability
 *   26 pocket        27 type
 *   28 fieldUseFunc* 32 battleUsage    (33-35 pad)
 *   36 battleUseFunc* 40 secondaryId   (41-43 pad)
 *
 * Discovery is structural and deliberately NOT name-based: entry i
 * stores its own index in `itemId`, so the table is self-referencing and
 * a long run of `u16(base + i*44 + 14) === i` identifies it no matter
 * how many items the user has renamed. (The old MASTER BALL/ULTRA BALL
 * name anchor still runs as an independent cross-check, but it cannot be
 * the primary — this editor makes those names editable.)
 *
 * Unused slots are real table members: name "????????", itemId 0, all
 * sharing one placeholder description pointer. They are kept in the run
 * so the indices after them stay aligned.
 *
 * Pocket numbering genuinely differs between the two families
 * (pokeemerald include/constants/item.h vs pokefirered
 * include/constants/global.h), so the labels are chosen per game.
 */
import type { Rom } from '../rom'
import type { EntryHandle, FieldSpec, FieldValue, SelectOption } from '../games/schema'
import { gen3Codec, gen3DecodeText, gen3EncodeText } from '../text'
import { findFreeSpaceAtEnd, readGbaPointer, writeGbaPointer } from '../freespace'

export const ITEM_ENTRY = 44
const NAME_LEN = 14
/** Long enough that no unrelated data fakes it; short enough for hacks. */
const MIN_RUN = 100

const OFF = {
  name: 0,
  itemId: 14,
  price: 16,
  holdEffect: 18,
  holdEffectParam: 19,
  description: 20,
  importance: 24,
  pocket: 26,
  type: 27,
  battleUsage: 32,
  secondaryId: 40,
} as const

const RSE_POCKETS: SelectOption[] = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Items' },
  { value: 2, label: 'Poké Balls' },
  { value: 3, label: 'TMs & HMs' },
  { value: 4, label: 'Berries' },
  { value: 5, label: 'Key Items' },
]
const FRLG_POCKETS: SelectOption[] = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Items' },
  { value: 2, label: 'Key Items' },
  { value: 3, label: 'Poké Balls' },
  { value: 4, label: 'TM Case' },
  { value: 5, label: 'Berry Pouch' },
]

/** Length of the self-referencing `itemId === index` run starting at p. */
function runLength(bytes: Uint8Array, p: number, cap: number): number {
  let i = 0
  while (i < cap) {
    const o = p + i * ITEM_ENTRY
    if (o + ITEM_ENTRY > bytes.length) break
    const id = bytes[o + OFF.itemId] | (bytes[o + OFF.itemId + 1] << 8)
    const desc = readGbaPointer(bytes, o + OFF.description)
    // Placeholder slots carry itemId 0 but are still part of the table.
    if (id !== i && !(id === 0 && i > 0)) break
    if (desc === null) break
    i++
  }
  return i
}

function findItemTable(bytes: Uint8Array): { offset: number; count: number } | null {
  let best: { offset: number; count: number } | null = null
  for (let p = 0; p + ITEM_ENTRY * 4 < bytes.length; p += 4) {
    // Cheap gate first: entries 1-3 must state indices 1, 2, 3.
    if ((bytes[p + ITEM_ENTRY + OFF.itemId] | (bytes[p + ITEM_ENTRY + OFF.itemId + 1] << 8)) !== 1) continue
    if ((bytes[p + ITEM_ENTRY * 2 + OFF.itemId] | (bytes[p + ITEM_ENTRY * 2 + OFF.itemId + 1] << 8)) !== 2) continue
    if ((bytes[p + ITEM_ENTRY * 3 + OFF.itemId] | (bytes[p + ITEM_ENTRY * 3 + OFF.itemId + 1] << 8)) !== 3) continue
    const count = runLength(bytes, p, 2000)
    if (count >= MIN_RUN && (!best || count > best.count)) best = { offset: p, count }
  }
  return best
}

export interface ItemModule {
  entries: EntryHandle[]
  fields: FieldSpec[]
  nameLength: number
  read(id: number): Record<string, FieldValue>
  write(id: number, key: string, value: FieldValue): void
  setName(id: number, name: string): boolean
  /** Description text, with the game's line breaks as "\n". */
  description(id: number): string
  /**
   * Rewrite the description. Writes in place only when it fits AND the
   * string is this item's alone; otherwise relocates and retargets.
   */
  setDescription(id: number, text: string): boolean
  revert(id: number): void
}

export function buildGen3Items(
  rom: Rom,
  gameCode: string,
): { module: ItemModule; offset: number; count: number } | null {
  const bytes = rom.bytes
  const found = findItemTable(bytes)
  if (!found) return null
  const { offset: base, count } = found

  const isRse = gameCode.startsWith('AX') || gameCode.startsWith('BPE')
  const pockets = isRse ? RSE_POCKETS : FRLG_POCKETS

  const entryAt = (id: number) => base + id * ITEM_ENTRY
  const nameOf = (id: number) => gen3Codec.decode(bytes.subarray(entryAt(id), entryAt(id) + NAME_LEN))

  const entries: EntryHandle[] = []
  const refreshHandle = (id: number) => {
    const name = nameOf(id) || `Item #${id}`
    entries[id] = { id, label: `#${String(id).padStart(3, '0')} ${name}`, name }
  }
  for (let i = 0; i < count; i++) refreshHandle(i)

  const fields: FieldSpec[] = [
    { key: 'price', label: 'Price', kind: 'number', min: 0, max: 65535, group: 'shop' },
    {
      key: 'holdEffect',
      label: 'Hold effect',
      kind: 'number',
      min: 0,
      max: 255,
      group: 'battle',
      help: 'Hold effect id — see the decomp constants for what each does.',
    },
    { key: 'holdEffectParam', label: 'Hold effect value', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'pocket', label: 'Pocket', kind: 'select', options: pockets, group: 'bag' },
    {
      key: 'importance',
      label: 'Importance',
      kind: 'select',
      options: [
        { value: 0, label: 'Normal (can be tossed)' },
        { value: 1, label: 'Key item' },
        { value: 2, label: 'HM / unsellable' },
      ],
      group: 'bag',
    },
    { key: 'type', label: 'Type / sub-index', kind: 'number', min: 0, max: 255, group: 'bag' },
    {
      key: 'battleUsage',
      label: 'Battle usage',
      kind: 'select',
      options: [
        { value: 0, label: 'Not usable in battle' },
        { value: 1, label: 'On your Pokémon' },
        { value: 2, label: 'On the opponent (balls)' },
        { value: 3, label: 'Other' },
      ],
      group: 'battle',
    },
    { key: 'secondaryId', label: 'Secondary id', kind: 'number', min: 0, max: 255, group: 'bag' },
  ]

  const read = (id: number): Record<string, FieldValue> => {
    const o = entryAt(id)
    return {
      price: rom.readU16LE(o + OFF.price),
      holdEffect: bytes[o + OFF.holdEffect],
      holdEffectParam: bytes[o + OFF.holdEffectParam],
      pocket: bytes[o + OFF.pocket],
      importance: bytes[o + OFF.importance],
      type: bytes[o + OFF.type],
      battleUsage: bytes[o + OFF.battleUsage],
      secondaryId: bytes[o + OFF.secondaryId],
    }
  }

  const write = (id: number, key: string, value: FieldValue): void => {
    if (typeof value !== 'number' || id < 0 || id >= count) return
    const o = entryAt(id)
    if (key === 'price') rom.writeU16LE(o + OFF.price, Math.max(0, Math.min(65535, value)))
    else if (key in OFF) rom.writeU8(o + (OFF as Record<string, number>)[key], value & 0xff)
  }

  const setName = (id: number, name: string): boolean => {
    if (id < 0 || id >= count) return false
    const encoded = gen3Codec.encode(name.toUpperCase(), NAME_LEN - 1)
    if (!encoded || name.length === 0) return false
    rom.writeBytes(entryAt(id), [...encoded, 0xff].slice(0, NAME_LEN))
    refreshHandle(id)
    return true
  }

  const descriptionAt = (id: number): { at: number; length: number } | null => {
    const at = readGbaPointer(bytes, entryAt(id) + OFF.description)
    if (at === null) return null
    let end = at
    while (end < bytes.length && bytes[end] !== 0xff) end++
    return { at, length: end - at } // excluding the terminator
  }

  const description = (id: number): string => {
    const d = descriptionAt(id)
    return d ? gen3DecodeText(bytes.subarray(d.at, d.at + d.length)) : ''
  }

  /** True when another item points at the same string. */
  const isShared = (id: number, at: number): boolean => {
    for (let i = 0; i < count; i++) {
      if (i === id) continue
      if (readGbaPointer(bytes, entryAt(i) + OFF.description) === at) return true
    }
    return false
  }

  const setDescription = (id: number, text: string): boolean => {
    if (id < 0 || id >= count) return false
    const d = descriptionAt(id)
    if (!d) return false
    const encoded = gen3EncodeText(text)
    if (!encoded) return false
    const data = Uint8Array.from([...encoded, 0xff])
    // Unused item slots all share one placeholder string, and the
    // composite POKéBLOCK glyphs re-encode longer than they decoded, so
    // both cases route through relocation instead of clobbering a
    // neighbour's text or overrunning the original.
    if (data.length <= d.length + 1 && !isShared(id, d.at)) {
      rom.writeBytes(d.at, data)
      return true
    }
    const dest = findFreeSpaceAtEnd(bytes, data.length)
    if (dest === null) return false
    rom.writeBytes(dest, data)
    writeGbaPointer(rom, entryAt(id) + OFF.description, dest)
    return true
  }

  const revert = (id: number): void => {
    if (id < 0 || id >= count) return
    rom.revertRange(entryAt(id), ITEM_ENTRY)
    refreshHandle(id)
  }

  return {
    module: {
      entries,
      fields,
      nameLength: NAME_LEN - 1,
      read,
      write,
      setName,
      description,
      setDescription,
      revert,
    },
    offset: base,
    count,
  }
}
