# AI-komentojen turvamalli

**AI ehdottaa. Sovellus päättää. Käyttäjä vahvistaa.**

Toteutus: `src/ai/intentSchema.js`, `src/ai/entityResolver.js`,
`src/app/aiCommands.js`, `src/ui/confirm.js`
Testit: `ai-intent`, `ai-entity-resolver`, `app-ai-commands`, `accessibility`
Skeema: `supabase/migrations/0008_ai_audit.sql`

---

## Putki

```
raaka syöte  (kirjoitettu tai puhuttu)
  ↓
intent-jäsennys            api/parse.js — avain ei koskaan selaimeen
  ↓
tiukka skeema              resolveCommand: vain sallitut kentät
  ↓
allowlist ja riskiluokka   LOW / MEDIUM / HIGH
  ↓
kohteen tunnistus          EXACT / AMBIGUOUS / NOT_FOUND
  ↓
ehdotus + esikatselu       mitä, mihin, nykyinen → uusi
  ↓
KÄYTTÄJÄN VAHVISTUS        oma dialogi, fokus peruutuksessa
  ↓
sovelluskomento            app/actions.js
  ↓
repositorio → tulos → kirjaus
```

`resolveCommand()` **ei suorita mitään**. Se palauttaa arvon. Suorittaminen
on erillinen, nimenomainen askel.

---

## Riskiluokat

| Taso | Mitä | Vahvistus |
|---|---|---|
| `LOW` | Ei muuta mitään (`show_day_plan`, `show_week_plan`) | Ei kysytä — turha kysymys on kitkaa |
| `MEDIUM` | Luo tai muuttaa | Kysytään |
| `HIGH` | Poistaa, peruuttamaton | **Eksplisiittinen vahvistus, jota ei voi ohittaa asetuksella** |

Vahvistus **johdetaan riskitasosta** eikä ole erillinen lippu. Kaksi
kenttää voisi joutua ristiriitaan, ja ristiriidassa väärä puoli voittaa
hiljaa.

---

## Muutos V1:stä: poisto on nyt olemassa

V1:ssä poistoa ei ollut allowlistillä lainkaan. Se oli yksinkertaisin
mahdollinen suoja, mutta tarkoitti myös ettei "poista se peruttu palaveri"
toiminut lainkaan.

**V2 sallii poiston ja korvaa puuttuvan suojan kolmella tiukemmalla:**

1. **HIGH-riski**, joka vaatii aina eksplisiittisen vahvistuksen.
2. **`requiresExactTarget`** — poisto ei koskaan etene epäselvällä
   kohteella. Kaksi samannimistä tehtävää pysäyttää komennon.
3. **Massapoistoa ei ole olemassa.** `delete_all`, `delete_everything` ja
   `delete_account` ovat kielletyissä. Yksittäisen rivin poisto voidaan
   vahvistaa mielekkäästi yhdellä dialogilla; "poista kaikki" ei voi.

Tämä on tietoinen turvarajan löysennys, joka on korvattu tarkemmalla
suojalla — ei suojan poisto.

---

## Kohteen tunnistus on oma kerroksensa

`"Siirrä lääkäriaika huomiselle"` on vaaraton lause vain jos sovellus tietää
täsmälleen mitä siirretään.

| Tulos | Merkitys | Mitä tapahtuu |
|---|---|---|
| `EXACT` | Tasan yksi kohde | Vasta tämä sallii mutaation |
| `AMBIGUOUS` | Useita mahdollisia | **Sovellus kysyy, ei valitse** |
| `NOT_FOUND` | Ei yhtään | Komento pysähtyy |

### Neljä ratkaisua, joilla on perustelu

**Osumatasot ratkaistaan ennen monikäsitteisyyttä.** Täsmällinen osuma
voittaa osittaiset. Ilman tätä "Osta maitoa" olisi ikuisesti epäselvä aina
kun "Osta maitoa ja leipää" on olemassa — eikä käyttäjä saisi tehtyä mitään.

**Tyhjä hakusana ei osu koskaan mihinkään.** Tyhjä merkkijono sisältyy
jokaiseen merkkijonoon, joten ilman torjuntaa kohteeton poisto olisi
osunut kaikkiin riveihin kerralla.

**Sumeaa hakua ei ole.** Sumea haku arvaa, ja arvaus mutaatiossa on juuri
se mitä halutaan estää. Kirjoitusvirhe ei osu — se on ominaisuus.

**ä, ö ja å eivät taitu a:ksi ja o:ksi.** Suomessa ne ovat omia
kirjaimiaan; taittaminen tekisi sanoista "sää" ja "saa" saman kohteen.
Unicode normalisoidaan (NFC), jotta yhdistetty ja hajotettu esitysmuoto
vastaavat toisiaan.

> **Haku on eri asia.** `src/domain/search.js` **sietää** diakriittien
> puuttumisen, koska se ei muuta mitään. Ero on tietoinen eikä sitä pidä
> yhtenäistää.

---

## Mitä AI ei voi tehdä

| Ei voi | Miksi ei |
|---|---|
| Vaihtaa omistajuutta | `user_id` ei esiinny yhdessäkään skeemassa |
| Suorittaa SQL:ää | Komennot ovat nimettyjä, eivät kyselyitä |
| Kutsua repositoriota | `resolveCommand` palauttaa arvon |
| Poistaa epäselvää kohdetta | `requiresExactTarget` |
| Ohittaa HIGH-vahvistusta | Ei asetusta, joka sen sallisi |
| Ylikirjoittaa antamattomia kenttiä | `provided`-joukko |
| Ujuttaa olioita tai prototyyppiä | Vain primitiivit sallittu |

### Miksi muutoskomento on vaarallisin

Naiivi toteutus normalisoi kaikki kentät ja kirjoittaa ne:

```js
changes.category = normalizeCategory(raw.category);  // undefined -> 'muu'
```

Käyttäjä sanoo "siirrä hammaslääkäri kolmeen". AI palauttaa vain uuden ajan.
Normalisointi täyttää puuttuvat kentät oletusarvoilla, ja tallennus
ylikirjoittaa käyttäjän valitseman kategorian ja prioriteetin. Käyttäjä ei
pyytänyt sitä eikä huomaa sitä.

`taskFields()` palauttaa `provided`-joukon: vain oikeasti annetut kentät
päätyvät muutoksiin. Sama suoja on rutiineilla, tavoitteilla, projekteilla
ja laskuilla.

---

## Vahvistusnäkymä

Käyttäjän on nähtävä neljä asiaa:

```
LASKU
Muuta laskua
Sähkölasku

SUMMA
84,50 €  →  99,90 €

ERÄPÄIVÄ
15.9.2026  →  30.9.2026

[ Peruuta ]  [ Hyväksy ]
```

- **Oletusfokus on peruutuksessa.** Enter ei poista mitään.
- **Peruuttamaton erottuu** sanoin ("Poista pysyvästi"), varoituslaatikolla
  ja tyylillä. Pelkkä sanamuoto hyväksyttäisiin samalla rutiinilla kuin
  muutos.
- **Muutosrivit rakennetaan DOM-solmuina ja `textContent`illa.** Arvot ovat
  käyttäjän ja AI:n tuottamaa tekstiä; `textContent` estää injektion
  rakenteellisesti eikä voi unohtua yhdestä kentästä niin kuin escapeHtml.

---

## Kirjausketju

`ai_action_audit` vastaa kysymykseen *"miksi tämä muuttui?"* silloin kun
käyttäjä ei muista tehneensä muutosta.

**Tämä ei ole analytiikkaa.** Se ei mittaa käyttöä, ei seuraa
käyttäytymistä eikä lähde mihinkään. Se poistuu käyttäjän mukana.

- **Raakaa syötettä ei tallenneta.** Tiivistelmä katkaistaan sanan rajalta
  120 merkkiin. Pituusrajoite on myös kannassa: sovellusvirhe ei saa
  johtaa siihen, että koko päiväkirjamerkintä päätyy tietokantaan.
- **`target_id` ei ole vierasavain.** Kohde on voitu poistaa, ja kirjaus
  siitä on nimenomaan se mitä halutaan säilyttää.
- **Kanta hylkää suoritetun komennon ilman vahvistusta.** Sellainen rivi
  olisi merkki turvamallin rikkoutumisesta.

---

## Puheohjaus käyttää samaa putkea

Puhe ei ole vaihtoehtoinen, löysempi komentoreitti:

```
puhe → teksti → SAMA intent-putki → SAMAT vahvistussäännöt
```

Mikrofonilupaa ei pyydetä käynnistyksessä.

---

## Tila

| Osa | Tila |
|---|---|
| Intent-skeema, 22 komentoa | **IMPLEMENTED** |
| Kohteen tunnistus | **IMPLEMENTED** |
| Riskiluokat ja vahvistussäännöt | **IMPLEMENTED** |
| Vahvistusdialogi ja kohteen valinta | **IMPLEMENTED** |
| Orkestrointi ja kirjausketju | **IMPLEMENTED** |
| Kirjausketjun tallennus | **SCHEMA-GATED** — migraatio 0008 |
| Komentojen kytkentä puhenäkymään | **PLANNED** |
| Palvelimen kehote uusille intenteille | **PLANNED** |
