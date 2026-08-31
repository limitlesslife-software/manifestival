// Muotoilu ja merkkijonojen käsittely. Puhtaita funktioita, ei DOM:ia.

export const WD_SHORT = Object.freeze(['SU', 'MA', 'TI', 'KE', 'TO', 'PE', 'LA']);

export const WD_FULL = Object.freeze([
  'sunnuntai', 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai'
]);

export const MONTHS = Object.freeze([
  'tammikuuta', 'helmikuuta', 'maaliskuuta', 'huhtikuuta', 'toukokuuta', 'kesäkuuta',
  'heinäkuuta', 'elokuuta', 'syyskuuta', 'lokakuuta', 'marraskuuta', 'joulukuuta'
]);

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

/**
 * Suojaa käyttäjän syöttämän tekstin HTML-koosteeseen.
 *
 * Aiempi toteutus käytti document.createElement -kiertotietä, jolloin sitä ei
 * voinut testata ilman selainta eikä se suojannut lainausmerkkejä. Tämä
 * versio suojaa myös ne, joten sama funktio kelpaa myös attribuuttikontekstiin.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Ensimmäinen kirjain isoksi. Tyhjä syöte palautuu tyhjänä. */
export function capitalize(value) {
  const s = String(value ?? '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Aikaväli luettavaksi tekstiksi.
 *   ('07:00', '08:00') -> '07:00–08:00'
 *   ('07:00', null)    -> '07:00'
 *   (null, ...)        -> null
 */
export function formatTimeRange(time, endTime) {
  if (!time) return null;
  return endTime ? `${time}–${endTime}` : time;
}

/** Minuutit luettavaksi kestoksi: 90 -> '1 h 30 min', 45 -> '45 min'. */
export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Päivämäärä 'YYYY-MM-DD' -> '31. elokuuta'. */
export function formatLongDate(date) {
  return `${date.getDate()}. ${MONTHS[date.getMonth()]}`;
}

/** Päivämäärä lyhyesti: '31.8.' */
export function formatShortDate(date) {
  return `${date.getDate()}.${date.getMonth() + 1}.`;
}
