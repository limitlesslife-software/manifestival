// Esimerkkipaiva onboardingia ja paikallista kehitysta varten.
//
// TARKEAA (WP1): tata moduulia EI ole kytketty sovellukseen.
// Aiemmin index.html kutsui seedIntoSupabase()-funktiota init()-polussa, jolloin
// tyhja tietokanta taytettiin automaattisesti naila esimerkkiriveilla — myos
// tuotannossa. Se poistettiin, koska uuden kayttajan pitaa saada tyhja
// henkilokohtainen tila, ei toisen ihmisen esimerkkipaivaa.
//
// Logiikka on sailytetty tanne, jotta se voidaan myohemmin kytkea
// vapaaehtoiseksi "tayta esimerkkipaivalla" -toiminnoksi onboardingissa.
// Tama moduuli ei kirjoita mihinkaan — se palauttaa vain taulukon.

import { fmtISO, todayMidnight } from './datetime.js';

/**
 * Palauttaa esimerkkipaivan tehtavat talle paivalle.
 * Puhdas funktio: ei tietokantakutsuja, ei sivuvaikutuksia.
 */
export function seedTasks() {
  const t = fmtISO(todayMidnight());
  let n = 1;
  const mk = (time, endTime, title, category, note, isWake) => ({
    id: 'seed' + (n++),
    date: t,
    time: time || null,
    endTime: endTime || null,
    title,
    category,
    note: note || null,
    completed: false,
    isWake: !!isWake
  });
  return [
    mk('05:30', null, 'Herätys', 'hyvinvointi', null, true),
    mk('05:35', '05:55', 'Hengitys ja aamuliike', 'hyvinvointi'),
    mk('05:55', '06:25', 'Valmistautuminen', 'koti'),
    mk('06:30', null, 'Lähtö töihin', 'tyo', '18 min · karting-varusteet mukaan'),
    mk('07:00', '12:00', 'Työ', 'tyo'),
    mk('12:00', null, 'Ruokailu', 'hyvinvointi'),
    mk('13:00', '14:00', 'Laskutus', 'talous'),
    mk('16:00', '17:00', 'Karting-harjoitus', 'harrastus'),
    mk('18:00', null, 'Perheaika', 'perhe'),
    mk('21:30', '22:00', 'Iltarutiini ja uni', 'hyvinvointi')
  ];
}
