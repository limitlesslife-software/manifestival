# ADR: Goal-to-Action -moottori

**Tila:** ehdotettu. Ei toteutettu.
**Konteksti:** migraatioiden 0003–0008 aktivointivalmius, 2026-09-08

---

## Miksi tämä kirjoitetaan nyt

Tavoitteet ja projektit ovat valmiina aktivoitavaksi. Ennen kuin niihin
tallennetaan käyttäjän dataa, kannattaa kirjata ylös mihin ne ovat
matkalla — koska datamallia on paljon halvempi muuttaa nyt kuin
myöhemmin.

**Tämä ei ehdota mitään rakennettavaksi tässä paketissa.** Se kirjaa
suunnan ja tarkistaa, ettei nykyinen malli sulje sitä pois.

---

## Tavoitetila

Vapaamuotoinen tavoite pitäisi voida purkaa:

```
tavoite
  → välitavoitteet
    → projektit
      → tehtävät
      → rutiinit
    → mittarit
```

Sen jälkeen:

1. **Suunnittelija-AI** ehdottaa suunnitelman
2. **Ajoittaja** sovittaa sen todelliseen kalenteriin ja päivärytmiin
3. **Käyttäjä hyväksyy** sitovat kalenterimuutokset
4. **Mukautuva ajoittaja** siirtää tekemättä jääneitä
5. **Edistymismoottori** seuraa ja ennustaa valmistumista

Automaatiotasot: vain ehdotus → saman päivän siirrot → viikon sisäiset
siirrot → automaattinen optimointi käyttäjän sääntöjen alla.

Tavoitteen tilat: aktiivinen, ylläpito, tauolla, saavutettu, hylätty.

---

## Mitä nykyinen malli jo kestää

Tarkistin tämän migraatioita ja domainia vasten:

| Tarve | Nykytila |
|---|---|
| Tavoitehierarkia | `goals.parent_goal_id → goals` on olemassa. Välitavoite on alatavoite |
| Tavoite → projekti | `goals.project_id` ja `projects.goal_id` molempiin suuntiin |
| Tavoite → tehtävä | `tasks.goal_id` |
| Projekti → tehtävä | `tasks.project_id` |
| Tavoite → rutiini | `routines.goal_id` |
| Tavoitteen tilat | `goals_status_check`: `active`, `paused`, `completed`, `abandoned`, `archived` |
| Edistymisen lähde | `goals.progress_mode`: `manual`, `task_based`, `project_based`, `routine_based` |
| Määräaika vs. ajoitus | `tasks.date` ja `tasks.deadline` ovat eri sarakkeita |

**Rakenne kantaa suunnan.** Purku tavoite → projekti → tehtävä/rutiini
on jo mallinnettu, eikä `progress_mode` lukitse laskentaa yhteen
tapaan.

---

## Kolme asiaa, jotka on syytä tietää nyt

### 1. Tilajoukko on lähes valmis

Tavoitetila kaipaa **ylläpito**-tilaa (`maintenance`), jota
`goals_status_check` ei tunne. Ero on merkityksellinen:
"saavutettu ja pidetään yllä" ei ole sama kuin "valmis".

Se on yhden rivin muutos tarkisteeseen tulevassa migraatiossa. Ei
kiireellinen — mutta jos se tehdään, se kannattaa tehdä **ennen** kuin
käyttäjät ovat merkinneet tavoitteita `completed`-tilaan tarkoittaen
ylläpitoa.

### 2. Välitavoitteelle ei ole omaa käsitettä

Alatavoite (`parent_goal_id`) ajaa saman asian. Jos välitavoitteista
halutaan oma tyyppinsä — kevyempi, järjestetty, ei omaa
edistymistilaansa — se on uusi taulu, ei nykyisen muokkaus.

Alatavoite riittää ensimmäiseen versioon. **Älä lisää tauluja ennen
kuin ne ovat tarpeen.**

### 3. Ajoittaja ei saa täyttää kaikkea vapaata aikaa

Tämä on tuotepäätös, ei tekninen, mutta se rajoittaa mallia:
ajoittajan on tunnettava palautuminen, työ, uni, matkat ja kilpailevat
sitoumukset. Vapaa aika ei ole vapaata kapasiteettia.

Nykyisessä mallissa ei ole käsitettä "suojattu aika" eikä
"kuormituskatto". Hyvinvointimerkinnät (`wellbeing_entries`) ovat
lähin olemassa oleva signaali, ja domain laskee niistä jo ehdotuksen
päivän kuormaksi — mutta se on **ehdotus, ei muutos**, ja niin sen
kuuluukin olla.

Kun ajoittaja rakennetaan, sen on säilytettävä tämä ero: moottori
ehdottaa, käyttäjä hyväksyy sitovat kalenterimuutokset.

---

## Päätös

**Älä rakenna moottoria nyt.** Aktivoi tavoitteet ja projektit
sellaisenaan.

Nykyinen skeema ei paina nurkkaan: hierarkia, liitokset ja
edistymistavat ovat paikallaan, eikä mikään niistä lukitse tulevaa
purkua.

Kaksi asiaa harkittavaksi ennen kuin tavoitedataa kertyy paljon:

1. `maintenance` tavoitteen tilaksi
2. Käsite suojatusta ajasta tai kuormituskatosta ajoittajaa varten

Kumpikin on additiivinen. Kumpikaan ei estä aktivointia.

---

## Mitä tämä ADR ei ratkaise

- Miten AI purkaa tavoitteen — kehotus, malli, validointi
- Miten ehdotus esitetään ja hyväksytään
- Miten mukautuva uudelleenajoitus välttää loputtoman siirtelyn
- Miten edistymisen ennuste lasketaan
- Miten ääniohjaus aloittaa suunnittelun

Nämä ovat suunnittelukysymyksiä, ja ne ratkaistaan kun moottori
rakennetaan. Tämän dokumentin tehtävä oli varmistaa, ettei niitä ole
tehty mahdottomiksi.
