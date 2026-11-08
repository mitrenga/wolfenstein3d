# Wolfenstein 3D — nálezy

Co je o hře zjištěné a čím je to doložené. `★` = ověřeno na datech nebo
ve zdrojovém kódu originálu; bez hvězdičky = zdroj z druhé ruky, čeká na
ověření. Rozhodnutí patří do `ZADANI.md`, postup do `MILNIKY.md`.

Autorita: **běžící originál v DOSBoxu** > zdrojáky id > porty > popisy
formátů. Licenční omezení práce se zdrojáky: `sources/reference/README.md`.

## 1. Konstanty enginu ★

Vypsané 2026-09-16 ze zdrojáků id (`WOLFSRC/WL_DEF.H`, `ID_SD.H`, `ID_VL.C`,
`ID_US_A.ASM`).

| konstanta | hodnota | co to je |
|---|---|---|
| `GLOBAL1` / `TILEGLOBAL` | `1<<16` | jedna dlaždice v globálních jednotkách |
| `TILESHIFT` | 16 | pevná čárka 16.16 |
| `PIXGLOBAL` | `GLOBAL1/64` | jeden pixel textury |
| `MAPSIZE` | 64 | mapa je 64×64 dlaždic |
| `MINDIST` | `0x5800` | nejmenší vzdálenost od stěny = poloměr hráče (`PLAYERSIZE`) |
| `MINACTORDIST` | `0x10000` | nejmenší vzdálenost středů hráče a postavy |
| `PIXRADIUS` | 512 | poloměr pro zásahy |
| `ANGLES` / `FINEANGLES` | 360 / 3600 | hrubé a jemné dělení kruhu |
| `MAXVIEWWIDTH` | 320 | sloupců pohledu |
| `MAXSCALEHEIGHT` | 256 | největší škálování |
| `HEIGHTRATIO` | 0.50 | poměr výšky stěny |
| `STATUSLINES` | 40 | stavový řádek dole; herní okno tedy max. 320×160 |
| `SCREENBWIDE` | 80 | šířka stránky v bajtech (odřetězený režim: 80×4 = 320 px) |
| `SCREENSIZE` | `80*208` = 16 640 | jedna videostránka; jsou **tři** (`PAGE1..3START`) |
| `TickBase` | 70 | přerušení za sekundu = tik hry |
| `BORDERCOLOR` / `FLASHCOLOR` / `FLASHTICS` | 3 / 5 / 4 | okraj a bliknutí |
| `STARTAMMO` | 8 | náboje na začátku |

**Grafický režim ★**: `ID_VL.C` přepne `mov ax,0x13`, pak kartu **odřetězí** —
`SC_MAPMASK` přes čtyři plány, adresace `bufferofs + ylookup[y] + (x>>2)`,
kopie textur přes latche (`VL_MemToLatch`, `VL_LatchToScreen`), tři stránky
a page flipping. Remake to nemodeluje (`ZADANI.md` §2).

**Náhoda ★**: `rndtable` je 256 bajtů v `ID_US_A.ASM` (začíná
`0, 8, 109, 220, 222, 241, 149, 107, …`) plus `rndindex`; `US_InitRndT(false)`
index vynuluje, `true` ho nasadí z času. Splňuje R-009 bez vlastního PRNG:
entropie je jen v počátečním indexu.

**Zvuk ★**: Sound Blaster jede na **7 000 Hz** (`ID_SD.C`:
`timevalue = 256 - 1000000/7000`). Tři nezávislé cesty: `SoundMode`
(PC speaker / AdLib), `DigiMode` (SB / Sound Source / PC), hudba OPL.

**Dema ★**: `WL_GAME.C:PlayDemo` bere záznam jako **chunk VGAGRAPH**
(`T_DEMO0..3`). Je to posloupnost vstupů, ne obrázků — opakovatelný průlet.
W1 našel v datech **8 externích chunků** (148–155); které z nich jsou dema
a které texty, se rozhodne, až se budou přehrávat (W5).

## 2. Datové soubory ★

Ověřeno 2026-09-16 na `sources/game/sw14/` (shareware v1.4) jednorázovým
skriptem.

- **`MAPHEAD.WL1`** (402 B): `UInt16` RLEW tag = **`ABCD`**, pak **100
  `UInt32` offsetů** do GAMEMAPS; neprázdných je **10** — epizoda 1 (9 + tajná).
- **`GAMEMAPS.WL1`** (27 425 B): začíná řetězcem **`TED5v1.0`** (editor, ve
  kterém mapy vznikly). Hlavička úrovně je **38 B** (3× `UInt32` offset
  plánu, 3× `UInt16` délka, šířka a výška **64×64**, 16 B jméno) a za ní
  **`!ID!`**, které do hlavičky nepatří, ale odlišuje v1.1+ od v1.0 — na
  disku tedy 42 B. Jména jsou `Wolf1 Map1`…`Wolf1 Map8`, `Wolf1 Boss`,
  `Wolf1 Secret` ★. Plány: 0 = stěny a dveře, 1 = objekty a nepřátelé,
  2 = nevyužitý (délka 10 B ve všech úrovních). Rozbalený plán = **8 192 B**
  (64×64 slov).
- **`VSWAP.WL1`** (742 912 B): hlavička `UInt16` **663 chunků**, první sprite
  **106**, první zvuk **542**; pak `UInt32` offsety a `UInt16` délky. Stěna =
  **4 096 B** nekomprimovaně, pixely **po sloupcích**. Sprity komprimované
  posty (první/poslední neprázdný sloupec, offsety, dvojice hranic řádků).
  Zvuky jsou syrové **u8 @ 7 000 Hz**.
- **`VGAHEAD.WL1`** (471 B) = 157 tříbajtových offsetů, tedy **156 chunků**
  (poslední offset jen ukončuje ten předchozí);
  **`VGADICT.WL1`** přesně **1 024 B** = **255 uzlů** huffmanovy tabulky
  po 4 B (1 020 B) a 4 B výplně ★;
  `VGAGRAPH.WL1` (326 568 B) drží obrázky, fonty, texty a dema. První chunk
  (`STRUCTPIC`) nese rozměry obrázků.
- **`AUDIOHED.WL1`** (1 156 B) = **288 položek** (289 offsetů) do
  `AUDIOT.WL1` (132 613 B): pásma PC speaker, AdLib, hudba IMF.

Komprese jsou tři: **RLEW** (slovní RLE s tagem), **Carmack** (near `0xA7` /
far `0xA8` ukazatele nad slovy) a **huffman** (VGAGRAPH). Mapy cílové edice
(v1.4) jsou **carmackizované** — potřeba obě vrstvy. (v1.0 měla mapy jen
RLEW, ale ta se nedělá, `ZADANI.md` §5.)

## 3. Kontejnery — co změřilo W1 ★

Všechno v této sekci je odvozené z dat `sources/game/sw14/` nástroji
`tools/dumpdat.mjs` a `tools/checkdat.mjs`, ne opsané z hlavičky jiného
vydání. Hlavičky id (`GFXV_WL1.H`, `AUDIOWL1.H`) totiž popisují **jinou
shareware verzi než v1.4** a jejich čísla nesedí — `NUMCHUNKS 556`,
`NUMSNDCHUNKS 234` proti 156 a 288 v datech. Proto se layout odvozuje
z dat a hlavičky slouží nejvýš jako hypotéza.

**VGAGRAPH ★** — 156 chunků: chunk 0 je `STRUCTPIC` (tabulka rozměrů,
**144 obrázků**), pak 2 fonty, obrázky od chunku **3**, jediný chunk
**tile8** na **147** a **8 externů** (148–155, mezi nimi texty a záznamy
dem). Kotva je tabulka obrázků: chunk obrázku *i* hlásí rozbalenou velikost
přesně `šířka × výška`, takže se běh obrázků v datech dá najít a ověřit.

**tile8 nemá uloženou velikost ★** — a **není 72 dlaždic jako WL6, ale 35**
(2 240 B po 64 B). Odvozeno z bitů: dopočítá se, ve kterém okamžiku
huffmanův proud končí v posledním bajtu chunku, a jediná taková délka, která
je celým násobkem 64, je 2 240. Uložená `INT32` velikost je u tohohle chunku
záporná (data, ne délka) — právě tím se pozná.

**VSWAP ★** — 663 chunků, ale shareware jich má naplněnou jen část: **64
stěn** ze 106, **226 spritů** ze 436, **20 zvuků** ze 46 v tabulce.
Tabulka digitalizovaných zvuků je v **posledním chunku** (46 dvojic
stránka/délka) a je **celá z registrované verze** — u chybějících zvuků
ukazuje na stránky nulové délky. Že je čtení správné, potvrzuje součet:
20 přítomných zvuků si nárokuje **45 stránek** a VSWAP jich má neprázdných
přesně **45**.

**Offset postu spritu je znaménkový ★** — `INT16`, ne `UINT16`: sloupec,
jehož pixely leží před jeho vlastním seznamem postů, sahá zpátky.
S `UINT16` to spadne hned na prvním spritu. Formát dovoluje číst pixely
dvěma způsoby (přes offset postu, nebo popořadě za seznamy postů); na všech
226 spritech dávají **týž obrázek**, takže ani jeden výklad není náhoda.

**AUDIOT ★** — 288 chunků ve čtyřech pásmech: **87 efektů** PC speaker
(0–86), 87 AdLib (87–173), digitalizované prázdné (174–260) a **27 skladeb
od 261**. To je layout `AUDIOWL6.H` (87 / 261), ne `AUDIOWL1.H` (69 / 207).
Poslední chunk prázdného pásma (260) není prázdný — jsou v něm 4 bajty
`!ID!`, značka, kterou MUSE psal na konec každého pásma. Skladeb má data
jen **11** (`CORNER`, `WARMARCH`, `GETTHEM`, `NAZI_NOR`, `POW`, `SEARCHN`,
`SUSPENSE`, `WONDERIN`, `ENDLEVEL`, `ROSTER`, `URAHERO` — 643 s, 27 604
zápisů do registrů); ostatních 16 je jen 88bajtový záznam MUSE se jménem.

**Efekty PC speaker mají na konci jméno ★** — ne jen délku, prioritu, data
a nulový bajt, jak píše HiPhish, ale za ním ještě jméno ukončené nulou,
stejně jako efekty AdLib. Chunky jsou o ty bajty delší, než by vycházelo.

**Naše balení je řádově stejně dobré jako id ★** — mapy 26 841 B proti
26 994 B originálu (99,4 %), VGAGRAPH 327 152 proti 326 568 (100,2 %). Není
to kritérium (kompresorů je nekonečně, dekompresor jediný), ale výrazný
rozdíl by znamenal, že je formát pochopený jen napůl.

## 4. Program: `WOLF3D.EXE` ★

Ověřeno 2026-09-17 nástroji `tools/lib/lzexe.mjs` a `tools/lib/exeTables.mjs`.

**`WOLF3D.EXE` je zabalený LZEXE 0.91 ★** — 109 959 B na disku, 287 040 B
v paměti. Pozná se podle `LZ91` na offsetu 0x1C (tam, kde by u nezabaleného
programu začínala relokační tabulka, která u zabaleného není). Za obrazem
sedí rozbalovač a před ním šestnáct bajtů, které říkají, co udělá: původní
`ip`, `cs`, `sp`, `ss`, velikost zabaleného obrazu (6 695 paragrafů), o kolik
naroste (11 264), délka rozbalovače (2 807 B) a kontrolní součet.

**Bitový proud se čte dopředu, ale slovo bitů se nabírá „o token dřív“ ★.**
Tohle je jediná věc, kterou nešlo uhodnout a musela se přečíst z rozbalovače
(disassembly `objdump -b binary -m i8086`): čítač bitů se testuje **hned po
spotřebování bitu**, a když dojde na nulu, načte se další slovo — **dřív, než
se přečte bajt tokenu, který ten poslední bit použil**. Pořadí „nejdřív bajt,
pak doplnit bity“, ke kterému člověk sáhne jako k prvnímu, rozbalí prvních
24 bajtů správně a pak se rozejde. Formát tokenů: `1` = literál,
`0 0 ll b` = 2–5 bajtů z 1–256 zpět, `0 1 <dva bajty>` = až 8 192 zpět,
délka v dolních třech bitech druhého bajtu, nula tam znamená délku ve vlastním
bajtu (0 konec, 1 změna segmentu).

**Paleta je na 0x3A68A rozbaleného obrazu ★, `rndtable` na 0x209F2 ★.** Obě se
ale nehledají podle adresy, ale podle obsahu (`exeTables.mjs`): paleta je
jediných 768 bajtů, kde nic nepřesahuje 63 a začátek je šestnáct barev EGA;
`rndtable` je jediné místo, které začíná `0, 8, 109, 220, 222, 241, 149, 107`
a má v sobě 166 různých hodnot. Adresa platí pro tuhle jednu edici, obsah pro
každou.

**`sintable` nikdy nedosáhne jedničky ★** — `cos(0)` je 65 535, ne 65 536.
Vypadá to jako chyba a je to zásadní: násobička originálu bere z čísla jen
dolní slovo, takže hodnota 0x10000 by znamenala **nulový pohyb**. Že k ní
tabulka nedojde, je důsledek toho, jak se staví: úhel se sčítá v 32bitovém
`float` a `PI` je v `WL_DEF.H` napsané jako `3.141592657`. Remake to dělá
stejně (`Math.fround` a totéž PI), jinak by hráč při pohledu přesně na východ
stál na místě.

## 5. Obraz: co drží pixely na místě ★

**Obrázky VGAGRAPH jsou rozložené do čtyř plánů karty ★** — plán 0 jsou
pixely, jejichž `x` je násobek čtyř, a tak dál; každý plán je čtvrtina šířky.
`VL_MemToScreen` je kopíruje po plánech s maskou. Kdo chunk přečte popořadě,
uvidí čtyři úzké kopie obrázku vedle sebe. Totéž platí pro `tile8`.

**Sloupce se dávkují a výška se kopíruje ★** — dokud paprsek trefuje tutéž
stěnu ve stejném sloupci textury, sdílí sloupce **výšku prvního z nich**
(`HitVertWall`: `wallheight[pixx] = wallheight[pixx-1]`). Není to jen
zrychlení: `wallheight[]` je pole, podle kterého se ořezávají sprity, takže
dávkování je vidět na obraze a `match*` ho musí reprodukovat.

**Dveře jsou půl kroku dovnitř ★** — paprsek, který narazí na dlaždici dveří,
se posune o půl kroku dál a započítá se, jen když je pořád v téže dlaždici
a za náběžnou hranou dveří (`doorposition`). Proto je vidět skrz otevřené
dveře a proto se do zárubně dá nakouknout.

**Škálování je tabulka na výšku ★** — pro každou výšku (po dvou pixelech, až
`viewwidth*1.5/2`) se dopředu spočítá, který ze 64 řádků textury padne na
který řádek obrazovky: `step = height*65536/64`, `top = (viewheight-height)/2`.
Sloupec stěny i sprite používají tutéž tabulku, jen index se bere jinak:
stěna a postava `height>>3`, zbraň v ruce `height>>1`.

**Fizzle fade není náhoda ★** — je to 17bitový posuvný registr, který začíná
na 1: dolních osm bitů minus jedna je řádek, dalších devět je sloupec, krok
je posun doprava a při vypadlé jedničce `xor` s 0x12000. Projde všech 65 536
poloh a skončí zpátky na jedničce. Pořadí pixelů je tedy stejné pokaždé a na
každém stroji — dá se porovnat krok po kroku.

**Mezihra nemá font ★** — každé písmeno je vlastní obrázek (`L_APIC`…), široký
16 pixelů, u `!`, `'` a `:` osm. Proto jsou pozice v originálu v „půlznacích“
(`Write(x,y,…)` = `x*8` pixelů).

## 6. Hra: tiky, dema, náhoda ★

**Záznam dema jsou tři bajty na krok ★** (`PollControls`): stav tlačítek,
`controlx` a `controly` jako znaménkové bajty. Krok trvá **vždy `DEMOTICS` = 4
tiky**, ať stroj stíhá cokoli; `controlx`/`controly` se čtyřmi tiky násobí.
Před záznamem jsou čtyři bajty hlavičky: číslo úrovně, délka celého chunku
(slovo) a jeden bajt navíc, který nikdo nečte. Demo se hraje vždy na
`gd_hard` a s `US_InitRndT(false)`, tedy od indexu 0 — proto je opakovatelné.

**Pořadí v tiku je součást zadání ★** (`PlayLoop`): ovládání → dveře →
posuvné stěny → **`DoActor` pro každý objekt v pořadí, v jakém vznikly, hráč
první** → posun palety → obraz → `TimeCount += tics`. Každý nepřítel si
cestou bere bajty z `rndtable`, takže změna pořadí změní každou přestřelku.

**Obličej BJ si bere z `rndtable` každý snímek ★** — `UpdateFace` porovnává
`facecount` s `US_RndT()` a při změně si vezme ještě jeden bajt. Pozdější
porty (Wolf4SDL) v demu místo toho počítají snímky; jejich dema proto běží
jinak než originálu. Remake dělá to, co originál.

**Otočení si pamatuje zbytek ★** — `anglefrac += controlx`, a teprve každá
dvacátá jednotka je jeden stupeň. Bez toho by se pomalé otáčení po stovkách
tiků rozešlo.

## 7. Zvuk: AdLib a k tomu DAC ★

Remake je postavený na **Sound Blasteru**, což jsou dvě nastavení originálu,
ne jedno: `SoundMode = AdLib` (efekty z pásma AdLib v AUDIOT a hudba IMF,
obojí přes OPL2 ze svision) a `DigiMode = SoundBlaster` (dvacet efektů, které
mají ve VSWAP digitalizovanou verzi, jde přes DAC). Oba ovladače jsou od
2026-09-17 **v knihovně** (`audio/chip/adlibSound.js`, `audio/chip/adlibIMF.js`,
`../ROADMAP.md` 3.7) — jsou to formáty rodiny her id/Apogee, ne vlastnost
Wolfensteina. Ve hře zůstalo, co je její: priorita, panning a hlasitost.

**Efekt je nástroj a jeden hlas ★** — šestnáct bajtů nastaví kanál 0
(operátory 0 a 3), pak jeden bajt na 1/140 s: nula znamená pustit klávesu,
cokoli jiného se zapíše do `alFreqL` a `alFreqH` dostane blok
`((oktáva & 7) << 2) | 0x20`. **Registr zpětné vazby se zapisuje jako nula**,
ne z nástroje — originál to má okomentované jako kompatibilitu s MUSE.

**Kartu je potřeba přepnout do režimu vlnových tvarů ★** — `ID_SD.C` při
nalezení karty vynuluje všechny registry a pak zapíše `alOut(1,0x20)`, tedy
**WSE=1**. Bez toho bajt vlnového tvaru v nástroji nedělá nic a hraje se
čistý sinus. Týká se to obojího: **56 z 87 efektů** má nenulový vlnový tvar
(hodnoty 1–3, tedy usměrněné sinusovky) a **žádný proud IMF si registr 1
nezapisuje sám** — všech 11 skladeb spoléhá na to, že ho hra nastavila při
startu. Ovladače v knihovně ho proto zapisují v `play()`.

*(Model OPL2 ve svision si zatím příznak jen pamatuje a negeneruje podle něj —
vlnový tvar používá vždycky. Na zvuku se to tedy dnes neprojeví; zapsané je to
proto, že hardware to tak má a až se model doplní, ovladače budou správně.)*

**Efekty se hrají jako FM, i když nástroje chtějí additive ★** — a je to
ověřené v **shipnuté binárce**, ne jen ve vydaných zdrojácích. 86 z 87
nástrojů má v bajtu `nConn` nastavený bit „obě operace sečti" (additive),
ale ovladač ho zahazuje a píše do registru `0xC0` nulu, tedy FM a nulovou
zpětnou vazbu. V rozbaleném `WOLF3D.EXE` je **jediný** zápis do registru
`0xC0` v celém programu (`push 0; push 0xC0; call alOut` na `0x1A9A9`
rozbaleného obrazu) — konstantní nula. Komentář ve zdrojáku u té řádky
(„switch commenting for old MUSE compatibility") tedy popisuje cestu, kterou
tahle edice **nejde**. Rozdíl je slyšet: additive zní o poznání měkčeji
(těžiště spektra dveří 239 Hz proti 496 Hz u FM).

**O tom, co bude hrát, rozhoduje priorita ★** — karta uměla jeden zvuk naráz
a nový se pustí, jen když jeho priorita není nižší než priorita toho, co
hraje. Jak dlouho zvuk „drží kartu“, se počítá z délky dat: bajt na 1/140 s,
tedy `length/2` tiků. Hra se na to ptá (`SD_SoundPlaying`) — třeba než pustí
zvuk nárazu do zdi.

**Hudba a efekt hrály na jednom čipu zároveň ★** — a je to vidět v datech:
**žádný proud IMF nikdy nezapne kanál 0** (ověřeno na všech 11 skladbách),
zapínají se jen kanály 1–8. Efekt totiž jede na hlase 0 (`SDL_ALPlaySound`
píše jen do něj) a hudba má zbylých osm. Karta tedy nehrála „jeden zvuk
naráz" — jeden zvuk naráz byl jen **efekt**, hudba mu běžela pod rukama.
Remake to má zatím jako dvě sběrnice (efekty a hudba zvlášť); věrné by bylo
jeden běžící čip, do kterého píšou obojí — viz §8.

**Dvacet efektů se na Sound Blasteru hraje jako nahrávka ★** — a jejich FM
verze se nehraje **vůbec**. Pravidlo je v `ID_SD.C` jedna podmínka: je-li
`DigiMode != sds_Off` a `DigiMap[zvuk] != -1`, pustí se digitalizovaný vzorek
a funkce skončí (`return true`) — k pásmu AdLib se vůbec nedojde. Digitalizované
zvuky nejsou v AUDIOT, ale ve VSWAP za stěnami a sprity, jako **unsigned 8 bit
na 7 000 Hz**, a mají **vlastní číslování**; spojuje je tabulka `wolfdigimap`
(`WL_MAIN.C`). Dveře, pistole, samopal, výkřiky, „Achtung", zásah a tajná stěna
jsou v té dvacítce — tedy skoro všechno, co hráč slyší.

*To je odpověď na „zvuky znějí jak ze speakeru" (nahlášeno 2026-09-17).
Reference operátora byl Sound Blaster, remake hrál FM verzi téhož čísla zvuku.
Nahrané samply v `sources/audio/` to potvrdily: devět z třinácti sedí
s `data/sounds/digi.json` **bajt po bajtu**.*

**Tabulka `wolfdigimap` je ověřitelná proti datům ★** — je to jediný kus
projektu, který se nedá odvodit z dat, tak se aspoň dá zkontrolovat. Shareware
půlka tabulky (před `#ifndef UPLOAD`) jmenuje digitalizované zvuky
`0..15, 20, 21, 22, 32`, a to je **přesně dvacet slotů, které shareware VSWAP
plní** — zbylých dvacet šest, které tabulka jmenuje až pro registrovanou verzi,
je v shareware datech prázdných. Dvě nezávislé věci, které se takhle trefí, už
nejsou opis (`tools/checkdigi.mjs`: 224 kontrol, 0 rozdílů).

**DAC a hlas 0 mají vlastní priority ★** — jsou to dva kusy hardwaru a jeden
druhý neumlčí: `SD_PlaySound` porovnává buď proti `DigiPriority`, nebo proti
`SoundPriority`, `SD_StopSound` zastaví obojí a `SDL_DigitizedDone` nuluje jen
to své. **`SD_SoundPlaying` odpovídá jen za FM zvuk** — digitalizovaný zvuk
tedy hru nedrží (hráč může bušit do zdi, i když zrovna hraje výkřik). Remake
to má stejně a má na to tři sběrnice: `sounds` (FM efekt), `music` a `digi`.

**Panning je dvojice tabulek 15×30 ★** (`lefttable`, `righttable`
ve `WL_GAME.C`), do kterých se sahá podle toho, kde zvuk je **ve výhledu**,
ne na mapě. Nejsou zrcadlové, proto jsou v `app/wolf/soundTables.js` obě.

**Jména skladeb v datech sedí s hlavičkou MUSE ★** — pořadí `CORNER`,
`DUNGEON`, `WARMARCH`, `GETTHEM`, … v záznamech IMF je přesně to, co má
`AUDIOWL6.H`. Je to nezávislé potvrzení, že pásmo hudby začíná na 261.

## 8. Co je ještě potřeba změřit

Tohle jsou věci, které **bez běžícího originálu v DOSBoxu rozhodnout nejdou**
a na kterých visí akceptace W3–W8 (`MILNIKY.md`):

- **snímky a sloupce**: `matchcolumns` a `matchframes` umí porovnat, ale
  nemají proti čemu — potřebují záznam z DOSBoxu (`--reference`)
- **dema tik po tiku**: `matchdemo` zatím jen dokazuje, že náš průlet je
  opakovatelný. Dema 0 a 3 u nás **končí smrtí hráče**, dema 1 a 2 dojedou
  do konce záznamu; v originálu by mělo dojet všechno. Někde se tedy
  rozcházíme — kandidáti: zaokrouhlení pohybu, pořadí bran `rndtable`,
  chování `CheckLine` u dveří
- **zvuk proti kartě**: `matchsound` porovná, až budou nahrávky
- **kolik má hráč po úrovni** — hodnocení mezihry proti originálu (W9)
- jestli shareware v1.4 opravdu používá plných osm smrtelných výkřiků stráže,
  nebo dva (`#ifdef UPLOAD` v `A_DeathScream`) — remake má osm
- **efekt utnul hudbu** (nahlášeno 2026-09-17, opraveno): obojí šlo na jednu
  sběrnici, která hraje jeden zvuk naráz jako DAC, takže každé otevření dveří
  hudbu zabilo. Teď má hudba sběrnici vlastní. **Pořád to není, jak to měl
  originál** — ten mixoval obojí v jednom čipu (hlas 0 proti hlasům 1–8), což
  je i důvod, proč se ty dva zvuky v originálu navzájem ovlivňují na hlasitosti
  a náš oddělený render ne
- **hudba se nestíhala vyrenderovat** (nahlášeno 2026-09-17, opraveno):
  jedna skladba je ~5 s procesoru a renderovala se v hlavním vlákně po 8 ms
  ze 108 → první tón by zazněl po minutě a půl. Teď to dělá vlastní worker
  (`app/musicWorker.js`) a model si stahuje nejdřív skladbu právě začínající
  úrovně. **Pozor na past při měření pod Node**: `import('…/opl2.js')` a
  `import('…/opl2.js?ver=node')` jsou pro Node **dva různé moduly**, takže
  přepsání statické konstanty na jednom z nich nemá na ovladače žádný vliv —
  hodinu jsem si tím měřil nulové rozdíly.
- ~~**zvuky zní „jak ze speakeru"**~~ (nahlášeno 2026-09-17, **vyřešeno**):
  remake hrál FM verzi i u zvuků, které na Sound Blasteru chodí přes DAC.
  Doloženo nahrávkami operátora, viz §7. Otevřené po tom zůstává jen ladění
  čipu pro **zbylých 67 efektů** a hudbu, viz níž.
- **jak má zvuk vlastně znít** (týká se už jen FM části) — po vyloučení všeho ostatního zbývají dvě
  konstanty čipu, které nikdy nikdo nezměřil: hloubka FM modulace
  (`OPL2.FM_INDEX`, dnes 3,99) a mez výstupního filtru (13 kHz, laděná ještě
  proti čtyřikrát slabší modulaci). Na hudbě to skoro není slyšet, na efektech
  ano — jejich modulátor jede skoro naplno. **Nástroj na to je hotový**:
  `tools/tunechip.mjs` vezme nahrávku originálu a proměří proti ní mřížku
  obou konstant (ověřeno na podvržené nahrávce se známým nastavením: našel
  přesně ji). Chybí jediné — nahrávka (hlášeno operátorem 2026-09-17: „je to jak ze
  speakeru"). Změřené je tohle: ladění čipu sedí na vzorec `fnum·49716/2^(20−block)`,
  čistý sinus má crest 1,41, mapování operátorů na kanály sedí, hlasitost
  nikde nedoráží na doraz. Co se liší od karty: **stejnosměrná složka** až
  0,14 při špičce 0,44 u efektů s usměrněnými vlnovými tvary (karta ji
  odstraní vazebním kondenzátorem, model ne) a **decimace 49 716 → 22 050 Hz**
  bez filtru. A jeden rozdíl, který je v architektuře: originál měl jeden
  pořád běžící čip a nový zvuk jen přepsal registry, kdežto tady se každý
  efekt vyrenderuje zvlášť a nový zvuk ten předchozí **utne** (jeden zvuk
  naráz, `AudioSampleHandler`). Vzorky k poslechu vyrábí
  `/tmp`-nezávisle `build/adlib/` (pět variant, viz `MILNIKY.md` W8)
