# Arkkitehtuuri

Tila: WP2:n jälkeen. Päivitetty 1.9.2026.

---

## Yleiskuva

```
┌──────────────────────────────────────────────────────────────┐
│ index.html — RUNKO (250 riviä)                               │
│   merkintä · SVG-ikonit · <link styles.css> · <script main.js>│
│   EI sovelluslogiikkaa. Tämä on testattu invariantti.        │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ src/app/     selain, DOM, tapahtumat, elinkaari              │
│   main.js      bootstrap: kytkennät kerran, tilaus, istunto  │
│   state.js     tila + tilaajat                               │
│   actions.js   optimistinen päivitys + peruutus              │
│   auth.js  navigation.js  voice.js  onboarding.js            │
│   notifications.js  domainin ja alustan ainoa kohtaamispiste │
│   views/  today · week · tasks · routines · goals            │
│           profile · notificationSettings                     │
├──────────────────────────────────────────────────────────────┤
│ src/ui/      dom · toast · confirm     (ei tunne domainia)   │
├──────────────────────────────────────────────────────────────┤
│ src/ai/      proposalSchema · parseClient · intentSchema     │
│ src/data/    client · session · tasksRepo · profileRepo      │
│              collectionsRepo · notificationPrefsRepo         │
│              memoryStore · schema (migraatioportti)          │
│ src/platform/ capabilities · notifications                   │
│              nativeNotifications (Capacitor)                 │
├──────────────────────────────────────────────────────────────┤
│ src/domain/  task · scheduler · week · categories · priority │
│              routine · goal · project · focus · review       │
│              notification · wellbeing · finance              │
│              PUHDAS: ei DOM:ia, ei verkkoa, ei kelloa        │
├──────────────────────────────────────────────────────────────┤
│ src/lib/     datetime · format · rows · result · seed        │
│              PUHDAS: ei riippuvuuksia                        │
└──────────────────────────────────────────────────────────────┘
```

**Riippuvuudet osoittavat aina alaspäin.** Sääntö on koodattu
`tests/architecture.test.mjs`-testeihin, jotka kaatuvat heti jos domain alkaa
koskea DOM:iin tai jos moduulien väliin syntyy sykli.

### Kolme kerrosta, kolme vastuuta — esimerkkinä muistutukset

Muistutukset ovat selkein esimerkki siitä, miksi kerrosjako on olemassa:

```
domain/notification.js    MITÄ ja MILLOIN   puhdas, testattava ilman selainta
app/notifications.js      MILLOIN SYNKRONOIDAAN
platform/notifications.js MITEN             selain tai Capacitor
```

Domain ei tunne Capacitoria eikä `Notification`-rajapintaa. Alusta ei tunne
tehtäviä eikä rutiineja. Kumpikin on testattavissa yksin, ja niiden välinen
kerros on ohut tarkoituksella.

Sama jako toistuu muualla: aikataulumoottori ei tiedä DOM:ista, ja
tallennuskerros ei tiedä renderöinnistä.

---

## Miksi ei frameworkia

Sovellus on tarkoituksella ilman frameworkia, bundleria ja käännösvaihetta:
selain lataa moduulit sellaisenaan ja Vercel tarjoilee ne staattisesti.

Vaihtoehto arvioitiin WP2:ssa. Framework-migraatio ei olisi ratkaissut
yhtäkään todetuista ongelmista (autentikaatio, RLS, virheenkäsittely, testit),
joten se lykättiin. **Modularisointi ratkaisi ne ilman uutta riippuvuutta.**

Päätös arvioidaan uudelleen, jos näkymien määrä kasvaa selvästi tai
komponenttien uudelleenkäytölle syntyy todellinen tarve.

---

## Tilanhallinta

Yksi store, yksi paikka muutoksille.

```js
state = {
  tasks, viewDate, weekStart, profile, profileExists,
  editingId, screen, loading
}
```

`src/app/state.js` julkaisee muutokset tilaajille. Näkymät tilaavat
`subscribe()`-funktiolla, joten yksikään toiminto ei joudu muistamaan kutsua
`renderAll()`. Ennen tätä datakerros kutsui renderöintiä itse.

Kirjautuneen käyttäjän identiteetti on erikseen `src/data/session.js`:ssä.
`requireUserId()` **heittää poikkeuksen** ilman kirjautumista, joten rajaamaton
kysely kaatuu ennen kuin se lähtee verkkoon.

---

## Optimistinen päivitys ja peruutus

Tämä on `src/app/actions.js`:n keskeisin vastuu.

```
1. talleta nykytila
2. päivitä käyttöliittymä heti          (nopea tuntuma säilyy)
3. kirjoita kantaan
4. jos kirjoitus epäonnistuu:
     PALAUTA aiempi tila
     näytä käyttäjälle ymmärrettävä virhe
```

Aiemmin vaihe 4 puuttui kokonaan: virhe meni `console.error`iin ja näyttö jäi
valehtelemaan onnistumisesta. Nyt jokainen kirjoituspolku peruuttaa itsensä ja
tämä on testattu.

---

## Virheiden käsittely

`src/lib/result.js` pakottaa erottelun:

| | |
|---|---|
| `AppError.userMessage` | Lyhyt suomenkielinen viesti käyttäjälle |
| `AppError.toDiagnostic()` | Koodi + syy + Supabasen yksityiskohdat konsoliin |

Repositoriot palauttavat `{ ok, value }` tai `{ ok, error }` — ne eivät
koskaan heitä Supabasen viestiä eteenpäin. `src/ui/toast.js` näyttää
käyttäjäviestin ja lokittaa diagnostiikan.

---

## Näkymät ja navigaatio

| Näkymä | Sisältö |
|---|---|
| Kirjautuminen `#authGate` | Kirjaudu / luo tili, virhe- ja lataustilat |
| Tänään | Aikajana, aikatauluttamattomat, vapaat välit, tehdyt |
| Viikko | Viikkonauha kuormituksella + päivittäin ryhmitelty lista |
| Tehtävät | Koko lista, lisäys- ja muokkauslomake |
| Profiili | Henkilötiedot, aikatauluparametrit, esikatselu, uloskirjautuminen |

Navigointi on alapalkin välilehdillä. Piilotettu näkymä saa `inert`- ja
`aria-hidden`-määreet, joten se on poissa sekä sarkainjärjestyksestä että
ruudunlukijalta.

**Tapahtumakytkennät tehdään tasan kerran** käynnistyksessä (`init*`-funktiot).
Renderöinti korvaa vain listojen sisällön, joten kuuntelijat eivät kasaannu.
Tämä on testattu invariantti.

---

## Automaattinen aikataululogiikka

Merkittävä osa arvosta syntyy laskennasta, jota **ei tallenneta kantaan**.
`domain/scheduler.js` on puhdas funktio ja siksi kattavasti testattavissa.

Yksityiskohdat: `docs/DOMAIN-MODEL.md`.

---

## Offline-malli

`sw.js` toteuttaa **vain sovelluskuoren** offline-toiminnan: sivu avautuu,
käyttöliittymä latautuu ja käyttäjälle kerrotaan näkyvästi, ettei verkkoa ole.

**Tämä ei ole offline-synkronointi.** Tehtäviä ei jonouteta eikä lähetetä
myöhemmin.

### Miksi ei

Offline-kirjoitus ilman konfliktimallia on vaarallisempi kuin sen puuttuminen:
käyttäjä luulisi tallentaneensa jotain, mitä ei tallennettu. Sama tehtävä voisi
muuttua kahdella laitteella, eikä järjestelmällä olisi sääntöä siitä kumpi
voittaa.

### Mitä myöhempi offline-synkronointi vaatisi

1. **Muutosloki, ei tilan kopiointi.** Jono operaatioista (`lisää`, `muuta`,
   `poista`) aikaleimoineen — ei "viimeisin kirjoitus voittaa" koko riville.
2. **Palvelinpuolen aikaleimat.** Migraatio 0002 lisää `updated_at`-sarakkeen
   ja triggerin; laitteen kelloon ei voi luottaa.
3. **Konfliktisääntö per kenttä.** Kuittaus ja ajan muutos ovat eri asioita:
   toinen voi sulautua, toinen vaatii käyttäjän valinnan.
4. **Näkyvä synkronointitila.** Käyttäjän pitää nähdä mikä on tallennettu ja
   mikä odottaa.
5. **Poiston käsittely.** Poistettu rivi ei saa palata toiselta laitteelta.

Tämä on oma työpakettinsa, ei sivutuote.

### Service workerin valinnat

| Valinta | Miksi |
|---|---|
| Network-first | Ei sisältötiivisteitä tiedostonimissä; cache-first jättäisi vanhan `index.html`:n uusien moduulien kanssa |
| Ei `skipWaiting` | Moduulit eivät saa vaihtua kesken istunnon |
| Vain oma origin | Supabase-vastauksissa on henkilökohtaista dataa — ei laitteelle |
| Ei `/api/*` | Palvelinkutsuja ei koskaan tarjoilla välimuistista |
| Vain GET | Kirjoituksia ei toisteta |
| Versioitu välimuisti | Vanhat siivotaan aktivoinnissa |

---

## Alustasovittimet

`src/platform/` on **ainoa kohta, jossa web ja natiivi eroavat**.

| Sovitin | Web | Natiivi (PLANNED) |
|---|---|---|
| `speech` | Selaimen puheentunnistus (toimii) | Natiivi, myös taustalla |
| `notifications` | Lupa-API (osittain) | Ajastetut natiivi-ilmoitukset |
| `location` | Ei toteutusta | Taustasijainti |
| `background` | Ei mahdollinen | Taustatehtävät |
| `apiUrl()` | Suhteellinen polku | Tuotannon absoluuttinen osoite |

Toteuttamattomat sovittimet **kertovat sen rehellisesti** (`supported: false` ja
syy) sen sijaan että epäonnistuisivat hiljaa. Käyttöliittymä voi näin piilottaa
ominaisuuden.

`apiUrl()` on esimerkki todellisesta alustaerosta: natiivikuoressa sivu
ladataan laitteelta, joten suhteellinen `/api/parse` osuisi paikalliseen
kuoreen eikä koskaan palvelimeen.

---

## Skeemaportti

`src/data/schema.js` ratkaisee ongelman, jossa domain on migraatiota edellä.

Domain ja käyttöliittymä tukevat kuvausta, kestoa, prioriteettia ja
aikataulutuksen tilaa. Tuotannon tietokannassa niitä ei vielä ole. Ilman
porttia jokainen tallennus epäonnistuisi olemattomaan sarakkeeseen.

```js
export const TASK_EXTENDED_FIELDS = false;   // PRODUCTION GATE
```

Migraation 0002 jälkeen tämä vaihdetaan arvoon `true`. Se on tarkoituksella
**yhden rivin muutos**: kaikki muu koodi on jo valmiina.

Käyttöliittymä kertoo käyttäjälle rehellisesti, että nämä kentät näkyvät vain
istunnon ajan — se ei teeskentele tallentavansa niitä.

---

## Android

Capacitor-kuori, joka ajaa **saman koodin**. Ei toista koodikantaa.
Ks. `docs/ANDROID-STRATEGY.md`.

`dist/` on olemassa vain Androidia varten: Capacitor kopioi `webDir`-hakemiston
APK:hon. Web-tuotanto ei käytä sitä lainkaan.

---

## Seuraavat rakenteelliset askeleet

| Askel | Työpaketti |
|---|---|
| Toistuvien rutiinien moottori (`domain/routine.js`) | WP5 |
| Ilmoitusten ajastus alustasovittimen kautta | WP6 |
| Tavoitteet ja niiden kytkentä tehtäviin | WP7 |
| Natiivitoteutus `platform/capacitor.js` | WP12 |
