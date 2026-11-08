const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
const { SPRITE } = await import('./spriteNumbers.js?ver='+window.srcVersion);
const { SOUND } = await import('./soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * The level as the game holds it while it is being played: the walls, the
 * doors, the things standing about, and which parts of it can hear each
 * other.
 *
 * A level on disk is three planes of 64 x 64 words (`data/levels/levelNN.json`).
 * Plane 0 is walls, doors and floor codes; plane 1 says where the player,
 * the guards, the treasure and the lamps are; plane 2 was never used. What
 * the game makes of plane 0 is `tilemap`, one byte a tile, and this is the
 * heart of the whole engine, so the encoding is worth stating plainly:
 *
 *   0             you can walk here
 *   1..63         a wall, and the number picks its texture
 *   bit 6 (0x40)  set on the tiles either side of a door: they draw the
 *                 door jamb instead of their own texture
 *   bit 7 (0x80)  a door; the low six bits are which door
 *   0xC0 | tile   a secret wall that is moving right now
 *
 * `actorat` is the same grid again, but it holds what is *in* the tile: a
 * wall number, a door, an actor, or nothing. The original keeps a pointer
 * and a number in the same slot and tells them apart by their value; here a
 * number is a number and an actor is an object, which is the same
 * distinction with less arithmetic.
 *
 * Floor codes (107 and up) split the level into areas. Two areas hear each
 * other while a door between them is open, and that is what decides whether
 * a guard two rooms away wakes up when you fire - so the connections are
 * counted here, not guessed from distance.
 */
export class WolfWorld {

  // ---------------------------------------------------------------- tiles

  static get MAPSIZE() { return 64; }
  static get MAXDOORS() { return 64; }
  static get MAXSTATS() { return 400; }
  /** the floor codes, and how many of them there are */
  static get AREATILE() { return 107; }
  static get NUMAREAS() { return 37; }
  /** a guard standing on this one does not wake until he sees you */
  static get AMBUSHTILE() { return 106; }
  /** the tile you push to finish a level, and the one that hides a secret */
  static get ELEVATORTILE() { return 21; }
  static get EXITTILE() { return 99; }
  static get PUSHABLETILE() { return 98; }
  /** a door takes three seconds of tics to shut itself again */
  static get OPENTICS() { return 300; }

  /** what a door is locked with */
  static get LOCK() { return { NORMAL: 0, LOCK1: 1, LOCK2: 2, LOCK3: 3, LOCK4: 4, ELEVATOR: 5 }; }
  /** what a door is doing */
  static get DOOR() { return { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3 }; }
  /** the eight ways an actor can face (`dirtype`) */
  static get DIR() { return { EAST: 0, NORTHEAST: 1, NORTH: 2, NORTHWEST: 3, WEST: 4, SOUTHWEST: 5, SOUTH: 6, SOUTHEAST: 7, NODIR: 8 }; }
  /**
   * The four a secret wall can be pushed (`controldir_t`). These are **not**
   * the same numbers as {@link WolfWorld.DIR}, and the ray caster compares
   * `pwalldir` against these - mixing the two sends a moving wall sideways.
   */
  static get PUSHDIR() { return { NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3 }; }

  /**
   * What kind of thing a static object is: something you walk into,
   * something you pick up, or something that is only there to look at. The
   * numbers are the original's `stat_t`, because a bonus keeps its own
   * number as `itemnumber` and the pickup code switches on it.
   */
  static get STAT() {
    return {
      dressing: 0, block: 1, bo_gibs: 2, bo_alpo: 3, bo_firstaid: 4, bo_key1: 5,
      bo_key2: 6, bo_key3: 7, bo_key4: 8, bo_cross: 9, bo_chalice: 10, bo_bible: 11,
      bo_crown: 12, bo_clip: 13, bo_clip2: 14, bo_machinegun: 15, bo_chaingun: 16,
      bo_food: 17, bo_fullheal: 18, bo_25clip: 19, bo_spear: 20
    };
  } // STAT

  /**
   * The 48 things plane 1 can put on the floor, in the order it numbers
   * them (`statinfo` of the original): which sprite, and what it is. A
   * trailing entry repeats the ammo clip as `bo_clip2`, the one a dead
   * guard leaves behind.
   */
  static get STATINFO() {
    var stat = WolfWorld.STAT;
    var sprite = (index) => SPRITE['STAT_' + index];
    var list = [
      [0, stat.dressing], [1, stat.block], [2, stat.block], [3, stat.block],
      [4, stat.dressing], [5, stat.block], [6, stat.bo_alpo], [7, stat.block],
      [8, stat.block], [9, stat.dressing], [10, stat.block], [11, stat.block],
      [12, stat.block], [13, stat.block], [14, stat.dressing], [15, stat.dressing],
      [16, stat.block], [17, stat.block], [18, stat.block], [19, stat.dressing],
      [20, stat.bo_key1], [21, stat.bo_key2], [22, stat.block], [23, stat.dressing],
      [24, stat.bo_food], [25, stat.bo_firstaid], [26, stat.bo_clip], [27, stat.bo_machinegun],
      [28, stat.bo_chaingun], [29, stat.bo_cross], [30, stat.bo_chalice], [31, stat.bo_bible],
      [32, stat.bo_crown], [33, stat.bo_fullheal], [34, stat.bo_gibs], [35, stat.block],
      [36, stat.block], [37, stat.block], [38, stat.bo_gibs], [39, stat.block],
      [40, stat.block], [41, stat.dressing], [42, stat.dressing], [43, stat.dressing],
      [44, stat.dressing], [45, stat.block], [46, stat.block], [47, stat.dressing]
    ];
    var info = list.map(([index, type]) => ({ picnum: sprite(index), type: type }));
    // the clip a dead guard drops is the same picture with a type of its own
    info.push({ picnum: SPRITE.STAT_26, type: stat.bo_clip2 });
    return info;
  } // STATINFO

  /** The bonuses that count towards the treasure score of a level. */
  static get TREASURE() {
    var stat = WolfWorld.STAT;
    return [stat.bo_cross, stat.bo_chalice, stat.bo_bible, stat.bo_crown, stat.bo_fullheal];
  } // TREASURE

  // ----------------------------------------------------------------- life

  constructor() {
    this.id = 'WolfWorld';
    var tiles = WolfWorld.MAPSIZE * WolfWorld.MAPSIZE;

    /** plane 0 as it is on disk, which the game keeps reading for areas */
    this.mapPlane0 = new Uint16Array(tiles);
    /** plane 1, the things; the game blanks entries it has dealt with */
    this.mapPlane1 = new Uint16Array(tiles);
    /** walls, doors and moving secret walls, one byte a tile */
    this.tilemap = new Uint8Array(tiles);
    /** what is in a tile: a number, an actor, or null */
    this.actorat = new Array(tiles).fill(null);
    /** which tiles a ray touched this frame */
    this.spotvis = new Uint8Array(tiles);

    /** the doors of this level, at most 64 */
    this.doors = [];
    /** how far each door is open, 0 shut, 0xffff wide open */
    this.doorposition = new Uint16Array(WolfWorld.MAXDOORS);
    /** how many doors connect each pair of areas */
    this.areaconnect = new Uint8Array(WolfWorld.NUMAREAS * WolfWorld.NUMAREAS);
    /** which areas the player can be heard in */
    this.areabyplayer = new Uint8Array(WolfWorld.NUMAREAS);

    /** the lamps, the tables and the treasure */
    this.statics = [];

    /** the secret wall that is moving, if any */
    this.pwallstate = 0;
    this.pwallpos = 0;
    this.pwallx = 0;
    this.pwally = 0;
    this.pwalldir = 0;
    /** the texture the moving wall shows */
    this.pwalltile = 0;

    /** the game this world belongs to, for sounds and counters */
    this.game = null;
  } // constructor

  /** The index of a tile; the original's `(x<<6)+y`. */
  at(x, y) {
    return (x << 6) + y;
  } // at

  tileAt(x, y) {
    return this.tilemap[(x << 6) + y];
  } // tileAt

  /** Whether something is standing in a tile (`actorat` in the original). */
  occupied(x, y) {
    return this.actorat[(x << 6) + y] !== null;
  } // occupied

  /** The actor in a tile, or null when what is there is a wall or a door. */
  actorAt(x, y) {
    var thing = this.actorat[(x << 6) + y];
    return thing !== null && typeof thing === 'object' ? thing : null;
  } // actorAt

  /** The floor code of a tile, and with it the area it belongs to. */
  areaOf(x, y) {
    return this.mapPlane0[(x << 6) + y] - WolfWorld.AREATILE;
  } // areaOf

  // -------------------------------------------------------------- the level

  /**
   * `SetupGameLevel`: takes the three planes apart into the grid the engine
   * runs on, spawns the doors, then hands plane 1 to the game so it can put
   * the player, the guards and the things where they belong, and finally
   * rubs out the ambush markers.
   *
   * @param {Object} level - `data/levels/levelNN.json`, planes as base64.
   * @param {Object} game - The game; `spawnThing(tile, x, y)` is called for
   *        every entry of plane 1 and returns whether it was taken.
   */
  setupLevel(level, game) {
    this.game = game;
    this.mapPlane0 = WolfWorld.readPlane(level.planes[0]);
    this.mapPlane1 = WolfWorld.readPlane(level.planes[1]);
    this.tilemap.fill(0);
    this.actorat.fill(null);
    this.spotvis.fill(0);
    this.doors = [];
    this.doorposition.fill(0);
    this.areaconnect.fill(0);
    this.areabyplayer.fill(0);
    this.statics = [];
    this.pwallstate = this.pwallpos = this.pwallx = this.pwally = this.pwalldir = 0;
    this.pwalltile = 0;

    var size = WolfWorld.MAPSIZE;
    // the walls: everything below the first floor code is solid
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var tile = this.mapPlane0[y * size + x];
        var spot = this.at(x, y);
        if (tile < WolfWorld.AREATILE) {
          this.tilemap[spot] = tile;
          this.actorat[spot] = tile;
        } else {
          this.tilemap[spot] = 0;
          this.actorat[spot] = null;
        }
      }
    }

    // the doors, which take the area number of the tile behind them
    for (var dy = 0; dy < size; dy++) {
      for (var dx = 0; dx < size; dx++) {
        var doorTile = this.mapPlane0[dy * size + dx];
        if (doorTile >= 90 && doorTile <= 101) {
          this.spawnDoor(dx, dy, (doorTile & 1) === 0, Math.floor((doorTile - 90) / 2));
        }
      }
    }

    // the things
    for (var ty = 0; ty < size; ty++) {
      for (var tx = 0; tx < size; tx++) {
        var thing = this.mapPlane1[ty * size + tx];
        if (thing) game.spawnThing(thing, tx, ty);
      }
    }

    this.clearAmbushMarkers();
  } // setupLevel

  /**
   * The ambush markers are not floor: a guard standing on one waits until
   * he sees the player. Once they have done their work at spawn time the
   * game rubs them out and gives the tile the floor code of a neighbour, so
   * that the tile belongs to an area like any other.
   */
  clearAmbushMarkers() {
    var size = WolfWorld.MAPSIZE;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var plane = y * size + x;
        if (this.mapPlane0[plane] !== WolfWorld.AMBUSHTILE) continue;
        var spot = this.at(x, y);
        this.tilemap[spot] = 0;
        if (this.actorat[spot] === WolfWorld.AMBUSHTILE) this.actorat[spot] = null;
        var tile = WolfWorld.AMBUSHTILE;
        // the original looks at the tile after it, the two above it and the
        // one before it, in that order, and keeps the last floor it finds
        var neighbours = [plane + 1, plane - size, plane + size, plane - 1];
        for (var i = 0; i < neighbours.length; i++) {
          var near = neighbours[i];
          if (near >= 0 && near < this.mapPlane0.length && this.mapPlane0[near] >= WolfWorld.AREATILE) {
            tile = this.mapPlane0[near];
          }
        }
        this.mapPlane0[plane] = tile;
      }
    }
  } // clearAmbushMarkers

  /** A plane out of the JSON: 64 x 64 little endian words. */
  static readPlane(encoded) {
    var size = WolfWorld.MAPSIZE * WolfWorld.MAPSIZE;
    var plane = new Uint16Array(size);
    if (!encoded) return plane;
    var bytes = WolfWorld.decodeBase64(encoded);
    for (var i = 0; i < size; i++) plane[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    return plane;
  } // readPlane

  /** Base64 in the worker, in the browser and under Node alike. */
  static decodeBase64(text) {
    if (typeof atob === 'function') {
      var binary = atob(text);
      var out = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(text, 'base64'));
  } // decodeBase64

  // ------------------------------------------------------------- the doors

  /**
   * `SpawnDoor`: the door tile becomes a special tile, the two tiles beside
   * it are marked as jambs, and the door itself takes the area number of
   * what is behind it so that the two rooms can be told apart.
   * @param {number} x
   * @param {number} y
   * @param {boolean} vertical - A door in a wall running north to south.
   * @param {number} lock - 0 plain, 1..4 a key, 5 the lift.
   */
  spawnDoor(x, y, vertical, lock) {
    if (this.doors.length === WolfWorld.MAXDOORS) throw new Error('64+ doors on level');
    var number = this.doors.length;
    var spot = this.at(x, y);
    this.doorposition[number] = 0;
    this.doors.push({ number: number, tilex: x, tiley: y, vertical: vertical, lock: lock,
      action: WolfWorld.DOOR.CLOSED, ticcount: 0 });
    this.actorat[spot] = number | 0x80;
    this.tilemap[spot] = number | 0x80;

    var size = WolfWorld.MAPSIZE;
    var plane = y * size + x;
    if (vertical) {
      this.mapPlane0[plane] = this.mapPlane0[plane - 1];
      this.tilemap[this.at(x, y - 1)] |= 0x40;
      this.tilemap[this.at(x, y + 1)] |= 0x40;
    } else {
      this.mapPlane0[plane] = this.mapPlane0[plane - size];
      this.tilemap[this.at(x - 1, y)] |= 0x40;
      this.tilemap[this.at(x + 1, y)] |= 0x40;
    }
  } // spawnDoor

  /** `OpenDoor`: start it opening, or hold an open one open. */
  openDoor(number) {
    var door = this.doors[number];
    if (door.action === WolfWorld.DOOR.OPEN) door.ticcount = 0;
    else door.action = WolfWorld.DOOR.OPENING;
  } // openDoor

  /**
   * `CloseDoor`: a door will not shut on anything - not on an actor in the
   * doorway, not on the player standing in it, and not on anyone close
   * enough beside it that the door would cut into him.
   */
  closeDoor(number) {
    var door = this.doors[number];
    var x = door.tilex;
    var y = door.tiley;
    var player = this.game.player;
    if (this.occupied(x, y)) return;
    if (player.tilex === x && player.tiley === y) return;

    var mindist = WolfFixed.MINDIST;
    if (door.vertical) {
      if (player.tiley === y) {
        if (((player.x + mindist) >> 16) === x) return;
        if (((player.x - mindist) >> 16) === x) return;
      }
      var west = this.actorAt(x - 1, y);
      if (west && ((west.x + mindist) >> 16) === x) return;
      var east = this.actorAt(x + 1, y);
      if (east && ((east.x - mindist) >> 16) === x) return;
    } else {
      if (player.tilex === x) {
        if (((player.y + mindist) >> 16) === y) return;
        if (((player.y - mindist) >> 16) === y) return;
      }
      var north = this.actorAt(x, y - 1);
      if (north && ((north.y + mindist) >> 16) === y) return;
      var south = this.actorAt(x, y + 1);
      if (south && ((south.y - mindist) >> 16) === y) return;
    }

    if (this.areabyplayer[this.areaOf(x, y)]) {
      this.game.playSoundLocTile(SOUND.CLOSEDOOR, x, y);
    }
    door.action = WolfWorld.DOOR.CLOSING;
    this.actorat[this.at(x, y)] = number | 0x80;
  } // closeDoor

  /**
   * `OperateDoor`: the player pressed space at a door. A locked one only
   * says no unless he has the key.
   */
  operateDoor(number) {
    var door = this.doors[number];
    var lock = WolfWorld.LOCK;
    if (door.lock >= lock.LOCK1 && door.lock <= lock.LOCK4) {
      if (!(this.game.gamestate.keys & (1 << (door.lock - lock.LOCK1)))) {
        this.game.playSound(SOUND.NOWAY);
        return;
      }
    }
    switch (door.action) {
      case WolfWorld.DOOR.CLOSED:
      case WolfWorld.DOOR.CLOSING:
        this.openDoor(number);
        break;
      case WolfWorld.DOOR.OPEN:
      case WolfWorld.DOOR.OPENING:
        this.closeDoor(number);
        break;
    }
  } // operateDoor

  /** `MoveDoors`: every door gets its share of the tics of this frame. */
  moveDoors(tics) {
    if (this.game.gamestate.victoryflag) return;
    for (var i = 0; i < this.doors.length; i++) {
      switch (this.doors[i].action) {
        case WolfWorld.DOOR.OPEN: this.doorOpen(i, tics); break;
        case WolfWorld.DOOR.OPENING: this.doorOpening(i, tics); break;
        case WolfWorld.DOOR.CLOSING: this.doorClosing(i, tics); break;
      }
    }
  } // moveDoors

  /** An open door shuts itself after three seconds. */
  doorOpen(number, tics) {
    var door = this.doors[number];
    door.ticcount += tics;
    if (door.ticcount >= WolfWorld.OPENTICS) this.closeDoor(number);
  } // doorOpen

  doorOpening(number, tics) {
    var door = this.doors[number];
    var position = this.doorposition[number];
    if (!position) {
      // the moment it starts to move the two rooms can hear each other
      this.connectDoorAreas(door, 1);
      var area1 = this.doorAreas(door)[0];
      if (this.areabyplayer[area1]) {
        this.game.playSoundLocTile(SOUND.OPENDOOR, door.tilex, door.tiley);
      }
    }
    position += tics << 10;
    if (position >= 0xffff) {
      position = 0xffff;
      door.ticcount = 0;
      door.action = WolfWorld.DOOR.OPEN;
      this.actorat[this.at(door.tilex, door.tiley)] = null;
    }
    this.doorposition[number] = position;
  } // doorOpening

  doorClosing(number, tics) {
    var door = this.doors[number];
    var x = door.tilex;
    var y = door.tiley;
    var spot = this.at(x, y);
    var player = this.game.player;
    if (this.actorat[spot] !== (number | 0x80) || (player.tilex === x && player.tiley === y)) {
      // something walked into the doorway
      this.openDoor(number);
      return;
    }
    var position = this.doorposition[number] - (tics << 10);
    if (position <= 0) {
      position = 0;
      door.action = WolfWorld.DOOR.CLOSED;
      this.connectDoorAreas(door, -1);
    }
    this.doorposition[number] = position;
  } // doorClosing

  /** The two areas a door joins, in the order the original reads them. */
  doorAreas(door) {
    var size = WolfWorld.MAPSIZE;
    var plane = door.tiley * size + door.tilex;
    var one = door.vertical ? this.mapPlane0[plane + 1] : this.mapPlane0[plane - size];
    var two = door.vertical ? this.mapPlane0[plane - 1] : this.mapPlane0[plane + size];
    return [one - WolfWorld.AREATILE, two - WolfWorld.AREATILE];
  } // doorAreas

  /** Counts a door as joining or no longer joining its two areas. */
  connectDoorAreas(door, delta) {
    var areas = this.doorAreas(door);
    var one = areas[0];
    var two = areas[1];
    var count = WolfWorld.NUMAREAS;
    if (one < 0 || two < 0 || one >= count || two >= count) return;
    this.areaconnect[one * count + two] += delta;
    this.areaconnect[two * count + one] += delta;
    this.connectAreas();
  } // connectDoorAreas

  /**
   * `ConnectAreas`: which areas the player can be heard in - his own, and
   * everything reachable from it through open doors.
   */
  connectAreas() {
    var count = WolfWorld.NUMAREAS;
    this.areabyplayer.fill(0);
    var start = this.game.player.areanumber;
    if (start < 0 || start >= count) return;
    this.areabyplayer[start] = 1;
    var queue = [start];
    while (queue.length) {
      var area = queue.shift();
      for (var i = 0; i < count; i++) {
        if (this.areaconnect[area * count + i] && !this.areabyplayer[i]) {
          this.areabyplayer[i] = 1;
          queue.push(i);
        }
      }
    }
  } // connectAreas

  // ------------------------------------------------------ the secret walls

  /**
   * `PushWall`: the player pushed a wall that gives. It starts moving into
   * the tile beyond, which has to be free, and keeps going for two tiles.
   * @param {number} x - The wall.
   * @param {number} y
   * @param {number} dir - One of {@link WolfWorld.PUSHDIR}.
   * @returns {boolean} Whether it moved.
   */
  pushWall(x, y, dir) {
    if (this.pwallstate) return false;
    var spot = this.at(x, y);
    var oldtile = this.tilemap[spot];
    if (!oldtile) return false;

    var step = WolfWorld.stepOf(dir);
    var aheadX = x + step.x;
    var aheadY = y + step.y;
    if (this.occupied(aheadX, aheadY)) {
      this.game.playSound(SOUND.NOWAY);
      return false;
    }
    var ahead = this.at(aheadX, aheadY);
    this.actorat[ahead] = oldtile;
    this.tilemap[ahead] = oldtile;

    this.game.gamestate.secretcount++;
    this.pwallx = x;
    this.pwally = y;
    this.pwalldir = dir;
    this.pwallstate = 1;
    this.pwallpos = 0;
    this.pwalltile = oldtile;
    this.tilemap[spot] = oldtile | 0xc0;
    this.mapPlane1[y * WolfWorld.MAPSIZE + x] = 0;
    this.game.playSound(SOUND.PUSHWALL);
    return true;
  } // pushWall

  /**
   * `MovePWalls`: a secret wall moves a tile every 128 tics and stops after
   * two of them. `pwallpos` is how far into the tile it is, in
   * sixty-fourths, which is what the ray caster draws it by.
   */
  movePWalls(tics) {
    if (!this.pwallstate) return;
    var oldblock = Math.floor(this.pwallstate / 128);
    this.pwallstate += tics;
    if (Math.floor(this.pwallstate / 128) !== oldblock) {
      var spot = this.at(this.pwallx, this.pwally);
      var oldtile = this.tilemap[spot] & 63;
      // the tile it has left can be walked into now
      this.tilemap[spot] = 0;
      this.actorat[spot] = null;
      this.mapPlane0[this.pwally * WolfWorld.MAPSIZE + this.pwallx] =
        this.game.player.areanumber + WolfWorld.AREATILE;

      if (this.pwallstate > 256) {
        this.pwallstate = 0;
        return;
      }
      var step = WolfWorld.stepOf(this.pwalldir);
      this.pwallx += step.x;
      this.pwally += step.y;
      var aheadX = this.pwallx + step.x;
      var aheadY = this.pwally + step.y;
      if (this.occupied(aheadX, aheadY)) {
        this.pwallstate = 0;
        return;
      }
      var ahead = this.at(aheadX, aheadY);
      this.actorat[ahead] = oldtile;
      this.tilemap[ahead] = oldtile;
      this.tilemap[this.at(this.pwallx, this.pwally)] = oldtile | 0xc0;
      this.pwalltile = oldtile;
    }
    this.pwallpos = Math.floor(this.pwallstate / 2) & 63;
  } // movePWalls

  /** Which way a secret wall goes on the grid ({@link WolfWorld.PUSHDIR}). */
  static stepOf(dir) {
    switch (dir) {
      case WolfWorld.PUSHDIR.NORTH: return { x: 0, y: -1 };
      case WolfWorld.PUSHDIR.EAST: return { x: 1, y: 0 };
      case WolfWorld.PUSHDIR.SOUTH: return { x: 0, y: 1 };
      case WolfWorld.PUSHDIR.WEST: return { x: -1, y: 0 };
    }
    return { x: 0, y: 0 };
  } // stepOf

  // ---------------------------------------------------------- the scenery

  /**
   * `SpawnStatic`: a lamp, a table, a pool of blood or a treasure. A
   * blocking one makes its tile solid; a bonus gets a flag and its own
   * number, which is what the pickup code reads.
   * @param {number} x
   * @param {number} y
   * @param {number} type - 0..48, the index of plane 1 minus 23.
   */
  spawnStatic(x, y, type) {
    var info = WolfWorld.STATINFO[type];
    if (!info) return null;
    var stat = WolfWorld.STAT;
    var object = { tilex: x, tiley: y, shapenum: info.picnum, flags: 0, itemnumber: 0 };
    if (info.type === stat.block) {
      this.actorat[this.at(x, y)] = 1;          // solid, but not a wall
    } else if (info.type !== stat.dressing) {
      if (WolfWorld.TREASURE.indexOf(info.type) >= 0) this.game.gamestate.treasuretotal++;
      object.flags = 2;                          // FL_BONUS
      object.itemnumber = info.type;
    }
    this.statics.push(object);
    if (this.statics.length > WolfWorld.MAXSTATS) throw new Error('too many static objects');
    return object;
  } // spawnStatic

  /**
   * `PlaceItemType`: what a guard drops when he dies. It takes the place of
   * a static that has been picked up if there is one, so that a level can
   * never run out of room for them.
   * @param {number} itemtype - A `bo_` number.
   * @param {number} x
   * @param {number} y
   */
  placeItemType(itemtype, x, y) {
    var info = WolfWorld.STATINFO;
    var type = -1;
    for (var i = 0; i < info.length; i++) if (info[i].type === itemtype) { type = i; break; }
    if (type < 0) throw new Error('PlaceItemType: no static of type ' + itemtype);

    var spot = null;
    for (var s = 0; s < this.statics.length; s++) {
      if (this.statics[s].shapenum === -1) { spot = this.statics[s]; break; }
    }
    if (!spot) {
      if (this.statics.length >= WolfWorld.MAXSTATS) return null;
      spot = { tilex: 0, tiley: 0, shapenum: -1, flags: 0, itemnumber: 0 };
      this.statics.push(spot);
    }
    spot.shapenum = info[type].picnum;
    spot.tilex = x;
    spot.tiley = y;
    spot.flags = 2;
    spot.itemnumber = info[type].type;
    return spot;
  } // placeItemType

} // WolfWorld
