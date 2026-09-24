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
- `delete` vaatii täsmälleen oman sähköpostin ja vahvistuslauseen sekä
  tuoreen kirjautumisen (15 min). Poisto on yksi `auth.admin.deleteUser`-
  kutsu; kaikki käyttäjätaulut kaskadoituvat atomisesti.
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
5. Vasta sen jälkeen `ACCOUNT_DELETION.endpointEnabled = true` (`src/data/config.js`).
