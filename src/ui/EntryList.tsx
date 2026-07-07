import { useMemo, useState } from 'react'
import type { EntryHandle } from '../core/games/schema'

interface Props {
  entries: EntryHandle[]
  selected: number | null
  onSelect: (id: number) => void
  placeholder: string
}

export function EntryList({ entries, selected, onSelect, placeholder }: Props) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.label.toLowerCase().includes(q))
  }, [entries, query])

  return (
    <div className="entry-list">
      <input
        className="search"
        type="search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="entry-scroll">
        {filtered.map((e) => (
          <button
            key={e.id}
            className={`entry ${selected === e.id ? 'selected' : ''}`}
            onClick={() => onSelect(e.id)}
          >
            {e.label}
          </button>
        ))}
        {filtered.length === 0 && <div className="empty">No matches</div>}
      </div>
    </div>
  )
}
