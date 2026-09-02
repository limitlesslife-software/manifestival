# Modularisointi

Tila: **IMPLEMENTED** (WP2). Suunnitelma laadittu ennen siirtoa, tämä dokumentti
kuvaa lopputuloksen.

---

## Lähtötilanne

`index.html` WP1:n jälkeen: **1 154 riviä**, josta

| Vyöhyke | Riviä |
|---|---|
| CSS `<style>` | 150 |
| HTML + inline SVG | 227 |
| JS `<script type="module">` | 773 |

Kaikki sovelluslogiikka eli yhdessä sulkeumassa, jossa oli kaksi jaettua
muuttuvaa tilaa (`state`, `authUser`) ja 29 hajallaan olevaa
tapahtumankuuntelijaa. Mikään kerros ei ollut testattavissa ilman selainta.

---

## Riippuvuuskartta ennen refaktorointia

Kartoitettu lukemalla koko `<script>`-lohko. Nuoli = "käyttää".

```
CATEGORIES, WD_*, MONTHS ─────┐
catLabel, capitalize          │  formatointi
escapeHtml (tarvitsee DOM)    │
                              v
sb (Supabase client) ── SUPABASE_URL, SUPABASE_ANON_KEY
   ^
   │
requireUserId ── authUser
   ^
   │
loadTasks, loadProfile, saveProfile, clearOtherWakeFlags,
toggleComplete, deleteTask, addTask, updateTask
   │        │
   │        └──> state.tasks (suora mutaatio)
   │        └──> renderAll (renderöinti datakerroksesta!)
   v
state ─────> findWorkAnchor ──> computeAutoWakeTime ──> computeAutoBedtimeTonight
                                      │                        │
                                      └──> getDisplayItemsForDate <──
                                                   │
                                                   v
renderToday ──> renderTimeline ──> DOM + event listeners
renderWeek  ──> renderGroupedList ──> attachListHandlers ──> toggleComplete/deleteTask
renderTasks ──> renderGroupedList
openEditForm ──> switchTab ──> DOM

startVoiceFlow ──> handleTranscript ──> parseWithClaude ──> fetch /api/parse
                                              │
                                              └──> fillConfirmForm ──> addTask

init ──> sb.auth ──> enterApp/leaveApp ──> loadUserData ──> renderAll
```

### Todetut ongelmat

1. **Datakerros kutsui renderöintiä.** `addTask` mutatoi tilaa, kutsui
   `renderAll()` ja teki verkkokutsun — kolme vastuuta yhdessä funktiossa.
2. **Aikataululogiikka luki globaalia tilaa suoraan.** `computeAutoWakeTime`
   luki `state.tasks` ja `state.profile`, joten sitä ei voinut testata.
3. **Kirjoitusvirheet katosivat.** Jokainen kirjoitus päättyi
   `.then(({error}) => console.error(...))` — käyttäjä ei nähnyt mitään.
4. **Optimistinen päivitys ilman perumista.** UI päivittyi ennen kirjoitusta
   eikä palautunut, jos kirjoitus epäonnistui. UI valehteli onnistumisesta.
5. **Renderöinti liitti kuuntelijat uudelleen joka kerta** (`attachListHandlers`).
   Toimi, koska `innerHTML` korvasi elementit, mutta kytkös oli hauras.
6. **Ei erottelua käyttäjälle näytettävän ja diagnostisen virheen välillä.**

---

## Moduulirajat

Periaate: **riippuvuudet osoittavat aina alaspäin.** Ylempi kerros saa käyttää
alempaa, ei koskaan toisin päin. Tämä estää syklit rakenteellisesti.

```
  app/          selain, DOM, tapahtumat, elinkaari
    │
    v
  ui/           yleiset DOM-apuvälineet (ei sovelluslogiikkaa)
    │
    v
  ai/  data/    verkko: Anthropic-proxy, Supabase
    │
    v
  domain/       puhdas liiketoimintalogiikka (ei DOM, ei verkkoa)
    │
    v
  lib/          puhtaat apufunktiot (ei DOM, ei verkkoa, ei domain-tietoa)
```

### Kerrokset

| Kerros | Saa käyttää | EI saa käyttää | Testattavuus |
|---|---|---|---|
| `lib/` | ei mitään | DOM, verkko, domain | Suora yksikkötesti |
| `domain/` | `lib/` | DOM, verkko | Suora yksikkötesti |
| `data/` | `lib/`, `domain/` | DOM | Testataan sopimustesteillä |
| `ai/` | `lib/`, `domain/` | DOM | Skeemavalidointi testattavissa |
| `ui/` | `lib/` | `domain/`, `data/` | Staattiset testit |
| `app/` | kaikki | — | Staattiset arkkitehtuuritestit |

---

## Lopullinen rakenne

```
index.html                     HTML-runko + entrypoint (ei logiikkaa)
src/
  styles.css                   Kaikki tyylit
  lib/
    datetime.js                Päivämäärä-/aikafunktiot
    format.js                  escapeHtml, capitalize, viikonpäivät, kuukaudet
    rows.js                    Kanta <-> domain -rivimuunnos, scoping-suojat
    result.js                  AppError: käyttäjäviesti erillään diagnostiikasta
  domain/
    categories.js              Kategoriat yhtenä lähteenä
    priority.js                Prioriteettimalli ja järjestys
    task.js                    Tehtävän normalisointi, validointi, järjestys
    week.js                    Viikkorajat ja ryhmittely
    scheduler.js               Deterministinen aikataulumoottori (puhdas)
  data/
    config.js                  Supabase-osoite ja julkinen anon-avain
    schema.js                  Skeemakyvykkyydet (migraatioportit)
    client.js                  Supabase-clientin luonti
    session.js                 Kirjautunut käyttäjä, requireUserId
    tasksRepo.js               tasks-taulun CRUD
    profileRepo.js             profile-taulun luku/kirjoitus
    preferences.js             Laitekohtaiset asetukset (localStorage)
  ai/
    proposalSchema.js          AI-ehdotuksen tiukka validointi (jaettu palvelimen kanssa)
    parseClient.js             /api/parse -kutsu
  ui/
    dom.js                     el, on, show, hide, setBusy
    toast.js                   Keskitetty ilmoitus käyttäjälle
    confirm.js                 Vahvistusdialogi
  app/
    state.js                   Sovelluksen tila ja tilaan kohdistuvat muutokset
    auth.js                    Kirjautumisvirta
    navigation.js              Välilehdet ja näkymänvaihto
    onboarding.js              Ensikäytön opastus
    voice.js                   Puheohjaus ja AI-ehdotuksen vahvistus
    views/
      today.js                 Päivänäkymä ja aikajana
      week.js                  Viikkonäkymä
      tasks.js                 Tehtävälista ja lomake
      profile.js               Profiili ja asetukset
    main.js                    Bootstrap: kytkee kaiken yhteen
```

`index.html` sisältää enää HTML-rungon, SVG-symbolikirjaston,
tyylitiedoston linkin ja yhden entrypointin.

---

## Mitä refaktoroinnissa korjattiin

| Ongelma | Ratkaisu |
|---|---|
| Datakerros kutsui renderöintiä | `data/`-repositoriot palauttavat arvon. Renderöinnin laukaisee `app/`-kerros. |
| Scheduler luki globaalia tilaa | `domain/scheduler.js` ottaa kaiken parametreina ja on puhdas funktio. |
| Hiljaiset kirjoitusvirheet | Repositoriot palauttavat `AppError`-olion; `app/` näyttää sen toastina. |
| Optimistinen päivitys ilman perumista | Epäonnistunut kirjoitus **palauttaa** aiemman tilan ja kertoo siitä. |
| Ei tuplaklikkaussuojaa | `ui/dom.js:setBusy` + `app/state.js`-tason lukot. |
| Kategoriat kahdessa paikassa | `domain/categories.js` on ainoa lähde; myös lomakkeet renderöidään siitä. |

---

## Regressiosuoja

Refaktorointi tehtiin testit edellä. Uudet arkkitehtuuritestit
(`tests/architecture.test.mjs`) valvovat pysyvästi:

- `index.html` ei sisällä sovelluslogiikkaa (ei `function`-määrittelyjä)
- kerrosjärjestys pitää: `lib/` ei importoi ylöspäin, `domain/` ei koske DOM:iin
  eikä verkkoon, `ui/` ei importoi `domain/`- tai `data/`-moduuleja
- ei syklisiä riippuvuuksia (koko importgraafi käydään läpi)
- jokainen DOM-id, johon koodi viittaa, on olemassa `index.html`:ssä
- jokainen `sb.from('tasks')`-kutsu on käyttäjärajattu
- salaisuuksia ei esiinny missään lähdetiedostossa

---

## Mitä EI tehty

- **Ei framework-migraatiota.** Ei Reactia, ei bundleria, ei käännösvaihetta.
  Selain lataa moduulit sellaisenaan, Vercel tarjoilee ne staattisesti.
- **Ei visuaalisia muutoksia.** Paletti, typografia ja asettelu ovat ennallaan.
- **Ei DOM-id:iden uudelleennimeämistä.** Kaikki tunnisteet säilyivät, jotta
  refaktorointi ei piiloudu kosmeettisten muutosten sekaan.
