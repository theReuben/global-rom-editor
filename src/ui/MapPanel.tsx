import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { GameAdapter, MapModule } from '../core/games/schema'
import { GEN3_MOVEMENT_TYPES } from '../core/games/gen3-constants'
import { ScriptBuilder } from './ScriptBuilder'
import { ScriptEditor } from './ScriptEditor'
import { ShopCard } from './ShopCard'
import { ItemsCard } from './ItemsCard'

type Tool = 'paint' | 'inspect'

type EventKind = 'npc' | 'warp' | 'sign'
/** Which event both the map and the side list are pointing at. */
interface EventRef {
  kind: EventKind
  index: number
}

const BLOCKS_PER_ROW = 8

function drawImage(
  canvas: HTMLCanvasElement | null,
  img: { pixels: Uint8ClampedArray; width: number; height: number },
) {
  if (!canvas || img.width === 0 || img.height === 0) return
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  // Copy into a fresh ArrayBuffer-backed array (ImageData rejects ArrayBufferLike).
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.pixels), img.width, img.height), 0, 0)
}

/**
 * Trainers standing on this map, keyed by their object-event index, so a
 * marker can name whoever it represents. Trainers assigned at run time
 * (Battle Frontier and similar) are absent from the index and stay
 * anonymous rather than being guessed at.
 */
function trainersOnMap(adapter: GameAdapter, mapKey: string): Map<number, { id: number; name: string }> {
  const out = new Map<number, { id: number; name: string }>()
  const locations = adapter.trainerLocations
  const trainers = adapter.trainerModule
  if (!locations || !trainers) return out
  for (const [id, spots] of locations) {
    for (const spot of spots) {
      if (spot.mapKey === mapKey) out.set(spot.eventIndex, { id, name: trainers.entries[id]?.name || `Trainer ${id}` })
    }
  }
  return out
}

/**
 * The markers on the map and the cards in the side list are the same
 * events, so both are labelled with the same number and clicking either
 * highlights the other. Without that the list is just an unordered pile
 * of coordinates with no way to tell which figure on the map it means.
 */
function EventMarkers({
  adapter,
  module,
  mapKey,
  zoom,
  selected,
  onSelect,
}: {
  adapter: GameAdapter
  module: MapModule
  mapKey: string
  zoom: number
  selected: EventRef | null
  onSelect: (ref: EventRef) => void
}) {
  const events = module.events(mapKey)
  const trainers = useMemo(() => trainersOnMap(adapter, mapKey), [adapter, mapKey])
  // Pickups are ordinary events - a Ball is an NPC - so without this
  // they are indistinguishable from the people standing around.
  const items = useMemo(() => {
    const out = new Map<string, string>()
    const names = adapter.itemOptions
    for (const it of module.readItems(mapKey)) {
      const name = names?.find((o) => o.value === it.item)?.label ?? `item #${it.item}`
      out.set(`${it.event.kind}${it.event.index}`, name)
    }
    return out
  }, [adapter, module, mapKey])
  const marker = (
    kind: EventKind,
    index: number,
    x: number,
    y: number,
    title: string,
    body: React.ReactNode,
    extra = '',
  ) => (
    <button
      key={`${kind}${index}`}
      type="button"
      className={`map-marker ${kind} ${extra} ${
        selected?.kind === kind && selected.index === index ? 'selected' : ''
      }`}
      title={title}
      style={{ left: x * 16 * zoom, top: y * 16 * zoom, width: 16 * zoom, height: 16 * zoom }}
      onClick={(ev) => {
        ev.stopPropagation()
        onSelect({ kind, index })
      }}
    >
      {body}
    </button>
  )
  return (
    <>
      {events.npcs.map((e, i) => {
        const t = trainers.get(i)
        const item = items.get(`npc${i}`)
        return marker(
          'npc',
          i,
          e.x,
          e.y,
          t
            ? `NPC ${i} — ${t.name} (trainer #${t.id})`
            : item
              ? `NPC ${i} — ${item}`
              : `NPC ${i} (sprite ${e.graphicsId}) at ${e.x}, ${e.y}`,
          <>
            <span className="marker-glyph">{item && !t ? '◆' : i}</span>
            {t && <span className="marker-name">{t.name}</span>}
          </>,
          t ? 'trainer' : item ? 'item' : '',
        )
      })}
      {events.warps.map((e, i) =>
        marker(
          'warp',
          i,
          e.x,
          e.y,
          `Warp ${i} → map ${e.targetBank}.${e.targetMap}`,
          <span className="marker-glyph">{i}</span>,
        ),
      )}
      {events.signs.map((e, i) => {
        const item = items.get(`sign${i}`)
        return marker(
          'sign',
          i,
          e.x,
          e.y,
          item ? `Sign ${i} — hidden ${item}` : `Sign ${i} at ${e.x}, ${e.y}`,
          <span className="marker-glyph">{item ? '◆' : i}</span>,
          item ? 'item' : '',
        )
      })}
    </>
  )
}

function EventList({
  adapter,
  module,
  mapKey,
  onEdit,
  selected,
  onSelect,
  onOpenTrainer,
}: {
  adapter: GameAdapter
  module: MapModule
  mapKey: string
  onEdit: () => void
  selected: EventRef | null
  onSelect: (ref: EventRef) => void
  onOpenTrainer?: (id: number) => void
}) {
  const events = module.events(mapKey)
  const trainers = useMemo(() => trainersOnMap(adapter, mapKey), [adapter, mapKey])
  const cards = useRef(new Map<string, HTMLDivElement>())
  // Picking a marker on the map has to bring its card into view, or the
  // highlight lands somewhere off-screen in a long list.
  useEffect(() => {
    if (!selected) return
    cards.current
      .get(`${selected.kind}${selected.index}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])
  const cardProps = (kind: EventKind, i: number) => ({
    className: `event-card ${selected?.kind === kind && selected.index === i ? 'selected' : ''}`,
    ref: (el: HTMLDivElement | null) => {
      if (el) cards.current.set(`${kind}${i}`, el)
      else cards.current.delete(`${kind}${i}`)
    },
    onClick: () => onSelect({ kind, index: i }),
  })
  const [scriptTarget, setScriptTarget] = useState<{ kind: 'npc' | 'sign'; index: number } | null>(null)
  const num = (
    kind: 'npc' | 'warp' | 'sign',
    index: number,
    field: string,
    value: number,
    label: string,
  ) => (
    <label className="event-field" key={field}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isFinite(n)) return
          module.updateEvent(mapKey, kind, index, field, Math.round(n))
          onEdit()
        }}
      />
    </label>
  )

  const addButtons = (
    <div className="button-row" style={{ marginBottom: 8 }}>
      {(['npc', 'warp', 'sign'] as const).map((kind) => (
        <button
          key={kind}
          onClick={() => {
            if (module.addEvent(mapKey, kind)) onEdit()
          }}
        >
          + {kind.toUpperCase()}
        </button>
      ))}
    </div>
  )

  if (events.npcs.length + events.warps.length + events.signs.length === 0) {
    return (
      <div>
        {addButtons}
        <p className="muted">This map has no NPCs, warps or signs yet.</p>
      </div>
    )
  }
  const removeBtn = (kind: 'npc' | 'warp' | 'sign', i: number) => (
    <button
      className="ghost event-remove"
      title="Remove"
      onClick={() => {
        module.removeEvent(mapKey, kind, i)
        setScriptTarget(null)
        onEdit()
      }}
    >
      ✕
    </button>
  )
  const scriptBtn = (kind: 'npc' | 'sign', i: number) => (
    <button className="ghost" onClick={() => setScriptTarget({ kind, index: i })}>
      ✨ Script
    </button>
  )
  return (
    <div className="event-list">
      {addButtons}
      {scriptTarget &&
        // An event that already has a script opens in the command editor,
        // which can show anything the game runs. The step builder is for
        // events with no script, where there is nothing to preserve.
        // A script is far too wide for the side panel, so it opens over
        // the map instead of inside the list.
        (
          <div className="modal-backdrop" onClick={() => setScriptTarget(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              {module.readScriptCommands(mapKey, scriptTarget.kind, scriptTarget.index) ? (
                <ScriptEditor
                  adapter={adapter}
                  mapKey={mapKey}
                  target={scriptTarget}
                  onEdit={onEdit}
                  onClose={() => setScriptTarget(null)}
                />
              ) : (
                <ScriptBuilder
                  existing={module.readScript(mapKey, scriptTarget.kind, scriptTarget.index)}
                  adapter={adapter}
                  onApply={(steps) => {
                    const ok = module.attachScript(mapKey, scriptTarget.kind, scriptTarget.index, steps)
                    if (ok) onEdit()
                    return ok
                  }}
                  onClose={() => setScriptTarget(null)}
                />
              )}
            </div>
          </div>
        )}
      {events.npcs.map((e, i) => (
        <div {...cardProps('npc', i)} key={`n${i}`}>
          <h4>
            <span className="event-tag npc">{i}</span> NPC {scriptBtn('npc', i)} {removeBtn('npc', i)}
          </h4>
          {trainers.get(i) && (
            <button className="ghost small" onClick={() => onOpenTrainer?.(trainers.get(i)!.id)}>
              🎽 {trainers.get(i)!.name} — open trainer
            </button>
          )}
          {num('npc', i, 'x', e.x, 'X')}
          {num('npc', i, 'y', e.y, 'Y')}
          {num('npc', i, 'graphicsId', e.graphicsId, 'Sprite')}
          <label className="event-field">
            <span>Movement</span>
            <select
              value={e.movementType}
              onChange={(ev) => {
                module.updateEvent(mapKey, 'npc', i, 'movementType', Number(ev.target.value))
                onEdit()
              }}
            >
              {!GEN3_MOVEMENT_TYPES.some((o) => o.value === e.movementType) && (
                <option value={e.movementType}>Type {e.movementType}</option>
              )}
              {GEN3_MOVEMENT_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {num('npc', i, 'elevation', e.elevation, 'Elev.')}
        </div>
      ))}
      {events.warps.map((e, i) => (
        <div {...cardProps('warp', i)} key={`w${i}`}>
          <h4><span className="event-tag warp">{i}</span> Warp {removeBtn('warp', i)}</h4>
          {num('warp', i, 'x', e.x, 'X')}
          {num('warp', i, 'y', e.y, 'Y')}
          {num('warp', i, 'targetBank', e.targetBank, 'To bank')}
          {num('warp', i, 'targetMap', e.targetMap, 'To map')}
          {num('warp', i, 'warpId', e.warpId, 'To warp')}
        </div>
      ))}
      {events.signs.map((e, i) => (
        <div {...cardProps('sign', i)} key={`s${i}`}>
          <h4>
            <span className="event-tag sign">{i}</span> Sign {scriptBtn('sign', i)} {removeBtn('sign', i)}
          </h4>
          {num('sign', i, 'x', e.x, 'X')}
          {num('sign', i, 'y', e.y, 'Y')}
          {num('sign', i, 'kind', e.kind, 'Kind')}
        </div>
      ))}
    </div>
  )
}

function ResizeControl({
  module,
  mapKey,
  onEdit,
}: {
  module: MapModule
  mapKey: string
  onEdit: () => void
}) {
  const d = module.describe(mapKey)
  const [w, setW] = useState(d.widthBlocks)
  const [h, setH] = useState(d.heightBlocks)
  const [error, setError] = useState(false)
  return (
    <div className="resize-control">
      <input type="number" min={1} max={255} value={w} onChange={(e) => setW(Number(e.target.value))} />
      ×
      <input type="number" min={1} max={255} value={h} onChange={(e) => setH(Number(e.target.value))} />
      <button
        disabled={w === d.widthBlocks && h === d.heightBlocks}
        onClick={() => {
          const ok = module.resize(mapKey, w, h)
          setError(!ok)
          if (ok) onEdit()
        }}
      >
        Resize
      </button>
      {error && <span className="name-hint">Not enough free ROM space.</span>}
    </div>
  )
}

export function MapPanel({
  adapter,
  onEdit,
  focusMapKey,
  onOpenTrainer,
}: {
  adapter: GameAdapter
  onEdit: () => void
  /** Map to open on mount, e.g. when arriving from a trainer's location. */
  focusMapKey?: string | null
  onOpenTrainer?: (id: number) => void
}) {
  const module = adapter.mapModule!
  const [mapKey, setMapKey] = useState(focusMapKey ?? module.entries[0]?.key ?? '')
  const [query, setQuery] = useState('')
  const [tool, setTool] = useState<Tool>('paint')
  const [selectedBlock, setSelectedBlock] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [showEvents, setShowEvents] = useState(true)
  const [inspected, setInspected] = useState<{ x: number; y: number } | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventRef | null>(null)
  const [sideTab, setSideTab] = useState<'events' | 'items' | 'blocks'>('events')
  const [renderError, setRenderError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const mapCanvas = useRef<HTMLCanvasElement>(null)
  const mapScroll = useRef<HTMLDivElement>(null)
  const blockCanvas = useRef<HTMLCanvasElement>(null)
  const painting = useRef(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? module.entries.filter((e) => e.label.toLowerCase().includes(q)) : module.entries
  }, [module, query])

  const bump = () => {
    setTick((t) => t + 1)
    onEdit()
  }

  useEffect(() => {
    try {
      drawImage(mapCanvas.current, module.render(mapKey))
      setRenderError(null)
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e))
    }
  }, [module, mapKey, tick])

  useEffect(() => {
    try {
      drawImage(blockCanvas.current, module.renderBlocks(mapKey, BLOCKS_PER_ROW))
    } catch {
      /* map render error already shown */
    }
  }, [module, mapKey])

  if (module.entries.length === 0) {
    return <div className="panel-message">No maps were discovered in this ROM.</div>
  }

  const cellFromMouse = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = e.currentTarget.width / rect.width
    const scaleY = e.currentTarget.height / rect.height
    return {
      x: Math.floor(((e.clientX - rect.left) * scaleX) / 16),
      y: Math.floor(((e.clientY - rect.top) * scaleY) / 16),
    }
  }

  const applyTool = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const { x, y } = cellFromMouse(e)
    const d = module.describe(mapKey)
    if (x < 0 || y < 0 || x >= d.widthBlocks || y >= d.heightBlocks) return
    if (tool === 'paint') {
      module.paint(mapKey, x, y, selectedBlock)
      bump()
    } else {
      setInspected({ x, y })
    }
  }

  const desc = module.describe(mapKey)
  /**
   * Scale the map to the space it has. Big routes are 100 blocks wide
   * and small interiors a dozen, so a fixed 1x/2x/3x either overflows
   * or wastes most of the panel.
   */
  const fitZoom = () => {
    const box = mapScroll.current
    if (!box) return
    const scale = (box.clientWidth - 24) / (desc.widthBlocks * 16)
    setZoom(Math.max(0.25, Math.min(6, Math.round(scale * 20) / 20)))
  }
  const mapEvents = module.events(mapKey)
  const eventCount = mapEvents.npcs.length + mapEvents.warps.length + mapEvents.signs.length
  const itemCount = module.readItems(mapKey).length + module.readShops(mapKey).length
  const inspectedCell = inspected ? module.cell(mapKey, inspected.x, inspected.y) : null

  return (
    <div className="map-layout">
      <div className="entry-list">
        <input
          className="search"
          type="search"
          placeholder="Search maps…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="entry-scroll">
          {filtered.map((e) => (
            <button
              key={e.key}
              className={`entry ${mapKey === e.key ? 'selected' : ''}`}
              onClick={() => {
                setMapKey(e.key)
                setInspected(null)
                setSelectedEvent(null)
              }}
            >
              🗺️ {e.label}
            </button>
          ))}
        </div>
      </div>

      <div className="map-main">
        <div className="map-toolbar">
          <div className="tool-group">
            <button className={tool === 'paint' ? 'primary' : ''} onClick={() => setTool('paint')}>
              🖌️ Paint
            </button>
            <button className={tool === 'inspect' ? 'primary' : ''} onClick={() => setTool('inspect')}>
              🔍 Inspect
            </button>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} />
            Show NPCs / warps / signs
          </label>
          <div className="tool-group">
            {[1, 2, 3].map((z) => (
              <button key={z} className={zoom === z ? 'primary' : ''} onClick={() => setZoom(z)}>
                {z}×
              </button>
            ))}
            <button
              className={![1, 2, 3].includes(zoom) ? 'primary' : ''}
              title="Scale the map to fit the space"
              onClick={fitZoom}
            >
              ⤢ Fit
            </button>
          </div>
          <span className="muted">
            {desc.widthBlocks}×{desc.heightBlocks} blocks · painting block #{selectedBlock}
          </span>
          <button
            className="ghost"
            onClick={() => {
              module.revertBlocks(mapKey)
              bump()
            }}
          >
            Revert layout edits
          </button>
          <button
            title="Create a brand-new map in this bank, starting from a copy of this one"
            onClick={() => {
              const newKey = module.duplicateMap(mapKey)
              if (newKey) {
                setMapKey(newKey)
                bump()
              }
            }}
          >
            ⧉ New map from this
          </button>
        </div>

        {renderError ? (
          <div className="notice err">Couldn't render this map: {renderError}</div>
        ) : (
          <div className="map-scroll" ref={mapScroll}>
            <div className="map-stage" style={{ width: desc.widthBlocks * 16 * zoom }}>
              <canvas
                ref={mapCanvas}
                className="map-canvas"
                style={{ width: desc.widthBlocks * 16 * zoom, height: desc.heightBlocks * 16 * zoom }}
                onMouseDown={(e) => {
                  painting.current = true
                  applyTool(e)
                }}
                onMouseMove={(e) => {
                  if (painting.current && tool === 'paint') applyTool(e)
                }}
                onMouseUp={() => (painting.current = false)}
                onMouseLeave={() => (painting.current = false)}
              />
              {showEvents && (
                <EventMarkers
                  adapter={adapter}
                  module={module}
                  mapKey={mapKey}
                  zoom={zoom}
                  selected={selectedEvent}
                  onSelect={setSelectedEvent}
                />
              )}
            </div>
          </div>
        )}

        {inspectedCell && inspected && (
          <div className="inspect-bar">
            <span>
              Cell ({inspected.x}, {inspected.y}) — block <strong>#{inspectedCell.blockId}</strong>
            </span>
            <label className="event-field">
              <span>Movement permission</span>
              <input
                type="number"
                min={0}
                max={63}
                value={inspectedCell.permission}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n)) return
                  module.setPermission(mapKey, inspected.x, inspected.y, Math.max(0, Math.min(63, n)))
                  bump()
                }}
              />
            </label>
            <button
              className="ghost"
              onClick={() => {
                setSelectedBlock(inspectedCell.blockId)
                setTool('paint')
              }}
            >
              Pick this block
            </button>
          </div>
        )}
      </div>

      <div className="map-side">
        <div className="side-tabs">
          {(
            [
              ['events', `Events (${eventCount})`],
              ['items', `Items (${itemCount})`],
              ['blocks', 'Blocks'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={sideTab === id ? 'primary' : ''}
              onClick={() => setSideTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={sideTab === 'blocks' ? '' : 'hidden'}>
        <h3>Blocks</h3>
        <p className="muted small">Click a block, then paint on the map.</p>
        <div className="block-picker">
          <canvas
            ref={blockCanvas}
            style={{ width: BLOCKS_PER_ROW * 16 * 2 }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const scaleX = e.currentTarget.width / rect.width
              const scaleY = e.currentTarget.height / rect.height
              const bx = Math.floor(((e.clientX - rect.left) * scaleX) / 16)
              const by = Math.floor(((e.clientY - rect.top) * scaleY) / 16)
              const id = by * BLOCKS_PER_ROW + bx
              if (id >= 0 && id < desc.blockCount) setSelectedBlock(id)
            }}
          />
        </div>
        <h3>Map size</h3>
        <ResizeControl module={module} mapKey={mapKey} onEdit={bump} />
        </div>

        <div className={sideTab === 'items' ? '' : 'hidden'}>
          <ShopCard adapter={adapter} mapKey={mapKey} onEdit={bump} />
          <ItemsCard adapter={adapter} mapKey={mapKey} onEdit={bump} />
          {itemCount === 0 && <p className="muted small">Nothing to pick up on this map.</p>}
        </div>

        <div className={sideTab === 'events' ? '' : 'hidden'}>
        <EventList
          adapter={adapter}
          module={module}
          mapKey={mapKey}
          onEdit={bump}
          selected={selectedEvent}
          onSelect={setSelectedEvent}
          onOpenTrainer={onOpenTrainer}
        />
        </div>
      </div>
    </div>
  )
}
