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
| Save edited ROM with fixed checksums | ✅ | ✅ | ✅ |
| Export edits as an IPS patch | ✅ | ✅ | ✅ |
| Apply community IPS patches | ✅ | ✅ | ✅ |

Everything runs **entirely client-side** — ROMs never leave the user's device.

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

1. **Trainer & wild encounter editing** — structured tables, same
   declarative-form treatment as Pokémon stats.
2. **Custom areas** — resize maps and add brand-new maps into free
   space with automatic repointing; add/remove NPCs and warps.
3. **Visual script builder** — compose events ("Show text → Give item →
   Set flag") from dropdowns; compiles to the game's script bytecode.
   This is the zero-code answer to custom storytelling.
4. **Gen 1/2 map editing** — same editor UI on the GB map formats.
5. Level-up learnsets, evolutions, type chart, starters, sprite
   importing, item/text editing, UPS/BPS patches.

## Legal

Use ROMs you legally own. Share hacks as **patches** (IPS), never as full
ROMs — the export flow makes the legal path the easy path. This project is
not affiliated with Nintendo, Game Freak or The Pokémon Company.
