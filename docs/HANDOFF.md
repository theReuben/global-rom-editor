# Handoff notes

For any model or contributor continuing this project. Read CLAUDE.md first
for the invariants; this file holds the deeper context.

## State (as of this handoff)

207 tests green; `npm test` and `npm run build` must stay that way.
Everything below is validated against ROMs built from the pret decomps
(see Validation methodology) unless noted.

**Gen 1 (R/B/Y):** species/moves editing (renames incl. moves), wild
encounters, trainer parties (both list formats, growth to 6 via class
relocation), map viewing + block painting + warp/sign/NPC viewing and coordinate
editing (object data: border, warps 4B {y,x,destWarp,destMap}, signs
3B {y,x,text}, objects 6B + 2 trainer / 1 item extras flagged by
textId bits 6/7; objectsPtr sits after the connections in the
header). Validated against built Red/Yellow .sym files and Pallet
Town's exact event coordinates (Yellow moves Oak to 10,4).
Event ADD/REMOVE ships too: adding copies the last entry of that kind
(all its ids are known-valid), growth relocates the object blob to
bank-end free space and retargets the header pointer (old blob kept —
other headers may alias it). The blob's trailing warp_to entries
(4B {viewPtr,y,x} per warp, arrival scroll data read by
LoadTilesetHeader on dungeon maps) stay in sync on add/remove/move;
viewPtr = wOverworldMap + 7 + w + (w+6)*(y>>1) + (x>>1), with
wOverworldMap derived by majority vote over every existing warp_to
entry (= 0xC6E8 on built Red AND Yellow, matching their .sym).
Item names: same backward-walk pair voting as Gen 2, anchors at ids
1/20/76 (identical pokered/pokeyellow; the 97-entry list ends with
the elevator floor names). They feed the evolution editor's item
dropdown via the new EvolutionModule.itemParamMethods field (Gen 1
method 2; Gen 2 methods 2-3; Gen 4 methods 6/7/16-19).
Evolutions + learnsets (src/core/gb/evosmoves.ts, shared with Gen 2):
EvosMovesPointerTable = 190 INTERNAL-order bank-local u16s, each blob =
evo entries {1,level,sp} / {2,item,minLvl(1),sp} (4B) / {3,minLvl,sp},
0, then (level,move) pairs, 0 — species bytes are internal ids.
Discovery: longest run of same-bank pointers whose targets parse,
cross-checked by the blobs tiling ≥80% of their middle-90% span (the
trim keeps editor-relocated blobs from blowing up the span). The scan
runs once per byte parity — skipping a failed run's length is only
sound within one parity, or an odd-aligned table gets jumped over.
Growth relocates a blob to bank free space FLOORED past every live
blob ("no evos, no moves" is literally 00 00 and fools the padding
scan). Verified: table at Red 0e:705c / Yellow 0e:71e5 per .sym.

**Gen 2 (G/S/C):** species/moves editing (renames incl. moves),
time-of-day wild encounters, trainer parties (names, items, custom
moves, growth to 6), item names from the ROM (held-item dropdowns;
vote anchors at item ids 1/77/179, and the backward name walker
accepts the 0x4A PKMN / 0x54 POKe glyph bytes - "# DOLL"),
map viewing + block painting in CGB color (lz3 tileset decompressor;
palette maps are 1 nibble/tile — byte = tile>>1, odd tile = high
nibble, bit 3 = VRAM bank, low 3 bits = palette; the palmap pointer at
tileset entry +13 has NO bank byte, so the bank is discovered by
voting across all tilesets for nibble-pair-shaped data — Gold bank
0x02, Crystal 0x13, matching the .sym files; colors = the public
day/indoor/dungeon sets from bg_tiles.pal picked by the map entry's
environment byte per environment_colors.asm),
warp/sign/NPC viewing and in-place editing (MapEvents blob at
scriptsBank:eventsPtr — filler word, then counted lists: warps 5B
{y,x,destWarp,group,map}, coord events 8B (skipped), bg events 5B
{y,x,fn,script u16}, objects 13B {sprite,y+4,x+4,movefn,radii,h1,h2,
pal/type,sight,script u16,eventFlag u16}; verified against pokecrystal
macros/scripts/maps.asm and Pallet Town's exact coordinates in built
Gold + Crystal). Event add/remove works like Gen 1's: copy-last
template, relocate the MapEvents blob to scripts-bank free space on
growth, retarget the attributes' events pointer; coord events are
carried through verbatim.
Evolutions + learnsets: EvosAttacksPointers = 251 DEX-order u16s
(Gold 10:67bd, Crystal 10:65b1 per .sym); blob format as Gen 1 but
{2,item,sp}, {3,heldItem|FF,sp}, {4,happinessWhen,sp} and
{5,level,statCmp,sp} (4B); the stat-compare byte survives edits.
Type chart: as Gen 1 but with a 0xFE separator before the two
Foresight entries (Ghost immunities), exposed like normal matchups
and preserved on rewrite (Gold 0d:4d01, Crystal 0d:4bb1; 110).
Sprites (src/core/gb/gen2sprites.ts): PokemonPicPointers = 251 x
6-byte {frontBank,ptr, backBank,ptr}; Unown's slot is 0xFF filler —
its 26 per-form entries live in UnownPicPointers (Gold 1f:4000,
Crystal 49:4000), discovered structurally and rendered as form A.
Two bank strategies: Crystal spreads forms over many banks (the main
table's delta applies per entry); Gold stores one shared REMAPPED
bank byte ($1F -> Pics 14 in FixPicBank), so a single-bank sweep
finds the real one. The stored bank byte is
game-specific nonsense (Crystal subtracts PICS_FIX 0x36 + bank list,
Gold raw + 3 remaps) so real banks are resolved by CONTENT: the bank
where the pic lz3-decompresses WITH a proper LZ_END terminator
(lz3TryDecompress strict mode — zero-filled banks 'decompress' to
plausible sizes by running off the end otherwise) to >= tiles*16
bytes (front tiles from stats dims byte 17, nibbles w/h; backs always
6x6; Crystal fronts carry animation frames after the base sprite so
the size check is >=, render uses frame 0). Delta stored->real voted
across species, per-stored-bank exceptions cached. Tiles are
COLUMN-major. PokemonPalettes (8B/species: normal+shiny RGB555 color
pairs; row 0 = dummy 000) found via findByVote anchors dex 1/25/131
(byte-identical in built Gold+Crystal). Validated: tables at Gold
12:4000 / Crystal 48:4000 per .sym, 500/500 pics render, Bulbasaur
front byte-exact vs the build intermediate .2bpp, PNGs eyeballed.
Sprite IMPORT ships for Gen 2: lz3Compress (literal/iterate/zero/
repeat commands; round-trips all 500 real pics at 105% of the game's
own compression) + luminance quantization into the 4 palette slots,
normal+shiny palette recolored from the image midtones, in-place when
the stream fits (lz3CompressedLength) else relocated to bank free
space with stored byte = realBank - delta, ROUND-TRIP VERIFIED via
resolveBank and reverted on failure (some raw values are FixPicBank-
remapped). Crystal fronts keep their decompressed length by repeating
the base frame (animation data). The table prefilter accepts stored
bytes up to 0x7F — relocations in delta-0 games write high values.

**Gen 3 (R/S/E/FR/LG):** the full suite — species, moves, trainers,
wild, maps (paint/resize/new maps/NPCs/warps/signs/script builder),
evolutions, learnsets, type chart, TM/HM, front+back sprite display
AND importing (PNG → 4bpp+LZ77, auto-relocation), shiny palettes.
All per-species tables discovered by anchor majority vote (findByVote)
so editing anchor species can't break reload.

**Gen 4 (D/P/Pt/HGSS):** full personal editing, trainers, encounters
(incl. HGSS time-of-day/radio/swarms), real names from the msg banks,
species/trainer/move renaming at ANY length — in place when it fits, else
the growth path: rebuild the msg bank (char scrambling depends only on
entry index, so other entries' encrypted streams copy verbatim),
repack the msg NARC (4-byte aligned, 0xFF padding, per o2narc), and
relocate it into end-of-ROM 0xFF/0x00 padding with a FAT retarget +
used-size (0x80) + header CRC16 update (poly 0xA001 per fixrom.c).
Trimmed ROMs without padding keep the in-place-only behaviour.
Also:
item names from the msg banks (D/P bank
344, Pt 392, HGSS 222) feeding held-item dropdowns, move data
editing (16-byte waza_tbl entries — effect, category,
power, type, accuracy %, PP, effect chance, priority; struct from
pokeplatinum move_table.h == pokeheartgold move.h; paths
waza_tbl / pl_waza_tbl / a-0-1-1), and front+back sprite display
with shiny palettes (src/core/nds/pokegra.ts): the pokegra NARC
(pokegra.narc / pl_pokegra.narc / a-0-0-4) holds 6 subfiles per
species {back F, back M, front F, front M, NCLR normal, NCLR shiny}
per pokeheartgold GetMonSpriteCharAndPlttNarcIdsEx. NCGR char data is
160x80 4bpp LINEAR (the 'scanned' flag at RAHC+0x14 bit 0 — NOT
tiled), two frames side by side (render shows the right frame, the
standard pose), XOR-scrambled by an LCRNG (seed*1103515245+24691,
pokepic.c): D/P seeds from the LAST u16 walking backward, Pt/HGSS
from the FIRST walking forward. Ground truth: pokeheartgold's asset
pipeline (nitrogfx + nitroarc, plain C, buildable here) produced the
REAL pokegra.narc from source PNGs + scramble keys; all 493 fronts
decode and Bulbasaur/Pikachu are pixel-perfect vs the source art.

**Gen 5 (B/W/B2W2):** full personal editing (PKHeX-verified layout —
no Gen 5 decomp exists).

**Decomp backend:** species stats + types/abilities/egg groups/items
as dropdowns for pokeemerald / pokefirered / pokeemerald-expansion
trees (1,364 species incl. Megas); one-line diffs.

**Engine:** IPS + UPS + BPS patches (BPS = beat's format: vlq-coded
SourceRead/TargetRead/SourceCopy/TargetCopy actions, source/target/
patch CRC32 footer; the encoder emits SourceRead/TargetRead runs,
which every consumer accepts), checksum fixing, PWA offline, CI to
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

DS assets need no ARM compiler — the pokegra archive builds from the
decomp's own PNGs with the plain-C asset tools, and `parseNarc` +
`buildPokegra` accept the bare NARC (no .nds container needed), so the
sprite path can be validated end to end against real data:

```bash
git clone --depth 1 https://github.com/pret/pokeheartgold   # ~264 MiB
cd pokeheartgold && make -C tools/nitrogfx && make -C tools/nitroarc
make files/poketool/pokegra/pokegra.narc -j$(nproc)   # ~1 min, 11.7 MiB
# 2964 subfiles = 494 species × 6; feed it to buildPokegra with mode 'pt'
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
   Gen 1 events SHIPPED including add/remove (copy-last template +
   object-blob relocation, warp_to kept in sync).

   Gen 2 map facts: map entry = {attrBank, tileset, environment,
   attrPtr u16, location, music, phone/tod, fishgroup} (9 bytes);
   attributes = {border, height, width, blocksBank, blocksPtr u16,
   scriptsBank, scriptsPtr u16, eventsPtr u16, connections};
   tileset entry (15 bytes) = dba GFX, dba Meta, dba Coll, dw Anim,
   dw NULL, dw PalMap. GFX is lz3-compressed; metatiles are raw
   4x4 tile grids. lz3: commands in top 3 bits (literal/iterate/
   alternate/zero/repeat/flip/reverse), LZ_LONG=7 extends length to
   10 bits, offsets positive 15-bit big-endian from output start or
   negative 7-bit back-from-cursor-minus-one, 0xFF ends. Gen 2
   events (view/edit/add/remove) and CGB color rendering: SHIPPED.
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
   addresses on built Emerald + FireRed). Gen 1 sprites (custom RLE
   + SGB colors), Gen 2 sprites (lz3 + shiny palettes) and Gen 4
   sprites (pokegra NCGR + LCRNG descramble): all SHIPPED. Gen 1 AND
   Gen 2 sprite IMPORT also ship: gen1PicCompress (src/core/gb/
   gen1pics.ts) is a faithful port of pokered tools/pkmncompress.c
   compress() — it tries every mode/order combo and keeps the fewest
   BITS (not bytes; two encodings can share a byte length), so it's
   byte-exact against the reference tool on all 304 real Red pics.
   Gen 1 import snaps pixels to the nearest of the species' four SGB
   palette colors (palettes are shared palette *classes*, never
   rewritten), re-encodes column-major 2bpp, compresses, and writes
   in place (gen1PicDecompress now returns byteLength) or relocates to
   the SAME bank's trailing free space with the bank-local pointer
   retargeted — front and back share the mon's bank, so the content
   bank-resolution stays valid. Validated on built Red + Yellow:
   import front/back, reload with zero new warnings, all 151 still
   render, imported art pixel-exact.

   **Gen 4 (DS) sprite import: SHIPPED** — sprite import now covers
   every supported generation. The scramble walk is its own inverse for
   a given seed, so `xorStream` (src/core/nds/pokegra.ts) serves both
   directions; only the seed's origin differs. Reference: nitrogfx
   `gfx.c` Decode/Encode — Encode runs the LCRNG backwards with the
   inverse multiplier 4005161829 from the terminal state, which is
   equivalent to walking forwards from the initial seed (what we do).
   The loader takes its seed from the word the walk *starts* on, so
   that word necessarily descrambles to zero: import forces it (four
   corner pixels — frame 0's top-left for Pt/HGSS, the last pixels for
   D/P), because a non-zero anchor decodes the whole sprite as noise.
   Import reuses the slot's existing seed so unchanged art re-encodes
   to the original bytes, keeping revert and IPS diffs clean. Char data
   and the 16-color palette both keep their exact footprint, so the
   write is in place — no NARC repack. Slot resolution is male-first
   with a female fallback, matching the renderer (the Nidoran♀ line,
   species 29-31, has an EMPTY male slot — a validation script that
   assumes slot +3 will silently skip them).

   Validated against the real HGSS `pokegra.narc` built here from
   pokeheartgold assets with nitrogfx + nitroarc (2964 subfiles / 494
   species): all 1812 NCGRs descramble to a zero anchor and re-scramble
   byte-exactly with their recovered seed; importing into 60 species
   and re-parsing the edited archive renders the imported art
   pixel-exact 60/60, both animation frames carry it, no subfile
   outside the edited species changes, and `revertAll` restores the
   archive byte for byte. Facts confirmed against that archive (not
   from memory): char data is always 6400 bytes / 20×10 tiles with the
   "scanned" linear flag set; palette subfiles are 72 bytes with 16
   BGR555 colors at TTLP+0x18. Known display quirk, shared with the
   Gen 1/2/3 importers: the viewer renders palette slot 0 as white, so
   re-importing a *displayed* sprite collapses genuine white pixels
   into the transparent slot (Pikachu has real white at index 15 and a
   lavender slot 0). Front and back share slot 4, so the sprite
   imported last defines the colors of both; the shiny palette (slot 5)
   is left untouched.
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
   (any length — the NARC growth/relocation path ships as
   replaceNarcSub in gen45.ts). No DS ROM can be built in this
   container (the Metrowerks compiler isn't redistributable), but the
   asset pipeline tools ARE plain C: nitrogfx + nitroarc built the
   real HGSS pokegra.narc here, and the repo ships the real prebuilt
   wotbl.narc — both used as ground truth. Gen 5 full personal
   layout: SHIPPED (PKHeX-verified).
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

6. **Gen 3 egg moves: SHIPPED** (`src/core/gba/eggmoves.ts`).
   `gEggMoves` is not a per-species table but ONE flat u16 array:
   entries are a marker word `species + 20000` followed by that
   species' move ids, whole array terminated by 0xFFFF, species with
   no egg moves simply absent. The game linear-scans for the marker and
   reads forward until the next word above 20000, so at most
   EGG_MOVES_ARRAY_COUNT = 10 moves per species are reachable (real
   data uses 1-8).

   There is no stride to key on, so a signature would have to be one
   species' moves — which breaks the moment that species is edited.
   Discovery is therefore structural: every aligned word in the marker
   range is tried as a table start, runs are parsed under strict rules
   (strictly ascending species, move ids in 1..MOVE_COUNT, 0xFFFF
   terminator), and candidates are taken longest-first. The second,
   independent confirmation is that the game's 32-bit pointer to the
   candidate must exist — length alone never decides. Because the
   pointer is what confirms, MIN_ENTRIES can stay low (8), so deleting
   most species' egg moves cannot shrink the table out of
   discoverability; below the floor the module cleanly disappears
   instead of guessing.

   Writes rebuild the whole array (replace / insert in dex order /
   drop on an empty list) and stay in place while it fits, relocating
   via `relocate()` with pointer retarget when it grows.

   Validated on built Emerald + FireRed, whose tables are byte-
   identical: 165 entries / 2278 bytes, species 1-411, exactly ONE
   pointer to the table in each ROM. Discovery lands on the `gEggMoves`
   address from each .map file exactly; same-length edit, shrink,
   species removal, and a bulk grow of 250 species (forcing relocation
   to 0xdb7acc / 0x9ee1f8) all reload with zero warnings and read back
   250/250, with species/moves/maps/learnsets/evolutions/type chart all
   still discovered afterwards; `revertAll` is byte-perfect.

   Gen 4 uses the same 20000-marker format (pokeheartgold
   src/get_egg.c, MAX_EGG_MOVES = 16, 2045-word array) but its list is
   an UNEXTRACTED narc — NARC id 231 sits between a/2/2/8 and a/2/3/0,
   so `/a/2/2/9` — with no buildable ground truth here. Left disabled
   rather than shipped on a source-only reading. Gen 1 has no breeding;
   Gen 2 egg moves: SHIPPED, see item 9.

7. **Gen 3 item editor: SHIPPED** (`src/core/gba/items.ts`, Items tab).
   44-byte `gItems` entries, layout confirmed against built Emerald +
   FireRed rather than read off the header (they agree):
   `0 name[14], 14 itemId u16, 16 price u16, 18 holdEffect,
   19 holdEffectParam, 20 description*, 24 importance,
   25 registrability, 26 pocket, 27 type, 28 fieldUseFunc*,
   32 battleUsage (33-35 pad), 36 battleUseFunc*, 40 secondaryId
   (41-43 pad)`.

   The item table was already being found via a MASTER BALL/ULTRA BALL
   name signature — which this editor would break, since it makes those
   names editable. Discovery is now structural: every entry stores its
   own index at +14, so a run of `u16(base + i*44 + 14) === i` (>= 100,
   with valid description pointers) identifies the table however many
   items have been renamed. The old name anchor still runs as an
   independent cross-check and raises a warning if the two disagree.
   Unused ids (52-62 in Emerald) are REAL table members carrying
   itemId 0 and a shared placeholder description — they're kept in the
   run so later indices stay aligned.

   Pocket numbering genuinely differs by family, so labels are picked
   per game code: R/S/E = Items 1, Poké Balls 2, TMs 3, Berries 4, Key
   Items 5 (pokeemerald include/constants/item.h); FR/LG = Items 1, Key
   Items 2, Poké Balls 3, TM Case 4, Berry Pouch 5 (pokefirered
   include/constants/global.h).

   Validated on both built ROMs: discovery lands on the `gItems` .map
   address exactly; Emerald reads 377 items (last OLD SEA MAP), FireRed
   375 (last SAPPHIRE); known prices check out (Ultra Ball 1200, Great
   Ball 600, Potion 300); field writes, renames, per-item revert and
   `revertAll` all round-trip with zero warnings; and renaming MASTER
   BALL — or all of the first 60 items — still re-discovers the table.

   Description editing: SHIPPED, on top of the codec work in item 8.

8. **Gen 3 charmap completed + decode-only channel: SHIPPED.**
   `buildMaps` now takes a second `decodeOnly` list whose entries reach
   the decode map only. That exists because Gen 3 composite glyphs
   decompose into text that collides with real letters: charmap.txt has
   `PKMN = 53 54` and `POKEBLOCK = 55 56 57 58 59`, so 0x57/0x58/0x59
   render BL/OC/K — and a naive `0x59 -> 'K'` pair would hijack the
   letter K, which must encode to 0xC5. First-wins ordering happened to
   protect this already, but the explicit channel makes it robust to
   reordering.

   69 single-character glyphs were missing from GEN3_PAIRS and are now
   transcribed from pokeemerald charmap.txt (English section, above
   "@ Hiragana"): the accented capitals/lowercase, plus & + = ; ¿ ¡ Í %
   ( ) â í < > · … “ ” ‘ ¥ × ▶ : Ä Ö Ü ä ö ü. 0xFF is the terminator,
   NOT a printable '$', and is deliberately excluded. One intentional
   deviation: charmap.txt calls 0xB4 '’', but we decode it as a plain
   apostrophe (what people type) and accept both on encode.

   New `gen3DecodeText` / `gen3EncodeText` handle running text rather
   than fixed-width name fields, mapping the game's line break
   (`'\n' = FE`) to and from "\n".

   Validated on built Emerald + FireRed: all 377/375 item descriptions
   now decode with ZERO unknown glyphs (previously several dozen bytes
   fell through to '?'). Byte-exact re-encoding is 361/377 and 374/375
   — every exception is a composite-glyph string, which decodes to more
   characters than it encoded from (the 5-byte POKéBLOCK becomes 9
   letters). That is not corruption: it displays identically and simply
   needs more room, which the relocation path handles.

   Item description editing rides on this. Writes go in place only when
   the text fits AND no other item points at the same string — the
   unused item ids all share one placeholder description, so editing one
   of them relocates instead of silently rewriting its siblings.
   Validated on both ROMs: shorter edits stay in place, longer ones
   relocate and retarget with zero warnings on reload, POKéBLOCK
   descriptions re-save and read back identical, editing a shared
   placeholder leaves its siblings untouched, unsupported characters are
   refused, and revert is byte-perfect.

9. **Gen 2 egg moves: SHIPPED** (`src/core/gb/eggmoves.ts`). A totally
   different shape from Gen 3's flat array: `EggMovePointers` is 251
   dex-order bank-local u16s, each pointing at a run of move-id bytes
   terminated by 0xFF. Pointers and lists share ONE bank — `GetEggMove`
   reads list bytes with a fixed `BANK("Egg Moves")` — so relocations
   must stay inside it. The game's reader has no length cap (it loops to
   the 0xFF); real lists top out at 8, and writes are capped at 12.

   Discovery mirrors evosmoves.ts (the lists are editable, so no byte
   signature would survive): longest run of same-bank pointers whose
   targets all parse, cross-checked by requiring the referenced lists to
   tile >= 80% of the span they cover.

   TWO hazards come from the shared empty list. Most species have no egg
   moves and share one pointer to a lone 0xFF (146 of 251 in Crystal,
   145 in Gold):
   - Writing "in place" to a shared list would hand egg moves to every
     species pointing at it, so a shared target ALWAYS relocates. Only
     an unshared list that still fits is written in place.
   - That lone 0xFF is the last live byte in the bank, so
     findGbBankFreeSpace happily offers it as padding. The destination
     is floored past every live list — the same trap evosmoves.ts hits
     with its all-zero blobs. Clearing a species points it back at the
     shared empty list rather than burning bank space on another 0xFF.

   Bank space is TIGHT: bank 8 has only ~177 free bytes in Crystal and
   ~453 in Gold, so a bulk grow succeeds for roughly 7 (Crystal) / 20
   (Gold) species before writes start refusing. That is inherent to the
   ROM layout, not a defect — writes fail cleanly and the UI surfaces
   it. Everything stays discoverable and revert is byte-perfect.

   Validated on built Crystal + Gold: discovery lands on the
   `EggMovePointers` address from each .sym exactly (0x23b11 / 0x239fe);
   counts match the decomp (105 species with egg moves in Crystal, 106
   in Gold — Crystal removed Charm/Steel Wing/Sweet Scent/Lovely Kiss,
   and Gold's Bulbasaur correctly still has Charm); in-place edits,
   shrinks, granting moves to a species that had none (siblings verified
   untouched), clearing, bank exhaustion and revert all behave, with
   species/moves/evolutions/learnsets/sprites/maps still found
   afterwards.

   (The wild-encounter warning noted here previously turned out to be a
   real bug — fixed in item 10.)

10. **Gen 2 wild encounters: FIXED (was silently disabled on every
   real ROM).** Discovery used one `findVerified` anchor built from
   Sprout Tower 2F's encounter bytes. Sprout Tower 2F and 3F have
   BYTE-IDENTICAL tables, so the pattern matched twice; `findVerified`
   returns null unless exactly one candidate verifies, so it returned
   null — and the adapter fell back to "Couldn't locate wild encounter
   data" on built Gold AND Crystal. The fixture happened to contain only
   one matching block, so the tests passed while every real ROM lost
   wild editing. Lesson: a signature has to be checked for UNIQUENESS
   against a real ROM, not just for presence.

   Now `findByVote` over five 9-byte anchors — {group, map, 3 rates, 2
   encounter pairs} at JohtoGrassWildMons indices 0, 2, 5, 8 and 14
   (stride 47, so index → offset holds even where the games differ).
   The leading group/map pair is what disambiguates 2F from 3F. All five
   are verified byte-identical in built Gold + Crystal and occur exactly
   once in each.

   Only 11 of 61 Johto grass blocks are identical across the two games
   (Crystal rewrote the rest), and all 11 sit in the first 15 — so the
   anchors are unavoidably CLUSTERED in early Johto, exactly what an
   encounter-rebalancing hack rewrites first. Editing 4 of the 5 does
   drop voting below its 2-vote threshold, so there is a structural
   fallback: chain 47-byte blocks that all pass the plausibility check
   and require a run of >= 40 ending in 0xFF, longest run wins.
   Verified on both ROMs that wrecking ALL FIVE anchors still re-finds
   the table at exactly the .sym address with all 114 areas.

   Validated on built Crystal + Gold: table found at 0x2a5e9 / 0x2ab35
   per .sym, 114 areas, zero warnings; editing an anchor map, then four
   anchor maps, then all five, still reloads cleanly; water areas read;
   species/moves/egg moves/evolutions/maps all still discovered; revert
   byte-perfect. The Gen 2 fixture now carries 45 grass blocks so both
   the voting path and the >= 40-block fallback are exercised.

## What's genuinely left (checked 2026-07-12)

- Gen 5 move data + trainers + wild: blocked on a verifiable source
  (no decomp; PKHeX reads pre-extracted resources, not ROM bytes).
- Gen 5 sprites: B/W NCGRs are 96x96 and unscrambled per community
  docs — needs a verifiable reference before shipping.
- Gen 4 TM->move labels: `sTMHMMoves` is a `static const` in
  pokeheartgold src/item.c, so it compiles into arm9 — which needs the
  Metrowerks compiler we can't run, and the decomp ships no BLZ tool
  either. No path to ground truth in this container; don't ship it on a
  guess.
- Gen 4 egg moves: format is source-verified but the list is an
  unextracted NARC (/a/2/2/9) — see roadmap item 6.
- DS map editing (out of near-term scope). Gen 4 evolutions can't be
  byte-validated until a real evo.narc surfaces (struct is
  source-verified; wotbl was validated against the repo's real
  prebuilt binary).

## Legal posture

Patches only, never ROMs; names read from the user's own ROM at load
time; decomps used for struct shapes and constants, never shipped code
or assets. Keep it that way.
