# Supabase Edge Functions

**Tila: paikallinen lähdekoodi. Ei deployattu. Tuotantoon ei ole tehty mitään.**

## delete-account

Tilin poiston ainoa etuoikeutettu rajapinta. Korotettu avain (service-role /
secret key) elää vain tässä funktiossa, Supabasen ympäristössä — ei
selaimessa, ei Vercelin `api/`-hakemistossa, ei repositoriossa.

| Tiedosto | Tehtävä |
|---|---|
| `delete-account/handler.js` | Koko logiikka, riippuvuudet injektoitu, testattu Nodessa |
| `delete-account/index.ts` | Denon liima (`Deno.serve`) |
| `_shared/accountInventory.js` | Kokoelma → taulu/omistajasarake. Kopio `src/domain/accountLifecycle.js`:stä, testi vaatii identtisyyden |

### Rajapinta

`POST /functions/v1/delete-account`, `Authorization: Bearer <käyttäjän access token>`

```json
{ "mode": "dry_run" }
{ "mode": "delete", "confirmEmail": "oma@osoite.fi", "confirmPhrase": "POISTA TILINI" }
```

- Käyttäjän tunniste johdetaan tokenista palvelimella. Rungossa ei saa olla
  muita kenttiä (`userId` ym. → 400 `unexpected_field`).
- `dry_run` palauttaa rivimäärät kokoelmittain (ei rivien sisältöä).
  Jokaisella kokoelmalla on `present`: `true` (laskettu), `false` (taulua
  ei ole tässä kannassa, `rowCount: 0`) tai `null` (laskenta epäonnistui,
  `blockedReason: "count_failed"`). Puuttuvat luetellaan myös `absent`-listassa.
- `delete` vaatii täsmälleen oman sähköpostin ja vahvistuslauseen sekä
  tuoreen kirjautumisen (15 min). Poisto on yksi `auth.admin.deleteUser`-
  kutsu; kaikki käyttäjätaulut kaskadoituvat atomisesti.
- Poiston jälkeen rivit lasketaan uudelleen: `residual` (rivejä jäi),
  `unverified` (laskenta epäonnistui) ja `absent` (taulua ei ole).
  `complete` on `true` vain, kun `residual` ja `unverified` ovat tyhjiä.

### Puuttuvat taulut (tuotanto ennen aaltoa J)

Inventaario (`_shared/accountInventory.js`) kattaa kaikki 26 taulua, mutta
tuotanto etenee aalloittain: ennen kuin migraatiot 0009–0013 on ajettu,
osa tauluista puuttuu. Aallolla C kannassa on 12 taulua (`tasks`,
`profile`, `routines`, `routine_exceptions`, `goals`, `projects`,
`notification_preferences`, `wellbeing_entries`, `recurring_expenses`,
`bills`, `savings_goals`, `ai_action_audit`), ja loput 14 kokoelmaa
raportoidaan `absent`-listassa.

- Puuttuva taulu tunnistetaan PostgRESTin koodista `PGRST205` (vanhempi:
  `42P01`) tai HEAD-pyynnön 404:stä, jonka postgrest-js palauttaa muodossa
  `error: null, count: null, status: 204`. Muu virhe tai puuttuva määrä on
  `count_failed` eikä koskaan hiljainen nolla.
- Puuttuva taulu **ei estä** `complete: true` -tulosta: siinä ei voi olla
  rivejä, ja myöhemmin luotuna FK-kaskadi poistaa rivit kannassa.
- Jos yhtäkään taulua ei näy (kaikki "puuttuvat"), vika on yhteydessä eikä
  skeemassa: silloin kaikki raportoidaan `unverified`-listassa ja
  `complete` on `false`.
- **Tarkista kontrolloidussa testissä**, että kuiva-ajon `absent` vastaa
  tuotannon aaltoa. Jos `absent`-listassa on taulu, jonka migraatio on jo
  ajettu, PostgRESTin skeemavälimuisti on vanhentunut
  (`notify pgrst, 'reload schema'`) — kaskadi poistaa rivit silti, mutta
  esikatselu näyttää ne "ei käytössä".
- Virheet ovat vakiokoodeja. Supabasen viestiä, avaimia tai sähköpostia ei
  palauteta eikä lokiteta.

### Salaisuudet (vahvistettu Supabasen dokumentaatiosta 2026-09)

Hostattu funktio saa automaattisesti `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`
(JSON-sanakirja, uusi avainjärjestelmä) ja legacy-muuttujat
`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`. Mitään tähän
repositorioon ei tallenneta. Handler käyttää ensin `SUPABASE_SECRET_KEYS`:iä
(`default`-avain, muuten ensimmäinen) ja putoaa legacy-avaimeen. **Vahvista
sanakirjan avainnimi käyttöönotossa.**

Ainoa itse asetettava muuttuja:

```
supabase secrets set DELETE_ACCOUNT_ALLOWED_ORIGINS="https://manifestival-ten.vercel.app,https://localhost"
```

Tyhjä lista = CORS suljettu (selain ei voi kutsua funktiota).

### Käyttöönotto (OMISTAJAN TOIMENPIDE, ei suoritettu)

1. Päätä aiAudit-säilytys (ks. `RETENTION_DECISIONS`, `docs/ACCOUNT-DELETION.md`).
2. `supabase functions deploy delete-account` (JWT-vahvistus gatewayssä päällä).
3. Aseta `DELETE_ACCOUNT_ALLOWED_ORIGINS`.
4. Kontrolloitu testi kertakäyttöisellä testitilillä (ei oikealla käyttäjällä).
   Aallon J alapuolella kuiva-ajon `absent`-lista ei ole tyhjä (ks.
   "Puuttuvat taulut" yllä); vertaa se ajettuihin migraatioihin. Poiston
   odotettu tulos on silti `complete: true`.
5. Vasta sen jälkeen `ACCOUNT_DELETION.endpointEnabled = true` (`src/data/config.js`).
