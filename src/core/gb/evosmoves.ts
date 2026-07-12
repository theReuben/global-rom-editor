/**
 * Gen 1/2 evolutions + level-up learnsets.
 *
 * Both generations share one layout (verified against pokered
 * data/pokemon/evos_moves.asm and pokecrystal/pokegold
 * data/pokemon/evos_attacks.asm): a table of bank-local u16 pointers
 * (internal order in Gen 1, dex order in Gen 2), each pointing at
 *   evolution entries…, 0, (level, move) pairs…, 0
 * Evolution entries:
 *   Gen 1: {EVOLVE_LEVEL=1, level, species}
 *          {EVOLVE_ITEM=2, item, minLevel(1), species}   ← 4 bytes
 *          {EVOLVE_TRADE=3, minLevel, species}
 *   Gen 2: {1, level, sp} {2, item, sp} {3, heldItem|0xFF, sp}
 *          {EVOLVE_HAPPINESS=4, when, sp}
 *          {EVOLVE_STAT=5, level, cmp, species}          ← 4 bytes
 *
 * The table is discovered structurally: the longest run of same-bank
 * pointers whose targets all parse as evo+learnset blobs, cross-checked
 * by requiring the parsed blobs to tile most of the region they span
 * (two independent patterns, per the project invariants).
 *
 * Edits re-emit the whole blob: in place when it fits, otherwise into
 * trailing free space of the same bank with the pointer retargeted.
 */
import type { Rom } from '../rom'
import type {
  EvolutionEntry,
  EvolutionModule,
  LearnsetEntry,
  LearnsetModule,
  SelectOption,
} from '../games/schema'
import { findGbBankFreeSpace } from '../freespace'

const GEN1_METHODS: SelectOption[] = [
  { value: 0, label: '— none —' },
  { value: 1, label: 'Level up' },
  { value: 2, label: 'Use item' },
  { value: 3, label: 'Trade' },
]
const GEN2_METHODS: SelectOption[] = [
  { value: 0, label: '— none —' },
  { value: 1, label: 'Level up' },
  { value: 2, label: 'Use item' },
  { value: 3, label: 'Trade (param: held item, 255 = none)' },
  { value: 4, label: 'Happiness (param: 1 any, 2 day, 3 night)' },
  { value: 5, label: 'Level, stat compare' },
]

interface ParsedEvo {
  method: number
  param: number
  /** Raw species byte (internal id in Gen 1, dex in Gen 2). */
  rawTarget: number
  /** Gen 2 EVOLVE_STAT comparison byte (ATK_LT/GT/EQ); -1 elsewhere. */
  extra: number
}

interface ParsedBlob {
  evos: ParsedEvo[]
  moves: LearnsetEntry[]
  /** Byte length of the blob including both terminators. */
  length: number
}

export function buildGbEvosMoves(
  rom: Rom,
  opts: {
    gen: 1 | 2
    /** Number of pointer-table entries (internal count / dex count). */
    entries: number
    /** dex → 1-based table index. */
    indexForDex: (dex: number) => number
    /** raw species byte in an evo entry → dex id (and back). */
    targetToDex: (raw: number) => number
    dexToTarget: (dex: number) => number
  },
): { evolutions: EvolutionModule; learnsets: LearnsetModule; tableOff: number } | null {
  const { gen } = opts
  const bytes = rom.bytes
  const maxMethod = gen === 1 ? 3 : 5
  const fourByte = (method: number) => (gen === 1 ? method === 2 : method === 5)

  const parseBlob = (buf: Uint8Array, off: number): ParsedBlob | null => {
    const evos: ParsedEvo[] = []
    let p = off
    while (p < buf.length) {
      const method = buf[p]
      if (method === 0) {
        p++
        break
      }
      if (method > maxMethod || evos.length >= 8) return null
      const size = fourByte(method) ? 4 : 3
      const target = buf[p + size - 1]
      if (target < 1 || target > opts.entries) return null
      evos.push({
        method,
        param: buf[p + 1],
        rawTarget: target,
        extra: size === 4 && gen === 2 ? buf[p + 2] : -1,
      })
      p += size
    }
    const moves: LearnsetEntry[] = []
    while (p < buf.length) {
      const level = buf[p]
      if (level === 0) {
        p++
        return { evos, moves, length: p - off }
      }
      if (level > 100 || buf[p + 1] === 0 || moves.length >= 30) return null
      moves.push({ level, move: buf[p + 1] })
      p += 2
    }
    return null
  }

  // Discovery: longest run of same-bank pointers with parseable
  // targets. Two passes, one per byte parity — skipping ahead by the
  // failed run's length is only sound for starts of the same parity
  // (an odd-aligned table inside an even-phase run would be jumped
  // over otherwise).
  let tableOff = -1
  let runLen = 0
  scan: for (let phase = 0; phase < 2 && tableOff < 0; phase++) {
    for (let o = phase; o + opts.entries * 2 <= bytes.length; o += 2) {
      const bank = Math.floor(o / 0x4000)
      let n = 0
      const seen = new Map<number, number>() // blob offset → length
      while (n < opts.entries + 66 && o + n * 2 + 2 <= bytes.length) {
        const v = rom.readU16LE(o + n * 2)
        if (v < 0x4000 || v >= 0x8000) break
        const target = bank * 0x4000 + v - 0x4000
        if (!seen.has(target)) {
          const blob = parseBlob(bytes, target)
          if (!blob) break
          seen.set(target, blob.length)
        }
        n++
      }
      if (n >= opts.entries) {
        // Independent cross-check: the referenced blobs must tile most
        // of the span they cover — random data that happens to parse
        // won't. The middle 90% is used so a few editor-relocated blobs
        // (moved to bank-end free space) don't blow up the span.
        const offs = [...seen.keys()].sort((a, b) => a - b)
        const from = Math.floor(offs.length * 0.05)
        const to = Math.ceil(offs.length * 0.95)
        const mid = offs.slice(from, to)
        const lo = mid[0]
        const hi = Math.max(...mid.map((s) => s + seen.get(s)!))
        const covered = mid.reduce((a, s) => a + seen.get(s)!, 0)
        if (hi > lo && covered >= (hi - lo) * 0.8) {
          tableOff = o
          runLen = n
          continue scan
        }
      }
      // Same-parity starts inside a failed run break at the same spot
      // and end up shorter — safe to skip past them.
      if (n > 0) o += n * 2 - 2
    }
  }
  if (tableOff < 0) return null
  const bank = Math.floor(tableOff / 0x4000)

  const slotFor = (dex: number) => {
    const idx = opts.indexForDex(dex)
    return idx >= 1 && idx <= runLen ? tableOff + (idx - 1) * 2 : -1
  }
  const blobOffFor = (buf: Uint8Array, slot: number) => {
    const v = buf[slot] | (buf[slot + 1] << 8)
    return bank * 0x4000 + v - 0x4000
  }
  const parseFor = (dex: number, buf: Uint8Array): { off: number; blob: ParsedBlob } | null => {
    const slot = slotFor(dex)
    if (slot < 0) return null
    const off = blobOffFor(buf, slot)
    const blob = parseBlob(buf, off)
    return blob ? { off, blob } : null
  }

  const emit = (evos: ParsedEvo[], moves: LearnsetEntry[]): number[] => {
    const out: number[] = []
    for (const e of evos) {
      if (e.method === 0) continue
      if (fourByte(e.method)) {
        out.push(e.method, e.param & 0xff, gen === 1 ? 1 : e.extra >= 0 ? e.extra : 1, e.rawTarget)
      } else {
        out.push(e.method, e.param & 0xff, e.rawTarget)
      }
    }
    out.push(0)
    for (const m of moves) out.push(m.level & 0xff, m.move & 0xff)
    out.push(0)
    return out
  }

  const rewrite = (dex: number, evos: ParsedEvo[], moves: LearnsetEntry[]): boolean => {
    const cur = parseFor(dex, bytes)
    if (!cur) return false
    const blob = emit(evos, moves)
    if (blob.length <= cur.blob.length) {
      rom.writeBytes(cur.off, blob)
      // Pad the freed tail with zeros so stale bytes can't re-parse.
      for (let i = blob.length; i < cur.blob.length; i++) rom.writeU8(cur.off + i, 0)
      return true
    }
    let dest = findGbBankFreeSpace(bytes, bank, blob.length)
    if (dest === null) return false
    // All-zero blobs ("no evos, no moves" is literally 00 00) look like
    // padding to the free-space scan — floor the destination past every
    // live blob and the pointer table itself.
    let maxEnd = tableOff + runLen * 2
    for (let i = 0; i < runLen; i++) {
      const off = blobOffFor(bytes, tableOff + i * 2)
      const b = parseBlob(bytes, off)
      if (b) maxEnd = Math.max(maxEnd, off + b.length)
    }
    if (dest < maxEnd) {
      dest = maxEnd
      if (dest + blob.length + 8 > (bank + 1) * 0x4000) return false
    }
    rom.writeBytes(dest, blob)
    rom.writeU16LE(slotFor(dex), (dest % 0x4000) + 0x4000)
    return true
  }

  const evolutions: EvolutionModule = {
    methods: gen === 1 ? GEN1_METHODS : GEN2_METHODS,
    read(dex): EvolutionEntry[] {
      const cur = parseFor(dex, bytes)
      const out: EvolutionEntry[] = (cur?.blob.evos ?? []).map((e) => ({
        method: e.method,
        param: e.param,
        target: opts.targetToDex(e.rawTarget),
      }))
      // One blank slot lets the UI append a new evolution.
      if (out.length < 8) out.push({ method: 0, param: 0, target: 0 })
      return out
    },
    write(dex, slot, field, value) {
      const cur = parseFor(dex, bytes)
      if (!cur) return
      const evos = cur.blob.evos
      if (slot === evos.length && field === 'method' && value > 0 && value <= maxMethod) {
        // Fill the blank slot: default to evolving into the next dex id.
        const target = opts.dexToTarget(Math.min(dex + 1, opts.entries)) || 1
        evos.push({ method: value, param: value === 1 || value === 5 ? 20 : 1, rawTarget: target, extra: 1 })
      } else if (slot >= 0 && slot < evos.length) {
        const e = evos[slot]
        if (field === 'method') {
          if (value === 0) evos.splice(slot, 1)
          else if (value <= maxMethod) e.method = value
        } else if (field === 'param') e.param = value & 0xff
        else if (field === 'target') {
          const raw = opts.dexToTarget(value)
          if (raw >= 1) e.rawTarget = raw
        }
      } else return
      rewrite(dex, evos, cur.blob.moves)
    },
    revert(dex) {
      const slot = slotFor(dex)
      if (slot < 0) return
      // Restore the pointer, then the original blob it pointed at.
      rom.revertRange(slot, 2)
      const orig = parseFor(dex, rom.original)
      if (orig) rom.revertRange(orig.off, orig.blob.length)
    },
  }

  const learnsets: LearnsetModule = {
    read(dex): LearnsetEntry[] {
      return parseFor(dex, bytes)?.blob.moves ?? []
    },
    write(dex, entries) {
      const cur = parseFor(dex, bytes)
      if (!cur) return false
      const clean = entries
        .filter((e) => e.level >= 1 && e.level <= 100 && e.move >= 1 && e.move <= 255)
        .slice(0, 30)
        .sort((a, b) => a.level - b.level)
      return rewrite(dex, cur.blob.evos, clean)
    },
  }

  return { evolutions, learnsets, tableOff }
}
