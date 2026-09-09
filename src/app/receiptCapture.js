// Kuitin ja laskun kuvan ottaminen — ja sen unohtaminen.
//
// =====================================================================
// KUVAN ELINKAARI ON KOKO TÄMÄN MODUULIN AIHE
// =====================================================================
//
//   1. käyttäjä valitsee tai ottaa kuvan
//   2. kuva pienennetään canvasilla
//   3. pienennetty kuva lähetetään /api/extract -päätepisteelle
//   4. KUVA VAPAUTETAAN — heti, onnistui luenta tai ei
//   5. jäljelle jää luenta, joka on ehdotus
//
// Kuvaa EI tallenneta Supabaseen, EI localStorageen, EI IndexedDB:hen
// eikä sitä laiteta sovelluksen tilaan. `<input type="file">` tyhjennetään,
// data-URI unohdetaan ja `URL.createObjectURL`-viitteet vapautetaan.
//
// Kuitin kuva kertoo missä olit, milloin ja mitä ostit. Ainoa turvallinen
// tapa käsitellä sitä on olla säilyttämättä sitä.
//
// =====================================================================
// MIKSI KUVA PIENENNETÄÄN SELAIMESSA
// =====================================================================
//
// Kaksi syytä, joista jälkimmäinen on tärkeämpi:
//
//   1. Puhelimen kamera tuottaa 4-12 MB:n kuvia. Base64 kasvattaa ne
//      kolmanneksella, ja palvelimen raja on 5 MB.
//
//   2. Pienempi kuva on VÄHEMMÄN TIETOA. Kuitin lukemiseen riittää
//      1600 pikselin pitkä sivu; sitä tarkempi kuva ei paranna luentaa
//      mutta lähettää enemmän kuin on tarpeen.
//
// Pienennys tehdään canvasilla, joka myös RIISUU EXIF-METATIEDOT —
// mukaan lukien GPS-koordinaatit, jotka kamera kirjoittaa kuvaan
// automaattisesti. Alkuperäinen kuva ei siis missään vaiheessa lähde
// laitteelta.

import { parseExtractionResponse } from '../domain/receipts.js';
import { currentAccessToken } from './auth.js';
import { apiUrl } from '../platform/index.js';
import { API } from '../data/config.js';
import { logError } from '../lib/result.js';

/** Pitkän sivun enimmäispituus pikseleinä. */
const MAX_DIMENSION = 1600;

/** JPEG-laatu. 0,8 riittää tekstin lukemiseen ja puolittaa koon. */
const JPEG_QUALITY = 0.8;

/** Lähetettävä kuvatyyppi. JPEG pakkaa valokuvan pienimmäksi. */
const MEDIA_TYPE = 'image/jpeg';

/** Suurin hyväksyttävä lähdetiedosto tavuina. 20 MB kattaa jokaisen puhelimen. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * Lue tiedosto kuvaksi ja pienennä se.
 *
 * Palauttaa base64-merkkijonon ILMAN data-URI-etuliitettä — juuri sen,
 * mitä Anthropicin Vision odottaa.
 *
 * KAIKKI VÄLIVAIHEET VAPAUTETAAN. `objectURL` revokoidaan `finally`-
 * lohkossa, koska muuten selain pitää kuvaa muistissa niin kauan kuin
 * sivu on auki — ja juuri sitä pyritään välttämään.
 *
 * @param {File} file
 * @returns {Promise<{base64: string, mediaType: string}>}
 */
export async function prepareImage(file) {
  if (!file) throw new Error('Kuvaa ei valittu.');
  if (!String(file.type || '').startsWith('image/')) {
    throw new Error('Valitse kuvatiedosto.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('Kuva on liian suuri.');
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(objectUrl);
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Kuvan käsittely ei onnistunut.');

    // Valkoinen tausta: JPEG ei tunne läpinäkyvyyttä, ja ilman tätä
    // PNG:n läpinäkyvä alue muuttuisi mustaksi — mikä on kuitin
    // valkoisella paperilla juuri väärin päin.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL(MEDIA_TYPE, JPEG_QUALITY);

    // Canvas tyhjennetään heti. Se ei ole pakollista — canvas katoaa
    // roskienkeruussa — mutta se tekee aikeen näkyväksi ja pienentää
    // ikkunaa, jossa kuva on muistissa.
    canvas.width = 0;
    canvas.height = 0;

    const comma = dataUrl.indexOf(',');
    if (comma === -1) throw new Error('Kuvan käsittely ei onnistunut.');

    return { base64: dataUrl.slice(comma + 1), mediaType: MEDIA_TYPE };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Lataa kuva object-URL:sta. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Kuvaa ei voitu lukea.'));
    image.src = url;
  });
}

/**
 * Mittasuhteet säilyttävä sovitus.
 *
 * Pienempää kuvaa EI suurenneta: suurentaminen ei lisää tietoa mutta
 * kasvattaa lähetettävää määrää.
 */
export function fitWithin(width, height, max = MAX_DIMENSION) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return { width: 1, height: 1 };
  if (w <= max && h <= max) return { width: w, height: h };

  const scale = max / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  };
}

/**
 * Lähetä kuva luettavaksi ja palauta luenta.
 *
 * PALAUTTAA EHDOTUKSEN, EI TALLENNETTUA RIVIÄ. Luennan tila on
 * EXTRACTED, ja ainoa tapa päästä siitä eteenpäin on käyttäjän
 * hyväksyntä. Ks. src/domain/receipts.js.
 *
 * @param {object} input
 * @param {File}   input.file
 * @param {string} input.subject  'receipt' tai 'bill'
 * @param {string} input.todayIso
 * @param {string} input.id
 * @returns {Promise<{ok: boolean, extraction?: object, error?: string}>}
 */
export async function extractFromImage({ file, subject, todayIso, id }) {
  let prepared;
  try {
    prepared = await prepareImage(file);
  } catch (cause) {
    return { ok: false, error: cause.message || 'Kuvaa ei voitu lukea.' };
  }

  try {
    const token = await currentAccessToken();
    if (!token) return { ok: false, error: 'Kirjaudu sisään ennen kuvan lukemista.' };

    const response = await fetch(apiUrl(API.extract), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        image: prepared.base64,
        mediaType: prepared.mediaType,
        subject,
        today: todayIso
      })
    });

    if (!response.ok) {
      let message = 'Kuvan lukeminen epäonnistui.';
      try {
        const body = await response.json();
        if (body && typeof body.error === 'string') message = body.error;
      } catch { /* geneerinen viesti riittää */ }
      return { ok: false, error: message };
    }

    const data = await response.json();
    const text = textFrom(data);
    if (!text) return { ok: false, error: 'Kuvasta ei saatu luettua mitään.' };

    // FAIL CLOSED. parseExtractionResponse hylkää kaiken, mitä se ei
    // ymmärrä, ja kertoo syyn. Puolittain ymmärretty luenta olisi
    // pahin vaihtoehto: se näyttäisi luennalta.
    const parsed = parseExtractionResponse(text, { subject, id });
    if (!parsed.ok) {
      return { ok: false, error: parsed.reason || 'Kuvasta ei saatu luettua mitään.' };
    }

    return { ok: true, extraction: parsed.extraction };
  } catch (cause) {
    logError(cause);
    return { ok: false, error: 'Kuvan lukeminen epäonnistui.' };
  } finally {
    // KUVA VAPAUTETAAN AINA. Onnistui luenta tai ei, base64 ei jää
    // elämään tämän funktion yli.
    prepared.base64 = '';
    prepared = null;
  }
}

/** Vastauksen tekstisisältö, tai tyhjä. */
function textFrom(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .trim();
}

/**
 * Tyhjennä tiedostovalitsin.
 *
 * `<input type="file">` PITÄÄ VALITUN TIEDOSTON MUISTISSA niin kauan
 * kuin arvo on asetettu. Ilman tätä kuitin kuva jäisi elämään DOMiin
 * senkin jälkeen kun luenta on hyväksytty — ja se on täsmälleen se,
 * mitä koko moduuli välttää.
 *
 * Tyhjennys myös mahdollistaa saman tiedoston valitsemisen uudelleen:
 * `change` ei laukea, jos arvo ei muutu.
 */
export function releaseFileInput(input) {
  if (!input) return;
  try {
    input.value = '';
  } catch {
    // Vanhat selaimet eivät salli arvon asettamista. Korvataan elementti
    // omalla kloonillaan, jolloin valittu tiedosto katoaa joka
    // tapauksessa.
    if (input.parentNode) {
      input.parentNode.replaceChild(input.cloneNode(true), input);
    }
  }
}
