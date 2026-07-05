import type { GameAdapter } from '../core/games/schema'

interface Props {
  adapter: GameAdapter
  onEdit: () => void
  onClose: () => void
}

const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(6, '0')

export function InfoPanel({ adapter, onEdit, onClose }: Props) {
  const rom = adapter.rom
  return (
    <div className="patch-panel">
      <section className="card">
        <h3>ROM information</h3>
        <table className="info-table">
          <tbody>
            <tr><td>Game</td><td>{adapter.gameName}</td></tr>
            <tr><td>Platform</td><td>{adapter.platform} · Generation {adapter.generation}</td></tr>
            <tr><td>File</td><td>{rom.fileName}</td></tr>
            <tr><td>Size</td><td>{(rom.length / 1024 / 1024).toFixed(2)} MiB</td></tr>
            <tr><td>Edited bytes</td><td>{rom.changedByteCount.toLocaleString()}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Detected data tables</h3>
        <p className="muted">
          Tables are located by scanning for the game's own data signatures and verified before any
          editing is enabled — no fragile hardcoded offsets, so most ROM hacks work too.
        </p>
        <table className="info-table">
          <thead>
            <tr><th>Table</th><th>Offset</th><th>Size</th></tr>
          </thead>
          <tbody>
            {adapter.regions.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="mono">{hex(r.offset)}</td>
                <td>{r.length.toLocaleString()} bytes</td>
              </tr>
            ))}
          </tbody>
        </table>
        {adapter.warnings.map((w, i) => (
          <div key={i} className="notice warn">{w}</div>
        ))}
      </section>

      <section className="card">
        <h3>Session</h3>
        <div className="button-row">
          <button
            className="danger"
            onClick={() => {
              if (confirm('Discard ALL edits and restore the original ROM?')) {
                rom.revertAll()
                onEdit()
              }
            }}
          >
            Discard all edits
          </button>
          <button className="ghost" onClick={onClose}>Close ROM</button>
        </div>
        <p className="muted">
          Everything happens locally in your browser — the ROM is never uploaded anywhere.
        </p>
      </section>
    </div>
  )
}
