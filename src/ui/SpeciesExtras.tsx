import { useState } from 'react'
import type { GameAdapter, LearnsetEntry } from '../core/games/schema'

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
  const itemParam = (method: number) => method === 6 || method === 7

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
          </div>
        ))}
      </div>
    </section>
  )
}
