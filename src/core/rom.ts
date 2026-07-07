/**
 * Rom — an in-memory ROM image with change tracking.
 *
 * All edits go through write helpers so the editor always knows exactly
 * which bytes differ from the originally loaded file. That powers the
 * change counter, per-field revert, and IPS patch export.
 */
export class Rom {
  readonly fileName: string
  readonly bytes: Uint8Array
  readonly original: Uint8Array
  private changed = new Set<number>()
  /** Bumped on every write; UI subscribes to this to re-render. */
  version = 0

  constructor(fileName: string, data: Uint8Array) {
    this.fileName = fileName
    this.bytes = new Uint8Array(data) // working copy
    this.original = new Uint8Array(data) // pristine copy
  }

  get length(): number {
    return this.bytes.length
  }

  get changedByteCount(): number {
    return this.changed.size
  }

  readU8(off: number): number {
    return this.bytes[off]
  }

  readU16LE(off: number): number {
    return this.bytes[off] | (this.bytes[off + 1] << 8)
  }

  readBytes(off: number, len: number): Uint8Array {
    return this.bytes.subarray(off, off + len)
  }

  writeU8(off: number, value: number): void {
    const v = value & 0xff
    if (this.bytes[off] === v) return
    this.bytes[off] = v
    if (this.original[off] === v) this.changed.delete(off)
    else this.changed.add(off)
    this.version++
  }

  writeU16LE(off: number, value: number): void {
    this.writeU8(off, value & 0xff)
    this.writeU8(off + 1, (value >> 8) & 0xff)
  }

  writeBytes(off: number, data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.writeU8(off + i, data[i])
  }

  /** Restore a range back to the originally loaded bytes. */
  revertRange(off: number, len: number): void {
    for (let i = 0; i < len; i++) this.writeU8(off + i, this.original[off + i])
  }

  /** Restore the entire ROM to the originally loaded bytes. */
  revertAll(): void {
    this.bytes.set(this.original)
    this.changed.clear()
    this.version++
  }
}
