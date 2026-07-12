# Global ROM Editor

**The all-in-one Pokémon ROM hacking studio that runs in your browser.**

No installs. No hex editors. No spreadsheets of offsets. No code. Load a ROM,
edit with normal forms and sliders, save — and share your hack as a patch.

## What it does today

| Feature | Gen 1 (R/B/Y) | Gen 2 (G/S/C) | Gen 3 (R/S/E/FR/LG) | Gen 4/5 (DS) |
| --- | :-: | :-: | :-: | :-: |
| Base stats, types, catch rate, EXP yield | ✅ | ✅ | ✅ | ✅ |
| Pokémon renaming | ✅ | ✅ | ✅ | ✅ Gen 4 (any length — the msg archive relocates when a name outgrows its slot) |
| Level curve (growth rate) | ✅ | ✅ | ✅ | ✅ |
| TM/HM compatibility (checkbox grid) | ✅ | ✅ | ✅ | ✅ |
| Starting moves / level-up learnsets | ✅ | ✅ | ✅ | — |
| Evolutions & type effectiveness chart | ✅ | ✅ | ✅ | — |
| Front + back sprite display (with shiny toggle) | — | — | ✅ | — |
| Custom sprite importing, front and back (64×64 PNG, auto-relocation) | — | — | ✅ | — |
| Wild held items, gender ratio, egg groups, hatch cycles | — | ✅ | ✅ | ✅ |
| Abilities (named, read from the ROM) | — | — | ✅ | ✅ (+hidden in Gen 5) |
| EV yields | — | — | ✅ | ✅ |
| Move power / accuracy / PP / type / effect / priority / flags | ✅ | ✅ | ✅ | ✅ Gen 4 |
| Move renaming | ✅ | ✅ | ✅ | ✅ Gen 4 (any length) |
| Map viewer & block painting (scene editing) | ✅ | ✅ (full CGB color) | ✅ | — |
| Movement permission (collision) editing | — | — | ✅ | — |
| NPC / warp / sign editing | ✅ (edit in place) | ✅ (edit in place) | ✅ | — |
| Trainer editing (class, AI, items, full parties) | ✅ parties (grow to 6) | ✅ parties+names (grow to 6) | ✅ | ✅ Gen 4 (named) |
| Wild encounter editing (time-of-day in Gen 2/HGSS; grass/surf/rods/radio/swarms in Gen 4) | ✅ | ✅ | ✅ | ✅ D/P/Pt/HGSS |
| Item names read from the ROM (dropdowns everywhere) | — | ✅ | ✅ | ✅ Gen 4 |
| Map resizing (relocated into free space) | — | — | ✅ | — |
| Brand-new maps (duplicate into a fresh bank slot) | — | — | ✅ | — |
| Add / remove NPCs, warps and signs | ✅ | ✅ | ✅ | — |
| Visual script builder (messages, Y/N questions, items, Pokémon, trainer battles, flags) | — | — | ✅ | — |
| Decomp project editing (stats + types/abilities/egg groups dropdowns) | — | — | ✅ | — |
| Save edited ROM with fixed checksums | ✅ | ✅ | ✅ | ✅ |
| Export edits as an IPS or UPS patch | ✅ | ✅ | ✅ | ✅ UPS |
| Apply community IPS / UPS patches | ✅ | ✅ | ✅ | ✅ |

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

**Shipped:** map resizing (block grids relocate into the ROM's trailing
free space with automatic repointing), adding/removing NPCs/warps/signs,
and the first **visual script builder** — compose "Show message → Give
item → Give Pokémon → Set flag" steps and they compile to the games'
real script bytecode (opcodes verified against both pokeemerald and
pokefirered), get written to free space, and attach to any NPC or sign.
Also shipped: the first slice of the **decomp project backend** — open a
pokeemerald/pokefirered source folder in Chromium and edit species stats
with formatting-preserving writes back to `species_info.h`.

**Also shipped:** brand-new map creation — "New map from this" clones a
map's terrain and settings into a fresh layout/header/bank entry in free
space (retarget any warp to reach it), and the script builder gained
Yes/No questions (with bail-out) and single trainer battles. All of it
verified on a real Emerald ROM: the edited ROM re-scans cleanly and the
new map is discovered like any original one.

In rough build order:

1. **Gen 1/2 map & trainer editing**; Gen 5 full personal layout
   verification; the Gen 4 text codec for names.
2. **Deeper decomp editing** — types/abilities/items as dropdowns,
   trainers and encounters from source, project-wide save.
3. Level-up learnsets, evolutions, type chart, starters, sprite
   importing, item/text editing, UPS/BPS patches.

## What about 1000+ Pokémon, Megas, Tera, Z-moves?

Those mechanics don't exist in the vanilla GB/GBC/GBA engines — no binary
editor can flip them on. In the ROM-hacking world they come from
**[pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion)**
(the community engine fork with Gen 1–9 species, Megas, Z-moves, Dynamax
and Tera backported to the GBA engine) or from large binary engine
overhauls built on it. This editor meets that world twice:

- **Binary ROMs with expanded rosters**: table sizes are detected from
  the ROM itself (name-table scanning with stats plausibility checks),
  so hacks with more than 411 species, extra moves or extra abilities
  expose their full rosters instead of being capped at vanilla counts.
- **The decomp backend opens pokeemerald-expansion directly**: all
  `species_info/gen_*.h` family files load together — 1,300+ entries
  including every Mega and regional/battle form — with the same stat
  editor and formatting-preserving saves. This is the recommended base
  for "custom game" projects that want modern mechanics.

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
