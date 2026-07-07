/**
 * Nintendo DS ROM container — the foundation for Gen 4/5 support.
 *
 * DS ROMs are not flat binaries: they carry a real file system (NitroFS)
 * described by a file-name table (FNT) and file-allocation table (FAT),
 * with most game data inside NARC archives. Formats per gbatek and the
 * pret DS decompilations.
 */

export interface NdsHeader {
  title: string
  gameCode: string
  fntOffset: number
  fntSize: number
  fatOffset: number
  fatSize: number
}

export interface NdsFile {
  id: number
  path: string
  start: number
  end: number
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}
function ascii(b: Uint8Array, o: number, len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    const c = b[o + i]
    if (c === 0) break
    out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ''
  }
  return out
}

export function parseNdsHeader(bytes: Uint8Array): NdsHeader | null {
  if (bytes.length < 0x200) return null
  const header: NdsHeader = {
    title: ascii(bytes, 0x00, 12).trim(),
    gameCode: ascii(bytes, 0x0c, 4),
    fntOffset: u32(bytes, 0x40),
    fntSize: u32(bytes, 0x44),
    fatOffset: u32(bytes, 0x48),
    fatSize: u32(bytes, 0x4c),
  }
  const ok =
    header.gameCode.length === 4 &&
    /^[A-Z0-9]{4}$/.test(header.gameCode) &&
    header.fntOffset > 0 &&
    header.fntOffset + header.fntSize <= bytes.length &&
    header.fatOffset > 0 &&
    header.fatOffset + header.fatSize <= bytes.length &&
    header.fatSize % 8 === 0 &&
    header.fatSize > 0
  return ok ? header : null
}

export function isNdsRom(bytes: Uint8Array): boolean {
  return parseNdsHeader(bytes) !== null
}

/** Walk the FNT/FAT into a flat path → file list. */
export function listNdsFiles(bytes: Uint8Array, header: NdsHeader): NdsFile[] {
  const fnt = header.fntOffset
  const out: NdsFile[] = []
  const dirCount = u16(bytes, fnt + 6) // root's parent field = total dirs
  const walk = (dirId: number, prefix: string, depth: number) => {
    if (depth > 16) return
    const entry = fnt + (dirId & 0xfff) * 8
    let p = fnt + u32(bytes, entry)
    let fileId = u16(bytes, entry + 4)
    while (p < bytes.length) {
      const len = bytes[p]
      if (len === 0) break
      const isDir = (len & 0x80) !== 0
      const nameLen = len & 0x7f
      const name = ascii(bytes, p + 1, nameLen)
      p += 1 + nameLen
      if (isDir) {
        const subId = u16(bytes, p)
        p += 2
        if ((subId & 0xfff) < dirCount) walk(subId, `${prefix}${name}/`, depth + 1)
      } else {
        const fat = header.fatOffset + fileId * 8
        out.push({ id: fileId, path: prefix + name, start: u32(bytes, fat), end: u32(bytes, fat + 4) })
        fileId++
      }
    }
  }
  walk(0xf000, '/', 0)
  return out
}

export function findNdsFile(files: NdsFile[], path: string): NdsFile | null {
  return files.find((f) => f.path === path) ?? null
}

/* -------------------------------------------------------------- NARC ---- */

export interface NarcSubfile {
  index: number
  /** Absolute offset into the ROM (or NARC buffer) and length. */
  offset: number
  length: number
}

/**
 * Parse a NARC archive at `base`. Returned offsets are absolute within
 * `bytes`, so editors can write subfile fields through the usual Rom
 * helpers (same-size edits; growing files needs a FAT rebuild — phase 2).
 */
export function parseNarc(bytes: Uint8Array, base: number): NarcSubfile[] | null {
  if (ascii(bytes, base, 4) !== 'NARC') return null
  const headerSize = u16(bytes, base + 0x0c)
  let p = base + headerSize
  if (ascii(bytes, p, 4) !== 'BTAF') return null
  const btafSize = u32(bytes, p + 4)
  const count = u16(bytes, p + 8)
  const entries: { start: number; end: number }[] = []
  for (let i = 0; i < count; i++) {
    entries.push({ start: u32(bytes, p + 12 + i * 8), end: u32(bytes, p + 16 + i * 8) })
  }
  p += btafSize
  if (ascii(bytes, p, 4) !== 'BTNF') return null
  p += u32(bytes, p + 4)
  if (ascii(bytes, p, 4) !== 'GMIF') return null
  const dataStart = p + 8
  return entries.map((e, index) => ({
    index,
    offset: dataStart + e.start,
    length: e.end - e.start,
  }))
}
