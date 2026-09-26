# Aalto F — Talous 2.0: tapahtumat ja sijoitukset

**Portit:** `transactions`, `investments`, `BILL_PAYMENT_FIELDS`
**Taulut:** `transactions`, `investments` (+ kolme saraketta `bills`-tauluun)
**Välimuistiversio:** `v19`
**Edellinen tuotanto:** aallon E commit (v18)
**Peruutuskohde:** aalto E

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon F `deployTarget` — täysi 40-merkkinen SHA, sama kuin kohdan
"Deploy" push-rivillä. Manifestin (`docs/activation-0003-0008-release-manifest.json`)
`commitSha` on aallon AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde.
Push tehdään orkestroijalla (`npm run activation:orchestrate -- --execute-deploy
--approved-sha=<deployTarget>`), joka tarkistaa ensin, että `origin`in main on
yhä odotettu edellinen SHA.

---

## LUE TÄMÄ ENSIN: aalto F on ESTETTY

**Migraatiota `0009_finance_2.sql` ei ole ajettu tuotantoon.**

Tämä ei ole muistutus vaan este. Aallon F portit avaavat kirjoituksen
tauluihin `transactions` ja `investments` sekä `bills`-taulun
sarakkeisiin `payee`, `iban` ja `reference`. **Yhtäkään niistä ei ole
tuotantokannassa.** Porttien avaaminen ennen migraatiota kaataisi
jokaisen tapahtuman, sijoituksen ja laskun tallennuksen — tapahtumat ja
sijoitukset koodilla `42P01` (taulua ei ole), laskut koodilla `42703`
(saraketta ei ole).

### Mikä ei ole estettynä

Talous 2.0:n **sovelluskoodi** on valmis ja se toimii porttien ollessa
kiinni. Käyttäjä voi kirjata tapahtumia, tuloja, kuitteja ja
sijoituksia; ne elävät istunnon muistissa ja käyttöliittymä sanoo sen
ääneen. Tämä on sama tila kuin kaikilla muillakin domaineilla ennen
niiden omaa aaltoa.

### Mitä esteen purkaminen vaatii

1. Panun kirjallinen hyväksyntä migraatiolle 0009
2. Varmuuskopio
3. Migraation esitarkistus (vain lukeva, tiedoston lopussa)
4. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
5. `supabase/verify/verify_0009.sql` → **poikkeavia_yhteensa = 0**

Vasta sen jälkeen tämä paketti on ajettavissa, ja vasta silloin aallon
valmius `docs/PRODUCTION-STATUS.md`:ssä muuttuu ESTETTY → VALMIS.

---

## KOLME ASIAA, JOTKA TÄMÄ AALTO EI TEE

Nämä on syytä lukea ennen hyväksyntää, koska ne ovat suunnittelun
päätöksiä eivätkä puutteita.

### 1. Mikään ei maksa mitään

Manifestivalilla **ei ole pankkiyhteyttä eikä valtuutta siirtää rahaa.**

- Skannattu lasku syntyy aina tilassa `open`. Se ei ole maksettu.
- `iban` ja `reference` ovat tietoa, jonka käyttäjä kopioi omaan
  pankkiinsa. Ne eivät käynnistä mitään.
- Säästösiirto on **kirjaus** siitä, että käyttäjä siirsi rahaa itse.

Jos hyväksynnän aikana jokin näyttää siltä kuin sovellus olisi maksanut
laskun, **keskeytä ja peruuta**.

### 2. Kuitin kuvaa ei tallenneta minnekään

Kuittitaulua **ei ole** — ei tässä migraatiossa eikä missään. Luenta
elää istunnon muistissa siihen asti että käyttäjä hyväksyy sen, ja
hyväksytystä luennasta syntyy tavallinen rivi `transactions`-tauluun.
Kuva vapautetaan heti.

Tarkistuslista hyväksynnässä:

- [ ] `transactions`-taulussa ei ole yhtään saraketta, joka voisi
      sisältää kuvaa (varmistuksen tarkistukset 02 ja 03)
- [ ] Selaimen verkkoliikenteessä kuva ei mene Supabaseen

### 3. Kursseja ei keksitä

`investments.current_value_minor` on **NULL kun arvoa ei tiedetä** — ei
nolla. Markkinadatan toimittajaa ei ole, eikä sovellus hae kursseja
mistään. Rajoite `investments_unknown_value_check` valvoo, ettei
tuntematon arvo voi väittää olevansa käsin kirjattu.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon E SHA
npm run activation:verify-wave -- F
npm run activation:preflight -- --wave=F
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Migraatio 0009 on ajettu ja `verify_0009.sql` antoi 0 poikkeavaa**
- [ ] Kaikki kaksitoista porttia auki
- [ ] `BILL_PAYMENT_FIELDS` on `true`
- [ ] `TASK_EXTENDED_FIELDS` yhä `true`
- [ ] `CACHE_VERSION` on `v19`

### Diffin tarkistus

```
git diff <WAVE-E-SHA>..<WAVE-F-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin 5e4e7cf50e40fe1e0ba7b4543b147767e3a0eb32:refs/heads/main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=F
```

- [ ] HTTP 200, `CACHE_VERSION` `v19`
- [ ] Kaikki kaksitoista porttia `true`
- [ ] `TASK_EXTENDED_FIELDS = true`

---

## 4. Selainhyväksyntä

Jokainen kohta tarkistetaan **sivun latauksen jälkeen** — se on ainoa
tapa erottaa tallennus muistista.

### Tapahtumat

- [ ] Luo meno: summa, päivä, kululuokka → säilyy latauksen yli
- [ ] Luo tulo: palkka → säilyy, ja **kasvattaa** kuukauden tulosta
- [ ] Muokkaa tapahtuman summaa → muutos säilyy
- [ ] Poista tapahtuma → poistuu, eikä lähdelasku muutu

### Kaksoislaskennan esto

Tämä on aallon tärkein yksittäinen tarkistus.

- [ ] Merkitse avoin lasku maksetuksi → syntyy **yksi** tapahtuma
- [ ] Budjetissa lasku näkyy menona **kerran**, ei kahdesti
- [ ] Merkitse sama lasku uudelleen maksetuksi → **uutta tapahtumaa ei
      synny**

### Kuitti

- [ ] Ota kuva kuitista → luenta ilmestyy **ehdotuksena**
- [ ] Luenta **ei** tallennu ennen hyväksyntää
- [ ] Korjaa luennasta yksi kenttä → tila palaa tarkistettavaksi
- [ ] Hyväksy → syntyy tapahtuma, luenta katoaa
- [ ] Hylkää toinen luenta → **mitään ei tallennu**

### Laskun skannaus

- [ ] Skannattu lasku syntyy tilassa **avoin**
- [ ] Lasku **ei** ole maksettu automaattisesti
- [ ] `payee`, `iban` ja `reference` säilyvät latauksen yli

### Sijoitukset

- [ ] Luo sijoitus ilman arvoa → näkyy **tuntemattomana**, ei nollana
- [ ] Kirjaa arvo käsin → tuotto lasketaan ja päiväys näkyy
- [ ] Vanha arvo (yli 30 vrk) merkitään vanhentuneeksi

### Aiemmat aallot

- [ ] Aaltojen A–E ominaisuudet toimivat kaikki yhä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0009.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0009) | Odotus |
|---|---|
| 14 — `transactions` ei viittaa public-tauluihin | PASS |
| 21 — tuntematon sijoitusarvo on lähteestä `unknown` | PASS |
| 22 — lähdelaji ja -tunniste esiintyvät parina | PASS |
| 24 — yksikään summa ei ole nolla tai negatiivinen | PASS |
| 28 — `bills`-taulun uudet sarakkeet ovat nullable | PASS |
| 30–32 — rivimäärät | INFO |

> Tarkistus **14** on se, jota ei saa ohittaa. Jos `source_id`:stä on
> tehty vierasavain, laskun poisto veisi maksukirjauksen mukanaan —
> juuri sen tiedon, jonka takia tapahtuma on olemassa.

---

## 6. Peruutus

**Laukaisin:**

- tapahtuman, sijoituksen tai laskun tallennus epäonnistuu
- sama meno näkyy budjetissa kahdesti
- kuitin kuva päätyy verkkoliikenteessä Supabaseen
- skannattu lasku syntyy maksettuna
- `failures_total > 0` tai `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-F-SHA>
# revert-commitissa: nosta CACHE_VERSION v19 -> v20
git push origin HEAD:main
```

Palauttaa **aallon E** tilan.

> **Kantaa ei peruuteta.** Portin sulkeminen riittää: taulut jäävät
> paikoilleen tyhjinä tai rivien kanssa, ja sovellus lakkaa
> kirjoittamasta niihin. Rivien poisto SQL:llä ohittaisi domainin
> säännöt ja veisi käyttäjän omaa dataa.
>
> Migraation peruutus on erikseen migraatiotiedoston lopussa, ja se on
> oma päätöksensä — ei osa aallon peruutusta.

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto F ja portit
- [ ] `docs/FINANCE-2.0.md` päivitetty: tila ESTETTY → tuotannossa
- [ ] Peruutusta ei ole voimassa

### Jäljelle jäävät asiat

1. **Markkinadatan toimittaja** — rajapinta on kuvattu
   (`MARKET_DATA_CONTRACT`), toteutusta ei ole
2. **Laitehyväksyntä** — `docs/DEVICE-ACCEPTANCE-BACKLOG.md`
