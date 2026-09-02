# Tilin poisto ja datan omistajuus

**TILA: ARKKITEHTUURI VALMIS, BACKEND PUUTTUU.**
Sovellus **ei saa** näyttää tilin poistoa toimivana ennen kuin se on
oikeasti toteutettu.

Vienti: `src/domain/dataExport.js` — **IMPLEMENTED**
Tilin poisto: **PRODUCTION-BLOCKED**

---

## Periaate

Tieto on käyttäjän, ei sovelluksen. Jos sovelluksesta ei pääse ulos, se ei
ole työkalu vaan ansa. Konseptidokumentin luku 24 vaatii sekä viennin että
poiston.

Näistä **vienti on toteutettu**, poisto ei — ja ero on kerrottava
käyttäjälle suoraan.

---

## Vienti (IMPLEMENTED)

`buildUserDataExport()` on puhdas kokoaja: ottaa datan, palauttaa
versioidun vientiolion.

```json
{
  "kind": "manifestival-export",
  "manifestivalExportVersion": 1,
  "exportedAt": "2026-09-02T10:00:00.000Z",
  "counts": { "tasks": 128, "goals": 4, "bills": 12 },
  "data": { "tasks": [...], "goals": [...] }
}
```

Kattaa 12 tietotyyppiä **nimenomaisena listana** eikä johdettuna tilasta:
uusi tilakenttä ei päädy vientiin vahingossa.

### Mitä ei viedä — eikä missään olosuhteissa

```
API-avaimet · istunto- ja refresh-tokenit · salasanat ja tiivisteet
Supabase-avaimet · user_id · sisäiset autentikaatiokentät
```

Vienti on tiedosto, joka päätyy latauskansioon, pilveen ja mahdollisesti
sähköpostiin. Salaisuus siinä olisi salaisuus kaikkialla.

Suodatus tehdään **nimen perusteella koko puusta rekursiivisesti**, ei
tyyppikohtaisesti: jos jokin tuleva rivi kantaa tokenia, se putoaa pois
ilman että kukaan muistaa lisätä sääntöä. Testi myrkyttää datan jokaisella
kielletyllä kentällä eri syvyyksissä.

---

## Tuonti (PARSE + VALIDATE + PREVIEW)

Tuonti **ei kirjoita mitään** tässä aallossa.

```
tiedosto → jäsennys → versiotarkistus → rakennetarkistus
        → esikatselu → konfliktianalyysi → [käyttäjän vahvistus] → kirjoitus
                                            ↑ tähän asti toteutettu
```

Uudempaa vientiversiota **ei yritetä arvata**: se voi sisältää rakenteita,
joita tämä versio ei ymmärrä, ja arvaaminen turmelisi käyttäjän tiedot.

Massakirjoitus ilman konfliktimallia olisi paras tapa tuhota olemassa oleva
data yhdellä väärällä tiedostolla. Siksi kirjoitusvaihe on tietoisesti
lykätty.

---

## Tilin poisto (PRODUCTION-BLOCKED)

### Miksi tätä ei toteutettu

Tilin poisto on **kertaluonteinen ja peruuttamaton**. Se vaatii
palvelinpuolen transaktion, jota ei voi todentaa ilman toimivaa
production-Supabasea — ja se on tällä hetkellä portin takana.

Puolivalmis toteutus olisi tässä pahin mahdollinen: käyttöliittymä, joka
näyttää onnistumisen mutta jättää datan kantaan, on suoraan valhe.

**Sovellus ei saa luoda fake-successia.** Jos poistoa yritetään ennen kuin
backend tukee sitä, käyttöliittymän on sanottava suoraan, ettei toiminto
ole vielä käytettävissä.

### Sopimus, kun se toteutetaan

```
RequestAccountDeletion
  ↓
1. Vahvistus: käyttäjä kirjoittaa sähköpostinsa
2. Pakotettu vienti: lataa tietosi ennen poistoa
3. Palvelinkutsu (yksi transaktio)
4. Uloskirjautuminen ja paikallisen tilan tyhjennys
5. Vahvistus sähköpostiin
```

### Poistojärjestys palvelimella

Kaikki yhdessä transaktiossa. Osittainen poisto jättäisi orpoja rivejä,
joita kukaan ei omista eikä voi poistaa.

```sql
begin;
  delete from public.ai_action_audit    where user_id = :uid;
  delete from public.bills              where user_id = :uid;
  delete from public.savings_goals      where user_id = :uid;
  delete from public.recurring_expenses where user_id = :uid;
  delete from public.wellbeing_entries  where user_id = :uid;
  delete from public.routine_exceptions where user_id = :uid;
  delete from public.routines           where user_id = :uid;
  delete from public.tasks              where user_id = :uid;
  delete from public.projects           where user_id = :uid;
  delete from public.goals              where user_id = :uid;
  delete from public.notification_preferences where id = :uid;
  delete from public.profile            where id = :uid;
  -- Viimeisenä käyttäjä itse. auth.users -> on delete cascade hoitaisi
  -- yllä olevat, mutta nimenomainen järjestys on tarkistettavissa ja
  -- dokumentoitu — implisiittiseen kaskadiin ei kannata luottaa silloin
  -- kun virhe on peruuttamaton.
commit;
```

Käyttäjän poisto `auth.users`-taulusta vaatii `service_role`-oikeudet,
joita **selain ei koskaan saa**. Se kuuluu palvelinfunktioon.

### Mitä poisto EI saa tehdä

- Ei saa jättää dataa "arkistoituna" ja väittää poistaneensa sen
- Ei saa kestää päiviä ilman että käyttäjälle kerrotaan
- Ei saa vaatia tukipyyntöä
- Ei saa poistaa vain istuntoa ja jättää rivit kantaan

---

## Paikallinen tyhjennys (IMPLEMENTED)

Tämä on eri asia kuin tilin poisto, ja se **on** toteutettu.

`clearLocalUserData()` tyhjentää repositorioiden muistivarastot ja
muistutusasetukset. Se ajetaan:

- uloskirjautumisessa
- **tilinvaihdossa ilman uloskirjautumista** (`USER_SWITCHED`)

Ilman tätä seuraava käyttäjä näkisi edellisen rutiinit ja tavoitteet
samalla selaimella. Molemmat reitit ovat regressiotestattuja —
kumpikin oli aiemmin todellinen vuoto.

---

## Tila

| Osa | Tila |
|---|---|
| Datan vienti | **IMPLEMENTED** |
| Salaisuuksien suodatus viennistä | **IMPLEMENTED**, testattu |
| Tuonnin jäsennys ja esikatselu | **IMPLEMENTED** |
| Tuonnin kirjoitus | **PLANNED** — vaatii konfliktimallin |
| Paikallisen datan tyhjennys | **IMPLEMENTED** |
| Tilin poiston käyttöliittymä | **PLANNED** |
| Tilin poiston palvelintransaktio | **PRODUCTION-BLOCKED** |
