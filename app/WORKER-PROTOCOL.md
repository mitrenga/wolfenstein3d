# Protokol model ↔ worker (R-007)

Worker je `app/gameWorker.js`, slepený za běhu z ES modulů
(`svision/js/moduleWorker.js`: seznam v `GameModel.WORKER_SOURCES`, tytéž
soubory v `config/compile.json` `standalone`). **Stejná třída `GameWorker` se
importuje pod Node do nástrojů** — bez časovače, snímek po snímku přes `tick`
(`tools/lib/gamelib.mjs`).

Tik = **1/70 s** (`TickBase 70`). Hra počítá pohyb z počtu tiků od minulého
snímku, takže:

| režim | kolik tiků má snímek |
|---|---|
| hraní | kolik jich uplynulo na hodinách, nejvýš 10 (`MAXTICS`) |
| přehrávání dema | vždy **4** (`DEMOTICS`) — proto je průlet opakovatelný |
| nástroje (`tick`) | co si nástroj řekne, výchozí 4 |

Obraz se posílá, jen když se změnil; `tick` v headless režimu ho pošle vždy.

## model → worker

| zpráva | význam |
|---|---|
| `{id:'init', seed}` | seed, ze kterého se nasadí index do `rndtable` (R-009). Je to **jediná entropie ve hře** — demo a nástroje ho nepoužijí, tam se index nuluje |
| `{id:'assets', palette, random, walls, sprites, pics, fonts, tile8, texts, demos, adlib, digi}` | obsah `data/*.json` tak, jak přišel ze serveru. Dekóduje se **ve workeru**, ne v hlavním vlákně: sprity samy jsou přes megabajt base64. `digi` je výjimka — **jen délky** digitalizovaných zvuků (`{rate, seconds[]}`), protože worker rozhoduje, co se hraje jako nahrávka a jak dlouho to drží DAC, ale samotné PCM (200 kB) patří zvukovému manažeru |
| `{id:'level', number, level, difficulty, demo?, headless?}` | obsah `data/levels/levelNN.json`; `difficulty` 0–3; `demo` 0–3 přehraje místo hraní záznam z dat (a přebije `number` tím, co je v záznamu). Worker postaví svět, spustí hudbu úrovně a rozjede hodiny (pokud není `headless`) |
| `{id:'controls', action, value}` | stav jedné akce: `left/right/forward/back`, `fire/strafe/run/use`, `weapon1..weapon4` |
| `{id:'ack'}` | klávesa na mezihře — panel zmizí a hra pokračuje |
| `{id:'pause'}` / `{id:'continue'}` | hodiny běží, snímky ne |
| `{id:'reset'}` | zastaví a zahodí úroveň |
| `{id:'tick', tics?}` | headless: přesně jeden snímek a `frame` zpátky |

## worker → model

| zpráva | význam |
|---|---|
| `{id:'ready', ready}` | data dorazila a hra se dá postavit |
| `{id:'frame', frame, level, vram: Uint8Array(64000), palette: Uint8Array(768), paletteVersion, sound[], state}` | celá videoram 13h a 256 registrů DAC (6bitové složky). Model volá `VGAVideoRAMEntity.restore(vram)` a `palette.load()` jen při změně `paletteVersion` — ta se mění při červeném a bílém bliknutí (`UpdatePaletteShifts`). `sound` je fronta toho, co se má rozeznít (`{sound, left, right}`, `{music}`, `{stop}`), `state` jsou počitadla pro panely |
| `{id:'levelDone', reason, level, panel, state}` | konec úrovně: `reason` je `completed`, `secretlevel`, `died` nebo `victorious`. Po dohrané úrovni worker rovnou nakreslí **mezihru** (`panel` = bonus a tři poměry) a čeká na `ack`; po smrti čeká model sám |

## Druhý worker: hudba

`app/musicWorker.js` je malý worker, který nedělá nic jiného, než že renderuje
skladby: `{id:'render', index, stream, sampleRate, gain}` → `{id:'rendered',
index, samples, …}` a vzorky se **předávají**, ne kopírují (transferable).

Je tam proto, že jedna skladba Wolfensteina je minuta čipu a **asi pět vteřin
procesoru**. Když se to renderovalo v hlavním vlákně po kouscích tak malých,
aby hra netrhala (8 ms ze 108), byla první skladba hotová za minutu a půl —
což v praxi znamenalo, že **hudba nehrála vůbec** (nahlášeno 2026-09-17).
V samostatném vlákně to stránku nestojí nic.

**Data stahuje aplikace, ne model** (`MainApp.loadData`, od 2026-09-17), a to
**už při bootu** — boot MS-DOSu trvá zhruba tak dlouho jako stažení těch 2,2 MB,
takže model, když se postaví, obvykle najde všechno hotové. Pořadí je zvolené,
ne náhodné: malé soubory (paleta, tabulky, `adlib`, `digi`, index hudby) →
**skladba té úrovně, která začíná** (40 kB před megabajty, aby ji hudební worker
stihl vyrenderovat) → grafika → úroveň → zbytek hudby. Hlídá to
`tools/checkload.mjs` (47 kontrol, bez prohlížeče).

**Tři sběrnice, ne jedna**: `sounds` pro FM efekt (hlas 0), `music` pro hudbu
(hlasy 1–8) a `digi` pro digitalizované zvuky (DAC). Na jedné sběrnici každý
efekt hudbu utnul — a originál to tak neměl, na kartě hrálo obojí zároveň
(`NOTES.md` §7).

## Co je vědomě jinak než v originálu

- **Odřetězený režim se nemodeluje** (`ZADANI.md` §2): kreslí se do lineární
  `VGAVideoRAM` 320×200, ne do čtyř plánů a tří stránek. Výsledné bajty jsou
  tytéž, a `match*` porovnává právě ty.
- **Herní worker zvuk nepočítá.** Řekne jen, co má hrát a jak hlasitě do
  každého ucha (priority a panning jsou v `app/wolf/sound.js`, což je logika
  hry). Efekty renderuje OPL2 v hlavním vlákně (`app/audioManager.js`, desítky
  ms na efekt), hudbu ten druhý worker výš,
  protože sample se stejně musí dostat do Web Audia.
- **Mezihra a fizzle fade kreslí worker**, ne model — má data a má kam
  kreslit, takže model zůstává tím, čím je: oknem na videoram.
