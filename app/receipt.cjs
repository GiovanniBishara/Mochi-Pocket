'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { composeRecipientAddress } = require('./receipt-address.cjs');
const { suggestReceiptNumber } = require('./receipt-numbering.cjs');

class ReceiptError extends Error {
  constructor(message, code = 'RECEIPT_VALIDATION') { super(message); this.code = code; }
}

function field(value, label, { required = true, max = 180, multiline = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new ReceiptError(`${label}: inserisci un testo valido.`);
  const text = value.trim();
  if (required && !text) throw new ReceiptError(`${label}: campo obbligatorio.`);
  if (text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || (!multiline && /[\r\n\t]/.test(text))) {
    throw new ReceiptError(`${label}: testo troppo lungo o caratteri non validi.`);
  }
  return text;
}

function addressLines(value, label, required = true) {
  const items = Array.isArray(value) ? value : field(value, label, { required, max: 600, multiline: true }).split(/\r?\n/);
  if (items.length > 6) throw new ReceiptError(`${label}: usa al massimo sei righe.`);
  const lines = items.map(line => field(line, label, { required: false, max: 180 })).filter(Boolean);
  if (required && !lines.length) throw new ReceiptError(`${label}: campo obbligatorio.`);
  return lines;
}

// Parse decimal strings into integer cents; neither addition nor rounding uses floats.
function moneyCents(value, label = 'Importo') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ReceiptError(`${label}: importo non valido.`);
    value = String(value);
  }
  if (typeof value !== 'string') throw new ReceiptError(`${label}: importo non valido.`);
  let normalized = value.trim();
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(normalized)) normalized = normalized.replaceAll('.', '');
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) {
    throw new ReceiptError(`${label}: usa un importo positivo con al massimo due decimali (es. 125,50).`);
  }
  const [units, decimals = ''] = normalized.replace(',', '.').split('.');
  const cents = BigInt(units) * 100n + BigInt(decimals.padEnd(2, '0'));
  if (cents > 99999999999n) throw new ReceiptError(`${label}: importo troppo elevato.`);
  return Number(cents);
}

function decimalString(cents) { return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`; }

function dateISO(value, label) {
  value = field(value, label, { max: 10 });
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (local) match = [value, local[3], local[2], local[1]];
  }
  if (!match) throw new ReceiptError(`${label}: usa una data valida.`);
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T12:00:00Z`);
  if (Number(year) < 1900 || Number(year) > 9999 || Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month) || parsed.getUTCDate() !== Number(day)) {
    throw new ReceiptError(`${label}: usa una data valida.`);
  }
  return `${year}-${month}-${day}`;
}

function safeFilename(value) {
  let result = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 140).replace(/[. ]+$/g, '');
  if (!result || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(result)) result = `Ricevuta-${result || 'ospite'}`;
  return result;
}

function outputDirectory(value, optional = false) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw new ReceiptError('Configura una cartella assoluta per i PDF ricevute.', 'RECEIPT_OUTPUT');
  }
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value.trim())) {
    throw new ReceiptError('La cartella dei PDF ricevute deve essere un percorso locale assoluto valido.', 'RECEIPT_OUTPUT');
  }
  return path.resolve(value.trim());
}

function normalizeProfile(source) {
  if (!source || typeof source !== 'object') throw new ReceiptError('Profilo ricevute non valido.', 'RECEIPT_PROFILE');
  const issuer = source.issuer || {};
  const property = source.property || {};
  const id = field(source.id, 'Identificativo profilo', { max: 64 });
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ReceiptError('Identificativo profilo non valido.', 'RECEIPT_PROFILE');
  const calendarInitial = field(source.calendarInitial, 'Calendario della struttura', { required: false, max: 1 });
  if (calendarInitial && !/^[A-Z]$/.test(calendarInitial)) throw new ReceiptError('Calendario della struttura non valido.', 'RECEIPT_PROFILE');
  const destination = outputDirectory(source.outputDir, true);
  return {
    id,
    ...(calendarInitial ? { calendarInitial } : {}),
    ...(destination ? { outputDir: destination } : {}),
    label: field(source.label || property.name, 'Nome profilo', { max: 120 }),
    issuer: {
      name: field(issuer.name, 'Emittente', { max: 160 }),
      taxId: field(issuer.taxId, 'P. IVA / Codice fiscale emittente', { max: 64 }),
      taxLabel: field(issuer.taxLabel || 'P. IVA / C.F.', 'Etichetta fiscale', { max: 40 }),
      address: addressLines(issuer.address, 'Indirizzo emittente'),
    },
    property: {
      name: field(property.name, 'Nome struttura', { max: 160 }),
      address: field(property.address, 'Indirizzo struttura', { max: 200 }),
      city: field(property.city, 'Città struttura', { max: 100 }),
      kind: field(property.kind || 'CAV', 'Tipo struttura', { max: 50 }),
    },
  };
}

function readProfiles(profilePath) {
  if (!profilePath) throw new ReceiptError('Configura il profilo emittente prima di creare una ricevuta.', 'RECEIPT_PROFILE_MISSING');
  let content;
  try {
    const info = fs.statSync(profilePath);
    if (!info.isFile() || info.size > 256 * 1024) throw new ReceiptError('Il file dei profili ricevute non è valido.', 'RECEIPT_PROFILE');
    content = fs.readFileSync(profilePath, 'utf8');
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    if (error.code === 'ENOENT') throw new ReceiptError('Configura il profilo emittente prima di creare una ricevuta.', 'RECEIPT_PROFILE_MISSING');
    throw new ReceiptError('Non riesco a leggere i profili salvati. Controlla l’accesso alla cartella di Mochi e premi Rileggi profili salvati.', 'RECEIPT_PROFILE_UNREADABLE');
  }
  let parsed;
  try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new ReceiptError('Il file dei profili ricevute non è un JSON valido.', 'RECEIPT_PROFILE'); }
  if (!parsed || !Array.isArray(parsed.profiles) || !parsed.profiles.length || parsed.profiles.length > 100) {
    throw new ReceiptError('Aggiungi almeno un profilo emittente nel file ricevute.', 'RECEIPT_PROFILE');
  }
  const profiles = parsed.profiles.map(normalizeProfile);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new ReceiptError('I profili ricevute hanno identificativi duplicati.', 'RECEIPT_PROFILE');
  return profiles;
}

function prepare(input, profiles) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReceiptError('Compila i dati della ricevuta.');
  const profile = profiles.find(item => item.id === input.profileId);
  if (!profile) throw new ReceiptError('Seleziona un profilo emittente valido.', 'RECEIPT_PROFILE');
  const recipientName = field(input.recipientName, 'Nome destinatario', { required: false, max: 160 });
  const recipientCompany = field(input.recipientCompany, 'Azienda destinataria', { required: false, max: 160 });
  if (!recipientName && !recipientCompany) throw new ReceiptError('Inserisci il nome o l’azienda del destinatario.');
  const number = field(input.number, 'Numero ricevuta', { max: 32 });
  if (!/^[\p{L}\p{N} /._-]+$/u.test(number)) throw new ReceiptError('Numero ricevuta: usa lettere, numeri, / o trattino.');
  const issueDate = dateISO(input.issueDate, 'Data emissione');
  const arrival = dateISO(input.arrival, 'Arrivo');
  const departure = dateISO(input.departure, 'Partenza');
  if (departure < arrival) throw new ReceiptError('La partenza deve essere successiva o uguale all’arrivo.');
  const rentCents = moneyCents(input.rent, 'Canone');
  const cityTaxCents = moneyCents(input.cityTax === undefined || input.cityTax === '' ? '0' : input.cityTax, 'Imposta di soggiorno');
  const totalCents = rentCents + cityTaxCents;
  if (!totalCents) throw new ReceiptError('Il totale della ricevuta deve essere maggiore di zero.');
  if (!Number.isSafeInteger(totalCents)) throw new ReceiptError('Totale non valido.');
  return {
    profile,
    receipt: {
      number, issueDate, arrival, departure, rentCents, cityTaxCents, totalCents,
      recipientName, recipientCompany,
      recipientAddress: composeRecipientAddress(input),
      recipientTaxId: field(input.recipientTaxId, 'P. IVA / Codice fiscale destinatario', { required: false, max: 64 }),
      recipientTaxLabel: field(input.recipientTaxLabel || 'P. IVA / C.F.', 'Etichetta fiscale destinatario', { max: 40 }),
      paymentMethod: field(input.paymentMethod, 'Metodo di pagamento', { required: false, max: 120 }),
    },
    filename: safeFilename(`Ricevuta n ${number} - ${recipientCompany || recipientName}`),
  };
}

function runPython(pythonPath, payload, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(pythonPath, ['-X', 'utf8', path.join(__dirname, 'receipt.py')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new ReceiptError('Impossibile avviare Python per creare il PDF.', 'RECEIPT_RUNTIME')); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(new ReceiptError('Creazione PDF interrotta: tempo massimo superato.', 'RECEIPT_TIMEOUT')); }, 45000);
    timer.unref?.();
    child.on('error', () => finish(new ReceiptError('Python non disponibile. Controlla il percorso configurato.', 'RECEIPT_RUNTIME')));
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 65536) { child.kill(); finish(new ReceiptError('Risposta PDF non valida.', 'RECEIPT_RUNTIME')); } });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {}); // A missing Python runtime may close stdin before its error event.
    child.on('close', code => {
      if (settled) return;
      let result;
      try { result = JSON.parse(stdout.trim()); } catch { /* No user data or raw stderr is copied to the activity log. */ }
      if (code !== 0 || !result?.ok) {
        const message = /(?:No module named|ModuleNotFoundError).*reportlab/i.test(stderr)
          ? 'Manca ReportLab nel Python configurato per le ricevute.'
          : result?.code === 'RECEIPT_LAYOUT' ? 'Testo troppo lungo per il modello ricevuta: abbrevia nome o indirizzo.'
            : 'Impossibile creare il PDF. Controlla cartella di destinazione e runtime Python.';
        finish(new ReceiptError(message, result?.code || 'RECEIPT_PDF'));
      } else finish(null, result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function createReceiptAdapter({ pythonPath = 'python', outputDir, profilePath, spawnImpl = spawn } = {}) {
  return {
    async inspectProfiles() {
      try {
        const profiles = readProfiles(profilePath);
        return { ok: true, configured: true, profiles: profiles.map(item => ({ id: item.id, label: item.label, issuerName: item.issuer.name, propertyName: item.property.name, calendarInitial: item.calendarInitial || '', ...(item.outputDir ? { outputDir: item.outputDir } : {}) })) };
      } catch (error) { return { ok: false, configured: false, profiles: [], error: error.message, code: error.code || 'RECEIPT_PROFILE' }; }
    },
    outputDirectory(profileId) {
      try {
        const profile = readProfiles(profilePath).find(item => item.id === profileId);
        return profile ? outputDirectory(profile.outputDir || outputDir) : null;
      } catch { return null; }
    },
    async suggestNumber(input) {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReceiptError('Scegli una struttura e una data di emissione valide.', 'RECEIPT_NUMBER');
        const profile = readProfiles(profilePath).find(item => item.id === input.profileId);
        if (!profile) throw new ReceiptError('Seleziona un profilo emittente valido.', 'RECEIPT_PROFILE');
        const issueDate = dateISO(input.issueDate, 'Data emissione');
        return await suggestReceiptNumber({ outputDir: outputDirectory(profile.outputDir || outputDir), issueDate, pythonPath, spawnImpl });
      } catch (error) { return { ok: false, error: error.message || 'Non riesco a suggerire il numero della ricevuta.', code: error.code || 'RECEIPT_NUMBER' }; }
    },
    async generate(input) {
      try {
        const payload = prepare(input, readProfiles(profilePath));
        payload.outputDir = outputDirectory(payload.profile.outputDir || outputDir);
        const result = await runPython(pythonPath, payload, spawnImpl);
        const generatedPath = path.resolve(result.path || '');
        if (path.dirname(generatedPath) !== payload.outputDir || path.extname(generatedPath).toLowerCase() !== '.pdf' || result.totalCents !== payload.receipt.totalCents) {
          throw new ReceiptError('Il generatore ha restituito un PDF non valido.', 'RECEIPT_PDF');
        }
        return { ok: true, path: generatedPath, total: decimalString(payload.receipt.totalCents), totalCents: payload.receipt.totalCents, number: payload.receipt.number };
      } catch (error) { return { ok: false, error: error.message || 'Impossibile creare la ricevuta.', code: error.code || 'RECEIPT_PDF' }; }
    },
  };
}

module.exports = { createReceiptAdapter, moneyCents, dateISO, safeFilename, normalizeProfile };
