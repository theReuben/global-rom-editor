import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { GameAdapter, MapModule } from '../core/games/schema'
import { GEN3_MOVEMENT_TYPES } from '../core/games/gen3-constants'
import { ScriptBuilder } from './ScriptBuilder'
import { ScriptEditor } from './ScriptEditor'
import { ShopCard } from './ShopCard'

type Tool = 'paint' | 'inspect'

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

function EventMarkers({
  adapter,
  module,
  mapKey,
  zoom,
  onOpenTrainer,
}: {
  adapter: GameAdapter
  module: MapModule
  mapKey: string
  zoom: number
  onOpenTrainer?: (id: number) => void
}) {
  const events = module.events(mapKey)
  const trainers = useMemo(() => trainersOnMap(adapter, mapKey), [adapter, mapKey])
  const marker = (x: number, y: number, cls: string, text: string, title: string, k: string) => (
    <div
      key={k}
      className={`map-marker ${cls}`}
      title={title}
      style={{ left: x * 16 * zoom, top: y * 16 * zoom, width: 16 * zoom, height: 16 * zoom }}
    >
      {text}
    </div>
  )
  return (
    <>
      {events.npcs.map((e, i) => {
        const t = trainers.get(i)
        if (!t) return marker(e.x, e.y, 'npc', 'N', `NPC ${i} (sprite ${e.graphicsId})`, `n${i}`)
        return (
          <button
            key={`n${i}`}
            type="button"
            className="map-marker npc trainer"
            title={`${t.name} — trainer #${t.id}. Click to open.`}
            style={{ left: e.x * 16 * zoom, top: e.y * 16 * zoom, width: 16 * zoom, height: 16 * zoom }}
            onClick={(ev) => {
              ev.stopPropagation()
              onOpenTrainer?.(t.id)
            }}
          >
            <span className="marker-glyph">T</span>
            <span className="marker-name">{t.name}</span>
          </button>
        )
      })}
      {events.warps.map((e, i) =>
        marker(e.x, e.y, 'warp', 'W', `Warp ${i} → map ${e.targetBank}.${e.targetMap}`, `w${i}`),
      )}
      {events.signs.map((e, i) => marker(e.x, e.y, 'sign', 'S', `Sign ${i}`, `s${i}`))}
    </>
  )
}

function EventList({
  adapter,
  module,
  mapKey,
  onEdit,
}: {
  adapter: GameAdapter
  module: MapModule
  mapKey: string
  onEdit: () => void
}) {
  const events = module.events(mapKey)
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
      <ShopCard adapter={adapter} mapKey={mapKey} onEdit={onEdit} />

      {scriptTarget &&
        // An event that already has a script opens in the command editor,
        // which can show anything the game runs. The step builder is for
        // events with no script, where there is nothing to preserve.
        (module.readScriptCommands(mapKey, scriptTarget.kind, scriptTarget.index) ? (
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
        ))}
      {events.npcs.map((e, i) => (
        <div className="event-card" key={`n${i}`}>
          <h4>
            🧍 NPC {i} {scriptBtn('npc', i)} {removeBtn('npc', i)}
          </h4>
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
        <div className="event-card" key={`w${i}`}>
          <h4>🌀 Warp {i} {removeBtn('warp', i)}</h4>
          {num('warp', i, 'x', e.x, 'X')}
          {num('warp', i, 'y', e.y, 'Y')}
          {num('warp', i, 'targetBank', e.targetBank, 'To bank')}
          {num('warp', i, 'targetMap', e.targetMap, 'To map')}
          {num('warp', i, 'warpId', e.warpId, 'To warp')}
        </div>
      ))}
      {events.signs.map((e, i) => (
        <div className="event-card" key={`s${i}`}>
          <h4>
            🪧 Sign {i} {scriptBtn('sign', i)} {removeBtn('sign', i)}
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
  const [renderError, setRenderError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const mapCanvas = useRef<HTMLCanvasElement>(null)
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
          <div className="map-scroll">
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
                  onOpenTrainer={onOpenTrainer}
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
        <h3>Events</h3>
        <EventList adapter={adapter} module={module} mapKey={mapKey} onEdit={bump} />
      </div>
    </div>
  )
}
