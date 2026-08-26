import { useState } from 'react'
import type { GameAdapter, ScriptStep } from '../core/games/schema'

interface Props {
  adapter: GameAdapter
  /** The event's current script, so it can be edited rather than only replaced. */
  existing: { kind: 'steps'; steps: ScriptStep[] } | { kind: 'none' } | { kind: 'foreign' }
  onApply: (steps: ScriptStep[]) => boolean
  onClose: () => void
}

const STEP_LABELS: Record<ScriptStep['kind'], string> = {
  message: '💬 Show message',
  yesNo: '❓ Ask Yes/No (No ends the script)',
  giveItem: '🎁 Give item',
  givePokemon: '🐣 Give Pokémon',
  trainerBattle: '⚔️ Trainer battle',
  setFlag: '🚩 Set flag',
  clearFlag: '⚐ Clear flag',
}

function blankStep(kind: ScriptStep['kind']): ScriptStep {
  switch (kind) {
    case 'message':
      return { kind, text: 'HELLO!' }
    case 'yesNo':
      return { kind, question: 'WANT TO BATTLE?' }
    case 'giveItem':
      return { kind, item: 13, quantity: 1 }
    case 'givePokemon':
      return { kind, species: 1, level: 5 }
    case 'trainerBattle':
      return { kind, trainerId: 1, intro: 'LET US BATTLE!', defeat: 'YOU WIN!' }
    case 'setFlag':
    case 'clearFlag':
      return { kind, flag: 0x200 }
  }
}

/**
 * Zero-code event scripting: compose steps, and they compile to real
 * game bytecode placed in free space.
 */
export function ScriptBuilder({ adapter, existing, onApply, onClose }: Props) {
  const [steps, setSteps] = useState<ScriptStep[]>(() =>
    existing.kind === 'steps' ? existing.steps : [{ kind: 'message', text: 'HELLO!' }],
  )
  const [status, setStatus] = useState<string | null>(null)

  const update = (i: number, step: ScriptStep) =>
    setSteps((s) => s.map((old, idx) => (idx === i ? step : old)))
  const remove = (i: number) => setSteps((s) => s.filter((_, idx) => idx !== i))

  const speciesOptions = adapter.species
  const itemOptions = adapter.itemOptions

  return (
    <div className="script-builder">
      <h4>{existing.kind === 'steps' ? '✏️ Edit script' : '✨ Custom script'}</h4>
      <p className="muted small">
        Runs when the player interacts. Compiles to real script bytecode in free ROM space.
      </p>
      {existing.kind === 'foreign' && (
        <div className="notice">
          This event already has a script, but it uses commands this builder cannot represent —
          branching, specials and the like — so it can't be shown here. Writing a script below
          will replace it.
        </div>
      )}
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
          {step.kind === 'yesNo' && (
            <textarea
              rows={2}
              value={step.question}
              placeholder="The question to ask"
              onChange={(e) => update(i, { ...step, question: e.target.value })}
            />
          )}
          {step.kind === 'trainerBattle' && (
            <div className="script-battle">
              {adapter.trainerModule ? (
                <select
                  value={step.trainerId}
                  onChange={(e) => update(i, { ...step, trainerId: Number(e.target.value) })}
                >
                  {adapter.trainerModule.entries.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              ) : (
                <input type="number" value={step.trainerId}
                  onChange={(e) => update(i, { ...step, trainerId: Number(e.target.value) })} />
              )}
              <input value={step.intro} placeholder="Intro line"
                onChange={(e) => update(i, { ...step, intro: e.target.value })} />
              <input value={step.defeat} placeholder="Said when defeated"
                onChange={(e) => update(i, { ...step, defeat: e.target.value })} />
            </div>
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
