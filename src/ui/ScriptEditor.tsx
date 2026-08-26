import { useMemo, useState } from 'react'
import type { GameAdapter, ScriptInstruction } from '../core/games/schema'
import { GEN3_SCRIPT_COMMANDS } from '../core/games/gen3-script-commands'

/**
 * Command-level script editing.
 *
 * The step builder can only express the shapes it emits itself, which is
 * a fraction of what real events do. This shows the script as the actual
 * commands the game runs, with dialogue resolved in place of the pointer
 * that holds it, so an event written by the game can be edited rather
 * than replaced.
 */
export function ScriptEditor({
  adapter,
  mapKey,
  target,
  onEdit,
  onClose,
}: {
  adapter: GameAdapter
  mapKey: string
  target: { kind: 'npc' | 'sign'; index: number }
  onEdit: () => void
  onClose: () => void
}) {
  const module = adapter.mapModule!
  const initial = useMemo(
    () => module.readScriptCommands(mapKey, target.kind, target.index),
    [module, mapKey, target.kind, target.index],
  )
  const [instructions, setInstructions] = useState<ScriptInstruction[]>(
    () => initial?.instructions ?? [],
  )
  const [status, setStatus] = useState<string | null>(null)
  const [adding, setAdding] = useState('')

  if (!initial) {
    return (
      <div className="script-builder">
        <h4>⚙️ Script</h4>
        <div className="notice">
          This event's script can't be read — it uses a command with no known layout, so the rest
          of it can't be located safely.
        </div>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
    )
  }

  const mutate = (fn: (draft: ScriptInstruction[]) => void) => {
    const next = instructions.map((ins) => ({ ...ins, args: ins.args.map((a) => ({ ...a })) }))
    fn(next)
    setInstructions(next)
    setStatus(null)
  }

  const commandNames = Object.entries(GEN3_SCRIPT_COMMANDS)
    .map(([op, c]) => ({ op: Number(op), name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="script-builder script-editor">
      <h4>⚙️ Script — {instructions.length} commands</h4>
      <p className="muted small">
        The commands this event actually runs. Dialogue is shown in place of the pointer that
        holds it; longer text and longer scripts move to free ROM space when written.
      </p>

      <ol className="script-commands">
        {instructions.map((ins, i) => (
          <li key={i} className="script-command">
            <div className="script-command-head">
              <code>{ins.name}</code>
              <button
                className="ghost small"
                title="Remove this command"
                onClick={() => mutate((d) => d.splice(i, 1))}
              >
                ✕
              </button>
            </div>
            {ins.args.map((arg, j) => (
              <label className="field" key={j}>
                <span className="field-label">{arg.name}</span>
                {arg.text !== undefined && arg.text !== null ? (
                  <textarea
                    rows={Math.min(6, arg.text.split('\n').length + 1)}
                    value={arg.text}
                    onChange={(e) => mutate((d) => { d[i].args[j].text = e.target.value })}
                  />
                ) : arg.target !== null ? (
                  <span className="field-help">→ command {arg.target + 1} (kept in step)</span>
                ) : (
                  <input
                    type="number"
                    value={arg.value}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) mutate((d) => { d[i].args[j].value = v >>> 0 })
                    }}
                  />
                )}
              </label>
            ))}
          </li>
        ))}
      </ol>

      <div className="script-step-row">
        <select
          value={adding}
          onChange={(e) => {
            const op = Number(e.target.value)
            const c = GEN3_SCRIPT_COMMANDS[op]
            if (!c) return
            mutate((d) =>
              d.splice(Math.max(0, d.length - 1), 0, {
                offset: 0,
                opcode: op,
                name: c.name,
                args: c.args.map((a) => ({ name: a.name, size: a.size, value: 0, target: null })),
              }),
            )
            setAdding('')
          }}
        >
          <option value="">+ Add command…</option>
          {commandNames.map((c) => (
            <option key={c.op} value={c.op}>{c.name}</option>
          ))}
        </select>
        <button
          className="primary"
          onClick={() => {
            const ok = module.writeScriptCommands(mapKey, target.kind, target.index, instructions)
            setStatus(
              ok
                ? 'Script written. Save the ROM to try it.'
                : "Couldn't write — the ROM has no free space, or a message uses characters this game can't display.",
            )
            if (ok) onEdit()
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
