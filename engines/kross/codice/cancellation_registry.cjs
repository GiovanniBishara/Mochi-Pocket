'use strict';
// Shared by the desktop app and standalone importer; confirmations are durable.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_DATES = 3660;
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fail(message, code = 'KROSS_CANCELLATION_INVALID') {
  const error = new Error(message); error.code = code; throw error;
}
function identifier(value, label) {
  if (typeof value !== 'string' || value.length > 120 || !/^[\p{L}\p{N}_-]{1,120}$/u.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(`${label} non valido.`);
  return value;
}
function referenceOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('Nome della prenotazione non valido.');
  return value.trim();
}
function datesOf(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_DATES) fail('Date della prenotazione non valide.');
  const dates = value.map(date => {
    if (typeof date !== 'string' || !/^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(date)) fail('Date della prenotazione non valide.');
    const parsed = new Date(date + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('Date della prenotazione non valide.');
    return date;
  });
  if (new Set(dates).size !== dates.length) fail('Le date della prenotazione non possono essere duplicate.');
  return dates.sort();
}
function timestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function revisionOf({ calendarId, bookingId, reference, dates }) {
  return crypto.createHash('sha256').update(JSON.stringify([calendarId, bookingId, reference, dates])).digest('hex');
}
function identity(input) {
  if (!object(input)) fail('Conferma di annullamento non valida.');
  return { calendarId: identifier(input.calendarId, 'Calendario'), bookingId: identifier(input.bookingId, 'ID prenotazione') };
}
function expectedEntry(input) {
  const normalized = { ...identity(input), reference: referenceOf(input.reference), dates: datesOf(input.dates) };
  return { ...normalized, revision: revisionOf(normalized) };
}
function validateStore(value) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || Object.keys(value).some(key => !['version', 'entries'].includes(key))) throw Error();
  const seen = new Set();
  for (const entry of value.entries) {
    const normalized = expectedEntry(entry), key = JSON.stringify([normalized.calendarId, normalized.bookingId]);
    if (seen.has(key) || entry.reference !== normalized.reference || JSON.stringify(entry.dates) !== JSON.stringify(normalized.dates)
      || entry.revision !== normalized.revision || !timestamp(entry.confirmedAt)
      || !['confirmed', 'released'].includes(entry.status)
      || Object.keys(entry).some(field => !['calendarId', 'bookingId', 'reference', 'dates', 'revision', 'confirmedAt', 'status', 'releasedAt', 'audit'].includes(field))
      || !Array.isArray(entry.audit) || entry.audit.length !== (entry.status === 'released' ? 2 : 1)) throw Error();
    const first = entry.audit[0];
    if (!object(first) || first.type !== 'confirmed' || first.at !== entry.confirmedAt || first.revision !== entry.revision
      || Object.keys(first).some(field => !['type', 'at', 'revision'].includes(field))) throw Error();
    if (entry.status === 'confirmed') { if (entry.releasedAt !== null) throw Error(); }
    else {
      const release = entry.audit[1];
      if (!timestamp(entry.releasedAt) || entry.releasedAt < entry.confirmedAt || !object(release)
        || release.type !== 'released' || release.at !== entry.releasedAt || release.revision !== entry.revision
        || Object.keys(release).some(field => !['type', 'at', 'revision'].includes(field))) throw Error();
    }
    seen.add(key);
  }
  return value;
}

/** Explicit user-confirmed tombstones. Absence from an export never changes this file.
 * `released` records that calendar cleanup committed; it does not remove the
 * cancellation or permit a later confirmed export to reactivate the same ID.
 */
function createCancellationRegistry({ filePath, now = () => new Date() } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) fail('Percorso del registro annullamenti non valido.');
  const target = path.resolve(filePath);
  function serialized(operation) {
    const pending = (queues.get(target) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(target, pending);
    const cleanup = () => { if (queues.get(target) === pending) queues.delete(target); };
    pending.then(cleanup, cleanup);
    return pending;
  }
  function currentTime() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('Data della conferma non valida.');
    return value.toISOString();
  }
  async function read() {
    let raw;
    try {
      const info = await fs.stat(target);
      if (!info.isFile() || info.size > MAX_BYTES) throw Error();
      raw = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, entries: [] };
      fail('Registro annullamenti non accessibile. Nessun dato è stato sostituito.', 'KROSS_CANCELLATION_UNAVAILABLE');
    }
    try { return validateStore(JSON.parse(raw.replace(/^\uFEFF/, ''))); }
    catch { fail('Registro annullamenti non valido o non supportato. Nessun dato è stato sostituito.', 'KROSS_CANCELLATION_CORRUPT'); }
  }
  async function write(store) {
    const serialized = JSON.stringify(store, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) fail('Il registro annullamenti ha raggiunto la dimensione massima. Nessun dato è stato sostituito.');
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, target); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      }
    } catch { fail('Non riesco a salvare il registro annullamenti. Nessun dato esistente è stato rimosso.', 'KROSS_CANCELLATION_WRITE_FAILED'); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  return {
    list() { return serialized(async () => clone((await read()).entries)); },
    confirm(input) {
      return serialized(async () => {
        if (input?.confirmed !== true) fail('Conferma esplicitamente che questa prenotazione è stata annullata.');
        const normalized = expectedEntry(input), store = await read();
        const existing = store.entries.find(entry => entry.calendarId === normalized.calendarId && entry.bookingId === normalized.bookingId);
        if (existing) {
          if (existing.revision !== normalized.revision) fail('L’ID è già annullato per un nome o date diversi. Rileggi la prenotazione: nessun dato è stato sostituito.', 'KROSS_CANCELLATION_CHANGED');
          return clone(existing);
        }
        if (store.entries.length >= MAX_ENTRIES) fail('Il registro annullamenti ha raggiunto il numero massimo di voci.');
        const confirmedAt = currentTime();
        const entry = { ...normalized, confirmedAt, status: 'confirmed', releasedAt: null,
          audit: [{ type: 'confirmed', at: confirmedAt, revision: normalized.revision }] };
        store.entries.push(entry); await write(store); return clone(entry);
      });
    },
    markReleased(input) {
      return serialized(async () => {
        if (input?.confirmed !== true) fail('Conferma il completamento della pulizia della prenotazione annullata.');
        const requested = identity(input), store = await read();
        const entry = store.entries.find(value => value.calendarId === requested.calendarId && value.bookingId === requested.bookingId);
        if (!entry || typeof input.revision !== 'string' || entry.revision !== input.revision) fail('La conferma di annullamento è cambiata o non esiste. Rileggi il registro prima di continuare.', 'KROSS_CANCELLATION_CHANGED');
        if (entry.status === 'released') return clone(entry);
        const releasedAt = currentTime();
        if (releasedAt < entry.confirmedAt) fail('La data di completamento precede la conferma di annullamento.');
        entry.status = 'released'; entry.releasedAt = releasedAt;
        entry.audit.push({ type: 'released', at: releasedAt, revision: entry.revision });
        await write(store); return clone(entry);
      });
    },
  };
}

module.exports = { createCancellationRegistry };
