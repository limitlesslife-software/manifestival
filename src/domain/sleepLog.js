// Unikirjaukset: vuoteessa olon aika, yksi rivi heräämispäivää kohti.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// SOVELLUS EI MITTAA UNTA. Se tietää vain, milloin käyttäjä kertoi
// menneensä nukkumaan ja heränneensä (tai milloin herätys kuitattiin):
// se on MAHDOLLISUUS nukkua (`kind: 'opportunity'`). Mitattu uni
// (`'measured'`) on varattu terveyslaitteen tiedolle. Ei diagnooseja, ei
// väestönormeja.
//
// Yö ylittää keskiyön: kellonajat ovat 'HH:MM', ja heräämispäivä kertoo,
// mihin yöhön rivi kuuluu. Unitiedot ovat arkaluonteisia: ne eivät kulje
// tekoälylle eivätkä lokiin (src/lib/logger.js).

import { SLEEP_KIND, SLEEP_KINDS, SLEEP_SOURCE, SLEEP_SOURCES } from './dailyLife.js';
import {
  idOrNull, textOrNull, oneOf, dateOrNull, timeOrNull, minutesOfTime
} from './entityFields.js';

export const MAX_SLEEP_NOTE_LENGTH = 500;

/** Normalisoi unikirjaus. Ei heitä; roska -> null tai oletus. */
export function normalizeSleepLog(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    wakeDate: dateOrNull(source.wakeDate),
    plannedBedtime: timeOrNull(source.plannedBedtime),
    actualBedtime: timeOrNull(source.actualBedtime),
    plannedWake: timeOrNull(source.plannedWake),
    actualWake: timeOrNull(source.actualWake),
    source: oneOf(source.source, SLEEP_SOURCES, SLEEP_SOURCE.USER),
    kind: oneOf(source.kind, SLEEP_KINDS, SLEEP_KIND.OPPORTUNITY),
    note: textOrNull(source.note, MAX_SLEEP_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validateSleepLog(log) {
  const errors = {};
  if (!log || typeof log !== 'object') return { valid: false, errors: { log: 'Kirjausta ei ole.' } };
  if (!dateOrNull(log.wakeDate)) errors.wakeDate = 'Heräämispäivä puuttuu.';
  if (!log.plannedBedtime && !log.actualBedtime && !log.plannedWake && !log.actualWake) {
    errors.log = 'Kirjaa ainakin yksi kellonaika.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Vuoteessa olon aika minuutteina keskiyön yli, tai null kun jompikumpi
 * aika puuttuu. Sama nukkumaanmeno- ja heräämisaika on epäselvä (nolla vai
 * vuorokausi?), joten sekin on null — ei arvausta.
 *
 * @param {object} log
 * @param {'actual'|'planned'} [which]
 */
export function sleepOpportunityMinutes(log, which = 'actual') {
  if (!log || typeof log !== 'object') return null;
  const bed = timeOrNull(which === 'planned' ? log.plannedBedtime : log.actualBedtime);
  const wake = timeOrNull(which === 'planned' ? log.plannedWake : log.actualWake);
  if (!bed || !wake || bed === wake) return null;
  return (minutesOfTime(wake) - minutesOfTime(bed) + 1440) % 1440;
}
