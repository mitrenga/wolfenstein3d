const { SOUND, SOUNDS } = await import('./soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * **Which effect has a digitised version, and which one.**
 *
 * The digitised sounds of Wolfenstein do not live in AUDIOT with the PC and
 * the AdLib bands - they are in VSWAP, after the walls and the sprites, as
 * unsigned eight-bit samples at 7 000 Hz, and they have a **numbering of
 * their own**. A table in the game connects the two: sound 18 (`OPENDOOR`)
 * is digitised sound 3, sound 24 (`ATKPISTOL`) is digitised sound 5, and
 * most effects have no digitised version at all.
 *
 * A machine with a Sound Blaster played both: the music and the effects
 * without a digitised version came out of the card's FM part, exactly as
 * an AdLib made them, and these twenty came out of the DAC. That is the
 * rule the game applies, and it is why a door in the original sounds like a
 * recording while the menu beeps do not (`ID_SD.C`: `if ((DigiMode !=
 * sds_Off) && (DigiMap[sound] != -1)) ...; return true` - the FM version of
 * a mapped sound is **not** played as well).
 *
 * ## Why these twenty and not the other twenty-six
 *
 * The table in the released source has two halves: the shareware one and,
 * behind `#ifndef UPLOAD`, the twenty-six the registered game adds. The
 * shareware half names exactly the digitised sounds
 *
 *     0..15, 20, 21, 22, 32
 *
 * and those are **exactly the slots filled in the VSWAP of the shareware**
 * (`data/sounds/digi.json`: twenty sounds in forty-six slots, the rest
 * empty). Two independent things agreeing like that is what makes this a
 * measurement rather than a copy - `checkaudio` checks it.
 *
 * The names are this game's own ({@link SOUND}); the numbering of the
 * shareware data is what W1 measured, so the pairs are written by name and
 * the numbers fall out of the table.
 */
const SHAREWARE = [
  ['HALT', 0], ['DOGBARK', 1], ['CLOSEDOOR', 2], ['OPENDOOR', 3],
  ['ATKMACHINEGUN', 4], ['ATKPISTOL', 5], ['ATKGATLING', 6], ['SCHUTZAD', 7],
  ['GUTENTAG', 8], ['MUTTI', 9], ['BOSSFIRE', 10], ['SSFIRE', 11],
  ['DEATHSCREAM1', 12], ['DEATHSCREAM2', 13], ['DEATHSCREAM3', 13],
  ['TAKEDAMAGE', 14], ['PUSHWALL', 15],
  ['LEBEN', 20], ['NAZIFIRE', 21], ['SLURPIE', 22], ['YEAH', 32]
];

/**
 * The twenty-six the registered game adds. They are written down because
 * the table is one table, but **the shareware data has none of them** - the
 * VSWAP slots they name are empty - so nothing here uses them until the
 * registered data is the one being read.
 */
const REGISTERED = [
  ['DOGDEATH', 16], ['AHHHG', 17], ['DIE', 18], ['EVA', 19],
  ['TOT_HUND', 23], ['MEINGOTT', 24], ['SCHABBSHA', 25], ['HITLERHA', 26],
  ['SPION', 27], ['NEINSOVAS', 28], ['DOGATTACK', 29], ['LEVELDONE', 30],
  ['MECHSTEP', 31], ['SCHEIST', 33],
  ['DEATHSCREAM4', 34], ['DEATHSCREAM5', 35], ['DEATHSCREAM6', 39],
  ['DEATHSCREAM7', 40], ['DEATHSCREAM8', 41], ['DEATHSCREAM9', 42],
  ['DONNER', 36], ['EINE', 37], ['ERLAUBEN', 38],
  ['KEIN', 43], ['MEIN', 44], ['ROSE', 45]
];

/**
 * Builds the table the game keeps: one entry per effect, the digitised
 * number or **-1**, which is what `InitDigiMap` leaves everywhere it has
 * nothing to say.
 * @param {boolean} [registered=false] - Include the sounds only the
 *        registered data has.
 * @returns {number[]} `DIGI_MAP[soundNumber]`.
 */
export function buildDigiMap(registered) {
  var map = new Array(SOUNDS).fill(-1);
  var pairs = registered ? SHAREWARE.concat(REGISTERED) : SHAREWARE;
  for (var i = 0; i < pairs.length; i++) {
    var number = SOUND[pairs[i][0]];
    if (number !== undefined) map[number] = pairs[i][1];
  }
  return map;
} // buildDigiMap

/** The table for the data this build reads: the shareware one. */
export const DIGI_MAP = buildDigiMap(false);

/** The pairs themselves, for the tools that check them against the data. */
export const DIGI_PAIRS = {shareware: SHAREWARE, registered: REGISTERED};

export default DIGI_MAP;
