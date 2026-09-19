# Puhekomennot ja AI-intentit

**AI ehdottaa. Sovellus päättää. Käyttäjä vahvistaa.**

Toteutus: `src/ai/intentSchema.js` (turvamalli), `src/ai/commandClient.js`
(kutsu), `api/command.js` (palvelinvälitys), `src/app/commandBar.js`
(putki: luokittelu → ehdotus → vahvistus → suoritus), `src/app/voice.js`
(puheen käyttöliittymä, ohut sovitin commandBar.js:n päällä),
`src/app/search.js` (kirjoitetun komennon käyttöliittymä)
Testit: `tests/ai-command-client.test.mjs`, `tests/ai-command-handlers.test.mjs`,
`tests/api-command-validation.test.mjs`, `tests/app-ai-commands.test.mjs`,
`tests/command-bar.test.mjs`, `tests/voice-command-pipeline.test.mjs`,
`tests/voice-flow.test.mjs`, `tests/fi-temporal.test.mjs`,
`tests/temporal-reconcile.test.mjs`, `tests/ai-command-prompt.test.mjs`,
`tests/ai-command-adversarial.test.mjs`, `tests/ai-command-idempotency.test.mjs`

---

## Toteutuksen tila

| Osa | Tila |
|---|---|
| Puheentunnistus selaimessa | IMPLEMENTED (Web Speech API, Chrome/Edge) |
| Kirjoitettu varasyöte | IMPLEMENTED — toimii kaikkialla |
| Yksi tulkintaputki tekstille ja puheelle | IMPLEMENTED — `runTypedCommand({source})` |
| Kaikki 20 komentoa (ei vain luonti) puheessa | IMPLEMENTED, käytössä |
| Intent-skeema ja komentorekisteri | IMPLEMENTED, testattu |
| Palvelinvälitys ja avainsuojaus | IMPLEMENTED |

Puhe ja kirjoitettu teksti kulkevat nyt **täsmälleen saman** putken läpi
(`src/app/commandBar.js` `runTypedCommand`): sama allowlist, sama
kohteentunnistus, sama vahvistusdialogi (`ui/confirm.js`), sama kirjausketju.
Ainoa ero on `source`-kenttä palvelinkutsussa (`'text'` tai `'voice'`), joka
on puhtaasti diagnostinen — se ei muuta turvamallia millään tavalla.
Aiempi erillinen "vain luo tehtävä puheesta" -putki (`parseClient.js`,
`api/parse.js`) on poistettu käytöstä puheen käyttöliittymästä; `api/parse.js`
säilyy palvelimella muuta käyttöä varten, mutta puhekomennot eivät enää
kutsu sitä.

---

## Neljä porttia

Mallin vastaus ei koskaan päädy suoritukseen. Se kulkee neljän portin läpi:

```
AI:n vastaus
   │
   ├─ 1. allowlist ......... tunnetaanko tämä intentti lainkaan?
   ├─ 2. tyyppitarkistus ... ovatko kentät yksinkertaisia arvoja?
   ├─ 3. skeemavalidointi .. ovatko arvot kelvollisia tälle komennolle?
   └─ 4. riskiarvio ........ vaatiiko tämä vahvistuksen?
   │
   ▼
Sovelluskomento — kuvaus siitä mitä VOITAISIIN tehdä
   │
   ▼
Käyttäjän vahvistus
   │
   ▼
Suoritus (actions.js)
```

`resolveCommand()` **ei suorita mitään**. Se palauttaa komennon. Kutsuja
päättää, mitä sillä tehdään.

---

## Mitä AI ei voi tehdä missään olosuhteissa

| Ei voi | Miksi ei |
|---|---|
| Poistaa mitään | Poisto ei ole allowlistissä lainkaan |
| Vaihtaa omistajuutta | `user_id` ei esiinny yhdessäkään skeemassa |
| Suorittaa SQL:ää | Komennot ovat nimettyjä, eivät kyselyitä |
| Kutsua repositoriota | `resolveCommand` palauttaa arvon, ei kutsu mitään |
| Muuttaa asetuksia tai turvallisuutta | Ei allowlistissä |
| Ohittaa vahvistuksen | Vain `read_only`-komennot voivat ohittaa sen |

`FORBIDDEN_INTENTS` listaa nimenomaisesti kielletyt: `delete_task`,
`delete_all`, `change_owner`, `execute_sql`, `disable_security` ja muut. Lista
on olemassa **dokumentaationa ja testattavana invarianttina** — hylkäys
tapahtuisi joka tapauksessa, koska niitä ei ole allowlistillä.

Tuntematon ja kielletty intentti hylätään täsmälleen samalla tavalla. Ero
näkyy vain lokissa. Käyttäjälle molemmat ovat "tuntematon komento".

---

## Sallitut komennot

Kaksikymmentä intenttiä, tehtäville, rutiineille, tavoitteille, projekteille,
laskuille ja asetuksille — täydellinen, ajantasainen lista ja jokaisen riski
on `src/ai/intentSchema.js`:n `COMMANDS`-rekisterissä (yksi lähde, ei kahta
listaa jotka erkanevat). Poimintoja:

| Intentti | Riski | Vahvistus | Mitä tekee |
|---|---|---|---|
| `create_task` | keskitaso | kyllä | Luo tehtävän |
| `update_task` / `reschedule_task` | keskitaso | kyllä | Muuttaa olemassa olevaa |
| `delete_task` / `delete_routine` / `delete_goal` / `delete_project` | **korkea** | kyllä, ei ohitettavissa | Poistaa pysyvästi |
| `complete_task` / `uncomplete_task` | keskitaso | kyllä | Merkitsee tehdyksi / avaa uudelleen |
| `mark_bill_paid` | keskitaso | kyllä | Merkitsee laskun maksetuksi |
| `show_day_plan` / `show_week_plan` | matala (vain luku) | ei | Vaihtaa näkymän |

Vain lukevat komennot ohittavat vahvistuksen. Ne eivät muuta mitään, joten
vahvistuksen kysyminen olisi pelkkää kitkaa. Korkean riskin (poisto)
komennon vahvistusta ei voi ohittaa millään asetuksella — ks.
`needsConfirmation()` ja `isDestructive()`.

---

## Miksi muutoskomento on vaarallisin

`update_task` oli lähellä aiheuttaa hiljaisen tietohäviön, ja korjaus on
opettavainen.

Naiivi toteutus normalisoi kaikki kentät ja kirjoittaa ne:

```js
// VÄÄRIN
changes.category = normalizeCategory(raw.category);  // undefined -> 'muu'
changes.priority = normalizePriority(raw.priority);  // undefined -> 'normaali'
```

Käyttäjä sanoo "siirrä hammaslääkäri kolmeen". AI palauttaa vain uuden ajan.
Normalisointi täyttää puuttuvat kentät **oletusarvoilla**, ja tallennus
ylikirjoittaa käyttäjän itse valitseman kategorian ja prioriteetin. Käyttäjä
ei pyytänyt sitä eikä huomaa sitä.

Korjaus: `taskFields()` palauttaa `provided`-joukon, joka kertoo mitkä kentät
tulivat **oikeasti syötteestä** kelvollisina. Vain ne päätyvät muutoksiin.

```js
for (const key of result.provided) {
  if (key === 'title') continue;
  changes[key] = result.payload[key];
}
```

Sama syy erottaa `title` ja `newTitle`: `title` tunnistaa kohteen,
`newTitle` nimeää sen uudelleen. Yhdessä kentässä ne sekoittuisivat, ja
"merkitse kaupassa käynti tehdyksi" voisi nimetä tehtävän uudelleen.

---

## Rakenteiden torjunta

Payloadissa sallitaan vain yksinkertaiset arvot: `null`, merkkijono, luku,
totuusarvo — ja taulukko, jonka jokainen alkio on sellainen.

```js
if (!isPrimitive(value)) return { ok: false, reason: 'Kelvoton kenttä: ' + key };
```

Näin malli ei voi ujuttaa olioita, funktioita eikä prototyyppiä
(`__proto__`, `constructor`) hyötykuormaan. Tarkistus tehdään ennen
skeemavalidointia, koska validointi voisi muuten koskea vaaralliseen
rakenteeseen.

---

## Avain ei koskaan päädy selaimeen

```
Selain                     Vercel                    Anthropic
  │                          │                           │
  │  POST /api/command       │                           │
  │  { text, today, source } │                           │
  ├─────────────────────────>│                           │
  │                          │  Messages API             │
  │                          │  Authorization: <avain>   │
  │                          ├──────────────────────────>│
  │                          │<──────────────────────────┤
  │<─────────────────────────┤                           │
  │  { intent, payload }     │                           │
```

`source` on `'text'` tai `'voice'` — puhtaasti diagnostinen kenttä, ei
turvarajaus. `api/command.js` lukee avaimen ympäristömuuttujasta. Avain ei ole missään
selaimeen ladattavassa tiedostossa. Tämä on lukittu testillä
(`tests/security-invariants.test.mjs`), joka lukee kaikki selainmoduulit ja
etsii avainkuvioita.

Palvelinpuolella on myös:
- **Autentikaatio** — kutsu vaatii kirjautuneen käyttäjän
- **Pyyntökatto** — `api/_ratelimit.js`
- **Syötteen validointi** — `api/_validate.js`, ennen kuin mitään lähetetään
  eteenpäin

---

## Puheentunnistus ja sen varasyöte

Web Speech API toimii käytännössä vain Chromessa ja Edgessä. Safari ja
Firefox eivät tue sitä luotettavasti.

Siksi puhenäkymässä on aina **"Kirjoita sen sijaan"** -tila. Se ei ole
virhetila vaan tasavertainen tapa: sama tulkintaputki, sama vahvistus, sama
lopputulos. Sovellus ei saa olla käyttökelvoton siksi, että selain ei osaa
kuunnella.

Kun mikrofoni tuottaa tuloksen, käyttäjä näkee tunnistetun tekstin
muokattavana ennen kuin mitään tulkitaan (`voiceState-transcript`,
`src/app/voice.js`) — puheentunnistus erehtyy säännöllisesti, ja virhe on
halvin korjata ennen luokittelua.

### Tilakone (`src/domain/voiceFlow.js`)

Puheen käyttöliittymä ei aseta paneelia tapahtumakäsittelijöistä käsin: jokainen
tapahtuma kulkee puhtaan reducerin `nextVoiceState(state, event)` läpi, ja vasta
uusi tila piirretään (`applyState`). Kielletty siirtymä palauttaa saman tilan.

```
IDLE → REQUESTING_PERMISSION → LISTENING → TRANSCRIPT_READY ──SUBMIT──▶ CLASSIFYING
        │ (ei tukea)                          ▲ (kirjoitettu: TYPE_FALLBACK ─SUBMIT─┘)
        └▶ TYPE_FALLBACK                      │
CLASSIFYING → [TARGET_SELECTION] → REVIEW → [CONFIRMATION] → EXECUTING → SUCCESS | ERROR | IDLE
```

Takuut (testattu `tests/voice-flow.test.mjs`):

- Litterointi ei etene tulkintaan ilman käyttäjän SUBMIT-toimintoa.
- Mikrofoni on päällä vain tiloissa `REQUESTING_PERMISSION` ja `LISTENING`;
  jokaisessa muussa tilassa tunnistus sammutetaan.
- `visibilitychange` (piilotettu) ja `pagehide` sammuttavat mikrofonin
  (`HIDDEN`); ei taustakuuntelua, `continuous = false`, ääntä ei tallenneta
  (ei `getUserMedia`/`MediaRecorder`).
- Peruutus onnistuu joka tilasta; suljetun paneelin myöhäinen tulos ei avaa
  paneelia uudelleen.
- Vaiheet CLASSIFYING/REVIEW/TARGET_SELECTION/CONFIRMATION/EXECUTING tulevat
  `commandBar.js`:n `onPhase`-kutsusta — samat vaiheet kuin kirjoitetulla
  komennolla, ei omaa rinnakkaista logiikkaa.
- Tilasiirtymät lokitetaan vain tilojen nimillä (`voice.state`), ei litterointia.

### Alkureititys (`src/domain/utteranceRoute.js`)

Selvä haku ("etsi …", "löydä …") ohjataan suoraan hakupaneeliin hakusanalla
(täytesanat kuten "kaikki", "liittyvät", "tehtävät" poistetaan) eikä sitä lähetetä
mallille. "Hae" jätetään tarkoituksella pois: "hae lapset koulusta klo 15" on
tehtävä. Pelkkä "etsi" ilman hakusanaa, "etsimään", "etsin" jne. menevät mallille.

### Luonti vs. komento ja suomen aikailmaisut

- Palvelinkehote (`api/command.js` `buildPrompt`) erottaa LUONNIN ("lisää
  tehtävä …", "muistuta minua …") olemassa olevan kohteen KOMENNOSTA ("siirrä …",
  "merkitse … maksetuksi") ja sisältää validoidut esimerkit (`PROMPT_EXAMPLES`).
- Deterministinen jäsennin `src/domain/fiTemporal.js` tunnistaa suomen aikailmaisut
  (huomenna, ylihuomenna, ensi viikon perjantaina, viikonpäivät, klo 8, puoli
  yhdeksältä = 08:30 (ei 09:30)) ja `src/ai/temporalReconcile.js` korjaa mallin päivämäärän tai
  kellonajan VAIN kun jäsennin on yksiselitteinen; muuten mallin arvo jää
  ennalleen. Korjaus kirjataan (`command.reconciled`, vain kenttien nimet).
- Luonnin esikatselu ja muutoskomentojen "nykyinen → uusi" -rivit näytetään
  vahvistusdialogissa (`derivedChanges`).
- Rajoitus: mallin luokittelun tarkkuutta (create vs. command) ei voi testata
  ilman oikeaa mallia; testit kattavat kehotteen sisällön, esimerkit ja koko
  putken mallia matkivilla vastauksilla.

---

## Rajoitukset

- Haku ei ole komento: `COMMANDS`-rekisterissä ei ole hakuintenttiä. Selvä
  "etsi/löydä …" -lause ohjataan paikallisesti hakupaneeliin hakusanalla
  (`utteranceRoute.js`); muut hakumuotoiset lauseet ("hae …") menevät mallille.
- Ei monivaiheista keskustelua ("mihin aikaan?" → vastaus → jatka)
- Ei kohdetehtävän tunnistusta epämääräisestä viittauksesta ("se eilinen")
- Ei offline-tulkintaa — vaatii verkkoyhteyden
- Ei äänipalautetta
- Puheella luotu tehtävä ei tarjoa erillistä kenttäkohtaista muokkauslomaketta
  ennen tallennusta (toisin kuin ennen yhtenäistystä) — vahvistusdialogi
  näyttää otsikon ja tarvittaessa muutosrivit; väärin tunnistetun ajan tms.
  korjaa peruuttamalla ja yrittämällä uudelleen, tai muokkaamalla tehtävää
  tallennuksen jälkeen.
