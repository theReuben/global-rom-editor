/** Platform / cartridge header detection. */

export type Platform = 'GB' | 'GBC' | 'GBA'

export interface RomInfo {
  platform: Platform
  /** Raw header title, e.g. "POKEMON RED" or "POKEMON FIRE". */
  title: string
  /** GBA 4-letter game code (e.g. BPRE), empty on GB/GBC. */
  gameCode: string
}

const GB_LOGO_START = [0xce, 0xed, 0x66, 0x66]

export function detectPlatform(bytes: Uint8Array): Platform | null {
  // GBA header: fixed value 0x96 at 0xB2.
  if (bytes.length >= 0xc0 && bytes[0xb2] === 0x96) return 'GBA'
  // GB/GBC header: Nintendo logo at 0x104.
  if (bytes.length >= 0x150 && GB_LOGO_START.every((b, i) => bytes[0x104 + i] === b)) {
    return bytes[0x143] === 0x80 || bytes[0x143] === 0xc0 ? 'GBC' : 'GB'
  }
  return null
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    const b = bytes[off + i]
    if (b === 0) break
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ''
  }
  return out.trim()
}

export function readRomInfo(bytes: Uint8Array): RomInfo | null {
  const platform = detectPlatform(bytes)
  if (!platform) return null
  if (platform === 'GBA') {
    return {
      platform,
      title: ascii(bytes, 0xa0, 12),
      gameCode: ascii(bytes, 0xac, 4),
    }
  }
  return { platform, title: ascii(bytes, 0x134, platform === 'GBC' ? 15 : 16), gameCode: '' }
}
