import { useEffect, useRef, useState } from 'react'
import type { FieldSpec, GameAdapter } from '../core/games/schema'
import { EntryList } from './EntryList'
import { FieldEditor } from './FieldEditor'
import { EggMoveCard, EvolutionCard, FormChangeCard, LearnsetCard } from './SpeciesExtras'
import { CreateMega } from './CreateMega'

function OneSprite({
  render,
  importSprite,
  label,
  onEdit,
}: {
  render: () => ReturnType<NonNullable<GameAdapter['speciesSprite']>>
  importSprite: ((image: { pixels: Uint8ClampedArray; width: number; height: number }) => string | null) | null
  label: string
  onEdit: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const img = render()
    const canvas = ref.current
    if (!canvas) return
    if (!img) {
      canvas.width = 0
      return
    }
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.pixels), img.width, img.height), 0, 0)
  }, [render, version])

  const importFile = async (file: File) => {
    try {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
      const result = importSprite!({ pixels: data.data, width: data.width, height: data.height })
      setError(result)
      if (!result) {
        setVersion((v) => v + 1)
        onEdit()
      }
    } catch {
      setError("Couldn't read that image file.")
    }
  }

  return (
    <div className="sprite-view">
      <canvas ref={ref} className="mon-sprite" title={label} />
      {importSprite && (
        <>
          <button className="ghost sprite-import" onClick={() => fileRef.current?.click()}>
            ⬆ {label}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importFile(f)
              e.target.value = ''
            }}
          />
          {error && <span className="name-hint invalid-hint">{error}</span>}
        </>
      )}
    </div>
  )
}

function SpriteView({ adapter, id, onEdit }: { adapter: GameAdapter; id: number; onEdit: () => void }) {
  const [shiny, setShiny] = useState(false)
  if (!adapter.speciesSprite) return null
  return (
    <>
      <OneSprite
        key={`f${id}${shiny}`}
        label="front"
        render={() => adapter.speciesSprite!(id, shiny)}
        importSprite={adapter.importSpeciesSprite ? (img) => adapter.importSpeciesSprite!(id, img) : null}
        onEdit={onEdit}
      />
      {adapter.speciesSpriteBack && (
        <OneSprite
          key={`b${id}${shiny}`}
          label="back"
          render={() => adapter.speciesSpriteBack!(id, shiny)}
          importSprite={
            adapter.importSpeciesSpriteBack ? (img) => adapter.importSpeciesSpriteBack!(id, img) : null
          }
          onEdit={onEdit}
        />
      )}
      {adapter.hasShinySprites && (
        <label className="shiny-toggle">
          <input type="checkbox" checked={shiny} onChange={(e) => setShiny(e.target.checked)} />
          <span>✨ Shiny</span>
        </label>
      )}
    </>
  )
}

const GROUP_TITLES: Record<string, string> = {
  stats: 'Base stats',
  typing: 'Typing & abilities',
  battle: 'Battle',
  evs: 'EV yield (0–3 per stat)',
  moves: 'Starting moves',
  breeding: 'Breeding',
  tmhm: 'TM / HM compatibility',
}

function NameEditor({ adapter, id, onEdit }: { adapter: GameAdapter; id: number; onEdit: () => void }) {
  const entry = adapter.species.find((s) => s.id === id)!
  const [draft, setDraft] = useState(entry.name)
  const [error, setError] = useState(false)
  if (adapter.speciesNameLength === null) return <h2 className="entry-title">{entry.label}</h2>

  const commit = () => {
    if (draft === entry.name) return
    const ok = adapter.setSpeciesName(id, draft)
    setError(!ok)
    if (ok) onEdit()
    else setDraft(entry.name)
  }

  return (
    <div className="name-editor">
      <input
        className={`name-input ${error ? 'invalid' : ''}`}
        value={draft}
        maxLength={adapter.speciesNameLength}
        onChange={(e) => {
          setError(false)
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="name-hint">
        {error
          ? 'That name contains characters this game cannot display.'
          : `Click to rename · up to ${adapter.speciesNameLength} characters`}
      </span>
    </div>
  )
}

function StatRow({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="stat-row">
      <span className="stat-label">{spec.label}</span>
      <input
        type="range"
        min={spec.min ?? 1}
        max={spec.max ?? 255}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        type="number"
        className="stat-num"
        min={spec.min ?? 1}
        max={spec.max ?? 255}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value))
          if (Number.isFinite(n)) onChange(Math.max(spec.min ?? 1, Math.min(spec.max ?? 255, n)))
        }}
      />
    </div>
  )
}

export function SpeciesPanel({ adapter, onEdit }: { adapter: GameAdapter; onEdit: () => void }) {
  const [selected, setSelected] = useState<number>(adapter.species[0]?.id ?? 1)
  const data = adapter.readSpecies(selected)

  const groups = new Map<string, FieldSpec[]>()
  for (const spec of adapter.speciesFields) {
    const g = spec.group ?? 'other'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(spec)
  }
  const statSpecs = groups.get('stats') ?? []
  const bst = statSpecs.reduce((sum, s) => sum + Number(data[s.key] ?? 0), 0)

  const write = (key: string, value: (typeof data)[string]) => {
    adapter.writeSpeciesField(selected, key, value)
    onEdit()
  }

  return (
    <div className="editor-layout">
      <EntryList
        entries={adapter.species}
        selected={selected}
        onSelect={setSelected}
        placeholder="Search Pokémon…"
      />
      <div className="detail" key={selected}>
        <div className="detail-header">
          <div className="detail-title-row">
            <SpriteView adapter={adapter} id={selected} onEdit={onEdit} />
            <NameEditor adapter={adapter} id={selected} onEdit={onEdit} />
          </div>
          <button className="ghost" onClick={() => { adapter.revertSpecies(selected); onEdit() }}>
            Revert this Pokémon
          </button>
        </div>

        <section className="card">
          <h3>
            {GROUP_TITLES.stats} <span className="bst">Total: {bst}</span>
          </h3>
          {statSpecs.map((spec) => (
            <StatRow
              key={spec.key}
              spec={spec}
              value={Number(data[spec.key] ?? 0)}
              onChange={(v) => write(spec.key, v)}
            />
          ))}
        </section>

        {adapter.evolutions && <EvolutionCard adapter={adapter} speciesId={selected} onEdit={onEdit} />}
        {adapter.formChanges && <FormChangeCard adapter={adapter} speciesId={selected} onEdit={onEdit} />}
        {adapter.formChanges && <CreateMega adapter={adapter} speciesId={selected} onEdit={onEdit} />}
        {adapter.learnsets && <LearnsetCard adapter={adapter} speciesId={selected} onEdit={onEdit} />}
        {adapter.eggMoves && <EggMoveCard adapter={adapter} speciesId={selected} onEdit={onEdit} />}

        {[...groups.entries()]
          .filter(([g]) => g !== 'stats')
          .map(([group, specs]) => (
            <section className="card" key={group}>
              <h3>{GROUP_TITLES[group] ?? group}</h3>
              <div className={specs.some((s) => s.kind === 'flags') ? '' : 'field-grid'}>
                {specs.map((spec) => (
                  <FieldEditor
                    key={spec.key}
                    adapter={adapter}
                    spec={spec}
                    value={data[spec.key] ?? 0}
                    onChange={(v) => write(spec.key, v)}
                  />
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  )
}
