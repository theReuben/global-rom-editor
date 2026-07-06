/**
 * Decomp project backend — first vertical slice.
 *
 * Parses and edits the species data file of a pret decompilation source
 * tree (pokeemerald `src/data/pokemon/species_info.h`, pokefirered
 * `src/data/pokemon/base_stats.h` — same shape):
 *
 *   [SPECIES_BULBASAUR] =
 *   {
 *       .baseHP        = 45,
 *       ...
 *   },
 *
 * Edits are applied as minimal text substitutions so the file keeps its
 * formatting, comments and macros — diffs stay reviewable.
 */

export interface DecompSpecies {
  species: string
  /** Character range of the block body in the source text. */
  start: number
  end: number
  fields: Map<string, string>
}

export const NUMERIC_FIELDS: { key: string; label: string; max: number }[] = [
  { key: 'baseHP', label: 'HP', max: 255 },
  { key: 'baseAttack', label: 'Attack', max: 255 },
  { key: 'baseDefense', label: 'Defense', max: 255 },
  { key: 'baseSpeed', label: 'Speed', max: 255 },
  { key: 'baseSpAttack', label: 'Sp. Attack', max: 255 },
  { key: 'baseSpDefense', label: 'Sp. Defense', max: 255 },
  { key: 'catchRate', label: 'Catch rate', max: 255 },
  { key: 'expYield', label: 'Base EXP yield', max: 65535 },
  { key: 'eggCycles', label: 'Egg cycles', max: 255 },
  { key: 'friendship', label: 'Base friendship', max: 255 },
]

/** Fields shown read-only (constant expressions, edited as text later). */
export const INFO_FIELDS = ['types', 'abilities', 'growthRate', 'genderRatio', 'eggGroups', 'itemCommon', 'itemRare']

export function parseSpeciesInfo(text: string): DecompSpecies[] {
  const out: DecompSpecies[] = []
  const re = /\[SPECIES_([A-Z0-9_]+)\]\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let i = re.lastIndex
    while (i < text.length && text[i] !== '{' && text[i] !== ',') i++
    if (text[i] !== '{') continue // e.g. `[SPECIES_NONE] = {0},` handled below too
    // Match braces (blocks nest: .types = { ... }).
    const start = i + 1
    let depth = 1
    i++
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
      i++
    }
    const end = i - 1
    const body = text.slice(start, end)
    const fields = new Map<string, string>()
    const fieldRe = /\.([A-Za-z_0-9]+)\s*=\s*([^,\n]+(?:\{[^}]*\})?[^,\n]*)/g
    let f: RegExpExecArray | null
    while ((f = fieldRe.exec(body)) !== null) {
      fields.set(f[1], f[2].trim().replace(/\\$/, '').trim())
    }
    if (fields.size > 0) out.push({ species: m[1], start, end, fields })
  }
  return out
}

/** Return the numeric value of a field, or null if it isn't a number. */
export function numericValue(entry: DecompSpecies, key: string): number | null {
  const raw = entry.fields.get(key)
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Set a numeric field inside one species block, preserving all
 * formatting. Returns the updated file text, or null if the field
 * wasn't found.
 */
export function setNumericField(
  text: string,
  entry: DecompSpecies,
  key: string,
  value: number,
): string | null {
  const body = text.slice(entry.start, entry.end)
  const re = new RegExp(`(\\.${key}\\s*=\\s*)(\\d+)`)
  if (!re.test(body)) return null
  const newBody = body.replace(re, `$1${Math.round(value)}`)
  return text.slice(0, entry.start) + newBody + text.slice(entry.end)
}

export function prettySpeciesName(species: string): string {
  return species
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
}
