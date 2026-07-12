/**
 * Gen 1/2 type effectiveness chart.
 *
 * Format (pokered TypeEffects / pokecrystal TypeMatchups, verified
 * against data/types/type_matchups.asm in both): 3-byte entries
 * {attacker, defender, damage×10 ∈ {0, 5, 20}}, terminated by 0xFF.
 * Gen 2 inserts a 0xFE separator before the two Foresight entries
 * (the Ghost immunities Foresight bypasses); they're exposed like any
 * other matchup and the separator is preserved.
 *
 * The chart is referenced from engine code, so it can't relocate.
 * setMultiplier is a 1-byte in-place write; removeEntry shifts the
 * tail up and zero-fills; addEntry grows into zero bytes directly
 * after the terminator (freed by earlier removals) and fails cleanly
 * when there are none.
 */
import type { Rom } from '../rom'
import type { TypeChartEntry, TypeChartModule } from '../games/schema'

const MULTS = new Set([0, 5, 20])

export function buildGbTypeChart(
  rom: Rom,
  maxType: number,
): { module: TypeChartModule; tableOff: number } | null {
  const bytes = rom.bytes

  const runAt = (o: number): { count: number; end: number } | null => {
    let p = o
    let count = 0
    let seenSep = false
    while (p + 3 <= bytes.length && count < 200) {
      const b = bytes[p]
      if (b === 0xff) return { count, end: p }
      if (b === 0xfe && !seenSep) {
        seenSep = true
        p += 1
        continue
      }
      const def = bytes[p + 1]
      const eff = bytes[p + 2]
      if (b > maxType || def > maxType || !MULTS.has(eff)) return null
      // All-zero triplets ("Normal deals 0× to Normal") never occur in
      // a real chart but zero-filled regions are full of them.
      if (b === 0 && def === 0 && eff === 0) return null
      count++
      p += 3
    }
    return null
  }

  // Discovery: a long triplet run with real structural variety (many
  // distinct attackers, both super- and not-very-effective entries) —
  // no per-version offsets, no single content anchor.
  let tableOff = -1
  for (let o = 0; o + 60 * 3 <= bytes.length; o++) {
    const run = runAt(o)
    if (!run || run.count < 60) continue
    const attackers = new Set<number>()
    let se = 0
    let nve = 0
    let p = o
    while (p < run.end) {
      if (bytes[p] === 0xfe) {
        p += 1
        continue
      }
      attackers.add(bytes[p])
      if (bytes[p + 2] === 20) se++
      if (bytes[p + 2] === 5) nve++
      p += 3
    }
    if (attackers.size >= 8 && se >= 10 && nve >= 10) {
      tableOff = o
      break
    }
  }
  if (tableOff < 0) return null

  const parse = (): { entries: TypeChartEntry[]; end: number } => {
    const entries: TypeChartEntry[] = []
    let p = tableOff
    while (bytes[p] !== 0xff) {
      if (bytes[p] === 0xfe) {
        p += 1
        continue
      }
      entries.push({ attacker: bytes[p], defender: bytes[p + 1], multiplier: bytes[p + 2], offset: p })
      p += 3
    }
    return { entries, end: p }
  }

  const module: TypeChartModule = {
    entries: () => parse().entries,
    setMultiplier(index, multiplier) {
      const { entries } = parse()
      const e = entries[index]
      if (e && MULTS.has(multiplier)) rom.writeU8(e.offset + 2, multiplier)
    },
    addEntry(attacker, defender, multiplier) {
      if (!MULTS.has(multiplier) || attacker > maxType || defender > maxType) return false
      const { end } = parse()
      // Only grow into zero slack directly after the terminator
      // (left behind by earlier removals) — the chart can't relocate.
      if (bytes[end + 1] !== 0 || bytes[end + 2] !== 0 || bytes[end + 3] !== 0) return false
      // Insert at the front so the new entry lands in the main section
      // (before any Gen 2 Foresight separator).
      for (let p = end + 3; p >= tableOff + 3; p--) rom.writeU8(p, bytes[p - 3])
      rom.writeU8(tableOff, attacker)
      rom.writeU8(tableOff + 1, defender)
      rom.writeU8(tableOff + 2, multiplier)
      return true
    },
    removeEntry(index) {
      const { entries, end } = parse()
      const e = entries[index]
      if (!e) return false
      // Shift everything (incl. separator + terminator) up 3 bytes;
      // the 0xFF lands at end-3. Zero the freed tail for addEntry.
      for (let p = e.offset; p <= end - 3; p++) rom.writeU8(p, bytes[p + 3])
      for (let p = end - 2; p <= end; p++) rom.writeU8(p, 0)
      return true
    },
  }
  return { module, tableOff }
}
