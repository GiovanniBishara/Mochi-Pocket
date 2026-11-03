'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const DELIVERY_OK = 'copia locale in Drive verificata; sincronizzazione cloud gestita da Drive';
const DOWNLOADS = new Set(['non dovuto', 'completato', 'incompleto', 'errore']);
const DELIVERIES = new Set([DELIVERY_OK, 'non controllata', 'in attesa o da verificare', 'in attesa']);
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// Keep diagnostics useful without returning paths, archive entries, credentials,
// receipt contents, or arbitrary text that a child process might print.
function safeError(value) {
  if (typeof value !== 'string') return 'Errore locale: controlla configurazione e cartelle.';
  const text = value.trim();
  if (/^Tabella errori non disponibile: eventuali esiti sconosciuti saranno segnalati\.$/.test(text)) {
    return 'Tabella errori non disponibile: eventuali esiti sconosciuti saranno segnalati.';
  }
  if (/^\d{4}-\d{2}-\d{2}: copia locale non valida o di altro account; conservata senza sovrascriverla\.$/.test(text)) {
    return 'Una copia locale non valida o di un altro account è stata conservata. Verifica l’archivio.';
  }
  const message = text.replace(/^\d{4}-\d{2}-\d{2}: /, '');
  if (/^\[Credenziali\] Configurazione assente o non leggibile da questo utente Windows\. Riesegui configura\.$/.test(message)) {
    return 'Credenziali assenti o non leggibili da questo utente Windows. Riesegui la configurazione.';
  }
  const code = message.match(/^\[(Autenticazione|Verifica accesso|Ricevuta|Tabella)\] Operazione non riuscita o esito assente\. Codice servizio: (\d{1,6}|non disponibile)\.$/);
  if (code) return `${code[1]} non riuscita. Codice servizio: ${code[2]}.`;
  if (/^\[(GenerateToken|Authentication_Test|Ricevuta|Tabella)\] Richiesta non completata: controllare connessione e disponibilita' del portale\.$/.test(message)) {
    return 'Richiesta non completata: controlla connessione e disponibilità di Alloggiati.';
  }
  if (/^\[(GenerateToken|Authentication_Test|Ricevuta|Tabella)\] (Il servizio ha restituito un errore SOAP\.|Formato della risposta inatteso\.|Il servizio non ha risposto con HTTP 200\.|Risposta XML non valida\. Nessun contenuto della risposta e' stato mostrato\.)$/.test(message)) {
    return 'Alloggiati ha restituito una risposta non valida. Riprova più tardi.';
  }
  if (/^\[PDF\] Tempo massimo di elaborazione superato\.$/.test(message)) {
    return 'Elaborazione PDF: tempo massimo superato.';
  }
  if (/^\[(PDF|Ricevuta)\]/.test(message)) return 'Impossibile verificare una ricevuta PDF. Controlla l’archivio.';
  return 'Errore locale: controlla configurazione, spazio disponibile e permessi delle cartelle.';
}

function safeProfile(profile, index) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const fallback = `Account ${index + 1}`;
  const label = typeof source.label === 'string' && source.label.length <= 96 &&
    !/[\x00-\x1f\x7f\\/:<>@]/.test(source.label) ? source.label.trim() || fallback : fallback;
  return {
    id: typeof source.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) ? source.id : `profilo-${index + 1}`,
    label,
    download: DOWNLOADS.has(source.download) ? source.download : 'non disponibile',
    delivery: DELIVERIES.has(source.delivery) ? source.delivery : 'non disponibile',
    newReceipts: count(source.newReceipts),
    newReceiptsAvailable: optionalCount(source.newReceipts) !== null &&
      ['completato', 'incompleto', 'errore'].includes(source.download),
    copiesWritten: optionalCount(source.archive?.written),
    missingDays: count(source.missingDays),
    pendingDelivery: source.pendingDelivery !== false,
    lastScanUtc: utc(source.lastScanUtc),
    nextScanUtc: utc(source.nextScanUtc),
    errors: Array.isArray(source.errors) ? source.errors.slice(0, 100).map(safeError) : [],
  };
}

function receiptSummary(profiles) {
  const accounts = profiles.map(profile => ({ id: profile.id, label: profile.label,
    downloaded: profile.newReceiptsAvailable ? profile.newReceipts : null,
    copied: profile.copiesWritten }));
  const total = key => {
    if (!accounts.length || accounts.some(profile => profile[key] === null)) return null;
    const value = accounts.reduce((sum, profile) => sum + profile[key], 0);
    return Number.isSafeInteger(value) ? value : null;
  };
  return { downloaded: total('downloaded'), copied: total('copied'), profiles: accounts };
}

function summaryMessage(summary) {
  const download = summary.downloaded === null ? 'Controllo completato.'
    : summary.downloaded === 0 ? 'Nessuna nuova ricevuta da scaricare.'
      : summary.downloaded === 1 ? 'Scaricata 1 nuova ricevuta.' : `Scaricate ${summary.downloaded} nuove ricevute.`;
  const copy = summary.copied === null ? '' : ` File copiati nelle cartelle: ${summary.copied}.`;
  const details = summary.profiles.slice(0, 6).map(profile => `${profile.label}: ${profile.downloaded === null
    ? 'conteggio non disponibile' : `${profile.downloaded} ${profile.downloaded === 1 ? 'nuova' : 'nuove'}`}`).join(' · ');
  return `${download}${copy}${details ? ' ' + details + '.' : ''}`;
}

function createAlloggiatiAdapter({ engineDir, stateRoot, powershellPath = 'powershell.exe', spawnImpl = spawn } = {}) {
  for (const [name, value] of Object.entries({ engineDir, stateRoot, powershellPath })) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} non valido.`);
  }
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl non valido.');
  engineDir = path.resolve(engineDir);
  stateRoot = path.resolve(stateRoot);
  const statusPath = path.join(stateRoot, 'stato.json');
  const configPath = path.join(stateRoot, 'config.json');
  const scriptPath = path.join(engineDir, 'esegui.ps1');
  let running = false;

  async function isFile(filePath) {
    try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
  }

  async function configuredFolders() {
    const folders = new Map();
    try {
      const stat = await fs.stat(configPath);
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return folders;
      const config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
      if (config?.version !== 1 || !Array.isArray(config.profiles) || config.profiles.length > 100) return folders;
      const seenIds = new Set();
      for (const profile of config.profiles) {
        const id = profile?.id;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue;
        if (seenIds.has(id)) { folders.delete(id); continue; }
        seenIds.add(id);
        const destination = profile.destination;
        if (typeof destination !== 'string' || !destination.trim() || /[\x00-\x1f\x7f]/.test(destination)
          || !path.isAbsolute(destination.trim())) continue;
        const label = safeProfile(profile, folders.size).label;
        folders.set(id, { path: path.resolve(destination.trim()), label });
      }
    } catch { /* Configuration contents, including runtime paths, remain private. */ }
    return folders;
  }

  async function receiptFolder(profileId) {
    if (typeof profileId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId)) return null;
    return (await configuredFolders()).get(profileId)?.path || null;
  }

  async function inspect() {
    // Only allowlisted profile labels and folder availability leave the private
    // configuration. DPAPI credentials and PDF/archive contents are never read.
    const configured = await isFile(configPath);
    const folders = await configuredFolders();
    const status = { configured, statusPath, checkedUtc: null, failures: 0, profiles: [], running, statusAvailable: false, errors: [] };
    try {
      const stat = await fs.stat(statusPath);
      if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) throw new Error('Invalid status');
      const parsed = JSON.parse((await fs.readFile(statusPath, 'utf8')).replace(/^\uFEFF/, ''));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.profiles)) throw new Error('Invalid status');
      status.checkedUtc = utc(parsed.checkedUtc);
      status.failures = count(parsed.failures);
      status.profiles = parsed.profiles.slice(0, 100).map(safeProfile);
      status.statusAvailable = true;
    } catch (error) {
      if (error.code !== 'ENOENT') status.errors.push('Il riepilogo Alloggiati non è leggibile. Apri il programma originale per verificarlo.');
    }
    if (!status.statusAvailable) status.profiles = [...folders].map(([id, folder], index) => safeProfile({ id, label: folder.label }, index));
    // The action is available when a destination is configured. The main process
    // checks that Drive is mounted when opening it; no folder is created here.
    for (const profile of status.profiles) profile.folderAvailable = folders.has(profile.id);
    return status;
  }

  async function lockAvailable() {
    let handle;
    try {
      // The engine keeps this file after exiting. Opening, rather than merely
      // checking existence, detects its Windows FileShare.None lock.
      handle = await fs.open(path.join(stateRoot, 'esecuzione.lock'), 'r+');
      return (await handle.stat()).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      return false;
    } finally {
      if (handle) await handle.close();
    }
  }

  async function run(options = {}, onProgress = () => {}) {
    const notify = message => { try { if (typeof onProgress === 'function') onProgress(message); } catch { /* UI failures must not interrupt the engine. */ } };
    const result = async (outcome, message, exitCode = null, ownsRun = true) => {
      const status = await inspect();
      if (ownsRun) status.running = false;
      return { ok: outcome === 'completed', outcome, message, exitCode, status, summary: null };
    };
    if (running) return result('alreadyRunning', 'Alloggiati è già in esecuzione. Attendi la fine del recupero.', null, false);
    running = true;
    try {
      const before = await inspect();
      const knownLabel = value => before.profiles.find(profile => profile.label === value)?.label || 'Appartamento';
      if (!before.configured) return await result('configMissing', 'Configura prima Alloggiati: esegui engines\\alloggiati\\configura.ps1 (vedi LEGGIMI).');
      if (!await isFile(scriptPath)) return await result('engineMissing', 'Il motore Alloggiati non è presente. Ripristina la cartella dell’app.');
      if (!await lockAvailable()) return await result('alreadyRunning', 'Alloggiati è già in esecuzione oppure il blocco non è accessibile. Attendi e riprova.');

      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-StateRoot', stateRoot];
      if (options.force !== false) args.push('-Force');
      const startedAt = Date.now();
      let sawSummary = false;
      let childFailed = false;
      let unknownErrorReported = false;
      notify('Avvio del recupero ricevute Alloggiati…');
      const consumeLine = (raw, isError) => {
        const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
        if (!line) return;
        const checking = line.match(/^(.+): controllo ricevute degli ultimi 30 giorni\.\.\.$/);
        if (checking) {
          notify(`${knownLabel(checking[1])}: controllo delle ricevute degli ultimi 30 giorni…`);
          return;
        }
        if (/^.+: nessun recupero dovuto\.$/.test(line)) {
          sawSummary = true;
          notify('Account verificato: nessun recupero dovuto.');
          return;
        }
        const summary = line.match(/^(.+): (completato|incompleto|errore|non dovuto); (.+)\.$/);
        if (summary && DELIVERIES.has(summary[3])) {
          sawSummary = true;
          notify(`${knownLabel(summary[1])}: recupero ${summary[2]}; ${summary[3]}.`);
          return;
        }
        if (line === 'Esegui prima la configurazione.' || line === 'Configurazione incompleta: riesegui configura.') {
          childFailed = true;
          notify('Configurazione Alloggiati incompleta. Riesegui la configurazione originale.');
          return;
        }
        if (/^\[/.test(line)) {
          childFailed = true;
          notify(safeError(line));
        } else if (isError && !unknownErrorReported) {
          childFailed = true;
          unknownErrorReported = true;
          notify('Il motore Alloggiati ha segnalato un errore locale. Controlla la configurazione.');
        }
      };

      const exit = await new Promise(resolve => {
        let child;
        try {
          child = spawnImpl(powershellPath, args, { cwd: engineDir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch { resolve({ code: null, failed: true }); return; }
        for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
          if (!stream || typeof stream.on !== 'function') continue;
          const decoder = new StringDecoder('utf8');
          let remainder = '';
          let discarding = false;
          const feed = text => {
            const pieces = (remainder + text).split(/\r?\n/);
            remainder = pieces.pop();
            for (const piece of pieces) {
              if (!discarding && piece.length <= 8192) consumeLine(piece, isError);
              discarding = false;
            }
            if (remainder.length > 8192) { remainder = ''; discarding = true; }
          };
          stream.on('data', chunk => feed(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)));
          stream.on('end', () => { feed(decoder.end()); if (!discarding && remainder) consumeLine(remainder, isError); remainder = ''; });
        }
        child.once('error', () => resolve({ code: null, failed: true }));
        child.once('close', (code, signal) => resolve({ code, failed: !!signal }));
      });

      const after = await inspect();
      const updated = after.statusAvailable && after.checkedUtc !== before.checkedUtc &&
        after.checkedUtc !== null && Date.parse(after.checkedUtc) >= startedAt - 1000;
      const summary = updated && sawSummary ? receiptSummary(after.profiles) : null;
      let outcome;
      let message;
      if (exit.failed || exit.code !== 0 || childFailed) {
        outcome = 'failed';
        message = 'Recupero Alloggiati non completato. Controlla gli esiti degli account e la configurazione.';
      } else if (!sawSummary || !updated) {
        outcome = 'alreadyRunning';
        message = 'Nessun nuovo esito confermato: Alloggiati potrebbe essere già in esecuzione. Aggiorna lo stato tra poco.';
      } else if (after.failures !== 0 || after.profiles.length === 0 || after.profiles.some(profile =>
        !['completato', 'non dovuto'].includes(profile.download) || profile.pendingDelivery || profile.delivery !== DELIVERY_OK)) {
        outcome = 'failed';
        message = 'Il controllo è terminato con operazioni incomplete. Verifica gli esiti degli account.';
      } else {
        outcome = 'completed';
        message = summary ? summaryMessage(summary) : 'Recupero completato; copia locale in Drive verificata. La sincronizzazione cloud è gestita da Drive.';
      }
      notify(message);
      after.running = false;
      return { ok: outcome === 'completed', outcome, message, exitCode: Number.isInteger(exit.code) ? exit.code : null, status: after, summary };
    } finally {
      running = false;
    }
  }

  return { inspect, run, receiptFolder };
}

module.exports = { createAlloggiatiAdapter };
