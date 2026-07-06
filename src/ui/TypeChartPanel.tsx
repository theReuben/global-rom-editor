import { useState } from 'react'
import type { GameAdapter } from '../core/games/schema'
import { typeColor } from './typeColors'

const MULTS = [
  { value: 0, label: '0× (immune)' },
  { value: 5, label: '½× (not very effective)' },
  { value: 20, label: '2× (super effective)' },
]

export function TypeChartPanel({ adapter, onEdit }: { adapter: GameAdapter; onEdit: () => void }) {
  const chart = adapter.typeChart!
  const [newAtk, setNewAtk] = useState(0)
  const [newDef, setNewDef] = useState(0)
  const [newMult, setNewMult] = useState(20)
  const [error, setError] = useState(false)

  const entries = chart.entries()
  const typeName = (id: number) => adapter.typeOptions.find((t) => t.value === id)?.label ?? `Type ${id}`
  const typeSelect = (value: number, onChange: (v: number) => void) => (
    <div className="type-select">
      <span className="type-badge" style={{ background: typeColor(typeName(value)) }} />
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {adapter.typeOptions.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="patch-panel">
      <section className="card">
        <h3>Type effectiveness chart</h3>
        <p className="muted">
          Matchups not listed here are plain 1× damage. Change multipliers in place; adding a
          matchup relocates the chart into free space automatically.
        </p>
        <div className="typechart-add">
          {typeSelect(newAtk, setNewAtk)}
          <span className="muted">attacking</span>
          {typeSelect(newDef, setNewDef)}
          <select value={newMult} onChange={(e) => setNewMult(Number(e.target.value))}>
            {MULTS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => {
              const ok = chart.addEntry(newAtk, newDef, newMult)
              setError(!ok)
              if (ok) onEdit()
            }}
          >
            + Add matchup
          </button>
        </div>
        {error && <div className="notice err">Couldn't rewrite the chart (out of free space?).</div>}
        <div className="typechart-list">
          {entries.map((e, i) => (
            <div className="wild-slot" key={`${e.offset}-${i}`}>
              <span className="type-chip" style={{ background: typeColor(typeName(e.attacker)) }}>
                {typeName(e.attacker)}
              </span>
              <span className="muted">→</span>
              <span className="type-chip" style={{ background: typeColor(typeName(e.defender)) }}>
                {typeName(e.defender)}
              </span>
              <select
                value={e.multiplier}
                onChange={(ev) => {
                  chart.setMultiplier(i, Number(ev.target.value))
                  onEdit()
                }}
              >
                {!MULTS.some((m) => m.value === e.multiplier) && (
                  <option value={e.multiplier}>{e.multiplier / 10}×</option>
                )}
                {MULTS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <button
                className="ghost event-remove"
                onClick={() => {
                  if (chart.removeEntry(i)) onEdit()
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
