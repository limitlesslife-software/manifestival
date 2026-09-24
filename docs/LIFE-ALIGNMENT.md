# Suunta (Life Alignment)

**Tila:** ensimmäinen pystyviipale rakennettu paikallisesti, haara
`feature/life-alignment-foundation`. Migraatio `0012` **EI AJETTU**; portit
kiinni, joten tieto elää istunnon muistissa ja näkymä sanoo sen.

> Käyttäjä kertoo mikä on tärkeää ja paljonko ehtii. Suunta näyttää, missä
> suunnitelma ja todellisuus poikkeavat siitä — ja käyttäjä päättää mitä
> muuttaa. Sovellus ei päätä arvoja, tärkeyttä eikä suuntaa.

Ketju: **Elämänalueet → Tavoitteet → Kapasiteetti → Tekeminen →
Toteuma / havainnot → Viikkokatsaus → Muutokset ensi viikolle**.

---

## Mallin valinnat ja miksi

| Käsite | Esitys | Miksi |
|---|---|---|
| Elämänalue | Käyttäjän oma rivi (`life_areas`), ei oletusalueita | Sovellus ei päätä mikä on tärkeää. Ehdotukset ovat aloitusapu |
| Tärkeys | 1–5 nimettynä ("Vähän tärkeä" … "Erittäin tärkeä") | Strateginen tärkeys, ei kiire. Ei näennäistarkkuutta |
| Toivottu huomio | **Minuutteja viikossa** (`target_minutes_per_week`); `null` = ei asetettu, `0` = ei nyt | Verrataan suoraan kapasiteettiin ja toteumaan; prosenttien summaa ei tarvitse pitää sadassa. Osuus lasketaan näytettäessä |
| Tavoitteen tärkeys | Olemassa oleva `goals.priority` (3 tasoa) | Uutta kenttää ei tarvittu |
| Tavoite → alue | `goals.life_area_id` (nullable) | Yksi alue per tavoite; vanha tavoite ilman aluetta on kelvollinen |
| Tehtävä/rutiini → alue | **Peritään** tavoitteelta tai projektin tavoitteelta; muuten olemassa olevalta kategorialta (`life_areas.category_key`) | Ei rinnakkaista luokittelua `tasks`-tauluun; vanha data tulee näkyviin ilman täyttöä |
| Kapasiteetti | `weekly_capacities`: minuutit + valinnainen energia 1–5, yksi rivi/viikko (ma) | "Paljonko realistisesti ehdin" on käyttäjän arvio, ei laskelma |
| Suunniteltu | Päivätyt tehtävät + rutiinien esiintymät viikolla; kesto `durationOf()` | Olemassa oleva kesto; puuttuva = **tuntematon**, ei 0 eikä 60 |
| Toteuma | `time_entries` (käyttäjän kirjaama, `source = 'manual'`) | Valmiiksi merkitty ≠ toteutunut aika. Arviota ei kopioida toteumaksi |
| Havainnot | **Lasketaan**, ei tallenneta | Ei vanhenevaa toista totuutta |
| Katsaus | `alignment_reviews`: versioitu tiivis tilannekuva + pohdinta + valitut muutokset | Historia on tarkoituksella jäädytetty |

### Alueen päättely (yksi alue, yksi sääntö — ei kaksoislaskentaa)

```
tehtävä   1. tavoite (ylätavoitteen kautta)  2. projektin tavoite  3. kategoria  4. ei aluetta
rutiini   1. tavoite                          2. kategoria          3. ei aluetta
kirjaus   1. suora alue                       2. tehtävä            3. tavoite    4. ei aluetta
```

Ensimmäinen osuma voittaa. Jokainen kohde lasketaan tasan yhteen alueeseen.

---

## Havaintojen säännöt (tarkat)

Kaikki kynnykset ovat `RULES`-vientejä tiedostossa `src/domain/alignment.js`.
Jokainen havainto kantaa säännön tunnisteen, perustan (`planned`/`actual`) ja
luvut; käyttöliittymä näyttää ne kohdassa **"Miksi tämä näkyy?"**.

### Kuormitus (`overload`)

- Vaatii käyttäjän asettaman kapasiteetin tälle viikolle.
- `tunnettu suunniteltu > kapasiteetti` → **Huomio**; `≥ 120 %` tai
  kapasiteetti 0 → **Vahva**.
- `tunnettu ≥ 90 %` ja arvioimatonta työtä on → **Tiedoksi** ("voi ylittyä").
- Raportoi: suunniteltu, kapasiteetti, ylitys, prosentti, arvioimattomien määrä.

### Huomiotta jääminen (`neglect`)

Vain aktiiviset alueet, joiden **tärkeys ≥ 4** ja **tavoite ≥ 30 min**.

- **Toteumaan perustuva** (kun viikolle on kirjattu aikaa JA viikosta on
  kulunut ≥ 3/7 eli torstaista alkaen): `toteuma < 50 % × tavoite ×
  kulunut osuus` → **Huomio**; viikon jälkeen alle 25 % → **Vahva**.
- **Suunnitelmaan perustuva** (muuten): `suunniteltu < 50 % tavoitteesta` →
  **Tiedoksi** (suunnitelma on vielä muutettavissa).
- Maanantaina toteumaa ei verrata. Vähemmän tärkeä alue, tavoite 0/puuttuu tai
  pois käytöstä oleva alue ei ole koskaan "huomiotta".

### Poikkeama tavoitteista (`misalignment`)

- Toivottu osuus = alueen tavoite / kaikkien aktiivisten tavoitteiden summa.
- Perusta: toteuma, jos alueisiin liitettyä aikaa ≥ 120 min; muuten suunnitelma
  (sama raja); muuten ei arvioida.
- `|toteutunut % − toivottu %| ≥ 15 pp` → **Huomio**, `≥ 25 pp` → **Vahva**
  (suunnitelmaan perustuva enintään Huomio).
- Jos alle 60 % ajasta on liitetty alueisiin → **Tiedoksi** ja "suuntaa-antava".
- Tavoite 0 on päätös (siihen kulunut aika on poikkeama); puuttuva tavoite ei.
- Vajetta ei raportoida kahdesti, jos alue on jo "huomiotta".

### Jännite (`target_tension`)

Alueiden tavoitteiden summa > kapasiteetti → **Tiedoksi**. Tärkeyttä,
tavoitetta tai kapasiteettia ei muuteta puolesta.

### Aineiston laatu

`good` / `partial` / `weak` / `none` + syyt: ei alueita, ei tavoitteita, ei
kapasiteettia, arvioimatonta työtä, liittämätöntä työtä, ei toteumaa.
Kattavuusprosentit: arvioitu osuus, alueeseen liitetty suunniteltu ja toteuma.

---

## Viikkokatsaus ja muutokset

Seitsemän kysymystä (`REVIEW_QUESTIONS`): mikä oli tärkeää, mitä suunnittelin,
mitä tapahtui, missä kuormitus ylittyi, mikä jäi huomiotta, missä todellisuus
poikkesi, mitä muutan. Ei valmistumisprosenttia pääviestinä.

Ehdotukset (`proposeAdjustments`) — **mikään ei muutu ennen vahvistusta**,
jokainen erikseen, ja sama ehdotus ei toteudu kahdesti:

| Ehdotus | Milloin | Mitä tekee vahvistettuna |
|---|---|---|
| Aseta ensi viikon kapasiteetti | ei asetettu | tallentaa kapasiteetin (käyttäjä muokkaa arvon) |
| Kevennä ensi viikkoa | ensi viikon suunnitelma > kapasiteetti | siirtää liittämättömät ja vähiten tärkeät tehtävät viikolla eteenpäin |
| Keskeytä tavoite | kuormitus; alueen tärkeys ≤ 2 | tavoitteen tila `paused` (ei katoa) |
| Varaa aikaa alueelle | huomiotta jääminen | luo tehtävän ensi maanantaille alueen tärkeimpään tavoitteeseen |
| Muuta alueen tavoitetta | huomiotta jääminen / poikkeama | päivittää tavoitteen (käyttäjä muokkaa arvon) |

## Palaute Tavoitteesta tekemiseksi -moottorille

`planningFeedback()` → suunnittelun konteksti (`buildPlanningContext`) rajaa
viikon vapaan ajan käyttäjän omaan kapasiteettiin (raja vain laskee).
Suunnittelunäkymä kertoo syyn. Huomiotta jäävät alueet ja yli-edustetut
alueet välitetään tunnisteina — ei mallille.

## Tekoäly

Havainnot ovat deterministisiä; testi vartioi, ettei domain tuo mitään
ai-kerroksesta. `src/ai/alignmentContext.js` rakentaa selitystä varten
minimoidun kontekstin (luvut, havainnot, aluenimet tunnuksina A1…, ei
otsikoita/muistiinpanoja/pohdintoja). **Kutsupolkua mallille ei ole
rakennettu:** käyttöliittymän selitykset ovat deterministisiä
(`explainSignal`).

## Laajennuspisteet

Life Alignment lukee normalisoidun viikkoaineiston (`analyzeWeek`). Uusi lähde
tuottaa samoja faktoja:

- **Kalenteri** → suunniteltu ja toteutunut aika (uusi `time_entries.source`
  omalla migraatiollaan)
- **Talous** → rahan sitoumukset/toteuma alueittain (erillinen ulottuvuus;
  rahaa ei sekoiteta aikaan)
- **Hyvinvointi** (`wellbeing_entries.energy`) → toteutunut energia; tänään
  vain käyttäjän viikkoarvio `energy_level` näytetään, energiakuormitusta ei
  lasketa, koska tehtävillä ei ole energiavaatimusta
- **Terveys/aktiivisuus** → energian ja liikkeen näyttö

## Tila (rehellinen)

| Osa | Tila |
|---|---|
| Elämänalueet, tärkeys, tavoite, kategoriakytkentä | COMPLETE_LOCAL |
| Tavoite → alue, periytyminen tehtäville/projekteille/rutiineille | COMPLETE_LOCAL |
| Viikkokapasiteetti (+ energia-arvio) | COMPLETE_LOCAL |
| Suunniteltu / toteuma / liittämätön / aineiston laatu | COMPLETE_LOCAL |
| OVERLOAD / NEGLECT / MISALIGNMENT / TENSION | COMPLETE_LOCAL |
| Energiakuormitus | ARCHITECTURE_ONLY |
| Viikkokatsaus + historia + muutosehdotukset | COMPLETE_LOCAL |
| Palaute suunnittelulle | COMPLETE_LOCAL |
| Tekoälyselitys | PARTIAL (minimoitu konteksti valmis, kutsupolkua ei) |
| Suunta-näkymä ja päiväkortti | IMPLEMENTED_DEVICE_UNVERIFIED |
| Pysyvyys kantaan (migraatio 0012) | BLOCKED (ajo vaatii omistajan hyväksynnän) |
| RLS | Staattisesti + simuloidusti todennettu; oikea PostgreSQL-ajo puuttuu |
