// Puhtaat paivamaara- ja aikafunktiot.
//
// Irrotettu index.html-monoliitista WP1:ssa, jotta nama voidaan testata
// ilman selainta. Logiikka on siirretty sellaisenaan — kayttaytymisen
// pitaa olla identtinen aiempaan verrattuna.
//
// Kaikki funktiot toimivat KAYTTAJAN PAIKALLISESSA aikavyohykkeessa.
// Paivamaarat liikkuvat merkkijonoina muodossa 'YYYY-MM-DD' ja kellonajat
// muodossa 'HH:MM' (24 h).

/** Date -> 'YYYY-MM-DD' paikallisessa aikavyohykkeessa (ei UTC-siirtymaa). */
export function fmtISO(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** 'YYYY-MM-DD' -> Date paikallisen aikavyohykkeen keskiyona. */
export function parseISO(s) {
  const p = s.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

/** Palauttaa uuden Daten n paivaa eteen- tai taaksepain. Ei mutatoi syotetta. */
export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Viikon alku MAANANTAINA, klo 00:00. */
export function startOfWeek(d) {
  const r = new Date(d);
  const day = r.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  r.setDate(r.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Ovatko kaksi Datea samana kalenteripaivana. */
export function sameDay(a, b) {
  return fmtISO(a) === fmtISO(b);
}

/** Tama paiva klo 00:00. */
export function todayMidnight() {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  return n;
}

/**
 * Jarjestysvertailu ajan mukaan. Ajattomat merkinnat ('Joskus tanaan')
 * menevat aina listan loppuun.
 */
export function sortByTime(a, b) {
  if (!a.time && !b.time) return 0;
  if (!a.time) return 1;
  if (!b.time) return -1;
  return a.time.localeCompare(b.time);
}

/**
 * Paivan kuormitusluokka merkintojen maaran perusteella.
 * null = ei suunniteltua, 'sage' = kevyt, 'gold' = kohtalainen, 'clay' = raskas.
 */
export function loadClass(n) {
  if (n === 0) return null;
  if (n <= 3) return 'sage';
  if (n <= 7) return 'gold';
  return 'clay';
}

/**
 * Vahentaa minuutteja kellonajasta. Kiertaa keskiyon yli molempiin suuntiin,
 * eli 00:30 - 60 min = 23:30. Tama on tarkeaa nukkumaanmenoajan laskennassa.
 */
export function subtractMinutes(timeStr, minutes) {
  const p = timeStr.split(':').map(Number);
  let total = p[0] * 60 + p[1] - minutes;
  total = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60), m = Math.round(total % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** Lisaa minuutteja kellonaikaan. Kiertaa keskiyon yli kuten subtractMinutes. */
export function addMinutes(timeStr, minutes) {
  return subtractMinutes(timeStr, -minutes);
}
