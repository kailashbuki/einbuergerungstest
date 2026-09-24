// GENERATED FILE — do not edit by hand.
// Source: scripts/build-questions.ts (npm run build:questions)

/** ISO 3166-2:DE subdivision codes for the 16 Bundesländer. */
export const STATE_CODES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const;

export type StateCode = (typeof STATE_CODES)[number];

export interface State {
  /** ISO 3166-2:DE subdivision code, e.g. "BW". */
  readonly code: StateCode;
  /** Official German name. */
  readonly name: string;
  /** True for the three Stadtstaaten (Berlin, Bremen, Hamburg). */
  readonly isCityState: boolean;
  /** Repo-relative path to this state's coat of arms, or null when none is available. */
  readonly wappen: string | null;
}

/** All 16 Bundesländer in conventional German alphabetical order by name. */
export const STATES: readonly State[] = [
  { code: 'BW', name: 'Baden-Württemberg', isCityState: false, wappen: 'img/bw01.jpg' },
  { code: 'BY', name: 'Bayern', isCityState: false, wappen: 'img/by01.jpg' },
  { code: 'BE', name: 'Berlin', isCityState: true, wappen: 'img/be01.jpg' },
  { code: 'BB', name: 'Brandenburg', isCityState: false, wappen: 'img/bb01.jpg' },
  { code: 'HB', name: 'Bremen', isCityState: true, wappen: 'img/hb01.jpg' },
  { code: 'HH', name: 'Hamburg', isCityState: true, wappen: 'img/hh01.jpg' },
  { code: 'HE', name: 'Hessen', isCityState: false, wappen: 'img/he01.jpg' },
  { code: 'MV', name: 'Mecklenburg-Vorpommern', isCityState: false, wappen: 'img/mv01.jpg' },
  { code: 'NI', name: 'Niedersachsen', isCityState: false, wappen: 'img/ni01.jpg' },
  { code: 'NW', name: 'Nordrhein-Westfalen', isCityState: false, wappen: 'img/nw01.jpg' },
  { code: 'RP', name: 'Rheinland-Pfalz', isCityState: false, wappen: 'img/rp01.jpg' },
  { code: 'SL', name: 'Saarland', isCityState: false, wappen: 'img/sl01.jpg' },
  { code: 'SN', name: 'Sachsen', isCityState: false, wappen: 'img/sn01.jpg' },
  { code: 'ST', name: 'Sachsen-Anhalt', isCityState: false, wappen: 'img/st01.jpg' },
  { code: 'SH', name: 'Schleswig-Holstein', isCityState: false, wappen: 'img/sh01.jpg' },
  { code: 'TH', name: 'Thüringen', isCityState: false, wappen: 'img/th01.jpg' },
];

export const STATES_BY_CODE: Record<StateCode, State> = Object.fromEntries(
  STATES.map((s) => [s.code, s]),
) as Record<StateCode, State>;

export function isStateCode(value: string): value is StateCode {
  return (STATE_CODES as readonly string[]).includes(value);
}
