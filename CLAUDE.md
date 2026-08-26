# CLAUDE.md — working on Global ROM Editor

Browser-based Pokémon ROM editor. Everything client-side; ROMs never leave
the user's machine. Read `docs/HANDOFF.md` before building features — it
records the methodology, validated byte-format facts, and the roadmap.

## Commands

```bash
npm test         # vitest — must stay green; runs on synthetic fixtures only
npm run build    # tsc --noEmit && vite build — both must pass
npm run dev      # local dev server
```

## Non-negotiable invariants

1. **Never hardcode per-version ROM offsets.** Every table is discovered by
   content signatures or structural validation (see `src/core/scan.ts`,
   `src/core/gba/mapscan.ts`) and verified against a second independent
   pattern before its editor is enabled. Unverified = disabled + warning,
   never a guess.
2. **Never trust byte-format facts from memory** — including your own.
   Verify against the pret decomp sources (clone them into scratch space)
   AND against a ROM built from those sources (see HANDOFF §Validation).
   Multiple from-memory "facts" were wrong during development; the ROM is
   ground truth (structs may be padded differently than headers suggest).
3. **No Nintendo data in the repo.** Tests use synthetic fixtures
   (`tests/fixtures.ts`) containing only public-knowledge signature bytes.
   Never commit ROMs, built or otherwise (.gitignore already blocks them).
4. **All edits go through `Rom` write helpers** (`src/core/rom.ts`) so
   change tracking, revert and IPS export keep working.
5. **Data that outgrows its footprint relocates** via
   `src/core/freespace.ts` (end-of-ROM padding first) with automatic
   pointer retargeting — never overwrite neighbours.
6. **The UI stays game-agnostic.** Features are adapter modules declared in
   `src/core/games/schema.ts`; a null module hides its tab. Adding a game =
   one adapter, zero UI changes.

## Layout

- `src/core/` — engine (rom, scan, text codecs, ips, checksum, freespace,
  tiles, gba/{lz77,smol,compress,mapscan,maps,regionmap,trainers,wild,
  script,disasm,species-extras,expansion,expansion-trainers,expansion-items,
  trainer-locations,trainer-sprites})
- `src/core/games/` — schema + gen1/gen2/gen3/gen3-expansion adapters
  + generated constants (gen1-constants, gen3-constants — regenerate
  from decomps, don't hand-edit)
- `src/decomp/` — decomp source-tree backend (species_info parser)
- `src/ui/` — React panels, one per tab
- `tests/` — vitest; fixtures build fake ROMs with planted signatures

## Workflow

Commit and push after every completed feature (branch:
`claude/pokemon-rom-editor-rc0rcn`). Container restarts can wipe
uncommitted work — it happened once.
