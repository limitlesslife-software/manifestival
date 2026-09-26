# Tavoitteesta tekemiseksi

**Tila:** rakennettu, portit kiinni. **Mitään ei ole deployattu eikä
ajettu tuotantoon.**

Käyttäjä kuvailee tavoitteen omin sanoin, ja Manifestival tekee siitä
toteutuskelpoisen suunnitelman. Tämä dokumentti kertoo mitä se
tarkoittaa, mitä se tarkoituksella **ei** tee, ja mitä sen tuotantoon
vieminen vaatii.

---

## Ketju

```
VAPAA TEKSTI
    ↓
TULKINTA               mitä järjestelmä ymmärsi + OLETUKSET näkyviin
    ↓
EHDOTUS                välitavoitteet, projektit, tehtävät, rutiinit
    ↓
KÄYTTÄJÄN TARKISTUS    kohta kerrallaan, poissulku yhdellä painalluksella
    ↓
HYVÄKSYNTÄ             domain-sääntö, ei käyttöliittymän vaihe
    ↓
TALLENNUS              onnistuu tai peruuntuu — ei koskaan puolittain hiljaa
    ↓
AIKATAULUTUS           mille päiville, kapasiteetin rajoissa
    ↓
SEURANTA               edistyminen, ennuste, ristiriidat
    ↓
MUKAUTUMINEN           delta-ehdotus, ei koko suunnitelmaa uudestaan
```

---

## Viisi asiaa, joita tämä ei tee

Nämä eivät ole puutteita. Ne ovat suunnittelun päätöksiä, ja ne on
kirjoitettu koodiin rajoitteina eikä muistutuksina.

### 1. Ehdotus ei tallennu ilman hyväksyntää

`toCommittable()` palauttaa `null` kaikesta muusta kuin
`APPROVED`-tilaisesta ehdotuksesta, ja se on **ainoa polku**
ehdotuksesta tallennukseen.

Hyväksyntä on domain-sääntö, ei käyttöliittymän vaihe. Jos se olisi
vain käyttöliittymässä, se katoaisi ensimmäisessä oikopolussa: uusi
näkymä tai automaatio kutsuisi tallennusta suoraan.

`applyEdit()` palauttaa tilan `REVIEWED`-tilaan — **hyväksytyn
ehdotuksen muokkaaminen ei säilytä hyväksyntää**, muuten käyttäjä
voisi hyväksyä yhden suunnitelman ja tallentaa toisen.

Lukittu testeillä `tests/goal-to-action-approval.test.mjs`, joka lukee
toimintokerroksen lähdekoodin ja tarkistaa ettei ehdotuksen sisältöä
kirjoiteta `commitPlan`-funktion ulkopuolelta.

### 2. Ehdotusta ei säilytetä

**Ehdotustaulua ei ole** — ei migraatiossa 0010 eikä missään.

Ehdotus elää istunnon muistissa siihen asti että käyttäjä hyväksyy tai
hylkää sen. Hyväksynnästä syntyy tavallisia rivejä; ehdotus katoaa.
Kolme syytä:

1. Hylätty ehdotus on roskaa, joka ei koskaan katoaisi itsestään.
2. Ehdotus päätyisi vientiin ja täyttäisi sen asioilla, joita käyttäjä
   ei valinnut.
3. Ehdotus sisältää mallin tuottamaa tekstiä. Mitä vähemmän sitä
   säilytetään, sitä vähemmän sitä voi vuotaa.

Sama päätös kuin kuittiluennalla (Talous 2.0).

### 3. Mikään automaatiotaso ei siirrä kiinteää työtä

Käyttäjän itse asettama aika on koskematon **jokaisella tasolla, myös
neljännellä**. Automaatiotaso päättää kuinka pitkälle *joustavaa* työtä
saa siirtää — ei sitä, mikä on joustavaa.

### 4. Tekoäly ei päätä tunnisteita, aikoja eikä tiloja

| Mitä malli voisi palauttaa | Mitä sille tapahtuu |
|---|---|
| `id` | pudotetaan ja kirjataan hylätyksi |
| `time`, `endTime` | pudotetaan — aika tulee aikatauluttajalta |
| `completed`, `status` | pudotetaan — ehdotettu on aina kesken |
| `user_id` | pudotetaan |

Mallin ehdottama tunniste voisi olla käyttäjän olemassa olevan rivin
tunniste, ja "luonti" ylikirjoittaisi sen. Ehdotuksen sisäiset
viittaukset käyttävät paikallisia `ref`-avaimia, jotka `toCommittable`
kääntää oikeiksi tunnisteiksi vasta hyväksynnän jälkeen.

Kehote pyytää nämä; `src/ai/planSchema.js` **pakottaa** ne. Kehote on
kohteliaisuus, validointi on sopimus.

### 5. Tuntematon ei ole nolla

Tavoite ilman tehtäviä, välitavoitteita ja mittaria **ei ole 0 %
valmis**. Sen edistymistä ei tiedetä, ja käyttöliittymä sanoo sen.

Sama koskee ennustetta: määräpäivätön tavoite ei ole aikataulussa vaan
määräpäivätön. `INSUFFICIENT_DATA` on eri asia kuin `ON_TRACK`.

---

## Kapasiteetti: vuorokaudessa ei ole 24 suunniteltavaa tuntia

Suunnittelija, joka pitää vuorokautta 1440 minuutin säiliönä, tuottaa
suunnitelmia jotka ovat aritmeettisesti mahdollisia ja inhimillisesti
mahdottomia — ja mahdoton suunnitelma näyttää täsmälleen yhtä valmiilta
kuin mahdollinen.

Päivä kuluu neljään osaan:

| Osa | Mistä tulee |
|---|---|
| **Uni** | profiilista, ei suunniteltavissa |
| **Kiinteä** | käyttäjän itse ajastama työ |
| **Joustava** | automaatin sijoittama, siirrettävissä |
| **Vapaa** | se mitä jää — ja siitäkään ei käytetä kaikkea |

`bufferRatio` (oletus 0,25) jättää neljänneksen vapaasta ajasta
suunnittelematta. **Puskuri ei ole hukkaa vaan realismia:** täyteen
ahdettu kalenteri epäonnistuu ensimmäisestä yllätyksestä, ja
epäonnistunut suunnitelma opettaa käyttäjän olemaan luottamatta
suunnitelmiin.

Puskuri lasketaan **vapaasta ajasta**, ei valveillaoloajasta — muuten
täysi päivä kuluttaisi sen kahdesti.

---

## Automaatiotasot

| Taso | Mitä sallii | Oletus |
|---|---|---|
| **1** Vain ehdotukset | ei mitään ilman hyväksyntää | **kyllä** |
| **2** Saman päivän sisällä | joustavan työn siirto päivän sisällä | |
| **3** Saman viikon sisällä | joustavan työn siirto viikon sisällä | |
| **4** Automaattinen optimointi | joustavan työn siirto horisontin sisällä | |

Taso 1 on oletus, ja se on tarkoituksellinen: käyttäjä joka ei ole
tehnyt valintaa ei ole antanut lupaa. Tuntematon tai rikkinäinen arvo
putoaa tasolle 1 — **ei lähimpään** vaan varovaisimpaan.

Taso 4 vaatii nimenomaisen valinnan (`requiresExplicitOptIn`), koska se
on ainoa taso, jolla järjestelmä muuttaa suunnitelmaa ennen kuin
käyttäjä näkee muutoksen. Käyttöliittymä sanoo sen ääneen.

Siirtoikkuna lasketaan **tehtävän nykyisestä päivästä**, ei tästä
päivästä: taso 2 tarkoittaa sen päivän sisällä, jossa tehtävä on.

---

## Kaksi moottoria, kaksi kysymystä

| Kysymys | Moottori |
|---|---|
| **Mille päivälle?** | `src/domain/planScheduler.js` (uusi) |
| **Mihin kohtaan päivää?** | `src/domain/scheduler.js` (olemassa) |

Olemassa oleva `proposeSchedule` sijoittaa kellonajat yhden päivän
sisällä ja tekee sen hyvin. Sitä ei kirjoitettu uudelleen: kaksi
toteutusta samasta sijoituslogiikasta erkanisi, ja toinen niistä
rikkoisi "älä siirrä kiinteää" -lupauksen ilman että kukaan huomaa.

### Priorisointisääntö on yhdessä paikassa

1. riippuvuudet ensin (topologinen taso)
2. määräpäivä (aikaisempi ensin)
3. tavoitteen prioriteetti
4. tehtävän prioriteetti
5. nimi — takaa determinismin

**Määräpäivä ennen prioriteettia** on tietoinen valinta: korkea
prioriteetti ilman määräpäivää ei saa syrjäyttää huomenna erääntyvää
normaalia työtä. Kiire on tosiasia, prioriteetti on mielipide.

### Portfoliotietoinen

Tehtävät sijoitetaan **yhteen jonoon** kaikkien tavoitteiden kesken.
Tavoite kerrallaan optimoiva aikatauluttaja tuottaa suunnitelmia,
joissa jokainen tavoite on erikseen mahdollinen ja kaikki yhdessä
mahdottomia — ja se näyttää oikealta jokaisesta tavoitenäkymästä
katsottuna.

`detectPortfolioConflicts` löytää sen, mitä tavoitekohtainen
tarkistus ei voi löytää.

---

## Edistymisstrategiat

Yhteensopimattomia mittareita **ei keskiarvoisteta**. "60 % tehtävistä,
2/5 välitavoitetta, paino 82/75" ei ole 47 %.

| Strategia | Mistä |
|---|---|
| `manual` | käyttäjän oma prosentti |
| `task_based` | valmiit tehtävät / kaikki |
| `project_based` | liitettyjen projektien tehtävistä |
| `routine_based` | liitettyjen rutiinien toteumasta |
| `milestone_based` | saavutetut / lasketut välitavoitteet |
| `metric_based` | mitattu arvo suhteessa lähtö- ja tavoitearvoon |
| `hybrid` | **nimetty painotettu** yhdistelmä |

Strategia näkyy vastauksessa. Käyttöliittymä kertoo mistä luku on
laskettu, ja käyttäjä voi olla eri mieltä strategiasta epäilemättä
laskutoimitusta.

Hybridin painot ovat näkyvissä (`HYBRID_WEIGHTS`), eivät piilotettuja
oletuksia. **Puuttuva osa on poissa, ei nolla** — painot normalisoidaan
jäljelle jäävien kesken.

### Mittari: kolme lukua eikä yhtä

```
baseline   mistä lähdettiin
current    missä ollaan nyt
target     mihin pyritään
```

Suunta **johdetaan** näistä. 82 kg on edistystä jos tavoite on 75 kg
lähtien 90:stä, ja taantumista jos tavoite on 90 lähtien 75:stä. Sama
luku, päinvastainen merkitys.

Edistyminen lasketaan **matkasta, ei arvosta** — sama kaava molempiin
suuntiin, ei kahta haaraa joissa etumerkki voi mennä väärin päin.

---

## Ennuste kantaa laatunsa mukanaan

| Tila | Merkitys |
|---|---|
| `on_track` | nykyvauhdilla ehtii |
| `at_risk` | ehtii vain jos mikään ei mene pieleen |
| `delayed` | ei ehdi |
| `insufficient_data` | **ei tarpeeksi tietoa — eri asia kuin aikataulussa** |

| Laatu | Merkitys |
|---|---|
| `good` | tarpeeksi historiaa ja kestoarvioita |
| `weak` | laskettavissa, mutta ohuella pohjalla |
| `none` | ei laskettavissa |

"At risk" hyvällä laadulla ja "at risk" heikolla laadulla ovat eri
väitteitä. Käyttöliittymä näyttää eron, koska käyttäjä tekee eri
päätöksiä niiden perusteella.

Vauhtia ei lasketa alle kolmesta valmiista tehtävästä: yhdestä laskettu
vauhti on arvaus, joka esiintyy mittauksena.

### Korjaavat toimet

Järjestys on tarkoituksellinen — **vähiten tuhoava ensin**:

1. siirrä joustavaa työtä
2. karsi laajuutta
3. pilko isot tehtävät
4. harkitse toisen tavoitteen taukoa
5. varaa enemmän aikaa
6. **siirrä määräpäivää** — viimeisenä, koska se on tehokkain ja
   tuhoavin: se tekee ongelmasta näkymättömän muuttamatta mitään
   todellista

**Tavoitetta ei koskaan luovuteta automaattisesti.** Luovuttaminen on
päätös, ja päätös on käyttäjän.

---

## Ristiriidat

Kolme vakavuutta, ja raja on määritelty:

| Vakavuus | Merkitys |
|---|---|
| `info` | huomionarvoista, ei estä |
| `warning` | toteutuu vain jos kaikki menee hyvin |
| `blocking` | ei voi toteutua sellaisenaan |

**Estävä ei estä käyttäjää hyväksymästä suunnitelmaa.** Se estää
järjestelmää väittämästä, että suunnitelma on kunnossa. Päätös on
käyttäjän; totuus ei ole.

Suunnittelija, joka sanoo "tiukka mutta tehtävissä" tilanteessa jossa
työtä on 18 tuntia ja aikaa 10, ei ole kohtelias vaan epärehellinen.

---

## Mukautuva uudelleensuunnittelu

Kun tehtävä jää tekemättä, oikea vastaus on

> "Siirrä 'Viimeistele X' tiistailta torstaille."

eikä

> "Tässä uusi suunnitelma kaikille tavoitteillesi."

Koko suunnitelman uudelleengenerointi on käyttäjälle kallista kahdesti:
hän joutuu tarkistamaan kaiken uudelleen, ja hän menettää jo tekemänsä
päätökset. Muutos, jota ei voi lukea yhdellä silmäyksellä, hyväksytään
lukematta — ja silloin hyväksyntä lakkaa tarkoittamasta mitään.

**Laukaisinta ei keksitä.** `detectReplanTriggers` ehdottaa vain kun on
syy: myöhässä oleva tehtävä, toistuvasti väliin jäänyt rutiini,
myöhästynyt välitavoite. Jatkuva "haluatko järjestellä uudelleen"
opettaa käyttäjän ohittamaan kysymyksen.

**Tauolla olevan tavoitteen työtä ei suunnitella.** Jos aikatauluttaja
sijoittaisi sen tehtäviä, tauko ei tarkoittaisi mitään.

---

## Yhteydet olemassa olevaan

### Talous 2.0

Rahatavoite kytketään säästötavoitteeseen (`goals.savings_goal_id`), ja
**laskenta tehdään Taloudessa**:

| Mitä tarvitaan | Mistä tulee |
|---|---|
| kuukausierä | `monthlyContributionMinor` |
| kuukaudet maaliin | `monthsToReach` |
| ehdotus ylijäämästä | `suggestSavingsMinor` |

Tätä laskentaa **ei toisteta**. Kytketty tavoite ei myöskään saa kantaa
omaa mittariaan — kaksi lukua samasta asiasta erkanisi heti kun toista
päivitetään. Kanta valvoo sen
(`goals_savings_exclusive_check`), samoin `validateGoal`.

**Rahaa ei siirretä.** Manifestivalilla ei ole pankkiyhteyttä.

### Hyvinvointi

`planningLoadSuggestion` (olemassa) tuottaa ehdotuksen kuormituksen
keventämisestä, kun päivä näyttää raskaalta. Se on **ehdotus**, ja se
on selitettävissä: se nojaa käyttäjän omiin merkintöihin ja päivän
suunniteltuun kuormaan.

**Manifestival ei diagnosoi eikä päättele terveydentilaa.** Se laskee
kuormaa ja kertoo mihin laskelma perustuu.

### Ääni

Puhe muuttuu tekstiksi `src/app/voice.js`:ssä ja tulee samaan
`requestPlan`-funktioon samana merkkijonona. **Erillistä
puhesuunnittelijaa ei ole eikä tule** — kaksi polkua erkanisi.

### Kalenteri

Suunnittelu käyttää Manifestivalin omaa aikataulumallia. Ulkoista
kalenteria ei ole eikä tässä paketissa toteuteta. Sovitinraja on
`planHorizon`in syöte: ulkoiset sitoumukset tulisivat sisään
kiinteinä tehtävinä, jolloin kapasiteettilaskenta ottaisi ne huomioon
ilman muutoksia muualle.

---

## Tekoälyn turva

| Vaatimus | Toteutus |
|---|---|
| API-avain vain palvelimella | `api/plan.js`, `process.env` |
| Kirjautuminen | `api/_auth.js` |
| Pyyntörajoitin | `api/_ratelimit.js`, oma avain `plan:` |
| Syötevalidointi | `api/_validatePlan.js` |
| Aikakatkaisu | 45 s |
| Tulosvalidointi | `src/ai/planSchema.js`, fail closed |
| Ei salaisuuksia lokiin | tilakoodi, ei runkoa |

### Konteksti on lukuja

Mallille lähetetään **vain se, mitä suunnitteluun tarvitaan**:

```
activeGoalCount       montako tavoitetta kilpailee ajasta
nearestDeadlineDays   kuinka monen päivän päässä lähin määräpäivä on
weeklyFreeHours       paljonko vapaata aikaa viikossa on
```

Käyttäjän tehtävälista, muistiinpanot, hyvinvointimerkinnät ja
taloustiedot **eivät lähde ulos**. Numero ei voi sisältää ohjetta, eikä
siitä voi lukea mitä käyttäjä tekee tai ajattelee.

Lukittu testillä: `buildPlanningContext` serialisoituna ei saa sisältää
yhdenkään tavoitteen nimeä.

---

## Tietokanta

Migraatio: `supabase/migrations/0010_goal_to_action.sql`
Varmistus: `supabase/verify/verify_0010.sql`

**TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.**

### ⚠ Tämä migraatio on vaarallisempi kuin aiemmat

Migraatiot 0003–0009 **loivat** uusia tauluja. Tyhjää taulua ei voi
rikkoa.

Migraatio 0010 **muuttaa kolmea taulua, joissa on käyttäjän oikeaa
dataa ja joiden portit ovat auki tuotannossa:**

| Taulu | Tila tuotannossa |
|---|---|
| `goals` | aalto B ajettu (`ddfc356`), portti auki |
| `projects` | aalto B ajettu (`ddfc356`), portti auki |
| `tasks` | migraatiot 0001/0002 ajettu, portti auki |

Erityisesti: **`goals_status_check` pudotetaan ja luodaan uudelleen**.
Migraatio on yksi transaktio: keskeytynyt tai virheeseen päättynyt ajo
perutaan kokonaan, ja rajoite jää ennalleen. Taulu voi jäädä ilman
tilarajoitetta **vain, jos tiedostosta ajetaan VALINTA** (osa lauseista
editorissa valittuna) — eikä mikään sovelluksessa huomaisi sitä. Siksi
tiedosto ajetaan aina kokonaan; `preflight_0010.sql` rivi 09 ja
`verify_0010.sql` rivi 20 paljastavat puuttuvan rajoitteen. Migraation
vaihe 5 tarkistaa sen ennen committia; `verify_0010.sql` tarkistukset
20–22 sen jälkeen.

**Varmuuskopio ei ole muodollisuus. Esitarkistus on pakollinen.**

### Mitä muuttuu

| Kohde | Muutos |
|---|---|
| `public.milestones` | uusi taulu |
| `public.goals` | 7 uutta nullable-saraketta + tilarajoite korvataan |
| `public.tasks` | `milestone_id`, `depends_on` |
| `public.projects` | `milestone_id` |
| `public.profile` | `automation_level`, `planning_buffer_ratio` |

### Miksi riippuvuuksille ei ole taulua

`tasks.depends_on` on `text[]` eikä liitostaulu:

- riippuvuus on tehtävän ominaisuus, ei itsenäinen olio
- liitostaulu vaatisi oman RLS:nsä ja politiikkansa
- lista on lyhyt (sovellus rajaa kymmeneen)

Hinta: kanta ei voi valvoa viite-eheyttä taulukon sisällä. Poistettu
edeltäjä jättää roikkuvan tunnisteen, jonka sovellus ohittaa hiljaa.
**Roikkuva tunniste on pienempi vahinko kuin tehtävän poiston
estäminen.**

---

## Portit

| Portti | Migraatio | Tila | Virhe jos avataan liian aikaisin |
|---|---|---|---|
| `milestones` | 0010 | kiinni | `42P01` taulua ei ole |
| `GOAL_PLANNING_FIELDS` | 0010 | kiinni | `42703` saraketta ei ole |
| `GOAL_MAINTENANCE_MODE` | 0010 | kiinni | `23514` rajoiterikkomus |

Keskimmäinen on se, joka tekee tästä erilaisen: sen ennenaikainen
avaaminen ei kaataisi uutta ominaisuutta vaan **jokaisen tavoitteen,
tehtävän ja projektin tallennuksen** — myös niiden, jotka toimivat
tänään.

Sarakeportti ja arvoportti ovat erillisiä, koska niiden viat ovat
erilaisia ja oireet eri.

**Portit ohjaavat säilyvyyttä, eivät näkyvyyttä.** Koko
Tavoitesuunnittelun käyttöliittymä toimii porttien ollessa kiinni:
tieto elää istunnon muistissa ja käyttöliittymä kertoo sen.

### Automaatiotaso on toistaiseksi laitekohtainen

`DEVICE_DEFAULTS.automationLevel` toimii tänään ilman migraatiota ja
**epäonnistuu turvallisesti**: uusi laite alkaa tasolta 1.

Tilikohtainen olisi oikeampi (asetus koskee käyttäjää, ei laitetta), ja
sarake `profile.automation_level` syntyy migraatiossa 0010. Siirto
tehdään kun portti avataan.

Väärä vaihtoehto olisi ollut jättää asetus kokonaan pois kunnes
migraatio on ajettu — silloin käyttäjä ei voisi valita lainkaan, ja
valitsematta jättäminen on itsessään valinta.

---

## Julkaisujärjestys

**Sama avoin päätös kuin Talous 2.0:ssa, ja nyt se koskee kahta
pakettia.**

Aallot A–E on numeroitu `v14`–`v18`, aalto F `v19` ja aalto G `v20`.
Tuotannossa on aalto B (`v15`).

Kummankaan tuotekoodille — Talous 2.0 eikä Tavoitesuunnittelu — **ei
ole annettu cache-versiota**, koska oikea numero riippuu
deployjärjestyksestä. Cache-versio ei saa koskaan laskea: selain, joka
on kerran nähnyt numeron `v20`, ei asenna service workeria uudelleen
numerolle `v17`.

Tämä haara on kehityshaara. `sw.js` on yhä perustilan `v13`.
Deploypaketti valitsee numeron ja nostaa sen samassa commitissa.

---

## Missä koodi on

| Tiedosto | Vastuu |
|---|---|
| `src/domain/milestone.js` | Välitavoite: tila, jono, edistyminen |
| `src/domain/goalTarget.js` | Mitattava kohde, suunta, matka |
| `src/domain/goalProgress.js` | Nimetyt edistymisstrategiat |
| `src/domain/capacity.js` | Kapasiteetti, puskuri, jäljellä oleva työ |
| `src/domain/automation.js` | Automaatiotasot ja siirtoikkunat |
| `src/domain/conflicts.js` | Ristiriidat vakavuuksineen |
| `src/domain/plan.js` | **Ehdotuksen elinkaari ja hyväksyntäportti** |
| `src/domain/planScheduler.js` | Horisonttiaikataulutus |
| `src/domain/forecast.js` | Ennuste, laatu, korjaavat toimet |
| `src/domain/replan.js` | Delta-ehdotukset |
| `src/ai/planSchema.js` | Mallin vastauksen validointi |
| `api/plan.js` | Palvelinpuolen suunnittelija |
| `src/app/planning.js` | **Ainoa polku tallennukseen** |
| `src/app/views/planning.js` | Ehdotus ja tarkistus |
| `src/app/views/goalDetail.js` | Tavoitteen yksityiskohdat |

---

## Mitä seuraavaksi

1. **Migraation 0010 hyväksyntä ja ajo** — Panun päätös. Esitarkistus
   on migraatiotiedoston lopussa ja se on vain lukeva. **Varmuuskopio
   ensin.**
2. **Tuotekoodin deploypaketti** — cache-version valinta kahdelle
   paketille, ks. "Julkaisujärjestys".
3. **Aalto G** — `docs/acceptance/WAVE-G.md`, estettynä kunnes 1 on
   tehty.
4. **Automaatiotason siirto tiliin** — sarake on olemassa migraation
   jälkeen.
5. **Ulkoinen kalenteri** — sovitinraja on kuvattu, toteutusta ei ole.
