"""Names for the numbers the ROM is full of.

A script argument is a bare number in the ROM: `setflag 0x11b` says
nothing, `setflag RECEIVED_CASTFORM` says everything. The names live in
the decomp, so they are extracted rather than transcribed - the same
rule as every other generated table here.

Four sources, each with its own shape:
  * flags.h / vars.h   - #defines, often written as an offset from a
    base (`(TEMP_VARS_START + 0x3)`), so values are resolved by
    evaluating each expression against the names already known.
  * data/specials.inc  - a `def_special` per line, numbered in order.
  * data/event_scripts.s - gStdScripts, again numbered in order.
  * C enums              - hold effects, item sort types and the rest,
    which count up from 0 unless a member says otherwise.

Usage: python3 scripts/gen-symbols.py <decomp-dir> > out.ts
"""
import re, sys, json

root = sys.argv[1]


def enum_values(path, name):
    """Members of a C enum, numbered the way the compiler numbers them.

    A member counts on from the one before unless it is given a value.
    Two members can share one - the first is usually a compatibility
    alias, and the decomp marks those `dummy`, so those are skipped and
    the real name kept.
    """
    src = open(f'{root}/{path}', encoding='utf-8').read()
    # PACKED, __attribute__((packed)) and friends sit between the
    # keyword and the name.
    m = re.search(r'enum\s+(?:__attribute__\s*\(\(.*?\)\)\s*|\w+\s+)*' + name + r'\s*\{(.*?)\n\}',
                  src, re.S)
    if not m:
        return {}
    out, value = {}, 0
    # One member per line, which is how the decomp writes them. Splitting
    # on commas would not do: the comments have commas in them.
    for line in m.group(1).split('\n'):
        comment = ' '.join(re.findall(r'//(.*)', line))
        entry = re.sub(r'//.*', '', line).strip().rstrip(',').strip()
        if not entry:
            continue
        member = re.match(r'^(\w+)\s*(?:=\s*(.+))?$', entry)
        if not member:
            continue
        if member.group(2):
            try:
                value = eval(member.group(2), {'__builtins__': {}}, dict(out_by_name))  # noqa: S307
            except Exception:
                continue
        if 'dummy' not in comment.lower():
            out.setdefault(value, member.group(1))
        out_by_name[member.group(1)] = value
        value += 1
    return out


out_by_name = {}


def defines(path):
    """#define NAME <expr> pairs, in file order."""
    out = []
    try:
        src = open(path, encoding='utf-8').read()
    except FileNotFoundError:
        return out
    for m in re.finditer(r'^#define\s+(\w+)\s+(.+?)\s*(?://.*)?$', src, re.M):
        out.append((m.group(1), m.group(2).strip()))
    return out


def rank(label):
    """How much a name tells you, lowest first.

    A value can carry several names. `TEMP_1` and `UNUSED_0x020` say
    only that a slot exists; `HIDDEN_ITEMS_START` marks where a block
    begins and belongs to the block, not to its first member. A name
    that describes what the flag is for beats all of them.
    """
    if re.fullmatch(r'(TEMP_)?[0-9A-FX_]+', label):
        return 3        # TEMP_1, 0x0B4
    if label.startswith('UNUSED'):
        return 2
    if re.search(r'_(START|END|COUNT)$', label):
        return 1        # the marker for a range, not a flag in itself
    return 0


def resolve(pairs, prefix, drop_zero=True):
    """NAME -> number, for the names that are plain arithmetic.

    Values reference other names, so this repeats until nothing new
    resolves rather than assuming the file is in dependency order.
    """
    known, pending = {}, list(pairs)
    for _ in range(8):
        rest = []
        for name, expr in pending:
            if not re.fullmatch(r'[\w\s()+\-*x0-9A-Fa-f]+', expr):
                continue
            try:
                value = eval(expr, {'__builtins__': {}}, dict(known))  # noqa: S307
            except Exception:
                rest.append((name, expr))
                continue
            if isinstance(value, int):
                known[name] = value
        if len(rest) == len(pending):
            break
        pending = rest
    # Several names can share a value (aliases, and unused slots named
    # after their neighbours). The first definition is the canonical one.
    # Several names can share a value: aliases, the stubs that define
    # the other game's flags as 0, and the markers that name where a
    # block of flags begins. Definition order does not pick the useful
    # one - FLAG_TEMP_1 is defined before FLAG_TEMP_SKIP_GABBY_INTERVIEW
    # and FLAG_HIDDEN_ITEMS_START before the first hidden item - so the
    # names are ranked and the most descriptive wins.
    #
    # Flags and vars drop 0 - neither starts there, so anything landing
    # on it is a stub - but sprite and music ids do start at 0.
    out = {}
    for name, value in known.items():
        if not name.startswith(prefix) or (drop_zero and value == 0):
            continue
        label = name[len(prefix):]
        if value not in out or rank(label) < rank(out[value]):
            out[value] = label
    return out


def ordered(path, pattern, prefix=''):
    """Names numbered by the order they appear, e.g. def_special lines."""
    out = {}
    for i, m in enumerate(re.finditer(pattern, open(f'{root}/{path}', encoding='utf-8'). read(), re.M)):
        out[i] = prefix + m.group(1)
    return out


# flags.h counts its trainer flags from the trainer ids, so the headers
# it includes have to be resolved alongside it. The _frlg headers are
# left out on purpose: the two files define each other's names as 0 so
# that whichever game is not being built compiles away, and mixing them
# would hand those stubs the id 0.
flags = resolve(sum((defines(f'{root}/include/constants/{f}.h') for f in
                     ('trainers', 'opponents', 'rematches', 'flags')), []), 'FLAG_')
variables = resolve(defines(f'{root}/include/constants/vars.h'), 'VAR_')
specials = ordered('data/specials.inc', r'^\s*def_special\s+(\w+)')
# gStdScripts is one list among many .4byte runs; keep only the block
# that follows the gStdScripts label.
src = open(f'{root}/data/event_scripts.s', encoding='utf-8').read()
block = src.split('gStdScripts::', 1)[1].split('gStdScripts_End', 1)[0]
stds = {i: m.group(1) for i, m in enumerate(re.finditer(r'^\s*\.4byte\s+Std_(\w+)', block, re.M))}


def table(name, mapping, doc):
    print(f'\n/** {doc} */')
    print(f'export const {name}: Record<number, string> = {{')
    for k in sorted(mapping):
        print(f'  {k}: {json.dumps(mapping[k])},')
    print('}')


print('// GENERATED by scripts/gen-symbols.py - do not hand-edit.')
print('// Regenerate from a pokeemerald-expansion decomp when it changes.')
print('// Prefixes (FLAG_, VAR_, Std_, OBJ_EVENT_GFX_) are stripped: the')
print('// editor adds back whatever context the field needs.')
table('GEN3_FLAG_NAMES', flags, 'Story/progress flags, by number.')
table('GEN3_VAR_NAMES', variables, 'Script variables, by number (0x4000 and up).')
table('GEN3_SPECIAL_NAMES', specials, 'Native functions callable with `special`, in table order.')
table('GEN3_STD_SCRIPTS', stds, 'The standard scripts `callstd` runs, in table order.')
def stripped(mapping, prefix):
    return {k: (v[len(prefix):] if v.startswith(prefix) else v) for k, v in mapping.items()}


sprites = stripped(resolve(defines(f'{root}/include/constants/event_objects.h'), 'OBJ_EVENT_GFX_', drop_zero=False), '')
bg_kinds = {0: 'Facing any', 1: 'Facing north', 2: 'Facing south', 3: 'Facing east', 4: 'Facing west',
            7: 'Hidden item', 8: 'Secret base'}
music = stripped(resolve(defines(f'{root}/include/constants/trainers.h'), 'TRAINER_ENCOUNTER_MUSIC_', drop_zero=False), '')
hold = stripped(enum_values('include/constants/hold_effects.h', 'HoldEffect'), 'HOLD_EFFECT_')
sort_types = stripped(enum_values('include/item.h', 'ItemSortType'), 'ITEM_TYPE_')
use_types = stripped(enum_values('include/constants/items.h', 'ItemType'), 'ITEM_USE_')
battle_use = stripped(enum_values('include/constants/items.h', 'EffectItem'), 'EFFECT_ITEM_')

table('GEN3_OBJ_EVENT_GFX', sprites, 'Overworld sprite ids, by number.')
table('GEN3_BG_EVENT_KINDS', bg_kinds, 'What a bg event does: face the player, or hide an item.')
table('GEN3_ENCOUNTER_MUSIC', music, 'The fanfare a trainer starts a battle with.')
table('GEN3_HOLD_EFFECTS', hold, "An item's effect while a mon holds it.")
table('GEN3_ITEM_SORT_TYPES', sort_types, 'Which shelf of the bag an item sorts onto.')
table('GEN3_ITEM_USE_TYPES', use_types, 'Where using an item takes the player.')
table('GEN3_ITEM_BATTLE_USE', battle_use, 'What an item does when used in a battle.')

print(f'\n// flags {len(flags)}, vars {len(variables)}, specials {len(specials)}, std {len(stds)}, '
      f'sprites {len(sprites)}, hold {len(hold)}, sort {len(sort_types)}, use {len(use_types)}, '
      f'battle {len(battle_use)}, music {len(music)}',
      file=sys.stderr)
