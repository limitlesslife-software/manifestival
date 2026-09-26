// docs/ACCOUNT-DELETION.md ei saa ajautua koodista.
//
// Dokumentti väitti aiemmin "12 tietotyyppiä" ja "20 taulua", kun koodissa
// oli 26 kumpaakin, eikä maininnut laitteen tilaa lainkaan. Nämä testit
// sitovat dokumentin luvut ja luettelot samoihin lähteisiin kuin koodi.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { EXPORTED_COLLECTIONS } from '../src/domain/dataExport.js';
import { ACCOUNT_DATA_MAP } from '../src/domain/accountLifecycle.js';
import { DEVICE_STORAGE } from '../src/data/deviceData.js';
import { DEVICE_CANCEL_TIMEOUT_MS } from '../src/app/notifications.js';

const doc = read('docs/ACCOUNT-DELETION.md').replace(/\r\n/g, '\n');

function section(heading) {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.ok(start > -1, `osio "${heading}" puuttuu`);
  const end = doc.indexOf('\n## ', start + heading.length + 4);
  return doc.slice(start, end === -1 ? doc.length : end);
}

test('dokumentin tietotyyppi- ja taulumäärät ovat koodin määrät', () => {
  const types = [...doc.matchAll(/(\d+) tietotyyppiä/g)].map(match => Number(match[1]));
  assert.ok(types.length >= 1, 'tietotyyppien määrä puuttuu');
  assert.deepEqual([...new Set(types)], [EXPORTED_COLLECTIONS.length]);

  const tables = [...doc.matchAll(/kaikki \*\*(\d+) taulua\*\*|kartan (\d+) taulua/g)].map(match => Number(match[1] || match[2]));
  assert.ok(tables.length >= 2, 'taulumäärä puuttuu');
  assert.deepEqual([...new Set(tables)], [Object.keys(ACCOUNT_DATA_MAP).length]);
});

test('dokumentin taulu luettelee täsmälleen poistokartan kokoelmat, taulut ja omistajasarakkeet', () => {
  const rows = [...section('Mitä tiliin kuuluu').matchAll(/^\| `(\w+)` \| `(\w+)` \| `(\w+)` \|/gm)]
    .map(match => [match[1], { table: match[2], ownerColumn: match[3] }]);
  assert.deepEqual(Object.fromEntries(rows), JSON.parse(JSON.stringify(ACCOUNT_DATA_MAP)));
  assert.equal(rows.length, EXPORTED_COLLECTIONS.length, 'kokoelma kahdesti');
});

test('Laitteen tila -osio kattaa jokaisen laitteen tallennusavaimen ja kertoo muistutuksista', () => {
  const device = section('Laitteen tila');
  for (const entry of DEVICE_STORAGE) {
    assert.ok(device.includes('`' + entry.prefix), `avainetuliite ${entry.prefix} puuttuu dokumentista`);
  }
  assert.match(device, /cancelDeviceNotifications\(\)/);
  assert.match(device, new RegExp(`enintään ${DEVICE_CANCEL_TIMEOUT_MS / 1000} s`));
  assert.match(device, /purgeDeviceDataForUser/);
});

test('poistovirta ja puuttuvat taulut on kuvattu niin kuin koodi ne tekee', () => {
  const deletion = section('Tilin poisto (COMPLETE_LOCAL, ei deployattu)');
  for (const step of ['offline.purge', 'purgeDeviceDataForUser', 'cancelDeviceNotifications',
    'queueAuthNote', "signOut({ scope: 'local' })", 'forceLocalSignOut']) {
    assert.ok(deletion.includes(step), `vaihe ${step} puuttuu kuvauksesta`);
  }
  assert.match(deletion, /### Puuttuvat taulut/);
  assert.match(deletion, /PGRST205/);
  assert.match(deletion, /absent/);
  assert.match(deletion, /tools\/pg-rehearsal/, 'kaskadin todistus oikealla kannalla mainittava');

  // Järjestys on sama kuin src/app/accountDeletion.js:ssä.
  const order = ['offline.purge', 'purgeDeviceDataForUser', 'cancelDeviceNotifications', 'queueAuthNote', 'signOutAndClean'];
  const ui = read('src/app/accountDeletion.js');
  const flow = ui.slice(ui.indexOf('dispatch(FLOW_EVENT.SUCCEEDED)'));
  const positions = order.map(step => flow.indexOf(step));
  assert.ok(positions.every(position => position > -1), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'koodin järjestys eroaa dokumentista');
});
