# Henkilökohtainen avustaja — kirjaus, muistutukset ja lähtöaika

**Tila:** rakennettu, portit kiinni. **Mitään ei ole deployattu eikä
ajettu tuotantoon.**

Manifestival ottaa vastaan sen, mitä käyttäjällä on mielessä — yhtenä
lauseena, milloin tahansa — ja tekee siitä jotain käyttökelpoista vasta
kun käyttäjä on hyväksynyt sen. Tämä dokumentti kertoo mitä se
tarkoittaa, mitä se tarkoituksella **ei** tee, ja mitä sen tuotantoon
vieminen vaatii.

---

## Ketju

```
VAPAA TEKSTI TAI PUHE
    ↓
RIVI SAAPUVIIN         syntyy HETI, ennen kuin mitään tulkitaan
    ↓
TULKINTA               tekoälyn ehdotus + luottamustaso
    ↓
REITTI                 kuvaus siitä mitä hyväksyminen tekisi — ei kutsu
    ↓
KÄYTTÄJÄN TARKISTUS    yksi lause, kolme painiketta
    ↓
HYVÄKSYNTÄ             vahvistus, jota ei voi kytkeä pois
    ↓
DOMAIN-RIVI            tehtävä, tavoite, lasku, matka…
    ↓
MUISTUTUS              jos asia tarvitsee palata mieleen
    ↓
ILMOITUS               kun hetki on käsillä — perusteltuna
```

Järjestys on tärkeä. Jos tulkinta tehtäisiin ensin ja rivi vasta sen
onnistuessa, verkkokatko söisi käyttäjän ajatuksen — ja juuri sitä
ajatusta varten koko kirjaus on olemassa.

---

## Kuusi asiaa, joita tämä ei tee

Nämä eivät ole puutteita. Ne ovat suunnittelun päätöksiä, ja ne on
kirjoitettu koodiin rajoitteina eikä muistutuksina.

### 1. Mitään ei synny ilman hyväksyntää

`routeOf()` palauttaa **kuvauksen**, ei toteutusta. Se kertoo mitä
kutsuttaisiin; sovelluskerros kutsuu vasta kun käyttäjä on sanonut
kyllä.

Toiminnon nimi ratkaistaan **nimetystä luettelosta**
(`ROUTE_ACTIONS`), ei hakemalla moduulista. Dynaaminen haku antaisi
mallin nimetä minkä tahansa viedyn funktion — myös `deleteTask`.
Luettelossa on vain `create`-alkuisia nimiä, ja testi vartioi sitä.

Jokainen reitti vaatii vahvistuksen. Ei siksi että ne olisivat
vaarallisia, vaan siksi että ne syntyvät **tulkinnasta**: käyttäjä
kirjoitti lauseen, ja joku muu päätti mitä se tarkoittaa.

### 2. Ääntä ei tallenneta

`src/app/speechInput.js` on 140 riviä ja tekee yhden asian: kuuntele
kerran, palauta teksti. Siinä ei ole `MediaRecorder`ia, `getUserMedia`a
eikä puskuria, eikä sellaista saa lisätä.

Puheesta tullut rivi kantaa **litteroinnin**, koska litterointi on
silloin se mitä käyttäjä sanoi — ei välivaihe matkalla johonkin muuhun.
Äänitallenne kertoo ihmisestä paljon enemmän kuin se mitä hän sanoi.

`inbox_items.source` kertoo vain, tuliko rivi puheesta.

### 3. Koordinaatteja ei tallenneta

`origin`, `destination` ja `place` ovat käyttäjän kirjoittamia **nimiä**.
Kannassa ei ole yhtään koordinaattisaraketta.

Koordinaatti kannassa olisi koordinaatti varmuuskopiossa, viennissä ja
mahdollisessa vuodossa. Sijaintihistoria kertoo missä ihminen asuu,
työskentelee ja käy — eikä lähtöajan laskenta tarvitse siitä mitään.

`verify_0011.sql` **tarkistus 12** etsii koordinaattisarakkeita
sarakenimistä suoraan. Se on ainoa tarkistus koko tiedostossa, joka
etsii jotain mitä **ei saa olla**.

### 4. Matka-aikaa ei haeta mistään

`hasTravelProvider()` palauttaa `false`. Reittipalvelua ei ole, ja
sopimus sille (`TRAVEL_PROVIDER_CONTRACT`) on kuvattu mutta
toteuttamatta.

Kun kestoa ei tiedetä, `travelMinutes` on **NULL eikä nolla**. Nolla
tarkoittaisi "ollaan jo perillä", ja siitä laskettu lähtöaika olisi
vale. Laskettu lähtöaika näyttää täsmälleen yhtä varmalta kuin oikea —
käyttäjä luottaisi siihen ja myöhästyisi.

Kannassa `travel_plans_unknown_source_check` estää sen, että puuttuva
arvio väittäisi olevansa mitattu.

### 5. Geoaitaa ei ole

`locationRules` on **sääntö, ei toteutus**. Sääntö on dataa, jota
voidaan kirjata, nähdä ja testata simuloiduilla sijainneilla —
`locationRuleMatches(rule, context)` on puhdas funktio, joka ei tarvitse
laitetta.

Oikeaa sijaintiseurantaa ei ole eikä sitä voi luvata ilman
laitehyväksyntää. Ks. `docs/LOCATION-DEPARTURE-ARCHITECTURE.md` ja
`docs/DEVICE-ACCEPTANCE-BACKLOG.md`.

Uusi sääntö on **oletuksena pois päältä**, sekä domainissa että
kannassa. Päälle kytkeminen kysyy vahvistuksen; pois kytkeminen ei —
turvallisempaan suuntaan siirtyminen ei tarvitse kitkaa.

### 6. Taustaherätystä ei ole

Muistutukset lasketaan silloin kun sovellus on auki: kirjautumisen
jälkeen ja kolmenkymmenen sekunnin välein. Suljetusta sovelluksesta
tulevaa hälytystä ei voi luvata selaimessa, eikä sitä siksi luvata.

Muistutusnäkymä sanoo tämän yhdellä rivillä, ja rivi luetaan
sovittimelta (`background.capability()`) eikä kirjoiteta käsin — jos
natiivikuori joskus tukee taustaherätystä, rivi muuttuu itsestään.

Käyttäjä, joka luulee saavansa hälytyksen suljetusta sovelluksesta,
jättää tekemättä sen mitä oli tekemässä.

---

## Saapuvat: kirjaa nyt, järjestä myöhemmin

### Elinkaari

```
unprocessed ──┬─→ proposed ──┬─→ accepted ──→ converted   (päätetila)
              │              │
              ├─→ needs_review ┘
              │
              └─→ dismissed ──→ unprocessed
```

Kartta on nimenomainen (`TRANSITIONS`) eikä johdettu. Jokainen nuoli on
päätös, ja päätös näkyy yhtenä rivinä — ei ehtolauseiden verkostona,
jonka läpi voi vahingossa kulkea väärään suuntaan.

**Hylätystä voi palata.** Se on tarkoituksellinen ero muihin
elinkaariin: käyttäjä voi hylätä rivin vahingossa, eikä hylkäys tuhoa
mitään.

**Muunnettu on päätetila.** Paluu tarkoittaisi kahta riviä samasta
asiasta: rivin palauttaminen ei poistaisi siitä syntynyttä tehtävää,
joten toinen hyväksyntä loisi kaksoiskappaleen.

**Muunnos vaatii hyväksynnän ensin.** Suora hyppy ehdotetusta
muunnettuun ohittaisi sen hetken, jossa käyttäjä sanoo kyllä.

### Ehdotus katoaa kun rivi käsitellään

`markConverted` ja `dismissItem` nollaavat `proposal`-kentän.

Käsitellyn rivin ehdotus on mallin tuotosta ilman käyttöä: se ei kerro
mitä syntyi (`convertedId` kertoo), eikä sitä voi enää hyväksyä.
Säilytettynä se päätyisi vientiin ja varmuuskopioon.

`verify_0011.sql` **tarkistus 47** havaitsee, jos tämä lakkaa pitämästä
paikkansa.

### Idempotenssi

Painikkeen kahdesti painaminen on tavallista, ei virhe.

`approveItem` tarkistaa päätetilan **kahdesti**: kerran ennen
vahvistusdialogia ja kerran sen jälkeen. Vahvistus on odotus, ja rivi
voi muuttua sen aikana.

### Katto

`MAX_OPEN_ITEMS = 200` **avointa** riviä. Kaksisataa avointa riviä ei
ole enää lista vaan kasa, eikä kasaa käsittele kukaan. Katto estää
kirjaamisen näkyvästi sen sijaan että saapuvat hiljaa kasvaisivat
rajatta.

Suljetut rivit eivät laske kattoa: ne eivät odota ketään.

---

## Muistutukset

### Tilakone

```
scheduled ─→ due ─→ delivered ─→ acknowledged ─→ completed
    │         │         │             │
    └─────────┴─────────┴─── snoozed ─┘
    │
    └─→ cancelled · expired                    (päätetiloja)
```

### Torkku siirtää muistutusta, ei määräpäivää

`snooze(reminder, minutes, now)` ottaa vastaan **muistutuksen eikä
kohdetta**. Se ei voi siirtää tehtävän määräaikaa, koska sillä ei ole
pääsyä siihen.

Tämä on rakenteellinen tae eikä muistisääntö, ja testi todistaa sen
sitä kautta mitä funktio palauttaa: pelkän muistutuksen, jonka kentät
ovat muistutuksen kenttiä.

Torkku **säilyttää käyttäjän asettaman takarajan** (`untilTime`). Jos
torkku menee rajan yli, muistutus vanhenee.

### Hälytysten määrä on rajattu kannassa asti

`MAX_ALERTS_PER_REMINDER = 5`, `MAX_SNOOZE_COUNT = 10`.

Loputon toisto on helppo kirjoittaa vahingossa: yksi ehto väärin päin
ja käyttäjän puhelin soi minuutin välein. Sovellus rajaa viiteen; kanta
(`reminders_alert_count_check`) on toinen este saman virheen tiellä.

### Porrastus

Kolme porrasta: **hienovarainen** (60 min ennen), **painokkaampi**
(15 min ennen), **myöhässä**.

Neljäs porras ei lisää tietoa vaan ärsytystä, ja ärsyttävä muistutus
opettaa käyttäjän ohittamaan kaikki muistutukset.

### Orpo muistutus perutaan näkyvästi

`target_id` **ei ole vierasavain**. Kohde voidaan poistaa, ja muistutus
on silti tietue siitä että muistuttaminen oli tarkoitus. Sama perustelu
kuin `transactions.source_id` (0009) ja `ai_action_audit.target_id`
(0008).

`isOrphaned` tunnistaa orvon, ja sovellus **peruu sen näkyvästi** —
hiljaisen katoamisen sijaan. Käyttäjän pitää saada tietää, mitä hänen
poistonsa aiheutti.

Peruttu muistutus jää listaan päätetilassa. Se ei ole poissa, se on
päättynyt.

### Jokainen hälytys kantaa perustelun

`explainAlert` laskee perustelun **todellisista luvuista**:

> Muistutan tästä nyt, koska "Soita hammaslääkärille" alkaa 30 min
> kuluttua.

Hälytys ilman perustelua on käsky, ja käskyyn ei voi olla eri mieltä.

---

## Lähtöaika

```
lähtöaika = saapuminen − matka − valmistautuminen − pysäköinti
```

Vähennyslasku on nimenomainen, ja **jokainen osa näkyy erikseen**:
käyttäjä säätää puskureita erikseen, eikä hän voi korjata lukua jonka
osia hän ei näe.

**Keskiyön yli menevä lähtö siirtää päivää.** Saapuminen klo 08:00 ja
kymmenen tunnin matka tarkoittaa edellisen päivän klo 21:45 — ei saman
päivän aikaa, joka olisi saapumisen jälkeen.

**Myöhässä sanotaan suoraan.** "Lähde nyt" tilanteessa jossa lähtöaika
meni ohi kaksikymmentä minuuttia sitten on epärehellinen. Käyttäjän on
tiedettävä, ettei hän ehdi — jotta hän voi ilmoittaa siitä.

**Käsin kirjattu arvio ei vanhene.** Käyttäjä tietää oman matkansa,
eikä sitä pidä merkitä epäluotettavaksi ajan kulumisen takia.
Palvelun arvio vanhenee puolessa tunnissa, koska ruuhka muuttuu.

---

## Ilmoituskeskus

### Kaksoiskappaleiden esto on kolminkertainen

```
occurrenceKey(reminder, escalation, hetki)   deterministinen avain
        ↓
addNoticeToState(notice)                     sama avain ei mene tilaan kahdesti
        ↓
notices_key_unique (user_id, notice_key)     kanta hylkää rivin
```

Sama muistutus, sama porras, sama minuutti tuottaa saman avaimen.
Taustatarkistus voidaan ajaa niin usein kuin halutaan.

Kolmas este on se, joka tekee estosta **rakenteellisen eikä
sovelluslogiikkaa**: toistuvasti ajettu tarkistus ei voi luoda toista
riviä edes silloin kun sovelluksen oma tarkistus pettäisi.

### Lukematon säilyy kaksi kertaa pidempään

Merkintä, jolle käyttäjä ei ole tehnyt mitään, on juuri se jonka hän
saattoi missata. Sen poistaminen ensin olisi täsmälleen väärin päin.

Kaksi rajaa: **ikä** (30 vrk, lukemattomille 60) ja **määrä** (100).
Ikä hoitaa tavallisen käytön; määrä suojaa poikkeukselta, jossa yksi
päivä tuottaa satoja merkintöjä.

### Vain mielekkäät toiminnot

`actionsFor(notice)` lukee nimenomaisesta kartasta. Ilman sitä
käyttöliittymä tarjoaisi "torkuta" ristiriidalle ja "merkitse tehdyksi"
säästötiedotteelle — toimintoja, joilla ei ole merkitystä eivätkä ne
tee mitään.

### Tämä ei ole tausta-aineistoa

Huomaa ero `aiAudit`-kirjausketjuun: se on tietue siitä mitä tapahtui,
ja sen arvo on siinä että se on olemassa. Selainta sille ei tarvita.

Ilmoitus on eri asia. Se kirjoitetaan nimenomaan käyttäjän luettavaksi,
ja **ilmoitus jota ei näytetä ei ole ilmoitus**.

---

## Komentokeskus: NYT, SEURAAVA ja PIAN

### Järjestyssääntö yhdessä paikassa

```
1. laji       lähtöaika ensin, saapuvat viimeisenä
2. aika       aikaisempi ensin
3. kiireellisyys
4. prioriteetti
5. nimi       takaa determinismin
```

**Lähtöaika on ensimmäinen**, koska se on ainoa asia jonka
myöhästyminen ei ole korjattavissa myöhemmin samana päivänä: bussi
lähtee ilman käyttäjää.

**Saapuvat ovat viimeisenä**, koska ne eivät ole kiireellisiä — ne ovat
kirjattuja juuri siksi, ettei niitä tarvitse ratkaista heti.

**Aika painaa lajin sisällä, ei sen yli.** Myöhässä oleva tehtävä ei
ohita alkavaa kokousta, vaikka se olisi myöhässä viikon.

### Tyhjä on kelvollinen vastaus

Jos mitään ei ole käsillä, `now` on `null` — ei ensimmäinen mahdollinen
tehtävä. Keksitty "nyt" opettaisi käyttäjän epäilemään kaikkia
vastauksia.

### Järjestys on selitettävissä

`explainRanking` kokoaa selityksen **pisteytyksen osista**. Se on sama
tieto, jonka varassa järjestys tehtiin — ei erikseen kirjoitettu
perustelu, joka voisi ajautua siitä erilleen.

### Aamun suunnitelma ei täytä aukkoja

`morningPlan` kertoo mitä päivässä on ja paljonko tilaa jää — ja
jättää päätöksen käyttäjälle. Automaattisesti täytetty päivä on
suunnitelma, jota kukaan ei valinnut.

Ylibuukattu päivä sanotaan suoraan: `freeMinutes` on negatiivinen eikä
nolla.

### Illan katsaus ei merkitse mitään tehdyksi

Se kertoo mitä tapahtui ja **ehdottaa** mitä siirtää. Vain ajaton työ
ehdotetaan siirrettäväksi: ajastettu oli käyttäjän oma päätös, ja sen
siirtäminen on eri asia.

Tyhjä päivä ei tuota valmistumisprosenttia. Nolla prosenttia tyhjästä
päivästä olisi syytös.

---

## Kerrokset

```
src/domain/inbox.js               saapuvien elinkaari
src/domain/capture.js             tulkinnan muoto ja reititys
src/domain/reminder.js            muistutusten tilakone ja porrastus
src/domain/travel.js              lähtöaika ja sijaintisäännöt
src/domain/notificationCenter.js  ilmoitusten elinkaari ja karsinta
src/domain/assistant.js           NYT / SEURAAVA / PIAN
src/domain/risk.js                riskitasot ja kielletyt toimenpiteet

src/ai/captureSchema.js           mallin vastauksen validointi (fail closed)
api/capture.js                    palvelinpuolen välityspalvelin
api/_validateCapture.js           pyynnön validointi

src/data/collectionsRepo.js       viisi repositoriota
src/data/schema.js                viisi porttia — kaikki kiinni

src/app/capture.js                kirjaus, tulkinta, hyväksyntä
src/app/assistantActions.js       muistutukset, ilmoitukset, matka, säännöt
src/app/speechInput.js            puhesovitin: ääni sisään, teksti ulos
src/app/state.js                  viisi kokoelmaa + pendingCapture

src/app/views/inbox.js            kirjauspalkki ja saapuvat
src/app/views/reminders.js        muistutuslista ja lomake
src/app/views/travel.js           matkat ja paikkamuistutukset
src/app/views/notices.js          ilmoituskeskus
```

Riippuvuussuunta on **domain ← sovellus ← näkymä**. Domain ei tuota
tunnisteita, ei lue kelloa eikä tunne `window`ia. Jokainen näistä on
testattu invariantti (`tests/architecture.test.mjs`).

---

## Tekoälyn turvarajat

| Raja | Toteutus | Missä |
|---|---|---|
| Vain sallitut kentät | `ALLOWED_FIELDS` -luettelo | `src/ai/captureSchema.js` |
| Hylätyt kentät kirjataan | `rejectedFields` konsoliin | `src/app/capture.js` |
| Tuntematon → muistiinpano | ei "lähin arvaus" | `validateCaptureResponse` |
| Kielletty toimenpide torjutaan | `FORBIDDEN_INTENTS` | `src/domain/risk.js` |
| Reitti ≠ kutsu | `ROUTE_ACTIONS` -luettelo | `src/app/capture.js` |
| Vahvistus aina | `requiresConfirmation: true` | `src/domain/capture.js` |
| Malli ei näe käyttäjän dataa | vain päivä + ominaisuusliput | `buildCaptureContext` |

**Tuntematon kohde putoaa muistiinpanoksi, ei lähimpään.** Lähin arvaus
näyttäisi täsmälleen yhtä varmalta kuin oikea tulkinta.

**Malli ei saa nähdä käyttäjän tehtäviä.** Kohteen päättelyyn riittää
tieto siitä, mikä päivä tänään on ja mitkä ominaisuudet ovat käytössä.

---

## Kanta

Migraatio `0011_personal_assistant.sql` — **EI AJETTU**.

| Taulu | Mitä |
|---|---|
| `inbox_items` | kirjaukset ja niiden tulkinta |
| `reminders` | muistutukset |
| `notices` | ilmoitushistoria |
| `travel_plans` | matkat ja lähtöajat |
| `location_rules` | paikkamuistutukset (sääntöinä) |

Viisi uutta tyhjää taulua. **Yhtäkään olemassa olevaa saraketta,
rajoitetta, indeksiä tai riviä ei muuteta.** Migraation vaihe 6
todistaa sen ennen committia laskemalla `tasks`-, `goals`- ja
`projects`-taulujen politiikat.

Tämä on tietoinen ero migraatioon `0010`, joka muutti kolmea taulua
joissa on käyttäjän dataa. Kaikki migraatiot eivät ole yhtä
riskialttiita, ja se on syytä sanoa ääneen.

Varmistus: `supabase/verify/verify_0011.sql` — 64 tarkistusta, vain
lukeva.

---

## Mitä tuotantoon vieminen vaatii

1. Panun kirjallinen hyväksyntä migraatiolle `0011`
2. Varmuuskopio
3. Migraation esitarkistus (vain lukeva, tiedoston lopussa)
4. Migraation ajo `postgres`-roolilla
5. `verify_0011.sql` → **poikkeavia_yhteensa = 0**
6. Aallon H deploy: `docs/acceptance/WAVE-H.md`

Aalto H on julkaisujunan viimeisenä. Ks. myös
`docs/RELEASE-SEQUENCING.md` — junan numerointi ei ole ratkaistu, ja
välimuistiversio **ei koskaan saa laskea**.

---

## Testit

| Tiedosto | Testejä | Mitä |
|---|---|---|
| `tests/assistant-inbox.test.mjs` | 52 | saapuvat ja reititys |
| `tests/assistant-reminders.test.mjs` | 67 | tilakone, porrastus, torkku |
| `tests/assistant-travel.test.mjs` | 48 | lähtöaika, arviot, säännöt |
| `tests/assistant-notices.test.mjs` | 40 | kaksoiskappaleet, säilytys |
| `tests/assistant-today.test.mjs` | 43 | NYT, SEURAAVA, PIAN |
| `tests/assistant-ui.test.mjs` | 32 | turvarajat, portit, runko |

Kaikki domain-testit ovat **kellottomia**: jokainen antaa hetken itse,
eikä yksikään käytä `Date.now()`. Sama syöte tuottaa saman tuloksen, ja
se tekee niistä testattavia ilman ajastimia ja ilman laitetta.

---

## Jäljelle jäävät asiat

Nämä vaativat laitteen, eikä niitä voi todentaa selaimessa. Ks.
`docs/DEVICE-ACCEPTANCE-BACKLOG.md`.

1. **Taustaherätys** — muistutus lasketaan vain sovelluksen ollessa auki
2. **Puheentunnistus eri alustoilla** — tuki vaihtelee selaimittain
3. **Matka-aikapalvelu** — sopimus on kuvattu, toteutusta ei ole
4. **Geoaita** — sääntö on dataa; toteutus vaatii laiteluvan
5. **Ulkoinen kalenteri** — sovitin on kuvattu, toteutusta ei ole
