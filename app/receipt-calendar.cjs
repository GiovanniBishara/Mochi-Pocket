'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MESSAGES = {
  configuration: 'Configura il collegamento ai calendari Kross prima della ricerca.',
  validation: 'Scegli una struttura e una data valide.',
  google_auth: 'Ricollega Google dalle impostazioni, poi ripeti la ricerca.',
  google_unavailable: 'Calendario Google non raggiungibile. Controlla la connessione e riprova.',
  calendar_invalid: 'La struttura del calendario non permette di riconoscere la prenotazione. Controlla le date e le celle del foglio.',
  runtime: 'Il motore di lettura dei calendari non è disponibile.',
  busy: 'Una ricerca nel calendario è già in corso.',
};
const FIELDS = ['recipientName', 'recipientAddress', 'recipientTaxId', 'arrival', 'departure', 'rent', 'cityTax'];
const TEXT_LIMITS = { recipientName: 160, recipientAddress: 600, recipientTaxId: 64 };
const clean = (value, max = 160) => typeof value === 'string'
  ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max) : '';
const failure = code => ({ ok: false, bookings: [], source: 'google', errorCode: code,
  error: MESSAGES[code], message: MESSAGES[code] });

function validDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function publicBooking(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('Invalid booking');
  const recipientName = clean(source.recipientName, TEXT_LIMITS.recipientName);
  if (!recipientName) throw Error('Missing guest');
  const booking = { id: /^[a-f0-9]{16}$/.test(source.id) ? source.id : null, recipientName };
  for (const key of ['arrival', 'departure']) {
    if (source[key] !== null && source[key] !== undefined && !validDate(source[key])) throw Error('Invalid date');
    booking[key] = source[key] || null;
  }
  if (booking.arrival && booking.departure && booking.departure <= booking.arrival) throw Error('Invalid stay');
  for (const key of ['rent', 'cityTax']) {
    if (source[key] !== null && source[key] !== undefined
      && (typeof source[key] !== 'string' || !/^\d{1,9}\.\d{2}$/.test(source[key]))) throw Error('Invalid money');
    booking[key] = source[key] ?? null;
  }
  for (const key of ['recipientAddress', 'recipientTaxId']) booking[key] = clean(source[key], TEXT_LIMITS[key]);
  booking.missingFields = FIELDS.filter(key => !booking[key]);
  booking.warnings = Array.isArray(source.warnings)
    ? source.warnings.filter(value => typeof value === 'string').map(value => clean(value, 280)).slice(0, 12) : [];
  return booking;
}

/** Explicit, ephemeral guest lookup. inspect never contacts Google or opens login. */
function createReceiptCalendarAdapter({ baseDir, engineDir, pythonPath, spawnImpl = spawn } = {}) {
  const absoluteBase = typeof baseDir === 'string' && path.isAbsolute(baseDir) ? path.resolve(baseDir) : null;
  const codeDirectory = engineDir === undefined && absoluteBase ? path.join(absoluteBase, 'codice')
    : typeof engineDir === 'string' && path.isAbsolute(engineDir) ? path.resolve(engineDir) : null;
  let running = false;

  async function fileExists(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }

  async function configuration() {
    if (!absoluteBase) throw Error('No base');
    const configPath = path.join(absoluteBase, 'config.json');
    if ((await fs.stat(configPath)).size > 1024 * 1024) throw Error('Config too large');
    const config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    if (config?.version !== 1 || !Array.isArray(config.calendars)) throw Error('Invalid config');
    const calendars = config.calendars.filter(item => item?.type === 'google');
    const seen = new Set();
    if (!calendars.length) throw Error('No Google calendars');
    for (const item of calendars) {
      if (typeof item.name !== 'string' || !/^[A-Za-z]/.test(item.name.trim())
        || typeof item.sheetName !== 'string' || !/^20\d{2}$/.test(item.sheetName)
        || ['spreadsheet', 'credentials', 'token'].some(key => typeof item[key] !== 'string' || !item[key] || item[key].includes('\0'))) {
        throw Error('Invalid calendar');
      }
      const key = item.name.trim()[0].toUpperCase() + item.sheetName;
      if (seen.has(key)) throw Error('Ambiguous calendar');
      seen.add(key);
    }
    return calendars;
  }

  async function inspect() {
    let calendars = [];
    try {
      const configured = await configuration();
      calendars = configured.map(item => ({ initial: item.name.trim()[0].toUpperCase(), name: clean(item.name), year: Number(item.sheetName) }));
      if (!codeDirectory || !await fileExists(path.join(codeDirectory, 'google_sheets.py'))
        || typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath) || !await fileExists(pythonPath)) {
        return { configured: false, calendars, reason: MESSAGES.runtime };
      }
      for (const item of configured) {
        if (!await fileExists(path.resolve(absoluteBase, item.credentials)) || !await fileExists(path.resolve(absoluteBase, item.token))) {
          return { configured: false, calendars, reason: MESSAGES.google_auth };
        }
      }
      return { configured: true, calendars };
    } catch { return { configured: false, calendars, reason: MESSAGES.configuration }; }
  }

  async function lookup(input = {}, onProgress) {
    if (running) return failure('busy');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.initial !== 'string' || !/^[A-Z]$/.test(input.initial) || !validDate(input.date)) return failure('validation');
    running = true;
    const progress = (stage, message) => { try { if (typeof onProgress === 'function') onProgress({ stage, message }); } catch {} };
    try {
      const status = await inspect();
      if (!status.configured) return failure(status.reason === MESSAGES.runtime ? 'runtime'
        : status.reason === MESSAGES.google_auth ? 'google_auth' : 'configuration');
      if (!status.calendars.some(item => item.initial === input.initial && item.year === Number(input.date.slice(0, 4)))) return failure('validation');
      progress('reading', 'Leggo il calendario Google per la data scelta…');
      let child;
      try {
        child = spawnImpl(pythonPath, ['-B', path.join(__dirname, 'receipt-calendar.py'),
          '--engine-dir', codeDirectory, '--config', path.join(absoluteBase, 'config.json')], {
          cwd: absoluteBase, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { return failure('runtime'); }
      const output = await new Promise(resolve => {
        let stdout = '', settled = false, oversize = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } };
        const timeout = setTimeout(() => { child.kill?.(); finish(null); }, 180000);
        timeout.unref?.();
        child.stdout?.on('data', chunk => {
          if (oversize) return;
          stdout += String(chunk);
          if (Buffer.byteLength(stdout, 'utf8') > 128 * 1024) { oversize = true; stdout = ''; child.kill?.(); finish(null); }
        });
        child.stderr?.on('data', () => {}); // Raw Google errors, identifiers and guest notes stay private.
        child.stdin?.on('error', () => finish(null));
        child.once('error', () => finish(null));
        child.once('close', code => {
          try { finish(code === 0 && !oversize ? JSON.parse(stdout) : null); } catch { finish(null); }
        });
        try { child.stdin.end(JSON.stringify({ initial: input.initial, date: input.date })); } catch { finish(null); }
      });
      if (!output || typeof output !== 'object') return failure('google_unavailable');
      if (output.ok !== true) return failure(Object.hasOwn(MESSAGES, output.errorCode) ? output.errorCode : 'google_unavailable');
      if (!Array.isArray(output.bookings) || output.bookings.length > 10) return failure('calendar_invalid');
      let bookings;
      try { bookings = output.bookings.map(publicBooking); } catch { return failure('calendar_invalid'); }
      const message = bookings.length ? 'Prenotazione trovata. Controlla e completa i dati della ricevuta.'
        : 'Nessuna prenotazione per la data scelta. Il giorno di partenza è escluso.';
      progress('finished', message);
      return { ok: true, bookings, source: 'google', message };
    } catch { return failure('configuration'); }
    finally { running = false; }
  }

  return { inspect, lookup };
}

module.exports = { createReceiptCalendarAdapter };
