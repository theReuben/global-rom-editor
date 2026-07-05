import { useCallback, useState } from 'react'
import { Rom } from './core/rom'
import { buildAdapter, type GameAdapter } from './core/games'
import { Dropzone } from './ui/Dropzone'
import { SpeciesPanel } from './ui/SpeciesPanel'
import { MovesPanel } from './ui/MovesPanel'
import { PatchPanel } from './ui/PatchPanel'
import { InfoPanel } from './ui/InfoPanel'

type Tab = 'pokemon' | 'moves' | 'patch' | 'info'

const TABS: { id: Tab; label: string }[] = [
  { id: 'pokemon', label: '🧬 Pokémon' },
  { id: 'moves', label: '⚔️ Moves' },
  { id: 'patch', label: '📦 Save & Patches' },
  { id: 'info', label: 'ℹ️ ROM Info' },
]

export function App() {
  const [adapter, setAdapter] = useState<GameAdapter | null>(null)
  const [tab, setTab] = useState<Tab>('pokemon')
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const onEdit = useCallback(() => setTick((t) => t + 1), [])

  const loadBytes = useCallback((fileName: string, bytes: Uint8Array) => {
    const rom = new Rom(fileName, bytes)
    const result = buildAdapter(rom)
    if (result.adapter) {
      setAdapter(result.adapter)
      setError(null)
      setTab('pokemon')
    } else {
      setError(result.reason ?? 'Unsupported file.')
    }
  }, [])

  const onFile = useCallback(
    async (file: File) => {
      if (file.size > 64 * 1024 * 1024) {
        setError('That file is too large to be a Game Boy / GBA ROM.')
        return
      }
      loadBytes(file.name, new Uint8Array(await file.arrayBuffer()))
    },
    [loadBytes],
  )

  if (!adapter) {
    return <Dropzone onFile={(f) => void onFile(f)} error={error} />
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="logo-ball" /> Global ROM Editor
        </span>
        <span className="game-badge">{adapter.gameName}</span>
        <span className="spacer" />
        <span className="dirty">
          {adapter.rom.changedByteCount > 0
            ? `${adapter.rom.changedByteCount.toLocaleString()} bytes edited`
            : 'No edits yet'}
        </span>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'pokemon' && <SpeciesPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'moves' && <MovesPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'patch' && (
          <PatchPanel
            adapter={adapter}
            onEdit={onEdit}
            onRomRebuilt={(bytes) => loadBytes(adapter.rom.fileName, bytes)}
          />
        )}
        {tab === 'info' && (
          <InfoPanel adapter={adapter} onEdit={onEdit} onClose={() => setAdapter(null)} />
        )}
      </main>
    </div>
  )
}
