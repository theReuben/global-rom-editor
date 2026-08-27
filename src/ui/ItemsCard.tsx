import type { GameAdapter } from '../core/games/schema'
import { Sprite } from './Sprite'

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
  const icon = adapter.itemModule?.icon

  if (found.length === 0) return null

  return (
    <section className="card">
      <h3>
        Items on this map
        <span className="bst">{found.length}</span>
      </h3>
      <div className="map-items">
        {found.map((entry) => (
          <div className="map-item" key={`${entry.source}-${entry.id}`}>
            <div className="map-item-head">
              <Sprite image={icon?.(entry.item) ?? null} scale={1} />
              <span className={`event-tag ${entry.source === 'hidden' ? 'sign' : 'npc'}`}>
                {entry.source === 'hidden' ? 'Hidden' : entry.source === 'ball' ? 'Ball' : 'Gift'}
              </span>
              <span className="muted small">
                {entry.x}, {entry.y}
                {entry.quantity > 1 ? ` · ×${entry.quantity}` : ''}
              </span>
            </div>
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
          </div>
        ))}
      </div>
    </section>
  )
}
