// begin code

/**
 * What the sounds and the tracks of the game are called.
 *
 * AUDIOT holds every effect three times over - PC speaker, AdLib and a
 * digitised band the game never filled - and the music after them. The
 * numbering is the same for all three bands, so one number names the sound
 * whichever card is playing it; the digitised version of an effect lives in
 * VSWAP instead and has a numbering of its own.
 *
 * The names are the game's own (the MUSE header of the release whose layout
 * the shareware data matches - 87 effects and the music from 261, which is
 * what W1 measured in the file, not the 69/207 of the older header).
 * `SOUND.HITWALL` is `HITWALLSND`, `MUSIC.WONDERIN` is `WONDERIN_MUS`.
 *
 * Episode one fills 11 of the 27 tracks; the rest of the table points at
 * stubs with nothing but a name in them.
 */
export const SOUND = {
  HITWALL: 0,
  SELECTWPN: 1,
  SELECTITEM: 2,
  HEARTBEAT: 3,
  MOVEGUN2: 4,
  MOVEGUN1: 5,
  NOWAY: 6,
  NAZIHITPLAYER: 7,
  SCHABBSTHROW: 8,
  PLAYERDEATH: 9,
  DOGDEATH: 10,
  ATKGATLING: 11,
  GETKEY: 12,
  NOITEM: 13,
  WALK1: 14,
  WALK2: 15,
  TAKEDAMAGE: 16,
  GAMEOVER: 17,
  OPENDOOR: 18,
  CLOSEDOOR: 19,
  DONOTHING: 20,
  HALT: 21,
  DEATHSCREAM2: 22,
  ATKKNIFE: 23,
  ATKPISTOL: 24,
  DEATHSCREAM3: 25,
  ATKMACHINEGUN: 26,
  HITENEMY: 27,
  SHOOTDOOR: 28,
  DEATHSCREAM1: 29,
  GETMACHINE: 30,
  GETAMMO: 31,
  SHOOT: 32,
  HEALTH1: 33,
  HEALTH2: 34,
  BONUS1: 35,
  BONUS2: 36,
  BONUS3: 37,
  GETGATLING: 38,
  ESCPRESSED: 39,
  LEVELDONE: 40,
  DOGBARK: 41,
  ENDBONUS1: 42,
  ENDBONUS2: 43,
  BONUS1UP: 44,
  BONUS4: 45,
  PUSHWALL: 46,
  NOBONUS: 47,
  PERCENT100: 48,
  BOSSACTIVE: 49,
  MUTTI: 50,
  SCHUTZAD: 51,
  AHHHG: 52,
  DIE: 53,
  EVA: 54,
  GUTENTAG: 55,
  LEBEN: 56,
  SCHEIST: 57,
  NAZIFIRE: 58,
  BOSSFIRE: 59,
  SSFIRE: 60,
  SLURPIE: 61,
  TOT_HUND: 62,
  MEINGOTT: 63,
  SCHABBSHA: 64,
  HITLERHA: 65,
  SPION: 66,
  NEINSOVAS: 67,
  DOGATTACK: 68,
  FLAMETHROWER: 69,
  MECHSTEP: 70,
  GOOBS: 71,
  YEAH: 72,
  DEATHSCREAM4: 73,
  DEATHSCREAM5: 74,
  DEATHSCREAM6: 75,
  DEATHSCREAM7: 76,
  DEATHSCREAM8: 77,
  DEATHSCREAM9: 78,
  DONNER: 79,
  EINE: 80,
  ERLAUBEN: 81,
  KEIN: 82,
  MEIN: 83,
  ROSE: 84,
  MISSILEFIRE: 85,
  MISSILEHIT: 86,
};

export const SOUNDS = 87;

export const MUSIC = {
  CORNER: 0,
  DUNGEON: 1,
  WARMARCH: 2,
  GETTHEM: 3,
  HEADACHE: 4,
  HITLWLTZ: 5,
  INTROCW3: 6,
  NAZI_NOR: 7,
  NAZI_OMI: 8,
  POW: 9,
  SALUTE: 10,
  SEARCHN: 11,
  SUSPENSE: 12,
  VICTORS: 13,
  WONDERIN: 14,
  FUNKYOU: 15,
  ENDLEVEL: 16,
  GOINGAFT: 17,
  PREGNANT: 18,
  ULTIMATE: 19,
  NAZI_RAP: 20,
  ZEROHOUR: 21,
  TWELFTH: 22,
  ROSTER: 23,
  URAHERO: 24,
  VICMARCH: 25,
  PACMAN: 26,
};

export const TRACKS = 27;

/**
 * Which track plays on which level of episode one (`songs` of the original):
 * four tunes over the eight ordinary levels, a march for Hans and the corner
 * tune for the secret level.
 *
 * It lives here, in the smallest module of the game, because **both sides
 * need it**: the game to start the music, and the model to fetch that one
 * track before the megabytes of sprites, so that the worker has it rendered
 * by the time the level starts.
 */
export const LEVEL_SONGS = [
  MUSIC.GETTHEM, MUSIC.SEARCHN, MUSIC.POW, MUSIC.SUSPENSE,
  MUSIC.GETTHEM, MUSIC.SEARCHN, MUSIC.POW, MUSIC.SUSPENSE,
  MUSIC.WARMARCH, MUSIC.CORNER
];
