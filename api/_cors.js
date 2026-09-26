// CORS AI-päätepisteille: vain sovelluksen natiivikuori saa lukea
// vastauksen toisesta originista.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Webissä sovellus ja /api/* ovat samassa originissa, eikä selain tarvitse
// CORS-otsakkeita. Natiivikuoressa sivu ladataan laitteen omasta originista
// ja kutsu menee tuotannon osoitteeseen (src/platform/index.js apiUrl).
// Authorization- ja Content-Type-otsakkeet pakottavat selaimen
// esikyselyyn (OPTIONS). Jos siihen vastataan 405, WebView estää varsinaisen
// kutsun ja asiakas näkee vain verkkovirheen: puhe, tekstikomennot ja
// selitys eivät toimisi puhelimessa koskaan.
//
// SALLITUT ORIGINIT — TÄSMÄLLEEN NÄMÄ
//
//   https://localhost      Android (Capacitor, androidScheme 'https')
//   capacitor://localhost  iOS (Capacitor)
//
// Ei jokerimerkkiä eikä mielivaltaisen originin heijastusta: tuntematon
// origin ei saa Access-Control-Allow-Origin-otsaketta, joten selain ei
// anna sivun lukea vastausta.
//
// CORS EI OLE TODENNUS. Kutsu vaatii yhä kirjautumisen (api/_auth.js) ja
// kuluttaa käyttäjän pyyntörajaa (api/_ratelimit.js). CORS päättää vain,
// saako selainsivu lukea vastauksen.

/** Originit, joiden sivut saavat kutsua AI-päätepisteitä ristiin. */
const ALLOWED_ORIGINS = Object.freeze(['https://localhost', 'capacitor://localhost']);

/** Esikyselyn tuloksen välimuistiaika sekunteina. */
const MAX_AGE_SECONDS = 600;

/** Onko origin sallittu? Vertailu on tarkka merkkijonovertailu. */
function isAllowedOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin);
}

/**
 * Aseta CORS-otsakkeet ja vastaa esikyselyyn.
 *
 * Kutsutaan käsittelijän ENSIMMÄISENÄ, ennen metoditarkistusta: muuten
 * OPTIONS saisi 405:n eikä selain lähettäisi varsinaista POSTia.
 *
 * @returns {boolean} true = pyyntö käsiteltiin (OPTIONS -> 204), käsittelijä
 *                    lopettaa. false = jatka normaalisti.
 */
function applyCors(req, res) {
  const headers = (req && req.headers) || {};
  const origin = headers.origin || headers.Origin;

  // Vastaus riippuu Origin-otsakkeesta: välimuisti ei saa jakaa sitä
  // originien kesken.
  res.setHeader('Vary', 'Origin');

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
  }

  if (req && req.method === 'OPTIONS') {
    // Esikysely ei koske todennukseen eikä kiintiöön. Tuntematon origin
    // saa saman 204:n ilman sallintaotsakkeita, jolloin selain estää
    // varsinaisen kutsun.
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyCors, isAllowedOrigin, ALLOWED_ORIGINS, MAX_AGE_SECONDS };
