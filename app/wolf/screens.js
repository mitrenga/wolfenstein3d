const { SOUND } = await import('./soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * Everything that is not the game itself: the fade the game comes in with,
 * the panel between levels, the pages of story, and the menu.
 *
 * ## The fizzle fade
 *
 * The screen does not fade in, it dissolves: one pixel at a time, in an
 * order that visits all 65 536 positions of a 17 bit shift register before
 * it repeats. The register starts at one; the low eight bits minus one are
 * the line, the next nine the column, and a step is a shift right with the
 * two taps applied when a one falls out. It is **not** random - the same
 * pixels come up in the same order every time, on every machine - which is
 * why `matchscreens` can compare the pixel order step by step and expect
 * nothing to differ.
 *
 * ## The rest
 *
 * The panel after a level, the story pages and the menu are drawn from the
 * same pictures and the same two fonts as the original, at the positions it
 * uses - the panel writes in units of eight pixels, which is how the
 * original's `Write` addressed the screen.
 */
export class WolfScreens {

  /** the colour the story pages are printed on, and the one they print in */
  static get BACKCOLOR() { return 0x11; }
  static get TEXTCOLOR() { return 0x17; }
  /** where a page of story starts */
  static get TOPMARGIN() { return 16; }
  static get BOTTOMMARGIN() { return 32; }
  static get LEFTMARGIN() { return 16; }
  static get RIGHTMARGIN() { return 16; }
  static get PICMARGIN() { return 8; }
  static get SCREENPIXWIDTH() { return 320; }

  /** how many points a second under par is worth, and a clean sweep */
  static get PAR_AMOUNT() { return 500; }
  static get PERCENT100AMT() { return 10000; }

  /**
   * The par times of episode one, in minutes, and as the panel prints them
   * (`parTimes` of the original). The boss level and the secret level have
   * none, and print `??:??`.
   */
  static get PARTIMES() {
    return [
      {minutes: 1.5, text: '01:30'}, {minutes: 2, text: '02:00'},
      {minutes: 2, text: '02:00'}, {minutes: 3.5, text: '03:30'},
      {minutes: 3, text: '03:00'}, {minutes: 3, text: '03:00'},
      {minutes: 2.5, text: '02:30'}, {minutes: 2.5, text: '02:30'},
      {minutes: 0, text: '??:??'}, {minutes: 0, text: '??:??'}
    ];
  } // PARTIMES

  /**
   * @param {WolfAssets} assets - The pictures and the fonts.
   */
  constructor(assets) {
    this.id = 'WolfScreens';
    this.assets = assets;
    /** which font a line of text is printed in */
    this.font = 0;
    this.fontcolor = WolfScreens.TEXTCOLOR;
    this.backcolor = WolfScreens.BACKCOLOR;
  } // constructor

  // ------------------------------------------------------------- the fade

  /**
   * The order the fizzle fade visits the pixels in.
   *
   * @param {number} [width=320]
   * @param {number} [height=200]
   * @returns {Function} A step: call it with how many pixels to take and it
   *          returns an array of `[x, y]` and whether the sequence is over.
   */
  static fizzleSequence(width, height) {
    var w = width === undefined ? 320 : width;
    var h = height === undefined ? 200 : height;
    var rndval = 1;
    var done = false;
    return function (count) {
      var pixels = [];
      for (var i = 0; i < count && !done; i++) {
        var y = ((rndval & 0xff) - 1) & 0xff;
        var x = ((rndval >> 8) & 0x1ff);
        // one step of the shift register: shift right, and if a one fell
        // out, the two taps
        var carry = rndval & 1;
        rndval = rndval >>> 1;
        if (carry) rndval ^= 0x00012000;
        if (x <= w && y <= h) pixels.push([x, y]);
        if (rndval === 1) {
          done = true;                      // the whole sequence has been walked
          break;
        }
      }
      return { pixels: pixels, done: done };
    };
  } // fizzleSequence

  /**
   * A fizzle fade from one picture to another, a frame at a time.
   * @param {VGAVideoRAM} from - What is on the screen now.
   * @param {VGAVideoRAM} to - What should be there.
   * @param {number} [frames=20] - Over how many frames.
   * @returns {Function} Call it once a frame with the screen to draw into;
   *          it returns true when the fade is over.
   */
  static fizzleFade(from, to, frames) {
    var howMany = frames === undefined ? 20 : frames;
    var step = WolfScreens.fizzleSequence(320, 200);
    var perFrame = Math.floor(64000 / howMany);
    return function (screen) {
      var taken = step(perFrame);
      for (var i = 0; i < taken.pixels.length; i++) {
        var at = taken.pixels[i][1] * 320 + taken.pixels[i][0];
        if (at >= 0 && at < 64000) screen.bytes[at] = to.bytes[at];
      }
      return taken.done;
    };
  } // fizzleFade

  // ------------------------------------------------------------- printing

  /**
   * One character of one of the game's two fonts.
   * @param {VGAVideoRAM} screen
   * @param {number} font - 0 or 1.
   * @param {number} x - In pixels.
   * @param {number} y
   * @param {string} character
   * @param {number} color
   * @returns {number} How wide it was.
   */
  drawChar(screen, font, x, y, character, color) {
    var record = this.assets.fonts[font];
    if (!record) return 0;
    var glyph = record.glyphs[character.charCodeAt(0) & 0xff];
    if (!glyph) return 0;
    for (var line = 0; line < record.height; line++) {
      var row = line * glyph.width;
      var at = (y + line) * 320 + x;
      if (y + line < 0 || y + line >= 200) continue;
      for (var column = 0; column < glyph.width; column++) {
        if (x + column < 0 || x + column >= 320) continue;
        if (glyph.pixels[row + column]) screen.bytes[at + column] = color;
      }
    }
    return glyph.width;
  } // drawChar

  /**
   * A string, with a newline starting a fresh line under the first.
   * @returns {{x: number, y: number}} Where the next character would go.
   */
  drawString(screen, font, x, y, text, color) {
    var record = this.assets.fonts[font];
    if (!record) return {x: x, y: y};
    var left = x;
    var at = x;
    var line = y;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        at = left;
        line += record.height;
        continue;
      }
      at += this.drawChar(screen, font, at, line, text[i], color);
    }
    return {x: at, y: line};
  } // drawString

  /** How wide a string is in a font. */
  textWidth(font, text) {
    var record = this.assets.fonts[font];
    if (!record) return 0;
    var width = 0;
    for (var i = 0; i < text.length; i++) {
      var glyph = record.glyphs[text.charCodeAt(i) & 0xff];
      if (glyph) width += glyph.width;
    }
    return width;
  } // textWidth

  /** A picture by name, at a place. */
  drawPic(screen, x, y, name) {
    var picture = typeof name === 'string' ? this.assets.picture(name) : name;
    if (!picture) return;
    for (var line = 0; line < picture.height; line++) {
      if (y + line < 0 || y + line >= 200) continue;
      var at = (y + line) * 320 + x;
      var row = line * picture.width;
      for (var column = 0; column < picture.width; column++) {
        if (x + column < 0 || x + column >= 320) continue;
        screen.bytes[at + column] = picture.pixels[row + column];
      }
    }
  } // drawPic

  // -------------------------------------------------- the panel after a level

  /**
   * `LevelCompleted`: the panel with the time, the par, and the three
   * ratios. The original counts the numbers up one at a time with a noise
   * for every ten; this draws the finished panel and hands back what the
   * counting would be, so the model can animate it (`state.steps`).
   *
   * @param {VGAVideoRAM} screen
   * @param {Object} state - The summary the worker sends when a level ends.
   * @returns {Object} The bonus and the three ratios.
   */
  levelCompleted(screen, state) {
    var par = WolfScreens.PARTIMES[state.mapon % WolfScreens.PARTIMES.length];
    var seconds = Math.floor(state.time / 70);
    if (seconds > 99 * 60) seconds = 99 * 60;
    var timeleft = 0;
    if (state.time < par.minutes * 4200) {
      timeleft = Math.floor((par.minutes * 4200) / 70) - seconds;
    }
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;

    var kill = state.killtotal ? Math.floor((state.kill * 100) / state.killtotal) : 0;
    var secret = state.secrettotal ? Math.floor((state.secret * 100) / state.secrettotal) : 0;
    var treasure = state.treasuretotal ? Math.floor((state.treasure * 100) / state.treasuretotal) : 0;

    var bonus = timeleft * WolfScreens.PAR_AMOUNT;
    if (kill === 100) bonus += WolfScreens.PERCENT100AMT;
    if (secret === 100) bonus += WolfScreens.PERCENT100AMT;
    if (treasure === 100) bonus += WolfScreens.PERCENT100AMT;

    screen.fill(WolfScreens.BACKCOLOR);
    this.drawPic(screen, 0, 16, 'L_GUYPIC');
    this.write(screen, 14, 2, 'floor\ncompleted');
    this.write(screen, 26, 2, String(state.mapon + 1));
    this.write(screen, 14, 7, 'bonus     0');
    this.write(screen, 16, 10, 'time');
    this.write(screen, 16, 12, ' par');
    this.write(screen, 26, 12, par.text);
    this.write(screen, 9, 14, 'kill ratio    %');
    this.write(screen, 5, 16, 'secret ratio    %');
    this.write(screen, 1, 18, 'treasure ratio    %');

    // the clock, in the big level digits
    var x = 26 * 8;
    this.drawPic(screen, x, 10 * 8, 'L_NUM' + Math.floor(minutes / 10) + 'PIC');
    this.drawPic(screen, x + 16, 10 * 8, 'L_NUM' + (minutes % 10) + 'PIC');
    this.write(screen, (x + 32) / 8, 10, ':');
    this.drawPic(screen, x + 40, 10 * 8, 'L_NUM' + Math.floor(rest / 10) + 'PIC');
    this.drawPic(screen, x + 56, 10 * 8, 'L_NUM' + (rest % 10) + 'PIC');

    this.writeRight(screen, 36, 7, String(bonus));
    this.writeRight(screen, 37, 14, String(kill));
    this.writeRight(screen, 37, 16, String(secret));
    this.writeRight(screen, 37, 18, String(treasure));

    return {bonus: bonus, kill: kill, secret: secret, treasure: treasure,
            minutes: minutes, seconds: rest, timeleft: timeleft, par: par.text};
  } // levelCompleted

  /**
   * `Write`: the panel between levels does not use a font at all - every
   * letter is a **picture of its own** (`L_APIC` and the rest), sixteen
   * pixels wide, eight for the few marks that are narrow. `x` and `y` count
   * eight pixels, which is why the positions in the original look like half
   * characters.
   *
   * @param {VGAVideoRAM} screen
   * @param {number} x - In units of eight pixels.
   * @param {number} y - The same.
   * @param {string} text - Letters, digits and `: % ! '`; a newline drops
   *        sixteen pixels and goes back to the left.
   */
  write(screen, x, y, text) {
    var left = x * 8;
    var at = left;
    var line = y * 8;
    for (var i = 0; i < text.length; i++) {
      var character = text[i];
      if (character === '\n') {
        at = left;
        line += 16;
        continue;
      }
      if (character === ' ') { at += 16; continue; }
      var narrow = {'!': 'L_EXPOINTPIC', "'": 'L_APOSTROPHEPIC', ':': 'L_COLONPIC'}[character];
      if (narrow) {
        this.drawPic(screen, at, line, narrow);
        at += 8;
        continue;
      }
      if (character === '%') {
        this.drawPic(screen, at, line, 'L_PERCENTPIC');
        at += 16;
        continue;
      }
      var upper = character.toUpperCase();
      var name = upper >= '0' && upper <= '9' ? 'L_NUM' + upper + 'PIC' : 'L_' + upper + 'PIC';
      this.drawPic(screen, at, line, name);
      at += 16;
    }
    return at;
  } // write

  /**
   * The same, but the original works out where a number starts from how
   * long it is: `x - length*2` in units of eight pixels, which is the same
   * as ending at `x`.
   */
  writeRight(screen, x, y, text) {
    return this.write(screen, x - text.length * 2, y, text);
  } // writeRight

  // ------------------------------------------------------- the story pages

  /**
   * A page of the story or of the help, in the markup the original writes
   * them in:
   *
   *   ^P    the page ends here          ^E   the text ends here
   *   ^C..  two hex digits of colour    ^G   y,x,pic - a picture
   *   ^L    y,x - move there            ^B   y,x,w,h - a bar of background
   *   ^>    to the middle               ^;   a comment to the end of the line
   *
   * @param {VGAVideoRAM} screen
   * @param {string} text - The whole chunk.
   * @param {number} [from=0] - Where in it to start.
   * @returns {number} Where the next page starts, or -1 at the end.
   */
  drawPage(screen, text, from) {
    var at = from === undefined ? 0 : from;
    var font = this.assets.fonts[0];
    var height = font ? font.height : 10;
    var color = 0;
    var right = WolfScreens.SCREENPIXWIDTH - WolfScreens.RIGHTMARGIN;

    // the frame the pages are printed in
    screen.fillRect(0, 0, 320, 200, WolfScreens.BACKCOLOR);
    this.drawPic(screen, 0, 0, 'H_TOPWINDOWPIC');
    this.drawPic(screen, 0, 8, 'H_LEFTWINDOWPIC');
    this.drawPic(screen, 312, 8, 'H_RIGHTWINDOWPIC');
    this.drawPic(screen, 8, 176, 'H_BOTTOMINFOPIC');

    var x = WolfScreens.LEFTMARGIN;
    var y = WolfScreens.TOPMARGIN;

    // a page begins with a line of its own: `^PAGE n`. The whole line is
    // skipped, marker and all
    while (at < text.length && text.charCodeAt(at) <= 32) at++;
    if (text[at] === '^' && (text[at + 1] || '').toUpperCase() === 'P') {
      while (at < text.length && text[at] !== '\n') at++;
      at++;
    }

    var number = () => {
      var digits = '';
      while (at < text.length && text[at] >= '0' && text[at] <= '9') digits += text[at++];
      if (text[at] === ',') at++;
      return parseInt(digits, 10) || 0;
    };
    var toEOL = () => {
      while (at < text.length && text[at] !== '\n') at++;
      at++;
    };

    while (at < text.length) {
      var character = text[at];
      if (character === '^') {
        var command = (text[at + 1] || '').toUpperCase();
        if (command === 'P' || command === 'E') return command === 'E' ? -1 : at;
        at += 2;
        switch (command) {
          case 'C':
            color = parseInt(text.substr(at, 2), 16);
            if (isNaN(color)) color = 0;
            at += 2;
            break;
          case 'L':
            y = number();
            x = number();
            toEOL();
            break;
          case 'G': {
            var picY = number();
            var picX = number();
            var picNumber = number();
            var picture = this.assets.pictures[picNumber - 3] || null;
            if (picture) this.drawPic(screen, picX & ~7, picY, picture);
            toEOL();
            break;
          }
          case 'B': {
            var barY = number();
            var barX = number();
            var barW = number();
            var barH = number();
            screen.fillRect(barX, barY, barW, barH, WolfScreens.BACKCOLOR);
            toEOL();
            break;
          }
          case '>':
            x = 160;
            break;
          case ';':
            toEOL();
            break;
          default:
            break;
        }
        continue;
      }
      if (character === '\n') {
        x = WolfScreens.LEFTMARGIN;
        y += height;
        at++;
        continue;
      }
      if (character === '\r') { at++; continue; }
      if (character === '\t') { x = (x + 8) & ~7; at++; continue; }
      // one word at a time, so that a line breaks between words
      var word = '';
      while (at < text.length && text[at] !== '\n' && text[at] !== '^' && text[at] !== '\r' && text[at] !== '\t') {
        word += text[at++];
        if (word[word.length - 1] === ' ') break;
      }
      var width = this.textWidth(0, word);
      if (x + width > right) {
        x = WolfScreens.LEFTMARGIN;
        y += height;
      }
      var end = this.drawString(screen, 0, x, y, word, color);
      x = end.x;
    }
    return -1;
  } // drawPage

  // ------------------------------------------------------------- the menu

  /**
   * The main menu of the original, with the cursor on one of its items.
   *
   * The items and the picture are the game's own; what each of them does is
   * the model's business. The gun that marks the choice is `C_CURSOR1PIC`,
   * which the original blinks by swapping it with `C_CURSOR2PIC`.
   *
   * @param {VGAVideoRAM} screen
   * @param {number} chosen - Which item the gun points at.
   * @param {boolean} blink - Which of the two cursor pictures to use.
   */
  drawMenu(screen, chosen, blink) {
    screen.fill(WolfScreens.BACKCOLOR);
    var banner = this.assets.picture('C_OPTIONSPIC');
    if (banner) this.drawPic(screen, Math.floor((320 - banner.width) / 2), 0, banner);
    var items = WolfScreens.MENU_ITEMS;
    var top = 55;
    var height = 13;
    for (var i = 0; i < items.length; i++) {
      this.drawString(screen, 1, 88, top + i * height, items[i],
        i === chosen ? 0x13 : WolfScreens.TEXTCOLOR);
    }
    this.drawPic(screen, 68, top + chosen * height - 2, blink ? 'C_CURSOR2PIC' : 'C_CURSOR1PIC');
  } // drawMenu

  /** What the main menu offers (the shareware release has no save games). */
  static get MENU_ITEMS() {
    return ['New Game', 'Sound', 'Control', 'Read This!', 'View Scores', 'Back to Demo', 'Quit'];
  } // MENU_ITEMS

  /**
   * The four settings, with the face that goes with each of them
   * (`C_BABYMODEPIC` and the three after it).
   */
  static get DIFFICULTIES() {
    return [
      {name: "Can I play, Daddy?", pic: 'C_BABYMODEPIC'},
      {name: "Don't hurt me.", pic: 'C_EASYPIC'},
      {name: "Bring 'em on!", pic: 'C_NORMALPIC'},
      {name: 'I am Death incarnate!', pic: 'C_HARDPIC'}
    ];
  } // DIFFICULTIES

  /** The panel that asks how hard the game should be. */
  drawDifficulty(screen, chosen) {
    screen.fill(WolfScreens.BACKCOLOR);
    this.drawPic(screen, 0, 0, 'C_MOUSELBACKPIC');
    this.drawString(screen, 1, 60, 30, 'How tough are you?', WolfScreens.TEXTCOLOR);
    var list = WolfScreens.DIFFICULTIES;
    for (var i = 0; i < list.length; i++) {
      this.drawString(screen, 1, 88, 60 + i * 13, list[i].name,
        i === chosen ? 0x13 : WolfScreens.TEXTCOLOR);
    }
    this.drawPic(screen, 16, 60, list[chosen].pic);
  } // drawDifficulty

} // WolfScreens
