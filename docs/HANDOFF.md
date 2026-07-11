# Handoff notes

For any model or contributor continuing this project. Read CLAUDE.md first
for the invariants; this file holds the deeper context.

## State (as of this handoff)

118 tests green. Shipped and validated: Gen 1–3 Pokémon/move editing;
Gen 3 trainers, wild encounters, maps (view/paint/resize/new-map),
NPC/warp/sign editing, visual script builder, evolutions, learnsets,
type chart, TM/HM compatibility; Gen 1 (R/B/Y) trainer parties
(validated against Red + Yellow built from pokered/pokeyellow with
rgbds — 391/396 trainers exact, edit + re-scan clean); Gen 2 (G/S/C)
trainer parties incl. names, held items and custom moves (validated
against built Gold 495/66-class and Crystal 541/67-class — counts
derived, never assumed); Gen 1 and Gen 2 (G/S/C, time-of-day) wild
encounters; Gen 4 (D/P/Pt/HGSS) species editing and
D/P/Pt trainers + encounters via the NDS/NARC layer; Gen 5 stats-only;
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

## Known caveat: anchor species self-edits

Discovery anchors on Bulbasaur-line data (stats, learnsets, TM bits,
evolutions). Editing those exact bytes on the anchor species works fine
in-session, but a saved ROM where e.g. Bulbasaur's TM flags changed will
fail re-discovery of that one table on reload (editor shows the usual
"couldn't locate" warning; nothing corrupts). Fix idea for later: after
a successful scan, stash discovered offsets in a comment-free sidecar
(IPS-adjacent JSON) or accept >1 anchor candidates verified against each
other.

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
2. **Deeper decomp editing** — parse constant-expression fields
   (`.types = MON_TYPES(...)`, `.abilities = {...}`) into dropdowns;
   enumerate options from `include/constants/*.h` of the opened tree.
3. **Sprite importing** — viewing shipped (gba/sprites.ts, self-tagged
   table discovery); import = re-compress + relocate when larger.
4. **Gen 4 text codec** (trainer/species names from the DS text banks)
   and the Gen 5 full personal layout (verify against DSPRE source).
5. **HGSS encounters** (different file format from D/P/Pt).

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
