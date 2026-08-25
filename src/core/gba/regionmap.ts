/**
 * `gRegionMapEntries` — the names behind map sections.
 *
 * A Gen 3 map header carries a `regionMapSectionId` at +0x14, and that
 * byte indexes this table:
 *
 *   struct RegionMapLocation { u8 x, y, width, height; const u8 *name; }
 *
 * which is where "Viridian City" actually lives. Without it the map list
 * can only show `bank.map` numbers, which is how this editor shipped
 * until now. The layout is identical in vanilla Gen 3 and in
 * pokeemerald-expansion, so both adapters get names from this.
 *
 * Discovery is structural: the table is a long run of 8-byte entries
 * whose first four bytes are small region-map grid coordinates and whose
 * pointer resolves to short, printable text. A name anchor would be
 * wrong here — hacks rename and re-region their maps constantly, which
 * is the whole point of a hack.
 */
import { readGbaPointer } from '../freespace'
import { gen3DecodeText } from '../text'

const ENTRY = 8
/** The region map is a 32x16-ish grid; nothing legitimately exceeds this. */
const MAX_COORD = 64
const MIN_RUN = 40
const MAX_ENTRIES = 512
const MAX_NAME = 24

export interface RegionMap {
  offset: number
  count: number
  /** Section id → display name; empty string when unnamed. */
  name(section: number): string
}

/**
 * A structurally valid entry: small grid coordinates and a pointer to
 * 0xFF-terminated text. Deliberately loose about the text itself —
 * real tables contain blank sections (Emerald has an empty slot at 87)
 * and names with glyphs this codec renders as '?', so demanding clean
 * names everywhere truncates the table mid-way. Name QUALITY is scored
 * across the whole run instead, below.
 */
function entryLooksValid(bytes: Uint8Array, off: number): boolean {
  if (off < 0 || off + ENTRY > bytes.length) return false
  // Four cheap byte tests before the pointer dereference; this runs at
  // every 4-aligned offset of the ROM.
  if (bytes[off] > MAX_COORD || bytes[off + 1] > MAX_COORD) return false
  if (bytes[off + 2] > MAX_COORD || bytes[off + 3] > MAX_COORD) return false
  const p = readGbaPointer(bytes, off + 4)
  if (p === null) return false
  const end = Math.min(p + MAX_NAME + 1, bytes.length)
  for (let i = p; i < end; i++) if (bytes[i] === 0xff) return true
  return false
}

/** The decoded name, or '' when blank/unprintable. */
function nameAt(bytes: Uint8Array, off: number): string {
  const term = bytes.subarray(off, Math.min(off + MAX_NAME + 1, bytes.length)).indexOf(0xff)
  if (term < 1) return ''
  return gen3DecodeText(bytes.subarray(off, off + term))
}

function cleanNameFraction(bytes: Uint8Array, offset: number, count: number): number {
  let clean = 0
  for (let i = 0; i < count; i++) {
    const p = readGbaPointer(bytes, offset + i * ENTRY + 4)
    if (p === null) continue
    const text = nameAt(bytes, p)
    if (text.length >= 3 && !/\?/.test(text)) clean++
  }
  return clean / count
}

export function findRegionMap(bytes: Uint8Array): RegionMap | null {
  let best: { offset: number; count: number } | null = null
  for (let o = 0; o + ENTRY * MIN_RUN <= bytes.length; o += 4) {
    if (!entryLooksValid(bytes, o)) continue
    // Only consider MAXIMAL runs, so the skip below can't step over a
    // longer run that starts inside this one.
    if (entryLooksValid(bytes, o - ENTRY)) continue
    let count = 0
    while (count < MAX_ENTRIES && entryLooksValid(bytes, o + count * ENTRY)) count++
    if (count >= MIN_RUN && cleanNameFraction(bytes, o, count) >= 0.8) {
      if (best === null || count > best.count) best = { offset: o, count }
    }
    if (count > 1) o += (count - 1) * ENTRY
  }
  if (best === null) return null
  const { offset, count } = best
  const cache = new Map<number, string>()
  return {
    offset,
    count,
    name(section) {
      if (section < 0 || section >= count) return ''
      const hit = cache.get(section)
      if (hit !== undefined) return hit
      const p = readGbaPointer(bytes, offset + section * ENTRY + 4)
      const text = p === null ? '' : nameAt(bytes, p)
      cache.set(section, text)
      return text
    },
  }
}
