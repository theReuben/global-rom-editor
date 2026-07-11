import { useRef, useState } from 'react'
import type { GameAdapter } from '../core/games/schema'
import { fixChecksums } from '../core/checksum'
import { applyIps, createIps } from '../core/ips'
import { applyUps, createUps, isUps } from '../core/ups'
import { downloadBytes, splitName } from './download'

interface Props {
  adapter: GameAdapter
  onEdit: () => void
  /** Called when a patch changed the ROM so tables must be re-scanned. */
  onRomRebuilt: (bytes: Uint8Array) => void
}

export function PatchPanel({ adapter, onEdit, onRomRebuilt }: Props) {
  const rom = adapter.rom
  const fileRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { base, ext } = splitName(rom.fileName)

  const saveRom = () => {
    fixChecksums(rom)
    onEdit()
    downloadBytes(rom.bytes, `${base} (edited)${ext || '.rom'}`)
    setStatus('ROM saved with corrected header checksums.')
  }

  const exportIps = () => {
    try {
      fixChecksums(rom)
      onEdit()
      const patch = createIps(rom.original, rom.bytes)
      downloadBytes(patch, `${base}.ips`)
      setError(null)
      setStatus(`IPS patch exported (${patch.length.toLocaleString()} bytes). Share the patch — never the ROM.`)
    } catch (e) {
      setStatus(null)
      setError(
        `${e instanceof Error ? e.message : String(e)} — for DS ROMs, share the edited ROM privately or wait for UPS/BPS export (roadmap).`,
      )
    }
  }

  const exportUps = () => {
    fixChecksums(rom)
    onEdit()
    const patch = createUps(rom.original, rom.bytes)
    downloadBytes(patch, `${base}.ups`)
    setError(null)
    setStatus(`UPS patch exported (${patch.length.toLocaleString()} bytes). Share the patch — never the ROM.`)
  }

  const applyPatchFile = async (file: File) => {
    setError(null)
    setStatus(null)
    try {
      const patch = new Uint8Array(await file.arrayBuffer())
      const patched = isUps(patch) ? applyUps(rom.bytes, patch) : applyIps(rom.bytes, patch)
      if (patched.length === rom.length) {
        rom.writeBytes(0, patched)
        onEdit()
        setStatus(`Applied ${file.name}. The edits are tracked like your own changes.`)
      } else {
        onRomRebuilt(patched)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="patch-panel">
      <section className="card">
        <h3>💾 Save edited ROM</h3>
        <p>
          Downloads your ROM with all edits applied and the cartridge checksums fixed, ready to
          play in any emulator or flash cart. <strong>{rom.changedByteCount.toLocaleString()}</strong>{' '}
          byte(s) currently differ from the original file.
        </p>
        <button className="primary" onClick={saveRom}>Download edited ROM</button>
      </section>

      <section className="card">
        <h3>📦 Export IPS patch</h3>
        <p>
          An IPS patch contains <em>only your changes</em> — none of the original game data — so it's
          the standard, legal way to share a ROM hack. Players apply it to their own copy of the
          game (they can do that right here, too).
        </p>
        <div className="button-row">
          <button className="primary" onClick={exportIps} disabled={rom.changedByteCount === 0 || rom.length > 0x1000000}>
            Export .ips patch
          </button>
          <button className="primary" onClick={exportUps} disabled={rom.changedByteCount === 0}>
            Export .ups patch
          </button>
        </div>
        {rom.length > 0x1000000 && (
          <p className="muted">This ROM is larger than 16 MiB, so use UPS (IPS can't address it).</p>
        )}
      </section>

      <section className="card">
        <h3>🩹 Apply an IPS / UPS patch</h3>
        <p>
          Apply a community patch (or someone else's hack) to the loaded ROM. The editor re-scans
          the game data afterwards so you can keep editing on top of it.
        </p>
        <button onClick={() => fileRef.current?.click()}>Choose .ips / .ups file…</button>
        <input
          ref={fileRef}
          type="file"
          accept=".ips,.ups"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void applyPatchFile(f)
            e.target.value = ''
          }}
        />
      </section>

      {status && <div className="notice ok">{status}</div>}
      {error && <div className="notice err">{error}</div>}
    </div>
  )
}
