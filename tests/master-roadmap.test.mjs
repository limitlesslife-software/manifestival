// docs/MANIFESTIVAL-MASTER-ROADMAP.md: kanoninen ominaisuusluettelo.
//
// MITÄ TÄMÄ VARTIOI
//
// - Jokaisella rivillä on TASAN YKSI tunnettu tila ja yksi prioriteetti.
// - Sama ominaisuus ei esiinny kahdesti (kaksi riviä = kaksi totuutta).
// - Ulkoisen palvelun takia estetty, osittainen tai päätöstä odottava rivi
//   kertoo syyn: tyhjä "puuttuva osa" on juuri se epämääräisyys, jonka
//   luettelo on olemassa poistamaan.
// - Henkilökäytön P0-rivi ei saa olla aloittamatta tai pelkkä arkkitehtuuri:
//   P0 rakennetaan, tai sen este nimetään (ulkoinen palvelu, laite, päätös).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';

const DOC = read('docs/MANIFESTIVAL-MASTER-ROADMAP.md').replace(/\r\n/g, '\n');

const STATUSES = Object.freeze([
  'COMPLETE_LOCAL', 'IMPLEMENTED_DEVICE_UNVERIFIED', 'PARTIAL', 'ARCHITECTURE_ONLY',
  'BLOCKED_EXTERNAL_PROVIDER', 'BLOCKED_PRODUCT_DECISION', 'FUTURE_COMMERCIAL', 'NOT_STARTED'
]);
const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'CL']);

function tableRows() {
  const start = DOC.indexOf('<!-- STATUS-TABLE-START -->');
  const end = DOC.indexOf('<!-- STATUS-TABLE-END -->');
  assert.ok(start >= 0 && end > start, 'tilataulukon merkinnät puuttuvat');
  const lines = DOC.slice(start, end).split('\n').filter(line => line.startsWith('|'));
  assert.ok(lines.length > 2, 'tilataulukko on tyhjä');
  const [header, separator, ...body] = lines;
  assert.match(header, /^\| Alue \| Ominaisuus \| Prioriteetti \| Tila \| Aalto \| Todiste \/ puuttuva osa \|$/);
  assert.match(separator, /^\|(---\|){6}$/);
  return body.map(line => {
    const cells = line.slice(1, -1).split(' | ').map(cell => cell.trim());
    assert.equal(cells.length, 6, `rivillä pitää olla kuusi saraketta: ${line}`);
    const [area, feature, priority, status, wave, evidence] = cells;
    return { area, feature, priority, status, wave, evidence, line };
  });
}

test('jokaisella rivillä on tasan yksi tunnettu tila ja prioriteetti', () => {
  for (const row of tableRows()) {
    assert.ok(PRIORITIES.includes(row.priority), `tuntematon prioriteetti: ${row.line}`);
    assert.ok(STATUSES.includes(row.status), `tuntematon tila: ${row.line}`);
    assert.ok(row.area && row.feature, `alue tai ominaisuus puuttuu: ${row.line}`);
  }
});

test('sama ominaisuus ei esiinny kahdesti', () => {
  const seen = new Set();
  for (const row of tableRows()) {
    const key = `${row.area}|${row.feature}`.toLowerCase();
    assert.equal(seen.has(key), false, `kaksi riviä samasta: ${row.line}`);
    seen.add(key);
  }
});

test('estetty, osittainen ja päätöstä odottava rivi kertoo syyn', () => {
  const needsReason = ['PARTIAL', 'BLOCKED_EXTERNAL_PROVIDER', 'BLOCKED_PRODUCT_DECISION',
    'ARCHITECTURE_ONLY', 'IMPLEMENTED_DEVICE_UNVERIFIED'];
  for (const row of tableRows().filter(r => needsReason.includes(r.status))) {
    assert.ok(row.evidence && row.evidence !== '—', `syy puuttuu: ${row.line}`);
  }
});

test('henkilökäytön P0 ei ole aloittamatta eikä pelkkää arkkitehtuuria', () => {
  for (const row of tableRows().filter(r => r.priority === 'P0')) {
    assert.ok(!['NOT_STARTED', 'ARCHITECTURE_ONLY', 'FUTURE_COMMERCIAL'].includes(row.status),
      `P0 ilman toteutusta tai nimettyä estettä: ${row.line}`);
  }
});

test('luettelo kattaa paketin pääalueet', () => {
  const areas = new Set(tableRows().map(row => row.area));
  for (const area of ['Kalenteri', 'Puhe', 'Avustaja', 'Paikat', 'Lähtö', 'Aamu', 'Uni', 'Rytmi', 'Herätys',
    'Päivä', 'Hyvinvointi', 'Terveys', 'Talous', 'Tieto', 'Laatu', 'Android', 'Kaupallinen', 'Suunta']) {
    assert.ok(areas.has(area), `alue puuttuu luettelosta: ${area}`);
  }
});
