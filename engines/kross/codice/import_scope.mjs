/** Import planning restricted to dates in the source. No files or API calls. */
import { planCalendar } from './planner.mjs';
import { planBookingDetails } from './booking_details.mjs';

const DAY_MS = 86400000;
const clone = value => JSON.parse(JSON.stringify(value));
const string = value => value == null ? '' : String(value);
const normalize = value => string(value).normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
const nameKey = value => normalize(value).match(/[\p{L}\p{N}]+/gu)?.sort().join('\u0000') ?? '';
const put = (object, key, value) => Object.defineProperty(object, key,
  { value, enumerable: true, writable: true, configurable: true });
const iso = milliseconds => new Date(milliseconds).toISOString().slice(0, 10);

function dateMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const result = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(result) && iso(result) === value ? result : null;
}

export function validateImportMonth(month) {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('Scegli il mese da importare nel formato AAAA-MM.');
  }
  const start = month + '-01', startMs = dateMilliseconds(start);
  const endMs = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
  return { month, year: month.slice(0, 4), start, endExclusive: iso(endMs), startMs, endMs };
}

function bookingDates(booking, year) {
  const start = dateMilliseconds(booking?.checkIn), end = dateMilliseconds(booking?.checkOut);
  if (start === null || end === null || end <= start || (end - start) / DAY_MS > 3660) return null;
  const yearStart = dateMilliseconds(`${year}-01-01`), yearEnd = Date.UTC(Number(year) + 1, 0, 1);
  const dates = [];
  for (let day = Math.max(start, yearStart); day < Math.min(end, yearEnd); day += DAY_MS) dates.push(iso(day));
  return dates;
}

export function collectSourceDates(bookings, config, { month } = {}) {
  if (!Array.isArray(bookings) || typeof config?.sheetName !== 'string' || !/^\d{4}$/.test(config.sheetName)) {
    throw new Error('Prenotazioni o anno del calendario non validi.');
  }
  if (month !== undefined && validateImportMonth(month).year !== config.sheetName) {
    throw new Error('Il mese scelto non appartiene all’anno del calendario.');
  }
  return [...new Set(bookings.filter(booking => booking?.room === config.roomName)
    .flatMap(booking => bookingDates(booking, config.sheetName) ?? [])
    .filter(date => month === undefined || date.startsWith(month + '-')))].sort();
}

export function collectHighlightBookingIds(bookings, config, { month } = {}) {
  const dates = new Set(collectSourceDates(bookings, config, { month }));
  const channels = new Set(['booking', 'booking.com', 'airbnb', 'airbnb.com']);
  return [...new Set(bookings.filter(booking => booking?.room === config.roomName
      && normalize(booking.status) === 'confermata' && channels.has(normalize(booking.channel))
      && bookingDates(booking, config.sheetName)?.some(date => dates.has(date)))
    .map(booking => string(booking.id).trim()).filter(Boolean))].sort();
}

/**
 * The annual registry still describes the cells actually on the calendar.
 * Only source-footprint C/ID and D/J/K anchors are planned. An explicit dates
 * array must be collected BEFORE injecting cancellation overrides; neither
 * registry dates nor a previous binding can expand the import footprint.
 */
export function planScopedCalendar(bookings, calendar, previousState, config, { month, dates: explicitDates } = {}) {
  if (!Array.isArray(bookings) || !Array.isArray(calendar)) throw new Error('Prenotazioni e calendario devono essere array.');
  const year = config?.sheetName;
  if (typeof year !== 'string' || !/^\d{4}$/.test(year) || Number(year) < 1) throw new Error('Anno del calendario non valido.');
  if (explicitDates !== undefined && !Array.isArray(explicitDates)) throw new Error('Le date dell’importazione devono essere un elenco ISO.');
  const scopeDates = explicitDates === undefined ? collectSourceDates(bookings, config, { month }) : [...explicitDates];
  if (!Array.isArray(explicitDates ?? scopeDates) || new Set(scopeDates).size !== scopeDates.length
      || scopeDates.some(date => dateMilliseconds(date) === null || date.slice(0, 4) !== year)) {
    throw new Error('Le date dell’importazione non sono un elenco ISO valido per il calendario.');
  }
  if (month !== undefined && validateImportMonth(month).year !== year) throw new Error('Il mese scelto non appartiene all’anno del calendario.');
  const selectedDates = scopeDates.filter(date => month === undefined || date.startsWith(month + '-')).sort();
  const footprint = new Set(selectedDates);
  const scope = { mode: 'source_dates', year, ...(month === undefined ? {} : { month }), dates: selectedDates,
    start: selectedDates[0] ?? null, endExclusive: selectedDates.length ? iso(dateMilliseconds(selectedDates.at(-1)) + DAY_MS) : null };
  const originalState = previousState ?? { version: 1, bindings: {} };
  if (originalState.version !== 1 || !originalState.bindings || typeof originalState.bindings !== 'object'
      || Array.isArray(originalState.bindings)) throw new Error('Registro degli ID non valido.');
  const inScope = date => footprint.has(date);
  const selectedCalendar = calendar.filter(row => inScope(row?.date));
  const selectedIds = new Set(selectedCalendar.map(row => string(row?.krossId).trim()).filter(Boolean));
  const scopedState = { version: 1, bindings: {} };
  for (const [id, binding] of Object.entries(originalState.bindings)) {
    const dates = Array.isArray(binding?.dates) ? binding.dates.filter(inScope) : [];
    if (dates.length) {
      selectedIds.add(id);
      put(scopedState.bindings, id, { ...clone(binding), dates,
        values: Object.fromEntries(dates.map(date => [date, binding.values?.[date]])) });
    } else if (selectedIds.has(id) && !Array.isArray(binding?.dates)) {
      // A malformed relevant binding must fail in the conservative planner.
      put(scopedState.bindings, id, clone(binding));
    }
  }
  const selectedBookings = bookings.filter(booking => {
    if (selectedIds.has(string(booking?.id).trim())) return true;
    if (booking?.room !== config.roomName) return false;
    const dates = bookingDates(booking, scope.year);
    return dates?.some(inScope) ?? false;
  });
  const sourceIds = new Set(selectedBookings.map(booking => string(booking?.id).trim()));
  const boundaryConflicts = [], scopeWarnings = [];
  const addConflict = (booking, message, extra = {}) => boundaryConflicts.push({
    type: 'import_scope_boundary_change', message, sheetName: config.sheetName,
    bookingId: string(booking.id).trim(), reference: string(booking.reference).trim(),
    ...(month === undefined ? {} : { month }), ...extra,
  });

  for (const booking of selectedBookings) {
    const id = string(booking.id).trim(), prior = originalState.bindings[id];
    const status = normalize(booking.status), dates = bookingDates(booking, scope.year);
    if (!prior || status !== 'confermata' || booking.room !== config.roomName || !dates) continue;
    const outside = Array.isArray(prior.dates) ? prior.dates.filter(date => !inScope(date)) : [];
    if (outside.length) {
      if (outside.some(date => !nameKey(prior.values?.[date])
            || nameKey(prior.values[date]) !== nameKey(booking.reference))) {
        addConflict(booking, 'Il nome della prenotazione cambia anche fuori dalle date dell’export: verifica prima di importarla.',
          { preservedDates: outside });
      }
    }
    const oldAnchor = prior.details?.anchorDate;
    if (oldAnchor && !inScope(oldAnchor) && inScope(booking.checkIn)) {
      addConflict(booking, 'L’importo gestito si trova fuori dalle date dell’export: lo spostamento dell’arrivo richiede una verifica.',
        { previousAnchorDate: oldAnchor, anchorDate: booking.checkIn });
    }
  }

  // Scope physical row guards too: an ambiguous row cannot safely be written
  // even if one conflicting date lies outside the selected month.
  const selectedRows = new Set(selectedCalendar.map(row => row.row));
  for (const row of calendar) {
    if (!inScope(row?.date) && selectedRows.has(row?.row)) boundaryConflicts.push({
      type: 'import_scope_ambiguous_row', message: 'Una riga dell’importazione compare anche con una data diversa.',
      sheetName: config.sheetName, month, row: row.row, date: row.date,
    });
  }

  const occupancyBookings = selectedBookings.map(clone);

  // Detail ownership unrelated to this import, and anchors in other months,
  // are opaque. The full metadata is restored in the final annual merge.
  for (const [id, binding] of Object.entries(scopedState.bindings)) {
    if (binding && (!sourceIds.has(id) || (binding.details && !inScope(binding.details.anchorDate)))) delete binding.details;
  }
  const scopedConfig = { ...config, scopeDates: selectedDates };
  const occupancy = planCalendar(occupancyBookings, selectedCalendar, scopedState, scopedConfig);
  const preservedManual = occupancy.conflicts.filter(conflict => conflict.type === 'manual_stay_dates_differ');
  occupancy.conflicts = occupancy.conflicts.filter(conflict => conflict.type !== 'manual_stay_dates_differ');
  occupancy.warnings.push(...preservedManual.map(conflict => ({ ...conflict,
    type: 'manual_stay_preserved', message: 'Prenotazione manuale lasciata invariata: le date nell’export differiscono dal calendario.' })));
  occupancy.conflicts.push(...boundaryConflicts);
  const detailsBookings = selectedBookings.map(booking => {
    if (normalize(booking.status) === 'confermata' && !inScope(booking.checkIn)) {
      if (bookingDates(booking, scope.year)?.some(inScope)) scopeWarnings.push({
        type: 'import_scope_details_anchor_outside', sheetName: config.sheetName,
        bookingId: string(booking.id).trim(), anchorDate: booking.checkIn, month,
        message: 'Importati soltanto i pernottamenti nelle date dell’export: l’arrivo e gli importi sono fuori dall’ambito e restano invariati.',
      });
      return clone(booking); // Never invent a first-of-month finance anchor.
    }
    const selected = bookingDates(booking, scope.year)?.filter(inScope) ?? [];
    return { ...clone(booking), ...(selected.length ? { checkOut: iso(dateMilliseconds(selected.at(-1)) + DAY_MS) } : {}) };
  });
  const details = planBookingDetails(detailsBookings, selectedCalendar, scopedState, occupancy, config);
  const nextState = clone(originalState);
  const plannedIds = new Set([...Object.keys(scopedState.bindings), ...Object.keys(details.nextState.bindings)]);
  for (const id of plannedIds) {
    const prior = originalState.bindings[id], planned = details.nextState.bindings[id];
    const outside = Array.isArray(prior?.dates) ? prior.dates.filter(date => !inScope(date)) : [];
    const inside = Array.isArray(planned?.dates) ? planned.dates.filter(inScope) : [];
    const dates = [...outside, ...inside].sort();
    if (!dates.length) { delete nextState.bindings[id]; continue; }
    const values = {};
    for (const date of outside) values[date] = prior.values[date];
    for (const date of inside) values[date] = planned.values[date];
    const binding = { ...(prior ? clone(prior) : {}), ...(planned ? clone(planned) : {}), dates, values };
    if (prior?.details && (!sourceIds.has(id) || !inScope(prior.details.anchorDate))) binding.details = clone(prior.details);
    else if (!planned?.details) delete binding.details;
    put(nextState.bindings, id, binding);
    if (outside.length && inside.length && new Set(dates.map(date => nameKey(values[date]))).size !== 1) {
      boundaryConflicts.push({ type: 'import_scope_boundary_change', sheetName: config.sheetName,
        bookingId: id, month, message: 'L’ID ha nomi non coerenti nelle date preservate fuori dall’export: verifica la prenotazione.' });
    }
  }
  const conflicts = [...occupancy.conflicts, ...details.conflicts,
    ...boundaryConflicts.filter(conflict => !occupancy.conflicts.includes(conflict))];
  const warnings = [...occupancy.warnings, ...details.warnings, ...scopeWarnings];
  const patches = [...occupancy.patches, ...details.patches]
    .sort((left, right) => left.row - right.row || left.column.localeCompare(right.column));
  if (patches.some(patch => !inScope(patch.date))) throw new Error('Il piano contiene una modifica fuori dalle date dell’export.');
  // Failed plans are reviewable, but can never accidentally persist projected
  // ownership or a subset of the proposed writes.
  if (conflicts.length) return { patches: [], nextState: clone(originalState), conflicts, warnings,
    summary: { ...occupancy.summary, patches: 0, conflicts: conflicts.length, warnings: warnings.length,
      ...(config.bookingDetails ? { details: details.summary } : {}) }, detailSummary: details.summary, scope };
  return { patches, nextState, conflicts, warnings,
    summary: { ...occupancy.summary, patches: patches.length,
      conflicts: 0, warnings: warnings.length, ...(config.bookingDetails ? { details: details.summary } : {}) },
    detailSummary: details.summary, scope };
}
