const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
const { WolfWorld } = await import('./world.js?ver='+window.srcVersion);
const { SOUND } = await import('./soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * BJ himself: how he moves, what he opens, and what happens when he pulls
 * the trigger.
 *
 * Movement is the part that has to be exact, because a demo is nothing but
 * a recording of the controls and it drifts apart from the original at the
 * first rounding that differs. Two things carry it:
 *
 * - **turning keeps a remainder.** `controlx` is added into `anglefrac`,
 *   and only every twentieth unit of it becomes a whole degree. Without
 *   that remainder a slow turn would lose a degree here and there and the
 *   whole demo would end up facing somewhere else.
 * - **a blocked move is tried again along each axis.** If the diagonal step
 *   does not fit, the game tries the same move with only x, then with only
 *   y, and takes the first that fits - which is what sliding along a wall
 *   is, and why you can walk into a corner and come out beside it.
 *
 * The player's radius is `MINDIST`, and what he may not walk into is a
 * wall, a shut door, a blocking lamp - or a guard, with a wider spacing of
 * `MINACTORDIST` between their middles.
 */
export class WolfPlayer {

  /** how much of a unit of control is a step */
  static get MOVESCALE() { return 150; }
  static get BACKMOVESCALE() { return 100; }
  /** how many units of `controlx` make one degree */
  static get ANGLESCALE() { return 20; }
  /** walking and running, in the units `Thrust` takes */
  static get PLAYERSPEED() { return 3000; }
  static get RUNSPEED() { return 6000; }
  /** BJ starts with eight bullets */
  static get STARTAMMO() { return 8; }
  /** an extra life every 40000 points */
  static get EXTRAPOINTS() { return 40000; }
  /** how long a face lasts before it may change */
  static get FACETICS() { return 70; }

  /** the four weapons */
  static get WEAPON() { return { KNIFE: 0, PISTOL: 1, MACHINEGUN: 2, CHAINGUN: 3 }; }

  /** the buttons, in the order the demos record them */
  static get BUTTON() {
    return { ATTACK: 0, STRAFE: 1, RUN: 2, USE: 3, READYKNIFE: 4, READYPISTOL: 5,
             READYMACHINEGUN: 6, READYCHAINGUN: 7 };
  } // BUTTON

  /**
   * `attackinfo`: for each weapon, the four steps of firing it - how many
   * tics the step lasts, what it does (0 nothing, 1 a shot, 2 the knife,
   * 3 hold for the machine gun, 4 hold for the chain gun, -1 done), and
   * which frame of the weapon to draw.
   */
  static get ATTACKINFO() {
    return [
      [[6, 0, 1], [6, 2, 2], [6, 0, 3], [6, -1, 4]],
      [[6, 0, 1], [6, 1, 2], [6, 0, 3], [6, -1, 4]],
      [[6, 0, 1], [6, 1, 2], [6, 3, 3], [6, -1, 4]],
      [[6, 0, 1], [6, 1, 2], [6, 4, 3], [6, -1, 4]]
    ];
  } // ATTACKINFO

  /**
   * @param {WolfGame} game - The game this player belongs to.
   */
  constructor(game) {
    this.id = 'WolfPlayer';
    this.game = game;
    /** the remainder of turning that has not made a whole degree yet */
    this.anglefrac = 0;
    /** how much the player moved this frame, for the actors to react to */
    this.playerxmove = 0;
    this.playerymove = 0;
    /** how hard he is pushing, which is what makes footsteps */
    this.thrustspeed = 0;
    /** who hit him last, for the face he pulls when he dies */
    this.lastAttacker = null;
    /** counts down to the next face */
    this.facecount = 0;
  } // constructor

  /**
   * `SpawnPlayer`: where plane 1 says he starts, in the middle of the tile,
   * facing one of the four ways.
   * @param {Object} ob - The player's actor record.
   * @param {number} tilex
   * @param {number} tiley
   * @param {number} dir - 0 north, 1 east, 2 south, 3 west.
   */
  spawn(ob, tilex, tiley, dir) {
    var world = this.game.world;
    ob.obclass = 1;                                  // playerobj
    ob.active = 1;
    ob.tilex = tilex;
    ob.tiley = tiley;
    ob.areanumber = world.mapPlane0[tiley * WolfWorld.MAPSIZE + tilex];
    ob.x = (tilex << 16) + WolfFixed.TILEGLOBAL / 2;
    ob.y = (tiley << 16) + WolfFixed.TILEGLOBAL / 2;
    ob.state = this.game.states.player;
    ob.angle = (1 - dir) * 90;
    if (ob.angle < 0) ob.angle += WolfFixed.ANGLES;
    ob.flags = 4;                                    // FL_NEVERMARK
    this.thrust(0, 0);                               // sets the area and the tile
    world.areabyplayer.fill(0);
    world.areabyplayer[ob.areanumber] = 1;
  } // spawn

  // ---------------------------------------------------------------- moving

  /**
   * `ControlMovement`: turning, walking, and strafing, out of `controlx`
   * and `controly` - which are already multiplied by the tics of the frame
   * by the time they get here.
   */
  controlMovement(ob) {
    var game = this.game;
    var player = game.player;
    this.thrustspeed = 0;
    var oldx = player.x;
    var oldy = player.y;
    var angles = WolfFixed.ANGLES;

    if (game.buttonstate[WolfPlayer.BUTTON.STRAFE]) {
      if (game.controlx > 0) {
        var left = ob.angle - angles / 4;
        if (left < 0) left += angles;
        this.thrust(left, game.controlx * WolfPlayer.MOVESCALE);
      } else if (game.controlx < 0) {
        var right = ob.angle + angles / 4;
        if (right >= angles) right -= angles;
        this.thrust(right, -game.controlx * WolfPlayer.MOVESCALE);
      }
    } else {
      this.anglefrac += game.controlx;
      var units = Math.trunc(this.anglefrac / WolfPlayer.ANGLESCALE);
      this.anglefrac -= units * WolfPlayer.ANGLESCALE;
      ob.angle -= units;
      if (ob.angle >= angles) ob.angle -= angles;
      if (ob.angle < 0) ob.angle += angles;
    }

    if (game.controly < 0) {
      this.thrust(ob.angle, -game.controly * WolfPlayer.MOVESCALE);
    } else if (game.controly > 0) {
      var back = ob.angle + angles / 2;
      if (back >= angles) back -= angles;
      this.thrust(back, game.controly * WolfPlayer.BACKMOVESCALE);
    }

    if (game.gamestate.victoryflag) return;
    this.playerxmove = player.x - oldx;
    this.playerymove = player.y - oldy;
  } // controlMovement

  /**
   * `Thrust`: a push in a direction. The speed is capped so that a step can
   * never be longer than the player is wide, which is what keeps him from
   * stepping over a wall at high tic counts.
   */
  thrust(angle, speed) {
    var game = this.game;
    var player = game.player;
    var tables = game.tables;
    this.thrustspeed += speed;
    if (speed >= WolfFixed.MINDIST * 2) speed = WolfFixed.MINDIST * 2 - 1;

    var xmove = WolfFixed.byFrac(speed, tables.cos(angle));
    var ymove = -WolfFixed.byFrac(speed, tables.sin(angle));
    this.clipMove(player, xmove, ymove);

    player.tilex = player.x >> 16;
    player.tiley = player.y >> 16;
    var world = game.world;
    var offset = player.tiley * WolfWorld.MAPSIZE + player.tilex;
    player.areanumber = world.mapPlane0[offset] - WolfWorld.AREATILE;
    if (world.mapPlane1[offset] === WolfWorld.EXITTILE) game.victoryTile();
  } // thrust

  /**
   * `ClipMove`: the move, and if it does not fit, the same move along one
   * axis at a time. A blocked move also thumps against the wall, but only
   * when nothing else is playing.
   */
  clipMove(ob, xmove, ymove) {
    var basex = ob.x;
    var basey = ob.y;

    ob.x = basex + xmove;
    ob.y = basey + ymove;
    if (this.tryMove(ob)) return;

    if (this.game.noclip) return;
    if (!this.game.soundPlaying()) this.game.playSound(SOUND.HITWALL);

    ob.x = basex + xmove;
    ob.y = basey;
    if (this.tryMove(ob)) return;

    ob.x = basex;
    ob.y = basey + ymove;
    if (this.tryMove(ob)) return;

    ob.x = basex;
    ob.y = basey;
  } // clipMove

  /**
   * `TryMove`: whether the player fits where he has just been put. Walls
   * and doors are checked over the tiles his body covers; actors over one
   * tile more in every direction, because they are checked by the distance
   * between the two middles rather than by tiles.
   */
  tryMove(ob) {
    var world = this.game.world;
    var size = WolfFixed.MINDIST;
    var xl = (ob.x - size) >> 16;
    var yl = (ob.y - size) >> 16;
    var xh = (ob.x + size) >> 16;
    var yh = (ob.y + size) >> 16;

    for (var y = yl; y <= yh; y++) {
      for (var x = xl; x <= xh; x++) {
        var thing = world.actorat[(x << 6) + y];
        if (thing !== null && typeof thing === 'number') return false;
      }
    }

    if (yl > 0) yl--;
    if (yh < WolfWorld.MAPSIZE - 1) yh++;
    if (xl > 0) xl--;
    if (xh < WolfWorld.MAPSIZE - 1) xh++;

    for (var ay = yl; ay <= yh; ay++) {
      for (var ax = xl; ax <= xh; ax++) {
        var check = world.actorat[(ax << 6) + ay];
        if (check !== null && typeof check === 'object' && (check.flags & 1)) {
          var deltax = ob.x - check.x;
          if (deltax < -WolfFixed.MINACTORDIST || deltax > WolfFixed.MINACTORDIST) continue;
          var deltay = ob.y - check.y;
          if (deltay < -WolfFixed.MINACTORDIST || deltay > WolfFixed.MINACTORDIST) continue;
          return false;
        }
      }
    }
    return true;
  } // tryMove

  // --------------------------------------------------------------- actions

  /**
   * `Cmd_Use`: space at a door, a lift or a wall that gives. Which tile is
   * meant comes from which of the four cardinal directions the player is
   * nearest to facing - the lift only works from the east or the west,
   * because that is the way its switch is drawn.
   */
  use() {
    var game = this.game;
    var world = game.world;
    var player = game.player;
    var angles = WolfFixed.ANGLES;
    var checkx;
    var checky;
    var dir;
    var elevatorok;

    if (player.angle < angles / 8 || player.angle > 7 * angles / 8) {
      checkx = player.tilex + 1;
      checky = player.tiley;
      dir = WolfWorld.PUSHDIR.EAST;
      elevatorok = true;
    } else if (player.angle < 3 * angles / 8) {
      checkx = player.tilex;
      checky = player.tiley - 1;
      dir = WolfWorld.PUSHDIR.NORTH;
      elevatorok = false;
    } else if (player.angle < 5 * angles / 8) {
      checkx = player.tilex - 1;
      checky = player.tiley;
      dir = WolfWorld.PUSHDIR.WEST;
      elevatorok = true;
    } else {
      checkx = player.tilex;
      checky = player.tiley + 1;
      dir = WolfWorld.PUSHDIR.SOUTH;
      elevatorok = false;
    }

    var doornum = world.tileAt(checkx, checky);
    var plane1 = world.mapPlane1[checky * WolfWorld.MAPSIZE + checkx];
    if (plane1 === WolfWorld.PUSHABLETILE) {
      world.pushWall(checkx, checky, dir);
      return;
    }
    var held = game.buttonheld[WolfPlayer.BUTTON.USE];
    if (!held && doornum === WolfWorld.ELEVATORTILE && elevatorok) {
      game.buttonheld[WolfPlayer.BUTTON.USE] = true;
      world.tilemap[world.at(checkx, checky)]++;      // the switch flips over
      var here = world.mapPlane0[player.tiley * WolfWorld.MAPSIZE + player.tilex];
      // the lift that leads to the secret level is the one the player stands
      // on floor code 107 to use (`ALTELEVATORTILE`, the same number as the
      // first floor code)
      game.playstate = here === WolfWorld.AREATILE ? 'secretlevel' : 'completed';
      game.playSound(SOUND.LEVELDONE);
    } else if (!held && (doornum & 0x80)) {
      game.buttonheld[WolfPlayer.BUTTON.USE] = true;
      world.operateDoor(doornum & ~0x80);
    } else {
      game.playSound(SOUND.DONOTHING);
    }
  } // use

  /** `Cmd_Fire`: the trigger is pulled, and the weapon starts its four steps. */
  fire() {
    var game = this.game;
    game.buttonheld[WolfPlayer.BUTTON.ATTACK] = true;
    game.gamestate.weaponframe = 0;
    game.player.state = game.states.attack;
    game.gamestate.attackframe = 0;
    game.gamestate.attackcount = WolfPlayer.ATTACKINFO[game.gamestate.weapon][0][0];
    game.gamestate.weaponframe = WolfPlayer.ATTACKINFO[game.gamestate.weapon][0][2];
  } // fire

  /** `CheckWeaponChange`: keys 1 to 4, as far as the best weapon he has. */
  checkWeaponChange() {
    var game = this.game;
    if (!game.gamestate.ammo) return;               // no ammo, no choice
    for (var weapon = 0; weapon <= game.gamestate.bestweapon; weapon++) {
      if (game.buttonstate[WolfPlayer.BUTTON.READYKNIFE + weapon]) {
        game.gamestate.weapon = game.gamestate.chosenweapon = weapon;
        return;
      }
    }
  } // checkWeaponChange

  // --------------------------------------------------------------- thinking

  /**
   * `T_Player`: what the player does in a tic when he is not firing.
   */
  think(ob) {
    var game = this.game;
    if (game.gamestate.victoryflag) {
      this.victorySpin();
      return;
    }
    this.updateFace();
    this.checkWeaponChange();
    if (game.buttonstate[WolfPlayer.BUTTON.USE]) this.use();
    if (game.buttonstate[WolfPlayer.BUTTON.ATTACK] && !game.buttonheld[WolfPlayer.BUTTON.ATTACK]) {
      this.fire();
    }
    this.controlMovement(ob);
    if (game.gamestate.victoryflag) return;
    game.player.tilex = game.player.x >> 16;
    game.player.tiley = game.player.y >> 16;
  } // think

  /**
   * `T_Attack`: the same tic while a weapon is going through its steps. The
   * loop is a `while`, not an `if`, because a slow frame can take a weapon
   * through more than one step.
   */
  attack(ob) {
    var game = this.game;
    var state = game.gamestate;
    this.updateFace();
    if (state.victoryflag) {
      this.victorySpin();
      return;
    }
    if (game.buttonstate[WolfPlayer.BUTTON.USE] && !game.buttonheld[WolfPlayer.BUTTON.USE]) {
      game.buttonstate[WolfPlayer.BUTTON.USE] = false;
    }
    if (game.buttonstate[WolfPlayer.BUTTON.ATTACK] && !game.buttonheld[WolfPlayer.BUTTON.ATTACK]) {
      game.buttonstate[WolfPlayer.BUTTON.ATTACK] = false;
    }

    this.controlMovement(ob);
    if (state.victoryflag) return;
    game.player.tilex = game.player.x >> 16;
    game.player.tiley = game.player.y >> 16;

    state.attackcount -= game.tics;
    while (state.attackcount <= 0) {
      var cur = WolfPlayer.ATTACKINFO[state.weapon][state.attackframe];
      switch (cur[1]) {
        case -1:
          ob.state = game.states.player;
          if (!state.ammo) {
            state.weapon = WolfPlayer.WEAPON.KNIFE;
          } else if (state.weapon !== state.chosenweapon) {
            state.weapon = state.chosenweapon;
          }
          state.attackframe = state.weaponframe = 0;
          return;
        case 4:
          if (!state.ammo) break;
          if (game.buttonstate[WolfPlayer.BUTTON.ATTACK]) state.attackframe -= 2;
          // falls through to the shot itself
        case 1:
          if (!state.ammo) {
            state.attackframe++;
            break;
          }
          this.gunAttack(ob);
          state.ammo--;
          break;
        case 2:
          this.knifeAttack(ob);
          break;
        case 3:
          if (state.ammo && game.buttonstate[WolfPlayer.BUTTON.ATTACK]) state.attackframe -= 2;
          break;
      }
      state.attackcount += cur[0];
      state.attackframe++;
      state.weaponframe = WolfPlayer.ATTACKINFO[state.weapon][state.attackframe][2];
    }
  } // attack

  /**
   * `KnifeAttack`: the nearest thing in front of him, and only if it is
   * within about a tile and a half.
   */
  knifeAttack(ob) {
    var game = this.game;
    game.playSound(SOUND.ATKKNIFE);
    var closest = null;
    var dist = 0x7fffffff;
    var actors = game.actors;
    for (var i = 1; i < actors.length; i++) {
      var check = actors[i];
      if ((check.flags & 1) && (check.flags & 8) &&
          Math.abs(check.viewx - game.tables.centerX) < game.shootdelta) {
        if (check.transx < dist) {
          dist = check.transx;
          closest = check;
        }
      }
    }
    if (!closest || dist > 0x18000) return;
    game.damageActor(closest, game.random.next() >> 4);
  } // knifeAttack

  /**
   * `GunAttack`: the nearest thing in front of him that the shot can
   * actually reach - if the line of sight is blocked the next one behind it
   * is tried, and so on. How much it hurts falls off with distance, and
   * past four tiles the shot can miss outright.
   */
  gunAttack(ob) {
    var game = this.game;
    var state = game.gamestate;
    switch (state.weapon) {
      case WolfPlayer.WEAPON.PISTOL: game.playSound(SOUND.ATKPISTOL); break;
      case WolfPlayer.WEAPON.MACHINEGUN: game.playSound(SOUND.ATKMACHINEGUN); break;
      case WolfPlayer.WEAPON.CHAINGUN: game.playSound(SOUND.ATKGATLING); break;
    }
    game.madenoise = true;

    var viewdist = 0x7fffffff;
    var closest = null;
    var actors = game.actors;
    for (;;) {
      var oldclosest = closest;
      for (var i = 1; i < actors.length; i++) {
        var check = actors[i];
        if ((check.flags & 1) && (check.flags & 8) &&
            Math.abs(check.viewx - game.tables.centerX) < game.shootdelta) {
          if (check.transx < viewdist) {
            viewdist = check.transx;
            closest = check;
          }
        }
      }
      if (closest === oldclosest) return;        // nothing else to hit
      if (game.checkLine(closest)) break;
    }

    var dx = Math.abs(closest.tilex - game.player.tilex);
    var dy = Math.abs(closest.tiley - game.player.tiley);
    var dist = dx > dy ? dx : dy;
    var damage;
    if (dist < 2) damage = Math.trunc(game.random.next() / 4);
    else if (dist < 4) damage = Math.trunc(game.random.next() / 6);
    else {
      if (Math.trunc(game.random.next() / 12) < dist) return;    // missed
      damage = Math.trunc(game.random.next() / 6);
    }
    game.damageActor(closest, damage);
  } // gunAttack

  // ------------------------------------------------------------ what he has

  /** `TakeDamage`. On the easiest setting a hit only does a quarter. */
  takeDamage(points, attacker) {
    var game = this.game;
    var state = game.gamestate;
    this.lastAttacker = attacker;
    if (state.victoryflag) return;
    if (state.difficulty === 0) points >>= 2;
    if (!game.godmode) state.health -= points;
    if (state.health <= 0) {
      state.health = 0;
      game.playstate = 'died';
      game.killerobj = attacker;
    }
    game.startDamageFlash(points);
    this.facecount = 0;
  } // takeDamage

  healSelf(points) {
    var state = this.game.gamestate;
    state.health += points;
    if (state.health > 100) state.health = 100;
  } // healSelf

  givePoints(points) {
    var state = this.game.gamestate;
    state.score += points;
    while (state.score >= state.nextextra) {
      state.nextextra += WolfPlayer.EXTRAPOINTS;
      this.giveExtraMan();
    }
  } // givePoints

  giveExtraMan() {
    var state = this.game.gamestate;
    if (state.lives < 9) state.lives++;
    this.game.playSound(SOUND.BONUS1UP);
  } // giveExtraMan

  giveAmmo(ammo) {
    var state = this.game.gamestate;
    if (!state.ammo && !state.attackframe) state.weapon = state.chosenweapon;
    state.ammo += ammo;
    if (state.ammo > 99) state.ammo = 99;
  } // giveAmmo

  giveWeapon(weapon) {
    var state = this.game.gamestate;
    this.giveAmmo(6);
    if (state.bestweapon < weapon) {
      state.bestweapon = state.weapon = state.chosenweapon = weapon;
    }
  } // giveWeapon

  giveKey(key) {
    this.game.gamestate.keys |= 1 << key;
  } // giveKey

  /**
   * `GetBonus`: what walking over a thing does. A bonus that would be
   * wasted - food at full health, a clip with 99 rounds - is left where it
   * is and picked up later.
   * @param {Object} check - The static object.
   */
  getBonus(check) {
    var game = this.game;
    var state = game.gamestate;
    var stat = WolfWorld.STAT;
    switch (check.itemnumber) {
      case stat.bo_firstaid:
        if (state.health === 100) return;
        game.playSound(SOUND.HEALTH2);
        this.healSelf(25);
        break;
      case stat.bo_key1:
      case stat.bo_key2:
      case stat.bo_key3:
      case stat.bo_key4:
        this.giveKey(check.itemnumber - stat.bo_key1);
        game.playSound(SOUND.GETKEY);
        break;
      case stat.bo_cross:
        game.playSound(SOUND.BONUS1);
        this.givePoints(100);
        state.treasurecount++;
        break;
      case stat.bo_chalice:
        game.playSound(SOUND.BONUS2);
        this.givePoints(500);
        state.treasurecount++;
        break;
      case stat.bo_bible:
        game.playSound(SOUND.BONUS3);
        this.givePoints(1000);
        state.treasurecount++;
        break;
      case stat.bo_crown:
        game.playSound(SOUND.BONUS4);
        this.givePoints(5000);
        state.treasurecount++;
        break;
      case stat.bo_clip:
        if (state.ammo === 99) return;
        game.playSound(SOUND.GETAMMO);
        this.giveAmmo(8);
        break;
      case stat.bo_clip2:
        if (state.ammo === 99) return;
        game.playSound(SOUND.GETAMMO);
        this.giveAmmo(4);
        break;
      case stat.bo_machinegun:
        game.playSound(SOUND.GETMACHINE);
        this.giveWeapon(WolfPlayer.WEAPON.MACHINEGUN);
        break;
      case stat.bo_chaingun:
        game.playSound(SOUND.GETGATLING);
        this.giveWeapon(WolfPlayer.WEAPON.CHAINGUN);
        game.gotgatgun = 1;
        this.facecount = 0;
        break;
      case stat.bo_fullheal:
        game.playSound(SOUND.BONUS1UP);
        this.healSelf(99);
        this.giveAmmo(25);
        this.giveExtraMan();
        state.treasurecount++;
        break;
      case stat.bo_food:
        if (state.health === 100) return;
        game.playSound(SOUND.HEALTH1);
        this.healSelf(10);
        break;
      case stat.bo_alpo:
        if (state.health === 100) return;
        game.playSound(SOUND.HEALTH1);
        this.healSelf(4);
        break;
      case stat.bo_gibs:
        if (state.health > 10) return;
        game.playSound(SOUND.SLURPIE);
        this.healSelf(1);
        break;
      default:
        return;
    }
    game.startBonusFlash();
    check.shapenum = -1;                             // gone from the level
  } // getBonus

  /**
   * `UpdateFace`: BJ looks around. How long a face lasts is itself a draw
   * from the table, which is why the eyes never move to a rhythm.
   */
  updateFace() {
    var game = this.game;
    // the face draws from `rndtable` twice every time it changes, and a demo
    // draws with it - the later ports count frames here instead and their
    // demos come out different (NOTES.md para 6)
    if (game.soundPlaying() === SOUND.GETGATLING) return;
    this.facecount += game.tics;
    if (this.facecount > game.random.next()) {
      game.gamestate.faceframe = game.random.next() >> 6;
      if (game.gamestate.faceframe === 3) game.gamestate.faceframe = 1;
      this.facecount = 0;
    }
  } // updateFace

  /**
   * `VictorySpin`: after the boss dies the player turns to face the last
   * gasp of BJ and walks back a little.
   */
  victorySpin() {
    var game = this.game;
    var player = game.player;
    if (player.angle > 270) {
      player.angle -= game.tics * 3;
      if (player.angle < 270) player.angle = 270;
    } else if (player.angle < 270) {
      player.angle += game.tics * 3;
      if (player.angle > 270) player.angle = 270;
    }
    var desty = ((player.tiley - 5) << 16) - 0x3000;
    if (player.y > desty) {
      player.y -= game.tics * 4096;
      if (player.y < desty) player.y = desty;
    }
  } // victorySpin

} // WolfPlayer
