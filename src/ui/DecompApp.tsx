import { useMemo, useState } from 'react'
import {
  parseSpeciesInfo,
  numericValue,
  setNumericField,
  prettySpeciesName,
  NUMERIC_FIELDS,
  INFO_FIELDS,
  type DecompSpecies,
} from '../decomp/speciesInfo'

/** Candidate species data files across pret projects. */
const SPECIES_FILES = [
  ['src', 'data', 'pokemon', 'species_info.h'],
  ['src', 'data', 'pokemon', 'base_stats.h'],
]

export interface DecompProject {
  dirName: string
  fileName: string
  fileHandle: FileSystemFileHandle
  text: string
}

/** Minimal typings for the File System Access API (Chromium). */
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: string }) => Promise<FileSystemDirectoryHandle>
  }
}

export function decompSupported(): boolean {
  return typeof window !== 'undefined' && !!window.showDirectoryPicker
}

export async function openDecompProject(): Promise<DecompProject | null> {
  const dir = await window.showDirectoryPicker!({ mode: 'readwrite' })
  for (const path of SPECIES_FILES) {
    try {
      let handle: FileSystemDirectoryHandle = dir
      for (const part of path.slice(0, -1)) handle = await handle.getDirectoryHandle(part)
      const fileHandle = await handle.getFileHandle(path[path.length - 1])
      const text = await (await fileHandle.getFile()).text()
      return { dirName: dir.name, fileName: path[path.length - 1], fileHandle, text }
    } catch {
      continue
    }
  }
  throw new Error(
    'No species data file found — pick the root folder of a pokeemerald or pokefirered source tree.',
  )
}

export function DecompApp({ project, onClose }: { project: DecompProject; onClose: () => void }) {
  const [text, setText] = useState(project.text)
  const [selected, setSelected] = useState(1)
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  const species = useMemo(() => parseSpeciesInfo(text), [text])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? species.filter((s) => s.species.toLowerCase().includes(q)) : species
  }, [species, query])

  const entry: DecompSpecies | undefined = species[selected]

  const write = (key: string, value: number) => {
    if (!entry) return
    const next = setNumericField(text, entry, key, value)
    if (next !== null) {
      setText(next)
      setDirty((d) => d + 1)
      setStatus(null)
    }
  }

  const save = async () => {
    try {
      const writable = await project.fileHandle.createWritable()
      await writable.write(text)
      await writable.close()
      setDirty(0)
      setStatus(`Saved ${project.fileName}. Rebuild the project (make) to see changes in game.`)
    } catch (e) {
      setStatus(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const bst = entry
    ? NUMERIC_FIELDS.slice(0, 6).reduce((sum, f) => sum + (numericValue(entry, f.key) ?? 0), 0)
    : 0

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="logo-ball" /> Global ROM Editor
        </span>
        <span className="game-badge">📁 {project.dirName} (decomp project)</span>
        <span className="spacer" />
        <span className="dirty">{dirty > 0 ? `${dirty} unsaved edit(s)` : 'No edits yet'}</span>
        <button className="primary" onClick={save} disabled={dirty === 0}>
          💾 Save file
        </button>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <main className="content">
        <div className="editor-layout">
          <div className="entry-list">
            <input
              className="search"
              type="search"
              placeholder="Search species…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="entry-scroll">
              {filtered.map((s) => (
                <button
                  key={s.species}
                  className={`entry ${species.indexOf(s) === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(species.indexOf(s))}
                >
                  {prettySpeciesName(s.species)}
                </button>
              ))}
            </div>
          </div>
          <div className="detail">
            {status && <div className="notice ok">{status}</div>}
            {entry && (
              <>
                <div className="detail-header">
                  <h2 className="entry-title">{prettySpeciesName(entry.species)}</h2>
                  <span className="muted">editing {project.fileName}</span>
                </div>
                <section className="card">
                  <h3>
                    Base stats & battle <span className="bst">BST: {bst}</span>
                  </h3>
                  <div className="field-grid">
                    {NUMERIC_FIELDS.map((f) => {
                      const v = numericValue(entry, f.key)
                      if (v === null) return null
                      return (
                        <label className="field" key={f.key}>
                          <span className="field-label">{f.label}</span>
                          <input
                            type="number"
                            min={0}
                            max={f.max}
                            value={v}
                            onChange={(e) => {
                              const n = Math.round(Number(e.target.value))
                              if (Number.isFinite(n)) write(f.key, Math.max(0, Math.min(f.max, n)))
                            }}
                          />
                        </label>
                      )
                    })}
                  </div>
                </section>
                <section className="card">
                  <h3>Other properties (read-only for now)</h3>
                  <table className="info-table">
                    <tbody>
                      {INFO_FIELDS.filter((k) => entry.fields.has(k)).map((k) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td className="mono">{entry.fields.get(k)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted">
                    Constant-expression fields become editable dropdowns in a later release. Edits
                    keep the file's formatting, so your git diff stays clean.
                  </p>
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
