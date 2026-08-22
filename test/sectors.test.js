import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectorOf, SECTORS, SECTOR_LABEL } from '../sectors.js';

test('sectorOf: government via gov TLD label', () => {
  assert.equal(sectorOf('rada.gov.ua'), 'government');
  assert.equal(sectorOf('www.gouvernement.fr'), 'government');
  assert.equal(sectorOf('comune.milano.it'), 'government');
  assert.equal(sectorOf('polizei.bayern.de'), 'government');
});

test('sectorOf: military beats government', () => {
  assert.equal(sectorOf('www.mil.pl'), 'military');
  assert.equal(sectorOf('bundeswehr.de'), 'military');
  assert.equal(sectorOf('esercito.difesa.it'), 'military');
});

test('sectorOf: finance', () => {
  assert.equal(sectorOf('online.bank.example'), 'finance');
  assert.equal(sectorOf('sparkasse.de'), 'finance');
  assert.equal(sectorOf('raiffeisen.at'), 'finance');
  // "banca" must win finance, not energy via "electr"
  assert.equal(sectorOf('bancaelectronica.example'), 'finance');
});

test('sectorOf: energy & utilities', () => {
  assert.equal(sectorOf('oblenergo.example.ua'), 'energy');
  assert.equal(sectorOf('stromnetz.berlin'), 'energy');
  assert.equal(sectorOf('nuclear.example'), 'energy');
});

test('sectorOf: transport, with port boundary rules', () => {
  assert.equal(sectorOf('port.rotterdam.nl'), 'transport');
  assert.equal(sectorOf('port-varna.bg'), 'transport');
  assert.equal(sectorOf('aeroport.example'), 'transport');
  assert.equal(sectorOf('bahn.de'), 'transport');
  // must NOT hit "port" as a substring of report/support/portal
  assert.equal(sectorOf('support.example.com'), 'other');
  assert.equal(sectorOf('report.example.com'), 'other');
  assert.equal(sectorOf('portal.example.com'), 'other');
});

test('sectorOf: telecom / media / education / healthcare', () => {
  assert.equal(sectorOf('telecom.example'), 'telecom');
  assert.equal(sectorOf('news.example'), 'media');
  assert.equal(sectorOf('university.example'), 'education');
  assert.equal(sectorOf('student.tu-berlin.ac.at'), 'education'); // "ac" whole label
  assert.equal(sectorOf('clinic.example'), 'healthcare');
});

test('sectorOf: false positives fall through to other', () => {
  // "press" only as a whole label — express/compress must not be media
  assert.equal(sectorOf('express.example.com'), 'other');
  // "spital"/"hospital" but not hospitality
  assert.equal(sectorOf('hospitality.example.com'), 'other');
  assert.equal(sectorOf('spital.example'), 'healthcare');
});

test('sectorOf: empty / missing host is other', () => {
  assert.equal(sectorOf(''), 'other');
  assert.equal(sectorOf(null), 'other');
  assert.equal(sectorOf(undefined), 'other');
});

test('every sector key has a label; other is last', () => {
  for (const [key, label] of SECTORS) assert.equal(SECTOR_LABEL[key], label);
  assert.equal(SECTORS[SECTORS.length - 1][0], 'other');
});
