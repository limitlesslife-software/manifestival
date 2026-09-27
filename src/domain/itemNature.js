// Asian luonne: mikä tämä asia elämässä ON — johdettuna, ei kysyttynä.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// Omistajan päätös 1 (2026-09-27): elämänalueen laji (`life_areas.kind`)
// ja asian luonne ovat ERI akseleita. Alue kertoo, mihin elämän osaan asia
// kuuluu; luonne kertoo, millainen asia se on:
//
//   OBLIGATION   velvoite: lasku, määräaika ulospäin, luvattu asia
//   GOAL_ACTION  vie tavoitetta tai projektia eteenpäin
//   MAINTENANCE  ylläpito: koti, asiointi, toistuva arki
//   WELLBEING    hyvinvointi: liikunta, lepo, terveys
//   ENJOYMENT    ilo: harrastus, oma aika
//   FREE_TIME    vapaa-aika, loma
//
// JOHDETAAN ENNEN KUIN TALLENNETAAN. Luonnetta ei ole kannassa: käyttäjä on
// jo kertonut sen (tavoite, alue, kategoria, määräaika). Uusi kenttä olisi
// yksi päätös lisää kirjaushetkellä — juuri sitä mielen kuorman keventäminen
// välttää. Ohitus lisätään vasta, kun johdos osoittautuu riittämättömäksi.
//
// Järjestys on dokumentoitu, jotta siitä voi olla eri mieltä:
//   1. lasku                                  -> OBLIGATION
//   2. alueen laji WELLBEING/ENJOYMENT/OWN_TIME/FREE_TIME/VACATION
//                                             -> vastaava luonne
//   3. tavoite tai projekti                   -> GOAL_ACTION
//   4. määräaika                              -> OBLIGATION
//   5. rutiini                                -> MAINTENANCE (hyvinvoinnin kategoria: WELLBEING)
//   6. kategoria: hyvinvointi -> WELLBEING, harrastus -> ENJOYMENT,
//      talous -> OBLIGATION, koti -> MAINTENANCE, tyo -> OBLIGATION
//   7. muuten                                 -> MAINTENANCE

export const NATURE = Object.freeze({
  OBLIGATION: 'OBLIGATION',
  GOAL_ACTION: 'GOAL_ACTION',
  MAINTENANCE: 'MAINTENANCE',
  WELLBEING: 'WELLBEING',
  ENJOYMENT: 'ENJOYMENT',
  FREE_TIME: 'FREE_TIME'
});
export const NATURES = Object.freeze(Object.values(NATURE));

const NATURE_LABELS = Object.freeze({
  [NATURE.OBLIGATION]: 'Velvoite',
  [NATURE.GOAL_ACTION]: 'Tavoitteen askel',
  [NATURE.MAINTENANCE]: 'Arjen ylläpito',
  [NATURE.WELLBEING]: 'Hyvinvointi',
  [NATURE.ENJOYMENT]: 'Ilo ja oma aika',
  [NATURE.FREE_TIME]: 'Vapaa-aika'
});

export function natureLabel(nature) {
  return NATURE_LABELS[nature] || NATURE_LABELS[NATURE.MAINTENANCE];
}

/** Elämänalueen laji (migraatio 0015, life_areas.kind). */
export const AREA_KIND = Object.freeze({
  STANDARD: 'STANDARD',
  WELLBEING: 'WELLBEING',
  ENJOYMENT: 'ENJOYMENT',
  OWN_TIME: 'OWN_TIME',
  FREE_TIME: 'FREE_TIME',
  VACATION: 'VACATION'
});
export const AREA_KINDS = Object.freeze(Object.values(AREA_KIND));

const AREA_KIND_LABELS = Object.freeze({
  [AREA_KIND.STANDARD]: 'Tavallinen',
  [AREA_KIND.WELLBEING]: 'Hyvinvointi',
  [AREA_KIND.ENJOYMENT]: 'Ilo',
  [AREA_KIND.OWN_TIME]: 'Oma aika',
  [AREA_KIND.FREE_TIME]: 'Vapaa-aika',
  [AREA_KIND.VACATION]: 'Loma'
});

export function areaKindLabel(kind) {
  return AREA_KIND_LABELS[kind] || AREA_KIND_LABELS[AREA_KIND.STANDARD];
}

export function isAreaKind(value) {
  return AREA_KINDS.includes(value);
}

const AREA_KIND_NATURE = Object.freeze({
  [AREA_KIND.WELLBEING]: NATURE.WELLBEING,
  [AREA_KIND.ENJOYMENT]: NATURE.ENJOYMENT,
  [AREA_KIND.OWN_TIME]: NATURE.ENJOYMENT,
  [AREA_KIND.FREE_TIME]: NATURE.FREE_TIME,
  [AREA_KIND.VACATION]: NATURE.FREE_TIME
});

const CATEGORY_NATURE = Object.freeze({
  hyvinvointi: NATURE.WELLBEING,
  harrastus: NATURE.ENJOYMENT,
  talous: NATURE.OBLIGATION,
  koti: NATURE.MAINTENANCE,
  tyo: NATURE.OBLIGATION
});

/**
 * Asian luonne ja sen syy.
 *
 * @param {object} item  tehtävä, rutiini tai lasku
 * @param {object} [context]
 * @param {'task'|'routine'|'bill'} [context.kind='task']
 * @param {object|null} [context.area]  asian elämänalue (jos tiedossa)
 * @returns {{nature:string, reason:string}}
 */
export function deriveNature(item, { kind = 'task', area = null } = {}) {
  if (kind === 'bill') return { nature: NATURE.OBLIGATION, reason: 'Lasku' };
  if (!item || typeof item !== 'object') return { nature: NATURE.MAINTENANCE, reason: 'Arjen asia' };

  const areaNature = area && AREA_KIND_NATURE[area.kind];
  if (areaNature) return { nature: areaNature, reason: `Alue: ${area.name || areaKindLabel(area.kind)}` };

  if (kind === 'task' && (item.goalId || item.projectId)) {
    return { nature: NATURE.GOAL_ACTION, reason: 'Vie tavoitetta eteenpäin' };
  }
  if (kind === 'task' && item.deadline) return { nature: NATURE.OBLIGATION, reason: 'Määräaika' };
  if (kind === 'routine') {
    return item.category === 'hyvinvointi'
      ? { nature: NATURE.WELLBEING, reason: 'Hyvinvoinnin rutiini' }
      : { nature: NATURE.MAINTENANCE, reason: 'Toistuva arki' };
  }
  const byCategory = CATEGORY_NATURE[item.category];
  if (byCategory) return { nature: byCategory, reason: 'Kategoria' };
  return { nature: NATURE.MAINTENANCE, reason: 'Arjen asia' };
}

/** Kilpaileeko luonne päivän fokuksesta ilman erillistä valintaa? */
export function competesForFocus(nature) {
  return nature === NATURE.OBLIGATION || nature === NATURE.GOAL_ACTION || nature === NATURE.MAINTENANCE;
}

/** Onko luonne välttämätön (velvoite) — lomalla ja vapaa-ajalla ainoa, joka saa huomautuksen. */
export function isEssentialNature(nature) {
  return nature === NATURE.OBLIGATION;
}
