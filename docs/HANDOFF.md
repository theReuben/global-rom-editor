# Handoff notes

For any model or contributor continuing this project. Read CLAUDE.md first
for the invariants; this file holds the deeper context.

## State (as of this handoff)

139 tests green; `npm test` and `npm run build` must stay that way.
Everything below is validated against ROMs built from the pret decomps
(see Validation methodology) unless noted.

**Gen 1 (R/B/Y):** species/moves editing (renames incl. moves), wild
encounters, trainer parties (both list formats, growth to 6 via class
relocation), map viewing + block painting (validated against built
Red/Yellow .sym files).

**Gen 2 (G/S/C):** species/moves editing (renames incl. moves),
time-of-day wild encounters, trainer parties (names, items, custom
moves, growth to 6), map viewing + block painting (lz3 tileset
decompressor, grayscale for now; validated against Gold/Crystal .sym).

**Gen 3 (R/S/E/FR/LG):** the full suite — species, moves, trainers,
wild, maps (paint/resize/new maps/NPCs/warps/signs/script builder),
evolutions, learnsets, type chart, TM/HM, front+back sprite display
AND importing (PNG → 4bpp+LZ77, auto-relocation), shiny palettes.
All per-species tables discovered by anchor majority vote (findByVote)
so editing anchor species can't break reload.

**Gen 4 (D/P/Pt/HGSS):** full personal editing, trainers, encounters
(incl. HGSS time-of-day/radio/swarms), real names from the msg banks,
species/trainer renaming in place (same-or-shorter encoded length).

**Gen 5 (B/W/B2W2):** full personal editing (PKHeX-verified layout —
no Gen 5 decomp exists).

**Decomp backend:** species stats + types/abilities/egg groups/items
as dropdowns for pokeemerald / pokefirered / pokeemerald-expansion
trees (1,364 species incl. Megas); one-line diffs.

**Engine:** IPS + UPS patches, checksum fixing, PWA offline, CI to
GitHub Pages from `main`. Change tracking via Rom write helpers powers
revert + patch export everywhere.

## Validation methodology (the project's superpower)

Real-ROM validation without retail ROMs, reproducible in a fresh container:

```bash
apt-get install -y gcc-arm-none-eabi binutils-arm-none-eabi libpng-dev
git clone --depth 1 https://github.com/pret/pokeemerald  <scratch>/pokeemerald
cd <scratch>/pokeemerald && make -j$(nproc) modern   # ~5-10 min → .gba
# same for pret/pokefirered
npx tsx <a script that loads the .gba with buildAdapter and prints tables>
```

Game Boy (Gen 1/2) works the same way, but needs rgbds built from
source — GitHub *release downloads* are blocked in this container while
`git clone` works fine:

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/gbdev/rgbds
cd rgbds && make -j$(nproc)          # pokered master needs rgbds ≥ 1.0.0
export PATH=$PWD:$PATH
git clone --depth 1 https://github.com/pret/pokered   # and/or pokeyellow
cd pokered && make -j$(nproc) red    # ~2 min → pokered.gbc (1 MiB)
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

## Known caveat: anchor species self-edits (partially fixed)

FIXED for all Gen 3 species tables: stats (findStatsTable in gen3.ts),
evolutions + TM/HM bits (voteForBase in species-extras.ts) and
learnsets (3-of-5 first-word vote) each use 5-6 independent anchors
spread across the dex (bytes extracted from built Emerald + FireRed,
identical in both) — a majority of intact anchors re-finds the table
no matter which anchor species was edited. Validated by wrecking
Bulbasaur's evo/learnset/TM rows (plus Ivysaur's evo) on both real
ROMs and reloading with zero warnings. Still single-anchor: the type
chart (not per-species — editing it can't self-break the same way,
its signature rows are Normal-type matchups). Gen 1/2/3 stats, names
and move-data tables all vote via `findByVote` (scan.ts) — validated
on all six built ROMs by wrecking Bulba/Ivy stats + names and
Pound/Karate Chop move rows, then reloading with zero new warnings.
Gen 1 name anchors are INTERNAL-order indices (Rhydon 1, Kangaskhan 2,
Pikachu 84, Mewtwo 131 — from pokered constants).

## Remaining roadmap, with implementation notes

1. **Gen 1/2 trainers: SHIPPED, including party growth.** Growing or
   shrinking a party rebuilds the whole class block (lists are back to
   back); growth relocates to bank-end padding (findGbBankFreeSpace),
   retargets the class + alias pointers, and zeroes the abandoned
   block so the previous class can't parse it as extra trainers.
   Validated on all four built GB ROMs by growing trainer #0 (the
   discovery anchor itself) to six mons: reload keeps exact trainer
   counts and revert is byte-perfect.

   Gen 2 facts (validated on built Gold + Crystal): `TrainerGroups` =
   one bank-local u16 per class (66 in G/S, 67 in Crystal — the count is
   *derived* as (ptr[0] − tableStart)/2, never assumed), table directly
   before FalknerGroup. Trainer = `"NAME@", type, mons…, 0xFF`; type
   bit 0 = 4 move bytes per mon, bit 1 = item byte per mon (order:
   level, species, item?, moves?). Anchor = Falkner+Whitney groups,
   byte-identical G/S/C; fallback = self-referencing table (entry 0
   lands exactly 2×N past table start) since Falkner is editable data.
   Renames are same-footprint: shorter names pad with 0x7F spaces
   before the 0x50 terminator (bytes after it belong to the type
   field). Class names via the unique "LEADER@RIVAL@" transition
   (a LEADER-only anchor is ambiguous inside the 8-LEADER run);
   glyphs 0x4A=PKMN / 0x54=POKé decode-only in gen12Codec.

   Gen 1 facts (validated on built Red + Yellow ROMs): 47 classes,
   pointer table (bank-local u16 per class) sits immediately before
   YoungsterData; anchor = Youngster's first 3 lists, byte-identical in
   R/B/Y. Because that anchor is a *real editable trainer*, discovery
   has a structural fallback: entry 0 of the table points exactly 94
   bytes past the table start (self-referencing), all 47 pointers
   non-decreasing and each targeting 0xFF or a level ≤ 120 — this
   re-finds the table after any party edit. Unused classes (12 Unused
   Juggler, 26 Chief) alias the next class's pointer; the later class
   owns the lists. Fixed-level lists share one level byte for the whole
   party; level writes clamp to 1..120 so re-discovery never breaks.
   Rival 1 #1's mon is version proof: Squirtle in Red, Eevee in Yellow.

   Gen 1 map facts: header = {tileset u8, height u8, width u8 (in
   32x32px blocks), blocksPtr u16, textPtr u16, scriptPtr u16,
   connections u8, ..., objectsPtr u16}; blocks live in the header's
   bank; tileset entry = {bank, blocksPtr, gfxPtr, collPtr (ROM0!),
   counterTiles[3], grassTile, anim}; block = 16 tile ids (4x4);
   tiles 2bpp. Yellow places MapHeaderPointers+Banks adjacent in a
   switchable bank ("Overworld Pikachu" section) while Red splits
   them between ROM0 and bank 3 - hence candidate-run discovery.
   Remaining for Gen 1 maps: warps/signs/NPCs (object data).

   Gen 2 map facts: map entry = {attrBank, tileset, environment,
   attrPtr u16, location, music, phone/tod, fishgroup} (9 bytes);
   attributes = {border, height, width, blocksBank, blocksPtr u16,
   scriptsBank, scriptsPtr u16, eventsPtr u16, connections};
   tileset entry (15 bytes) = dba GFX, dba Meta, dba Coll, dw Anim,
   dw NULL, dw PalMap. GFX is lz3-compressed; metatiles are raw
   4x4 tile grids. lz3: commands in top 3 bits (literal/iterate/
   alternate/zero/repeat/flip/reverse), LZ_LONG=7 extends length to
   10 bits, offsets positive 15-bit big-endian from output start or
   negative 7-bit back-from-cursor-minus-one, 0xFF ends. Remaining:
   Gen 2 events, CGB colors.
2. **Deeper decomp editing: SHIPPED.** Constant-expression fields
   (`.types`, `.abilities`, `.eggGroups`, `.growthRate`, `.itemCommon`,
   `.itemRare`) are dropdowns; options enumerated from the opened
   tree's `include/constants/{pokemon,abilities,items}.h`, handling
   both `#define` (vanilla) and enum-member (expansion) styles.
   `setConstantField` replaces exactly the slot's identifier, keeping
   one-line diffs in both `{ ... }` and `MON_TYPES(...)` styles.
   Still read-only: genderRatio (PERCENT_FEMALE(x) macro), bodyColor.
3. **Sprite importing: SHIPPED** for Gen 3 front sprites
   (`SpriteViewer.importFront`): quantise to ≤15 colors + transparent
   slot 0 (transparent pixels and the top-left color), encode 4bpp,
   LZ77-compress, write in place when it fits or relocate to end-of-ROM
   padding with the pic/palette table pointers retargeted; the frame is
   repeated to preserve the original decompressed size (animated mons
   store two frames). Back sprites: SHIPPED (same pipeline). Front/back
   classification, verified against .map symbols of built Emerald +
   FireRed and pokeruby's mon_attrs.s: a table whose gfx decompresses
   to 0x1000 (two frames) is Emerald's FRONT; when both are 0x800
   (R/S/FRLG) the first table in ROM order is front — Emerald is the
   only game with back before front. Front and back share one palette
   (gMonPaletteTable), so whichever sprite was imported last defines
   the colors of both. Shiny palettes: SHIPPED (tag base 500
   distinguishes the shiny table; validated against the map-file
   addresses on built Emerald + FireRed). Remaining: Gen 1/2 sprites (2bpp + Gen 1's custom RLE), DS sprites.
4. **Gen 4 text codec: SHIPPED (read-only).** `src/core/nds/msgdata.ts`
   decodes msg banks: u16 count + u16 key header; per-entry
   {u32 offset,u32 length} XORed with `key*765*(n+1) & 0xFFFF`
   replicated to 32 bits; chars XORed with a rolling u16 seed starting
   `(n+1)*596947`, incremented by 18749; 0xFFFF ends, 0xFFFE starts a
   {cmd u16, nargs u16, args} control sequence, 0xF100 switches to
   9-bit codes packed 15 bits per word (name banks), terminator 0x1FF.
   Charmap generated from pokeheartgold charmap.txt (byte-identical to
   pokeplatinum's) into gen4-charmap.ts. Bank indices per game are in
   MSG_BANKS in gen45.ts, each verified in the decomp sources (NOT from
   memory): D/P 362/588/559/560, Pt 412/647/618/619, HGSS
   237/750/729/730 (species/moves/trainer names/class names). Species,
   move, trainer and class names now come from the ROM itself, and
   species/trainer names WRITE back in place via writeMsgEntry
   (same-or-shorter encoded length; keeps the alloc table untouched by
   padding with encrypted terminators; 9-bit packed name banks are
   re-packed). No DS
   ROM can be built in this container (the Metrowerks compiler isn't
   redistributable), so validation = decomp source reading + symmetric
   encode/decode tests; writing names back (re-encrypt + NARC rebuild)
   beyond same-length is still open (needs NARC+FAT rebuild). Gen 5
   full personal layout: SHIPPED (PKHeX-verified).
5. **HGSS encounters + trainers: SHIPPED.** EncounterData = 0xC4-byte
   files (pret/pokeheartgold include/wild_encounter.h): 6 rate bytes +
   2 dummy; 12 shared land levels @0x08; 12 u16 species per time of day
   @0x14/0x2C/0x44; radio species @0x5C/0x60; surf 5×{min,max,u16}
   @0x64; rock smash 2 @0x78; rods 5 each @0x80/0x94/0xA8; swarm u16×4
   @0xBC. NARC paths (name-stripped, from pokeheartgold filesystem.mk):
   HG enc = /a/0/3/7, SS enc = /a/1/3/6, trdata = /a/0/5/5, trpoke =
   /a/0/5/6 — trainer structs are byte-identical to D/P/Pt (the trailing
   u16 is the ball capsule instead of padding), so buildGen4Trainers is
   reused unchanged.

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
