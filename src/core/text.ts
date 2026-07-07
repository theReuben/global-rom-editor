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

function buildMaps(pairs: [number, string][]): {
  dec: Map<number, string>
  enc: Map<string, number>
} {
  const dec = new Map<number, string>()
  const enc = new Map<string, number>()
  for (const [b, ch] of pairs) {
    if (!dec.has(b)) dec.set(b, ch)
    if (!enc.has(ch)) enc.set(ch, b)
  }
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
  // Composite glyphs (decode-only in practice): PKMN, POKé.
  [0x53, 'PK'],
  [0x54, 'MN'],
  [0x55, 'PO'],
  [0x56, 'Ké'],
]

const gen3Maps = buildMaps(GEN3_PAIRS)

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
