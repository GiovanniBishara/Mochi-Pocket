'use strict';

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'RECEIPT_VALIDATION' });
}

function text(value, label, { required = false, max = 180, multiline = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') invalid(`${label}: inserisci un testo valido.`);
  const clean = value.trim();
  if (required && !clean) invalid(`${label}: campo obbligatorio.`);
  if (clean.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean)
    || (!multiline && /[\r\n\t]/.test(clean))) {
    invalid(`${label}: testo troppo lungo o caratteri non validi.`);
  }
  return clean;
}

function legacyLines(value) {
  const lines = Array.isArray(value) ? value
    : text(value, 'Indirizzo destinatario', { required: true, max: 600, multiline: true }).split(/\r?\n/);
  if (lines.length > 6) invalid('Indirizzo destinatario: usa al massimo sei righe.');
  const clean = lines.map(line => text(line, 'Indirizzo destinatario')).filter(Boolean);
  if (!clean.length) invalid('Indirizzo destinatario: campo obbligatorio.');
  return clean;
}

const comparable = value => value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('it-IT');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compose address rows without guessing a country or a postcode from free text. */
function composeRecipientAddress(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Indirizzo destinatario non valido.');
  const lines = legacyLines(input.recipientAddress);
  const postal = text(input.recipientPostalCode, 'CAP destinatario', { max: 32 });
  const city = text(input.recipientCity, 'Città destinatario', { max: 100 });
  const country = text(input.recipientCountry, 'Paese destinatario', { max: 100 });
  if (!postal && !city && !country) return lines;
  if (!city) invalid('Città destinatario: campo obbligatorio.');

  const locality = [postal, city].filter(Boolean).join(' ');
  const localityRows = new Set([city, locality, ...(postal ? [postal] : [])].map(comparable));
  const countryRow = country ? comparable(country) : null;
  // Only an exact supplied postcode + city can identify a locality inside free
  // text. A city name alone could instead be part of the street name.
  const inlineLocality = postal ? new RegExp(`(?:^|[ ,;])${escaped(comparable(locality))}(?=$|[ ,;(])`) : null;
  const inlineCountry = country ? new RegExp(`(?:^|[ ,;])${escaped(countryRow)}$`) : null;
  const result = [];
  let locationInserted = false, countryInCompleteLine = false;
  for (const line of lines) {
    const key = comparable(line);
    if (localityRows.has(key)) {
      if (!locationInserted) { result.push(locality); locationInserted = true; }
      continue;
    }
    if (inlineLocality?.test(key)) {
      result.push(line);
      locationInserted = true;
      if (inlineCountry?.test(key)) countryInCompleteLine = true;
      continue;
    }
    if (countryRow && key === countryRow) {
      if (!locationInserted) { result.push(locality); locationInserted = true; }
      continue;
    }
    result.push(line);
  }
  if (!locationInserted) result.push(locality);
  if (country && !countryInCompleteLine) result.push(country);
  if (result.length > 6) invalid('Indirizzo destinatario: usa al massimo sei righe.');
  return result;
}

module.exports = { composeRecipientAddress };
