import type { GameAdapter } from '../core/games/schema'

/**
 * Every item lying around on the selected map.
 *
 * Three things end up here, because the game stores them three ways: a
 * hidden item is packed into its bg event; a Ball on the ground keeps
 * its item in the object's own template (the script is shared by every
 * Ball in the game); and an NPC's gift is a constant inside that NPC's
 * script. All three are edited the same way from here - the entry knows
 * which of the three it came from and where its bytes live.
 */
export function ItemsCard({
  adapter,
  mapKey,
  onEdit,
}: {
  adapter: GameAdapter
  mapKey: string
  onEdit: () => void
}) {
  const module = adapter.mapModule!
  const found = module.readItems(mapKey)
  const options = adapter.itemOptions ?? []

  if (found.length === 0) return null

  return (
    <section className="card">
      <h3>
        Items on this map
        <span className="bst">{found.length}</span>
      </h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Where</th>
            <th>At</th>
            <th>Item</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {found.map((entry) => (
            <tr key={`${entry.source}-${entry.id}`}>
              <td>{entry.label}</td>
              <td className="muted small">
                {entry.x}, {entry.y}
              </td>
              <td>
                <select
                  value={entry.item}
                  onChange={(e) => {
                    module.setItem(mapKey, entry.id, entry.source, Number(e.target.value))
                    onEdit()
                  }}
                >
                  {!options.some((o) => o.value === entry.item) && (
                    <option value={entry.item}>Item #{entry.item}</option>
                  )}
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </td>
              <td className="muted small">{entry.quantity > 1 ? `×${entry.quantity}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
