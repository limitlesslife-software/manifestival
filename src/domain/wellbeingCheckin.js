// Motivaatio ja hallinnan tunne: yksi kirjaus päivää kohti.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// Kirjaus näytetään saman päivän energian, mielialan ja kuormituksen
// (src/domain/wellbeing.js) rinnalla, mutta se on oma rivinsä omassa
// taulussaan (migraatio 0014): 0006:n taulua ei muuteta.
//
// Sama asteikko ja sama sääntö kuin hyvinvoinnissa: TYHJÄ EI OLE NOLLA.
// Vastaamatta jättäminen on null, ei asteikon pohja. Asteikon ulkopuolinen
// luku kiristetään asteikolle (se on arvo, vain liian suuri tai pieni).
//
// ARKALUONTEINEN: ei tekoälylle, ei lokiin (src/lib/logger.js).

import { SCALE_MIN, SCALE_MAX } from './wellbeing.js';
import { idOrNull, scaleOrNull, dateOrNull } from './entityFields.js';

/** Normalisoi kirjaus. Ei heitä. */
export function normalizeWellbeingCheckin(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    date: dateOrNull(source.date),
    motivation: scaleOrNull(source.motivation, SCALE_MIN, SCALE_MAX),
    /** "Hallinnan tunne": kuinka hyvin arki tuntuu olevan omissa käsissä. */
    control: scaleOrNull(source.control, SCALE_MIN, SCALE_MAX),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validateWellbeingCheckin(checkin) {
  const errors = {};
  if (!checkin || typeof checkin !== 'object') return { valid: false, errors: { checkin: 'Kirjausta ei ole.' } };
  if (!dateOrNull(checkin.date)) errors.date = 'Päivämäärä puuttuu.';
  if (checkin.motivation == null && checkin.control == null) errors.checkin = 'Merkitse edes yksi asia.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Päivän kirjaus, jos sellainen on. */
export function checkinForDate(checkins, dateIso) {
  if (!Array.isArray(checkins)) return null;
  return checkins.find(entry => entry && entry.date === dateIso) || null;
}
