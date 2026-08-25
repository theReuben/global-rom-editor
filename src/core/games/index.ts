import { Rom } from '../rom'
import { readRomInfo } from '../detect'
import { parseNdsHeader, listNdsFiles } from '../nds/nds'
import { tryBuildGen45 } from './gen45'
import { tryBuildGen1 } from './gen1'
import { tryBuildGen2 } from './gen2'
import { tryBuildGen3 } from './gen3'
import { tryBuildGen3Expansion } from './gen3-expansion'
import type { GameAdapter } from './schema'

export type { GameAdapter } from './schema'

const KNOWN_TITLES: [RegExp, string][] = [
  [/POKEMON RED/, 'Pokémon Red'],
  [/POKEMON BLUE/, 'Pokémon Blue'],
  [/POKEMON YEL/, 'Pokémon Yellow'],
  [/GLD/, 'Pokémon Gold'],
  [/SLV|SILVER/, 'Pokémon Silver'],
  [/CRYSTAL/, 'Pokémon Crystal'],
  [/RUBY|AXVE/, 'Pokémon Ruby'],
  [/SAPP|AXPE/, 'Pokémon Sapphire'],
  [/EMER|BPEE/, 'Pokémon Emerald'],
  [/FIRE|BPRE/, 'Pokémon FireRed'],
  [/LEAF|BPGE/, 'Pokémon LeafGreen'],
]

export interface LoadResult {
  adapter: GameAdapter | null
  /** Set when the file is a valid ROM but no adapter matched. */
  reason?: string
}

export function buildAdapter(rom: Rom): LoadResult {
  const info = readRomInfo(rom.bytes)
  if (!info) {
    const nds = parseNdsHeader(rom.bytes)
    if (nds) {
      const dsAdapter = tryBuildGen45(rom)
      if (dsAdapter) return { adapter: dsAdapter }
      const files = listNdsFiles(rom.bytes, nds)
      return {
        adapter: null,
        reason:
          `Nintendo DS ROM detected ("${nds.title}", ${nds.gameCode}; ${files.length} files in its file system), ` +
          "but no Pokémon personal-data archive was found at the known paths — this game/hack isn't supported yet.",
      }
    }
    return { adapter: null, reason: 'This file does not look like a Game Boy / GBC / GBA ROM.' }
  }

  const headerId = `${info.title} ${info.gameCode}`.trim()
  let pretty = KNOWN_TITLES.find(([re]) => re.test(headerId))?.[1]
  const suffix = info.gameCode ? ` (${info.gameCode})` : ''
  const gameName = (pretty ?? info.title ?? 'Unknown game') + suffix

  const adapter =
    info.platform === 'GBA'
      ? // Vanilla Gen 3 first: it is the cheaper scan, and an expansion
        // ROM has none of its anchors. pokeemerald-expansion keeps the
        // same GBA header, so only the data layout tells them apart.
        (tryBuildGen3(rom, gameName, info.platform) ?? tryBuildGen3Expansion(rom, gameName, info.platform))
      : (tryBuildGen2(rom, gameName, info.platform) ?? tryBuildGen1(rom, gameName, info.platform))

  if (!adapter) {
    return {
      adapter: null,
      reason:
        `Detected a ${info.platform} ROM ("${headerId}"), but no Pokémon data tables were found. ` +
        'Supported games: Red, Blue, Yellow, Gold, Silver, Crystal, Ruby, Sapphire, Emerald, FireRed, LeafGreen ' +
        '(and hacks based on them, including pokeemerald-expansion).',
    }
  }
  return { adapter }
}
