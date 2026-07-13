import type { Rom } from './rom'
import { detectPlatform } from './detect'
import { isNdsRom } from './nds/nds'

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
  } else if (isNdsRom(rom.bytes)) {
    fixNdsHeaderCrc(rom)
  }
}

/**
 * NDS header CRC-16 (poly 0xA001, init 0xFFFF, over bytes 0x000-0x15D,
 * stored at 0x15E) — algorithm from pokeheartgold tools/fixrom/fixrom.c.
 */
export function fixNdsHeaderCrc(rom: Rom): void {
  let crc = 0xffff
  for (let i = 0; i < 0x15e; i++) {
    crc ^= rom.bytes[i]
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
  }
  rom.writeU16LE(0x15e, crc)
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
