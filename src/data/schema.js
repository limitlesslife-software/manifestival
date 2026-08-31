// Skeemakyvykkyydet: mitkä tietokannan sarakkeet ovat oikeasti olemassa.
//
// MIKSI TÄMÄ ON OLEMASSA
// Domain-malli ja käyttöliittymä on kirjoitettu valmiiksi laajennetuille
// kentille (kuvaus, kesto, prioriteetti, aikataulutuksen tila). Tuotannon
// tietokannassa niitä ei kuitenkaan vielä ole, koska migraatiota 0002 ei ole
// ajettu — ja sen ajaminen on käyttäjän päätös, ei tämän koodin.
//
// Ilman tätä porttia sovellus yrittäisi kirjoittaa olemattomiin sarakkeisiin
// ja JOKAINEN tallennus epäonnistuisi tuotannossa.
//
// MITEN MIGRAATIO OTETAAN KÄYTTÖÖN
//   1. Aja supabase/migrations/0002_task_domain_fields.sql
//   2. Vaihda TASK_EXTENDED_FIELDS arvoon true
//   3. Aja npm test
//   4. Julkaise
//
// Se on tarkoituksella yhden rivin muutos: kaikki muu koodi on jo valmiina.

import { TASK_COLUMNS_CORE, TASK_COLUMNS_EXTENDED } from '../lib/rows.js';

/**
 * Onko migraatio 0002 ajettu tuotantoon?
 *
 * false = tasks-taulussa on vain alkuperäiset 9 saraketta.
 *         Kuvaus, kesto, prioriteetti ja aikataulutuksen tila elävät vain
 *         selaimen muistissa ja katoavat sivun latauksessa.
 * true  = kaikki domainin kentät tallentuvat.
 *
 * PRODUCTION GATE — älä muuta ilman että migraatio on todella ajettu.
 */
export const TASK_EXTENDED_FIELDS = false;

/** Sarakkeet, joita tehtävän kirjoituksissa saa käyttää juuri nyt. */
export function taskColumns() {
  return TASK_EXTENDED_FIELDS ? TASK_COLUMNS_EXTENDED : TASK_COLUMNS_CORE;
}

/**
 * Kentät, jotka eivät vielä säily tallennuksen yli.
 * Käyttöliittymä voi kertoa tämän käyttäjälle rehellisesti sen sijaan,
 * että se teeskentelisi tallentavansa ne.
 */
export function volatileFields() {
  return TASK_EXTENDED_FIELDS
    ? []
    : ['description', 'durationMinutes', 'priority', 'schedulingState'];
}

/** Säilyykö annettu domain-kenttä tallennuksen yli? */
export function isPersisted(field) {
  return !volatileFields().includes(field);
}
