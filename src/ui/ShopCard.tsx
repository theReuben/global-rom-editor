import { useState } from 'react'
import type { GameAdapter } from '../core/games/schema'

/**
 * Shop stock for the selected map.
 *
 * A shop is not a table: it is a `pokemart` script command pointing at a
 * zero-terminated item list, so one map can host several - Slateport has
 * a TM stall and a vitamin counter, and they are listed by the event
 * that runs them rather than pretending there is one shop per map.
 *
 * Decoration shops are deliberately absent. Their ids are a different
 * namespace, so editing them with an item dropdown would corrupt them.
 */
export function ShopCard({
  adapter,
  mapKey,
  onEdit,
}: {
  adapter: GameAdapter
  mapKey: string
  onEdit: () => void
}) {
  const module = adapter.mapModule!
  const shops = module.readShops(mapKey)
  const [adding, setAdding] = useState('')
  const items = adapter.itemOptions ?? []

  if (shops.length === 0) return null

  return (
    <section className="card">
      <h3>
        Shops
        <span className="bst">{shops.length}</span>
      </h3>
      {shops.map((shop) => (
        <div className="shop" key={shop.id}>
          <div className="shop-head">{shop.label}</div>
          <div className="shop-items">
            {shop.products.map((product, slot) => (
              <div className="shop-item" key={slot}>
                <select
                  value={product}
                  onChange={(e) => {
                    module.setShopProduct(mapKey, shop.id, slot, Number(e.target.value))
                    onEdit()
                  }}
                >
                  {!items.some((o) => o.value === product) && (
                    <option value={product}>Item #{product}</option>
                  )}
                  {items.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  className="ghost small"
                  title="Remove from this shop"
                  onClick={() => {
                    module.removeShopProduct(mapKey, shop.id, slot)
                    onEdit()
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {shop.products.length === 0 && <span className="muted small">Empty</span>}
          </div>
          <select
            value={adding}
            onChange={(e) => {
              if (!e.target.value) return
              const ok = module.addShopProduct(mapKey, shop.id, Number(e.target.value))
              setAdding('')
              if (ok) onEdit()
            }}
          >
            <option value="">+ Stock an item…</option>
            {items.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ))}
    </section>
  )
}
