import { useState } from 'react'
import type { GameAdapter } from '../core/games/schema'
import { EntryList } from './EntryList'
import { FieldEditor } from './FieldEditor'
import { Sprite } from './Sprite'

function ItemNameEditor({
  adapter,
  id,
  onEdit,
}: {
  adapter: GameAdapter
  id: number
  onEdit: () => void
}) {
  const module = adapter.itemModule!
  const entry = module.entries[id]
  const [draft, setDraft] = useState(entry.name)
  const [error, setError] = useState(false)

  const commit = () => {
    if (draft === entry.name) return
    const ok = module.setName(id, draft)
    setError(!ok)
    if (ok) onEdit()
    else setDraft(entry.name)
  }

  return (
    <div className="name-editor">
      <input
        className={`name-input ${error ? 'invalid' : ''}`}
        value={draft}
        maxLength={module.nameLength}
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
          : `Click to rename · up to ${module.nameLength} characters`}
      </span>
    </div>
  )
}

function DescriptionEditor({
  adapter,
  id,
  onEdit,
}: {
  adapter: GameAdapter
  id: number
  onEdit: () => void
}) {
  const module = adapter.itemModule!
  const current = module.description(id)
  const [draft, setDraft] = useState(current)
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    if (draft === current) return
    if (module.setDescription(id, draft)) {
      setError(null)
      onEdit()
    } else {
      setError("Couldn't write — unsupported characters, or no free space to move the text into.")
      setDraft(current)
    }
  }

  return (
    <section className="card">
      <h3>Description</h3>
      <textarea
        className={`desc-input ${error ? 'invalid' : ''}`}
        rows={4}
        value={draft}
        onChange={(e) => {
          setError(null)
          setDraft(e.target.value)
        }}
        onBlur={commit}
      />
      <p className="muted small">
        {error ?? 'Each line break is a new line in the game’s text box — keep lines short.'}
      </p>
    </section>
  )
}

export function ItemsPanel({ adapter, onEdit }: { adapter: GameAdapter; onEdit: () => void }) {
  const module = adapter.itemModule!
  const [selected, setSelected] = useState<number>(module.entries[1] ? 1 : 0)

  const data = module.read(selected)
  const write = (key: string, value: (typeof data)[string]) => {
    module.write(selected, key, value)
    onEdit()
  }

  return (
    <div className="editor-layout">
      <EntryList
        entries={module.entries}
        selected={selected}
        onSelect={setSelected}
        placeholder="Search items…"
      />
      <div className="detail" key={selected}>
        <div className="detail-header">
          {/* The bag icon says which item this is faster than the name. */}
          <Sprite
            image={module.icon?.(selected) ?? null}
            scale={2}
            className="item-icon"
            title={module.entries[selected]?.name}
          />
          <ItemNameEditor adapter={adapter} id={selected} onEdit={onEdit} />
          <button
            className="ghost"
            onClick={() => {
              module.revert(selected)
              onEdit()
            }}
          >
            Revert this item
          </button>
        </div>
        <section className="card">
          <h3>Item data</h3>
          <div className="field-grid">
            {module.fields.map((spec) => (
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
        <DescriptionEditor adapter={adapter} id={selected} onEdit={onEdit} />
      </div>
    </div>
  )
}
