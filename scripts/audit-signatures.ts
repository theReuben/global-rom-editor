/**
 * Signature uniqueness audit.
 *
 * Run against ROMs built from the pret decomps (see docs/HANDOFF.md
 * "Validation methodology"):
 *
 *   npx tsx scripts/audit-signatures.ts <rom> [<rom>...]
 *
 * Why this exists: a signature that is unique in tests/fixtures.ts can
 * still be AMBIGUOUS in a real ROM, and every test stays green while the
 * feature is silently disabled for real users. That is exactly what
 * happened to Gen 2 wild encounters — Sprout Tower 2F and 3F have
 * byte-identical tables, the single anchor matched twice, findVerified
 * requires exactly one survivor, and wild editing was dead on every real
 * Gold/Silver/Crystal.
 *
 * Reports, per ROM:
 *   AMBIGUOUS  a signature matched more than once and nothing resolved
 *              it — the table is lost.
 *   TIGHT      a vote won with no margin: one edited anchor loses it.
 *
 * Misses are reported only in verbose mode: adapters are probed in turn,
 * so a Gen 1 ROM legitimately misses on the Gen 2 signatures. A
 * genuinely absent table shows up as an adapter warning instead.
 *
 * Exits non-zero if anything is flagged, so it can gate a release.
 * ROMs are never committed; pass paths to your own built copies.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { scanDiagnostics } from '../src/core/scan'

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error('usage: npx tsx scripts/audit-signatures.ts <rom> [<rom>...]')
  process.exit(2)
}

let flagged = 0
scanDiagnostics.enabled = true

for (const path of paths) {
  scanDiagnostics.records = []
  const bytes = new Uint8Array(readFileSync(path))
  const { adapter } = buildAdapter(new Rom(basename(path), bytes))
  console.log(`\n=== ${basename(path)} — ${adapter ? adapter.gameName : 'NO ADAPTER'} ===`)
  if (!adapter) {
    flagged++
    console.log('  FLAG: no adapter recognised this ROM')
    continue
  }
  for (const w of adapter.warnings) console.log(`  warning: ${w}`)

  for (const r of scanDiagnostics.records) {
    let status: string
    if (r.kind === 'verified') {
      if (r.candidates === 0) status = 'NO HIT'
      else if (r.result === null) status = 'AMBIGUOUS'
      else if (r.candidates > 1) status = `ok (${r.candidates} hits, check resolved it)`
      else status = 'ok (unique)'
    } else {
      if (r.result === null) status = 'NO HIT'
      else if (r.accepted <= r.required) status = 'TIGHT'
      else status = `ok (${r.accepted}/${r.candidates} anchors)`
    }
    // A miss is NOT a failure here: buildAdapter probes each adapter in
    // turn, so a Gen 1 ROM legitimately produces misses from the Gen 2
    // scan before Gen 1 claims it. A signature that is genuinely absent
    // already surfaces as an adapter warning, printed above. This audit
    // exists for ambiguity and vote margin.
    const bad = status === 'AMBIGUOUS' || status === 'TIGHT'
    if (bad) flagged++
    if (bad || process.env.AUDIT_VERBOSE) {
      console.log(`  ${bad ? 'FLAG: ' : ''}${status.padEnd(34)} ${r.kind} @ ${r.site}`)
    }
  }
  const shown = scanDiagnostics.records.length
  console.log(`  ${shown} signature lookups checked`)
}

scanDiagnostics.enabled = false
console.log(`\n${flagged === 0 ? 'PASS — no ambiguous or tight signatures' : `FAIL — ${flagged} flagged`}`)
process.exit(flagged === 0 ? 0 : 1)
