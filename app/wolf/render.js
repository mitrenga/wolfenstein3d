const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
const { WolfWorld } = await import('./world.js?ver='+window.srcVersion);
const { SPRITE } = await import('./spriteNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * The part of Wolfenstein that made it Wolfenstein: one ray per column of
 * the view, walked through the grid until it meets a wall, and a column of
 * texture squeezed into the height that distance gives.
 *
 * Nothing here is drawn from a picture - every frame is computed. The whole
 * pass is integer: the ray steps in 16.16, the tangents come out of
 * {@link WolfTables}, and the height of a wall is one 16 bit division. That
 * is what makes a frame reproducible, and what `matchcolumns` measures.
 *
 * Three things are done exactly as the original does them, and each of them
 * is visible if it is not:
 *
 * - **the posts are batched.** While the ray keeps hitting the same wall at
 *   the same texture column, the columns share one height - the height of
 *   the *first* of them. The original does it to save work; the effect is
 *   that `wallheight[]` has flat runs in it, and sprite clipping reads that
 *   array, so the batching is part of the picture, not an optimisation.
 * - **the door is half a tile in.** A ray that meets a door tile is carried
 *   half a step further and only counts as a hit if it is still in the same
 *   tile and past the leading edge of the door - which is how you can see
 *   through a door that is open and along the jamb of one that is not.
 * - **a moving secret wall is drawn where it is**, by pushing the
 *   intersection along the ray by `pwallpos` sixty-fourths of a tile.
 *
 * The view is the top 320 x 160 of the screen; the 40 lines under it are the
 * status bar (`STATUSLINES`). Ceiling and floor are one colour each: the
 * floor is always 0x19, the ceiling is a colour per level.
 */
export class WolfRender {

  /** the eight door pages sit right before the sprites in VSWAP */
  static get DOORWALL() { return 98; }
  /** the floor of every level of the game */
  static get FLOORCOLOR() { return 0x19; }
  /**
   * The ceiling of the ten levels of episode one (`vgaCeiling` of the
   * original, the first ten entries).
   */
  static get CEILINGCOLOR() { return [0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0xbf]; }
  /** how much a shape is fudged towards the viewer so it clears a wall */
  static get ACTORSIZE() { return 0x4000; }
  /** at most this many things are drawn in one frame */
  static get MAXVISABLE() { return 50; }

  /**
   * @param {WolfTables} tables - The sines, tangents and scalers.
   * @param {WolfAssets} assets - The textures and sprites.
   * @param {WolfWorld} world - The level being played.
   */
  constructor(tables, assets, world) {
    this.id = 'WolfRender';
    this.tables = tables;
    this.assets = assets;
    this.world = world;

    this.viewWidth = tables.viewWidth;
    this.viewHeight = tables.viewHeight;
    /** how tall the wall is in each column, three fractional bits */
    this.wallheight = new Int32Array(this.viewWidth);
    /**
     * What each column is looking at, for the tools: which tile, which side
     * of it (0 a horizontal edge, 1 a vertical one, 2 a door, 3 a moving
     * wall), and which column of which texture. These are written as the
     * frame is drawn and cost nothing; `matchcolumns` compares them.
     */
    this.wallTile = new Int32Array(this.viewWidth);
    this.wallSide = new Int32Array(this.viewWidth);
    this.wallTexture = new Int32Array(this.viewWidth);
    this.wallPage = new Int32Array(this.viewWidth);
    /** which columns are the first of a batched post - the ones whose
        height was computed rather than copied from the column before */
    this.postStarts = new Uint8Array(this.viewWidth);

    // where the view is looking from, set up once a frame
    this.viewx = 0;
    this.viewy = 0;
    this.viewangle = 0;
    this.viewsin = 0;
    this.viewcos = 0;
    this.midangle = 0;
    this.focaltx = 0;
    this.focalty = 0;
    this.viewtx = 0;
    this.viewty = 0;
    this.xpartialup = 0;
    this.xpartialdown = 0;
    this.ypartialup = 0;
    this.ypartialdown = 0;

    // the state of one ray
    this.pixx = 0;
    this.xtile = 0;
    this.ytile = 0;
    this.xtilestep = 0;
    this.ytilestep = 0;
    this.xintercept = 0;
    this.yintercept = 0;
    this.xstep = 0;
    this.ystep = 0;
    this.tilehit = 0;

    // the post being batched
    this.lastside = -1;
    this.lastintercept = 0;
    this.lasttilehit = 0;
    this.postx = 0;
    this.postwidth = 0;
    this.postsource = 0;
    this.postpage = 0;

    /** which texture a wall number shows on each of its two sides */
    this.horizwall = new Int32Array(64);
    this.vertwall = new Int32Array(64);
    for (var i = 1; i < 64; i++) {
      this.horizwall[i] = (i - 1) * 2;
      this.vertwall[i] = (i - 1) * 2 + 1;
    }

    /** where the frame is drawn */
    this.screen = null;
  } // constructor

  // ------------------------------------------------------------- the frame

  /**
   * `ThreeDRefresh`: one whole frame of the game - the ceiling and floor,
   * the walls, the things, and the weapon in the player's hands.
   * @param {VGAVideoRAM} screen - The 320 x 200 memory to draw into.
   * @param {Object} player - The player object; his `x`, `y` and `angle`.
   * @param {Array} actors - The actors, player first.
   * @param {number} level - Which level, for the colour of the ceiling.
   * @param {Object} gamestate - For the weapon and the victory sequence.
   */
  refresh(screen, player, actors, level, gamestate) {
    this.screen = screen;
    this.world.spotvis.fill(0);
    this.clearScreen(level);
    this.wallRefresh(player);
    this.drawScaleds(player, actors);
    this.drawPlayerWeapon(gamestate);
  } // refresh

  /** `VGAClearScreen`: the ceiling over the top half, the floor under it. */
  clearScreen(level) {
    var ceiling = WolfRender.CEILINGCOLOR[level % WolfRender.CEILINGCOLOR.length];
    var half = this.viewHeight >> 1;
    this.screen.fillRect(0, 0, this.viewWidth, half, ceiling);
    this.screen.fillRect(0, half, this.viewWidth, this.viewHeight - half, WolfRender.FLOORCOLOR);
  } // clearScreen

  /**
   * `WallRefresh`: the point of view is not the player - it sits
   * `focallength` behind him, so that the projection plane can be at his
   * own position.
   */
  wallRefresh(player) {
    var tables = this.tables;
    this.viewangle = player.angle;
    this.midangle = this.viewangle * (WolfFixed.FINEANGLES / WolfFixed.ANGLES);
    this.viewsin = tables.sin(this.viewangle);
    this.viewcos = tables.cos(this.viewangle);
    this.viewx = player.x - WolfFixed.byFrac(tables.focalLength, this.viewcos);
    this.viewy = player.y + WolfFixed.byFrac(tables.focalLength, this.viewsin);

    this.focaltx = this.viewx >> 16;
    this.focalty = this.viewy >> 16;
    this.viewtx = player.x >> 16;
    this.viewty = player.y >> 16;

    this.xpartialdown = this.viewx & (WolfFixed.TILEGLOBAL - 1);
    this.xpartialup = WolfFixed.TILEGLOBAL - this.xpartialdown;
    this.ypartialdown = this.viewy & (WolfFixed.TILEGLOBAL - 1);
    this.ypartialup = WolfFixed.TILEGLOBAL - this.ypartialdown;

    this.lastside = -1;
    this.postStarts.fill(0);
    this.asmRefresh();
    this.scalePost();            // the last post has nothing to batch with
  } // wallRefresh

  // -------------------------------------------------------- the ray caster

  /**
   * `AsmRefresh`: the ray of every column, cast until it hits something.
   *
   * The walk alternates between the two kinds of crossing - the vertical
   * tile edges and the horizontal ones - and always takes the one the ray
   * reaches first, which is what the two comparisons at the top of each
   * loop decide.
   */
  asmRefresh() {
    var world = this.world;
    var tables = this.tables;
    var tilemap = world.tilemap;
    var spotvis = world.spotvis;
    var fine = WolfFixed.FINEANGLES;

    for (this.pixx = 0; this.pixx < this.viewWidth; this.pixx++) {
      var angle = this.midangle + tables.pixelangle[this.pixx];
      if (angle < 0) angle += fine;
      if (angle >= fine) angle -= fine;

      var xpartial;
      var ypartial;
      if (angle < 900) {
        this.xtilestep = 1;
        this.ytilestep = -1;
        this.xstep = tables.finetangent[900 - 1 - angle];
        this.ystep = -tables.finetangent[angle];
        xpartial = this.xpartialup;
        ypartial = this.ypartialdown;
      } else if (angle < 1800) {
        this.xtilestep = -1;
        this.ytilestep = -1;
        this.xstep = -tables.finetangent[angle - 900];
        this.ystep = -tables.finetangent[1800 - 1 - angle];
        xpartial = this.xpartialdown;
        ypartial = this.ypartialdown;
      } else if (angle < 2700) {
        this.xtilestep = -1;
        this.ytilestep = 1;
        this.xstep = -tables.finetangent[2700 - 1 - angle];
        this.ystep = tables.finetangent[angle - 1800];
        xpartial = this.xpartialdown;
        ypartial = this.ypartialup;
      } else {
        this.xtilestep = 1;
        this.ytilestep = 1;
        this.xstep = tables.finetangent[angle - 2700];
        this.ystep = tables.finetangent[3600 - 1 - angle];
        xpartial = this.xpartialup;
        ypartial = this.ypartialup;
      }

      this.yintercept = WolfFixed.byPartial(this.ystep, xpartial) + this.viewy;
      this.xtile = this.focaltx + this.xtilestep;
      var xspot = (this.xtile << 6) + (this.yintercept >> 16);
      this.xintercept = WolfFixed.byPartial(this.xstep, ypartial) + this.viewx;
      this.ytile = this.focalty + this.ytilestep;
      var yspot = ((this.xintercept >> 16) << 6) + this.ytile;

      // the walk itself: `vertical` says which of the two crossings is next
      var vertical = true;
      for (;;) {
        if (vertical) {
          if ((this.ytilestep === -1 && (this.yintercept >> 16) <= this.ytile) ||
              (this.ytilestep === 1 && (this.yintercept >> 16) >= this.ytile)) {
            vertical = false;
            continue;
          }
          if (xspot < 0 || xspot >= tilemap.length) break;
          this.tilehit = tilemap[xspot];
          if (this.tilehit) {
            if (this.hitVertical()) break;
          }
          spotvis[xspot] = 1;
          this.xtile += this.xtilestep;
          this.yintercept += this.ystep;
          xspot = (this.xtile << 6) + (this.yintercept >> 16);
        } else {
          if ((this.xtilestep === -1 && (this.xintercept >> 16) <= this.xtile) ||
              (this.xtilestep === 1 && (this.xintercept >> 16) >= this.xtile)) {
            vertical = true;
            continue;
          }
          if (yspot < 0 || yspot >= tilemap.length) break;
          this.tilehit = tilemap[yspot];
          if (this.tilehit) {
            if (this.hitHorizontal()) break;
          }
          spotvis[yspot] = 1;
          this.ytile += this.ytilestep;
          this.xintercept += this.xstep;
          yspot = ((this.xintercept >> 16) << 6) + this.ytile;
        }
      }
    }
  } // asmRefresh

  /**
   * The ray crossed a vertical edge into something. Returns whether that
   * was the end of the ray; a door the ray passes beside is not.
   */
  hitVertical() {
    var tile = this.tilehit;
    if (tile & 0x80) {
      if (tile & 0x40) {
        // a secret wall on the move: push the crossing along the ray by how
        // far the wall has slid, and only count it if it is still in the tile
        var slid = this.sixtyFourths(this.ystep, this.world.pwallpos);
        var yintbuf = this.yintercept + slid;
        if ((yintbuf >> 16) !== (this.yintercept >> 16)) return false;
        this.yintercept = yintbuf;
        this.xintercept = this.xtile << 16;
        this.hitVertPWall();
        return true;
      }
      // a door: half a step gets to the middle of the tile, where the door is
      var half = this.ystep >> 1;
      var middle = this.yintercept + half;
      if ((middle >> 16) !== (this.yintercept >> 16)) return false;
      if ((middle & 0xffff) < this.world.doorposition[tile & 0x7f]) return false;
      this.yintercept = middle;
      this.xintercept = (this.xtile << 16) | 0x8000;
      this.ytile = this.yintercept >> 16;
      this.hitVertDoor();
      return true;
    }
    this.xintercept = this.xtile << 16;
    this.ytile = this.yintercept >> 16;
    this.hitVertWall();
    return true;
  } // hitVertical

  /** The same for a horizontal edge. */
  hitHorizontal() {
    var tile = this.tilehit;
    if (tile & 0x80) {
      if (tile & 0x40) {
        var slid = this.sixtyFourths(this.xstep, this.world.pwallpos);
        var xintbuf = this.xintercept + slid;
        if ((xintbuf >> 16) !== (this.xintercept >> 16)) return false;
        this.xintercept = xintbuf;
        this.yintercept = this.ytile << 16;
        this.hitHorizPWall();
        return true;
      }
      var half = this.xstep >> 1;
      var middle = this.xintercept + half;
      if ((middle >> 16) !== (this.xintercept >> 16)) return false;
      if ((middle & 0xffff) < this.world.doorposition[tile & 0x7f]) return false;
      this.xintercept = middle;
      this.yintercept = (this.ytile << 16) | 0x8000;
      this.xtile = this.xintercept >> 16;
      this.hitHorizDoor();
      return true;
    }
    this.yintercept = this.ytile << 16;
    this.xtile = this.xintercept >> 16;
    this.hitHorizWall();
    return true;
  } // hitHorizontal

  /**
   * A step times `pwallpos`/64, the way the original does it: multiply by
   * 0..63 and shift six times, with the sign kept out of it.
   */
  sixtyFourths(step, position) {
    var negative = step < 0;
    var value = negative ? -step : step;
    var result = Math.floor((value * position) / 64);
    return negative ? -result : result;
  } // sixtyFourths

  /**
   * `CalcHeight`: how tall the wall at the crossing is. The distance that
   * counts is the one along the view direction, not the ray - that is what
   * keeps a flat wall flat instead of bowing it towards the edges.
   * @returns {number} The height, with three fractional bits.
   */
  calcHeight() {
    var gx = this.xintercept - this.viewx;
    var gxt = WolfFixed.byFrac(gx, this.viewcos);
    var gy = this.yintercept - this.viewy;
    var gyt = WolfFixed.byFrac(gy, this.viewsin);
    var nx = gxt - gyt;
    if (nx < WolfFixed.MINDIST) nx = WolfFixed.MINDIST;
    // a 32 by 16 bit divide, and the quotient is a 16 bit register
    var height = Math.trunc(this.tables.heightNumerator / (nx >> 8));
    return WolfFixed.int16(height);
  } // calcHeight

  // -------------------------------------------------------- the wall posts

  /**
   * The wall the ray met, on a vertical edge. Which texture column it is
   * comes straight out of where the ray crossed; which of the two pictures
   * of the wall depends on the side, and a tile next to a door shows the
   * jamb instead.
   */
  hitVertWall() {
    var texture = (this.yintercept >> 4) & 0xfc0;
    this.wallTile[this.pixx] = this.tilehit & 63;
    this.wallSide[this.pixx] = 1;
    if (this.xtilestep === -1) {
      texture = 0xfc0 - texture;
      this.xintercept += WolfFixed.TILEGLOBAL;
    }
    this.wallheight[this.pixx] = this.calcHeight();

    if (this.lastside === 1 && this.lastintercept === this.xtile && this.lasttilehit === this.tilehit) {
      if (texture === this.postsource) {
        this.postwidth++;
        this.wallheight[this.pixx] = this.wallheight[this.pixx - 1];
        this.wallTexture[this.pixx] = texture >> 6;
        this.wallPage[this.pixx] = this.postpage;
        return;
      }
      this.scalePost();
      this.postsource = texture;
      this.postwidth = 1;
      this.postx = this.pixx;
      this.wallTexture[this.pixx] = texture >> 6;
      this.wallPage[this.pixx] = this.postpage;
      return;
    }
    if (this.lastside !== -1) this.scalePost();
    this.lastside = 1;
    this.lastintercept = this.xtile;
    this.lasttilehit = this.tilehit;
    this.postx = this.pixx;
    this.postwidth = 1;

    var page;
    if (this.tilehit & 0x40) {
      var ytile = this.yintercept >> 16;
      page = (this.world.tileAt(this.xtile - this.xtilestep, ytile) & 0x80)
        ? WolfRender.DOORWALL + 3 : this.vertwall[this.tilehit & ~0x40];
    } else {
      page = this.vertwall[this.tilehit];
    }
    this.postpage = page;
    this.postsource = texture;
    this.wallTexture[this.pixx] = texture >> 6;
    this.wallPage[this.pixx] = page;
  } // hitVertWall

  /** The same on a horizontal edge. */
  hitHorizWall() {
    var texture = (this.xintercept >> 4) & 0xfc0;
    this.wallTile[this.pixx] = this.tilehit & 63;
    this.wallSide[this.pixx] = 0;
    if (this.ytilestep === -1) this.yintercept += WolfFixed.TILEGLOBAL;
    else texture = 0xfc0 - texture;
    this.wallheight[this.pixx] = this.calcHeight();

    if (this.lastside === 0 && this.lastintercept === this.ytile && this.lasttilehit === this.tilehit) {
      if (texture === this.postsource) {
        this.postwidth++;
        this.wallheight[this.pixx] = this.wallheight[this.pixx - 1];
        this.wallTexture[this.pixx] = texture >> 6;
        this.wallPage[this.pixx] = this.postpage;
        return;
      }
      this.scalePost();
      this.postsource = texture;
      this.postwidth = 1;
      this.postx = this.pixx;
      this.wallTexture[this.pixx] = texture >> 6;
      this.wallPage[this.pixx] = this.postpage;
      return;
    }
    if (this.lastside !== -1) this.scalePost();
    this.lastside = 0;
    this.lastintercept = this.ytile;
    this.lasttilehit = this.tilehit;
    this.postx = this.pixx;
    this.postwidth = 1;

    var page;
    if (this.tilehit & 0x40) {
      var xtile = this.xintercept >> 16;
      page = (this.world.tileAt(xtile, this.ytile - this.ytilestep) & 0x80)
        ? WolfRender.DOORWALL + 2 : this.horizwall[this.tilehit & ~0x40];
    } else {
      page = this.horizwall[this.tilehit];
    }
    this.postpage = page;
    this.postsource = texture;
    this.wallTexture[this.pixx] = texture >> 6;
    this.wallPage[this.pixx] = page;
  } // hitHorizWall

  /** A door, seen from the side the ray came from. */
  hitVertDoor() {
    this.hitDoor((this.yintercept - this.world.doorposition[this.tilehit & 0x7f]) >> 4 & 0xfc0, 1);
  } // hitVertDoor

  hitHorizDoor() {
    this.hitDoor((this.xintercept - this.world.doorposition[this.tilehit & 0x7f]) >> 4 & 0xfc0, 0);
  } // hitHorizDoor

  /**
   * Both doors, which differ only in which of the two door pages they use:
   * a plain door, a locked one or the lift, and the vertical one is the
   * page after the horizontal one.
   * @param {number} texture - The texture column, already worked out.
   * @param {number} vertical - 1 for a door in a wall running north-south.
   */
  hitDoor(texture, vertical) {
    this.wallheight[this.pixx] = this.calcHeight();
    this.wallTile[this.pixx] = this.tilehit;
    this.wallSide[this.pixx] = 2;
    if (this.lasttilehit === this.tilehit) {
      if (texture === this.postsource) {
        this.postwidth++;
        this.wallheight[this.pixx] = this.wallheight[this.pixx - 1];
        this.wallTexture[this.pixx] = texture >> 6;
        this.wallPage[this.pixx] = this.postpage;
        return;
      }
      this.scalePost();
      this.postsource = texture;
      this.postwidth = 1;
      this.postx = this.pixx;
      this.wallTexture[this.pixx] = texture >> 6;
      this.wallPage[this.pixx] = this.postpage;
      return;
    }
    if (this.lastside !== -1) this.scalePost();
    this.lastside = 2;
    this.lasttilehit = this.tilehit;
    this.postx = this.pixx;
    this.postwidth = 1;

    var lock = this.world.doors[this.tilehit & 0x7f].lock;
    var page = WolfRender.DOORWALL;
    if (lock >= WolfWorld.LOCK.LOCK1 && lock <= WolfWorld.LOCK.LOCK4) page = WolfRender.DOORWALL + 6;
    else if (lock === WolfWorld.LOCK.ELEVATOR) page = WolfRender.DOORWALL + 4;
    this.postpage = page + vertical;
    this.postsource = texture;
    this.wallTexture[this.pixx] = texture >> 6;
    this.wallPage[this.pixx] = this.postpage;
  } // hitDoor

  /** A secret wall in motion, met on a horizontal edge. */
  hitHorizPWall() {
    var texture = (this.xintercept >> 4) & 0xfc0;
    var offset = this.world.pwallpos << 10;
    if (this.ytilestep === -1) this.yintercept += WolfFixed.TILEGLOBAL - offset;
    else {
      texture = 0xfc0 - texture;
      this.yintercept += offset;
    }
    this.pWall(texture, this.horizwall[this.tilehit & 63]);
  } // hitHorizPWall

  /** And on a vertical one. */
  hitVertPWall() {
    var texture = (this.yintercept >> 4) & 0xfc0;
    var offset = this.world.pwallpos << 10;
    if (this.xtilestep === -1) {
      texture = 0xfc0 - texture;
      this.xintercept += WolfFixed.TILEGLOBAL - offset;
    } else {
      this.xintercept += offset;
    }
    this.pWall(texture, this.vertwall[this.tilehit & 63]);
  } // pWall

  /** What both of them do with the post once the texture is known. */
  pWall(texture, page) {
    this.wallheight[this.pixx] = this.calcHeight();
    this.wallTile[this.pixx] = this.tilehit & 63;
    this.wallSide[this.pixx] = 3;
    if (this.lasttilehit === this.tilehit) {
      if (texture === this.postsource) {
        this.postwidth++;
        this.wallheight[this.pixx] = this.wallheight[this.pixx - 1];
        this.wallTexture[this.pixx] = texture >> 6;
        this.wallPage[this.pixx] = this.postpage;
        return;
      }
      this.scalePost();
      this.postsource = texture;
      this.postwidth = 1;
      this.postx = this.pixx;
      this.wallTexture[this.pixx] = texture >> 6;
      this.wallPage[this.pixx] = this.postpage;
      return;
    }
    if (this.lastside !== -1) this.scalePost();
    this.lastside = 3;
    this.lasttilehit = this.tilehit;
    this.postx = this.pixx;
    this.postwidth = 1;
    this.postpage = page;
    this.postsource = texture;
    this.wallTexture[this.pixx] = texture >> 6;
    this.wallPage[this.pixx] = page;
  } // pWall

  /**
   * `ScalePost`: draws the columns that have been batched up - the same
   * column of the same texture, as many pixels wide as the wall stayed the
   * same, at the height of the first of them.
   */
  scalePost() {
    if (this.lastside === -1 || this.postwidth <= 0) return;
    this.postStarts[this.postx] = 1;
    var height = this.wallheight[this.postx];
    var scale = height >> 3;
    // the original clamps the tallest posts rather than dropping them, and
    // takes the smallest scaler for anything under one
    if (scale > this.tables.maxScale) scale = this.tables.maxScale;
    if (scale < 1) scale = 1;
    var scaler = this.tables.scalers[scale];
    var texture = this.assets.wallColumn(this.postpage, this.postsource >> 6);
    if (!scaler || !texture) return;
    var screen = this.screen;
    var width = Math.min(this.postwidth, this.viewWidth - this.postx);
    var first = scaler.first;
    var lines = scaler.width;
    for (var src = 0; src < 64; src++) {
      var count = lines[src];
      if (!count) continue;
      var y = first[src];
      var color = texture[src];
      for (var line = 0; line < count; line++, y++) {
        if (y < 0) continue;
        if (y >= this.viewHeight) break;
        var at = y * 320 + this.postx;
        for (var column = 0; column < width; column++) screen.bytes[at + column] = color;
      }
    }
  } // scalePost

  // ------------------------------------------------------------- the things

  /**
   * `DrawScaleds`: everything that is not a wall - the lamps and the
   * treasure, then the actors - sorted so that the farthest is drawn first
   * and the nearest last.
   *
   * What counts as visible is not a cone but the array the ray caster just
   * filled in: a thing is drawn when a ray touched its tile, or one of the
   * eight around it that is not a wall.
   */
  drawScaleds(player, actors) {
    var world = this.world;
    var spotvis = world.spotvis;
    var tilemap = world.tilemap;
    var vislist = [];

    for (var s = 0; s < world.statics.length; s++) {
      var statobj = world.statics[s];
      if (statobj.shapenum === -1) continue;
      if (!spotvis[world.at(statobj.tilex, statobj.tiley)]) continue;
      var tile = this.transformTile(statobj.tilex, statobj.tiley);
      if (tile.close && (statobj.flags & 2)) {
        // near enough to walk into: the player picks it up instead
        if (this.onBonus) this.onBonus(statobj);
        continue;
      }
      if (!tile.height) continue;
      if (vislist.length < WolfRender.MAXVISABLE - 1) {
        vislist.push({ viewx: tile.x, viewheight: tile.height, shapenum: statobj.shapenum });
      }
    }

    for (var a = 1; a < actors.length; a++) {
      var actor = actors[a];
      var shapenum = actor.state ? actor.state.shapenum : 0;
      if (!shapenum) continue;
      var spot = (actor.tilex << 6) + actor.tiley;
      var seen = spotvis[spot] ||
        (spotvis[spot - 1] && !tilemap[spot - 1]) ||
        (spotvis[spot + 1] && !tilemap[spot + 1]) ||
        (spotvis[spot - 65] && !tilemap[spot - 65]) ||
        (spotvis[spot - 64] && !tilemap[spot - 64]) ||
        (spotvis[spot - 63] && !tilemap[spot - 63]) ||
        (spotvis[spot + 65] && !tilemap[spot + 65]) ||
        (spotvis[spot + 64] && !tilemap[spot + 64]) ||
        (spotvis[spot + 63] && !tilemap[spot + 63]);
      if (!seen) {
        actor.flags &= ~8;                     // FL_VISABLE
        continue;
      }
      actor.active = 1;
      this.transformActor(actor);
      if (!actor.viewheight) continue;
      var picture = shapenum === -1 ? actor.temp1 : shapenum;
      if (actor.state.rotate) picture += this.calcRotate(player, actor);
      if (vislist.length < WolfRender.MAXVISABLE - 1) {
        vislist.push({ viewx: actor.viewx, viewheight: actor.viewheight, shapenum: picture });
      }
      actor.flags |= 8;
    }

    // the original picks the smallest height out of the list each time
    // round rather than sorting; the order that comes out is the same
    var count = vislist.length;
    for (var i = 0; i < count; i++) {
      var least = 32000;
      var farthest = null;
      for (var v = 0; v < count; v++) {
        if (vislist[v].viewheight < least) {
          least = vislist[v].viewheight;
          farthest = vislist[v];
        }
      }
      if (!farthest) break;
      this.scaleShape(farthest.viewx, farthest.shapenum, farthest.viewheight);
      farthest.viewheight = 32000;
    }
  } // drawScaleds

  /**
   * `TransformActor`: where on the screen an actor is, and how tall.
   * @param {Object} ob - The actor; `viewx` and `viewheight` are set on it.
   */
  transformActor(ob) {
    var gx = ob.x - this.viewx;
    var gy = ob.y - this.viewy;
    var nx = WolfFixed.byFrac(gx, this.viewcos) - WolfFixed.byFrac(gy, this.viewsin) - WolfRender.ACTORSIZE;
    var ny = WolfFixed.byFrac(gy, this.viewcos) + WolfFixed.byFrac(gx, this.viewsin);
    ob.transx = nx;
    ob.transy = ny;
    if (nx < WolfFixed.MINDIST) {
      ob.viewheight = 0;
      return;
    }
    ob.viewx = this.tables.centerX + Math.trunc((ny * this.tables.scale) / nx);
    ob.viewheight = WolfFixed.int16(Math.trunc(this.tables.heightNumerator / (nx >> 8)));
  } // transformActor

  /**
   * `TransformTile`: the same for something that stands in the middle of a
   * tile, and whether the player is close enough to pick it up.
   * @returns {{x: number, height: number, close: boolean}}
   */
  transformTile(tx, ty) {
    var gx = (tx << 16) + 0x8000 - this.viewx;
    var gy = (ty << 16) + 0x8000 - this.viewy;
    var nx = WolfFixed.byFrac(gx, this.viewcos) - WolfFixed.byFrac(gy, this.viewsin) - 0x2000;
    var ny = WolfFixed.byFrac(gy, this.viewcos) + WolfFixed.byFrac(gx, this.viewsin);
    if (nx < WolfFixed.MINDIST) {
      return { x: 0, height: 0, close: false };
    }
    return {
      x: this.tables.centerX + Math.trunc((ny * this.tables.scale) / nx),
      height: WolfFixed.int16(Math.trunc(this.tables.heightNumerator / (nx >> 8))),
      close: nx < WolfFixed.TILEGLOBAL && ny > -WolfFixed.TILEGLOBAL / 2 && ny < WolfFixed.TILEGLOBAL / 2
    };
  } // transformTile

  /**
   * `CalcRotate`: which of the eight views of an actor faces us. It is not
   * exact - the original says so itself - but with only eight of them it
   * does not need to be.
   */
  calcRotate(player, ob) {
    var viewangle = player.angle + Math.trunc((this.tables.centerX - ob.viewx) / 8);
    var angle = (viewangle - 180) - WolfRender.DIRANGLE[ob.dir];
    angle += WolfFixed.ANGLES / 16;
    while (angle >= WolfFixed.ANGLES) angle -= WolfFixed.ANGLES;
    while (angle < 0) angle += WolfFixed.ANGLES;
    if (ob.state.rotate === 2) return 4 * Math.floor(angle / (WolfFixed.ANGLES / 2));
    return Math.floor(angle / (WolfFixed.ANGLES / 8));
  } // calcRotate

  /** Which way each of the eight directions points, in whole degrees. */
  static get DIRANGLE() { return [0, 45, 90, 135, 180, 225, 270, 315, 360]; }

  /**
   * `ScaleShape`: a sprite, scaled and clipped against the walls. A column
   * of the shape is drawn only where the wall behind it is further away
   * than the shape is - which is the whole of the depth sorting the engine
   * does.
   * @param {number} xcenter - Where the middle of the shape is.
   * @param {number} shapenum - Which sprite.
   * @param {number} height - Its height, three fractional bits.
   */
  scaleShape(xcenter, shapenum, height) {
    var scale = height >> 3;
    if (!scale || scale > this.tables.maxScale) return;   // too close or too far
    var scaler = this.tables.scalers[scale];
    var sprite = this.assets.sprite(shapenum);
    if (!sprite) return;
    var lines = scaler.width;
    var wallheight = this.wallheight;
    var leftpix = this.assets.spriteLeft(shapenum);
    var rightpix = this.assets.spriteRight(shapenum);

    //
    // to the left of the middle, from column 31 down to the first one the
    // shape has anything in
    //
    var slinex = xcenter;
    var slinewidth;
    for (var srcx = 31; srcx >= leftpix && slinex > 0; srcx--) {
      slinewidth = lines[srcx];
      if (!slinewidth) continue;
      if (slinewidth === 1) {
        slinex--;
        if (slinex < this.viewWidth && wallheight[slinex] < height) {
          this.scaleLine(sprite, srcx, slinex, 1, scaler);
        }
        continue;
      }
      if (slinex > this.viewWidth) {
        slinex -= slinewidth;
        slinewidth = this.viewWidth - slinex;
        if (slinewidth < 1) continue;          // still off the right edge
      } else {
        if (slinewidth > slinex) slinewidth = slinex;
        slinex -= slinewidth;
      }
      var leftvis = wallheight[slinex] < height;
      var rightvis = wallheight[slinex + slinewidth - 1] < height;
      if (leftvis) {
        if (!rightvis) {
          while (wallheight[slinex + slinewidth - 1] >= height) slinewidth--;
        }
        this.scaleLine(sprite, srcx, slinex, slinewidth, scaler);
      } else {
        if (!rightvis) continue;               // a wall covers all of it
        while (wallheight[slinex] >= height) {
          slinex++;
          slinewidth--;
        }
        this.scaleLine(sprite, srcx, slinex, slinewidth, scaler);
        break;                                 // the rest of the shape is gone
      }
    }

    //
    // and to the right
    //
    slinex = xcenter;
    slinewidth = 0;
    var start = leftpix < 31 ? 32 : leftpix;
    for (var right = start; right <= rightpix && (slinex += slinewidth) < this.viewWidth; right++) {
      slinewidth = lines[right];
      if (!slinewidth) continue;
      if (slinewidth === 1) {
        if (slinex >= 0 && wallheight[slinex] < height) {
          this.scaleLine(sprite, right, slinex, 1, scaler);
        }
        continue;
      }
      if (slinex < 0) {
        if (slinewidth <= -slinex) continue;   // still off the left edge
        slinewidth += slinex;
        slinex = 0;
      } else if (slinex + slinewidth > this.viewWidth) {
        slinewidth = this.viewWidth - slinex;
      }
      var leftSeen = wallheight[slinex] < height;
      var rightSeen = wallheight[slinex + slinewidth - 1] < height;
      if (leftSeen) {
        if (rightSeen) {
          this.scaleLine(sprite, right, slinex, slinewidth, scaler);
        } else {
          while (wallheight[slinex + slinewidth - 1] >= height) slinewidth--;
          this.scaleLine(sprite, right, slinex, slinewidth, scaler);
          break;                               // the rest of the shape is gone
        }
      } else {
        if (!rightSeen) continue;              // a wall covers all of it
        while (wallheight[slinex] >= height) {
          slinex++;
          slinewidth--;
        }
        this.scaleLine(sprite, right, slinex, slinewidth, scaler);
      }
    }
  } // scaleShape

  /**
   * One column of a sprite: the pixels that are not see-through, each
   * stretched over the lines the scaler gives it, in the screen columns the
   * wall does not cover.
   */
  scaleLine(sprite, srcx, slinex, width, scaler) {
    var screen = this.screen;
    var first = scaler.first;
    var lines = scaler.width;
    for (var src = 0; src < 64; src++) {
      var count = lines[src];
      if (!count) continue;
      var color = sprite[src * 64 + srcx];
      if (color === 0xff) continue;                 // see-through
      var y = first[src];
      for (var line = 0; line < count; line++, y++) {
        if (y < 0) continue;
        if (y >= this.viewHeight) break;
        var at = y * 320 + slinex;
        for (var column = 0; column < width; column++) screen.bytes[at + column] = color;
      }
    }
  } // scaleLine

  /**
   * `DrawPlayerWeapon`: the weapon in the player's hands, drawn with no
   * clipping at all, twice the height of the view.
   */
  drawPlayerWeapon(gamestate) {
    if (gamestate.victoryflag) return;
    if (gamestate.weapon !== -1 && gamestate.weapon !== undefined) {
      var shapenum = WolfRender.WEAPONSCALE[gamestate.weapon] + gamestate.weaponframe;
      this.simpleScaleShape(this.viewWidth >> 1, shapenum, this.viewHeight + 1);
    }
    if (gamestate.demoplayback) {
      this.simpleScaleShape(this.viewWidth >> 1, SPRITE.DEMO, this.viewHeight + 1);
    }
  } // drawPlayerWeapon

  /** The first frame of each of the four weapons. */
  static get WEAPONSCALE() {
    return [SPRITE.KNIFEREADY, SPRITE.PISTOLREADY, SPRITE.MACHINEGUNREADY, SPRITE.CHAINREADY];
  } // WEAPONSCALE

  /**
   * `SimpleScaleShape`: the weapon and the demo sign. The scaler is picked
   * by `height>>1` rather than `height>>3`, so the weapon fills the view.
   */
  simpleScaleShape(xcenter, shapenum, height) {
    var scaler = this.tables.scalers[height >> 1];
    var sprite = this.assets.sprite(shapenum);
    if (!scaler || !sprite) return;
    var screen = this.screen;
    var lines = scaler.width;

    var slinex = xcenter;
    for (var srcx = 31; srcx >= 0; srcx--) {
      var width = lines[srcx];
      if (!width) continue;
      slinex -= width;
      this.plainLine(sprite, srcx, slinex, width, scaler);
    }
    slinex = xcenter;
    var slinewidth = 0;
    for (var right = 32; right < 64; right++) {
      slinewidth = lines[right];
      if (!slinewidth) continue;
      this.plainLine(sprite, right, slinex, slinewidth, scaler);
      slinex += slinewidth;
    }
  } // simpleScaleShape

  /** A column of a sprite with no wall to hide behind it. */
  plainLine(sprite, srcx, slinex, width, scaler) {
    var screen = this.screen;
    var first = scaler.first;
    var lines = scaler.width;
    for (var src = 0; src < 64; src++) {
      var count = lines[src];
      if (!count) continue;
      var color = sprite[src * 64 + srcx];
      if (color === 0xff) continue;
      var y = first[src];
      for (var line = 0; line < count; line++, y++) {
        if (y < 0) continue;
        if (y >= this.viewHeight) break;
        for (var column = 0; column < width; column++) {
          var x = slinex + column;
          if (x < 0 || x >= this.viewWidth) continue;
          screen.bytes[y * 320 + x] = color;
        }
      }
    }
  } // plainLine

} // WolfRender
