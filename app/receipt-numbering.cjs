'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_ENTRIES = 10000;
const NUMBERED_PDF = /^Ricevuta\s+n\.?\s+(\d{1,24})\s*[-_/]\s*(\d{4}|\d{2})(?=\s+-\s+|(?:\s+\(\d+\))?\.pdf$)/i;
const TEST_PDF = /^(?:Ricevuta\s+n\.?\s+)?(?:TEST|VERIFICA)(?:[-_ .]|$)/i;
const LEGACY_PDF = /^Ricevuta\s+n\.?\s+(\d{1,24})(?:\s+\(\d+\))?\.pdf$/i;
const MAX_LEGACY_FILES = 100;
const MAX_DURATION_MS = 15000;
function stop(child) { try { child?.kill?.(); } catch { /* A vanished reader cannot block the caller. */ } }

function failure(code, message) { return { ok: false, code, error: message, message }; }

function emissionYear(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const date = new Date(value + 'T12:00:00.000Z');
  if (year < 1900 || year > 9999 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return year;
}

const timeoutFailure = () => failure('RECEIPT_NUMBER_TIMEOUT', 'La verifica del numero ha impiegato troppo tempo. Inserisci il numero manualmente.');
const uncertainFailure = () => failure('RECEIPT_NUMBER_UNCERTAIN', 'Non posso confermare numero e anno di tutte le ricevute salvate. Controlla l’archivio e inserisci il numero manualmente.');

async function legacyMetadata(directory, files, pythonPath, spawnImpl, state) {
  if (state.cancelled) return null;
  if (typeof pythonPath !== 'string' || !pythonPath.trim() || pythonPath.includes('\0') || typeof spawnImpl !== 'function') return null;
  const payload = JSON.stringify({ directory, files });
  if (Buffer.byteLength(payload) > 64 * 1024) return null;
  return new Promise(resolve => {
    let child, stdout = '', bytes = 0, settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (state.child === child) state.child = null;
      resolve(value);
    };
    try {
      child = spawnImpl(pythonPath, ['-B', '-X', 'utf8', path.join(__dirname, 'receipt-numbering.py')], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      state.child = child;
      if (!child.stdin || !child.stdout || !child.stderr) { stop(child); finish(null); return; }
      child.stdout.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 32768) { stop(child); finish(null); return; }
        stdout += String(chunk);
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.once('error', () => finish(null));
      child.once('close', code => {
        if (state.cancelled) { finish(null); return; }
        try {
          const result = JSON.parse(stdout);
          if (code !== 0 || result?.ok !== true || !Array.isArray(result.receipts) || result.receipts.length !== files.length) { finish(null); return; }
          const valid = result.receipts.every((receipt, index) => receipt && typeof receipt.number === 'string' && /^\d{1,24}$/.test(receipt.number)
            && BigInt(receipt.number) === BigInt(files[index].number) && typeof receipt.year === 'string' && /^(?:\d{2}|\d{4})$/.test(receipt.year)
            && (receipt.year.length !== 4 || Number(receipt.year) >= 1900 && Number(receipt.year) <= 9999)
            && typeof receipt.fullYear === 'boolean');
          finish(valid ? result.receipts.map(receipt => ({ number: receipt.number, year: receipt.year, fullYear: receipt.fullYear })) : null);
        } catch { finish(null); }
      });
      child.stdin.end(payload);
    } catch { stop(child); finish(null); }
  });
}

async function inspectArchive({ outputDir, issueDate, pythonPath, spawnImpl = spawn }, state) {
  const year = emissionYear(issueDate);
  if (year === null) return failure('RECEIPT_NUMBER_DATE', 'Scegli una data di emissione valida per suggerire il numero.');
  if (typeof outputDir !== 'string' || !outputDir.trim() || /[\x00-\x1f\x7f]/.test(outputDir) || !path.isAbsolute(outputDir.trim())) {
    return failure('RECEIPT_NUMBER_OUTPUT', 'Configura una cartella ricevute valida prima di suggerire il numero.');
  }
  let entries = 0, unknown = false, nested = false, max = null, fullYear = false;
  const legacy = [], directoryPath = path.resolve(outputDir.trim());
  const shortYear = String(year).slice(-2);
  const consider = (number, archiveYear, useFullYear) => {
    if (archiveYear !== String(year) && archiveYear !== shortYear) return;
    const serial = BigInt(number);
    if (max === null || serial > max) { max = serial; fullYear = useFullYear; }
    else if (serial === max && useFullYear) fullYear = true;
  };
  try {
    const directory = await fs.opendir(directoryPath);
    for await (const entry of directory) {
      if (state.cancelled) return timeoutFailure();
      if (++entries > MAX_ENTRIES) return failure('RECEIPT_NUMBER_LIMIT', 'La cartella contiene troppi elementi per verificare la numerazione. Inserisci il numero manualmente.');
      if (entry.isDirectory()) { nested = true; continue; }
      if (entry.isSymbolicLink?.()) { unknown = true; continue; }
      if (!/\.pdf$/i.test(entry.name)) continue;
      if (!entry.isFile()) { unknown = true; continue; }
      const match = NUMBERED_PDF.exec(entry.name);
      if (!match) {
        const old = LEGACY_PDF.exec(entry.name);
        if (old) {
          if (legacy.length >= MAX_LEGACY_FILES) return failure('RECEIPT_NUMBER_LIMIT', 'Sono presenti troppe ricevute precedenti da verificare. Inserisci il numero manualmente.');
          legacy.push({ path: path.join(directoryPath, entry.name), number: old[1] });
        } else if (!TEST_PDF.test(entry.name)) unknown = true;
        continue;
      }
      const archiveYear = match[2];
      if (archiveYear.length === 4 && (Number(archiveYear) < 1900 || Number(archiveYear) > 9999)) { unknown = true; continue; }
      consider(match[1], archiveYear, archiveYear.length === 4);
    }
  } catch {
    return failure('RECEIPT_NUMBER_UNAVAILABLE', 'Non riesco a leggere la cartella ricevute. Verifica che la cartella sia raggiungibile oppure inserisci il numero manualmente.');
  }
  if (nested) return failure('RECEIPT_NUMBER_NESTED', 'La cartella contiene sottocartelle: non posso verificare tutti i numeri salvati. Inserisci il numero manualmente.');
  if (unknown) return uncertainFailure();
  if (legacy.length) {
    const receipts = await legacyMetadata(directoryPath, legacy, pythonPath, spawnImpl, state);
    if (state.cancelled) return timeoutFailure();
    if (!receipts) return uncertainFailure();
    for (const receipt of receipts) consider(receipt.number, receipt.year, receipt.fullYear);
  }
  const suffix = fullYear ? String(year) : shortYear;
  const lastNumber = max === null ? null : `${max}/${suffix}`;
  const number = `${max === null ? 1n : max + 1n}/${suffix}`;
  return {
    ok: true, number, lastNumber, year, basis: 'archive', checkedAt: new Date().toISOString(),
    message: lastNumber
      ? `Ultima ricevuta riconosciuta: ${lastNumber}. Numero suggerito: ${number}. Puoi modificarlo prima di creare il PDF.`
      : `Nessuna ricevuta numerata per il ${year} trovata nella cartella. Proposto ${number}: conferma o modifica il numero prima di creare il PDF.`,
  };
}

/** Annual names need no content reads. Legacy names without an annual suffix
 * use a bounded reader that returns only document number/year from page one.
 * Opening this suggestion never creates or reserves a receipt number.
 */
async function suggestReceiptNumber(options = {}) {
  const state = { cancelled: false, child: null };
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => { state.cancelled = true; stop(state.child); resolve(timeoutFailure()); }, MAX_DURATION_MS);
    timer.unref?.();
  });
  try { return await Promise.race([inspectArchive(options, state), timeout]); }
  catch { return uncertainFailure(); }
  finally { clearTimeout(timer); }
}

module.exports = { suggestReceiptNumber };
