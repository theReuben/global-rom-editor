# Handoff notes

For any model or contributor continuing this project. Read CLAUDE.md first
for the invariants; this file holds the deeper context.

## State (as of this handoff)

86 tests green. Shipped and validated: Gen 1–3 Pokémon/move editing;
Gen 3 trainers, wild encounters, maps (view/paint/resize/new-map),
NPC/warp/sign editing, visual script builder, evolutions, learnsets,
type chart, item/class/ability names read from the ROM; Gen 1 (R/B/Y)
wild encounters; IPS export/apply; PWA offline; decomp backend editing
species stats in pokeemerald / pokefirered / pokeemerald-expansion
(1,364 species incl. Megas). CI deploys to GitHub Pages from `main`.

## Validation methodology (the project's superpower)

Real-ROM validation without retail ROMs, reproducible in a fresh container:

```bash
apt-get install -y gcc-arm-none-eabi binutils-arm-none-eabi libpng-dev
git clone --depth 1 https://github.com/pret/pokeemerald  <scratch>/pokeemerald
cd <scratch>/pokeemerald && make -j$(nproc) modern   # ~5-10 min → .gba
# same for pret/pokefirered
npx tsx <a script that loads the .gba with buildAdapter and prints tables>
```

Expected on both: zero warnings; Emerald 411 species / 354 moves /
518 maps / 854 trainers / 116 wild maps / 110 type matchups; FireRed
411 / 354 / 425 / 718 / 124 / 110. After ANY write feature, re-run
`buildAdapter` on the edited bytes — a clean re-scan of every table is
the acid test that written structures are game-shaped. Never commit the
built ROMs.

## Byte-format facts we corrected (do not regress)

- `STD_OBTAIN_ITEM = callstd 0` (not 1). MSGBOX_DEFAULT=4, YESNO=5.
- Gen 3 evolution entries are **8 bytes** in compiled ROMs (u16 method,
  param, target + 2 pad), 5/species → 40-byte stride — even though the
  decomp header struct reads as 6 bytes.
- Learnset u16 is `(level << 9) | move`. Emerald vs FRLG differ in
  evolved-form learnsets (Growl at lvl 1 vs 4) — discovery keys on
  Bulbasaur `0x0221` first, Charmander `0x020A` at entry 4.
- Trainer party entries: 8 bytes, or 16 with custom moves; `lvl` is u16;
  held item occupies the pad slot when the item flag is set.
- Gen 1 wild anchors are byte-exact Route 1 blocks from pokered /
  pokeyellow sources (they differ between R/B and Yellow).

## Remaining roadmap, with implementation notes

1. **Gen 2 wild encounters** — pokecrystal `data/wild/*.asm`. Johto grass
   blocks: [group, map, 3 rates, 3×7 (lvl, species) for morn/day/nite],
   water: [group, map, rate, 3 slots]; tables end 0xFF. Anchor on a
   byte-exact block (e.g. Route 29) from pokecrystal, exactly like Gen 1.
   WildModule's group list handles the time-of-day split naturally
   ("Grass (morning)" etc.).
2. **Gen 1/2 trainers** — pokered `data/trainers/parties.asm`: per-class
   lists, format `[level, mon..., 0]` or `[0xFF, lvl, mon, ..., 0]`.
   Variable length ⇒ same-size in-place edits first. GB has no pointer
   retargeting helper yet — GB banked 2-byte pointers need a GB variant
   of freespace/relocate if lists must grow.
3. **Gen 3 TM/HM compatibility** — 8 bytes/species table; find via known
   Bulbasaur bits or adjacency to discovered tables; UI already renders
   flag grids (see gen1/gen2 tmhm fields).
4. **Deeper decomp editing** — parse constant-expression fields
   (`.types = MON_TYPES(...)`, `.abilities = {...}`) into dropdowns;
   enumerate options from `include/constants/*.h` of the opened tree.
5. **Sprite viewing/import** — Gen 3 front sprites: LZ77 4bpp + palette;
   all primitives exist (`lz77.ts`, `tiles.ts`).
6. **UPS/BPS patches** — needed for >16 MiB (DS) and nice for GBA.

## Gen 4+ (DS) plan — feasible, phased

Gen 4/5 (D/P/Platinum/HGSS/BW) are Nintendo DS ROMs: a real file system
(NitroFS), not a flat binary. Hacks like Platinum Kaizo are ordinary
Platinum ROMs with edited files — the existing product model (load ROM,
edit, export patch) transfers directly. 3D map editing is out of scope;
data editing is very much in scope.

- **Phase 1 — container (started in `src/core/nds/`)**: ROM header
  (gamecode at 0x0C; FNT/FAT offsets at 0x40-0x4F), file-name table,
  file allocation table, and NARC archives (sections "BTAF"/"BTNF"/
  "GMIF"). In-place same-size file writes first; growing files means
  rebuilding the FAT (documented in gbatek).
- **Phase 2 — species editor**: personal data NARCs, ~44-byte entries
  shaped like Gen 3's (stats, types, catch, EVs u16, items, abilities):
  D/P `/poketool/personal/personal.narc`, Platinum
  `/poketool/personal/pl_personal.narc`, HGSS `/a/0/0/2`, BW `/a/0/1/6`.
  Verify paths and entry layout against pret/pokediamond,
  pret/pokeplatinum, pret/pokeheartgold before trusting them.
- **Phase 3 — trainers/encounters**: per-version NARCs; text banks use
  Gen 4's encrypted text format (documented; needs its own codec).
- Ground truth: gbatek (DS filesystem), the pret DS decomps, and DSPRE
  (MIT-licensed C# editor) as a format reference.

## Legal posture

Patches only, never ROMs; names read from the user's own ROM at load
time; decomps used for struct shapes and constants, never shipped code
or assets. Keep it that way.
