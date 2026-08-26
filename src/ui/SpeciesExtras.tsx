import { useState } from 'react'
import type { GameAdapter, LearnsetEntry, EvolutionModule, EvolutionEntry } from '../core/games/schema'

/** Level-up learnset editor card (shown when the adapter supports it). */
export function LearnsetCard({
  adapter,
  speciesId,
  onEdit,
}: {
  adapter: GameAdapter
  speciesId: number
  onEdit: () => void
}) {
  const module = adapter.learnsets!
  const [error, setError] = useState(false)
  const entries = module.read(speciesId)

  const apply = (next: LearnsetEntry[]) => {
    const ok = module.write(speciesId, next)
    setError(!ok)
    if (ok) onEdit()
  }

  return (
    <section className="card">
      <h3>
        Level-up moves <span className="bst">{entries.length} moves</span>
      </h3>
      <div className="learnset-list">
        {entries.map((e, i) => (
          <div className="wild-slot" key={i}>
            <label>
              Lv
              <input
                type="number"
                min={1}
                max={100}
                value={e.level}
                onChange={(ev) => {
                  const n = Math.round(Number(ev.target.value))
                  if (!Number.isFinite(n)) return
                  const next = entries.map((x, j) => (j === i ? { ...x, level: Math.max(1, Math.min(100, n)) } : x))
                  apply(next)
                }}
              />
            </label>
            <select
              value={e.move}
              onChange={(ev) => {
                const next = entries.map((x, j) => (j === i ? { ...x, move: Number(ev.target.value) } : x))
                apply(next)
              }}
            >
              {!adapter.moves.some((m) => m.id === e.move) && <option value={e.move}>Move #{e.move}</option>}
              {adapter.moves.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button className="ghost event-remove" onClick={() => apply(entries.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="button-row" style={{ marginTop: 10 }}>
        <button
          onClick={() => {
            const last = entries[entries.length - 1]
            apply([...entries, { level: Math.min(100, (last?.level ?? 0) + 1), move: 33 }])
          }}
        >
          + Add move
        </button>
        {error && <span className="name-hint">Couldn't write (out of free space?).</span>}
      </div>
    </section>
  )
}

/**
 * Egg move editor card. Unlike the level-up learnset these are stored
 * in one shared array, so a species with no egg moves simply has no
 * entry — "+ Add move" creates one and removing the last drops it.
 */
export function EggMoveCard({
  adapter,
  speciesId,
  onEdit,
}: {
  adapter: GameAdapter
  speciesId: number
  onEdit: () => void
}) {
  const module = adapter.eggMoves!
  const [error, setError] = useState(false)
  const moves = module.read(speciesId)

  const apply = (next: number[]) => {
    const ok = module.write(speciesId, next)
    setError(!ok)
    if (ok) onEdit()
  }

  return (
    <section className="card">
      <h3>
        Egg moves{' '}
        <span className="bst">
          {moves.length} of {module.maxMoves}
        </span>
      </h3>
      {moves.length === 0 && (
        <p className="muted small">This species has no egg moves — breeding passes nothing down.</p>
      )}
      <div className="learnset-list">
        {moves.map((move, i) => (
          <div className="wild-slot" key={i}>
            <select
              value={move}
              onChange={(ev) => apply(moves.map((m, j) => (j === i ? Number(ev.target.value) : m)))}
            >
              {!adapter.moves.some((m) => m.id === move) && <option value={move}>Move #{move}</option>}
              {adapter.moves.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button className="ghost event-remove" onClick={() => apply(moves.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="button-row" style={{ marginTop: 10 }}>
        <button
          disabled={moves.length >= module.maxMoves}
          onClick={() => apply([...moves, adapter.moves[0]?.id ?? 1])}
        >
          + Add move
        </button>
        {moves.length >= module.maxMoves && (
          <span className="name-hint">The game only reads {module.maxMoves} egg moves per species.</span>
        )}
        {error && <span className="name-hint">Couldn't write (out of free space?).</span>}
      </div>
    </section>
  )
}

/** Evolution editor card. */
export function EvolutionCard({
  adapter,
  speciesId,
  onEdit,
}: {
  adapter: GameAdapter
  speciesId: number
  onEdit: () => void
}) {
  const module = adapter.evolutions!
  const evos = module.read(speciesId)
  const write = (slot: number, field: string, value: number) => {
    module.write(speciesId, slot, field, value)
    onEdit()
  }
  const itemMethods = module.itemParamMethods ?? [6, 7]
  const itemParam = (method: number) => itemMethods.includes(method)

  return (
    <section className="card">
      <h3>Evolutions</h3>
      <div className="learnset-list">
        {evos.map((evo, slot) => (
          <div className="wild-slot" key={slot}>
            <select value={evo.method} onChange={(e) => write(slot, 'method', Number(e.target.value))}>
              {module.methods.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {evo.method !== 0 && (
              <>
                {itemParam(evo.method) && adapter.itemOptions ? (
                  <select value={evo.param} onChange={(e) => write(slot, 'param', Number(e.target.value))}>
                    {adapter.itemOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    min={0}
                    max={65535}
                    value={evo.param}
                    title="Level / beauty / parameter"
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      if (Number.isFinite(n)) write(slot, 'param', n)
                    }}
                  />
                )}
                <span className="muted">→</span>
                <select value={evo.target} onChange={(e) => write(slot, 'target', Number(e.target.value))}>
                  {!adapter.species.some((s) => s.id === evo.target) && (
                    <option value={evo.target}>Species #{evo.target}</option>
                  )}
                  {adapter.species.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </>
            )}
            {module.conditionOptions && evo.method !== 0 && (
              <Conditions adapter={adapter} module={module} id={speciesId} slot={slot} evo={evo} onEdit={onEdit} />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The extra requirements hanging off an evolution.
 *
 * The expansion keeps these separate from the method, which is why so
 * many "level up" evolutions carry a level of 0 - Golbat's real
 * requirement is a friendship condition, not a level. Without this the
 * editor shows a bare 0 and no way to see or change what actually
 * triggers the evolution.
 */
function Conditions({
  adapter,
  module,
  id,
  slot,
  evo,
  onEdit,
}: {
  adapter: GameAdapter
  module: EvolutionModule
  id: number
  slot: number
  evo: EvolutionEntry
  onEdit: () => void
}) {
  const options = module.conditionOptions!
  const conditions = evo.conditions ?? []
  const [adding, setAdding] = useState('')

  const optionsFor = (kind?: string) =>
    kind === 'item' ? adapter.itemOptions
    : kind === 'species' ? adapter.species.map((sp) => ({ value: sp.id, label: sp.name }))
    : kind === 'move' ? adapter.moves.map((m) => ({ value: m.id, label: m.name }))
    : null

  return (
    <div className="evo-conditions">
      {conditions.length === 0 && <span className="muted small">No extra conditions</span>}
      {conditions.map((c, index) => {
        const def = options.find((o) => o.value === c.condition)
        const choices = optionsFor(def?.argKind)
        return (
          <div className="evo-condition" key={index}>
            <span className="evo-condition-label" title={def?.description}>
              {def?.label ?? `Condition #${c.condition}`}
            </span>
            {Array.from({ length: def?.args ?? 0 }, (_, a) =>
              choices && a === 0 ? (
                <select
                  key={a}
                  value={c.args[a]}
                  onChange={(e) => {
                    module.writeCondition?.(id, slot, index, a, Number(e.target.value))
                    onEdit()
                  }}
                >
                  {!choices.some((o) => o.value === c.args[a]) && (
                    <option value={c.args[a]}>#{c.args[a]}</option>
                  )}
                  {choices.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  key={a}
                  type="number"
                  min={0}
                  max={65535}
                  value={c.args[a]}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value))
                    if (!Number.isFinite(n)) return
                    module.writeCondition?.(id, slot, index, a, n)
                    onEdit()
                  }}
                />
              ),
            )}
            <button
              className="ghost small"
              title="Remove this condition"
              onClick={() => {
                module.removeCondition?.(id, slot, index)
                onEdit()
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
      <select
        value={adding}
        onChange={(e) => {
          if (!e.target.value) return
          module.addCondition?.(id, slot, Number(e.target.value))
          setAdding('')
          onEdit()
        }}
      >
        <option value="">+ Add condition…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.description}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
