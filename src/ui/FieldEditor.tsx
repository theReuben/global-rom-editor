import type { FieldSpec, FieldValue, GameAdapter } from '../core/games/schema'
import { typeColor } from './typeColors'

interface Props {
  adapter: GameAdapter
  spec: FieldSpec
  value: FieldValue
  onChange: (value: FieldValue) => void
}

/** Renders the right control for a FieldSpec — the UI never needs to know
 *  which game or generation it is editing. */
export function FieldEditor({ adapter, spec, value, onChange }: Props) {
  switch (spec.kind) {
    case 'number': {
      const v = typeof value === 'number' ? value : 0
      return (
        <label className="field" title={spec.help}>
          <span className="field-label">{spec.label}</span>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            value={v}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n)) return
              onChange(Math.max(spec.min ?? 0, Math.min(spec.max ?? 255, Math.round(n))))
            }}
          />
          {spec.help && <span className="field-help">{spec.help}</span>}
        </label>
      )
    }
    case 'type': {
      const v = typeof value === 'number' ? value : 0
      const label = adapter.typeOptions.find((o) => o.value === v)?.label
      return (
        <label className="field" title={spec.help}>
          <span className="field-label">{spec.label}</span>
          <div className="type-select">
            <span className="type-badge" style={{ background: typeColor(label ?? '') }} />
            <select value={v} onChange={(e) => onChange(Number(e.target.value))}>
              {label === undefined && <option value={v}>Unknown ({v})</option>}
              {adapter.typeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {spec.help && <span className="field-help">{spec.help}</span>}
        </label>
      )
    }
    case 'move': {
      const v = typeof value === 'number' ? value : 0
      const known = v === 0 || adapter.moves.some((m) => m.id === v)
      return (
        <label className="field">
          <span className="field-label">{spec.label}</span>
          <select value={v} onChange={(e) => onChange(Number(e.target.value))}>
            <option value={0}>— none —</option>
            {!known && <option value={v}>Unknown move ({v})</option>}
            {adapter.moves.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )
    }
    case 'select': {
      const v = typeof value === 'number' ? value : 0
      const known = spec.options?.some((o) => o.value === v)
      return (
        <label className="field" title={spec.help}>
          <span className="field-label">{spec.label}</span>
          <select value={v} onChange={(e) => onChange(Number(e.target.value))}>
            {!known && <option value={v}>Custom ({v})</option>}
            {spec.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {spec.help && <span className="field-help">{spec.help}</span>}
        </label>
      )
    }
    case 'flags': {
      const flags = Array.isArray(value) ? (value as boolean[]) : []
      return (
        <div className="flags-grid">
          {spec.flagLabels?.map((label, i) => (
            <label key={i} className={`flag ${flags[i] ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={!!flags[i]}
                onChange={(e) => {
                  const next = flags.slice()
                  next[i] = e.target.checked
                  onChange(next)
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )
    }
  }
}
