# Tuotannon aktivoinnin runbook

**Tämän ajaa ihminen. Ei agentti, ei skripti, ei CI.**

Jokainen vaihe on erillinen päätös. Vaiheiden välissä on PYSÄYTYS, jossa
on tarkoitus katsoa tulos ja päättää jatketaanko. **Ei ole olemassa
"aja kaikki migraatiot" -vaihetta eikä sellaista pidä rakentaa.**

Liittyvät: [`MIGRATION-MAP.md`](MIGRATION-MAP.md) ·
[`PRODUCTION-ACTIVATION-GATE.md`](PRODUCTION-ACTIVATION-GATE.md)

Varmistuskyselyt: `supabase/verify/` — **vain lukevia**, ei yhtään
`insert`, `update`, `delete` tai `alter`.

---

## Ennen aloitusta

Aktivointi kannattaa aloittaa vasta kun on aikaa viedä ainakin vaiheet
1–5 loppuun samalla istunnolla. Kesken jäänyt 0001 jättää tuotannon
tilaan, jossa vanha ja uusi omistajuusmalli ovat yhtä aikaa voimassa.

Tarvitset: pääsyn Supabasen SQL-editoriin, varmuuskopion, ja tiedon siitä
kuinka monta riviä `tasks`-taulussa on juuri nyt.

---

## Vaihe 1 — Varmuuskopio

Ota Supabasen kautta täysi varmuuskopio. Kirjaa aikaleima muistiin.

**0001 ei ole peruttavissa ilman tätä.** Se siirtää olemassa olevan datan
omistajuuden. Jos siirto menee pieleen eikä varmuuskopiota ole, dataa ei
saa takaisin.

### PYSÄYTYS 1
Varmuuskopio on olemassa ja sen aikaleima on kirjattu.
Jos ei: **älä jatka.**

---

## Vaihe 2 — Nykytilan inventaario

Aja `supabase/inventory.sql`. Se on lukeva.

Kirjaa ylös:
- montako riviä `tasks`-taulussa on
- onko `tasks`-taulussa jo `user_id`-sarake
- onko RLS päällä
- montako politiikkaa on olemassa
- mitä oikeuksia `anon`-roolilla on

### PYSÄYTYS 2
Tulos vastaa odotusta. Erityisesti: jos `user_id` on jo olemassa,
**0001 on osittain ajettu** ja tilanne on selvitettävä ennen jatkoa.

---

## Vaihe 3 — Migraatio 0001 (auth-omistajuus)

Aja `supabase/migrations/0001_auth_user_scoping.sql` kokonaisuudessaan.

Tämä on ainoa **pakollinen** migraatio. Kaikki muut ovat valinnaisia ja
voi jättää ajamatta pysyvästi.

### PYSÄYTYS 3
Aja `supabase/verify/verify_0001.sql`. Tarkista:
- `tasks` ja `profile`: RLS päällä
- politiikkoja yhteensä 8
- `tasks.user_id`: ei yhtään null-arvoa
- rivimäärä sama kuin vaiheessa 2
- `anon`-roolilla ei ole oikeuksia kumpaankaan tauluun

Jos rivimäärä muuttui: **palauta varmuuskopiosta.** Migraatio ei saa
hävittää yhtään riviä.

---

## Vaihe 4 — Sovelluksen savutesti oikeaa tuotantoa vasten

Ennen kuin yhtään lippua käännetään: kirjaudu sovellukseen, luo tehtävä,
muokkaa sitä, poista se. Kirjaudu ulos ja takaisin sisään.

Tämän vaiheen tarkoitus on todeta, että **0001 ei rikkonut mitään
olemassa olevaa** — ennen kuin päälle kasataan lisää.

### PYSÄYTYS 4
Tehtävien luonti, muokkaus ja poisto toimivat. Uloskirjautuminen tyhjentää
näkymän. Jos jokin ei toimi: korjaa ennen jatkoa. **Älä jatka vaiheeseen 5
rikkinäisen pohjan päälle.**

---

## Vaihe 5 — Toisella tilillä: eristystesti

Luo toinen testitili. Kirjaudu sillä sisään. Varmista, ettei se näe
ensimmäisen tilin yhtään tehtävää.

Tämä on koko turvamallin ainoa oikea todiste. Kaikki muu on päättelyä.

### PYSÄYTYS 5
Tili B ei näe tilin A dataa. Jos näkee: **RLS ei ole voimassa.**
Pysäytä kaikki ja selvitä syy ennen kuin yhtäkään muuta migraatiota
ajetaan.

---

## Vaihe 6 — Migraatio 0002 (tasks-lisäkentät)

Aja `0002_task_domain_fields.sql`.

### PYSÄYTYS 6
Aja `supabase/verify/verify_0002.sql`. Kuusi saraketta olemassa,
`scheduling_state` ei null, kaksi tarkistetta olemassa.

---

## Vaihe 7 — Lippu `TASK_EXTENDED_FIELDS`

Vaihda `src/data/schema.js`:ssä `TASK_EXTENDED_FIELDS` arvoon `true`.
Aja `npm test`. Committoi.

Deployaa. Kokeile tehtävän luontia kuvauksella ja prioriteetilla.
Lataa sivu uudelleen ja tarkista, että kentät ovat yhä siellä.

### PYSÄYTYS 7
Laajennetut kentät säilyvät uudelleenlatauksen yli. Jos eivät:
käännä lippu takaisin `false`:ksi ja deployaa. Vasta sitten selvitä syy.

---

## Vaihe 8 — Migraatio 0003 (rutiinit)

Aja `0003_routines.sql`.

### PYSÄYTYS 8
Aja `verify_0003.sql`. Molemmat taulut, 8 politiikkaa, uniikki-indeksi.

---

## Vaihe 9 — Liput `routines` + `routineExceptions`

Molemmat `true` **samassa committissa**. Poikkeus ilman sääntöä on orpo.

Päivitä myös `tests/migrations.test.mjs` — se kaatuu tarkoituksella.
Kirjoita commit-viestiin, **mikä migraatio ajettiin ja milloin**.

### PYSÄYTYS 9
Luo rutiini, ohita se yhdeltä päivältä, lataa sivu uudelleen. Sekä
rutiini että poikkeus säilyivät.

---

## Vaihe 10 — Migraatio 0004 (tavoitteet ja projektit)

Aja `0004_goals_projects.sql`.

### PYSÄYTYS 10
Aja `verify_0004.sql`. Tarkista erityisesti: **kaikki neljä
vierasavainta ovat `SET NULL`, ei yksikään `CASCADE`.** Jos jokin on
cascade, tavoitteen poisto veisi tehtävät mukanaan.

---

## Vaihe 11 — Liput `goals` + `projects`

Molemmat `true` samassa committissa.

**Huom:** projekteilla ei ole käyttöliittymää. Lipun kääntäminen tekee
projekteista pysyviä, mutta niitä pääsee luomaan vain AI-komennolla.
Tämä on tiedostettu ja hyväksyttävä tila.

### PYSÄYTYS 11
Luo tavoite, liitä siihen tehtävä, poista tavoite. **Tehtävän on jäätävä
olemaan** ilman tavoitelinkkiä. Jos tehtävä katosi: cascade on
väärässä paikassa — palauta varmuuskopiosta.

---

## Vaihe 12 — Migraatio 0005 (muistutusasetukset)

Aja `0005_notification_preferences.sql`.

### PYSÄYTYS 12
Aja `verify_0005.sql`. **`enabled`-sarakkeen oletusarvon on oltava
`false`.** Jos se on `true`, migraation ajaminen on kytkenyt
muistutukset päälle ilman lupaa — korjaa ennen lipun kääntämistä.

---

## Vaihe 13 — Lippu `notificationPreferences`

`true`. Deployaa.

### PYSÄYTYS 13
Aseta rauhoitusaika, lataa sivu uudelleen, tarkista että se säilyi.
Tarkista toisella laitteella, että sama asetus näkyy siellä.

---

## Vaihe 14 — Migraatio 0006 (hyvinvointi) + lippu

Aja `0006_wellbeing.sql`, aja `verify_0006.sql`, käännä lippu `wellbeing`.

### PYSÄYTYS 14
Tämä on terveystietoa. **Toista vaiheen 5 eristystesti tälle taululle
erikseen** kahdella tilillä. Älä ohita sitä sillä perusteella, että RLS
todettiin toimivaksi jo kerran.

---

## Vaihe 15 — Migraatio 0007 (talous)

Aja `0007_finance.sql`.

### PYSÄYTYS 15
Aja `verify_0007.sql`. Tarkista rahasarakkeiden tyyppi: kaikkien
kolmen on oltava **`bigint`**. Jos jokin on `numeric` tai
`double precision`, **älä käännä lippuja** — sentit katoaisivat
ajurin muunnoksessa.

---

## Vaihe 16 — Liput `bills` + `recurringExpenses` + `savingsGoals`

Kaikki kolme `true` samassa committissa.

**Huom:** taloudella ei ole käyttöliittymää. Sama tiedostettu tila kuin
projekteilla vaiheessa 11.

### PYSÄYTYS 16
Luo lasku summalla `129,95`. Lataa sivu uudelleen. Summa on edelleen
tasan `129,95` — ei `129,94` eikä `129,950000001`.

---

## Vaihe 17 — Migraatio 0008 (AI-kirjaus) + lippu

Aja `0008_ai_audit.sql`, aja `verify_0008.sql`, käännä lippu `aiAudit`.

### PYSÄYTYS 17
Yritä käsin lisätä kirjaus, jossa `executed = true` ja
`confirmed = false`. **Tietokannan on hylättävä se.** Jos se menee läpi,
rajoite puuttuu.

---

## Peruminen

| Migraatio | Peruminen |
|---|---|
| 0008 | `drop table public.ai_action_audit` |
| 0007 | `drop table` bills → savings_goals → recurring_expenses |
| 0006 | `drop table public.wellbeing_entries` |
| 0005 | `drop table public.notification_preferences` |
| 0004 | `drop table` projects → goals; kolme saraketta pois `tasks`-taulusta |
| 0003 | `drop table` routine_exceptions → routines |
| 0002 | Kuusi saraketta pois `tasks`-taulusta |
| 0001 | **Vain varmuuskopiosta** |

**Käännä aina lippu `false`:ksi ja deployaa ENNEN kuin taulu pudotetaan.**
Toisin päin sovellus kirjoittaa olemattomaan tauluun ja jokainen
tallennus epäonnistuu.

---

## Mitä tämä runbook ei kata

- **Vercel-ympäristömuuttujat** — eivät muutu, `SUPABASE_URL` ja
  `SUPABASE_ANON_KEY` ovat jo paikallaan
- **Android-julkaisu** — erillinen prosessi, ks. `docs/ANDROID.md`
- **Tilin poisto** — ks. [`ACCOUNT-DELETION.md`](ACCOUNT-DELETION.md).
  `on delete cascade` `auth.users`-tauluun tekee siitä yhden operaation,
  mutta sitä ei ole koskaan ajettu tuotannossa
- **Sijaintiperusteiset muistutukset** — ei toteutettu, ks.
  [`LOCATION-DEPARTURE-ARCHITECTURE.md`](LOCATION-DEPARTURE-ARCHITECTURE.md)
