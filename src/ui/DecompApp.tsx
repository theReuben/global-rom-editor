import { useMemo, useState } from 'react'
import {
  parseSpeciesInfo,
  numericValue,
  setNumericField,
  setConstantField,
  constantsIn,
  parseConstants,
  prettyConstant,
  prettySpeciesName,
  NUMERIC_FIELDS,
  CONST_FIELDS,
  INFO_FIELDS,
} from '../decomp/speciesInfo'

export interface DecompFile {
  name: string
  handle: FileSystemFileHandle
  text: string
}

export interface DecompProject {
  dirName: string
  files: DecompFile[]
  /** Constant names per prefix (TYPE_, ABILITY_, …) from the tree's headers. */
  constants: Record<string, string[]>
}

/** Minimal typings for the File System Access API (Chromium). */
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: string }) => Promise<FileSystemDirectoryHandle>
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>
  }
}

export function decompSupported(): boolean {
  return typeof window !== 'undefined' && !!window.showDirectoryPicker
}

async function dig(dir: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle> {
  let handle = dir
  for (const part of parts) handle = await handle.getDirectoryHandle(part)
  return handle
}

/**
 * Opens a pret source tree. Supports both vanilla (one species_info.h /
 * base_stats.h) and pokeemerald-expansion (species_info/gen_*.h with
 * 1000+ species, Megas and regional forms).
 */
export async function openDecompProject(): Promise<DecompProject | null> {
  const dir = await window.showDirectoryPicker!({ mode: 'readwrite' })
  const files: DecompFile[] = []

  const addFile = async (parent: FileSystemDirectoryHandle, name: string) => {
    const handle = await parent.getFileHandle(name)
    files.push({ name, handle, text: await (await handle.getFile()).text() })
  }

  let pokemonDir: FileSystemDirectoryHandle | null = null
  try {
    pokemonDir = await dig(dir, ['src', 'data', 'pokemon'])
  } catch {
    throw new Error('Pick the root folder of a pokeemerald / pokefirered / expansion source tree.')
  }
  for (const name of ['species_info.h', 'base_stats.h']) {
    try {
      await addFile(pokemonDir, name)
    } catch {
      /* not present in this fork */
    }
  }
  try {
    const infoDir = await pokemonDir.getDirectoryHandle('species_info')
    for await (const entry of infoDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.h') && entry.name.startsWith('gen_')) {
        const handle = entry as FileSystemFileHandle
        files.push({ name: `species_info/${entry.name}`, handle, text: await (await handle.getFile()).text() })
      }
    }
  } catch {
    /* vanilla layout without the folder */
  }

  if (files.length === 0) {
    throw new Error('No species data files found in this folder.')
  }
  files.sort((a, b) => a.name.localeCompare(b.name))

  // Dropdown options come from the tree's own constants headers, so
  // expansion forks with extra types/abilities/items enumerate fully.
  const constants: Record<string, string[]> = {}
  const loadConstants = async (paths: string[], prefixes: string[]) => {
    let text = ''
    for (const path of paths) {
      try {
        const parts = path.split('/')
        const parent = await dig(dir, parts.slice(0, -1))
        const handle = await parent.getFileHandle(parts[parts.length - 1])
        text += (await (await handle.getFile()).text()) + '\n'
      } catch {
        /* header not present in this fork */
      }
    }
    for (const prefix of prefixes) {
      const names = parseConstants(text, prefix)
      if (names.length > 0) constants[prefix] = names
    }
  }
  await loadConstants(['include/constants/pokemon.h'], ['TYPE_', 'EGG_GROUP_', 'GROWTH_'])
  await loadConstants(['include/constants/abilities.h'], ['ABILITY_'])
  await loadConstants(['include/constants/items.h'], ['ITEM_'])

  return { dirName: dir.name, files, constants }
}

export function DecompApp({ project, onClose }: { project: DecompProject; onClose: () => void }) {
  const [texts, setTexts] = useState(() => project.files.map((f) => f.text))
  const [dirtyFiles, setDirtyFiles] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState(0)
  const [query, setQuery] = useState('')
  const [edits, setEdits] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  // All species across all files, each remembering its file.
  const species = useMemo(
    () =>
      texts.flatMap((text, fileIndex) =>
        parseSpeciesInfo(text).map((entry) => ({ entry, fileIndex })),
      ),
    [texts],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? species.filter((s) => s.entry.species.toLowerCase().includes(q)) : species
  }, [species, query])

  const current = species[selected]

  const apply = (next: string | null) => {
    if (!current || next === null) return
    setTexts((t) => t.map((old, i) => (i === current.fileIndex ? next : old)))
    setDirtyFiles((d) => new Set(d).add(current.fileIndex))
    setEdits((e) => e + 1)
    setStatus(null)
  }
  const write = (key: string, value: number) => {
    if (!current) return
    apply(setNumericField(texts[current.fileIndex], current.entry, key, value))
  }
  const writeConst = (key: string, prefix: string, slot: number, value: string) => {
    if (!current) return
    apply(setConstantField(texts[current.fileIndex], current.entry, key, prefix, slot, value))
  }

  const save = async () => {
    try {
      let saved = 0
      for (const i of dirtyFiles) {
        const writable = await project.files[i].handle.createWritable()
        await writable.write(texts[i])
        await writable.close()
        saved++
      }
      setDirtyFiles(new Set())
      setEdits(0)
      setStatus(`Saved ${saved} file(s). Rebuild the project (make) to see changes in game.`)
    } catch (e) {
      setStatus(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const bst = current
    ? NUMERIC_FIELDS.slice(0, 6).reduce((sum, f) => sum + (numericValue(current.entry, f.key) ?? 0), 0)
    : 0

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="logo-ball" /> Global ROM Editor
        </span>
        <span className="game-badge">
          📁 {project.dirName} · {species.length.toLocaleString()} species
        </span>
        <span className="spacer" />
        <span className="dirty">{edits > 0 ? `${edits} unsaved edit(s)` : 'No edits yet'}</span>
        <button className="primary" onClick={save} disabled={dirtyFiles.size === 0}>
          💾 Save {dirtyFiles.size > 1 ? `${dirtyFiles.size} files` : 'file'}
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
              placeholder="Search species (try MEGA)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="entry-scroll">
              {filtered.slice(0, 800).map((s) => (
                <button
                  key={`${s.fileIndex}-${s.entry.species}`}
                  className={`entry ${species.indexOf(s) === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(species.indexOf(s))}
                >
                  {prettySpeciesName(s.entry.species)}
                </button>
              ))}
              {filtered.length > 800 && (
                <div className="empty">…{filtered.length - 800} more — refine the search</div>
              )}
            </div>
          </div>
          <div className="detail">
            {status && <div className="notice ok">{status}</div>}
            {current && (
              <>
                <div className="detail-header">
                  <h2 className="entry-title">{prettySpeciesName(current.entry.species)}</h2>
                  <span className="muted">{project.files[current.fileIndex].name}</span>
                </div>
                <section className="card">
                  <h3>
                    Base stats & battle <span className="bst">BST: {bst}</span>
                  </h3>
                  <div className="field-grid">
                    {NUMERIC_FIELDS.map((f) => {
                      const v = numericValue(current.entry, f.key)
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
                  <h3>Typing, abilities & properties</h3>
                  <div className="field-grid">
                    {CONST_FIELDS.flatMap((spec) => {
                      const raw = current.entry.fields.get(spec.key)
                      const options = project.constants[spec.prefix]
                      if (raw === undefined || !options) return []
                      return constantsIn(raw, spec.prefix).map((value, slot) => (
                        <label className="field" key={`${spec.key}-${slot}`}>
                          <span className="field-label">
                            {spec.slotLabels[slot] ?? `${spec.label} ${slot + 1}`}
                          </span>
                          <select
                            value={value}
                            onChange={(e) => writeConst(spec.key, spec.prefix, slot, e.target.value)}
                          >
                            {!options.includes(value) && <option value={value}>{prettyConstant(value, spec.prefix)}</option>}
                            {options.map((name) => (
                              <option key={name} value={name}>
                                {prettyConstant(name, spec.prefix)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))
                    })}
                  </div>
                  <table className="info-table">
                    <tbody>
                      {INFO_FIELDS.filter((k) => current.entry.fields.has(k)).map((k) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td className="mono">{current.entry.fields.get(k)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted">
                    Edits keep the file's formatting — your git diff stays a one-line change.
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
