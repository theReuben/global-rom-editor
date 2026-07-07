import type { Rom } from './rom'
import { detectPlatform } from './detect'

/**
 * Fix cartridge header/global checksums after editing, so real hardware
 * and strict emulators accept the modified ROM.
 */
export function fixChecksums(rom: Rom): void {
  const platform = detectPlatform(rom.bytes)
  if (platform === 'GB' || platform === 'GBC') {
    fixGbChecksums(rom)
  } else if (platform === 'GBA') {
    fixGbaHeaderChecksum(rom)
  }
}

function fixGbChecksums(rom: Rom): void {
  // Header checksum over 0x134..0x14C.
  let x = 0
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom.bytes[i] - 1) & 0xff
  rom.writeU8(0x14d, x)
  // Global checksum: 16-bit sum of every byte except the two checksum bytes.
  let sum = 0
  for (let i = 0; i < rom.bytes.length; i++) {
    if (i === 0x14e || i === 0x14f) continue
    sum = (sum + rom.bytes[i]) & 0xffff
  }
  rom.writeU8(0x14e, (sum >> 8) & 0xff) // big-endian
  rom.writeU8(0x14f, sum & 0xff)
}

function fixGbaHeaderChecksum(rom: Rom): void {
  let sum = 0
  for (let i = 0xa0; i <= 0xbc; i++) sum = (sum + rom.bytes[i]) & 0xff
  rom.writeU8(0xbd, (-(sum + 0x19)) & 0xff)
}
