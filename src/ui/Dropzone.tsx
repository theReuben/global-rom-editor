import { useRef, useState } from 'react'
import { decompSupported } from './DecompApp'

interface Props {
  onFile: (file: File) => void
  error: string | null
  onOpenDecomp: () => void
}

const FEATURES = [
  ['🧬', 'Pokémon editor', 'Base stats, types, abilities, EV yields, catch rates, TM/HM compatibility, names — every field a form, zero code.'],
  ['⚔️', 'Move editor', 'Power, accuracy, PP, typing, priority and effects for every move in the game.'],
  ['🔎', 'Works on hacks too', 'Data tables are found by signature scanning, not hardcoded offsets — most existing ROM hacks load fine.'],
  ['📦', 'Share legally', 'Export your work as an IPS patch that contains only your changes, and apply community patches in one click.'],
] as const

const GAMES = [
  ['Gen 1', 'Red · Blue · Yellow'],
  ['Gen 2', 'Gold · Silver · Crystal'],
  ['Gen 3', 'Ruby · Sapphire · Emerald · FireRed · LeafGreen'],
] as const

export function Dropzone({ onFile, error, onOpenDecomp }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <div className="landing">
      <div className="hero">
        <h1>
          <span className="logo-ball" /> Global ROM Editor
        </h1>
        <p className="tagline">
          The all-in-one Pokémon ROM hacking studio that runs in your browser. No installs, no
          spreadsheets of offsets, no code — load a ROM and start creating.
        </p>
      </div>

      <div
        className={`dropzone ${dragging ? 'drag' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const f = e.dataTransfer.files?.[0]
          if (f) onFile(f)
        }}
      >
        <div className="drop-icon">⬇️</div>
        <div className="drop-title">Drop a ROM here, or click to browse</div>
        <div className="drop-sub">.gb · .gbc · .gba — your file never leaves this device</div>
        <input
          ref={inputRef}
          type="file"
          accept=".gb,.gbc,.gba,.bin,.rom"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {decompSupported() && (
        <p className="decomp-link">
          Working from source instead?{' '}
          <button className="linkish" onClick={onOpenDecomp}>
            Open a pokeemerald / pokefirered project folder
          </button>{' '}
          <span className="muted">(experimental)</span>
        </p>
      )}

      {error && <div className="notice err">{error}</div>}

      <div className="game-row">
        {GAMES.map(([gen, list]) => (
          <div className="game-chip" key={gen}>
            <strong>{gen}</strong> {list}
          </div>
        ))}
      </div>

      <div className="feature-grid">
        {FEATURES.map(([icon, title, body]) => (
          <div className="feature" key={title}>
            <div className="feature-icon">{icon}</div>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>

      <p className="legal">
        Use ROMs you legally own. Share your hacks as patches, never as full ROMs — this tool makes
        that the easy path.
      </p>
    </div>
  )
}
