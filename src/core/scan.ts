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

export interface ScanRecord {
  kind: 'verified' | 'vote'
  /** Source location of the call, for reporting. */
  site: string
  patternLength: number
  /** findVerified: raw anchor hits. findByVote: anchors supplied. */
  candidates: number
  /** findVerified: hits that also passed their checks. findByVote: votes. */
  accepted: number
  /** Minimum `accepted` needed to return a result. */
  required: number
  result: number | null
}

/**
 * Dev-only diagnostics, off by default and free when off.
 *
 * A signature that is unique in the synthetic fixture can still be
 * AMBIGUOUS in a real ROM — that exact mismatch silently disabled Gen 2
 * wild encounter editing on every real Gold/Silver/Crystal (Sprout Tower
 * 2F and 3F have identical tables, so the single anchor matched twice
 * and resolved to nothing while the tests stayed green). Enable this and
 * run `npm run audit:signatures <rom>...` against built ROMs whenever a
 * signature is added or changed.
 */
export const scanDiagnostics: { enabled: boolean; records: ScanRecord[] } = {
  enabled: false,
  records: [],
}

function record(r: Omit<ScanRecord, 'site'>): void {
  if (!scanDiagnostics.enabled) return
  const site = (new Error().stack ?? '').split('\n')[3]?.trim() ?? '?'
  scanDiagnostics.records.push({ ...r, site: site.replace(/.*[/\\]src[/\\]/, 'src/').replace(/\)$/, '') })
}

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
  const result = verified.length === 1 ? verified[0] : null
  record({
    kind: 'verified',
    patternLength: anchor.length,
    candidates: candidates.length,
    accepted: verified.length,
    required: 1,
    result,
  })
  return result
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
  const result = bestVotes >= minVotes ? best : null
  record({
    kind: 'vote',
    patternLength: anchors.length,
    candidates: anchors.length,
    accepted: bestVotes,
    required: minVotes,
    result,
  })
  return result
}
