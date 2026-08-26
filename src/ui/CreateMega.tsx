import { useMemo, useState } from 'react'
import type { GameAdapter } from '../core/games/schema'

/**
 * Builds a Mega form from an existing species in one step.
 *
 * The tedious part of a custom Mega is not the idea, it is retyping a
 * species: stats, types, abilities, EV yield, breeding data, name and
 * sprites, then the trigger and the two entries that change it back.
 * This copies all of it and wires the trigger.
 *
 * It has to OVERWRITE a species, because a ROM cannot gain one - the
 * species count is compiled into the game's own bounds checks. So the
 * slot it writes into is chosen explicitly and named in the warning,
 * rather than picked quietly.
 */
export function CreateMega({
  adapter,
  speciesId,
  onEdit,
}: {
  adapter: GameAdapter
  speciesId: number
  onEdit: () => void
}) {
  const formChanges = adapter.formChanges
  const [open, setOpen] = useState(false)
  const [slot, setSlot] = useState('')
  const [stone, setStone] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const base = adapter.species.find((s) => s.id === speciesId)
  const megaFlagIndex = adapter.speciesFields
    .find((f) => f.key === 'formFlags')
    ?.flagLabels?.indexOf('Mega evolution') ?? -1

  // Every species a form change already points at, so the list can say
  // which slots are spoken for.
  const targeted = useMemo(() => {
    const seen = new Set<number>()
    if (!formChanges) return seen
    for (const s of adapter.species) for (const e of formChanges.read(s.id)) seen.add(e.target)
    return seen
  }, [adapter, formChanges])

  const candidates = useMemo(
    () =>
      adapter.species
        .filter((s) => s.id !== speciesId)
        .map((s) => ({
          id: s.id,
          label: `${s.displayName ?? s.name}${targeted.has(s.id) ? '' : ' — unused'}`,
          free: !targeted.has(s.id),
        }))
        .sort((a, b) => Number(b.free) - Number(a.free)),
    [adapter, speciesId, targeted],
  )

  if (!formChanges || megaFlagIndex < 0 || !base) return null

  const create = () => {
    const target = Number(slot)
    const item = Number(stone)
    if (!target || !item) return setStatus('Pick a slot and a stone first.')

    // 1. Copy every editable field off the base species.
    const source = adapter.readSpecies(speciesId)
    for (const field of adapter.speciesFields) {
      if (field.key === 'formFlags') continue
      const value = source[field.key]
      if (value !== undefined) adapter.writeSpeciesField(target, field.key, value)
    }

    // 2. Same name - the Mega flag is what tells the forms apart.
    adapter.setSpeciesName(target, base.name)

    // 3. The flag itself, which drives the battle indicator, the cry and
    //    the Pokedex, not just the label.
    const flags = (adapter.readSpecies(target).formFlags as boolean[]).slice()
    flags[megaFlagIndex] = true
    adapter.writeSpeciesField(target, 'formFlags', flags)

    // 4. Sprites, so the form is not left wearing whatever was there.
    const front = adapter.speciesSprite?.(speciesId)
    if (front && adapter.importSpeciesSprite) adapter.importSpeciesSprite(target, front)
    const back = adapter.speciesSpriteBack?.(speciesId)
    if (back && adapter.importSpeciesSpriteBack) adapter.importSpeciesSpriteBack(target, back)

    // 5. The trigger, then the two entries that change it back. Without
    //    those the Mega is permanent - it survives fainting and the end
    //    of the battle.
    const before = formChanges.read(speciesId).length
    if (!formChanges.add(speciesId, 14)) return setStatus('No free space for the form-change table.')
    formChanges.write(speciesId, before, 'param0', item)
    formChanges.write(speciesId, before, 'target', target)
    if (!formChanges.read(speciesId).some((e) => e.method === 5)) {
      if (formChanges.add(speciesId, 5))
        formChanges.write(speciesId, formChanges.read(speciesId).length - 1, 'target', speciesId)
    }
    if (!formChanges.read(speciesId).some((e) => e.method === 7)) {
      if (formChanges.add(speciesId, 7))
        formChanges.write(speciesId, formChanges.read(speciesId).length - 1, 'target', speciesId)
    }

    onEdit()
    setOpen(false)
    setStatus(null)
  }

  const chosen = candidates.find((c) => c.id === Number(slot))

  return (
    <section className="card">
      <h3>Mega Evolution</h3>
      {!open ? (
        <>
          <p className="muted small">
            Copies this species into another slot as a Mega form, sets the Mega flag, and wires the
            stone and the entries that change it back.
          </p>
          <button className="ghost" onClick={() => setOpen(true)}>Create a Mega form…</button>
        </>
      ) : (
        <div className="field-grid">
          <label className="field">
            <span className="field-label">Slot to use</span>
            <select value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">Choose a species to overwrite…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <span className="field-help">
              A ROM cannot gain a species, so this overwrites one. Unused slots are listed first.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Mega stone</span>
            <select value={stone} onChange={(e) => setStone(e.target.value)}>
              <option value="">Choose an item…</option>
              {(adapter.itemOptions ?? []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="field-help">Any item works; the game only compares its id.</span>
          </label>
          {chosen && !chosen.free && (
            <div className="notice">
              This replaces <strong>{chosen.label}</strong>, which something already points at.
              Revert that species to undo.
            </div>
          )}
          <div className="script-step-row">
            <button className="primary" onClick={create}>Create</button>
            <button className="ghost" onClick={() => { setOpen(false); setStatus(null) }}>Cancel</button>
          </div>
        </div>
      )}
      {status && <div className="notice err">{status}</div>}
    </section>
  )
}
