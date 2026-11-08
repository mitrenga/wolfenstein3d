const { VGAPlatform } = await import('./svision/js/platform/canvas2D/vga/vgaPlatform.js?ver='+window.srcVersion);
// begin code

/**
 * The machine Wolfenstein ran on: a PC with a VGA card in mode 13h on a 4:3
 * monitor - 320x200 pixels shown 1.2 times taller than wide, and a black
 * border that never changes (R-029).
 *
 * The original ran the card unchained, with four planes and three pages, to
 * be able to flip pages; the remake draws into one linear 64 000 byte
 * memory instead. The picture is the same bytes, which is what `match*`
 * compares - the deliberate difference is written down in `ZADANI.md`
 * para 2.
 */
export function appPlatform() {
  return new VGAPlatform({
    width: 320,
    height: 200,
    pixelAspect: 1.2,
    minimalBorder: 0
  });
} // appPlatform
