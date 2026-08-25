import { useCallback, useState } from 'react'
import { Rom } from './core/rom'
import { buildAdapter, type GameAdapter } from './core/games'
import { Dropzone } from './ui/Dropzone'
import { SpeciesPanel } from './ui/SpeciesPanel'
import { MovesPanel } from './ui/MovesPanel'
import { ItemsPanel } from './ui/ItemsPanel'
import { MapPanel } from './ui/MapPanel'
import { TrainerPanel } from './ui/TrainerPanel'
import { WildPanel } from './ui/WildPanel'
import { PatchPanel } from './ui/PatchPanel'
import { InfoPanel } from './ui/InfoPanel'
import { TypeChartPanel } from './ui/TypeChartPanel'
import { DecompApp, openDecompProject, type DecompProject } from './ui/DecompApp'

type Tab = 'pokemon' | 'moves' | 'items' | 'trainers' | 'wild' | 'maps' | 'types' | 'patch' | 'info'

function tabsFor(adapter: GameAdapter): { id: Tab; label: string }[] {
  return [
    { id: 'pokemon' as const, label: '🧬 Pokémon' },
    { id: 'moves' as const, label: '⚔️ Moves' },
    ...(adapter.itemModule ? [{ id: 'items' as const, label: '🎒 Items' }] : []),
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
  /**
   * Cross-tab jump target. Panels mount with `key` bound to it so a second
   * jump to the same tab still re-opens on the new entry.
   */
  const [jump, setJump] = useState<{ trainerId?: number; mapKey?: string; nonce: number } | null>(null)
  const openTrainer = useCallback((trainerId: number) => {
    setJump({ trainerId, nonce: Date.now() })
    setTab('trainers')
  }, [])
  const openMap = useCallback((mapKey: string) => {
    setJump({ mapKey, nonce: Date.now() })
    setTab('maps')
  }, [])
  const [, setTick] = useState(0)
  const onEdit = useCallback(() => setTick((t) => t + 1), [])

  const loadBytes = useCallback((fileName: string, bytes: Uint8Array) => {
    const rom = new Rom(fileName, bytes)
    const result = buildAdapter(rom)
    if (result.adapter) {
      setAdapter(result.adapter)
      setError(null)
      setTab('pokemon')
      setJump(null)
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
        {tab === 'items' && adapter.itemModule && <ItemsPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'trainers' && adapter.trainerModule && (
          <TrainerPanel
            key={`trainers-${jump?.trainerId ?? 'none'}-${jump?.nonce ?? 0}`}
            adapter={adapter}
            onEdit={onEdit}
            focusTrainerId={jump?.trainerId ?? null}
            onOpenMap={adapter.mapModule ? openMap : undefined}
          />
        )}
        {tab === 'wild' && adapter.wildModule && <WildPanel adapter={adapter} onEdit={onEdit} />}
        {tab === 'maps' && adapter.mapModule && (
          <MapPanel
            key={`maps-${jump?.mapKey ?? 'none'}-${jump?.nonce ?? 0}`}
            adapter={adapter}
            onEdit={onEdit}
            focusMapKey={jump?.mapKey ?? null}
            onOpenTrainer={adapter.trainerModule ? openTrainer : undefined}
          />
        )}
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
