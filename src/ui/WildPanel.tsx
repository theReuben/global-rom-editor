import { useMemo, useState } from 'react'
import type { GameAdapter } from '../core/games/schema'

export function WildPanel({ adapter, onEdit }: { adapter: GameAdapter; onEdit: () => void }) {
  const module = adapter.wildModule!
  const [key, setKey] = useState(module.entries[0]?.key ?? '')
  const [query, setQuery] = useState('')

  const speciesOptions = useMemo(
    () => adapter.species.map((s) => ({ value: s.id, label: s.displayName ?? s.name })),
    [adapter],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? module.entries.filter((e) => e.label.toLowerCase().includes(q)) : module.entries
  }, [module, query])

  if (module.entries.length === 0) {
    return <div className="panel-message">No wild encounter data found in this ROM.</div>
  }
  const groups = module.groups(key)

  return (
    <div className="editor-layout">
      <div className="entry-list">
        <input
          className="search"
          type="search"
          placeholder="Search maps…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="entry-scroll">
          {filtered.map((e) => (
            <button key={e.key} className={`entry ${key === e.key ? 'selected' : ''}`} onClick={() => setKey(e.key)}>
              🌿 {e.label}
            </button>
          ))}
        </div>
      </div>
      <div className="detail" key={key}>
        <div className="detail-header">
          {/* The list names the place; the heading said "Map 0.16". The
              label carries the key too ("0.16 - Route 101"), and the
              heading only needs the name. */}
          <h2 className="entry-title">
            Wild Pokémon — {module.entries.find((e) => e.key === key)?.label.split(' — ').pop() ?? key}
          </h2>
          <button className="ghost" onClick={() => { module.revert(key); onEdit() }}>
            Revert this map's encounters
          </button>
        </div>
        <p className="muted">
          Slot order matters: earlier slots appear far more often (slot 1 ≈ 20%, the last slots ≈ 1%).
        </p>
        {groups.map((group, gi) => (
          <section className="card" key={gi}>
            <h3>
              {group.name}
              <span className="bst">
                Encounter rate:{' '}
                <input
                  type="number"
                  className="rate-input"
                  min={0}
                  max={255}
                  value={group.rate}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value))
                    if (Number.isFinite(n)) {
                      module.setRate(key, gi, Math.max(0, Math.min(255, n)))
                      onEdit()
                    }
                  }}
                />
              </span>
            </h3>
            <div className="wild-grid">
              {group.slots.map((slot, si) => (
                <div className="wild-slot" key={si}>
                  <span className="wild-slot-n">{si + 1}</span>
                  <select
                    value={slot.species}
                    onChange={(e) => {
                      module.setSlot(key, gi, si, 'species', Number(e.target.value))
                      onEdit()
                    }}
                  >
                    {!speciesOptions.some((o) => o.value === slot.species) && (
                      <option value={slot.species}>Unknown ({slot.species})</option>
                    )}
                    {speciesOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <label>
                    Lv
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={slot.minLevel}
                      onChange={(e) => {
                        const n = Math.round(Number(e.target.value))
                        if (Number.isFinite(n)) {
                          module.setSlot(key, gi, si, 'minLevel', Math.max(1, Math.min(100, n)))
                          onEdit()
                        }
                      }}
                    />
                  </label>
                  <span>–</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={slot.maxLevel}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      if (Number.isFinite(n)) {
                        module.setSlot(key, gi, si, 'maxLevel', Math.max(1, Math.min(100, n)))
                        onEdit()
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
