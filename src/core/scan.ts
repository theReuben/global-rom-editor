/**
 * Signature scanning.
 *
 * Instead of trusting hardcoded per-version offsets (which break across
 * revisions, regions and already-hacked ROMs), we locate data tables by
 * searching for byte patterns that are intrinsic to the data itself —
 * e.g. Bulbasaur's well-known base stats, or "POUND" in the game's text
 * encoding. Callers then verify a second, independent pattern at the
 * expected relative position before trusting a match.
 */

/** Find all occurrences of `pattern` in `data`. -1 in the pattern = wildcard. */
export function findAll(data: Uint8Array, pattern: number[], limit = 8): number[] {
  const out: number[] = []
  const n = data.length - pattern.length
  outer: for (let i = 0; i <= n; i++) {
    for (let j = 0; j < pattern.length; j++) {
      const p = pattern[j]
      if (p >= 0 && data[i + j] !== p) continue outer
    }
    out.push(i)
    if (out.length >= limit) break
  }
  return out
}

/** True if `pattern` matches `data` at `off` (-1 = wildcard). */
export function matchesAt(data: Uint8Array, off: number, pattern: number[]): boolean {
  if (off < 0 || off + pattern.length > data.length) return false
  for (let j = 0; j < pattern.length; j++) {
    const p = pattern[j]
    if (p >= 0 && data[off + j] !== p) return false
  }
  return true
}

/**
 * Find the unique offset where `anchor` matches AND `check` matches at
 * `anchor + checkDelta`. Returns null when zero or multiple candidates
 * survive verification — a table we can't trust is a table we don't edit.
 */
export function findVerified(
  data: Uint8Array,
  anchor: number[],
  check: { delta: number; pattern: number[] }[],
): number | null {
  const candidates = findAll(data, anchor, 16)
  const verified = candidates.filter((off) =>
    check.every((c) => matchesAt(data, off + c.delta, c.pattern)),
  )
  return verified.length === 1 ? verified[0] : null
}

/**
 * Locate a fixed-stride table by anchor majority vote: each anchor hit
 * votes for `hit - index * stride` as the table base, and the base with
 * the most votes wins if it reaches `minVotes`. With anchors spread
 * across the table, editing any one anchor entry can't break discovery.
 */
export function findByVote(
  data: Uint8Array,
  anchors: { index: number; pattern: number[] }[],
  stride: number,
  minVotes = 2,
): number | null {
  const votes = new Map<number, number>()
  for (const a of anchors) {
    for (const hit of findAll(data, a.pattern, 8)) {
      const base = hit - a.index * stride
      if (base >= 0) votes.set(base, (votes.get(base) ?? 0) + 1)
    }
  }
  let best: number | null = null
  let bestVotes = 0
  for (const [base, v] of votes) {
    if (v > bestVotes) {
      best = base
      bestVotes = v
    }
  }
  return bestVotes >= minVotes ? best : null
}
