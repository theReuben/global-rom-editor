/**
 * Dev tool: load a real ROM through the adapter chain and dump what the
 * editor would show. Never run in CI (no ROMs in the repo).
 *   npx tsx scripts/probe-expansion.ts <rom>
 */
import { readFileSync } from 'node:fs'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'

const path = process.argv[2]
const rom = new Rom(path, new Uint8Array(readFileSync(path)))
console.time('buildAdapter')
const { adapter, reason } = buildAdapter(rom)
console.timeEnd('buildAdapter')
if (!adapter) {
  console.log('NO ADAPTER:', reason)
  process.exit(1)
}
console.log('game:', adapter.gameName, '| species:', adapter.species.length, '| moves:', adapter.moves.length)
console.log('regions:')
for (const r of adapter.regions) console.log('  ', r.name, '@', r.offset.toString(16), 'len', r.length)
console.log('warnings:')
for (const w of adapter.warnings) console.log('  -', w)
console.log('modules:', {
  map: !!adapter.mapModule, wild: !!adapter.wildModule, trainer: !!adapter.trainerModule,
  evo: !!adapter.evolutions, learn: !!adapter.learnsets, egg: !!adapter.eggMoves,
  sprite: !!adapter.speciesSprite, items: adapter.itemOptions?.length ?? 0,
})
const name = (id: number) => adapter.species[id - 1]?.name
for (const id of [1, 25, 133, adapter.species.length]) {
  console.log(`#${id} ${name(id)}`, adapter.readSpecies(id))
  console.log('   learnset', adapter.learnsets?.read(id).slice(0, 4))
  console.log('   evos', adapter.evolutions?.read(id))
  console.log('   egg', adapter.eggMoves?.read(id).slice(0, 4).map((m) => adapter.moves[m - 1]?.name))
  const img = adapter.speciesSprite?.(id)
  console.log('   sprite', img ? `${img.width}x${img.height}` : null, 'back', adapter.speciesSpriteBack?.(id) ? 'ok' : null)
}
for (const id of [1, 85, 94]) console.log('move', adapter.moves[id - 1]?.name, adapter.readMove(id))
console.log('types', adapter.typeOptions.map((t) => t.label).join(','))
