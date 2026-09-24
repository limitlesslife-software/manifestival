// Tehtävän, rutiinin tai projektin Suunta-asetukset.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// Kolme käyttäjän omaa valintaa, kaikki valinnaisia:
//
//   energyDemand         kuinka kuormittavaa tämä on (1–5). null =
//                        TUNTEMATON. Sovellus ei päättele sitä otsikosta,
//                        kategoriasta eikä kestosta.
//   alignmentOptOut      "jätän tämän tarkoituksella ilman elämänaluetta":
//                        Suunta ei muistuta siitä uudelleen
//   estimateApproximate  kestoarvio on karkea (käyttäjä tietää sen)
//
// MIKSI OMA TAULU: tasks-tauluun ei lisätä sarakkeita rinnakkaista
// luokittelua varten (ks. migraatio 0013). Puuttuva rivi = ei asetuksia.

export const ITEM_KIND = Object.freeze({ TASK: 'task', ROUTINE: 'routine', PROJECT: 'project' });
export const ITEM_KINDS = Object.freeze(Object.values(ITEM_KIND));
export const MAX_ITEM_ID_LENGTH = 100;

/** Kuormittavuuden asteikko. Nimet kertovat merkityksen; luku on järjestys. */
export const ENERGY_DEMAND_LEVELS = Object.freeze([
  Object.freeze({ value: 1, label: 'Kevyt' }),
  Object.freeze({ value: 2, label: 'Melko kevyt' }),
  Object.freeze({ value: 3, label: 'Keskitaso' }),
  Object.freeze({ value: 4, label: 'Kuormittava' }),
  Object.freeze({ value: 5, label: 'Erittäin kuormittava' })
]);

export function energyDemandLabel(value) {
  const level = ENERGY_DEMAND_LEVELS.find(entry => entry.value === value);
  return level ? level.label : 'Ei arvioitu';
}

export function isEnergyDemand(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function demandOf(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return isEnergyDemand(number) ? number : null;
}

export function settingsKey(kind, itemId) {
  return `${kind}:${itemId}`;
}

export function normalizeItemSettings(input = {}) {
  return {
    id: input.id != null ? String(input.id) : null,
    itemKind: ITEM_KINDS.includes(input.itemKind) ? input.itemKind : null,
    itemId: input.itemId == null || input.itemId === '' ? null : String(input.itemId).slice(0, MAX_ITEM_ID_LENGTH),
    energyDemand: demandOf(input.energyDemand),
    alignmentOptOut: Boolean(input.alignmentOptOut),
    estimateApproximate: Boolean(input.estimateApproximate),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateItemSettings(settings) {
  const errors = {};
  if (!settings || !settings.itemKind) errors.itemKind = 'Kohteen tyyppi puuttuu.';
  if (!settings || !settings.itemId) errors.itemId = 'Kohde puuttuu.';
  if (settings && settings.energyDemand !== null && !isEnergyDemand(settings.energyDemand)) {
    errors.energyDemand = 'Kuormittavuus on 1–5.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Onko rivillä yhtään asetusta? Tyhjä rivi poistetaan eikä tallenneta. */
export function isEmptySettings(settings) {
  return !settings || (settings.energyDemand === null && !settings.alignmentOptOut
    && !settings.estimateApproximate);
}

/**
 * Hakemisto: `kind:id` -> asetukset. Yksi rivi kohdetta kohti; jos
 * aineistossa on kaksoiskappale, ensimmäinen voittaa (kanta estää
 * kaksoiskappaleen uniikkirajoitteella).
 */
export function indexItemSettings(settings = []) {
  const index = new Map();
  for (const entry of settings || []) {
    if (!entry || !entry.itemKind || !entry.itemId) continue;
    const key = settingsKey(entry.itemKind, entry.itemId);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

/**
 * Kohteen kuormittavuus. Tehtävä perii projektinsa kuormittavuuden, jos
 * sillä ei ole omaa: se on käyttäjän oma nimenomainen valinta, ei arvaus.
 * Muuten null (tuntematon).
 */
export function energyDemandFor(item, index, { projectIdOf = () => null } = {}) {
  if (!item || !index) return null;
  if (item.kind === 'task') {
    const own = index.get(settingsKey(ITEM_KIND.TASK, item.id));
    if (own && own.energyDemand !== null) return own.energyDemand;
    const projectId = projectIdOf(item.id);
    const project = projectId ? index.get(settingsKey(ITEM_KIND.PROJECT, projectId)) : null;
    return project && project.energyDemand !== null ? project.energyDemand : null;
  }
  if (item.kind === 'routine') {
    const own = index.get(settingsKey(ITEM_KIND.ROUTINE, item.routineId));
    return own && own.energyDemand !== null ? own.energyDemand : null;
  }
  return null;
}

/** Onko kohde jätetty tarkoituksella ilman aluetta? */
export function isOptedOut(item, index) {
  if (!item || !index) return false;
  const key = item.kind === 'routine'
    ? settingsKey(ITEM_KIND.ROUTINE, item.routineId)
    : settingsKey(ITEM_KIND.TASK, item.id);
  const entry = index.get(key);
  return Boolean(entry && entry.alignmentOptOut);
}
