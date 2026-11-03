import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { selectCalendars, calendarSelectionLegend } from './calendar_selection.mjs';
import { collectSourceDates, collectHighlightBookingIds, planScopedCalendar, validateImportMonth } from './import_scope.mjs';
import { prepareConfirmedCancellations } from './cancellation_updates.mjs';
import cancellationRegistry from './cancellation_registry.cjs';
import { writeCalendar } from './write_calendar.mjs';
import { pythonExecutable } from './runtime.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const arguments_ = process.argv.slice(2);
const option = flag => {
  const index = arguments_.indexOf(flag);
  if (index === -1) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Manca il valore di ${flag}.`);
  return value;
};
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const emptyState = () => ({ version: 1, bindings: {} });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}
function python(script, args) {
  const result = spawnSync(pythonExecutable, [path.join(directory, script), ...args],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 15 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = new Error(result.error?.message ?? result.stderr.trim() ?? 'Operazione Python fallita.');
    error.outcomeUnknown = result.status === 3;
    throw error;
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error(`Risposta non valida da ${script}.`); }
}
function googleArgs(calendar, base) {
  if (!calendar.credentials) throw new Error(`${calendar.name}: manca credentials nella configurazione Google.`);
  return ['--spreadsheet', calendar.spreadsheet, '--sheet', calendar.sheetName,
    '--credentials', path.resolve(base, calendar.credentials),
    ...(calendar.idColumn ? ['--id-column', calendar.idColumn] : []),
    ...(calendar.token ? ['--token', path.resolve(base, calendar.token)] : [])];
}
const detailColumns = new Set(['D', 'J', 'K']);
const typedValue = value => value === null || typeof value === 'string'
  || (typeof value === 'number' && Number.isFinite(value));
const displayValue = value => value === null || value === undefined || value === '' ? '(vuoto)' : String(value);
const validIsoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value;
};
async function snapshot(calendar, base, bookingFile, scopeDates) {
  if (calendar.type === 'google') {
    return python('google_sheets.py', ['read', ...googleArgs(calendar, base),
      '--scope-dates', scopeDates.join(',')]);
  }
  const destination = path.resolve(base, calendar.file);
  const source = await exists(destination) ? destination : calendar.initialFile && path.resolve(base, calendar.initialFile);
  if (!source || !await exists(source)) throw new Error(`${calendar.name}: calendario Excel non trovato.`);
  const sourceHash = await hash(source);
  const read = python('read_workbooks.py', ['--bookings', bookingFile, '--calendar', source, '--sheet', calendar.sheetName,
    ...(calendar.idColumn ? ['--id-column', calendar.idColumn] : [])]);
  if (await hash(source) !== sourceHash) throw new Error(`${calendar.name}: il file è cambiato durante la lettura. Riprova.`);
  return { ...read, source, destination, sourceHash };
}
function identity(calendar, base, includeIdColumn = true) {
  return JSON.stringify({ type: calendar.type, target: calendar.type === 'google' ? calendar.spreadsheet : path.resolve(base, calendar.file),
    sheetName: calendar.sheetName, roomName: calendar.roomName,
    ...(includeIdColumn && calendar.idColumn ? { idColumn: calendar.idColumn } : {}) });
}
async function saveState(file, target, planner) {
  await atomicJson(file, { version: 1, target, planner });
}
async function recover(journalFile, stateFile, target, rows, idColumn, bookingDetails = false) {
  if (!await exists(journalFile)) return;
  const pending = await json(journalFile);
  if (pending.target !== target) throw new Error('Configurazione diversa da quella di un aggiornamento da recuperare.');
  const allowedColumns = new Set(['C', idColumn, ...(bookingDetails ? detailColumns : [])].filter(Boolean));
  if (!Array.isArray(pending.patches) || pending.patches.some(p => !p || !allowedColumns.has(p.column)
    || !Number.isInteger(p.row) || p.row < 1 || !typedValue(p.before) || !typedValue(p.after)
    || ((!bookingDetails || !detailColumns.has(p.column)) && (typeof p.before !== 'string' || typeof p.after !== 'string'))
    || (idColumn && (typeof p.expectedGuest !== 'string' || typeof p.expectedId !== 'string'
      || (p.column === 'C' && p.before !== p.expectedGuest)
      || (p.column === idColumn && p.before !== p.expectedId))))) {
    throw new Error('Il piano da recuperare contiene celle o colonne non valide.');
  }
  const byDate = new Map(rows.map(row => [row.date, row]));
  const groups = new Map();
  for (const patch of pending.patches) {
    const group = groups.get(patch.row) ?? { date: patch.date, expectedGuest: patch.expectedGuest,
      expectedId: patch.expectedId, cells: new Map() };
    if (group.date !== patch.date || group.cells.has(patch.column)
      || (idColumn && (group.expectedGuest !== patch.expectedGuest || group.expectedId !== patch.expectedId))) {
      throw new Error('Il piano da recuperare contiene celle duplicate o controlli incoerenti.');
    }
    group.cells.set(patch.column, patch);
    groups.set(patch.row, group);
  }
  const matches = key => pending.patches.every(p => {
    const row = byDate.get(p.date);
    if (idColumn) {
      const group = groups.get(p.row);
      const guest = key === 'after' ? group.cells.get('C')?.after ?? group.expectedGuest : group.expectedGuest;
      const id = key === 'after' ? group.cells.get(idColumn)?.after ?? group.expectedId : group.expectedId;
      return row?.row === p.row && !row.guestFormula && !row.idFormula
        && row.guest === guest && (row.krossId ?? '') === id
        && [...group.cells.values()].filter(cell => bookingDetails && detailColumns.has(cell.column)).every(cell =>
          row.cells?.[cell.column] && !row.cells[cell.column].formula
          && row.cells[cell.column].value === cell[key]);
    }
    return row?.row === p.row && (p.column === 'C'
      ? !row.guestFormula && row.guest === p[key]
      : !row.idFormula && (row.krossId ?? '') === p[key]);
  });
  if (matches('after')) {
    await saveState(stateFile, target, pending.nextState);
    console.log('Completato il registro di un aggiornamento già eseguito.');
  } else if (!matches('before')) {
    throw new Error(`Aggiornamento interrotto con celle diverse dal piano. Controlla ${journalFile} prima di continuare.`);
  }
  await fs.unlink(journalFile);
}

async function askCalendarSelection(calendars) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const lines = terminal[Symbol.asyncIterator]();
  try {
    console.log('\nVuoi modificarli tutti o solo alcuni?');
    console.log(calendarSelectionLegend(calendars));
    console.log('Scrivi TUTTI oppure le iniziali separate da una virgola (esempio: T,B).');
    while (true) {
      process.stdout.write('Selezione (Invio = tutti): ');
      const answer = await lines.next();
      if (answer.done) throw new Error('Selezione annullata: nessun calendario modificato.');
      try { return selectCalendars(calendars, answer.value); }
      catch (error) { console.log(`\n${error.message} Riprova.`); }
    }
  } finally { terminal.close(); }
}

async function main() {
  if (arguments_.includes('--help') || !arguments_.length) {
    console.log('Uso: aggiorna.mjs FILE_KROSS.xlsx [--config FILE.json] [--dry-run] [--overwrite-manual] [--calendars T,B | --ask-calendars] [--preview FILE.png]\n'
      + 'Aggiorna gli ospiti (C) e la colonna ID Kross se configurata, escludendo il giorno del check-out.\n'
      + '--dry-run mostra il piano senza modificare calendari o registri.\n'
      + '--overwrite-manual ripristina da Kross le celle gia gestite, mantenendo protette formule e altri ID.\n'
      + '--calendars seleziona le iniziali, senza distinzione maiuscole/minuscole; senza selezione usa tutti.\n'
      + '--ask-calendars chiede quali calendari aggiornare prima di iniziare.');
    return;
  }
  const configFile = path.resolve(option('--config') ?? path.join(directory, '..', 'config.json'));
  const base = path.dirname(configFile);
  const known = new Set(['--config', '--preview', '--dry-run', '--overwrite-manual', '--calendars', '--ask-calendars', '--month', '--help']);
  const positional = [];
  for (let index = 0; index < arguments_.length; index++) {
    const arg = arguments_[index];
    if (arg === '--config' || arg === '--preview' || arg === '--calendars' || arg === '--month') { index++; continue; }
    if (known.has(arg)) continue;
    if (arg.startsWith('--')) throw new Error(`Opzione sconosciuta: ${arg}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('Passa un solo file esportato da Kross.');
  const bookingFile = path.resolve(positional[0]);
  if (!/\.xlsx$/i.test(bookingFile) || !await exists(bookingFile)) throw new Error('File Kross .xlsx non trovato.');
  const dryRun = arguments_.includes('--dry-run');
  const overwriteManualEdits = arguments_.includes('--overwrite-manual');
  const month = option('--month');
  if (month !== null) validateImportMonth(month);
  const calendarSelection = option('--calendars');
  const askCalendars = arguments_.includes('--ask-calendars');
  if (askCalendars && calendarSelection !== null) throw new Error('Usa --calendars oppure --ask-calendars, non entrambi.');
  const config = await json(configFile);
  if (config.version !== 1 || !Array.isArray(config.calendars) || !config.calendars.length) throw new Error('Configurazione calendari non valida.');
  const ids = new Set(), targets = new Set();
  for (const calendar of config.calendars) {
    // This choice belongs to this invocation, never to the saved configuration.
    calendar.overwriteManualEdits = overwriteManualEdits;
    if (typeof calendar.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(calendar.id) || ids.has(calendar.id.toLowerCase())
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(calendar.id)) throw new Error('ID calendario mancante, duplicato o non valido.');
    if (!['excel', 'google'].includes(calendar.type) || typeof calendar.roomName !== 'string' || !calendar.roomName.trim()
      || typeof calendar.sheetName !== 'string' || !/^\d{4}$/.test(calendar.sheetName)) throw new Error('Tipo, camera Kross o anno calendario non validi.');
    if ((calendar.type === 'excel' && typeof calendar.file !== 'string') || (calendar.type === 'google' && typeof calendar.spreadsheet !== 'string')) throw new Error('Destinazione calendario mancante.');
    if (calendar.idColumn !== undefined) {
      if (typeof calendar.idColumn !== 'string') throw new Error('Colonna ID Kross non valida.');
      calendar.idColumn = calendar.idColumn.trim().toUpperCase();
      const index = [...calendar.idColumn].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      if (!/^[A-Z]{1,3}$/.test(calendar.idColumn) || index < 4 || index > 16384) {
        throw new Error('La colonna ID Kross deve essere compresa tra D e XFD.');
      }
    }
    if (calendar.highlightBookings !== undefined && typeof calendar.highlightBookings !== 'boolean') {
      throw new Error('highlightBookings deve essere true o false.');
    }
    if (calendar.highlightBookings && (calendar.type !== 'google' || !calendar.idColumn)) {
      throw new Error('Il giallo automatico richiede un calendario Google con la colonna ID configurata.');
    }
    if (calendar.bookingDetails !== undefined && (calendar.type !== 'google' || calendar.idColumn !== 'S'
      || !calendar.bookingDetails || typeof calendar.bookingDetails !== 'object'
      || Array.isArray(calendar.bookingDetails)
      || !validIsoDate(calendar.bookingDetails.fromDate)
      || (calendar.bookingDetails.fillMissing !== undefined && typeof calendar.bookingDetails.fillMissing !== 'boolean')
      || !Number.isFinite(calendar.bookingDetails.cleaningFee) || calendar.bookingDetails.cleaningFee < 0)) {
      throw new Error('I dettagli richiedono Google, ID in S, una data di inizio ISO e un costo pulizia non negativo.');
    }
    const target = identity(calendar, base);
    const destinationKey = JSON.stringify({ type: calendar.type, file: calendar.type === 'excel' ? path.resolve(base, calendar.file).toLowerCase() : calendar.spreadsheet, sheet: calendar.sheetName });
    if (targets.has(destinationKey)) throw new Error('La stessa destinazione compare due volte nella configurazione.');
    ids.add(calendar.id.toLowerCase()); targets.add(destinationKey);
  }
  let activeCalendars = askCalendars
    ? await askCalendarSelection(config.calendars)
    : selectCalendars(config.calendars, calendarSelection);
  const local = path.resolve(base, config.dataDirectory ?? '.local');
  await fs.mkdir(local, { recursive: true });
  const lockFile = path.join(local, 'aggiornamento.lock');
  let lock;
  try {
    console.log(`Calendari selezionati: ${calendarSelectionLegend(activeCalendars)}.`);
    lock = await fs.open(lockFile, 'wx');
  } catch {
    let lockData;
    try { lockData = await json(lockFile); } catch {
      throw new Error(`Registro di blocco incompleto: ${lockFile}. Dopo aver chiuso le altre importazioni, elimina questo file e riprova.`);
    }
    if (!Number.isInteger(lockData.pid) || lockData.pid < 1) throw new Error(`Registro di blocco non valido: ${lockFile}.`);
    let running = true;
    try { process.kill(lockData.pid, 0); } catch (error) { running = error.code !== 'ESRCH'; }
    if (running) throw new Error('Un altro aggiornamento è in corso.');
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, 'wx');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  try {
    console.log(overwriteManualEdits
      ? 'Modifiche manuali: ripristino da Kross abilitato sulle celle gia gestite.'
      : 'Modifiche manuali: protette; eventuali conflitti bloccano l\'importazione.');
    const inputHash = await hash(bookingFile);
    const source = python('read_workbooks.py', ['--bookings', bookingFile, '--bookings-only']);
    const sourceYears = new Set();
    for (const booking of source.bookings) {
      const first = Number(booking.checkIn?.slice(0, 4));
      const end = Date.parse(`${booking.checkOut}T00:00:00.000Z`) - 86400000;
      const last = Number.isFinite(end) ? new Date(end).getUTCFullYear() : NaN;
      if (Number.isInteger(first) && Number.isInteger(last)) for (let year = first; year <= last; year++) sourceYears.add(String(year));
    }
    activeCalendars = activeCalendars.filter(calendar => month ? calendar.sheetName === month.slice(0, 4) : sourceYears.has(calendar.sheetName));
    if (!activeCalendars.length) throw new Error('Nessun calendario corrisponde alle date dell’Excel.');
    const cancellations = cancellationRegistry.createCancellationRegistry({filePath:path.join(local,'annullamenti.json')});
    const cancellationEntries = await cancellations.list();
    // A future export may span more than one annual tab. Never silently lose
    // confirmed nights from the requested period because an annual tab is absent.
    const roomsWithDetails = new Map(activeCalendars.filter(calendar => calendar.bookingDetails)
      .map(calendar => [calendar.roomName, calendar.bookingDetails.fromDate]));
    for (const booking of source.bookings) {
      const fromDate = roomsWithDetails.get(booking.room);
      if (!fromDate || String(booking.status ?? '').trim().toLowerCase() !== 'confermata' || booking.checkOut <= fromDate) continue;
      const configuredYears = new Set(activeCalendars.filter(calendar => calendar.roomName === booking.room)
        .map(calendar => Number(calendar.sheetName)));
      const firstYear = Number((booking.checkIn < fromDate ? fromDate : booking.checkIn).slice(0, 4));
      const lastNight = new Date(Date.parse(`${booking.checkOut}T00:00:00.000Z`) - 86400000).toISOString();
      const lastYear = Number(lastNight.slice(0, 4));
      for (let year = firstYear; year <= lastYear; year++) {
        if (month && String(year) !== month.slice(0, 4)) continue;
        if (!configuredYears.has(year)) throw new Error(`Manca il calendario ${year} configurato per ${booking.room}. `
          + 'Prepara la scheda annuale e aggiungila alla configurazione prima di importare queste notti.');
      }
    }
    const items = [];
    for (const calendar of activeCalendars) {
      const target = identity(calendar, base);
      const stateFile = path.join(local, `${calendar.id}.state.json`);
      const journalFile = path.join(local, `${calendar.id}.pending.json`);
      const highlightStateFile = path.join(local, `${calendar.id}.highlight.json`);
      const scopeDates = collectSourceDates(source.bookings, calendar, {month:month??undefined});
      const highlightBookingIds = collectHighlightBookingIds(source.bookings, calendar, {month:month??undefined});
      const read = await snapshot(calendar, base, bookingFile, scopeDates);
      if (!dryRun) {
        if (await exists(journalFile)) {
          const pending = await json(journalFile);
          if (!Array.isArray(pending.scopeDates) || JSON.stringify(pending.scopeDates) !== JSON.stringify(scopeDates)
              || !Array.isArray(pending.patches) || pending.patches.some(patch => !scopeDates.includes(patch.date))) {
            throw new Error('Un aggiornamento interrotto ha un ambito diverso o non verificabile. Riprendere il file originale prima di usare un altro Excel.');
          }
        }
        await recover(journalFile, stateFile, target, read.calendar, calendar.idColumn, !!calendar.bookingDetails);
      }
      else if (await exists(journalFile)) throw new Error('Esiste un aggiornamento da recuperare. Avvia senza --dry-run prima di simulare.');
      const state = await exists(stateFile) ? await json(stateFile) : null;
      const upgradingLegacyState = calendar.idColumn && state?.target === identity(calendar, base, false);
      if (state && (state.version !== 1 || (state.target !== target && !upgradingLegacyState))) {
        throw new Error(`${calendar.name}: registro riferito a un calendario o una camera diversa.`);
      }
      const previousPlanner = state?.planner ?? emptyState();
      const confirmedCancellations = prepareConfirmedCancellations(source.bookings, previousPlanner, calendar,
        cancellationEntries, scopeDates);
      const plan = planScopedCalendar(confirmedCancellations.bookings, read.calendar, previousPlanner, calendar,
        {month:month??undefined,dates:scopeDates});
      plan.conflicts.push(...confirmedCancellations.conflicts);
      plan.warnings.push(...confirmedCancellations.warnings);
      // An untracked manual stay with different dates has no proven ownership
      // to edit. The planner already skipped it; preserve it and import the
      // remaining bookings unless a separate ownership/structural conflict exists.
      const preservedManualStays = plan.conflicts.filter(conflict => conflict.type === 'manual_stay_dates_differ');
      plan.conflicts = plan.conflicts.filter(conflict => conflict.type !== 'manual_stay_dates_differ');
      plan.warnings.push(...preservedManualStays.map(conflict => ({ ...conflict,
        type: 'manual_stay_preserved',
        message: `Prenotazione manuale ${conflict.reference ?? conflict.bookingId} lasciata invariata: `
          + 'le date del calendario differiscono da Kross. Le altre prenotazioni possono essere importate.',
      })));
      const details = {summary:plan.detailSummary??plan.summary.details??{added:0,updated:0,patches:0},
        patches:plan.patches.filter(patch=>detailColumns.has(patch.column))};
      plan.patches.sort((a, b) => a.row - b.row || a.column.localeCompare(b.column));
      if (plan.patches.some(patch => !scopeDates.includes(patch.date)
          || !new Set(['C',calendar.idColumn,...(calendar.bookingDetails?['D','J','K']:[])]).has(patch.column))) {
        throw new Error('Il piano contiene modifiche fuori dalle date dell’Excel: nessuna scrittura consentita.');
      }
      plan.summary.patches = plan.patches.length;
      plan.summary.conflicts = plan.conflicts.length;
      if (calendar.bookingDetails) plan.summary.details = details.summary;
      const warnings = [...(source.structuralWarnings ?? []), ...(read.structuralWarnings ?? []), ...plan.warnings];
      plan.summary.warnings = warnings.length;
      const highlight = calendar.highlightBookings && scopeDates.length
        ? python('google_sheets.py', ['highlight-preview', ...googleArgs(calendar, base),
          '--highlight-state', highlightStateFile,'--scope-dates',scopeDates.join(','),
          '--eligible-booking-ids',highlightBookingIds.join(',')]) : null;
      console.log(`\n${calendar.name}: ${plan.summary.added} nuove, ${plan.summary.adopted} già presenti, ${plan.summary.updated} modificate, ${plan.summary.cancelled} cancellate; ${plan.patches.length} celle da aggiornare.`);
      if (calendar.bookingDetails) console.log(`  Dettagli: ${details.summary.added} nuove compilazioni, `
        + `${details.summary.updated} aggiornamenti; ${details.patches.length} celle di importo, descrizione e pulizia.`);
      for (const patch of plan.patches) console.log(`  ${patch.date}, ${patch.column}${patch.row}: ${displayValue(patch.before)} -> ${displayValue(patch.after)}`);
      for (const warning of warnings) console.log(`  Avviso: ${typeof warning === 'string' ? warning : warning.message}`);
      for (const conflict of plan.conflicts) console.log(`  Conflitto: ${conflict.message} ${conflict.dates?.join(', ') ?? ''}`);
      if (highlight) console.log(`  Giallo C:L modificabile: ${highlight.needed ? 'da aggiornare' : 'aggiornato'}; i colori manuali vengono conservati.`);
      items.push({ calendar, target, stateFile, journalFile, highlightStateFile, read, plan, warnings, highlight, scopeDates, highlightBookingIds,
        confirmedCancellations:confirmedCancellations.applied });
    }
    if (await hash(bookingFile) !== inputHash) throw new Error('Il file Kross è cambiato durante la lettura. Riprova.');
    if (JSON.stringify(await cancellations.list()) !== JSON.stringify(cancellationEntries)) throw new Error('Le conferme delle cancellazioni sono cambiate: ripetere il controllo.');
    const report = { createdAt: new Date().toISOString(), dryRun, month, scopeMode:'source_dates', overwriteManualEdits, bookingFile,
      calendars: items.map(({ calendar, plan, warnings, highlight, read, scopeDates }) => ({ name: calendar.name, id: calendar.id,
        scope:{mode:'source_dates',dates:scopeDates},
        summary: plan.summary, patches: plan.patches, conflicts: plan.conflicts.map(conflict => {
          const dates = new Set([...(Array.isArray(conflict.dates) ? conflict.dates : []),
            ...(typeof conflict.date === 'string' ? [conflict.date] : []),
            ...(Array.isArray(conflict.cells) ? conflict.cells.map(cell => cell.date) : [])]);
          const columns = typeof conflict.column === 'string' ? [conflict.column]
            : ['C', ...(calendar.idColumn ? [calendar.idColumn] : [])];
          return { ...conflict, locations: read.calendar.filter(row => dates.has(row.date)).slice(0, 100)
            .flatMap(row => columns.map(column => ({ date: row.date, row: row.row, column,
              guest: row.guest, krossId: row.krossId }))) };
        }), warnings,
        ...(highlight ? { highlight } : {}) })) };
    const reportFile = path.join(local, 'rapporti', `${stamp()}-${dryRun ? 'simulazione' : 'importazione'}.json`);
    await atomicJson(reportFile, report);
    if (items.some(item => item.plan.conflicts.length)) {
      console.log(`\nNessun calendario modificato. Conflitti nel rapporto: ${reportFile}`);
      process.exitCode = 2;
      return;
    }
    if (dryRun) { console.log('\nSimulazione completata: nessun calendario modificato.'); return; }
    const expectedFiles = new Map();
    for (const item of items.filter(item => item.calendar.type === 'excel')) {
      const key = item.read.destination.toLowerCase();
      if (expectedFiles.has(key) && expectedFiles.get(key) !== item.read.sourceHash) {
        throw new Error('Due fogli dello stesso file partono da calendari diversi. Controlla initialFile.');
      }
      expectedFiles.set(key, item.read.sourceHash);
    }
    for (const item of items) {
      const { calendar, read, plan, target, stateFile, journalFile } = item;
      if (calendar.type === 'excel') {
        await fs.mkdir(path.dirname(read.destination), { recursive: true });
        const currentSource = await exists(read.destination) ? read.destination : read.source;
        const expectedHash = expectedFiles.get(read.destination.toLowerCase());
        if (await hash(currentSource) !== expectedHash) throw new Error(`${calendar.name}: il calendario è cambiato. Rilancia l'importazione.`);
        if (plan.patches.length || !await exists(read.destination)) {
          const temporary = `${read.destination}.${process.pid}.tmp.xlsx`;
          try {
            await writeCalendar(currentSource, temporary, calendar.sheetName, plan.patches,
              { preview: option('--preview') ? path.resolve(option('--preview')) : undefined,
                idColumn: calendar.idColumn });
            if (await hash(currentSource) !== expectedHash) throw new Error(`${calendar.name}: il calendario è cambiato durante la preparazione.`);
            const backup = path.join(local, 'backup', `${calendar.id}-${stamp()}.xlsx`);
            await fs.mkdir(path.dirname(backup), { recursive: true });
            await fs.copyFile(currentSource, backup);
            await atomicJson(journalFile, { target, scopeDates:item.scopeDates, patches: plan.patches, nextState: plan.nextState });
            const committedHash = await hash(temporary);
            await fs.rename(temporary, read.destination);
            expectedFiles.set(read.destination.toLowerCase(), committedHash);
          } finally { await fs.rm(temporary, { force: true }); }
        }
      } else if (plan.patches.length) {
        await atomicJson(journalFile, { target, scopeDates:item.scopeDates, patches: plan.patches, nextState: plan.nextState });
        python('google_sheets.py', ['write', ...googleArgs(calendar, base), '--patches', journalFile,
          ...(calendar.bookingDetails ? ['--booking-details'] : [])]);
      }
      await saveState(stateFile, target, plan.nextState);
      if (await exists(journalFile)) await fs.unlink(journalFile);
      console.log(calendar.type === 'excel' ? `Salvato: ${read.destination}` : `Aggiornato Google Sheets: ${calendar.name}`);
    }
    for (const item of items) for (const entry of item.confirmedCancellations) {
      if (!Object.hasOwn(item.plan.nextState.bindings,entry.bookingId)) await cancellations.markReleased({
        calendarId:entry.calendarId,bookingId:entry.bookingId,revision:entry.revision,confirmed:true});
    }
    // Formatting is a separate, repeatable step. Committed guest/ID registries
    // remain valid if a temporary formatting error requires another run.
    for (const { calendar, highlight, highlightStateFile, scopeDates, highlightBookingIds } of items) {
      if (!highlight) continue;
      try {
        const result = python('google_sheets.py', ['highlight', ...googleArgs(calendar, base),
          '--highlight-state', highlightStateFile,'--scope-dates',scopeDates.join(','),
          '--eligible-booking-ids',highlightBookingIds.join(',')]);
        report.calendars.find(item => item.id === calendar.id).highlight = result;
        console.log(`Giallo C:L modificabile aggiornato: ${calendar.name}; colori manuali conservati.`);
      } catch (error) {
        throw new Error(`Prenotazioni e ID salvati; giallo C:L non verificato per ${calendar.name}. `
          + `Rilancia lo stesso file per completare la formattazione. ${error.message}`);
      }
    }
    report.completedAt = new Date().toISOString();
    await atomicJson(reportFile, report);
    console.log(`\nAggiornamento completato. Rapporto: ${reportFile}`);
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}

main().catch(error => { console.error(`\nErrore: ${error.message}`); process.exitCode = 1; });
