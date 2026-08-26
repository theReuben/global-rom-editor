/**
 * Checks that every form which transforms mid-battle can change back.
 *
 * A Mega, Primal, Ultra Burst or Gigantamax form is reached through its
 * base species' form-change table, and the same table carries the
 * entries that revert it - FORM_CHANGE_FAINT and FORM_CHANGE_END_BATTLE.
 * Leave those out and the transformation is permanent: the mon stays
 * Mega through fainting and past the end of the battle. Nothing catches
 * that until someone plays a battle to the end, which is exactly why it
 * is worth a script.
 *
 * Primal Reversion legitimately has no Faint entry - upstream reverts it
 * at end of battle only, matching the official games - so it is reported
 * separately rather than as a fault.
 *
 * Usage: npx tsx scripts/audit-form-changes.ts <rom.gba>
 */
import { readFileSync } from 'node:fs'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'

const FAINT = 5
const END_BATTLE = 7
const PRIMAL = 16
/** Methods that put a mon into a temporary battle form. */
const TRANSFORMS = new Set([14, 15, PRIMAL, 19, 20])

const path = process.argv[2]
if (!path) {
  console.error('usage: npx tsx scripts/audit-form-changes.ts <rom.gba>')
  process.exit(2)
}

const adapter = buildAdapter(new Rom(path, new Uint8Array(readFileSync(path)))).adapter
if (!adapter) {
  console.error('no adapter could be built for this ROM')
  process.exit(2)
}
if (!adapter.formChanges) {
  console.error('this game has no form-change data')
  process.exit(2)
}

const formChanges = adapter.formChanges
const name = (id: number) =>
  adapter.species.find((s) => s.id === id)?.label.replace(/^#\d+ /, '').trim() ?? `#${id}`

let checked = 0
const faults: string[] = []
const expected: string[] = []

for (const species of adapter.species) {
  const table = formChanges.read(species.id)
  const transforms = table.filter((e) => TRANSFORMS.has(e.method))
  if (transforms.length === 0) continue
  checked++

  const hasFaint = table.some((e) => e.method === FAINT)
  const hasEnd = table.some((e) => e.method === END_BATTLE)
  if (hasFaint && hasEnd) continue

  const kinds = transforms
    .map((e) => formChanges.methods.find((m) => m.value === e.method)?.label ?? `#${e.method}`)
    .join('/')
  const missing = [!hasFaint && 'Faint', !hasEnd && 'End battle'].filter(Boolean).join(' + ')
  const line = `${name(species.id).padEnd(28)} [${kinds}] missing ${missing}`

  // Primal without a Faint entry is upstream's own design, not a fault.
  const primalOnly = transforms.every((e) => e.method === PRIMAL)
  ;(primalOnly && hasEnd ? expected : faults).push(line)
}

console.log(`forms that transform in battle : ${checked}`)
console.log(`missing a revert path          : ${faults.length}`)
for (const f of faults) console.log(`   ${f}`)
if (expected.length) {
  console.log(`\nby design (Primal reverts at end of battle only): ${expected.length}`)
  for (const e of expected) console.log(`   ${e}`)
}
process.exit(faults.length ? 1 : 0)
