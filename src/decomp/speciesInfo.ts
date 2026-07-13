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

/** Fields shown read-only (constant expressions we don't edit yet). */
export const INFO_FIELDS = ['genderRatio', 'bodyColor', 'safariZoneFleeRate']

/** Constant-expression fields edited as dropdowns. */
export interface ConstFieldSpec {
  key: string
  label: string
  /** Identifier prefix of the constants used in this field. */
  prefix: string
  /** Names for each slot when the field holds a list. */
  slotLabels: string[]
}

export const CONST_FIELDS: ConstFieldSpec[] = [
  { key: 'types', label: 'Types', prefix: 'TYPE_', slotLabels: ['Type 1', 'Type 2'] },
  { key: 'abilities', label: 'Abilities', prefix: 'ABILITY_', slotLabels: ['Ability 1', 'Ability 2', 'Hidden ability'] },
  { key: 'eggGroups', label: 'Egg groups', prefix: 'EGG_GROUP_', slotLabels: ['Egg group 1', 'Egg group 2'] },
  { key: 'growthRate', label: 'Level curve', prefix: 'GROWTH_', slotLabels: ['Level curve'] },
  { key: 'itemCommon', label: 'Wild held item (common)', prefix: 'ITEM_', slotLabels: ['Item'] },
  { key: 'itemRare', label: 'Wild held item (rare)', prefix: 'ITEM_', slotLabels: ['Item'] },
]

/** Constants with this prefix inside a raw field value, in order. */
export function constantsIn(raw: string, prefix: string): string[] {
  const out: string[] = []
  const re = /[A-Z][A-Z0-9_]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m[0].startsWith(prefix)) out.push(m[0])
  }
  return out
}

/**
 * Replace the slot-th `prefix…` constant of a field with a new
 * constant, preserving all surrounding formatting (macros, spacing,
 * comments). Returns the updated file text, or null if not found.
 */
export function setConstantField(
  text: string,
  entry: DecompSpecies,
  key: string,
  prefix: string,
  slot: number,
  value: string,
): string | null {
  if (!value.startsWith(prefix) || !/^[A-Z][A-Z0-9_]*$/.test(value)) return null
  const body = text.slice(entry.start, entry.end)
  const fieldRe = new RegExp(`(\\.${key}\\s*=\\s*)(${FIELD_VALUE_SRC})`)
  const m = fieldRe.exec(body)
  if (!m) return null
  const valOff = m.index + m[1].length
  const idRe = /[A-Z][A-Z0-9_]*/g
  let n = 0
  let id: RegExpExecArray | null
  while ((id = idRe.exec(m[2])) !== null) {
    if (!id[0].startsWith(prefix)) continue
    if (n === slot) {
      const abs = entry.start + valOff + id.index
      return text.slice(0, abs) + value + text.slice(abs + id[0].length)
    }
    n++
  }
  return null
}

/**
 * Collect `PREFIX…` constant names from a header, in definition order.
 * Handles both `#define TYPE_FIRE 10` (vanilla) and enum members
 * `TYPE_FIRE = 11,` (pokeemerald-expansion). Counters like TYPE_COUNT
 * are skipped.
 */
export function parseConstants(headerText: string, prefix: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (name.endsWith('_COUNT') || name.includes('_COUNT_') || seen.has(name)) return
    seen.add(name)
    out.push(name)
  }
  const defineRe = new RegExp(`^\\s*#define\\s+(${prefix}[A-Z0-9_]+)[\\s(]`, 'gm')
  const enumRe = new RegExp(`^\\s*(${prefix}[A-Z0-9_]+)(?:\\s*=\\s*[A-Za-z0-9_+\\- ]+)?\\s*,\\s*(?://.*)?$`, 'gm')
  let m: RegExpExecArray | null
  while ((m = defineRe.exec(headerText)) !== null) push(m[1])
  while ((m = enumRe.exec(headerText)) !== null) push(m[1])
  return out
}

/** "ABILITY_SOLAR_POWER" → "Solar Power" (prefix stripped). */
export function prettyConstant(name: string, prefix: string): string {
  return prettySpeciesName(name.startsWith(prefix) ? name.slice(prefix.length) : name)
}

// A field value: brace list, macro call, or a plain token — covers
// `{ TYPE_GRASS, TYPE_POISON }`, `MON_TYPES(TYPE_GRASS, TYPE_POISON)`,
// `PERCENT_FEMALE(87.5)` and simple numbers/constants.
const FIELD_VALUE_SRC = String.raw`\{[^}]*\}|[A-Za-z_0-9]+\([^)]*\)|[^,\n]+`

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
    const fieldRe = new RegExp(`\\.([A-Za-z_0-9]+)\\s*=\\s*(${FIELD_VALUE_SRC})`, 'g')
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
