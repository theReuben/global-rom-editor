/** Familiar per-type colors for badges and dropdown accents. */
const TYPE_COLORS: Record<string, string> = {
  Normal: '#a8a878',
  Fighting: '#c03028',
  Flying: '#a890f0',
  Poison: '#a040a0',
  Ground: '#e0c068',
  Rock: '#b8a038',
  Bug: '#a8b820',
  Ghost: '#705898',
  Steel: '#b8b8d0',
  Fire: '#f08030',
  Water: '#6890f0',
  Grass: '#78c850',
  Electric: '#f8d030',
  Psychic: '#f85888',
  Ice: '#98d8d8',
  Dragon: '#7038f8',
  Dark: '#705848',
}

export function typeColor(label: string): string {
  return TYPE_COLORS[label] ?? '#68a090'
}
