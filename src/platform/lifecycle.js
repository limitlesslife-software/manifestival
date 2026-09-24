// Sovelluksen etu-/taustatilan sovitin.
//
// MIKSI TÄMÄ ON OMA MODUULINSA
// Natiivikuoressa `document.visibilitychange` ei ole luotettava korvike
// oikealle elinkaaritapahtumalle: WebView voi pysyä "näkyvänä" DOM:in
// silmissä vaikka käyttöjärjestelmä on jo vaihtanut sovellusta taustalle,
// ja toisin päin. Capacitorin App-liitännäinen antaa oikean `resume`- ja
// `pause`-tapahtuman käyttöjärjestelmältä. Selaimessa tätä liitännäistä ei
// ole, joten `visibilitychange` on siellä ainoa ja riittävä vastine.
//
// MIKSI PLUGINIA EI IMPORTOIDA NIMELLÄ
// Sama syy kuin `nativeNotifications.js`:ssä: sovellus ladataan selaimeen
// natiiveina ES-moduuleina ilman bundleria, joten paljas moduulitunniste
// kaataisi sovelluksen webissä. Plugin haetaan ajossa globaalista
// `Capacitor.Plugins`-oliosta.
//
// KYTKENTÄ TASAN KERRAN
// `bindLifecycle` on idempotentti: toinen kutsu ei lisää toista
// kuuntelijaa. Tämä on sama invariantti kuin muualla sovelluskerroksessa
// (`docs/ARCHITECTURE.md`: "tapahtumakytkennät tehdään tasan kerran").

/**
 * Hae App-liitännäinen globaalista rekisteristä.
 * @returns {object|null} null jos ei olla natiivikuoressa tai plugin puuttuu
 */
export function plugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function') return null;
  if (!capacitor.isNativePlatform()) return null;
  const plugins = capacitor.Plugins;
  return (plugins && plugins.App) || null;
}

/** Onko natiivi elinkaaritapahtuma käytettävissä tässä kuoressa. */
export function isNativeLifecycleAvailable() {
  return plugin() !== null;
}

let bound = false;

/**
 * Kytke sovelluksen etu-/taustatilan kuuntelu.
 *
 * `onResume` kutsutaan kun sovellus tulee näkyviin ja käyttäjän kannattaa
 * nähdä ajan tasalla oleva tila: natiivissa App-liitännäisen `resume`-
 * tapahtumasta, selaimessa kun `document.hidden` muuttuu epätodeksi.
 * `onPause` on valinnainen ja kutsutaan vastaavasti taustalle
 * siirryttäessä.
 *
 * EI KORVAA `visibilitychange`-kuuntelua natiivissakaan — molemmat
 * kytketään, koska ne kattavat eri tilanteita eivätkä sulje toisiaan pois.
 * `onResume`-kutsujan on oltava idempotentti, koska se voi laueta useasta
 * lähteestä lähekkäin (esim. resume ja sen jälkeen visibilitychange).
 *
 * @returns {boolean} true jos kytkentä tehtiin nyt, false jos se oli jo tehty
 */
export function bindLifecycle({ onResume, onPause } = {}) {
  if (bound) return false;
  bound = true;

  const api = plugin();
  if (api && typeof api.addListener === 'function') {
    api.addListener('resume', () => { if (onResume) onResume(); });
    api.addListener('pause', () => { if (onPause) onPause(); });
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (onPause) onPause();
        return;
      }
      if (onResume) onResume();
    });
  }

  return true;
}

/** Vain testejä varten: palauta kytkentätila alkutilaan. */
export function resetLifecycleBinding() {
  bound = false;
}
