import { useCallback, useState } from 'react'
import { Rom } from './core/rom'
import { buildAdapter, type GameAdapter } from './core/games'
import { Dropzone } from './ui/Dropzone'
import { SpeciesPanel } from './ui/SpeciesPanel'
import { MovesPanel } from './ui/MovesPanel'
import { MapPanel } from './ui/MapPanel'
import { TrainerPanel } from './ui/TrainerPanel'
import { WildPanel } from './ui/WildPanel'
import { PatchPanel } from './ui/PatchPanel'
import { InfoPanel } from './ui/InfoPanel'
import { TypeChartPanel } from './ui/TypeChartPanel'
import { DecompApp, openDecompProject, type DecompProject } from './ui/DecompApp'

type Tab = 'pokemon' | 'moves' | 'trainers' | 'wild' | 'maps' | 'types' | 'patch' | 'info'

function tabsFor(adapter: GameAdapter): { id: Tab; label: string }[] {
  return [
    { id: 'pokemon' as const, label: '🧬 Pokémon' },
    { id: 'moves' as const, label: '⚔️ Moves' },
    ...(adapter.trainerModule ? [{ id: 'trainers' as const, label: '🥊 Trainers' }] : []),
    ...(adapter.wildModule ? [{ id: 'wild' as const, label: '🌿 Wild' }] : []),
    ...(adapter.mapModule ? [{ id: 'maps' as const, label: '🗺️ Maps' }] : []),
    ...(adapter.typeChart ? [{ id: 'types' as const, label: '🧪 Types' }] : []),
    { id: 'patch' as const, label: '📦 Save & Patches' },
    { id: 'info' as const, label: 'ℹ️ ROM Info' },
  ]
}

export function App() {
  const [adapter, setAdapter] = useState<GameAdapter | null>(null)
  const [decomp, setDecomp] = useState<DecompProject | null>(null)
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

  if (decomp) {
    return <DecompApp project={decomp} onClose={() => setDecomp(null)} />
  }

  if (!adapter) {
    return (
      <Dropzone
        onFile={(f) => void onFile(f)}
        error={error}
        onOpenDecomp={async () => {
          try {
            const project = await openDecompProject()
            if (project) setDecomp(project)
          } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return
            setError(e instanceof Error ? e.message : String(e))
          }
        }}
      />
    )
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
        {tabsFor(adapter).map((t) => (
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
        {tab === 'trainers' && adapter.trainerModule && <TrainerPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'wild' && adapter.wildModule && <WildPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'maps' && adapter.mapModule && <MapPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'types' && adapter.typeChart && <TypeChartPanel adapter={adapter} onEdit={onEdit} />}
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
