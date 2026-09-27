// Paikallisten selainajojen yhteiset CDP-apurit. EI TUOTANTOA.
//
// Käyttäjät: tools/e2e/run-suunta-e2e.mjs (Suunta E2E) ja
// tools/e2e/run-daily-life-e2e.mjs (arjen E2E). Siirretty Suunnan ajajasta
// sellaisenaan (käytös ennallaan): Chromen haku, MIME-tyypit, vapaan portin
// valinta, debug-portin tarkistus, CDP-yhteys ja sivun apurit (window.H).
// Uutta arjen E2E:tä varten: oikeat näppäilyt (pressKey: Tab, Escape,
// nuolet, Home, End, Enter) ja typeAndEnter.
//
// Turvasäännöt (DNS-esto, pyyntöjen kirjaus, profiilin poisto) ovat
// ajajissa itsessään, jotta ne näkyvät yhdellä silmäyksellä ja testit
// (tests/*-e2e-harness.test.mjs) voivat tarkistaa ne ajajan lähteestä.

import net from 'node:net';

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'
};

/** Käyttöjärjestelmän antama vapaa portti (127.0.0.1). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Vastaako portissa jo jokin CDP-palvelin? (Vieraaseen Chromeen ei liitytä.) */
export async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

export class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  open() { return new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve); this.ws.addEventListener('error', reject); }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(listener) { this.listeners.push(listener); }
  close() { this.ws.close(); }
}

/** Sivun apurit (window.H). Ajetaan jokaisen latauksen jälkeen. */
export const PAGE_HELPERS = `
window.H = {
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async waitFor(fn, label = 'ehto', timeout = 6000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      try { const value = fn(); if (value) return value; } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('aikakatkaisu: ' + label);
  },
  el(sel) { const node = document.querySelector(sel); if (!node) throw new Error('ei löydy: ' + sel); return node; },
  click(sel) { H.el(sel).click(); },
  fill(sel, value) {
    const node = H.el(sel);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  },
  text(sel) { const node = document.querySelector(sel); return node ? node.textContent : ''; },
  html(sel) { const node = document.querySelector(sel); return node ? node.innerHTML : ''; },
  s: () => window.__e2e.state(),
  // Kannan rivit (kirjautuneen käyttäjän), kuten palvelin ne näkee.
  db: table => window.__e2e.db.rows(table),
  tab: screen => H.click('.tab-btn[data-screen="' + screen + '"]'),
  // Tallennus on valmis vasta, kun painike ei ole enää varattu (tuplaklikkaussuoja):
  // tila päivittyy optimistisesti jo ennen kuin tallennus on palannut.
  idle: (sel, label) => H.waitFor(() => !H.el(sel).disabled && !H.el(sel).hasAttribute('aria-busy'), label || ('valmis: ' + sel))
};
true;`;

const KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 }
});

/**
 * Oikea näppäily CDP:n kautta (keyDown + keyUp). Synteettinen
 * KeyboardEvent ei siirrä fokusta (Tab) eikä lähetä lomaketta (Enter).
 *
 * @param {Cdp} cdp
 * @param {keyof KEYS} name
 * @param {{shift?: boolean}} [options]
 */
export async function pressKey(cdp, name, { shift = false } = {}) {
  const spec = KEYS[name];
  if (!spec) throw new Error('tuntematon näppäin: ' + name);
  const { text, ...key } = spec;
  const modifiers = shift ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text } : {}), modifiers, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...key });
}

/** Kirjoita teksti fokusoituun kenttään ja paina Enter oikeina näppäilyinä. */
export async function typeAndEnter(cdp, text) {
  if (text) await cdp.send('Input.insertText', { text });
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
}
