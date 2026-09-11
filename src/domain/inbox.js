// Elämän saapuvat: kirjaa nyt, järjestä myöhemmin.
//
// =====================================================================
// MIKSI TÄMÄ ON OLEMASSA
// =====================================================================
//
// Ihminen ei muista asiaa siinä muodossa, johon sovellus haluaa sen.
// Hän muistaa "vie auto katsastukseen" seistessään bussipysäkillä, ja
// jos sovellus kysyy siinä hetkessä onko kyseessä tehtävä vai projekti
// vai rutiini, asia jää kirjaamatta.
//
// Saapuvat on se paikka, johon asia menee ENNEN kuin kukaan päättää
// mikä se on. Luokittelu on erillinen, myöhempi ja peruutettavissa
// oleva teko.
//
// =====================================================================
// TEKSTI ON KÄYTTÄJÄN OMAA SISÄLTÖÄ, EI LOKIA
// =====================================================================
//
// `text` säilytetään tarkoituksella: se ON muistiinpano. Käyttäjä
// kirjoitti sen itselleen, ja sen hävittäminen luokittelun jälkeen
// hukkaisi vivahteen, jota jäsennelty rivi ei kanna.
//
// Tämä on eri asia kuin puheen litteroinnin tai tekoälyn kehotteen
// säilyttäminen. Niitä EI säilytetä: ne ovat välivaiheita, eivät
// sisältöä. Ks. `docs/PERSONAL-ASSISTANT-CORE.md`.
//
// =====================================================================
// EHDOTUS EI OLE HYVÄKSYNTÄ
// =====================================================================
//
// Saapuva rivi voi kantaa tekoälyn ehdotusta siitä, mikä se on. Ehdotus
// ei muuta mitään: `convert` vaatii käyttäjän teon, ja se on ainoa tie
// saapuvasta domainiin.

import { isIsoDate } from './task.js';

/** Saapuvan rivin käsittelytila. */
export const INBOX_STATUS = Object.freeze({
  /** Kirjattu, ei tulkittu. */
  UNPROCESSED: 'unprocessed',
  /** Tekoäly on ehdottanut tulkintaa. EI HYVÄKSYTTY. */
  PROPOSED: 'proposed',
  /**
   * Tulkinta on epävarma tai ristiriitainen.
   *
   * Eri asia kuin PROPOSED: tässä järjestelmä sanoo, ettei se tiedä.
   * Käyttäjä ei saa luulla epävarmaa ehdotusta varmaksi.
   */
  NEEDS_REVIEW: 'needs_review',
  /** Käyttäjä on hyväksynyt tulkinnan, muunnos ei ole vielä tehty. */
  ACCEPTED: 'accepted',
  /** Muunnettu domainiksi. Päätetila. */
  CONVERTED: 'converted',
  /** Hylätty. Päätetila. Rivi säilyy, jottei sama asia palaa uudelleen. */
  DISMISSED: 'dismissed'
});

export const INBOX_STATUSES = Object.freeze(Object.values(INBOX_STATUS));

/** Tilat, jotka odottavat käyttäjää. */
export const OPEN_INBOX_STATUSES = Object.freeze([
  INBOX_STATUS.UNPROCESSED, INBOX_STATUS.PROPOSED,
  INBOX_STATUS.NEEDS_REVIEW, INBOX_STATUS.ACCEPTED
]);

const STATUS_LABELS = Object.freeze({
  [INBOX_STATUS.UNPROCESSED]: 'Kirjattu',
  [INBOX_STATUS.PROPOSED]: 'Ehdotus valmis',
  [INBOX_STATUS.NEEDS_REVIEW]: 'Tarvitsee tarkennusta',
  [INBOX_STATUS.ACCEPTED]: 'Hyväksytty',
  [INBOX_STATUS.CONVERTED]: 'Käsitelty',
  [INBOX_STATUS.DISMISSED]: 'Hylätty'
});

export function inboxStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[INBOX_STATUS.UNPROCESSED];
}

/** Mistä rivi tuli. */
export const CAPTURE_SOURCE = Object.freeze({
  TEXT: 'text',
  VOICE: 'voice',
  /** Sovelluksen sisäinen ehdotus, esim. toistuvasti ohitettu rutiini. */
  SYSTEM: 'system'
});

export const CAPTURE_SOURCES = Object.freeze(Object.values(CAPTURE_SOURCE));

/** Rivin enimmäispituus. Pidempi ei ole muistiinpano vaan dokumentti. */
export const MAX_TEXT_LENGTH = 1000;

/** Montako riviä yksi käyttäjä saa pitää avoimena. */
export const MAX_OPEN_ITEMS = 200;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalisoi saapuva rivi.
 *
 * `proposal` on tekoälyn tuottamaa tietoa, ja se normalisoidaan
 * `capture.js`:ssä ennen kuin se päätyy tänne. Tämä moduuli ei tulkitse
 * sitä — se vain kantaa sen.
 */
export function normalizeInboxItem(input = {}) {
  const status = INBOX_STATUSES.includes(input.status)
    ? input.status
    : INBOX_STATUS.UNPROCESSED;

  const source = CAPTURE_SOURCES.includes(input.source)
    ? input.source
    : CAPTURE_SOURCE.TEXT;

  return {
    id: input.id != null ? String(input.id) : null,

    /**
     * Käyttäjän oma teksti. TÄMÄ ON SISÄLTÖÄ, EI LOKIA.
     *
     * Puheesta tullut rivi kantaa litteroinnin, koska litterointi on
     * silloin se mitä käyttäjä sanoi — ei välivaihe. Ääntä itseään ei
     * säilytetä missään.
     */
    text: String(input.text ?? '').trim().slice(0, MAX_TEXT_LENGTH),

    status,
    source,

    /**
     * Tekoälyn ehdotus siitä, mikä tämä on.
     *
     * EI MUUTA MITÄÄN. Ehdotuksen olemassaolo ei tarkoita, että jotain
     * olisi luotu. Ks. `convert`.
     */
    proposal: input.proposal ?? null,

    /**
     * Mihin tämä muunnettiin. Vain CONVERTED-tilassa merkityksellinen.
     *
     * EI VIERASAVAIN. Muunnettu tehtävä voidaan poistaa, eikä saapuvan
     * rivin pidä kadota sen mukana: rivi on tietue siitä, että asia
     * kirjattiin ja käsiteltiin. Sama perustelu kuin
     * `transactions.source_id` -sarakkeessa (migraatio 0009).
     */
    convertedKind: cleanText(input.convertedKind, 40),
    convertedId: input.convertedId != null ? String(input.convertedId) : null,

    /** Milloin käyttäjä kirjasi. Päivä riittää järjestykseen. */
    capturedAt: input.capturedAt ?? null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateInboxItem(item) {
  const errors = {};

  if (!item || !item.text) {
    errors.text = 'Kirjoita jotain.';
  } else if (item.text.length > MAX_TEXT_LENGTH) {
    errors.text = 'Teksti on liian pitkä.';
  }

  if (!INBOX_STATUSES.includes(item.status)) errors.status = 'Tuntematon tila.';
  if (!CAPTURE_SOURCES.includes(item.source)) errors.source = 'Tuntematon lähde.';

  // MUUNNETTU ILMAN KOHDETTA ON TIETO JOKA EI KERRO MIHIN.
  //
  // Sama sääntö kuin maksetulla laskulla ja saavutetulla
  // välitavoitteella: tila ja sen kohde kulkevat yhdessä tai eivät
  // lainkaan.
  if (item.status === INBOX_STATUS.CONVERTED && !item.convertedKind) {
    errors.convertedKind = 'Merkitse mihin rivi muunnettiin.';
  }
  if (item.status !== INBOX_STATUS.CONVERTED && item.convertedKind) {
    errors.convertedKind = 'Vain muunnetulla rivillä on kohde.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// TILASIIRTYMÄT
// =====================================================================

/**
 * Sallitut siirtymät.
 *
 * Kartta on nimenomainen eikä johdettu. Jokainen nuoli on päätös, ja
 * päätös näkyy tässä yhtenä rivinä — ei ehtolauseiden verkostona, jonka
 * läpi voi vahingossa kulkea väärään suuntaan.
 *
 * HYLÄTYSTÄ VOI PALATA. Se on tarkoituksellinen ero muihin elinkaariin
 * tässä sovelluksessa: käyttäjä voi hylätä rivin vahingossa, ja
 * saapuvien hylkäys ei tuhoa mitään. Muunnettu on sen sijaan päätetila,
 * koska paluu tarkoittaisi kahta riviä samasta asiasta.
 */
const TRANSITIONS = Object.freeze({
  [INBOX_STATUS.UNPROCESSED]: [
    INBOX_STATUS.PROPOSED, INBOX_STATUS.NEEDS_REVIEW,
    INBOX_STATUS.ACCEPTED, INBOX_STATUS.DISMISSED
  ],
  [INBOX_STATUS.PROPOSED]: [
    INBOX_STATUS.NEEDS_REVIEW, INBOX_STATUS.ACCEPTED, INBOX_STATUS.DISMISSED
  ],
  [INBOX_STATUS.NEEDS_REVIEW]: [
    INBOX_STATUS.PROPOSED, INBOX_STATUS.ACCEPTED, INBOX_STATUS.DISMISSED
  ],
  [INBOX_STATUS.ACCEPTED]: [
    INBOX_STATUS.CONVERTED, INBOX_STATUS.NEEDS_REVIEW, INBOX_STATUS.DISMISSED
  ],
  [INBOX_STATUS.DISMISSED]: [INBOX_STATUS.UNPROCESSED],
  [INBOX_STATUS.CONVERTED]: []
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Vaihda tila.
 *
 * Palauttaa `null` kiellettyyn siirtymään. Ei heitä: kutsupaikka
 * päättää, onko kielto virhe vai odotettu.
 */
export function transition(item, to, extra = {}) {
  if (!item || !canTransition(item.status, to)) return null;
  return normalizeInboxItem({ ...item, ...extra, status: to });
}

/**
 * Liitä tekoälyn ehdotus riviin.
 *
 * EHDOTUS EI MUUTA MITÄÄN DOMAINISSA. Se vain kertoo, mitä järjestelmä
 * luuli. Tila kertoo, kuinka varma se oli.
 */
export function attachProposal(item, proposal, { needsReview = false } = {}) {
  if (!item) return null;
  const target = needsReview ? INBOX_STATUS.NEEDS_REVIEW : INBOX_STATUS.PROPOSED;
  if (!canTransition(item.status, target)) return null;
  return normalizeInboxItem({ ...item, proposal, status: target });
}

/** Käyttäjä hyväksyy tulkinnan. Muunnos ei ole vielä tehty. */
export function acceptItem(item) {
  return transition(item, INBOX_STATUS.ACCEPTED);
}

/**
 * Merkitse muunnetuksi.
 *
 * KUTSUTAAN VASTA KUN DOMAIN-RIVI ON SYNTYNYT. Tämä on se raja, jossa
 * "hyväksytty" muuttuu "käsitellyksi" — eikä se saa liikkua sekuntiakaan
 * ennen kuin tallennus on vahvistunut.
 */
export function markConverted(item, kind, id) {
  if (!item || !kind) return null;
  return transition(item, INBOX_STATUS.CONVERTED, {
    convertedKind: kind,
    convertedId: id ?? null,
    // EHDOTUS KATOAA, KUN RIVI ON KÄSITELTY.
    //
    // Ehdotus säilytetään vain siihen asti että käyttäjä käsittelee
    // rivin. Sen jälkeen se on mallin tuotosta ilman käyttöä: se ei
    // kerro mitä syntyi (`convertedId` kertoo), eikä sitä voi enää
    // hyväksyä. Säilytettynä se päätyisi vientiin ja varmuuskopioon.
    //
    // `verify_0011.sql` tarkistus 47 havaitsee, jos tämä lakkaa
    // pitämästä paikkansa.
    proposal: null
  });
}

/**
 * Hylkää. Rivi säilyy, jottei sama asia palaa uudelleen.
 *
 * EHDOTUS KATOAA. Sama perustelu kuin muunnoksessa — ja jos käyttäjä
 * palauttaa rivin, tulkinta pyydetään uudelleen tuoreena sen sijaan
 * että hänelle näytettäisiin se sama ehdotus jonka hän jo hylkäsi.
 */
export function dismissItem(item) {
  return transition(item, INBOX_STATUS.DISMISSED, { proposal: null });
}

/** Palauta hylätty käsittelyyn. */
export function restoreItem(item) {
  return transition(item, INBOX_STATUS.UNPROCESSED, {
    proposal: null, convertedKind: null, convertedId: null
  });
}

// =====================================================================
// LISTA
// =====================================================================

/** Odottaako rivi käyttäjää? */
export function isOpenItem(item) {
  return Boolean(item) && OPEN_INBOX_STATUSES.includes(item.status);
}

/**
 * Järjestys: avoimet ensin, uusin ensin.
 *
 * Uusin ensin on tarkoituksellinen: saapuvat luetaan ylhäältä, ja
 * juuri kirjattu asia on se, joka on mielessä.
 */
export function compareInboxItems(a, b) {
  const aOpen = isOpenItem(a) ? 0 : 1;
  const bOpen = isOpenItem(b) ? 0 : 1;
  if (aOpen !== bOpen) return aOpen - bOpen;

  const aTime = String(a.capturedAt || a.createdAt || '');
  const bTime = String(b.capturedAt || b.createdAt || '');
  if (aTime !== bTime) return bTime.localeCompare(aTime);

  return String(a.id || '').localeCompare(String(b.id || ''));
}

/** Avoimet rivit järjestyksessä. */
export function openItems(items = []) {
  return items.filter(isOpenItem).sort(compareInboxItems);
}

/**
 * Yhteenveto saapuvista.
 *
 * `needsReview` erotetaan omaksi luvukseen, koska se on eri asia kuin
 * "odottaa": se tarkoittaa, että järjestelmä ei osannut tulkita ja
 * käyttäjän on kerrottava lisää.
 */
export function summarizeInbox(items = []) {
  const open = items.filter(isOpenItem);

  return {
    total: items.length,
    open: open.length,
    unprocessed: items.filter(i => i.status === INBOX_STATUS.UNPROCESSED).length,
    proposed: items.filter(i => i.status === INBOX_STATUS.PROPOSED).length,
    needsReview: items.filter(i => i.status === INBOX_STATUS.NEEDS_REVIEW).length,
    accepted: items.filter(i => i.status === INBOX_STATUS.ACCEPTED).length,
    converted: items.filter(i => i.status === INBOX_STATUS.CONVERTED).length,
    dismissed: items.filter(i => i.status === INBOX_STATUS.DISMISSED).length,
    /** Onko saapuvissa niin paljon, että se kannattaa sanoa? */
    crowded: open.length >= 20
  };
}

/**
 * Onko saapuvia liikaa?
 *
 * Raja ei estä kirjaamista — se olisi väärä paikka sanoa ei. Se kertoo
 * käyttöliittymälle, että saapuvat kaipaavat käsittelyä, ja estää
 * rajattoman kasvun kannassa.
 */
export function atCapacity(items = []) {
  return items.filter(isOpenItem).length >= MAX_OPEN_ITEMS;
}

/** Tietyn päivän rivit. */
export function itemsForDate(items = [], dateIso) {
  if (!isIsoDate(dateIso)) return [];
  return items.filter(item =>
    item && String(item.capturedAt || '').slice(0, 10) === dateIso);
}
