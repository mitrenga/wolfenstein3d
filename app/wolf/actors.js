const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
const { WolfWorld } = await import('./world.js?ver='+window.srcVersion);
const { WolfPlayer } = await import('./player.js?ver='+window.srcVersion);
const { STATES } = await import('./stateTable.js?ver='+window.srcVersion);
const { SOUND } = await import('./soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * The guards, the dogs and Hans: what they are, how they notice the player,
 * and how they walk.
 *
 * An actor is not a program but a walk through {@link STATES} - a state
 * says which sprite, for how long, what to think while it lasts and what to
 * do when it ends. This class holds what those names mean.
 *
 * The three things to know about the way they move:
 *
 * - **they move a tile at a time.** An actor picks a direction, `TryWalk`
 *   says whether that tile is free, and then it slides across the tile over
 *   as many frames as its speed takes. `distance` is how much of the tile
 *   is left, and a negative `distance` means it is waiting for a door.
 * - **noticing the player costs a reaction time**, drawn from `rndtable`,
 *   and a guard on an ambush tile only notices by sight, never by sound.
 * - **the whole fight is the table.** Whether a shot hits, how much it
 *   hurts, which way a cornered guard dodges - every one of those is the
 *   next byte of `rndtable`. That is why the order the actors are thought
 *   about in matters, and why a demo replays a fight exactly.
 */
export class WolfActors {

  /** how fast a guard walks his round, and how fast a dog runs */
  static get SPDPATROL() { return 512; }
  static get SPDDOG() { return 1500; }
  /** BJ's run at the end of an episode */
  static get BJRUNSPEED() { return 2048; }
  static get BJJUMPSPEED() { return 680; }
  /** how close the player has to be to be seen without looking */
  static get MINSIGHT() { return 0x18000; }
  /** the first of the eight arrows plane 1 turns a patrol with */
  static get ICONARROWS() { return 90; }

  /** the kinds of actor, as the original numbers them (`classtype`) */
  static get CLASS() {
    return { nothing: 0, player: 1, inert: 2, guard: 3, officer: 4, ss: 5, dog: 6,
             boss: 7, schabb: 8, fake: 9, mechahitler: 10, mutant: 11, needle: 12,
             fire: 13, bj: 14, ghost: 15, realhitler: 16, gretel: 17, gift: 18,
             fat: 19, rocket: 20 };
  } // CLASS

  /** the kinds plane 1 can place, as `enemy_t` numbers them */
  static get ENEMY() { return { guard: 0, officer: 1, ss: 2, dog: 3, boss: 4, mutant: 8 }; }

  /**
   * `starthitpoints`: how much of a beating each kind takes, on each of the
   * four settings. Only the ones episode one has are listed; the rest of
   * the table belongs to the registered game.
   */
  static get HITPOINTS() {
    return {
      0: [25, 50, 100, 1, 850, 0, 0, 0, 45],
      1: [25, 50, 100, 1, 950, 0, 0, 0, 55],
      2: [25, 50, 100, 1, 1050, 0, 0, 0, 55],
      3: [25, 50, 100, 1, 1200, 0, 0, 0, 65]
    };
  } // HITPOINTS

  /** `opposite`: the direction that undoes each of the eight. */
  static get OPPOSITE() { return [4, 5, 6, 7, 0, 1, 2, 3, 8]; }

  /**
   * `diagonal`: the diagonal between two cardinal directions, or `nodir`
   * when there is not one.
   */
  static get DIAGONAL() {
    var dir = WolfWorld.DIR;
    var table = [];
    for (var i = 0; i < 9; i++) table.push(new Array(9).fill(dir.NODIR));
    table[dir.EAST][dir.NORTH] = dir.NORTHEAST;
    table[dir.EAST][dir.SOUTH] = dir.SOUTHEAST;
    table[dir.NORTH][dir.EAST] = dir.NORTHEAST;
    table[dir.NORTH][dir.WEST] = dir.NORTHWEST;
    table[dir.WEST][dir.NORTH] = dir.NORTHWEST;
    table[dir.WEST][dir.SOUTH] = dir.SOUTHWEST;
    table[dir.SOUTH][dir.EAST] = dir.SOUTHEAST;
    table[dir.SOUTH][dir.WEST] = dir.SOUTHWEST;
    return table;
  } // DIAGONAL

  /** the eight death screams a guard can let out */
  static get GUARDSCREAMS() {
    return [SOUND.DEATHSCREAM1, SOUND.DEATHSCREAM2, SOUND.DEATHSCREAM3, SOUND.DEATHSCREAM4,
            SOUND.DEATHSCREAM5, SOUND.DEATHSCREAM7, SOUND.DEATHSCREAM8, SOUND.DEATHSCREAM9];
  } // GUARDSCREAMS

  constructor(game) {
    this.id = 'WolfActors';
    this.game = game;
    this.diagonal = WolfActors.DIAGONAL;
  } // constructor

  // ------------------------------------------------------------- the actors

  /** A fresh actor record, with everything the original's `objtype` has. */
  static newActor() {
    return {
      active: 0, ticcount: 0, obclass: 0, state: null, flags: 0, distance: 0,
      dir: WolfWorld.DIR.NODIR, x: 0, y: 0, tilex: 0, tiley: 0, areanumber: 0,
      viewx: 0, viewheight: 0, transx: 0, transy: 0, angle: 0, hitpoints: 0,
      speed: 0, temp1: 0, temp2: 0, temp3: 0
    };
  } // newActor

  /**
   * `SpawnNewObj`: an actor in the middle of a tile, in a state. Its first
   * tic count is a draw from the table, which is what keeps a row of guards
   * from breathing in step.
   */
  spawnNewObj(tilex, tiley, stateName) {
    var game = this.game;
    var state = STATES[stateName];
    var ob = WolfActors.newActor();
    ob.state = state;
    ob.ticcount = state.tictime ? game.random.next() % state.tictime : 0;
    ob.tilex = tilex;
    ob.tiley = tiley;
    ob.x = (tilex << 16) + WolfFixed.TILEGLOBAL / 2;
    ob.y = (tiley << 16) + WolfFixed.TILEGLOBAL / 2;
    ob.dir = WolfWorld.DIR.NODIR;
    game.actors.push(ob);
    game.world.actorat[game.world.at(tilex, tiley)] = ob;
    ob.areanumber = game.world.areaOf(tilex, tiley);
    return ob;
  } // spawnNewObj

  /** `NewState`: into a state, with the whole of its time in front of it. */
  newState(ob, stateName) {
    ob.state = STATES[stateName];
    ob.ticcount = ob.state.tictime;
  } // newState

  /**
   * `SpawnStand`: a guard standing where he was put, facing one way. If he
   * is standing on an ambush marker he takes the area of a neighbour and
   * will not hear a thing until he sees the player.
   * @param {number} which - One of {@link WolfActors.ENEMY}.
   */
  spawnStand(which, tilex, tiley, dir) {
    var game = this.game;
    var world = game.world;
    var names = { 0: 's_grdstand', 1: 's_ofcstand', 2: 's_ssstand', 8: 's_mutstand' };
    var ob = this.spawnNewObj(tilex, tiley, names[which]);
    ob.speed = WolfActors.SPDPATROL;
    game.gamestate.killtotal++;

    var size = WolfWorld.MAPSIZE;
    var plane = tiley * size + tilex;
    if (world.mapPlane0[plane] === WolfWorld.AMBUSHTILE) {
      world.tilemap[world.at(tilex, tiley)] = 0;
      var tile = WolfWorld.AMBUSHTILE;
      var neighbours = [plane + 1, plane - size, plane + size, plane - 1];
      for (var i = 0; i < neighbours.length; i++) {
        if (world.mapPlane0[neighbours[i]] >= WolfWorld.AREATILE) tile = world.mapPlane0[neighbours[i]];
      }
      world.mapPlane0[plane] = tile;
      ob.areanumber = tile - WolfWorld.AREATILE;
      ob.flags |= 64;                                 // FL_AMBUSH
    }

    ob.obclass = WolfActors.CLASS.guard + which;
    ob.hitpoints = WolfActors.HITPOINTS[game.gamestate.difficulty][which];
    ob.dir = dir * 2;
    ob.flags |= 1;                                    // FL_SHOOTABLE
    return ob;
  } // spawnStand

  /**
   * `SpawnPatrol`: a guard walking his round. He starts one tile along his
   * way, which is why his own tile is given up again.
   */
  spawnPatrol(which, tilex, tiley, dir) {
    var game = this.game;
    var world = game.world;
    var names = { 0: 's_grdpath1', 1: 's_ofcpath1', 2: 's_sspath1', 3: 's_dogpath1', 8: 's_mutpath1' };
    var ob = this.spawnNewObj(tilex, tiley, names[which]);
    ob.speed = which === WolfActors.ENEMY.dog ? WolfActors.SPDDOG : WolfActors.SPDPATROL;
    game.gamestate.killtotal++;

    ob.obclass = WolfActors.CLASS.guard + which;
    ob.dir = dir * 2;
    ob.hitpoints = WolfActors.HITPOINTS[game.gamestate.difficulty][which];
    ob.distance = WolfFixed.TILEGLOBAL;
    ob.flags |= 1;
    ob.active = 1;

    world.actorat[world.at(ob.tilex, ob.tiley)] = null;
    switch (dir) {
      case 0: ob.tilex++; break;
      case 1: ob.tiley--; break;
      case 2: ob.tilex--; break;
      case 3: ob.tiley++; break;
    }
    world.actorat[world.at(ob.tilex, ob.tiley)] = ob;
    return ob;
  } // spawnPatrol

  /** `SpawnDeadGuard`: one who was dead before the player arrived. */
  spawnDeadGuard(tilex, tiley) {
    var ob = this.spawnNewObj(tilex, tiley, 's_grddie4');
    ob.obclass = WolfActors.CLASS.inert;
    return ob;
  } // spawnDeadGuard

  /** `SpawnBoss`: Hans Grösse, who waits at the end of episode one. */
  spawnBoss(tilex, tiley) {
    var game = this.game;
    var ob = this.spawnNewObj(tilex, tiley, 's_bossstand');
    ob.speed = WolfActors.SPDPATROL;
    ob.obclass = WolfActors.CLASS.boss;
    ob.hitpoints = WolfActors.HITPOINTS[game.gamestate.difficulty][WolfActors.ENEMY.boss];
    ob.dir = WolfWorld.DIR.SOUTH;
    ob.flags |= 1 | 64;                               // shootable, and an ambusher
    game.gamestate.killtotal++;
    return ob;
  } // spawnBoss

  /** `SpawnBJVictory`: BJ runs out of the castle at the end of the episode. */
  spawnBJVictory() {
    var player = this.game.player;
    var ob = this.spawnNewObj(player.tilex, player.tiley + 1, 's_bjrun1');
    ob.x = player.x;
    ob.y = player.y;
    ob.obclass = WolfActors.CLASS.bj;
    ob.dir = WolfWorld.DIR.NORTH;
    ob.temp1 = 6;                                     // tiles to run forward
    return ob;
  } // spawnBJVictory

  // -------------------------------------------------------------- one tic

  /**
   * `DoActor`: one actor's share of a tic. An actor with time left on its
   * state counts it down and may run through several states in one frame;
   * one with no time thinks every frame.
   *
   * The actor is taken out of `actorat` at the start and put back at the
   * end, which is how two of them never end up in the same tile.
   */
  doActor(ob) {
    var game = this.game;
    var world = game.world;
    if (!ob.active && !world.areabyplayer[ob.areanumber]) return;
    if (!(ob.flags & (128 | 4))) world.actorat[world.at(ob.tilex, ob.tiley)] = null;

    if (!ob.ticcount) {
      if (!this.runThink(ob, ob.state.think)) return;
      this.mark(ob);
      return;
    }

    ob.ticcount -= game.tics;
    while (ob.ticcount <= 0) {
      if (!this.runThink(ob, ob.state.action)) return;
      ob.state = ob.state.next ? STATES[ob.state.next] : null;
      if (!ob.state) {
        this.removeObj(ob);
        return;
      }
      if (!ob.state.tictime) {
        ob.ticcount = 0;
        break;
      }
      ob.ticcount += ob.state.tictime;
    }
    if (!this.runThink(ob, ob.state.think)) return;
    this.mark(ob);
  } // doActor

  /**
   * Runs one of the named think or action functions.
   * @returns {boolean} False when the actor removed itself and there is
   *          nothing more to do with it.
   */
  runThink(ob, name) {
    if (name) {
      var handler = this[name];
      if (!handler) throw new Error('no such actor function: ' + name);
      handler.call(this, ob);
      if (!ob.state) {
        this.removeObj(ob);
        return false;
      }
    }
    return true;
  } // runThink

  /** Puts an actor back into the tile it stands in. */
  mark(ob) {
    var world = this.game.world;
    if (ob.flags & 4) return;                         // FL_NEVERMARK
    var spot = world.at(ob.tilex, ob.tiley);
    if ((ob.flags & 128) && world.actorat[spot]) return;   // FL_NONMARK
    world.actorat[spot] = ob;
  } // mark

  /** `RemoveObj`: out of the list; the order of the rest does not change. */
  removeObj(ob) {
    var actors = this.game.actors;
    var at = actors.indexOf(ob);
    if (at > 0) actors.splice(at, 1);
  } // removeObj

  // ------------------------------------------------------------- the moves

  /**
   * `TryWalk`: whether the actor can step into the tile its direction
   * points at. A door counts as passable - the actor starts it opening and
   * waits with a negative `distance` until it is open.
   *
   * A dog walks diagonally past a door frame where a man does not, which is
   * the only difference between the two checks.
   */
  tryWalk(ob) {
    var world = this.game.world;
    var dir = WolfWorld.DIR;
    var doornum = -1;
    var self = this;
    var blockedDiag = function (x, y) {
      var thing = world.actorat[world.at(x, y)];
      if (thing === null) return false;
      if (typeof thing === 'number') return true;
      return !!(thing.flags & 1);
    };
    var blockedSide = function (x, y) {
      var thing = world.actorat[world.at(x, y)];
      if (thing === null) return false;
      if (typeof thing === 'number') {
        if (thing < 128) return true;
        doornum = thing & 63;
        return false;
      }
      return !!(thing.flags & 1);
    };
    var sideways = (ob.obclass === WolfActors.CLASS.dog || ob.obclass === WolfActors.CLASS.fake)
      ? blockedDiag : blockedSide;

    if (ob.obclass === WolfActors.CLASS.inert) {
      // the dead do not check anything; only the BJ of the ending walks
      var step = WolfActors.stepOf(ob.dir);
      ob.tilex += step.x;
      ob.tiley += step.y;
    } else {
      switch (ob.dir) {
        case dir.NORTH:
          if (sideways(ob.tilex, ob.tiley - 1)) return false;
          ob.tiley--;
          break;
        case dir.NORTHEAST:
          if (blockedDiag(ob.tilex + 1, ob.tiley - 1)) return false;
          if (blockedDiag(ob.tilex + 1, ob.tiley)) return false;
          if (blockedDiag(ob.tilex, ob.tiley - 1)) return false;
          ob.tilex++;
          ob.tiley--;
          break;
        case dir.EAST:
          if (sideways(ob.tilex + 1, ob.tiley)) return false;
          ob.tilex++;
          break;
        case dir.SOUTHEAST:
          if (blockedDiag(ob.tilex + 1, ob.tiley + 1)) return false;
          if (blockedDiag(ob.tilex + 1, ob.tiley)) return false;
          if (blockedDiag(ob.tilex, ob.tiley + 1)) return false;
          ob.tilex++;
          ob.tiley++;
          break;
        case dir.SOUTH:
          if (sideways(ob.tilex, ob.tiley + 1)) return false;
          ob.tiley++;
          break;
        case dir.SOUTHWEST:
          if (blockedDiag(ob.tilex - 1, ob.tiley + 1)) return false;
          if (blockedDiag(ob.tilex - 1, ob.tiley)) return false;
          if (blockedDiag(ob.tilex, ob.tiley + 1)) return false;
          ob.tilex--;
          ob.tiley++;
          break;
        case dir.WEST:
          if (sideways(ob.tilex - 1, ob.tiley)) return false;
          ob.tilex--;
          break;
        case dir.NORTHWEST:
          if (blockedDiag(ob.tilex - 1, ob.tiley - 1)) return false;
          if (blockedDiag(ob.tilex - 1, ob.tiley)) return false;
          if (blockedDiag(ob.tilex, ob.tiley - 1)) return false;
          ob.tilex--;
          ob.tiley--;
          break;
        case dir.NODIR:
          return false;
      }
    }

    if (doornum !== -1) {
      world.openDoor(doornum);
      ob.distance = -doornum - 1;
      return true;
    }
    ob.areanumber = world.areaOf(ob.tilex, ob.tiley);
    ob.distance = WolfFixed.TILEGLOBAL;
    return true;
  } // tryWalk

  /** Which way each of the eight directions goes on the grid. */
  static stepOf(dir) {
    var d = WolfWorld.DIR;
    switch (dir) {
      case d.NORTH: return { x: 0, y: -1 };
      case d.NORTHEAST: return { x: 1, y: -1 };
      case d.EAST: return { x: 1, y: 0 };
      case d.SOUTHEAST: return { x: 1, y: 1 };
      case d.SOUTH: return { x: 0, y: 1 };
      case d.SOUTHWEST: return { x: -1, y: 1 };
      case d.WEST: return { x: -1, y: 0 };
      case d.NORTHWEST: return { x: -1, y: -1 };
    }
    return { x: 0, y: 0 };
  } // stepOf

  /**
   * `SelectDodgeDir`: towards the player, but not straight at him - the
   * four cardinal directions are put in order of how much they help, the
   * order is shaken by a draw from the table, and the diagonal between the
   * first two is tried before any of them.
   */
  selectDodgeDir(ob) {
    var game = this.game;
    var dir = WolfWorld.DIR;
    var turnaround;
    if (ob.flags & 32) {                              // FL_FIRSTATTACK
      turnaround = dir.NODIR;                         // turning round is allowed once
      ob.flags &= ~32;
    } else {
      turnaround = WolfActors.OPPOSITE[ob.dir];
    }

    var deltax = game.player.tilex - ob.tilex;
    var deltay = game.player.tiley - ob.tiley;
    var dirtry = new Array(5);
    dirtry[1] = deltax > 0 ? dir.EAST : dir.WEST;
    dirtry[3] = deltax > 0 ? dir.WEST : dir.EAST;
    dirtry[2] = deltay > 0 ? dir.SOUTH : dir.NORTH;
    dirtry[4] = deltay > 0 ? dir.NORTH : dir.SOUTH;

    var swap = function () {
      var tdir = dirtry[1]; dirtry[1] = dirtry[2]; dirtry[2] = tdir;
      tdir = dirtry[3]; dirtry[3] = dirtry[4]; dirtry[4] = tdir;
    };
    if (Math.abs(deltax) > Math.abs(deltay)) swap();
    if (game.random.next() < 128) swap();
    dirtry[0] = this.diagonal[dirtry[1]][dirtry[2]];

    for (var i = 0; i < 5; i++) {
      if (dirtry[i] === dir.NODIR || dirtry[i] === turnaround) continue;
      ob.dir = dirtry[i];
      if (this.tryWalk(ob)) return;
    }
    if (turnaround !== dir.NODIR) {
      ob.dir = turnaround;
      if (this.tryWalk(ob)) return;
    }
    ob.dir = dir.NODIR;
  } // selectDodgeDir

  /** `SelectChaseDir`: straight at the player, and round the houses if not. */
  selectChaseDir(ob) {
    var game = this.game;
    var dir = WolfWorld.DIR;
    var olddir = ob.dir;
    var turnaround = WolfActors.OPPOSITE[olddir];
    var deltax = game.player.tilex - ob.tilex;
    var deltay = game.player.tiley - ob.tiley;
    var d = [null, dir.NODIR, dir.NODIR];

    if (deltax > 0) d[1] = dir.EAST;
    else if (deltax < 0) d[1] = dir.WEST;
    if (deltay > 0) d[2] = dir.SOUTH;
    else if (deltay < 0) d[2] = dir.NORTH;

    if (Math.abs(deltay) > Math.abs(deltax)) {
      var tdir = d[1]; d[1] = d[2]; d[2] = tdir;
    }
    if (d[1] === turnaround) d[1] = dir.NODIR;
    if (d[2] === turnaround) d[2] = dir.NODIR;

    if (d[1] !== dir.NODIR) {
      ob.dir = d[1];
      if (this.tryWalk(ob)) return;
    }
    if (d[2] !== dir.NODIR) {
      ob.dir = d[2];
      if (this.tryWalk(ob)) return;
    }
    if (olddir !== dir.NODIR) {
      ob.dir = olddir;
      if (this.tryWalk(ob)) return;
    }

    // the four cardinal directions, searched one way or the other
    if (game.random.next() > 128) {
      for (var up = dir.NORTH; up <= dir.WEST; up++) {
        if (up === turnaround) continue;
        ob.dir = up;
        if (this.tryWalk(ob)) return;
      }
    } else {
      for (var down = dir.WEST; down >= dir.NORTH; down--) {
        if (down === turnaround) continue;
        ob.dir = down;
        if (this.tryWalk(ob)) return;
      }
    }
    if (turnaround !== dir.NODIR) {
      ob.dir = turnaround;
      if (this.tryWalk(ob)) return;
    }
    ob.dir = dir.NODIR;
  } // selectChaseDir

  /** `SelectPathDir`: the arrow on the floor, if this tile has one. */
  selectPathDir(ob) {
    var world = this.game.world;
    var spot = world.mapPlane1[ob.tiley * WolfWorld.MAPSIZE + ob.tilex] - WolfActors.ICONARROWS;
    if (spot >= 0 && spot < 8) ob.dir = spot;
    ob.distance = WolfFixed.TILEGLOBAL;
    if (!this.tryWalk(ob)) ob.dir = WolfWorld.DIR.NODIR;
  } // selectPathDir

  /**
   * `MoveObj`: slides an actor along its direction. It may not end up on
   * top of the player, so a move that would is taken back.
   */
  moveObj(ob, move) {
    var game = this.game;
    var step = WolfActors.stepOf(ob.dir);
    if (ob.dir === WolfWorld.DIR.NODIR) return;
    ob.x += step.x * move;
    ob.y += step.y * move;

    if (game.world.areabyplayer[ob.areanumber]) {
      var deltax = ob.x - game.player.x;
      var deltay = ob.y - game.player.y;
      if (deltax >= -WolfFixed.MINACTORDIST && deltax <= WolfFixed.MINACTORDIST &&
          deltay >= -WolfFixed.MINACTORDIST && deltay <= WolfFixed.MINACTORDIST) {
        ob.x -= step.x * move;
        ob.y -= step.y * move;
        return;
      }
    }
    ob.distance -= move;
  } // moveObj

  // ------------------------------------------------------------- the senses

  /**
   * `CheckLine`: whether a straight line from the actor to the player
   * passes anything solid. It walks the line a tile at a time in x and then
   * in y, at a precision of a 256th of a tile, and a door counts as solid
   * unless it is open far enough where the line crosses it.
   */
  checkLine(ob) {
    var game = this.game;
    var world = game.world;
    var tilemap = world.tilemap;
    var x1 = ob.x >> 8;                               // 1/256 of a tile
    var y1 = ob.y >> 8;
    var xt1 = x1 >> 8;
    var yt1 = y1 >> 8;
    var x2 = game.player.x >> 8;
    var y2 = game.player.y >> 8;
    var xt2 = game.player.tilex;
    var yt2 = game.player.tiley;

    var xdist = Math.abs(xt2 - xt1);
    var partial;
    var delta;
    var ltemp;
    if (xdist > 0) {
      var xstep = xt2 > xt1 ? 1 : -1;
      partial = xt2 > xt1 ? 256 - (x1 & 0xff) : (x1 & 0xff);
      var deltafrac = Math.abs(x2 - x1);
      delta = y2 - y1;
      ltemp = Math.trunc((delta * 256) / deltafrac);
      var ystep = ltemp > 0x7fff ? 0x7fff : (ltemp < -0x7fff ? -0x7fff : ltemp);
      var yfrac = y1 + ((ystep * partial) >> 8);
      var x = xt1 + xstep;
      var endx = xt2 + xstep;
      do {
        var y = yfrac >> 8;
        yfrac += ystep;
        var value = tilemap[(x << 6) + y];
        x += xstep;
        if (!value) continue;
        if (value < 128 || value > 256) return false;
        var door = value & ~0x80;
        // the C of the original divides by two, which truncates towards
        // zero; a shift would round the other way for a step going up
        var intercept = WolfFixed.word(yfrac - Math.trunc(ystep / 2));
        if (intercept > world.doorposition[door]) return false;
      } while (x !== endx);
    }

    var ydist = Math.abs(yt2 - yt1);
    if (ydist > 0) {
      var ystep2 = yt2 > yt1 ? 1 : -1;
      partial = yt2 > yt1 ? 256 - (y1 & 0xff) : (y1 & 0xff);
      var deltafrac2 = Math.abs(y2 - y1);
      delta = x2 - x1;
      ltemp = Math.trunc((delta * 256) / deltafrac2);
      var xstep2 = ltemp > 0x7fff ? 0x7fff : (ltemp < -0x7fff ? -0x7fff : ltemp);
      var xfrac = x1 + ((xstep2 * partial) >> 8);
      var y2t = yt1 + ystep2;
      var endy = yt2 + ystep2;
      do {
        var xx = xfrac >> 8;
        xfrac += xstep2;
        var value2 = tilemap[(xx << 6) + y2t];
        y2t += ystep2;
        if (!value2) continue;
        if (value2 < 128 || value2 > 256) return false;
        var door2 = value2 & ~0x80;
        var intercept2 = WolfFixed.word(xfrac - Math.trunc(xstep2 / 2));
        if (intercept2 > world.doorposition[door2]) return false;
      } while (y2t !== endy);
    }
    return true;
  } // checkLine

  /**
   * `CheckSight`: the player has to be in a room this actor can hear into,
   * either very close or in front of the actor, and with nothing in the
   * way.
   */
  checkSight(ob) {
    var game = this.game;
    if (!game.world.areabyplayer[ob.areanumber]) return false;

    var deltax = game.player.x - ob.x;
    var deltay = game.player.y - ob.y;
    var near = WolfActors.MINSIGHT;
    if (deltax > -near && deltax < near && deltay > -near && deltay < near) return true;

    var dir = WolfWorld.DIR;
    switch (ob.dir) {
      case dir.NORTH: if (deltay > 0) return false; break;
      case dir.EAST: if (deltax < 0) return false; break;
      case dir.SOUTH: if (deltay < 0) return false; break;
      case dir.WEST: if (deltax > 0) return false; break;
    }
    return this.checkLine(ob);
  } // checkSight

  /**
   * `FirstSighting`: the moment an actor notices the player. He shouts,
   * goes into his chase states and speeds up - a guard three times, an SS
   * four, an officer five.
   */
  firstSighting(ob) {
    var game = this.game;
    var cls = WolfActors.CLASS;
    switch (ob.obclass) {
      case cls.guard:
        game.playSoundLocActor(SOUND.HALT, ob);
        this.newState(ob, 's_grdchase1');
        ob.speed *= 3;
        break;
      case cls.officer:
        game.playSoundLocActor(SOUND.SPION, ob);
        this.newState(ob, 's_ofcchase1');
        ob.speed *= 5;
        break;
      case cls.mutant:
        this.newState(ob, 's_mutchase1');
        ob.speed *= 3;
        break;
      case cls.ss:
        game.playSoundLocActor(SOUND.SCHUTZAD, ob);
        this.newState(ob, 's_sschase1');
        ob.speed *= 4;
        break;
      case cls.dog:
        game.playSoundLocActor(SOUND.DOGBARK, ob);
        this.newState(ob, 's_dogchase1');
        ob.speed *= 2;
        break;
      case cls.boss:
        game.playSound(SOUND.GUTENTAG);
        this.newState(ob, 's_bosschase1');
        ob.speed = WolfActors.SPDPATROL * 3;
        break;
    }
    if (ob.distance < 0) ob.distance = 0;             // forget the door
    ob.flags |= 16 | 32;                              // attack mode, first attack
  } // firstSighting

  /**
   * `SightPlayer`: called by everyone who is not already chasing. Noticing
   * takes a moment - a reaction time drawn from the table, counted down in
   * tics - and an ambusher only reacts to what he sees.
   * @returns {boolean} Whether the actor went into attack mode this tic.
   */
  sightPlayer(ob) {
    var game = this.game;
    if (ob.temp2) {
      ob.temp2 -= game.tics;
      if (ob.temp2 > 0) return false;
      ob.temp2 = 0;
    } else {
      if (!game.world.areabyplayer[ob.areanumber]) return false;
      if (ob.flags & 64) {                            // FL_AMBUSH
        if (!this.checkSight(ob)) return false;
        ob.flags &= ~64;
      } else if (!game.madenoise && !this.checkSight(ob)) {
        return false;
      }
      var cls = WolfActors.CLASS;
      switch (ob.obclass) {
        case cls.guard: ob.temp2 = 1 + Math.trunc(game.random.next() / 4); break;
        case cls.officer: ob.temp2 = 2; break;
        case cls.mutant: ob.temp2 = 1 + Math.trunc(game.random.next() / 6); break;
        case cls.ss: ob.temp2 = 1 + Math.trunc(game.random.next() / 6); break;
        case cls.dog: ob.temp2 = 1 + Math.trunc(game.random.next() / 8); break;
        default: ob.temp2 = 1; break;
      }
      return false;
    }
    this.firstSighting(ob);
    return true;
  } // sightPlayer

  // ------------------------------------------------------------- the damage

  /**
   * `DamageActor`: a hit. One that lands on someone who has not noticed the
   * player yet does double - and wakes him.
   */
  damageActor(ob, damage) {
    var game = this.game;
    game.madenoise = true;
    if (!(ob.flags & 16)) damage <<= 1;               // not in attack mode yet
    ob.hitpoints -= damage;
    if (ob.hitpoints <= 0) {
      this.killActor(ob);
      return;
    }
    if (!(ob.flags & 16)) this.firstSighting(ob);
    var cls = WolfActors.CLASS;
    var odd = ob.hitpoints & 1;
    switch (ob.obclass) {
      case cls.guard: this.newState(ob, odd ? 's_grdpain' : 's_grdpain1'); break;
      case cls.officer: this.newState(ob, odd ? 's_ofcpain' : 's_ofcpain1'); break;
      case cls.mutant: this.newState(ob, odd ? 's_mutpain' : 's_mutpain1'); break;
      case cls.ss: this.newState(ob, odd ? 's_sspain' : 's_sspain1'); break;
    }
  } // damageActor

  /**
   * `KillActor`: the points, the death animation, and what he drops. A dead
   * actor stops being shootable and stops holding its tile.
   */
  killActor(ob) {
    var game = this.game;
    var world = game.world;
    var stat = WolfWorld.STAT;
    var cls = WolfActors.CLASS;
    var tilex = ob.tilex = ob.x >> 16;
    var tiley = ob.tiley = ob.y >> 16;

    switch (ob.obclass) {
      case cls.guard:
        game.agent.givePoints(100);
        this.newState(ob, 's_grddie1');
        world.placeItemType(stat.bo_clip2, tilex, tiley);
        break;
      case cls.officer:
        game.agent.givePoints(400);
        this.newState(ob, 's_ofcdie1');
        world.placeItemType(stat.bo_clip2, tilex, tiley);
        break;
      case cls.mutant:
        game.agent.givePoints(700);
        this.newState(ob, 's_mutdie1');
        world.placeItemType(stat.bo_clip2, tilex, tiley);
        break;
      case cls.ss:
        game.agent.givePoints(500);
        this.newState(ob, 's_ssdie1');
        world.placeItemType(
          game.gamestate.bestweapon < WolfPlayer.WEAPON.MACHINEGUN ? stat.bo_machinegun : stat.bo_clip2,
          tilex, tiley);
        break;
      case cls.dog:
        game.agent.givePoints(200);
        this.newState(ob, 's_dogdie1');
        break;
      case cls.boss:
        game.agent.givePoints(5000);
        this.newState(ob, 's_bossdie1');
        world.placeItemType(stat.bo_key1, tilex, tiley);
        break;
    }
    game.gamestate.killcount++;
    ob.flags &= ~1;                                   // no longer shootable
    world.actorat[world.at(ob.tilex, ob.tiley)] = null;
    ob.flags |= 128;                                  // FL_NONMARK
  } // killActor

  /**
   * `DropItem`: where a thing a dead actor leaves behind goes - its own
   * tile if it is free, otherwise one of the eight around it.
   */
  dropItem(itemtype, tilex, tiley) {
    var world = this.game.world;
    if (!world.occupied(tilex, tiley)) {
      world.placeItemType(itemtype, tilex, tiley);
      return;
    }
    for (var x = tilex - 1; x <= tilex + 1; x++) {
      for (var y = tiley - 1; y <= tiley + 1; y++) {
        if (!world.occupied(x, y)) {
          world.placeItemType(itemtype, x, y);
          return;
        }
      }
    }
  } // dropItem

  // -------------------------------------------------- what the states call

  /** `T_Stand`: he stands and watches. */
  T_Stand(ob) {
    this.sightPlayer(ob);
  } // T_Stand

  /**
   * `T_Path`: he walks his round, following the arrows on the floor, and
   * waits at a door until it is open.
   */
  T_Path(ob) {
    var game = this.game;
    if (this.sightPlayer(ob)) return;
    if (ob.dir === WolfWorld.DIR.NODIR) {
      this.selectPathDir(ob);
      if (ob.dir === WolfWorld.DIR.NODIR) return;
    }
    var move = ob.speed * game.tics;
    while (move) {
      if (ob.distance < 0) {
        var door = -ob.distance - 1;
        game.world.openDoor(door);
        if (game.world.doors[door].action !== WolfWorld.DOOR.OPEN) return;
        ob.distance = WolfFixed.TILEGLOBAL;
      }
      if (move < ob.distance) {
        this.moveObj(ob, move);
        break;
      }
      ob.x = (ob.tilex << 16) + WolfFixed.TILEGLOBAL / 2;
      ob.y = (ob.tiley << 16) + WolfFixed.TILEGLOBAL / 2;
      move -= ob.distance;
      this.selectPathDir(ob);
      if (ob.dir === WolfWorld.DIR.NODIR) return;
    }
  } // T_Path

  /**
   * `T_Chase`: after the player. If he has a shot he takes it - the chance
   * of that being worth it falls off with distance, and standing next to
   * the player is a certainty - otherwise he keeps coming, dodging if he
   * has been shot at.
   */
  T_Chase(ob) {
    var game = this.game;
    if (game.gamestate.victoryflag) return;
    var dodge = false;
    if (this.checkLine(ob)) {
      var dx = Math.abs(ob.tilex - game.player.tilex);
      var dy = Math.abs(ob.tiley - game.player.tiley);
      var dist = dx > dy ? dx : dy;
      var chance;
      if (!dist || (dist === 1 && ob.distance < 0x4000)) chance = 300;
      else chance = Math.trunc((game.tics << 4) / dist);

      if (game.random.next() < chance) {
        var cls = WolfActors.CLASS;
        switch (ob.obclass) {
          case cls.guard: this.newState(ob, 's_grdshoot1'); break;
          case cls.officer: this.newState(ob, 's_ofcshoot1'); break;
          case cls.mutant: this.newState(ob, 's_mutshoot1'); break;
          case cls.ss: this.newState(ob, 's_ssshoot1'); break;
          case cls.boss: this.newState(ob, 's_bossshoot1'); break;
        }
        return;
      }
      dodge = true;
    }

    if (ob.dir === WolfWorld.DIR.NODIR) {
      if (dodge) this.selectDodgeDir(ob);
      else this.selectChaseDir(ob);
      if (ob.dir === WolfWorld.DIR.NODIR) return;
    }

    var move = ob.speed * game.tics;
    while (move) {
      if (ob.distance < 0) {
        var door = -ob.distance - 1;
        game.world.openDoor(door);
        if (game.world.doors[door].action !== WolfWorld.DOOR.OPEN) return;
        ob.distance = WolfFixed.TILEGLOBAL;
      }
      if (move < ob.distance) {
        this.moveObj(ob, move);
        break;
      }
      ob.x = (ob.tilex << 16) + WolfFixed.TILEGLOBAL / 2;
      ob.y = (ob.tiley << 16) + WolfFixed.TILEGLOBAL / 2;
      move -= ob.distance;
      if (dodge) this.selectDodgeDir(ob);
      else this.selectChaseDir(ob);
      if (ob.dir === WolfWorld.DIR.NODIR) return;
    }
  } // T_Chase

  /** `T_DogChase`: a dog runs at the player and jumps when it is close. */
  T_DogChase(ob) {
    var game = this.game;
    if (ob.dir === WolfWorld.DIR.NODIR) {
      this.selectDodgeDir(ob);
      if (ob.dir === WolfWorld.DIR.NODIR) return;
    }
    var move = ob.speed * game.tics;
    while (move) {
      var dx = Math.abs(game.player.x - ob.x) - move;
      if (dx <= WolfFixed.MINACTORDIST) {
        var dy = Math.abs(game.player.y - ob.y) - move;
        if (dy <= WolfFixed.MINACTORDIST) {
          this.newState(ob, 's_dogjump1');
          return;
        }
      }
      if (move < ob.distance) {
        this.moveObj(ob, move);
        break;
      }
      ob.x = (ob.tilex << 16) + WolfFixed.TILEGLOBAL / 2;
      ob.y = (ob.tiley << 16) + WolfFixed.TILEGLOBAL / 2;
      move -= ob.distance;
      this.selectDodgeDir(ob);
      if (ob.dir === WolfWorld.DIR.NODIR) return;
    }
  } // T_DogChase

  /** `T_Bite`: the dog is on him. */
  T_Bite(ob) {
    var game = this.game;
    game.playSoundLocActor(SOUND.DOGATTACK, ob);
    var dx = Math.abs(game.player.x - ob.x) - WolfFixed.TILEGLOBAL;
    if (dx <= WolfFixed.MINACTORDIST) {
      var dy = Math.abs(game.player.y - ob.y) - WolfFixed.TILEGLOBAL;
      if (dy <= WolfFixed.MINACTORDIST) {
        if (game.random.next() < 180) {
          game.agent.takeDamage(game.random.next() >> 4, ob);
          return;
        }
      }
    }
  } // T_Bite

  /**
   * `T_Shoot`: a shot at the player. Whether it hits depends on the
   * distance, on whether the player is running, and on whether the player
   * can see the shooter to dodge - an SS or Hans shoots two thirds as far
   * off as everyone else.
   */
  T_Shoot(ob) {
    var game = this.game;
    var cls = WolfActors.CLASS;
    if (!game.world.areabyplayer[ob.areanumber]) return;
    if (!this.checkLine(ob)) return;                  // a wall is in the way

    var dx = Math.abs(ob.tilex - game.player.tilex);
    var dy = Math.abs(ob.tiley - game.player.tiley);
    var dist = dx > dy ? dx : dy;
    if (ob.obclass === cls.ss || ob.obclass === cls.boss) dist = Math.trunc((dist * 2) / 3);

    var hitchance;
    var visible = (ob.flags & 8) !== 0;               // FL_VISABLE
    if (game.agent.thrustspeed >= WolfPlayer.RUNSPEED) {
      hitchance = visible ? 160 - dist * 16 : 160 - dist * 8;
    } else {
      hitchance = visible ? 256 - dist * 16 : 256 - dist * 8;
    }

    if (game.random.next() < hitchance) {
      var damage;
      if (dist < 2) damage = game.random.next() >> 2;
      else if (dist < 4) damage = game.random.next() >> 3;
      else damage = game.random.next() >> 4;
      game.agent.takeDamage(damage, ob);
    }

    switch (ob.obclass) {
      case cls.ss: game.playSoundLocActor(SOUND.SSFIRE, ob); break;
      case cls.boss: game.playSoundLocActor(SOUND.BOSSFIRE, ob); break;
      default: game.playSoundLocActor(SOUND.NAZIFIRE, ob); break;
    }
  } // T_Shoot

  /** `A_DeathScream`: what he says on the way down. */
  A_DeathScream(ob) {
    var game = this.game;
    var cls = WolfActors.CLASS;
    switch (ob.obclass) {
      case cls.mutant:
        game.playSoundLocActor(SOUND.AHHHG, ob);
        break;
      case cls.guard:
        game.playSoundLocActor(WolfActors.GUARDSCREAMS[game.random.next() % 8], ob);
        break;
      case cls.officer:
        game.playSoundLocActor(SOUND.NEINSOVAS, ob);
        break;
      case cls.ss:
        game.playSoundLocActor(SOUND.LEBEN, ob);
        break;
      case cls.dog:
        game.playSoundLocActor(SOUND.DOGDEATH, ob);
        break;
      case cls.boss:
        game.playSound(SOUND.MUTTI);
        break;
    }
  } // A_DeathScream

  /** `T_BJRun`: BJ runs out of the castle when the episode is won. */
  T_BJRun(ob) {
    var game = this.game;
    var move = WolfActors.BJRUNSPEED * game.tics;
    while (move) {
      if (move < ob.distance) {
        this.moveObj(ob, move);
        break;
      }
      ob.x = (ob.tilex << 16) + WolfFixed.TILEGLOBAL / 2;
      ob.y = (ob.tiley << 16) + WolfFixed.TILEGLOBAL / 2;
      move -= ob.distance;
      this.selectPathDir(ob);
      if (!(--ob.temp1)) {
        this.newState(ob, 's_bjjump1');
        return;
      }
    }
  } // T_BJRun

  /** `T_BJJump`: and then he jumps. */
  T_BJJump(ob) {
    this.moveObj(ob, WolfActors.BJJUMPSPEED * this.game.tics);
  } // T_BJJump

  /** `T_BJYell`: with a shout. */
  T_BJYell(ob) {
    this.game.playSoundLocActor(SOUND.YEAH, ob);
  } // T_BJYell

  /** `T_BJDone`: and the episode is over. */
  T_BJDone(ob) {
    this.game.playstate = 'victorious';
  } // T_BJDone

  /** `T_Player` and `T_Attack` live in {@link WolfPlayer}; these hand over. */
  T_Player(ob) {
    this.game.agent.think(ob);
  } // T_Player

  T_Attack(ob) {
    this.game.agent.attack(ob);
  } // T_Attack

} // WolfActors
