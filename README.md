# Global ROM Editor

**The all-in-one Pokémon ROM hacking studio that runs in your browser.**

No installs. No hex editors. No spreadsheets of offsets. No code. Load a ROM,
edit with normal forms and sliders, save — and share your hack as a patch.

## What it does today

| Feature | Gen 1 (R/B/Y) | Gen 2 (G/S/C) | Gen 3 (R/S/E/FR/LG) |
| --- | :-: | :-: | :-: |
| Base stats, types, catch rate, EXP yield | ✅ | ✅ | ✅ |
| Pokémon renaming | ✅ | ✅ | ✅ |
| Level curve (growth rate) | ✅ | ✅ | ✅ |
| TM/HM compatibility (checkbox grid) | ✅ | ✅ | 🔜 |
| Starting moves | ✅ | — | 🔜 |
| Wild held items, gender ratio, egg groups, hatch cycles | — | ✅ | ✅ |
| Abilities (named, read from the ROM) | — | — | ✅ |
| EV yields | — | — | ✅ |
| Move power / accuracy / PP / type / effect / priority / flags | ✅ | ✅ | ✅ |
| Move renaming | 🔜 | 🔜 | ✅ |
| Map viewer & block painting (scene editing) | 🔜 | 🔜 | ✅ |
| Movement permission (collision) editing | — | — | ✅ |
| NPC / warp / sign editing | 🔜 | 🔜 | ✅ |
| Trainer editing (class, AI, items, full parties) | 🔜 | 🔜 | ✅ |
| Wild encounter editing (grass/surf/rock/fishing) | 🔜 | 🔜 | ✅ |
| Item names read from the ROM (dropdowns everywhere) | — | — | ✅ |
| Save edited ROM with fixed checksums | ✅ | ✅ | ✅ |
| Export edits as an IPS patch | ✅ | ✅ | ✅ |
| Apply community IPS patches | ✅ | ✅ | ✅ |

Everything runs **entirely client-side** — ROMs never leave the user's device.
The editor is an installable PWA: after the first visit it works fully
**offline**.

**Validated against real ROMs**: every scanner and editor is exercised in CI
against synthetic fixtures, and additionally verified against ROMs built from
source with the pret decompilation projects (pokeemerald and pokefirered) —
518/425 maps, 854/718 trainers, all names, wild tables and tilesets located
and rendered with zero warnings on both.

## Why it works where other tools break

Most editors hardcode per-version data offsets and fall over on anything but
one specific US revision. Global ROM Editor instead **finds every data table
by scanning for signatures intrinsic to the data itself** (e.g. Bulbasaur's
base stats, `POUND` in the game's own text encoding), then verifies a second
independent signature before enabling an editor. That means:

- All revisions and Latin-alphabet regions of the 11 supported games work.
- Most existing ROM hacks load and stay editable.
- A table that can't be verified is never edited — the UI tells you what was
  found (see the *ROM Info* tab) instead of silently corrupting data.

## Getting started

```bash
npm install
npm run dev      # local dev server
npm test         # core test suite (runs against synthetic ROM fixtures)
npm run build    # production build in dist/
```

The repo contains **no Nintendo data**. Tests run against synthetic fixtures
that only contain the handful of public-knowledge signature bytes the scanner
looks for.

## Architecture

```
src/core/           platform-independent ROM engine (fully unit-tested)
  rom.ts            byte-level access + change tracking (powers IPS export & revert)
  scan.ts           signature scanning / verification
  text.ts           Gen 1/2 and Gen 3 text codecs
  detect.ts         GB / GBC / GBA header detection
  checksum.ts       header & global checksum fixing on save
  ips.ts            IPS patch create / apply
  games/
    schema.ts       GameAdapter contract + declarative field specs
    gen1.ts         Red / Blue / Yellow
    gen2.ts         Gold / Silver / Crystal
    gen3.ts         Ruby / Sapphire / Emerald / FireRed / LeafGreen
src/ui/             React UI — 100% game-agnostic
```

Adapters describe their editable data as **field specs** (number, type,
select, flags, move); the UI renders the right form automatically. Supporting
a new game = one adapter file, zero UI changes.

## Roadmap

The goal is full "make your own game" capability — custom areas, NPCs and
events on top of a base ROM, shared as a patch. The engine layer for this
already exists and is tested (`src/core/gba/lz77.ts`, `src/core/tiles.ts`,
`src/core/freespace.ts`: LZ77 codec, tile/palette rendering, free-space
allocation + pointer retargeting).

**Shipped:** the Gen 3 map editor (view, paint blocks, edit movement
permissions, edit NPCs/warps/signs). Map data is discovered *structurally*
— tileset headers by shape, layouts that point at verified tilesets,
headers that point at verified layouts, then the bank table that ties it
together (`src/core/gba/mapscan.ts`) — so it works across versions and
most hacks with zero hardcoded offsets.

In rough build order:

1. **Custom areas** — resize maps and add brand-new maps into free
   space with automatic repointing; add/remove NPCs and warps.
2. **Visual script builder** — compose events ("Show text → Give item →
   Set flag") from dropdowns; compiles to the game's script bytecode.
   This is the zero-code answer to custom storytelling.
3. **Gen 1/2 map, trainer & wild editing** — same editor UI on the GB
   data formats.
4. Level-up learnsets, evolutions, type chart, starters, sprite
   importing, item/text editing, UPS/BPS patches.

## Relationship to the decompilation projects

The [pret](https://github.com/pret) decompilations (pokered, pokecrystal,
pokeemerald, pokefirered) are this project's ground truth for **data
formats**: every struct this editor reads or writes — base stats, trainer
entries, wild encounter headers, map layouts, tilesets, event templates —
is implemented from the layouts those projects documented. Planned deeper
uses:

- **Test ROMs built from source** (`make modern` in pokeemerald /
  pokefirered) are used to validate every scanner against real data —
  no retail ROMs needed for development.
- **Constants** are extracted from decomp headers into
  `src/core/games/gen3-constants.ts` (NPC movement types, battle AI
  flags) so dropdowns show names, not magic numbers.
- **Script command tables** extracted from the decomps will drive the
  visual script builder (command names, argument types and sizes).
- Longer-term: a **decomp project backend** — the same UI editing a
  pokeemerald/pokefirered source tree (via the browser's directory
  access API or a desktop build) instead of a binary ROM. That path
  removes all size limits: unlimited new maps, species, story. Binary
  editing stays the zero-setup default; the decomp backend becomes the
  "pro" tier for total conversions.

No code or assets from the games or the decomps are shipped — the editor
reads names (Pokémon, moves, items, abilities) out of the user's own ROM
at load time, and only struct *shapes* live in this repository.

## Legal

Use ROMs you legally own. Share hacks as **patches** (IPS), never as full
ROMs — the export flow makes the legal path the easy path. This project is
not affiliated with Nintendo, Game Freak or The Pokémon Company.
