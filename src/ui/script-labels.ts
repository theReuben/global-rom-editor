/**
 * Plain-English names for script commands and their arguments.
 *
 * A script reads as machine code by default - `callstd 4`, `setflag 151`,
 * `compare_var_to_value 16385 1`. The command names come from the decomp
 * and are worth keeping (they are what every guide and forum post uses),
 * but on their own they say nothing about what the event does, and the
 * numbers say less. So each command gets a sentence, and each argument
 * is classified by what its number *means* - a flag, a var, an item, a
 * species - so the editor can name it or offer the right dropdown.
 *
 * The classification keys off the argument names, which come from the
 * decomp macros' own parameters and so track the source rather than a
 * transcription of it.
 */
import { GEN3_FLAG_NAMES, GEN3_SPECIAL_NAMES, GEN3_STD_SCRIPTS, GEN3_VAR_NAMES } from '../core/games/gen3-symbols'

/** What a script argument's number refers to. */
export type ArgKind = 'flag' | 'var' | 'std' | 'special' | 'condition' | 'item' | 'species' | 'move' | 'trainer' | 'plain'

/** Vars are addressed from 0x4000 up; anything below is a literal. */
export const VARS_START = 0x4000

/** The six ways `goto_if` and friends compare, from sScriptConditionTable. */
export const SCRIPT_CONDITIONS = ['<', '=', '>', '<=', '>=', '≠']

const COMMAND_LABELS: Record<string, string> = {
  // Flow
  end: 'End the script',
  return: 'Return to the caller',
  goto: 'Jump',
  goto_if: 'Jump if',
  call: 'Run another script, then come back',
  call_if: 'Run another script if',
  callstd: 'Run a standard script',
  callstd_if: 'Run a standard script if',
  gotostd: 'Jump into a standard script',
  nop: 'Do nothing',
  // Player and NPC control
  lock: 'Freeze this NPC',
  lockall: 'Freeze everyone',
  release: 'Unfreeze this NPC',
  releaseall: 'Unfreeze everyone',
  faceplayer: 'Turn to face the player',
  applymovement: 'Move someone',
  waitmovement: 'Wait for the movement to finish',
  addobject: 'Make someone appear',
  removeobject: 'Make someone disappear',
  showobjectat: 'Show someone',
  hideobjectat: 'Hide someone',
  turnobject: 'Turn someone',
  // Talking
  message: 'Load a message',
  msgbox: 'Show a message',
  waitmessage: 'Wait for the message',
  closemessage: 'Close the message box',
  braillemessage: 'Show braille',
  multichoice: 'Ask a multiple choice question',
  yesnobox: 'Ask yes or no',
  playmoncry: "Play a Pokémon's cry",
  waitmoncry: 'Wait for the cry',
  // State
  setflag: 'Set a flag',
  clearflag: 'Clear a flag',
  checkflag: 'Check a flag',
  setvar: 'Set a variable',
  addvar: 'Add to a variable',
  subvar: 'Subtract from a variable',
  copyvar: 'Copy a variable',
  setorcopyvar: 'Set a variable (or copy one)',
  compare_var_to_value: 'Compare a variable with a number',
  compare_var_to_var: 'Compare two variables',
  special: 'Run a built-in routine',
  specialvar: 'Run a built-in routine and keep its result',
  // Things
  additem: 'Give an item',
  removeitem: 'Take an item away',
  checkitem: 'Check for an item',
  checkitemspace: 'Check there is bag room',
  givemon: 'Give a Pokémon',
  giveegg: 'Give an Egg',
  pokemart: 'Open a shop',
  addmoney: 'Give money',
  removemoney: 'Take money',
  // World
  warp: 'Warp the player',
  warpsilent: 'Warp with no sound',
  warpdoor: 'Warp through a door',
  setweather: 'Change the weather',
  doweather: 'Apply the weather change',
  playse: 'Play a sound effect',
  waitse: 'Wait for the sound',
  playbgm: 'Play music',
  fadescreen: 'Fade the screen',
  delay: 'Wait',
  waitstate: 'Wait for the game to catch up',
  waitbuttonpress: 'Wait for a button press',
  trainerbattle: 'Battle a trainer',
  callnative: 'Run native code',
  loadword: 'Load a value',
}

/** A sentence for what this command does, or null to show it bare. */
export function commandLabel(name: string): string | null {
  return COMMAND_LABELS[name] ?? null
}

const VAR_COMMANDS = new Set([
  'setvar', 'addvar', 'subvar', 'copyvar', 'setorcopyvar', 'compare_var_to_value',
  'compare_var_to_var', 'specialvar', 'random',
])

export function argKindFor(command: string, argName: string): ArgKind {
  if (argName === 'flag') return 'flag'
  if (argName === 'condition') return 'condition'
  if (argName === 'var' || (VAR_COMMANDS.has(command) && ['destination', 'source', 'output', 'input'].includes(argName)))
    return 'var'
  if (argName === 'function') {
    if (command.startsWith('special')) return 'special'
    if (command.includes('std')) return 'std'
  }
  if (argName === 'item' || argName === 'itemId') return 'item'
  if (argName === 'species') return 'species'
  if (argName === 'move') return 'move'
  if (argName.startsWith('trainer') && argName !== 'trainerbattle_flags') return 'trainer'
  return 'plain'
}

/**
 * The name behind a number, when there is one. Names are shown beside
 * the value rather than replacing it: the number is what the ROM holds,
 * and a hack that repurposes a flag still needs it editable.
 */
export function symbolFor(kind: ArgKind, value: number): string | null {
  switch (kind) {
    case 'flag':
      return GEN3_FLAG_NAMES[value] ?? null
    case 'var':
      return value >= VARS_START ? (GEN3_VAR_NAMES[value] ?? null) : null
    case 'special':
      return GEN3_SPECIAL_NAMES[value] ?? null
    case 'std':
      return GEN3_STD_SCRIPTS[value] ?? null
    case 'condition':
      return SCRIPT_CONDITIONS[value] ?? null
    default:
      return null
  }
}
