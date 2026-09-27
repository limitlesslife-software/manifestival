// Profiilinäkymän osiot: Arki | Hyvinvointi | Paikat | Asetukset.
//
// Profiilista tuli arjen asetusten koti (uni, herätys, aamu, ateriat,
// paikat), joten yhdelle vieritettävälle sivulle se ei enää mahdu
// luettavasti. Osiot ovat saman näytön välilehtiä (tab-lista), eivät uusia
// näyttöjä: alapalkin seitsemän välilehteä pysyy ennallaan.
//
// TILA RATKAISEE, EI DOM. Valittu osio on tilassa (profileSegment), ja
// renderProfileSegments() vain heijastaa sen: näkyvä säiliö, aria-selected
// ja kiertävä tabindex. Napautus tai nuolinäppäin muuttaa tilaa; piirto
// tulee tilamuutoksesta kuten muillakin näkymillä.

import { maybe } from '../../ui/dom.js';
import { getState, setProfileSegment, PROFILE_SEGMENTS } from '../state.js';

const capitalized = key => key.charAt(0).toUpperCase() + key.slice(1);

/** Osion välilehti ja säiliö: 'daily' -> #segmentProfileDaily, #profileDailySection. */
export function profileSegmentElements(key) {
  return {
    tab: maybe(`segmentProfile${capitalized(key)}`),
    section: maybe(`profile${capitalized(key)}Section`)
  };
}

/** Näytä valittu osio ja merkitse sen välilehti valituksi. */
export function renderProfileSegments() {
  const active = getState().profileSegment || 'daily';
  for (const { key } of PROFILE_SEGMENTS) {
    const { tab, section } = profileSegmentElements(key);
    const selected = key === active;
    if (section) section.style.display = selected ? 'block' : 'none';
    if (tab) {
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      // Kiertävä tabindex: sarkain pysähtyy vain valittuun välilehteen,
      // nuolinäppäimet liikkuvat välilehtien välillä (kuten alapalkissa).
      tab.setAttribute('tabindex', selected ? '0' : '-1');
    }
  }
}

/** Nuolinäppäimen kohde: seuraava, edellinen, ensimmäinen tai viimeinen. */
function targetIndex(key, index, count) {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

/** Kytke välilehdet. Kutsutaan kerran käynnistyksessä. */
export function initProfileSegments() {
  PROFILE_SEGMENTS.forEach(({ key }, index) => {
    const { tab } = profileSegmentElements(key);
    if (!tab) return;
    tab.addEventListener('click', () => setProfileSegment(key));
    tab.addEventListener('keydown', event => {
      const next = targetIndex(event.key, index, PROFILE_SEGMENTS.length);
      if (next < 0) return;
      event.preventDefault();
      const target = PROFILE_SEGMENTS[next];
      setProfileSegment(target.key);
      const node = profileSegmentElements(target.key).tab;
      if (node) node.focus();
    });
  });
}
