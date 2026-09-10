// Riskitasot ja kielletyt toimenpiteet.
//
// =====================================================================
// MIKSI TÄMÄ ON DOMAINISSA EIKÄ AI-KERROKSESSA
// =====================================================================
//
// Nämä olivat aiemmin `src/ai/intentSchema.js`:ssä, koska ne otettiin
// ensin käyttöön puhekomennoissa. Se oli oikea paikka niin kauan kuin
// tekoäly oli ainoa, joka niitä tarvitsi.
//
// Universaali kirjaus tarvitsee ne myös — ja domain ei saa riippua
// AI-kerroksesta. Riippuvuussuunta on domain <- ai, ei toisin päin:
// tekoäly on yksi tapa tuottaa syötettä, ei sääntöjen lähde.
//
// Siksi vokabulaari asuu nyt täällä ja `intentSchema.js` tuo sen.
// Kahta kopiota ei tehty: kaksi luetteloa kielletyistä toimenpiteistä
// erkanisi, ja toinen niistä olisi vanhentunut juuri silloin kun sitä
// tarvittaisiin.
//
// =====================================================================
// KIELLETTY EI OLE SAMA KUIN SUOJATTU
// =====================================================================
//
// `delete_task` on olemassa ja se on suojattu: se kysyy vahvistuksen.
//
// `delete_all` EI OLE OLEMASSA. Massapoistoa ei voi vahvistaa
// mielekkäästi yhdellä dialogilla — käyttäjä ei voi tietää mitä hän
// hyväksyy. Sitä ei siis toteuteta, ja tämä lista on se paikka, jossa
// päätös näkyy.

/**
 * Riskitasot.
 *
 *   LOW     ei muuta mitään. Vahvistusta ei kysytä — se olisi pelkkää kitkaa.
 *   MEDIUM  luo tai muuttaa. Vahvistus kysytään.
 *   HIGH    poistaa tai on muuten peruuttamaton. Eksplisiittinen vahvistus,
 *           jota EI voi kytkeä pois asetuksista.
 */
export const RISK = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
});

export const RISK_LEVELS = Object.freeze(Object.values(RISK));

/**
 * Toimenpiteet, joita EI ole eikä tule ilman erillistä suunnittelua.
 *
 * Lista on dokumentaatiota ja testattava invariantti. Se ei estä
 * mitään yksinään — se kertoo, mitä ei ole toteutettu, ja antaa
 * validoinnille tavan tunnistaa yritys.
 */
export const FORBIDDEN_INTENTS = Object.freeze([
  'delete_all', 'delete_account', 'delete_everything',
  'drop_table', 'truncate', 'execute_sql', 'run_query',
  'change_owner', 'transfer_data',
  'disable_security', 'grant_access', 'read_secrets', 'export_all'
]);

/**
 * Sisältääkö arvo kielletyn toimenpiteen?
 *
 * Karkea tekstihaku on tarkoituksellinen: tämä ei tulkitse vaan
 * torjuu. Väärä positiivinen on halpa (tulkinta menee tarkistettavaksi),
 * väärä negatiivinen ei ole.
 */
export function isForbidden(value) {
  if (value == null) return false;
  const text = String(value).toLowerCase();
  return FORBIDDEN_INTENTS.some(forbidden => text.includes(forbidden));
}
