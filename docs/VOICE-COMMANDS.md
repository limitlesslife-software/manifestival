# Puhekomennot ja AI-intentit

**AI ehdottaa. Sovellus päättää. Käyttäjä vahvistaa.**

Toteutus: `src/ai/intentSchema.js` (turvamalli), `src/ai/parseClient.js`
(kutsu), `api/parse.js` (palvelinvälitys), `src/app/voice.js` (käyttöliittymä)
Testit: `tests/ai-intent.test.mjs`, `tests/ai-proposal.test.mjs`,
`tests/api-security.test.cjs`

---

## Toteutuksen tila

| Osa | Tila |
|---|---|
| Puheentunnistus selaimessa | IMPLEMENTED (Web Speech API, Chrome/Edge) |
| Kirjoitettu varasyöte | IMPLEMENTED — toimii kaikkialla |
| Tehtävän luonti puheesta | IMPLEMENTED, käytössä |
| Intent-skeema ja komentorekisteri | IMPLEMENTED, testattu |
| Muut intentit kuin luonti käyttöliittymässä | **PLANNED** — skeema valmis, kytkentä puuttuu |
| Palvelinvälitys ja avainsuojaus | IMPLEMENTED |

Skeema kattaa seitsemän intenttiä. Käyttöliittymä käyttää tällä hetkellä
vain tehtävän luontia. Loput ovat valmiina ja testattuina, mutta niitä ei ole
vielä kytketty puhenäkymään — kytkentä vaatii oman käyttöliittymäsuunnittelun
sille, miltä "muuta hammaslääkäri kolmeen" näyttää vahvistusnäkymässä.

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

| Intentti | Riski | Vahvistus | Mitä tekee |
|---|---|---|---|
| `create_task` | matala | kyllä | Luo tehtävän |
| `update_task` | keskitaso | kyllä | Muuttaa olemassa olevaa |
| `complete_task` | keskitaso | kyllä | Merkitsee tehdyksi |
| `create_routine` | matala | kyllä | Luo rutiinin |
| `create_goal` | matala | kyllä | Luo tavoitteen |
| `show_day` | vain luku | ei | Vaihtaa näkymän |
| `show_week` | vain luku | ei | Vaihtaa näkymän |

Vain lukevat komennot ohittavat vahvistuksen. Ne eivät muuta mitään, joten
vahvistuksen kysyminen olisi pelkkää kitkaa.

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
  │  POST /api/parse         │                           │
  │  { text, today }         │                           │
  ├─────────────────────────>│                           │
  │                          │  Messages API             │
  │                          │  Authorization: <avain>   │
  │                          ├──────────────────────────>│
  │                          │<──────────────────────────┤
  │<─────────────────────────┤                           │
  │  { intent, payload }     │                           │
```

`api/parse.js` lukee avaimen ympäristömuuttujasta. Avain ei ole missään
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

---

## Rajoitukset

- Vain tehtävän luonti on kytketty käyttöliittymään
- Ei monivaiheista keskustelua ("mihin aikaan?" → vastaus → jatka)
- Ei kohdetehtävän tunnistusta epämääräisestä viittauksesta ("se eilinen")
- Ei offline-tulkintaa — vaatii verkkoyhteyden
- Ei äänipalautetta
