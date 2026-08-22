// anti-DDoSia — best-effort SECTOR classification of a target from its hostname.
//
// Heuristic (TLD/label + keyword), deterministic, no external lookup. Government
// and military are reliable (clear TLDs: .gov/.gouv/.mil/…); the rest are
// *inferred* from name keywords, so a generous "other" bucket is expected and
// the UI labels it "inferred". Tuned against the real target list, which is
// government-heavy and (by volume) German/Ukrainian/Italian/Canadian.

export const SECTORS = [
  ['government', 'Government'],
  ['military', 'Military & defense'],
  ['finance', 'Finance'],
  ['energy', 'Energy & utilities'],
  ['transport', 'Transport'],
  ['telecom', 'Telecom & IT'],
  ['media', 'Media'],
  ['healthcare', 'Healthcare'],
  ['education', 'Education'],
  ['other', 'Other'],
];
export const SECTOR_LABEL = Object.fromEntries(SECTORS);

// whole-label match (e.g. the "gov" in rada.gov.ua) — precise, few false positives
const label = (labels, ...names) => labels.some((l) => names.includes(l));
// substring-in-any-label match (e.g. "ministr" in ministrstvo) — broader
const kw = (labels, ...words) => labels.some((l) => words.some((w) => l.includes(w)));
// regex-in-any-label — for prefix/boundary rules that a plain substring gets wrong
const re = (labels, rx) => labels.some((l) => rx.test(l));

export function sectorOf(host) {
  if (!host) return 'other';
  const labels = String(host).toLowerCase().split('.');

  // military / defense — check before government (it's a subset of public sector)
  if (label(labels, 'mil') || kw(labels, 'army', 'navy', 'airforce', 'defense', 'defence', 'military', 'nato', 'bundeswehr', 'esercito', 'gendarmerie'))
    return 'military';

  // government / public sector (incl. police & municipalities, several languages)
  if (label(labels, 'gov', 'gouv', 'gob', 'gv', 'go', 'gouvernement', 'comune', 'kommune', 'kommun', 'admin', 'rada', 'mairie', 'gouvernementale')
    || kw(labels, 'gov', 'gouv', 'ministr', 'ministe', 'president', 'presedinte', 'parlament', 'parliament', 'senat', 'kabmin', 'municip', 'prefectur', 'polizei', 'politie', 'police', 'oblast'))
    return 'government';

  // finance / banking
  if (label(labels, 'bank') || kw(labels, 'bank', 'banca', 'banco', 'banque', 'banka', 'financ', 'invest', 'credit', 'insur', 'bourse', 'treasury', 'tresor', 'pension', 'forex', 'sparkasse', 'raiffeisen'))
    return 'finance';

  // energy & utilities ("electric"/"elektr", not bare "electr" which hits electronic)
  if (kw(labels, 'energy', 'energo', 'energ', 'power', 'electric', 'elektr', 'nuclear', 'atom', 'hydro', 'petrol', 'oblenergo', 'stromnetz'))
    return 'energy';

  // transport & logistics ("port"/"ports"/"port-…"/"seaport" but not report/support/portal)
  if (re(labels, /^ports?$|^port-|seaport/) || label(labels, 'aero', 'rail') || kw(labels, 'airport', 'aeroport', 'flughafen', 'airline', 'avia', 'railway', 'bahn', 'metro', 'transport', 'logistic', 'shipping', 'transit'))
    return 'transport';

  // telecom & IT
  if (label(labels, 'isp') || kw(labels, 'telecom', 'telco', 'mobile', 'cellular', 'broadband'))
    return 'telecom';

  // media ("press" whole-label only, else it catches express/compress)
  if (label(labels, 'tv', 'press') || kw(labels, 'news', 'media', 'radio', 'novyny', 'gazeta', 'zeitung', 'broadcast'))
    return 'media';

  // healthcare ("spital" whole-label + "hospital" but-not-hospitality)
  if (label(labels, 'spital') || kw(labels, 'health', 'clinic', 'klinik', 'pharma', 'medic') || re(labels, /hospital(?!ity)/))
    return 'healthcare';

  // education
  if (label(labels, 'edu', 'ac') || kw(labels, 'universit', 'school', 'schule', 'hochschule', 'academ', 'college', 'testportal', 'osvita'))
    return 'education';

  return 'other';
}
