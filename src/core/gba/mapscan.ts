/**
 * Structural discovery of Gen 3 map data.
 *
 * Map data can't be found with content signatures the way Pokémon stats
 * can — it's a web of pointers that differs per version. Instead we
 * discover it structurally, bottom-up, validating each level against the
 * one below:
 *
 *   1. tileset headers  — recognisable shape (flags + 3-5 ROM pointers)
 *   2. map layouts      — sane width/height + pointers to *verified* tilesets
 *   3. map headers      — pointer to a *verified* layout + a consistent
 *                         event header behind the event pointer
 *   4. map groups       — contiguous runs of pointers to *verified* headers
 *   5. the bank table   — the longest run of pointers into those groups
 *
 * Nothing is trusted until the whole chain validates, which is also why
 * this works on ROM hacks: hacks move the data, not its structure.
 */
import { readGbaPointer } from '../freespace'

export interface Gen3MapIndex {
  bankTableOffset: number
  /** banks[bank][map] = map header offset. */
  banks: number[][]
  tilesetOffsets: Set<number>
  layoutOffsets: Set<number>
}

const MAX_MAP_DIM = 0x200
const MAX_EVENT_COUNT = 200
const MAX_BANKS = 64
const MAX_TOTAL_MAPS = 1500

function u32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

function ptrOrZero(bytes: Uint8Array, off: number): boolean {
  return u32(bytes, off) === 0 || readGbaPointer(bytes, off) !== null
}

export interface ScanOptions {
  /**
   * Accept a compressed tileset whose graphics do not start with the
   * LZ77 magic byte. pokeemerald-expansion can build its graphics with
   * its own `smol` codec instead, which this editor cannot decode — but
   * the map *index* is still worth discovering, because the wild
   * encounter table is uncompressed and cross-checks against it.
   * Callers that set this must not try to RENDER the tilesets.
   */
  anyGraphicsCodec?: boolean
}

/** Step 1: everything shaped like a tileset header. Deliberately loose —
 *  false positives are pruned when layouts must point at them exactly. */
export function scanTilesetHeaders(bytes: Uint8Array, opts: ScanOptions = {}): Set<number> {
  const out = new Set<number>()
  for (let o = 0; o + 24 <= bytes.length; o += 4) {
    if (bytes[o] > 1 || bytes[o + 1] > 1 || bytes[o + 2] !== 0 || bytes[o + 3] !== 0) continue
    const gfx = readGbaPointer(bytes, o + 4)
    if (gfx === null) continue
    if (readGbaPointer(bytes, o + 8) === null) continue
    if (readGbaPointer(bytes, o + 12) === null) continue
    if (!ptrOrZero(bytes, o + 16) || !ptrOrZero(bytes, o + 20)) continue
    // Compressed ⇒ LZ77 magic, unless the ROM uses another codec.
    if (!opts.anyGraphicsCodec && bytes[o] === 1 && bytes[gfx] !== 0x10) continue
    out.add(o)
  }
  return out
}

/** Step 2: map layouts — dimensions + border/blockdata pointers + two
 *  pointers into the verified tileset set. */
export function scanLayouts(bytes: Uint8Array, tilesets: Set<number>): Set<number> {
  const out = new Set<number>()
  for (let o = 0; o + 24 <= bytes.length; o += 4) {
    const w = u32(bytes, o)
    const h = u32(bytes, o + 4)
    if (w === 0 || h === 0 || w > MAX_MAP_DIM || h > MAX_MAP_DIM) continue
    if (readGbaPointer(bytes, o + 8) === null) continue
    const blocks = readGbaPointer(bytes, o + 12)
    if (blocks === null || blocks + w * h * 2 > bytes.length) continue
    const ts1 = readGbaPointer(bytes, o + 16)
    const ts2 = readGbaPointer(bytes, o + 20)
    if (ts1 === null || ts2 === null || !tilesets.has(ts1) || !tilesets.has(ts2)) continue
    out.add(o)
  }
  return out
}

function validEventHeader(bytes: Uint8Array, off: number): boolean {
  if (off + 20 > bytes.length) return false
  for (let k = 0; k < 4; k++) {
    const count = bytes[off + k]
    if (count > MAX_EVENT_COUNT) return false
    const p = off + 4 + k * 4
    if (count > 0 && readGbaPointer(bytes, p) === null) return false
    if (!ptrOrZero(bytes, p)) return false
  }
  return true
}

/** Step 3: map headers — layout pointer + consistent event data. */
export function scanMapHeaders(bytes: Uint8Array, layouts: Set<number>): Set<number> {
  const out = new Set<number>()
  for (let o = 0; o + 28 <= bytes.length; o += 4) {
    const layout = readGbaPointer(bytes, o)
    if (layout === null || !layouts.has(layout)) continue
    const events = readGbaPointer(bytes, o + 4)
    if (events === null || !validEventHeader(bytes, events)) continue
    if (!ptrOrZero(bytes, o + 8) || !ptrOrZero(bytes, o + 12)) continue
    out.add(o)
  }
  return out
}

interface Run {
  start: number
  positions: number[]
}

/** Coalesce sorted 4-aligned positions into contiguous runs. */
function coalesce(positions: number[]): Run[] {
  const runs: Run[] = []
  let current: Run | null = null
  for (const p of positions) {
    if (current && p === current.positions[current.positions.length - 1] + 4) {
      current.positions.push(p)
    } else {
      current = { start: p, positions: [p] }
      runs.push(current)
    }
  }
  return runs
}

/** Steps 4 + 5: group runs, then the bank table pointing into them. */
export function scanBankTable(bytes: Uint8Array, headers: Set<number>): Gen3MapIndex | null {
  // Positions holding a pointer to a verified map header.
  const memberPositions: number[] = []
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    const t = readGbaPointer(bytes, o)
    if (t !== null && headers.has(t)) memberPositions.push(o)
  }
  const groupRuns = coalesce(memberPositions)
  const memberRun = new Map<number, Run>()
  for (const run of groupRuns) for (const p of run.positions) memberRun.set(p, run)

  // Positions holding a pointer to a group-run member (i.e. bank entries).
  const bankPositions: number[] = []
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    const t = readGbaPointer(bytes, o)
    if (t !== null && memberRun.has(t)) bankPositions.push(o)
  }
  const bankRuns = coalesce(bankPositions).filter((r) => r.positions.length >= 2)
  if (bankRuns.length === 0) return null
  bankRuns.sort((a, b) => b.positions.length - a.positions.length)
  const bankRun = bankRuns[0]
  if (bankRun.positions.length > MAX_BANKS) return null

  // Each bank's group spans from its start to the next bank start
  // within the same run (groups are laid out back-to-back).
  const bankStarts = bankRun.positions.map((p) => readGbaPointer(bytes, p)!)
  const startSet = new Set(bankStarts)
  const banks: number[][] = []
  let total = 0
  for (const start of bankStarts) {
    const run = memberRun.get(start)!
    const maps: number[] = []
    for (let p = start; memberRun.get(p) === run; p += 4) {
      if (p !== start && startSet.has(p)) break
      maps.push(readGbaPointer(bytes, p)!)
      total++
      if (total > MAX_TOTAL_MAPS) return null
    }
    banks.push(maps)
  }
  return { bankTableOffset: bankRun.start, banks, tilesetOffsets: new Set(), layoutOffsets: new Set() }
}

/** Run the full bottom-up discovery. */
export function discoverMaps(bytes: Uint8Array, opts: ScanOptions = {}): Gen3MapIndex | null {
  const tilesets = scanTilesetHeaders(bytes, opts)
  if (tilesets.size === 0) return null
  const layouts = scanLayouts(bytes, tilesets)
  if (layouts.size === 0) return null
  const headers = scanMapHeaders(bytes, layouts)
  if (headers.size === 0) return null
  const index = scanBankTable(bytes, headers)
  if (!index) return null
  index.tilesetOffsets = tilesets
  index.layoutOffsets = layouts
  return index
}
