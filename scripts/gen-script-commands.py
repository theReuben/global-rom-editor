"""
Generates the Gen 3 script command table from a pret-style decomp.

Every script command is declared twice in the sources: its opcode in
include/constants/script_commands.h, and its argument layout in the
assembler macro that emits it (asm/macros/event.inc). The macro body is
a literal list of .byte/.2byte/.4byte directives, so both the size and
the argument types are read straight off it rather than transcribed by
hand - transcription is exactly where byte-format bugs come from.

Three wrinkles the parser has to handle:

  * Conditionals are usually bookkeeping, not branching emission.
    trainerbattle uses .ifgt purely to compute a flags byte with .set and
    is a fixed 40 bytes; .warning inside an .if likewise emits nothing.
    Only a conditional that emits makes a command variable-size.
  * One macro can define two commands. applymovement emits
    SCR_OP_APPLYMOVEMENT or SCR_OP_APPLYMOVEMENTAT depending on whether
    a map was given, so each branch is collected separately.
  * Macros call other macros. `map \\map` expands to two bytes, so nested
    calls are resolved recursively.

Usage: python3 scripts/gen-script-commands.py <decomp-dir> > out.ts
"""
import re, sys, json

def arg_name(operand):
    """Macro operands look like `\\value` or `SPECIAL_\\function`; the
    parameter name is the part after the last backslash."""
    name = operand.split('\\')[-1].strip()
    name = re.sub(r'[^A-Za-z0-9_].*$', '', name)
    return name or 'arg'


EMIT = {'.byte': 1, '.2byte': 2, '.4byte': 4, '.short': 2, '.word': 4, '.int': 4}
# Directives that produce no bytes, so they cannot change a command's size.
HARMLESS = {'.set', '.warning', '.error', '.print', '.fail', '.equiv', '.equ'}


def opcodes(root):
    out = {}
    for line in open(f'{root}/include/constants/script_commands.h', encoding='utf-8'):
        m = re.match(r'\s*(SCR_OP_\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)', line)
        if m:
            out[m.group(1)] = int(m.group(2), 0)
    return out


def macro_bodies(root):
    src = open(f'{root}/asm/macros/event.inc', encoding='utf-8').read()
    out = {}
    for block in re.split(r'^\s*\.macro\s+', src, flags=re.M)[1:]:
        body = block.split('.endm')[0]
        head, *rest = body.split('\n')
        out[head.split()[0].rstrip(':').strip()] = rest
    return out


def parse(lines, ops, macros, seen=()):
    """Yields (opcode, name, args, variable) for each command a macro defines."""
    commands = []          # finished commands
    cur = None             # (opcode, args, variable)

    def flush():
        if cur:
            commands.append(cur)

    for raw in lines:
        line = raw.split('@')[0].strip()
        if not line:
            continue
        for piece in [p.strip() for p in line.split(';') if p.strip()]:
            token = piece.split()[0]
            if token in HARMLESS or re.match(r'\.if|\.else|\.endif|\.endm', token):
                continue
            if token in EMIT:
                operand = piece.split(None, 1)[1] if len(piece.split(None, 1)) > 1 else ''
                parts = [p.strip() for p in operand.split(',')]
                # A `.byte SCR_OP_*` starts a new command definition.
                if token == '.byte' and parts and parts[0] in ops:
                    flush()
                    cur = (ops[parts[0]], macros_name_for(parts[0]), [], False)
                    parts = parts[1:]
                if cur is None:
                    continue
                for part in parts:
                    cur[2].append({'name': arg_name(part), 'size': EMIT[token]})
                continue
            if token.startswith('.'):
                if cur:
                    cur = (cur[0], cur[1], cur[2], True)   # unknown directive
                continue
            # A nested macro call: expand it for its bytes.
            if token in macros and token not in seen and cur:
                nested = parse(macros[token], ops, macros, seen + (token,))
                if nested and not nested[0][3] and nested[0][0] is None:
                    cur[2].extend(nested[0][2])
                else:
                    inline = inline_size(macros[token], ops, macros, seen + (token,))
                    if inline is None:
                        cur = (cur[0], cur[1], cur[2], True)
                    else:
                        cur[2].extend(inline)
    flush()
    return commands


def inline_size(lines, ops, macros, seen):
    """Args emitted by a macro that does not start its own command."""
    args = []
    for raw in lines:
        line = raw.split('@')[0].strip()
        if not line:
            continue
        for piece in [p.strip() for p in line.split(';') if p.strip()]:
            token = piece.split()[0]
            if token in HARMLESS or re.match(r'\.if|\.else|\.endif|\.endm', token):
                continue
            if token in EMIT:
                operand = piece.split(None, 1)[1] if len(piece.split(None, 1)) > 1 else ''
                for part in [p.strip() for p in operand.split(',')]:
                    args.append({'name': arg_name(part), 'size': EMIT[token]})
                continue
            if token in macros and token not in seen:
                nested = inline_size(macros[token], ops, macros, seen + (token,))
                if nested is None:
                    return None
                args.extend(nested)
                continue
            if token.startswith('.'):
                return None
    return args


NAMES = {}


def macros_name_for(op_constant):
    return NAMES.get(op_constant, op_constant[7:].lower())


root = sys.argv[1]
ops = opcodes(root)
macros = macro_bodies(root)
# Prefer the macro's own name where one macro defines one command.
for name, lines in macros.items():
    for raw in lines:
        line = raw.split('@')[0].strip()
        if line.startswith('.byte'):
            first = line.split(None, 1)[1].split(',')[0].strip() if len(line.split(None, 1)) > 1 else ''
            if first in ops:
                NAMES.setdefault(first, name)
            break

table = {}
for name, lines in macros.items():
    for op, cname, args, variable in parse(lines, ops, macros):
        if op is not None and not variable:
            table.setdefault(op, {'name': cname, 'args': args})

sys.stderr.write(f'{len(table)} of {len(ops)} commands have a fixed layout\n')

print('// GENERATED by scripts/gen-script-commands.py - do not hand-edit.')
print('// Regenerate from a pokeemerald-expansion decomp when it changes.')
print('')
print('export interface ScriptArg {')
print('  name: string')
print('  /** Operand width in bytes. */')
print('  size: 1 | 2 | 4')
print('}')
print('')
print('export interface ScriptCommand {')
print('  name: string')
print('  args: ScriptArg[]')
print('}')
print('')
print('/** Opcode -> layout, for commands whose size does not vary. */')
print('export const GEN3_SCRIPT_COMMANDS: Record<number, ScriptCommand> = {')
for op in sorted(table):
    c = table[op]
    args = ', '.join('{ name: %s, size: %d }' % (json.dumps(a['name']), a['size']) for a in c['args'])
    print(f"  0x{op:02x}: {{ name: {json.dumps(c['name'])}, args: [{args}] }},")
print('}')
