import { useState } from 'react'
import type { GameAdapter } from '../core/games/schema'
import { EntryList } from './EntryList'
import { FieldEditor } from './FieldEditor'

function MoveNameEditor({ adapter, id, onEdit }: { adapter: GameAdapter; id: number; onEdit: () => void }) {
  const entry = adapter.moves.find((m) => m.id === id)!
  const [draft, setDraft] = useState(entry.name)
  const [error, setError] = useState(false)
  if (adapter.moveNameLength === null) {
    return (
      <div>
        <h2 className="entry-title">{entry.label}</h2>
        <span className="name-hint">Move names are stored packed in this game and can't be renamed yet.</span>
      </div>
    )
  }
  const commit = () => {
    if (draft === entry.name) return
    const ok = adapter.setMoveName(id, draft)
    setError(!ok)
    if (ok) onEdit()
    else setDraft(entry.name)
  }
  return (
    <div className="name-editor">
      <input
        className={`name-input ${error ? 'invalid' : ''}`}
        value={draft}
        maxLength={adapter.moveNameLength}
        onChange={(e) => { setError(false); setDraft(e.target.value) }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="name-hint">
        {error
          ? 'That name contains characters this game cannot display.'
          : `Click to rename · up to ${adapter.moveNameLength} characters`}
      </span>
    </div>
  )
}

export function MovesPanel({ adapter, onEdit }: { adapter: GameAdapter; onEdit: () => void }) {
  const [selected, setSelected] = useState<number>(adapter.moves[0]?.id ?? 1)

  if (adapter.moves.length === 0) {
    return (
      <div className="panel-message">
        The move data table couldn't be located in this ROM, so move editing is disabled.
      </div>
    )
  }
  if (adapter.moveFields.length === 0) {
    return (
      <div className="panel-message">
        Move names were read from this game's text banks and appear in the trainer editor —
        editing move data itself for this game is still on the roadmap.
      </div>
    )
  }

  const data = adapter.readMove(selected)
  const write = (key: string, value: (typeof data)[string]) => {
    adapter.writeMoveField(selected, key, value)
    onEdit()
  }

  return (
    <div className="editor-layout">
      <EntryList
        entries={adapter.moves}
        selected={selected}
        onSelect={setSelected}
        placeholder="Search moves…"
      />
      <div className="detail" key={selected}>
        <div className="detail-header">
          <MoveNameEditor adapter={adapter} id={selected} onEdit={onEdit} />
          <button className="ghost" onClick={() => { adapter.revertMove(selected); onEdit() }}>
            Revert this move
          </button>
        </div>
        <section className="card">
          <h3>Move data</h3>
          <div className="field-grid">
            {adapter.moveFields
              .filter((s) => s.kind !== 'flags')
              .map((spec) => (
                <FieldEditor
                  key={spec.key}
                  adapter={adapter}
                  spec={spec}
                  value={data[spec.key] ?? 0}
                  onChange={(v) => write(spec.key, v)}
                />
              ))}
          </div>
          {adapter.moveFields
            .filter((s) => s.kind === 'flags')
            .map((spec) => (
              <div key={spec.key} className="flags-section">
                <h4>{spec.label}</h4>
                <FieldEditor
                  adapter={adapter}
                  spec={spec}
                  value={data[spec.key] ?? []}
                  onChange={(v) => write(spec.key, v)}
                />
              </div>
            ))}
        </section>
      </div>
    </div>
  )
}
