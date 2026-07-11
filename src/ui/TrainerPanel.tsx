import { useState } from 'react'
import type { GameAdapter } from '../core/games/schema'
import { GEN3_AI_FLAG_LABELS } from '../core/games/gen3-constants'
import { EntryList } from './EntryList'

function Num({
  label,
  value,
  min,
  max,
  onChange,
  help,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (v: number) => void
  help?: string
}) {
  return (
    <label className="field" title={help}>
      <span className="field-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value))
          if (Number.isFinite(n)) onChange(n)
        }}
      />
      {help && <span className="field-help">{help}</span>}
    </label>
  )
}

function Options({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: number
  options: { value: number; label: string }[]
  onChange: (v: number) => void
}) {
  const known = options.some((o) => o.value === value)
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {!known && <option value={value}>Unknown ({value})</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function TrainerPanel({ adapter, onEdit }: { adapter: GameAdapter; onEdit: () => void }) {
  const module = adapter.trainerModule!
  const [selected, setSelected] = useState(module.entries.find((e) => e.name.trim())?.id ?? 0)
  const [nameError, setNameError] = useState(false)

  const data = module.read(selected)
  const party = module.party(selected)
  const speciesOptions = adapter.species.map((s) => ({ value: s.id, label: s.name }))
  const moveOptions = [{ value: 0, label: '— none —' }, ...adapter.moves.map((m) => ({ value: m.id, label: m.name }))]
  const itemOptions = adapter.itemOptions ?? []

  const write = (field: string, value: number) => {
    module.write(selected, field, value)
    onEdit()
  }
  const writeParty = (slot: number, field: string, value: number) => {
    module.writePartyField(selected, slot, field, value)
    onEdit()
  }

  return (
    <div className="editor-layout">
      <EntryList
        entries={module.entries}
        selected={selected}
        onSelect={(id) => {
          setSelected(id)
          setNameError(false)
        }}
        placeholder="Search trainers…"
      />
      <div className="detail" key={selected}>
        <div className="detail-header">
          {module.nameLength === 0 ? (
            <div>
              <h2 className="entry-title">{data.name}</h2>
              <span className="name-hint">Trainer #{selected} · names live in the text banks (not editable yet)</span>
            </div>
          ) : (
          <div className="name-editor">
            <input
              className={`name-input ${nameError ? 'invalid' : ''}`}
              defaultValue={data.name}
              maxLength={module.nameLength}
              onBlur={(e) => {
                if (e.target.value === data.name) return
                const ok = module.setName(selected, e.target.value)
                setNameError(!ok)
                if (ok) onEdit()
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="name-hint">
              {nameError
                ? 'That name contains characters this game cannot display.'
                : `Trainer #${selected} · click to rename`}
            </span>
          </div>
          )}
          <button className="ghost" onClick={() => { module.revert(selected); onEdit() }}>
            Revert this trainer
          </button>
        </div>

        <section className="card">
          <h3>Trainer</h3>
          <div className="field-grid">
            {module.classOptions ? (
              <Options label="Class" value={data.trainerClass} options={module.classOptions} onChange={(v) => write('trainerClass', v)} />
            ) : (
              <Num label="Class ID" value={data.trainerClass} min={0} max={255} onChange={(v) => write('trainerClass', v)} help="Determines title & prize money." />
            )}
            <Num label="Sprite ID" value={data.pic} min={0} max={255} onChange={(v) => write('pic', v)} />
            <Options
              label="Gender"
              value={data.gender}
              options={[{ value: 0, label: 'Male' }, { value: 1, label: 'Female' }]}
              onChange={(v) => write('gender', v)}
            />
            <Num label="Encounter music" value={data.music} min={0} max={127} onChange={(v) => write('music', v)} />
            <Options
              label="Battle type"
              value={data.doubleBattle}
              options={[{ value: 0, label: 'Single battle' }, { value: 1, label: 'Double battle' }]}
              onChange={(v) => write('doubleBattle', v)}
            />
          </div>
          <h4>Battle AI</h4>
          <div className="flags-grid">
            {GEN3_AI_FLAG_LABELS.map((label, bit) => (
              <label key={bit} className={`flag ${(data.aiFlags >> bit) & 1 ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={((data.aiFlags >> bit) & 1) === 1}
                  onChange={(e) => {
                    const next = e.target.checked ? data.aiFlags | (1 << bit) : data.aiFlags & ~(1 << bit)
                    write('aiFlags', next >>> 0)
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <h4>Battle items</h4>
          <div className="field-grid">
            {data.items.map((item, i) =>
              itemOptions.length > 0 ? (
                <Options key={i} label={`Item ${i + 1}`} value={item} options={itemOptions}
                  onChange={(v) => { module.setItem(selected, i, v); onEdit() }} />
              ) : (
                <Num key={i} label={`Item ${i + 1}`} value={item} min={0} max={65535}
                  onChange={(v) => { module.setItem(selected, i, v); onEdit() }} />
              ),
            )}
          </div>
        </section>

        <section className="card">
          <h3>
            Party
            <span className="bst">
              {data.partySize} of max {data.maxPartySize} Pokémon
            </span>
          </h3>
          <div className="field-grid" style={{ marginBottom: 12 }}>
            <Num label="Party size" value={data.partySize} min={1} max={data.maxPartySize}
              onChange={(v) => write('partySize', v)}
              help="Can't grow beyond the space the game originally reserved." />
          </div>
          <div className="party-grid">
            {party.map((mon, i) => (
              <div className="event-card" key={i}>
                <h4>Slot {i + 1}</h4>
                <Options label="Pokémon" value={mon.species} options={speciesOptions}
                  onChange={(v) => writeParty(i, 'species', v)} />
                <Num label="Level" value={mon.level} min={1} max={100} onChange={(v) => writeParty(i, 'level', v)} />
                <Num label="IV strength" value={mon.iv} min={0} max={255} onChange={(v) => writeParty(i, 'iv', v)} />
                {mon.item !== null &&
                  (itemOptions.length > 0 ? (
                    <Options label="Held item" value={mon.item} options={itemOptions} onChange={(v) => writeParty(i, 'item', v)} />
                  ) : (
                    <Num label="Held item" value={mon.item} min={0} max={65535} onChange={(v) => writeParty(i, 'item', v)} />
                  ))}
                {mon.moves?.map((mv, m) => (
                  <Options key={m} label={`Move ${m + 1}`} value={mv} options={moveOptions}
                    onChange={(v) => writeParty(i, `move${m}`, v)} />
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
