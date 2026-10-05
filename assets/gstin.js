/**
 * GSTIN validation in the browser, including the check digit.
 *
 * Mirrors src/lib/website/gstin.js in Central Ledger, deliberately line for line, so the
 * page and the server can never disagree about whether a number is acceptable. If you
 * change the algorithm in one, change it in the other.
 *
 * Format checking alone is not much use here: it accepts every transposed digit and every
 * character misread off a printed invoice. The 15th character is a checksum over the first
 * 14, so a full validation catches the errors people actually make. That matters because
 * this number gets printed on a tax invoice the buyer files a return against.
 *
 * Layout: 2 digit state code, 10 character PAN, 1 entity code, 1 literal Z, 1 checksum.
 */
(function () {
  'use strict';

  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  const SHAPE_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

  /** Only the states, for the message. The server holds the full map. */
  const STATE_CODES = [
    '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14',
    '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '26', '27', '29', '30',
    '31', '32', '33', '34', '35', '36', '37', '38',
  ];

  const normalize = (value) => String(value || '').replace(/\s/g, '').toUpperCase();

  /**
   * The official check digit: each of the first 14 characters is weighted alternately 1
   * and 2, and the digits of each product are summed, which is why it is not a plain
   * modulus.
   */
  function checkDigit(first14) {
    let total = 0;
    for (let i = 0; i < 14; i++) {
      const value = CHARS.indexOf(first14[i]);
      if (value < 0) return null;
      const product = value * (i % 2 === 0 ? 1 : 2);
      total += Math.floor(product / 36) + (product % 36);
    }
    return CHARS[(36 - (total % 36)) % 36];
  }

  /**
   * @returns {string} an empty string when the value is acceptable, otherwise a message
   *   written to be read by a person. An empty input is acceptable: the field is optional.
   */
  function error(value) {
    const g = normalize(value);
    if (!g) return '';
    if (g.length !== 15) return 'A GSTIN is 15 characters.';
    if (!SHAPE_RE.test(g)) return 'That does not look like a GSTIN.';
    if (!PAN_RE.test(g.slice(2, 12))) return 'The PAN inside that GSTIN is not valid.';
    if (STATE_CODES.indexOf(g.slice(0, 2)) < 0) return 'That state code is not a GST state.';
    // Almost always a transposition or a misread character rather than a fake number.
    if (checkDigit(g.slice(0, 14)) !== g[14]) return 'That GSTIN fails its check digit. Please re-check it.';
    return '';
  }

  window.gridGstin = { normalize, checkDigit, error, isValid: (v) => error(v) === '' && !!normalize(v) };
}());
