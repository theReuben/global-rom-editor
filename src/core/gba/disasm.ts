/**
 * Gen 3 script disassembler and reassembler.
 *
 * The step builder in script.ts can only express the handful of shapes
 * it emits itself. This reads any script into its actual commands, using
 * the layout table generated from the decomp's own macros, so an event
 * written by the game can be inspected and edited rather than only
 * overwritten.
 *
 * Branch targets are the reason this is not simply a byte dump. A script
 * that says "goto 0x28c0a4" cannot survive an edit that moves its
 * commands around, so every branch pointing inside the script itself is
 * resolved to the index of the command it lands on. Re-emitting
 * recomputes those addresses from the indices, which makes inserting and
 * deleting commands safe. Branches leaving the script keep their
 * absolute address, because the code they reach is not ours to move.
 */
import { GEN3_SCRIPT_COMMANDS, type ScriptCommand } from '../games/gen3-script-commands'
import { GBA_ROM_BASE } from '../freespace'
import { decodeScriptTextBytes } from './script'

/** Commands that end a straight-line run. */
const TERMINATORS = new Set(['end', 'return', 'goto', 'gotostd', 'returnptr'])

export interface ScriptArgValue {
  name: string
  size: number
  value: number
  /**
   * Decoded dialogue when this argument points at game text. Editing it
   * and writing the script back re-encodes the string; leaving it null
   * means the argument is a plain number or a pointer to something that
   * is not text.
   */
  text?: string | null
  /**
   * Index of the command this argument branches to, when it points
   * inside this same script. Null for plain numbers and for pointers
   * that leave the script.
   */
  target: number | null
}

export interface ScriptInstruction {
  /** Where it was read from, for display. */
  offset: number
  opcode: number
  name: string
  args: ScriptArgValue[]
}

export interface Disassembly {
  instructions: ScriptInstruction[]
  /** Byte range the script occupied, so a rewrite knows what it replaces. */
  start: number
  length: number
}

function commandSize(c: ScriptCommand): number {
  return 1 + c.args.reduce((n, a) => n + a.size, 0)
}

/**
 * Reads a script into commands. Returns null if it runs off the end of
 * the ROM or hits an opcode with no known layout, since guessing a size
 * would desynchronise everything after it.
 */
export function disassembleScript(bytes: Uint8Array, offset: number, maxCommands = 512): Disassembly | null {
  if (offset < 0 || offset >= bytes.length) return null

  // First pass: read commands and collect every address reached, so a
  // branch backwards or forwards can be matched to a command boundary.
  const raw: { offset: number; command: ScriptCommand; values: number[] }[] = []
  const boundaries = new Map<number, number>()
  let p = offset

  for (let n = 0; n < maxCommands; n++) {
    const command = GEN3_SCRIPT_COMMANDS[bytes[p]]
    if (!command) return null
    const size = commandSize(command)
    if (p + size > bytes.length) return null

    boundaries.set(p, raw.length)
    const values: number[] = []
    let at = p + 1
    for (const arg of command.args) {
      let v = 0
      for (let i = 0; i < arg.size; i++) v |= bytes[at + i] << (i * 8)
      values.push(v >>> 0)
      at += arg.size
    }
    raw.push({ offset: p, command, values })
    p += size
    if (TERMINATORS.has(command.name)) break
  }

  const end = p
  const instructions: ScriptInstruction[] = raw.map((r) => ({
    offset: r.offset,
    opcode: bytes[r.offset],
    name: r.command.name,
    args: r.command.args.map((arg, i) => {
      const value = r.values[i]
      let target: number | null = null
      if (arg.size === 4 && value >= GBA_ROM_BASE) {
        const at = value - GBA_ROM_BASE
        // Only addresses landing on a command boundary of THIS script
        // are internal branches; anything else is left absolute.
        if (at >= offset && at < end) target = boundaries.get(at) ?? null
      }
      return { name: arg.name, size: arg.size, value, target }
    }),
  }))

  return { instructions, start: offset, length: end - offset }
}

/**
 * Emits commands back to bytes at `base`, recomputing internal branch
 * addresses from their command indices so edits that move commands stay
 * correct.
 */
export function assembleScript(instructions: ScriptInstruction[], base: number): Uint8Array {
  const sizes = instructions.map((ins) => {
    const c = GEN3_SCRIPT_COMMANDS[ins.opcode]
    if (!c) throw new Error(`no layout for opcode 0x${ins.opcode.toString(16)}`)
    return commandSize(c)
  })
  const starts: number[] = []
  let running = base
  for (const s of sizes) {
    starts.push(running)
    running += s
  }

  const out = new Uint8Array(running - base)
  let at = 0
  instructions.forEach((ins) => {
    out[at++] = ins.opcode
    for (const arg of ins.args) {
      const value =
        arg.target !== null && arg.target < starts.length
          ? (starts[arg.target] + GBA_ROM_BASE) >>> 0
          : arg.value
      for (let b = 0; b < arg.size; b++) out[at++] = (value >>> (b * 8)) & 0xff
    }
  })
  return out
}

/**
 * Resolves 4-byte pointer arguments that address readable game text.
 *
 * Dialogue is not part of the command stream - commands only point at
 * it - so an editor that showed raw addresses would be unusable. A
 * pointer is treated as text when it lands in the ROM and every byte up
 * to its terminator decodes to a printable character, which is enough to
 * separate dialogue from pointers to other scripts or movement data.
 */
export function resolveText(bytes: Uint8Array, value: number, maxLength = 512): string | null {
  if (value < GBA_ROM_BASE) return null
  const at = value - GBA_ROM_BASE
  if (at < 0 || at >= bytes.length) return null

  let end = at
  while (end < bytes.length && bytes[end] !== 0xff && end - at < maxLength) end++
  if (end >= bytes.length || bytes[end] !== 0xff || end === at) return null

  for (let i = at; i < end; i++) {
    const b = bytes[i]
    // 0xFD introduces a placeholder such as {PLAYER} and swallows the
    // byte naming it; dialogue is full of them, and rejecting it here
    // made real messages look like raw pointers.
    if (b === 0xfd) {
      i++
      continue
    }
    // Printable glyphs, plus the line-break, new-box and pause controls.
    const printable =
      b === 0x00 || (b >= 0xf7 && b <= 0xfe) || (b >= 0xa1 && b <= 0xee) || (b >= 0x01 && b <= 0x6f)
    if (!printable) return null
  }
  return decodeScriptTextBytes(bytes.subarray(at, end))
}
