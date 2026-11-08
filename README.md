# Wolfenstein 3D — remake na svision

Remake původní **PC/MS-DOS verze z roku 1992** (VGA 320×200, 256 barev) pro
prohlížeč, na knihovně [svision](../svision) a její VGA platformě (R-029).
Cílová edice: **shareware v1.4, epizoda 1** (10 úrovní).

**Stav: W1–W8 napsané, akceptace W3–W8 otevřená.** Hra běží: úroveň se
vykreslí vrhem paprsků, stráže chodí a střílejí, dveře a tajné stěny se
hýbou, zbraně fungují, hraje hudba (AdLib/IMF) a efekty (dvacet z nich jako
digitalizované vzorky přes DAC, jak to dělal Sound Blaster), po úrovni je
mezihra.
Čtyři záznamy dem z herních dat se přehrávají. **Co chybí, aby se milníky
daly zavřít, je záznam z běžícího originálu v DOSBoxu** — bez něj `match*`
nástroje umí porovnat jen to, co jde porovnat bez něj, a hlásí to
(`MILNIKY.md`).

## Co je kde

| | |
|---|---|
| `ZADANI.md` | co se dělá, jaká věrnost, co se vědomě nedělá, **licenční omezení** |
| `MILNIKY.md` | M0 a W1..W9 s akceptačními kritérii ve tvaru `match*` |
| `NOTES.md` | nálezy o originálu — konstanty, formáty, LZEXE, dávkování sloupců, fizzle fade |
| `sources/` | podklady: popisy formátů, cizí implementace, manuál, herní data |
| `app/` | herní kód; `app/wolf/` je engine, `app/svision` symlink na knihovnu |
| `tools/` | `mkdata` / `dumpdat` / `checkdat`, `render*` a `match*` |
| `data/` | otevřené formáty vytažené z herních dat (**necommituje se**, `data/README.md`) |
| `build/` | co vyrobí nástroje (mimo verzování) |

## Rozjet to u sebe

1. **Herní data**: shareware v1.4 (`*.WL1` + `WOLF3D.EXE`) do
   `sources/game/sw14/` — jak, je v `sources/game/README.md`.
2. **Data pro hru**: `node tools/mkdata.mjs` (asi 3 s, vyrobí `data/`).
3. **Build**: `svtool build` pustí uživatel sám (`../CLAUDE.md`).
4. Web server přes `index.php`, jako ostatní projekty.

Ke čtení zdrojáků originálu je potřeba `sources/reference/src/`
(čtyři `git clone`, návod v `sources/reference/README.md`). **Pozor: zdroják
Wolfensteina není GPL** — než se z něj začne číst, přečti si to.

## Nástroje

```
node tools/dumpdat.mjs        # kontejnery -> build/chunks/ (W1)
node tools/checkdat.mjs       # round-trip všech tří kompresí: 2 259 kontrol
node tools/mkdata.mjs         # kontejnery + WOLF3D.EXE -> data/ (W2)
node tools/mkstates.mjs       # stavové tabulky nepřátel -> app/wolf/stateTable.js
node tools/matchgfx.mjs       # data/ proti herním souborům: 684 kontrol
node tools/renderlevel.mjs --all      # půdorysy úrovní do build/*.png
node tools/matchcolumns.mjs --demo 0  # raycaster proti druhému casteru
node tools/matchframes.mjs --demo 0   # celá videoram (--record / --reference)
node tools/matchdemo.mjs              # dema tik po tiku (--record / --reference)
node tools/matchsound.mjs --wav build/adlib   # efekty AdLib (a WAV pro ucho)
node tools/matchimf.mjs               # hudba proti AUDIOT: 27 626 kontrol
node tools/checkdigi.mjs      # digitalizované zvuky a tabulka wolfdigimap: 224 kontrol
node tools/checkload.mjs      # co se stahuje při bootu a v jakém pořadí: 47 kontrol
node tools/tunechip.mjs --reference <wav> --sound OPENDOOR   # kalibrace OPL2 podle nahrávky
```

Ovladače AdLibu jsou v knihovně, takže je kontroluje i její vlastní test:
`node app/svision/tools/checkaudio.mjs` (63 kontrol, z toho 9 na efekty
a IMF).

`checkdigi` a `checkload` běží **bez herních dat z originálu** — čtou jen
`data/` a herní kód, takže jdou pustit kdykoli.

Každý `match*` končí jednou řádkou „N kontrol, M rozdílů“ a nenulovým
návratovým kódem, když našel rozdíl. Nástroje, které potřebují záznam
z DOSBoxu, to **říkají** a neprohlašují nulu za výsledek.

## Jak se to hraje

Kurzorové šipky chodí, `Ctrl` střílí, `Alt` uhýbá do stran, `Shift` běží,
mezerník otevírá, `1`–`4` volí zbraň. Navíc, dokud není zapojené menu:
`+`/`-` mění úroveň, `D` přehraje jedno ze čtyř dem, `B` nabootuje znovu.

## Buildy

**Na vývojovém serveru se nebuilduje**: servíruje se přímo `app/`, bez
service workeru, takže změna zdrojáku je vidět po reloadu. Výjimky, které
reloadem nevzniknou: `data/` (vyrábí `node tools/mkdata.mjs`) a
`config/compile.json` (jen pro build — herní worker se za běhu slepuje
z `GameModel.WORKER_SOURCES`).

Build (`svtool build`) je věc produkce a spouští ho uživatel ručně.

## ⚠ Open issue — game data (data/)

The game's data in `data/` is derived from the original and is **not in git**
(`.gitignore`): every machine generates it from the operator's copy with the
project's `dump*` tools. Before the project moves on, decide and document:

1. **Storage** — where the data lives on the server, in what format and size,
   how it is produced from the original and how its completeness and
   correctness are verified (`SHA256SUMS`, `check*`).
2. **Versioning** — how a data set is tied to the version of the game and of
   the tools that produced it, when the files themselves are not versioned
   (a manifest with hashes and the dump version).
3. **Loading** — how the game loads it (all at once or on demand, through
   `appData` or directly), and what happens when a file is missing.
4. **Caching** — the browser and the service worker (precache or on demand,
   invalidation by version); `localStorage` is only a cache of server data
   and may be wiped at any time.

Raised 2026-11-08 for every project whose data is outside git.
