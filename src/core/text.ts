/**
 * Text codecs for the proprietary character encodings used by the games.
 *
 * Only the printable subset needed for names is mapped; unknown bytes
 * decode to '?' and characters we can't encode are rejected so we never
 * write garbage into a ROM.
 */

export interface TextCodec {
  /** Byte that terminates / pads strings. */
  terminator: number
  decode(bytes: Uint8Array): string
  /** Returns null if the string contains characters this game can't display. */
  encode(text: string, length: number): number[] | null
}

/**
 * `pairs` feed both directions (first mapping wins, so earlier entries
 * define the canonical encoding for a character). `decodeOnly` entries
 * never reach the encode map — that's for bytes whose glyph text
 * collides with a real character, e.g. Gen 3's 0x59 renders "K" as the
 * tail of POKéBLOCK but the letter K must still encode to 0xC5.
 */
function buildMaps(
  pairs: [number, string][],
  decodeOnly: [number, string][] = [],
): {
  dec: Map<number, string>
  enc: Map<string, number>
} {
  const dec = new Map<number, string>()
  const enc = new Map<string, number>()
  for (const [b, ch] of pairs) {
    if (!dec.has(b)) dec.set(b, ch)
    if (!enc.has(ch)) enc.set(ch, b)
  }
  for (const [b, ch] of decodeOnly) if (!dec.has(b)) dec.set(b, ch)
  return { dec, enc }
}

function range(startByte: number, startChar: string, count: number): [number, string][] {
  const out: [number, string][] = []
  const base = startChar.charCodeAt(0)
  for (let i = 0; i < count; i++) out.push([startByte + i, String.fromCharCode(base + i)])
  return out
}

/* ---------------------------------------------------------------- Gen 1/2 */

const GEN12_PAIRS: [number, string][] = [
  ...range(0x80, 'A', 26),
  ...range(0xa0, 'a', 26),
  ...range(0xf6, '0', 10),
  [0x7f, ' '],
  [0x9a, '('],
  [0x9b, ')'],
  [0x9c, ':'],
  [0x9d, ';'],
  [0x9e, '['],
  [0x9f, ']'],
  [0xe0, "'"],
  [0xe3, '-'],
  [0xe6, '?'],
  [0xe7, '!'],
  [0xe8, '.'],
  [0xf2, '.'],
  [0xf3, '/'],
  [0xf4, ','],
  [0xef, '♂'],
  [0xf5, '♀'],
  [0xba, 'é'],
  // Multi-character glyphs (decode-only; encode walks single characters).
  [0x4a, 'PKMN'],
  [0x54, 'POKé'],
]

const gen12Maps = buildMaps(GEN12_PAIRS)

export const gen12Codec: TextCodec = {
  terminator: 0x50,
  decode(bytes) {
    let out = ''
    for (const b of bytes) {
      if (b === 0x50) break
      out += gen12Maps.dec.get(b) ?? '?'
    }
    return out
  },
  encode(text, length) {
    const out: number[] = []
    for (const ch of text) {
      const b = gen12Maps.enc.get(ch) ?? gen12Maps.enc.get(ch.toUpperCase())
      if (b === undefined) return null
      out.push(b)
      if (out.length > length) return null
    }
    while (out.length < length) out.push(0x50)
    return out
  },
}

/* ------------------------------------------------------------------ Gen 3 */

const GEN3_PAIRS: [number, string][] = [
  ...range(0xbb, 'A', 26),
  ...range(0xd5, 'a', 26),
  ...range(0xa1, '0', 10),
  [0x00, ' '],
  [0xab, '!'],
  [0xac, '?'],
  [0xad, '.'],
  [0xae, '-'],
  [0xb4, "'"],
  [0xb5, '♂'],
  [0xb6, '♀'],
  [0xba, '/'],
  [0xb8, ','],
  [0x1b, 'é'],
  // Accented letters and punctuation, transcribed from pokeemerald
  // charmap.txt (the English section, above "@ Hiragana"). 0xFF is the
  // terminator, not a character, so '$' is deliberately absent.
  [0x01, 'À'], [0x02, 'Á'], [0x03, 'Â'], [0x04, 'Ç'], [0x05, 'È'],
  [0x06, 'É'], [0x07, 'Ê'], [0x08, 'Ë'], [0x09, 'Ì'], [0x0b, 'Î'],
  [0x0c, 'Ï'], [0x0d, 'Ò'], [0x0e, 'Ó'], [0x0f, 'Ô'], [0x10, 'Œ'],
  [0x11, 'Ù'], [0x12, 'Ú'], [0x13, 'Û'], [0x14, 'Ñ'], [0x15, 'ß'],
  [0x16, 'à'], [0x17, 'á'], [0x19, 'ç'], [0x1a, 'è'], [0x1c, 'ê'],
  [0x1d, 'ë'], [0x1e, 'ì'], [0x20, 'î'], [0x21, 'ï'], [0x22, 'ò'],
  [0x23, 'ó'], [0x24, 'ô'], [0x25, 'œ'], [0x26, 'ù'], [0x27, 'ú'],
  [0x28, 'û'], [0x29, 'ñ'], [0x2a, 'º'], [0x2b, 'ª'], [0x2d, '&'],
  [0x2e, '+'], [0x35, '='], [0x36, ';'], [0x51, '¿'], [0x52, '¡'],
  [0x5a, 'Í'], [0x5b, '%'], [0x5c, '('], [0x5d, ')'], [0x68, 'â'],
  [0x6f, 'í'], [0x85, '<'], [0x86, '>'], [0xaf, '·'], [0xb0, '…'],
  [0xb1, '“'], [0xb2, '”'], [0xb3, '‘'], [0xb7, '¥'], [0xb9, '×'],
  [0xef, '▶'], [0xf0, ':'], [0xf1, 'Ä'], [0xf2, 'Ö'], [0xf3, 'Ü'],
  [0xf4, 'ä'], [0xf5, 'ö'], [0xf6, 'ü'],
  // Composite glyphs: PK MN spell PKMN, PO Ké BL OC K spell POKéBLOCK
  // (charmap.txt: `PKMN = 53 54`, `POKEBLOCK = 55 56 57 58 59`).
  [0x53, 'PK'],
  [0x54, 'MN'],
  [0x55, 'PO'],
  [0x56, 'Ké'],
  // charmap.txt calls 0xB4 '’'; we decode it as a plain apostrophe
  // because that is what people type, and accept the curly one too.
  [0xb4, '’'],
]

/**
 * Bytes that must decode but never encode: 'K' and 'L'/'O' fragments
 * would otherwise steal the mappings for the real letters.
 */
const GEN3_DECODE_ONLY: [number, string][] = [
  [0x57, 'BL'],
  [0x58, 'OC'],
  [0x59, 'K'],
]

const gen3Maps = buildMaps(GEN3_PAIRS, GEN3_DECODE_ONLY)

/** The game's line break inside multi-line text (charmap: `'\n' = FE`). */
const GEN3_NEWLINE = 0xfe

/**
 * Decode a run of Gen 3 text that may contain line breaks (item and
 * move descriptions), as opposed to a fixed-width name field.
 */
export function gen3DecodeText(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    if (b === 0xff) break
    out += b === GEN3_NEWLINE ? '\n' : (gen3Maps.dec.get(b) ?? '?')
  }
  return out
}

/** Inverse of `gen3DecodeText`; null if any character can't be shown. */
export function gen3EncodeText(text: string): number[] | null {
  const out: number[] = []
  for (const ch of text) {
    if (ch === '\n') {
      out.push(GEN3_NEWLINE)
      continue
    }
    const b = gen3Maps.enc.get(ch) ?? gen3Maps.enc.get(ch.toUpperCase())
    if (b === undefined) return null
    out.push(b)
  }
  return out
}

export const gen3Codec: TextCodec = {
  terminator: 0xff,
  decode(bytes) {
    let out = ''
    for (const b of bytes) {
      if (b === 0xff) break
      out += gen3Maps.dec.get(b) ?? '?'
    }
    return out
  },
  encode(text, length) {
    const out: number[] = []
    for (const ch of text) {
      const b = gen3Maps.enc.get(ch) ?? gen3Maps.enc.get(ch.toUpperCase())
      if (b === undefined) return null
      out.push(b)
      if (out.length > length) return null
    }
    while (out.length < length) out.push(0xff)
    return out
  },
}

/** Encode an ASCII string with the Gen 1/2 charmap (for building signatures). */
export function gen12Bytes(text: string): number[] {
  const out = gen12Codec.encode(text, text.length)
  if (!out) throw new Error(`cannot encode: ${text}`)
  return out
}

/** Encode an ASCII string with the Gen 3 charmap (for building signatures). */
export function gen3Bytes(text: string): number[] {
  const out = gen3Codec.encode(text, text.length)
  if (!out) throw new Error(`cannot encode: ${text}`)
  return out
}

/**
 * Formats a SHOUTED game name for display: "MT. CHIMNEY" -> "Mt. Chimney".
 *
 * Gen 1-3 store names in caps because that is how the games render them,
 * which makes long names hard to scan in a list. This is presentation
 * only - never write the result back to a ROM, or the stored bytes stop
 * matching what the game expects.
 *
 * Minor words are lowercased unless they lead, so "CAVE OF ORIGIN" reads
 * as "Cave of Origin". A word already containing lowercase is left alone,
 * so names that are not shouted survive untouched.
 */
const MINOR_WORDS = new Set(['of', 'the', 'and', 'in', 'on', 'to', 'a', 'an'])

export function toTitleCase(name: string): string {
  if (/[a-z]/.test(name)) return name
  return name
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      if (i > 0 && MINOR_WORDS.has(word)) return word
      // Capitalise each dot-separated part, so initials survive:
      // "S.S. TIDAL" -> "S.S. Tidal", "MT." -> "Mt.". A part with no
      // letters, like "101", is left as it is.
      return word
        .split('.')
        .map((part) => part.replace(/[a-z]/, (c) => c.toUpperCase()))
        .join('.')
    })
    .join(' ')
}
