'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { describeKrossConflicts } = require('./kross-conflicts.cjs');

const ENGINE_FILES = [
  'import_scope.mjs', 'cancellation_updates.mjs', 'cancellation_registry.cjs',
  'aggiorna.mjs', 'runtime.mjs', 'calendar_selection.mjs', 'planner.mjs',
  'booking_details.mjs', 'write_calendar.mjs', 'read_workbooks.py',
  'google_sheets.py', 'preserve_xlsx.py',
];
const COUNTERS = ['added', 'adopted', 'updated', 'cancelled', 'patches', 'conflicts', 'warnings'];
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const GOOGLE_MESSAGES = {
  verified: 'Google collegato. Non serve accedere di nuovo.',
  auth: 'Google da collegare. Premi Collega Google.',
  configuration: 'Controlla la configurazione dei calendari Google.',
  network: 'Verifica Google non riuscita. Controlla la connessione e riprova.',
  permissions: 'Google risponde, ma un foglio non è accessibile. Verifica account e permessi.',
  runtime: 'Il controllo Google non è disponibile. Verifica il programma e il runtime Python.',
  busy: 'Attendi il termine dell’operazione in corso, poi verifica Google.',
};

function googleStatus(reason) {
  const status = reason === 'verified' ? 'connected' : reason === 'auth' ? 'disconnected' : 'unknown';
  return { ok: status === 'connected', status, reason, message: GOOGLE_MESSAGES[reason], checkedAt: new Date().toISOString() };
}

class ConfigurationError extends Error {}

function safeName(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
}

function validMonth(value) {
  return typeof value === 'string' && /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(value);
}

async function regularFile(filePath) {
  try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
}

async function readJson(filePath) {
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error('Invalid JSON file');
  return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

function resultFailure(message, extra = {}) {
  return { ok: false, exitCode: null, summary: null, reportPath: null,
    logs: [message], message, outcomeUnknown: false, ...extra };
}

/** Run the bundled Kross CLI without a command shell or exposing its guest logs. */
function createKrossAdapter({ baseDir, engineDir, nodePath, pythonPath, spawnImpl = spawn } = {}) {
  let running = false;
  let readingExport = false;
  let checkingGoogle = null;
  const absoluteBase = typeof baseDir === 'string' && path.isAbsolute(baseDir) ? path.resolve(baseDir) : null;
  const codeDirectory = engineDir === undefined && absoluteBase ? path.join(absoluteBase, 'codice')
    : typeof engineDir === 'string' && path.isAbsolute(engineDir) ? path.resolve(engineDir) : null;

  async function configuration() {
    if (!absoluteBase) throw new ConfigurationError('Cartella Kross non configurata.');
    let config;
    try { config = await readJson(path.join(absoluteBase, 'config.json')); }
    catch { throw new ConfigurationError('Configurazione Kross assente o non valida.'); }
    if (config?.version !== 1 || !Array.isArray(config.calendars) || !config.calendars.length) {
      throw new ConfigurationError('Configurazione Kross non valida.');
    }
    const ids = new Set();
    for (const item of config.calendars) {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.id)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(item.id) || ids.has(item.id.toLowerCase())
        || typeof item.name !== 'string' || !/^[a-zA-Z]/.test(item.name.trim())
        || typeof item.sheetName !== 'string' || !/^\d{4}$/.test(item.sheetName)
        || typeof item.roomName !== 'string' || !item.roomName.trim()
        || !['google', 'excel'].includes(item.type)
        || (item.type === 'google' && (typeof item.spreadsheet !== 'string' || !item.spreadsheet))
        || (item.type === 'excel' && (typeof item.file !== 'string' || !item.file))) {
        throw new ConfigurationError('Uno o più calendari Kross non sono configurati correttamente.');
      }
      ids.add(item.id.toLowerCase());
    }
    if (config.dataDirectory !== undefined && (typeof config.dataDirectory !== 'string'
      || !config.dataDirectory.trim() || config.dataDirectory.includes('\0'))) {
      throw new ConfigurationError('Archivio locale Kross non configurato correttamente.');
    }
    return config;
  }

  function publicCalendars(config) {
    return config.calendars.map(item => ({ id: item.id, name: safeName(item.name.trim()),
      initial: item.name.trim()[0].toUpperCase(), year: Number(item.sheetName) }));
  }

  async function ready(config) {
    if (!codeDirectory) throw new ConfigurationError('Cartella del motore Kross non configurata.');
    for (const runtime of [nodePath || process.execPath, pythonPath]) {
      if (typeof runtime !== 'string' || !path.isAbsolute(runtime) || !await regularFile(runtime)) {
        throw new ConfigurationError('Runtime Node o Python non disponibile.');
      }
    }
    for (const file of ENGINE_FILES) {
      if (!await regularFile(path.join(codeDirectory, file))) {
        throw new ConfigurationError('Motore Kross incompleto: ripristina i file del programma.');
      }
    }
    for (const item of config.calendars) {
      if (item.type === 'google') {
        // Authorization is deliberately never launched as a side effect of an import.
        for (const field of ['credentials', 'token']) {
          if (typeof item[field] !== 'string' || !item[field]
            || !await regularFile(path.resolve(absoluteBase, item[field]))) {
            throw new ConfigurationError('Collegamento Google assente o incompleto.');
          }
        }
      } else if (!await regularFile(path.resolve(absoluteBase, item.file))
        && !(typeof item.initialFile === 'string' && await regularFile(path.resolve(absoluteBase, item.initialFile)))) {
        throw new ConfigurationError('Uno dei calendari Excel configurati non è disponibile.');
      }
    }
  }

  async function inspect() {
    let calendars = [];
    try {
      const config = await configuration();
      calendars = publicCalendars(config);
      await ready(config);
      return { configured: true, calendars };
    } catch (error) {
      return { configured: false, calendars, reason: error instanceof ConfigurationError
        ? error.message : 'Configurazione Kross non disponibile.' };
    }
  }

  async function performExportScope(filePath) {
    const failure = () => ({ ok: false, error: 'Non riesco a leggere i mesi dell’Excel. Scegli un export Kross valido e riprova.' });
    try {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') || !/\.xlsx$/i.test(filePath)
        || !codeDirectory || typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath)) return failure();
      const info = await fs.stat(filePath);
      if (!info.isFile() || info.size > 64 * 1024 * 1024 || !await regularFile(pythonPath)
        || !await regularFile(path.join(codeDirectory, 'read_workbooks.py'))) return failure();
      const helper = path.join(__dirname, 'kross-export-scope.py');
      if (!await regularFile(helper)) return failure();
      const child = spawnImpl(pythonPath, ['-B', helper, '--engine-dir', codeDirectory, '--export', filePath],
        { ...(absoluteBase ? { cwd: absoluteBase } : {}), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const parsed = await new Promise(resolve => {
        let output = '', size = 0, settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const stop = () => { try { child.kill?.(); } catch { /* The read-only helper cannot change bookings. */ } };
        const timer = setTimeout(() => { finish(null); stop(); }, 60000); timer.unref?.();
        child.stdout?.on('data', chunk => {
          if (settled) return;
          size += Buffer.byteLength(chunk);
          if (size > 128 * 1024) { finish(null); stop(); return; }
          output += String(chunk);
        });
        child.stderr?.on('data', () => {});
        child.once('error', () => finish(null));
        child.once('close', code => { try { finish(code === 0 ? JSON.parse(output) : null); } catch { finish(null); } });
      });
      if (!parsed || parsed.ok !== true || !Array.isArray(parsed.months) || parsed.months.length > 1200) return failure();
      const seen = new Set(), months = [];
      for (const item of parsed.months) {
        if (!item || !validMonth(item.month) || seen.has(item.month) || !Number.isSafeInteger(item.stays) || item.stays < 1 || item.stays > 100000
          || !Number.isSafeInteger(item.nights) || item.nights < item.stays || item.nights > 3100000) return failure();
        seen.add(item.month); months.push({ month: item.month, stays: item.stays, nights: item.nights });
      }
      months.sort((a, b) => a.month.localeCompare(b.month));
      const dominant = [...months].sort((a, b) => b.nights - a.nights || b.stays - a.stays || b.month.localeCompare(a.month))[0]?.month || null;
      if (parsed.suggestedMonth !== dominant) return failure();
      return { ok: true, months, suggestedMonth: dominant };
    } catch { return failure(); }
  }

  async function readExportScope(filePath) {
    if (readingExport || running) return { ok: false, error: 'Attendi il termine dell’operazione Kross in corso.' };
    readingExport = true;
    try { return await performExportScope(filePath); }
    finally { readingExport = false; }
  }

  async function performGoogleCheck() {
    try {
      const config = await configuration();
      const calendars = config.calendars.filter(item => item.type === 'google');
      if (!calendars.length) return googleStatus('configuration');
      for (const item of calendars) {
        if (typeof item.credentials !== 'string' || !item.credentials
          || !await regularFile(path.resolve(absoluteBase, item.credentials))) return googleStatus('configuration');
        if (typeof item.token !== 'string' || !item.token
          || !await regularFile(path.resolve(absoluteBase, item.token))) return googleStatus('auth');
      }
      const helper = path.join(__dirname, 'google-status.py');
      if (!codeDirectory || !await regularFile(path.join(codeDirectory, 'google_sheets.py'))
        || typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath) || !await regularFile(pythonPath)
        || !await regularFile(helper)) return googleStatus('runtime');
      let child;
      try {
        child = spawnImpl(pythonPath, ['-B', helper, '--engine-dir', codeDirectory,
          '--config', path.join(absoluteBase, 'config.json')], {
          cwd: absoluteBase, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { return googleStatus('runtime'); }
      const result = await new Promise(resolve => {
        let stdout = '', bytes = 0, settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } };
        const timeout = setTimeout(() => { child.kill?.(); finish(null); }, 45000);
        timeout.unref?.();
        child.stdout?.on('data', chunk => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 8192) { child.kill?.(); finish(null); return; }
          stdout += String(chunk);
        });
        child.stderr?.on('data', () => {}); // OAuth responses and local paths are never exposed.
        child.once('error', () => finish({ runtimeFailure: true }));
        child.once('close', code => {
          try { finish(code === 0 ? JSON.parse(stdout) : null); } catch { finish(null); }
        });
      });
      if (result?.runtimeFailure === true) return googleStatus('runtime');
      if (!result || !Object.hasOwn(GOOGLE_MESSAGES, result.reason)
        || !['verified', 'auth', 'configuration', 'network', 'permissions'].includes(result.reason)
        || result.status !== (result.reason === 'verified' ? 'connected' : result.reason === 'auth' ? 'disconnected' : 'unknown')) {
        return googleStatus('network');
      }
      return googleStatus(result.reason);
    } catch { return googleStatus('configuration'); }
  }

  async function checkGoogleConnection() {
    if (running) return googleStatus('busy');
    if (checkingGoogle) return checkingGoogle;
    checkingGoogle = performGoogleCheck();
    try { return await checkingGoogle; } finally { checkingGoogle = null; }
  }

  async function reportNames(directory) {
    try { return new Set((await fs.readdir(directory)).filter(name => /-(simulazione|importazione)\.json$/.test(name))); }
    catch { return new Set(); }
  }

  async function newReport(directory, previous, input, selection, dryRun, started, month) {
    const candidates = [...await reportNames(directory)].filter(name => !previous.has(name)).sort().reverse();
    for (const name of candidates) {
      try {
        const file = path.join(directory, name);
        const report = await readJson(file);
        if (typeof report.bookingFile !== 'string' || path.resolve(report.bookingFile) !== input
          || report.dryRun !== dryRun || (report.month ?? null) !== month || !Array.isArray(report.calendars)
          || !Number.isFinite(Date.parse(report.createdAt)) || Date.parse(report.createdAt) < started - 2000
          || report.calendars.length !== selection.length
          || new Set(report.calendars.map(item => item?.id)).size !== selection.length
          || report.calendars.some(item => !selection.some(calendar => calendar.id === item?.id))) continue;
        return { reportPath: file, report };
      } catch { /* A half-written or unrelated report is never treated as success. */ }
    }
    return { reportPath: null, report: null };
  }

  async function summarize(report, selection, config) {
    if (!report) return null;
    const summary = Object.fromEntries(COUNTERS.map(key => [key, 0]));
    summary.calendars = report.calendars.map(item => {
      const calendar = selection.find(value => value.id === item.id);
      const counts = {};
      for (const key of COUNTERS) {
        const value = item.summary?.[key];
        counts[key] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
        summary[key] = Math.min(Number.MAX_SAFE_INTEGER, summary[key] + counts[key]);
      }
      // Only explicit normalized conflict details below may expose related guests.
      const scopeDates=item.scope?.mode==='source_dates'&&Array.isArray(item.scope.dates)
        ?item.scope.dates.filter(date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)).slice(0,366):[];
      return { ...calendar, ...counts,...(item.scope?.mode==='source_dates'?{scopeDates}: {}) };
    });
    const local = path.resolve(absoluteBase, config.dataDirectory ?? '.local');
    const conflicted = selection.filter(calendar => report.calendars.some(item => item.id === calendar.id
      && Array.isArray(item.conflicts) && item.conflicts.length));
    const statesByCalendar = Object.create(null);
    const states = await Promise.allSettled(conflicted.map(calendar => readJson(path.join(local, `${calendar.id}.state.json`))));
    states.forEach((value, index) => { if (value.status === 'fulfilled') statesByCalendar[conflicted[index].id] = value.value; });
    summary.conflictDetails = describeKrossConflicts(report, selection, { statesByCalendar });
    if(report.scopeMode==='source_dates')summary.scopeMode='source_dates';
    return summary;
  }

  async function latestReport() {
    const missing = () => ({ ok: false, error: 'Nessun riepilogo Kross disponibile. Esegui prima una simulazione.' });
    try {
      const config = await configuration(), available = publicCalendars(config);
      const directory = path.join(path.resolve(absoluteBase, config.dataDirectory ?? '.local'), 'rapporti');
      const candidates = [...await reportNames(directory)].sort().reverse().slice(0, 50);
      let latest = null;
      for (const name of candidates) {
        try {
          const report = await readJson(path.join(directory, name));
          const timestamp = typeof report?.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(report.createdAt) ? Date.parse(report.createdAt) : NaN;
          if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300000 || typeof report.dryRun !== 'boolean'
            || typeof report.bookingFile !== 'string' || report.bookingFile.length > 4096 || report.bookingFile.includes('\0')
            || !path.isAbsolute(report.bookingFile) || !/\.xlsx$/i.test(report.bookingFile)
            || !Array.isArray(report.calendars) || !report.calendars.length || report.calendars.length > available.length
            || new Set(report.calendars.map(item => item?.id)).size !== report.calendars.length
            || report.calendars.some(item => !item || !available.some(calendar => calendar.id === item.id))
            || (report.month !== undefined && report.month !== null && (!validMonth(report.month)
              || report.calendars.some(item => available.find(calendar => calendar.id === item.id).year !== Number(report.month.slice(0, 4)))))) continue;
          if (!latest || timestamp > latest.timestamp) latest = { report, timestamp };
        } catch { /* Incomplete and unrelated local files are ignored. */ }
      }
      if (!latest) return missing();
      const { report, timestamp } = latest;
      const selection = available.filter(calendar => report.calendars.some(item => item.id === calendar.id));
      const summary = await summarize(report, selection, config);
      const hasConflicts = summary.conflicts > 0 || report.calendars.some(calendar => Array.isArray(calendar.conflicts) && calendar.conflicts.length);
      const completedAt = typeof report.completedAt === 'string' ? Date.parse(report.completedAt) : NaN;
      const completed = Number.isFinite(completedAt) && completedAt >= timestamp && completedAt <= Date.now() + 300000;
      const outcomeUnknown = !report.dryRun && !hasConflicts && !completed;
      const ok = !hasConflicts && !outcomeUnknown;
      const message = hasConflicts ? 'Importazione bloccata dai conflitti: nessun calendario modificato. Controlla i dettagli del riepilogo.'
        : outcomeUnknown ? 'Esito dell’aggiornamento non verificato: alcune modifiche potrebbero essere già state salvate. Controlla i calendari prima di riprovare.'
          : report.dryRun ? 'Simulazione salvata: nessun calendario modificato.' : 'Aggiornamento dei calendari completato.';
      return { ok, summary, dryRun: report.dryRun, month: validMonth(report.month) ? report.month : null, outcomeUnknown, checkedAt: new Date(timestamp).toISOString(),
        sourceFile: safeName(path.basename(report.bookingFile)), message };
    } catch { return missing(); }
  }

  async function run(input = {}, onProgress) {
    if (running) return resultFailure('Un aggiornamento Kross è già in corso.');
    if (readingExport) return resultFailure('Attendi la lettura dei mesi dell’Excel prima di aggiornare.');
    if (checkingGoogle) return resultFailure('Verifica Google in corso. Attendi il risultato prima di aggiornare.');
    running = true;
    const progress = (stage, message) => {
      try { if (typeof onProgress === 'function') onProgress({ stage, message }); } catch { /* UI callbacks cannot stop the engine. */ }
    };
    try {
      if (!input || typeof input !== 'object' || typeof input.filePath !== 'string'
        || !path.isAbsolute(input.filePath) || !/\.xlsx$/i.test(input.filePath)
        || input.filePath.includes('\0') || !await regularFile(input.filePath)) {
        return resultFailure('Seleziona un file Excel Kross .xlsx esistente.');
      }
      if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean'
        || input.overwriteManual !== undefined && typeof input.overwriteManual !== 'boolean') {
        return resultFailure('Le opzioni Kross non sono valide.');
      }
      const month = input.month ?? null;
      if (month !== null && !validMonth(month)) return resultFailure('Il filtro del mese deve avere il formato anno-mese.');
      let selectedYears;
      if (month) selectedYears = new Set([Number(month.slice(0, 4))]);
      else {
        const scope = await performExportScope(input.filePath);
        if (!scope.ok) return resultFailure(scope.error, { month: null });
        selectedYears = new Set(scope.months.map(item => Number(item.month.slice(0, 4))));
        if (!selectedYears.size) return resultFailure('L’Excel non contiene notti da aggiornare. Nessun calendario modificato.', { month: null });
      }
      const config = await configuration();
      const available = publicCalendars(config).filter(calendar => selectedYears.has(calendar.year));
      if (!Array.isArray(input.calendars) || !input.calendars.length
        || input.calendars.some(letter => typeof letter !== 'string' || !/^[a-zA-Z]$/.test(letter)
          || !available.some(calendar => calendar.initial === letter.toUpperCase()))) {
        return resultFailure('Scegli almeno uno dei calendari disponibili.');
      }
      const initials = [...new Set(input.calendars.map(letter => letter.toUpperCase()))];
      const selection = available.filter(calendar => initials.includes(calendar.initial));
      await ready({ ...config, calendars: config.calendars.filter(calendar => selection.some(selected => selected.id === calendar.id)) });
      const filePath = path.resolve(input.filePath);
      // Default to simulation if a caller omits the option.
      const dryRun = input.dryRun !== false;
      const overwriteManual = input.overwriteManual === true;
      const directory = path.join(path.resolve(absoluteBase, config.dataDirectory ?? '.local'), 'rapporti');
      const previous = await reportNames(directory);
      const started = Date.now();
      const args = [path.join(codeDirectory, 'aggiorna.mjs'), filePath,
        '--config', path.join(absoluteBase, 'config.json'), '--calendars', initials.join(',')];
      if (month) args.push('--month', month);
      if (dryRun) args.push('--dry-run');
      if (overwriteManual) args.push('--overwrite-manual');
      progress('starting', dryRun ? 'Avvio simulazione Kross.' : 'Avvio aggiornamento Kross.');
      let child;
      try {
        // Without a separate Node.js, Electron itself runs the engine (ELECTRON_RUN_AS_NODE).
        const runner = nodePath || process.execPath;
        const runAsNode = nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' };
        child = spawnImpl(runner, args, { cwd: absoluteBase, windowsHide: true, shell: false,
          stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...runAsNode, KROSS_PYTHON: pythonPath } });
      } catch {
        return resultFailure('Impossibile avviare il motore Kross.', { dryRun, month });
      }
      const status = await new Promise(resolve => {
        let settled = false;
        let buffer = '';
        const emitted = new Set();
        const once = (stage, message) => {
          if (!emitted.has(stage)) { emitted.add(stage); progress(stage, message); }
        };
        const line = text => {
          if (text.startsWith('Calendari selezionati:')) once('reading', 'Lettura del file Kross e dei calendari selezionati.');
          if (/\d+ celle da aggiornare\.$/.test(text)) once('planning', 'Piano delle modifiche in preparazione.');
          if (/^(Salvato:|Aggiornato Google Sheets:)/.test(text)) once('writing', 'Salvataggio dei calendari selezionati.');
        };
        child.stdout?.on('data', chunk => {
          // Raw output can include names, booking data and credential paths. Never forward or retain it.
          buffer += String(chunk);
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop().slice(-65536);
          for (const value of lines) line(value);
        });
        child.stderr?.on('data', () => {});
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        child.once('error', () => finish({ exitCode: null, signal: null, launchError: true }));
        child.once('close', (code, signal) => finish({ exitCode: code, signal, launchError: false }));
      });
      const { report, reportPath } = await newReport(directory, previous, filePath, selection, dryRun, started, month);
      const summary = await summarize(report, selection, config);
      const completed = !!report && (dryRun || Number.isFinite(Date.parse(report.completedAt)));
      const ok = status.exitCode === 0 && completed && !status.launchError;
      const conflict = status.exitCode === 2;
      const outcomeUnknown = !dryRun && !ok && !conflict && !status.launchError;
      let message;
      if (ok) message = dryRun ? 'Simulazione completata: nessun calendario modificato.' : 'Aggiornamento dei calendari completato.';
      else if (conflict) message = 'Importazione bloccata dai conflitti: nessun calendario modificato. Controlla il rapporto.';
      else if (outcomeUnknown) message = 'Aggiornamento interrotto: alcune modifiche potrebbero essere già state salvate. Controlla il rapporto prima di riprovare.';
      else message = 'Operazione Kross non completata. Controlla configurazione e collegamento Google.';
      progress('finished', message);
      return { ok, exitCode: status.exitCode, summary, reportPath, dryRun, month, outcomeUnknown, message, logs: [message] };
    } catch (error) {
      return resultFailure(error instanceof ConfigurationError ? error.message : 'Operazione Kross non disponibile.');
    } finally { running = false; }
  }

  return { inspect, run, checkGoogleConnection, latestReport, readExportScope };
}

module.exports = { createKrossAdapter };
