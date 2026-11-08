const { WolfPlayer } = await import('./player.js?ver='+window.srcVersion);
// begin code

/**
 * The status bar: the forty lines under the view, with BJ's face in the
 * middle of it.
 *
 * The original draws it once and then pokes the numbers that change into
 * place, because redrawing it every frame was too slow on a 286. Here the
 * whole bar is drawn every frame from the same pictures at the same
 * positions - the result on the screen is the same bytes, and `match*`
 * compares bytes, so nothing is lost by it.
 *
 * Every position is the original's, in the units it uses: `x` counts eight
 * pixels (the bar was addressed a byte at a time across four planes), `y`
 * counts lines from the top of the bar.
 *
 *   2,16  level      6,16  score      14,16 lives     17,4  face
 *   21,16 health     27,16 ammo       30,4  gold key  30,20 silver key
 *   32,8  weapon
 *
 * The face is the one detail worth stating: which of the seven rows of
 * faces is shown comes from the health in steps of sixteen, and which of
 * the three in that row is the frame the game last drew from `rndtable` -
 * so BJ's eyes wander to a rhythm that is itself part of the recorded run.
 */
export class WolfHud {

  /** the bar is the bottom forty lines of the screen */
  static get STATUSLINES() { return 40; }
  static get TOP() { return 200 - WolfHud.STATUSLINES; }

  constructor(game, assets) {
    this.id = 'WolfHud';
    this.game = game;
    this.assets = assets;
  } // constructor

  /**
   * The whole bar.
   * @param {VGAVideoRAM} screen - The screen to draw into.
   */
  draw(screen) {
    var state = this.game.gamestate;
    this.pic(screen, 0, 0, 'STATUSBARPIC');
    this.number(screen, 2, 16, 2, state.mapon + 1);
    this.number(screen, 6, 16, 6, state.score);
    this.number(screen, 14, 16, 1, state.lives);
    this.number(screen, 21, 16, 3, state.health);
    this.number(screen, 27, 16, 2, state.ammo);
    this.drawKeys(screen);
    this.drawFace(screen);
    this.pic(screen, 32, 8, ['KNIFEPIC', 'GUNPIC', 'MACHINEGUNPIC', 'GATLINGGUNPIC'][state.weapon] || 'KNIFEPIC');
  } // draw

  /**
   * `DrawFace`: seven rows of three faces by health, and the mutant BJ when
   * a mutant was the last thing to hit him.
   */
  drawFace(screen) {
    var state = this.game.gamestate;
    if (state.health) {
      var row = Math.floor((100 - state.health) / 16);
      if (row > 6) row = 6;
      var frame = state.faceframe;
      this.pic(screen, 17, 4, 'FACE' + (row + 1) + ['A', 'B', 'C'][frame] + 'PIC');
      return;
    }
    var attacker = this.game.agent.lastAttacker;
    if (attacker && attacker.obclass === 12) this.pic(screen, 17, 4, 'MUTANTBJPIC');
    else this.pic(screen, 17, 4, 'FACE8APIC');
  } // drawFace

  /** `DrawKeys`: the gold one over the silver one, blank where he has none. */
  drawKeys(screen) {
    var keys = this.game.gamestate.keys;
    this.pic(screen, 30, 4, (keys & 1) ? 'GOLDKEYPIC' : 'NOKEYPIC');
    this.pic(screen, 30, 20, (keys & 2) ? 'SILVERKEYPIC' : 'NOKEYPIC');
  } // drawKeys

  /**
   * `LatchNumber`: a number right aligned in a field of digit pictures,
   * with blanks in front of it. A number too long for its field loses its
   * leading digits, which is what the original does rather than clamp.
   */
  number(screen, x, y, width, value) {
    var text = String(value);
    var length = text.length;
    while (length < width) {
      this.pic(screen, x, y, 'N_BLANKPIC');
      x++;
      width--;
    }
    var from = length <= width ? 0 : length - width;
    for (var at = from; at < length; at++) {
      this.pic(screen, x, y, 'N_' + text[at] + 'PIC');
      x++;
    }
  } // number

  /**
   * One picture of the bar.
   * @param {VGAVideoRAM} screen
   * @param {number} x - In units of eight pixels.
   * @param {number} y - Lines from the top of the bar.
   * @param {string} name - The chunk name, such as `GOLDKEYPIC`.
   */
  pic(screen, x, y, name) {
    var picture = this.assets.picture(name);
    if (!picture) return;
    var source = { bytes: picture.pixels, width: picture.width, height: picture.height };
    var left = x * 8;
    var top = WolfHud.TOP + y;
    for (var line = 0; line < picture.height; line++) {
      var at = (top + line) * 320 + left;
      if (top + line >= 200) break;
      var row = line * picture.width;
      for (var column = 0; column < picture.width; column++) {
        if (left + column >= 320) break;
        screen.bytes[at + column] = picture.pixels[row + column];
      }
    }
  } // pic

} // WolfHud
