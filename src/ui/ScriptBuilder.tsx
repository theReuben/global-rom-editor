import { useState } from 'react'
import type { GameAdapter, ScriptStep } from '../core/games/schema'

interface Props {
  adapter: GameAdapter
  onApply: (steps: ScriptStep[]) => boolean
  onClose: () => void
}

const STEP_LABELS: Record<ScriptStep['kind'], string> = {
  message: '💬 Show message',
  giveItem: '🎁 Give item',
  givePokemon: '🐣 Give Pokémon',
  setFlag: '🚩 Set flag',
  clearFlag: '⚐ Clear flag',
}

function blankStep(kind: ScriptStep['kind']): ScriptStep {
  switch (kind) {
    case 'message':
      return { kind, text: 'HELLO!' }
    case 'giveItem':
      return { kind, item: 13, quantity: 1 }
    case 'givePokemon':
      return { kind, species: 1, level: 5 }
    case 'setFlag':
    case 'clearFlag':
      return { kind, flag: 0x200 }
  }
}

/**
 * Zero-code event scripting: compose steps, and they compile to real
 * game bytecode placed in free space.
 */
export function ScriptBuilder({ adapter, onApply, onClose }: Props) {
  const [steps, setSteps] = useState<ScriptStep[]>([{ kind: 'message', text: 'HELLO!' }])
  const [status, setStatus] = useState<string | null>(null)

  const update = (i: number, step: ScriptStep) =>
    setSteps((s) => s.map((old, idx) => (idx === i ? step : old)))
  const remove = (i: number) => setSteps((s) => s.filter((_, idx) => idx !== i))

  const speciesOptions = adapter.species
  const itemOptions = adapter.itemOptions

  return (
    <div className="script-builder">
      <h4>✨ Custom script</h4>
      <p className="muted small">
        Runs when the player interacts. Compiles to real script bytecode in free ROM space.
      </p>
      {steps.map((step, i) => (
        <div className="script-step" key={i}>
          <div className="script-step-head">
            <span>{STEP_LABELS[step.kind]}</span>
            <button className="ghost" onClick={() => remove(i)}>✕</button>
          </div>
          {step.kind === 'message' && (
            <textarea
              rows={2}
              value={step.text}
              placeholder="One line per text row; blank line = next box"
              onChange={(e) => update(i, { ...step, text: e.target.value })}
            />
          )}
          {step.kind === 'giveItem' && (
            <div className="script-step-row">
              {itemOptions ? (
                <select value={step.item} onChange={(e) => update(i, { ...step, item: Number(e.target.value) })}>
                  {itemOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input type="number" value={step.item} onChange={(e) => update(i, { ...step, item: Number(e.target.value) })} />
              )}
              <label>
                ×
                <input type="number" min={1} max={99} value={step.quantity}
                  onChange={(e) => update(i, { ...step, quantity: Number(e.target.value) })} />
              </label>
            </div>
          )}
          {step.kind === 'givePokemon' && (
            <div className="script-step-row">
              <select value={step.species} onChange={(e) => update(i, { ...step, species: Number(e.target.value) })}>
                {speciesOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <label>
                Lv
                <input type="number" min={1} max={100} value={step.level}
                  onChange={(e) => update(i, { ...step, level: Number(e.target.value) })} />
              </label>
            </div>
          )}
          {(step.kind === 'setFlag' || step.kind === 'clearFlag') && (
            <label className="script-step-row">
              Flag ID
              <input type="number" min={0} max={0x1fff} value={step.flag}
                onChange={(e) => update(i, { ...step, flag: Number(e.target.value) })} />
            </label>
          )}
        </div>
      ))}
      <div className="script-step-row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) setSteps((s) => [...s, blankStep(e.target.value as ScriptStep['kind'])])
          }}
        >
          <option value="">+ Add step…</option>
          {Object.entries(STEP_LABELS).map(([kind, label]) => (
            <option key={kind} value={kind}>{label}</option>
          ))}
        </select>
        <button
          className="primary"
          disabled={steps.length === 0}
          onClick={() => {
            const ok = onApply(steps)
            setStatus(ok ? 'Script written and attached! Save the ROM to try it.' : "Couldn't compile — check for unsupported characters in messages.")
          }}
        >
          Write script
        </button>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {status && <div className={`notice ${status.startsWith('Script') ? 'ok' : 'err'}`}>{status}</div>}
    </div>
  )
}
