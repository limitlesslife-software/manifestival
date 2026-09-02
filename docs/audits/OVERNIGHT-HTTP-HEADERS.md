# HTTP-turvaotsakkeet

Ennen tätä työtä sovelluksella **ei ollut yhtäkään turvaotsaketta** eikä
`vercel.json`-tiedostoa lainkaan. Nyt on.

**Mitään ei ole deployattu.** Tiedosto on staattinen konfiguraatio, joka
astuu voimaan vasta seuraavassa käyttöönotossa.

## Käytössä (pakotettuina)

| Otsake | Arvo | Miksi |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Estää selainta arvaamasta sisältötyyppiä |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Polku ja kyselymerkkijono eivät vuoda ulos |
| `X-Frame-Options` | `DENY` | Sovellusta ei voi upottaa kehykseen |
| `Permissions-Policy` | ks. alla | Käyttämättömät laiterajapinnat suljetaan |
| `Cache-Control: no-store` (vain `/api/*`) | | AI-vastaukset eivät jää välimuistiin |

`Permissions-Policy` sulkee sijainnin, kameran, maksut, USB:n ja
liikeanturit. **Mikrofonia ei suljeta**, koska puhekomennot käyttävät sitä.
Sijainti on suljettu tarkoituksella: arkkitehtuuri on suunniteltu
([`LOCATION-DEPARTURE-ARCHITECTURE.md`](../LOCATION-DEPARTURE-ARCHITECTURE.md))
mutta toteutusta ei ole, joten lupaa ei pidä olla auki.

## CSP on RAPORTOIVA, ei pakottava

```
Content-Security-Policy-Report-Only
```

Tämä on tietoinen valinta. Liian tiukka CSP rikkoo sovelluksen
hiljaisesti, ja sen todentaminen vaatii oikean selaimen oikeaa
käyttöönottoa vasten — mitä tässä työssä ei tehdä eikä saa tehdä.
Raportoiva muoto ei estä mitään, joten se ei voi rikkoa mitään.

Politiikka on johdettu lähdekoodista, ei arvattu:

| Direktiivi | Lähde |
|---|---|
| `script-src 'self' https://cdn.jsdelivr.net` | `index.html:20` lataa Supabasen UMD-paketin. **Ei `unsafe-inline`** — sivulla ei ole yhtään inline-skriptiä eikä `onclick`-käsittelijää (tarkistettu) |
| `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` | 39 `style="…"`-attribuuttia ja 22 `.style.`-kirjoitusta JS:ssä. `unsafe-inline` on pakko, kunnes ne siirretään luokkiin |
| `font-src 'self' https://fonts.gstatic.com` | Google Fonts, `index.html:16–18` |
| `connect-src 'self' + Supabase (https ja wss)` | Ainoa selaimesta kutsuttava ulkopuolinen palvelu |
| `img-src 'self' data:` | Sovelluskuvakkeet |
| `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'` | Vakiokovennukset |

**`api.anthropic.com` EI ole `connect-src`-listalla, eikä sitä saa lisätä.**
Selain ei kutsu Anthropicia — kutsun tekee `/api/parse` palvelimella, jotta
avain ei koskaan päädy laitteelle. Jos tämä osoite joskus ilmestyy
politiikkaan, se on merkki siitä että avain on vuotamassa selaimeen.

### Miten CSP otetaan pakottavaksi

1. Deployaa nykyisellä raportoivalla politiikalla
2. Käytä sovellus läpi selaimen konsoli auki: kirjautuminen, tehtävät,
   rutiinit, puhekomento, AI-komento, asetukset
3. Jos konsoliin ei tule yhtään CSP-rikkomusta, vaihda avaimen nimi
   `Content-Security-Policy-Report-Only` → `Content-Security-Policy`
4. Jos rikkomuksia tulee, korjaa **sovellus**, älä löysennä politiikkaa

## HSTS — tietoinen poisjättö

`Strict-Transport-Security` **ei ole** tässä tiedostossa.

Kaksi syytä. Vercel asettaa HSTS:n omilla verkkotunnuksillaan valmiiksi,
joten se olisi päällekkäinen. Ja pitkä `max-age` on käytännössä
peruuttamaton: selain muistaa sen kuukausia riippumatta siitä mitä
palvelin myöhemmin sanoo. Sellaista ei aseteta ohimennen yöajossa vaan
omalla päätöksellään, kun oma verkkotunnus on käytössä.

## Todentamatta

Otsakkeiden voimassaolo tuotannossa. `vercel.json` on syntaktisesti
tarkistettu ja sisältö testattu (`tests/http-headers.test.mjs`), mutta
sitä ei ole otettu käyttöön eikä yhtään vastausta ole luettu.
