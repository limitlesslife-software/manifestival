# Aalto H — Henkilökohtainen avustaja: kirjaus, muistutukset ja matka

**Portit:** `inboxItems`, `reminders`, `notices`, `travelPlans`, `locationRules`
**Taulut:** `inbox_items`, `reminders`, `notices`, `travel_plans`, `location_rules`
**Välimuistiversio:** `v21`
**Edellinen tuotanto:** aallon G commit (v20)
**Peruutuskohde:** aalto G

Aallon commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`.

---

## VALMIUS: ESTETTY

**Tätä aaltoa ei saa deployata.** Este on kaksinkertainen, ja molemmat
puolet on purettava erikseen.

### Este 1 — kantaa ei ole

Migraatiota `0011_personal_assistant.sql` ei ole ajettu tuotantoon.
Portin avaaminen tauluun jota ei ole kaataa jokaisen kirjoituksen
virheeseen `42P01`.

### Este 2 — käyttöliittymää ei ole

Tämä on se puoli, joka erottaa aallon H kaikista aiemmista.

| Portti | Domain | Repositorio | Näkymä |
|---|---|---|---|
| `inboxItems` | `src/domain/inbox.js` | on | **ei** |
| `reminders` | `src/domain/reminder.js` | on | **ei** |
| `notices` | `src/domain/notificationCenter.js` | on | **ei** |
| `travelPlans` | `src/domain/travel.js` | on | **ei** |
| `locationRules` | `src/domain/travel.js` | on | **ei** |

Portti avaa **tallennuksen**. Se ei luo näkymää. Viiden portin
avaaminen ilman käyttöliittymää tekisi kannasta paikan, johon ei
kirjoita kukaan — tai pahempaa, johon kirjoitetaan eikä kukaan lue.

Kirjaus ilman lukemista on tiedon nielu. Tallennettu muistutus, jota ei
näytetä, on lupaus jota ei pidetä.

Valmiustilaa **ei kirjoiteta käsin**: `tests/ui-reachability.test.mjs`
johtaa sen `tools/release/reachability.mjs` -matriisista. Kun näkymät
rakennetaan, tämä tiedosto, matriisi ja `tools/release/waves.mjs`
muuttuvat samassa committissa — tai testi kaatuu.

---

## Mitä esteen purkaminen vaatii

1. **Viisi näkymää**, jokainen tavoitettavuusmatriisissa todistettuna
2. Panun kirjallinen hyväksyntä migraatiolle `0011`
3. **Varmuuskopio**
4. Migraation esitarkistus (vain lukeva, tiedoston lopussa) — erityisesti:
   - `uudet_taulut` = **0**
   - `tasks_omistajan_avain` = **1**
   - `pg15_tai_uudempi` = **true**
5. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
6. `supabase/verify/verify_0011.sql` → **poikkeavia_yhteensa = 0**

---

## Miksi tämä migraatio on VÄHEMMÄN vaarallinen kuin 0010

Se on syytä sanoa ääneen: kaikki migraatiot eivät ole yhtä
riskialttiita, eikä sama varovaisuus sovi jokaiseen.

Migraatio `0010` **muutti kolmea taulua**, joissa on käyttäjän oikeaa
dataa ja joiden portit ovat auki tuotannossa. Se korvasi
`goals_status_check` -rajoitteen ja otti `ACCESS EXCLUSIVE` -lukkoja.

Migraatio `0011` **luo viisi uutta tyhjää taulua eikä muuta yhtäkään
olemassa olevaa saraketta, rajoitetta, indeksiä tai riviä.** Ainoa
kosketus vanhaan on lukko `tasks`-tauluun kahden yhdistelmävierasavaimen
luonnin ajaksi.

Migraation vaihe 6 **todistaa tämän ennen committia**: se laskee
`tasks`-, `goals`- ja `projects`-taulujen politiikat ja keskeyttää, jos
luku ei ole 12.

Ajon kesto on käytännössä välitön.

---

## NELJÄ ASIAA, JOITA TÄMÄ AALTO EI TEE

### 1. Koordinaatteja ei tallenneta

`origin`, `destination` ja `place` ovat **käyttäjän kirjoittamia
nimiä**. Kannassa ei ole yhtään koordinaattisaraketta, eikä sellaista
saa lisätä.

Koordinaatti kannassa olisi koordinaatti varmuuskopiossa, viennissä ja
mahdollisessa vuodossa. Sijaintihistoria kertoo missä ihminen asuu,
työskentelee ja käy — eikä lähtöajan laskenta tarvitse siitä mitään.

`verify_0011.sql` **tarkistus 12** etsii niitä sarakenimistä suoraan.
Se on ainoa tarkistus koko tiedostossa, joka etsii jotain mitä **ei saa
olla**.

### 2. Geoaitaa ei ole

`locationRules` on **sääntö, ei toteutus**. Sääntö on dataa, jota
voidaan mallintaa ja testata simuloiduilla sijainneilla. Oikeaa
sijaintiseurantaa ei ole eikä sitä voi luvata ilman laitehyväksyntää.

`active` on kannassa oletuksena **epätosi**: sijainti vaatii luvan,
eikä lupaa oleteta.

### 3. Matka-aikaa ei haeta mistään

`hasTravelProvider()` palauttaa `false`. Kun kestoa ei tiedetä,
`travel_minutes` on **NULL** eikä nolla — nolla tarkoittaisi että
ollaan jo perillä, ja siitä laskettu lähtöaika olisi vale.

Tuntematon kesto **näytetään tuntemattomana**. Rajoite
`travel_plans_unknown_source_check` estää kantatasolla sen, että
puuttuva arvio väittäisi olevansa mitattu.

### 4. Ääntä ei tallenneta

`inbox_items.source` kertoo, tuliko rivi puheesta. Itse äänitallennetta
ei kirjoiteta mihinkään. Puheesta tullut rivi kantaa **litteroinnin**,
koska litterointi on silloin se mitä käyttäjä sanoi.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon G SHA
npm run activation:verify-wave -- H
npm run activation:preflight -- --wave=H
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Viisi näkymää on rakennettu ja tavoitettavuusmatriisi päivitetty**
- [ ] **Migraatio 0011 on ajettu ja `verify_0011.sql` antoi 0 poikkeavaa**
- [ ] **Varmuuskopio on otettu ennen migraatiota**
- [ ] Kaikki kahdeksantoista porttia auki
- [ ] `TASK_EXTENDED_FIELDS` yhä `true`
- [ ] `GOAL_PLANNING_FIELDS` yhä `true`
- [ ] `CACHE_VERSION` on `v21`

### Diffin tarkistus

```
git diff <WAVE-G-SHA>..<WAVE-H-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin <WAVE-H-SHA>:main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=H
```

- [ ] HTTP 200, `CACHE_VERSION` `v21`
- [ ] Kaikki kahdeksantoista porttia `true`

---

## 4. Selainhyväksyntä

Jokainen kohta tarkistetaan **sivun latauksen jälkeen** — se on ainoa
tapa erottaa tallennus muistista.

### Ensin: mikään ei saa olla rikki

- [ ] Tehtävän luonti, muokkaus ja poisto toimivat
- [ ] Tavoitteet, projektit ja välitavoitteet toimivat
- [ ] Talouden näkymät toimivat
- [ ] Vanhat rivit näkyvät ennallaan

### Kirjaus ja saapuvat

- [ ] Kirjaa vapaa teksti → rivi ilmestyy Saapuvat-näkymään
- [ ] Rivi säilyy latauksen yli
- [ ] Tulkinta näytetään **ehdotuksena**, ei valmiina muutoksena
- [ ] Hylkää ehdotus → **mitään ei synny**
- [ ] Hyväksy → tehtävä syntyy ja rivi merkitään muunnetuksi
- [ ] Paina hyväksyntää kahdesti → **vain yksi tehtävä syntyy**
- [ ] Hylätty rivi voidaan palauttaa käsittelemättömäksi
- [ ] Muunnettua riviä **ei** voi palauttaa

### Muistutukset

- [ ] Luo muistutus tehtävälle → säilyy latauksen yli
- [ ] Torkuta muistutus → **kohteen määräaika ei muutu**
- [ ] Kuittaa muistutus → ei toistu
- [ ] Poista kohde → muistutus **perutaan näkyvästi**, ei katoa hiljaa
- [ ] Sama hälytys kahdesti → **vain yksi ilmoitus**

### Ilmoituskeskus

- [ ] Ilmoitukset näkyvät uusin ensin
- [ ] Lukemattomat erottuvat luetuista
- [ ] Ilmoituksesta pääsee sen kohteeseen
- [ ] Ilmoituksen kuittaus säilyy latauksen yli

### Matka ja lähtöaika

- [ ] Luo matkasuunnitelma ilman kestoa → lähtöaika näkyy
      **tuntemattomana**, ei kellonaikana
- [ ] Kirjaa kesto käsin → lähtöaika lasketaan
- [ ] Valmistautumis- ja puskuriminuutit vaikuttavat lähtöaikaan
- [ ] Liitä matka tehtävään, poista tehtävä → **matka säilyy**, liitos katkeaa

### Sijaintisäännöt

- [ ] Uusi sääntö on oletuksena **pois päältä**
- [ ] Säännön kytkeminen päälle kysyy sijaintiluvan
- [ ] Luvan epääminen ei riko mitään muuta

### Aiemmat aallot

- [ ] Aaltojen A–G ominaisuudet toimivat kaikki yhä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0009.sql` → **poikkeavia_yhteensa = 0**
4. `verify_0010.sql` → **poikkeavia_yhteensa = 0**
5. `verify_0011.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0011) | Odotus |
|---|---|
| 12 — yhdessäkään taulussa ei ole koordinaattisaraketta | PASS |
| 15 — `location_rules.active` on oletuksena epätosi | PASS |
| 19 — `travel_minutes` on nullable kokonaisluku | PASS |
| 27 — `notices_key_unique` kattaa kaksi saraketta | PASS |
| 28 — vierasavaimet viittaavat kahdella sarakkeella | PASS |
| 29 — SET NULL rajaa nollauksen yhteen sarakkeeseen | PASS |
| 30 — kohdetunniste ei ole vierasavain | PASS |
| 40 — PUBLIC-roolilla ei ole oikeuksia | PASS |
| 54 — `tasks`, `goals` ja `projects` yhä 12 politiikkaa | PASS |
| 56–64 — rivimäärät ja ympäristö | INFO |

> **Tarkistus 12** on se, jota ei saa ohittaa. Sarakelistojen
> huolimaton päivitys tekisi sijaintihistoriasta sallittua hiljaa, ja
> tämä on ainoa kohta joka sanoo ääneen mitä etsitään.
>
> **Tarkistus 54** todistaa, ettei migraatio koskenut olemassa oleviin
> tauluihin. Migraatio itse todisti saman ennen committia; tämä toistaa
> sen jälkikäteen riippumattomasti.

---

## 6. Peruutus

**Laukaisin:**

- kirjatun rivin tallennus epäonnistuu
- muistutus hälyttää toistuvasti tai ei lainkaan
- torkutus siirtää kohteen määräaikaa
- sama ilmoitus ilmestyy kahdesti
- lähtöaika näytetään vaikka kestoa ei tiedetä
- sijaintisääntö aktivoituu ilman käyttäjän lupaa
- `failures_total > 0` tai `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-H-SHA>
# revert-commitissa: nosta CACHE_VERSION v21 -> v22
git push origin HEAD:main
```

Palauttaa **aallon G** tilan.

> **Kantaa ei peruuteta ensin.** Porttien sulkeminen riittää: taulut
> jäävät paikoilleen ja sovellus lakkaa kirjoittamasta niihin.
>
> Kannan peruutus on erikseen migraatiotiedoston lopussa, ja se on
> tässä poikkeuksellisen yksinkertainen, koska migraatio ei koskenut
> olemassa olevaan dataan. **Se poistaa rivit pysyvästi:** jos portit on
> ehditty avata ja käyttäjä on kirjannut saapuvia tai muistutuksia, ne
> katoavat. Sulje portit ensin ja ota varmuuskopio.

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto H ja viisi porttia
- [ ] `docs/PERSONAL-ASSISTANT-CORE.md` päivitetty: tila ESTETTY → tuotannossa
- [ ] `docs/UI-REACHABILITY.md` päivitetty: viisi riviä **EI** → **ON**
- [ ] Peruutusta ei ole voimassa

### Jäljelle jäävät asiat

1. **Taustaherätys** — muistutus lasketaan vasta kun sovellus on auki.
   Todellinen ajastin vaatii laitehyväksynnän.
2. **Puhesyöte** — sovitin on kuvattu; selaimen tunnistus vaihtelee
   alustoittain eikä sitä voi luvata ilman laitehyväksyntää.
3. **Matka-aika-palvelu** — `hasTravelProvider()` palauttaa `false`.
   Kestoa ei haeta mistään, ja tuntematon näytetään tuntemattomana.
4. **Geoaita** — sääntö on dataa; toteutus vaatii laitehyväksynnän.
5. **Laitehyväksyntä** — `docs/DEVICE-ACCEPTANCE-BACKLOG.md`
