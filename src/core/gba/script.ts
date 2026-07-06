/**
 * Gen 3 event script compiler — the zero-code path to custom events.
 *
 * Users compose steps ("Show message", "Give item", …) and this compiles
 * them to the games' script bytecode. Opcodes and macro encodings are
 * taken from the pret decomps (asm/macros/event.inc + script_cmd_table),
 * verified identical between pokeemerald and pokefirered:
 *
 *   end 0x02 · callstd 0x09 · loadword 0x0F · setorcopyvar 0x1A
 *   setflag 0x29 · clearflag 0x2A · faceplayer 0x5A · lock 0x6A
 *   release 0x6C · givemon 0x79 (species u16, level u8, item u16, 9×0)
 *   MSGBOX_DEFAULT = callstd 4 · STD_OBTAIN_ITEM = callstd 0
 */
import { gen3Codec } from '../text'
import { GBA_ROM_BASE } from '../freespace'

export type ScriptStep =
  | { kind: 'message'; text: string }
  | { kind: 'giveItem'; item: number; quantity: number }
  | { kind: 'givePokemon'; species: number; level: number }
  | { kind: 'setFlag'; flag: number }
  | { kind: 'clearFlag'; flag: number }

const VAR_0X8000 = 0x8000
const VAR_0X8001 = 0x8001

/** Encode dialogue: \n → new line (0xFE), blank line → new box (0xFB). */
export function encodeScriptText(text: string): number[] | null {
  const out: number[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push(i === 1 ? 0xfe : 0xfb)
    const encoded = gen3Codec.encode(lines[i], lines[i].length)
    if (encoded === null) return null
    out.push(...encoded)
  }
  out.push(0xff)
  return out
}

export interface CompiledScript {
  /** Complete blob: code followed by text data, ready to write at `base`. */
  bytes: Uint8Array
  codeLength: number
}

/**
 * Compile steps into a full script blob. `base` is the ROM offset where
 * the blob will be written (needed to resolve text pointers).
 */
export function compileScript(steps: ScriptStep[], base: number): CompiledScript | null {
  // First pass: encode texts and measure the code section.
  const texts: number[][] = []
  let codeLength = 2 // lock, faceplayer
  for (const step of steps) {
    switch (step.kind) {
      case 'message': {
        const t = encodeScriptText(step.text)
        if (!t || step.text.trim().length === 0) return null
        texts.push(t)
        codeLength += 6 + 2 // loadword + callstd
        break
      }
      case 'giveItem':
        codeLength += 5 + 5 + 2 // 2× setorcopyvar + callstd
        break
      case 'givePokemon':
        codeLength += 15
        break
      case 'setFlag':
      case 'clearFlag':
        codeLength += 3
        break
    }
  }
  codeLength += 2 // release, end

  // Second pass: emit with resolved text addresses.
  const code: number[] = [0x6a, 0x5a] // lock, faceplayer
  let textOffset = base + codeLength
  const textAddrs = texts.map((t) => {
    const addr = textOffset
    textOffset += t.length
    return addr
  })
  let textIndex = 0
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]

  for (const step of steps) {
    switch (step.kind) {
      case 'message': {
        const addr = (textAddrs[textIndex++] + GBA_ROM_BASE) >>> 0
        code.push(0x0f, 0x00, ...u32(addr)) // loadword 0, text
        code.push(0x09, 0x04) // callstd MSGBOX_DEFAULT
        break
      }
      case 'giveItem':
        code.push(0x1a, ...u16(VAR_0X8000), ...u16(step.item)) // setorcopyvar
        code.push(0x1a, ...u16(VAR_0X8001), ...u16(Math.max(1, step.quantity)))
        code.push(0x09, 0x00) // callstd STD_OBTAIN_ITEM
        break
      case 'givePokemon':
        code.push(0x79, ...u16(step.species), step.level & 0xff, ...u16(0))
        code.push(0, 0, 0, 0, 0, 0, 0, 0, 0)
        break
      case 'setFlag':
        code.push(0x29, ...u16(step.flag))
        break
      case 'clearFlag':
        code.push(0x2a, ...u16(step.flag))
        break
    }
  }
  code.push(0x6c, 0x02) // release, end

  if (code.length !== codeLength) throw new Error('script size mismatch')
  return { bytes: Uint8Array.from([...code, ...texts.flat()]), codeLength }
}
