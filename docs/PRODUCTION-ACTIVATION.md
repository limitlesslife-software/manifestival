# Tuotannon käyttöönotto

Tämä on ajolista, jolla Manifestival siirretään nykytilasta — jossa suuri osa
toiminnoista on rakennettu mutta ei säily tallennuksen yli — täyteen
tuotantokäyttöön.

**Mitään tässä kuvattua ei ole tehty.** Jokainen vaihe vaatii ihmisen
päätöksen ja ihmisen kädet: ne koskevat tuotantotietokantaa, salaisuuksia ja
julkaisua.

---

## Nykytila lyhyesti

| Asia | Tila |
|---|---|
| Supabase-projekti | **Pausella** |
| `supabase/inventory.sql` | Ajamatta |
| Migraatiot 0001–0006 | Kirjoitettu, **ajamatta** |
| Autentikaatio koodissa | Valmis (Supabase Auth) |
| Rutiinit, tavoitteet, projektit, hyvinvointi | Toimivat, **eivät säily** |
| Muistutukset | Suunnittelumoottori valmis, ei lähetystä |
| Anthropic-avain | Kierrettävä ennen julkista käyttöä |
| Android-allekirjoitusavain | Ei luotu |

---

## IMPLEMENTED LOCALLY vs REQUIRES PRODUCTION MIGRATION

Tämä erottelu on koko dokumentin ydin. Sovellus toimii ilman migraatioita,
mutta osa tiedosta katoaa sivun latauksessa. Käyttöliittymä kertoo sen
käyttäjälle — se ei teeskentele tallentavansa.

| Toiminto | Koodi | Persistenssi |
|---|---|---|
| Tehtävät (otsikko, päivä, aika, kategoria) | IMPLEMENTED | **Toimii jo** |
| Profiili | IMPLEMENTED | **Toimii jo** |
| Tehtävän kuvaus, kesto, prioriteetti, tila | IMPLEMENTED | REQUIRES MIGRATION 0002 |
| Rutiinit ja poikkeukset | IMPLEMENTED | REQUIRES MIGRATION 0003 |
| Tavoitteet ja projektit | IMPLEMENTED | REQUIRES MIGRATION 0004 |
| Tehtävän määräaika ja linkit | IMPLEMENTED | REQUIRES MIGRATION 0004 |
| Muistutusasetukset | IMPLEMENTED | REQUIRES MIGRATION 0005 |
| Hyvinvointimerkinnät | IMPLEMENTED | REQUIRES MIGRATION 0006 |
| Muistutusten lähetys | PARTIAL (vain heti näytettävä) | Ei vaadi migraatiota |
| Ajastetut muistutukset | PLANNED | Vaatii natiivikerroksen |
| Talous ja sijoitukset | PLANNED (vain arkkitehtuuri) | Oma migraationsa myöhemmin |

---

## Vaihe 1 — Supabase takaisin käyttöön

```
1. Supabase Dashboard -> projekti -> Resume
2. Odota kunnes tila on "Active"
3. Database -> Backups -> ota varmuuskopio ENNEN mitään muuta
```

Varmuuskopio ensin. Migraatio 0001 muuttaa `profile.id`-sarakkeen tyypin,
eikä sitä voi perua ilman palautusta.

---

## Vaihe 2 — Inventointi

```
1. SQL Editor -> New query
2. Liitä supabase/inventory.sql
3. Run
```

`inventory.sql` on **vain luku**. Se ei muuta mitään.

Vertaa tulosta migraation 0001 OLETUKSET-osioon. Erityisesti:

- Ovatko `public.tasks` ja `public.profile` olemassa?
- Onko `tasks.id` tekstityyppinen?
- Onko `profile`-taulussa yksi rivi arvolla `'me'`?
- Puuttuuko `user_id` kummastakin?

**Jos jokin oletus ei päde, pysähdy ja korjaa migraatio ennen ajoa.**

---

## Vaihe 3 — Migraatiot yksi kerrallaan

Jokaisen migraation jälkeen ajetaan sen lopussa olevat varmistuskyselyt ja
vasta sitten käännetään vastaava lippu koodissa. Yksi migraatio, yksi lippu,
yksi commit.

### 0001 — omistajuus ja RLS

Tämä on kaikkien muiden esiehto.

```
1. Luo itsellesi tili sovelluksen kirjautumisnäkymästä
2. SQL Editor: select id, email from auth.users;
3. Kopioi oma id
4. Avaa migraatio 0001 ja korvaa VAIHE 0:n paikanpitäjä sillä
5. Aja migraatio
6. Aja varmistuskyselyt
```

Migraatio keskeytyy itsestään eikä muuta mitään, jos paikanpitäjä on yhä
paikallaan.

**Varmista ennen jatkoa:**

```sql
select tablename, rowsecurity from pg_tables
 where schemaname='public' and tablename in ('tasks','profile');
-- molemmilla rowsecurity = true

select tablename, policyname, roles from pg_policies
 where schemaname='public' order by tablename;
-- roles on aina {authenticated}, ei koskaan {anon} eikä {public}
```

Koodissa ei tarvitse muuttaa mitään: autentikaatio on jo valmis.

### 0002 — tehtävän domain-kentät

```
Aja migraatio -> varmistuskyselyt -> src/data/schema.js:
  export const TASK_EXTENDED_FIELDS = true;
```

Tämän jälkeen kuvaus, kesto, prioriteetti ja aikataulutuksen tila säilyvät.

### 0003 — rutiinit

```
Aja migraatio -> varmistuskyselyt -> src/data/schema.js:
  TABLES.routines = true
  TABLES.routineExceptions = true
```

### 0004 — tavoitteet ja projektit

```
Aja migraatio -> varmistuskyselyt -> src/data/schema.js:
  TABLES.goals = true
  TABLES.projects = true
```

Huomaa: migraatio lisää myös `tasks.deadline`, `tasks.goal_id` ja
`tasks.project_id`. Ne ovat osa samaa lippuparia, koska niitä ei voi käyttää
ilman tavoitetauluja.

### 0005 — muistutusasetukset

```
Aja migraatio -> varmistuskyselyt -> src/data/schema.js:
  TABLES.notificationPreferences = true
```

### 0006 — hyvinvointi

```
Aja migraatio -> varmistuskyselyt -> src/data/schema.js:
  TABLES.wellbeing = true
```

### Lipun kääntäminen kaataa testin — tarkoituksella

`tests/migrations.test.mjs` sisältää testin, joka vaatii kaikkien
`TABLES`-lippujen olevan `false`. Se **kaatuu heti**, kun lippu käännetään.

Se on tarkoituksellista: lippua ei voi vaihtaa vahingossa. Kun migraatio on
oikeasti ajettu tuotannossa, testi päivitetään samassa committissa ja
commit-viestissä sanotaan ääneen mikä migraatio ajettiin ja milloin.

---

## Vaihe 4 — Anthropic-avain

Sovellus ei koskaan lähetä avainta selaimeen. Puheentulkinta menee Vercelin
serverless-funktion `api/parse.js` kautta, joka lukee avaimen
ympäristömuuttujasta.

```
1. console.anthropic.com -> luo UUSI avain
2. Vercel -> Project -> Settings -> Environment Variables
     ANTHROPIC_API_KEY = <uusi avain>   (Production, Preview, Development)
3. Redeploy
4. Varmista että /api/parse toimii
5. VASTA SITTEN: mitätöi vanha avain Anthropicin konsolista
```

Järjestys on tässä olennainen: uusi avain käyttöön ja todennettu ennen kuin
vanha mitätöidään. Toisin päin sovellus olisi rikki siltä väliltä.

**Jos avain on koskaan ollut työpöydällä tiedostossa tai committina, se on
kierrettävä.** Poista tiedosto vasta kun uusi avain toimii — ja poista se
itse, ei automaattisesti.

---

## Vaihe 5 — Vercel-julkaisu

Ks. `docs/DEPLOYMENT.md`. Lyhyesti:

```
1. Merge haara mainiin (vasta kun katselmointi on tehty)
2. Vercel deployaa automaattisesti
3. Tarkista tuotannossa:
   - kirjautuminen ja uloskirjautuminen
   - tehtävän luonti, muokkaus, poisto
   - sivun päivitys: data säilyy
   - /api/parse vastaa
   - service worker rekisteröityy (DevTools -> Application)
```

Service workerin välimuistiversio on `sw.js`:n `CACHE_VERSION`. Se on
nostettava aina kun sovelluskuori muuttuu, muuten vanha versio jää elämään
selaimiin.

---

## Vaihe 6 — Android

Ks. `docs/ANDROID-STRATEGY.md`. Debug-APK syntyy komennolla:

```
npm run build:android
```

Julkaisu Play Storeen vaatii allekirjoitusavaimen. **Sitä ei luoda tässä
projektissa automaattisesti eikä sitä tallenneta repoon.** Avain on
kertaluonteinen ja korvaamaton: jos se katoaa, sovellusta ei voi enää
päivittää samalla paketti-id:llä.

```
1. Luo keystore itse, talleta se salasanahallintaan
2. Anna Gradlelle polku ja salasana ympäristömuuttujina tai
   ~/.gradle/gradle.properties-tiedostossa — EI repoon
3. gradlew.bat bundleRelease
4. Lataa .aab Play Consoleen
```

Laitetestaus tehdään käsin oikealla puhelimella. Sitä ei voi automatisoida
tästä ympäristöstä.

---

## Vaihe 7 — Käyttöönoton jälkeen

Ensimmäisen viikon aikana kannattaa tarkistaa:

```sql
-- Kuuluuko kaikki data omistajalle?
select count(*) from public.tasks where user_id is null;   -- 0

-- Onko RLS yhä päällä kaikilla tauluilla?
select tablename, rowsecurity from pg_tables where schemaname='public';

-- Onko anon-roolilla oikeuksia mihinkään?
select grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema='public' and grantee='anon';
-- pitää olla tyhjä
```

---

## Peruutus

| Vaihe | Peruutus |
|---|---|
| 0001 | **Vain varmuuskopiosta.** `profile.id` menetti arvon `'me'` |
| 0002–0006 | Migraation lopussa oleva rollback-lohko + lipun palautus |
| Avaimen kierto | Luo taas uusi avain; vanhaa ei voi palauttaa |
| Vercel-julkaisu | Vercel -> Deployments -> aiempi -> Promote to Production |
| Play-julkaisu | Play Console -> pysäytä julkaisu; jo asennettuja ei voi perua |

---

## Muistilista

- [ ] Varmuuskopio otettu
- [ ] `inventory.sql` ajettu ja tulos verrattu oletuksiin
- [ ] 0001 ajettu, RLS todennettu, anon-oikeudet tarkistettu
- [ ] 0002 ajettu, `TASK_EXTENDED_FIELDS = true`
- [ ] 0003 ajettu, rutiiniliput päällä
- [ ] 0004 ajettu, tavoite- ja projektiliput päällä
- [ ] 0005 ajettu, muistutuslippu päällä
- [ ] 0006 ajettu, hyvinvointilippu päällä
- [ ] `tests/migrations.test.mjs` päivitetty vastaamaan todellista tilaa
- [ ] Anthropic-avain kierretty, vanha mitätöity
- [ ] Vercel-tuotanto todennettu käsin
- [ ] `CACHE_VERSION` nostettu
- [ ] Android-allekirjoitusavain luotu ja talletettu turvallisesti
