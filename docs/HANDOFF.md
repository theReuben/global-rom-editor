# Handoff notes

For any model or contributor continuing this project. Read CLAUDE.md first
for the invariants; this file holds the deeper context.

## State (as of this handoff)

133 tests green. Anchor voting now covers ALL generations:
Gen 1/2/3 stats, names and move-data tables each vote across 4-5
anchors (Pikachu/Chansey/Mewtwo rows extracted from built
Red/Yellow/Gold/Crystal/Emerald/FireRed; findByVote in scan.ts). Anchor voting now also covers evolutions,
learnsets and TM/HM bits (species-extras.ts voteForBase / learnset
3-of-5 first-word vote). The Gen 3 stats table is now found by anchor
MAJORITY VOTE (Bulba/Ivy/Pikachu/Chansey/Mewtwo each vote for a
table base; two agreeing win), so editing anchor species no longer
breaks reload for base stats. DS species and trainer names are now editable
in place (msg-bank rewrite, same-or-shorter encoded length — the
XOR scrambling is symmetric and each entry has a fixed allocation,
so nothing moves; longer names would need a NARC rebuild). Back sprites now display and import next to fronts;
this also fixed Emerald showing BACK pics as front (its back table
precedes the front table in ROM, unlike R/S/FRLG). Decomp projects now edit types, abilities (incl.
hidden), egg groups, level curve and wild items as dropdowns —
options enumerated from the opened tree's own headers (#define and
expansion enum styles), edits stay one-line diffs; validated against
the real pokeemerald and pokeemerald-expansion trees. Gen 5 (B/W, B2W2) now edits the full personal
entry (items ×3, hidden ability, u16 base EXP, 101 TM/HM flags) —
layout verified against PKHeX PersonalInfo5BW/B2W2 since no Gen 5
decomp or buildable ROM exists. Gen 4 names (species, moves, trainers, classes)
now decode from the msg banks — DS editors show real names. Shipped and validated: Gen 1–3 Pokémon/move editing;
Gen 3 sprite importing (64×64 PNG → 4bpp+LZ77, auto-relocation,
round-trip pixel-perfect on built Emerald);
Gen 3 trainers, wild encounters, maps (view/paint/resize/new-map),
NPC/warp/sign editing, visual script builder, evolutions, learnsets,
type chart, TM/HM compatibility; Gen 1 (R/B/Y) trainer parties
(validated against Red + Yellow built from pokered/pokeyellow with
rgbds — 391/396 trainers exact, edit + re-scan clean); Gen 2 (G/S/C)
trainer parties incl. names, held items and custom moves (validated
against built Gold 495/66-class and Crystal 541/67-class — counts
derived, never assumed); Gen 1 and Gen 2 (G/S/C, time-of-day) wild
encounters; Gen 4 (D/P/Pt/HGSS) species editing and
D/P/Pt trainers + encounters via the NDS/NARC layer; Gen 5 full personal editing;
IPS + UPS patches; PWA offline; decomp backend editing species stats in
pokeemerald / pokefirered / pokeemerald-expansion (1,364 species incl.
Megas). CI deploys to GitHub Pages from `main`.

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

1. **Gen 1/2 trainers: SHIPPED.** Remaining gap for both: parties can't
   grow (variable-length lists, edits are same-footprint in place). GB
   banked 2-byte pointers need a GB variant of freespace/relocate to
   lift that.

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
   the colors of both. Remaining: shiny palettes (second palette
   table), Gen 1/2 sprites (2bpp + Gen 1's custom RLE), DS sprites.
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
