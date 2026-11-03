/**
 * Pure, conservative occupancy planner. It never opens a workbook or calls an API.
 * Only column C (the guest/reference) and an explicitly configured ID column can
 * be changed. Monetary values, formulas,
 * notes and cleaning fields are deliberately outside this first version's scope.
 *
 * Dates use YYYY-MM-DD and checkout is excluded. A caller must apply neither
 * patches nor nextState when conflicts is nonempty. Persist nextState only after
 * successfully applying all patches; even an adoption with no patches has state.
 */

const DAY_MS = 86_400_000;
const MAX_STAY_NIGHTS = 3660;
const CANCELLED = new Set(['cancellata', 'cancellato', 'annullata']);

function text(value) {
  return value == null ? '' : String(value);
}

function normalize(value) {
  return text(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** Match names with reordered words, preserving duplicate tokens. */
function nameKey(value) {
  return normalize(value).match(/[\p{L}\p{N}]+/gu)?.sort().join('\u0000') ?? '';
}

function sameName(first, second) {
  const key = nameKey(first);
  return key !== '' && key === nameKey(second);
}

function isFree(value) {
  const normalized = normalize(value);
  return normalized === '' || normalized === 'libero';
}

function dateMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (Number(value.slice(0, 4)) < 1) return null;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString().slice(0, 10) === value ? millis : null;
}

function isoDate(millis) {
  return new Date(millis).toISOString().slice(0, 10);
}

function nightDates(checkIn, checkOut, yearStart, yearEnd) {
  const start = dateMilliseconds(checkIn);
  const end = dateMilliseconds(checkOut);
  if (start === null || end === null || end <= start || (end - start) / DAY_MS > MAX_STAY_NIGHTS) return null;
  const dates = [];
  // The binding belongs to this annual sheet, including cross-year stays.
  for (let day = Math.max(start, yearStart); day < Math.min(end, yearEnd); day += DAY_MS) {
    dates.push(isoDate(day));
  }
  return dates;
}

function emptyState() {
  return { version: 1, bindings: {} };
}

function columnNumber(column) {
  return [...column].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function copyState(state) {
  // JSON data is the sidecar contract. This preserves unrelated/absent bindings.
  return JSON.parse(JSON.stringify(state ?? emptyState()));
}

function validBinding(binding) {
  return binding && typeof binding.reference === 'string'
    && Array.isArray(binding.dates)
    && binding.dates.length > 0
    && new Set(binding.dates).size === binding.dates.length
    && binding.values && typeof binding.values === 'object'
    && !Array.isArray(binding.values)
    && binding.dates.every(date => dateMilliseconds(date) !== null
      && typeof binding.values[date] === 'string'
      && !isFree(binding.values[date]));
}

/**
 * @param {Array<object>} bookings Export rows, normalized by the caller.
 * @param {Array<object>} calendar Snapshot rows { row, date, guest, ... }.
 * @param {object} previousState { version: 1, bindings: { [id]: binding } }.
 * @param {object} config { roomName, sheetName, idColumn?, manualNames?, overwriteManualEdits? }.
 * @returns {{patches:Array, nextState:object, conflicts:Array, warnings:Array, summary:object}}
 */
export function planCalendar(bookings, calendar, previousState, config) {
  const conflicts = [];
  const warnings = [];
  const summary = {
    bookingsRead: Array.isArray(bookings) ? bookings.length : 0,
    roomBookings: 0,
    ignoredOtherRooms: 0,
    ignoredOutsideYear: 0,
    added: 0,
    adopted: 0,
    updated: 0,
    unchanged: 0,
    cancelled: 0,
    skipped: 0,
    occupiedNights: 0,
    releasedNights: 0,
    patches: 0,
    conflicts: 0,
    warnings: 0,
  };
  let nextState = emptyState();
  const finalPatches = new Map();

  function issue(collection, type, message, record, details = {}) {
    collection.push({
      type,
      message,
      ...(config?.sheetName ? { sheetName: config.sheetName } : {}),
      ...(record?.id ? { bookingId: record.id } : {}),
      ...(record?.reference ? { reference: record.reference } : {}),
      ...details,
    });
    if (collection === conflicts && record) record.blocked = true;
  }

  function finish() {
    const patches = [...finalPatches.values()].sort((a, b) => a.row - b.row
      || columnNumber(a.column) - columnNumber(b.column));
    summary.patches = patches.length;
    summary.conflicts = conflicts.length;
    summary.warnings = warnings.length;
    return { patches, nextState, conflicts, warnings, summary };
  }

  if (!Array.isArray(bookings) || !Array.isArray(calendar)) {
    issue(conflicts, 'invalid_input', 'Prenotazioni e calendario devono essere array.');
    return finish();
  }
  if (typeof config?.roomName !== 'string' || !config.roomName.trim()) {
    issue(conflicts, 'invalid_config', 'Manca il nome esatto della camera da importare.');
    return finish();
  }
  if (typeof config.sheetName !== 'string' || !/^\d{4}$/.test(config.sheetName)
    || Number(config.sheetName) < 1) {
    issue(conflicts, 'invalid_config', 'Il nome del foglio deve essere un anno a quattro cifre.');
    return finish();
  }
  if (config.overwriteManualEdits !== undefined && typeof config.overwriteManualEdits !== 'boolean') {
    issue(conflicts, 'invalid_config', 'overwriteManualEdits deve essere una scelta booleana esplicita.');
    return finish();
  }
  const idColumn = config.idColumn == null ? null : text(config.idColumn).toUpperCase();
  if (idColumn !== null && (!/^[A-Z]{1,3}$/.test(idColumn)
    || columnNumber(idColumn) < 4 || columnNumber(idColumn) > 16384)) {
    issue(conflicts, 'invalid_config', 'La colonna ID Kross deve essere compresa tra D e XFD.');
    return finish();
  }
  const manualNames = config.manualNames ?? {};
  if ((config.manualNames !== undefined && (config.manualNames === null
    || typeof config.manualNames !== 'object' || Array.isArray(config.manualNames)))
    || Object.entries(manualNames).some(([id, value]) => !id.trim() || id !== id.trim()
      || typeof value !== 'string' || !nameKey(value) || isFree(value))) {
    issue(conflicts, 'invalid_config', 'Le corrispondenze manualNames devono associare ID esatti a nomi ospite testuali utilizzabili.');
    return finish();
  }
  const yearStart = dateMilliseconds(`${config.sheetName}-01-01`);
  const yearEnd = dateMilliseconds(`${config.sheetName}-12-31`) + DAY_MS;
  // Internal projection contract used by import_scope.mjs. The caller also
  // projects calendar rows and binding values to this exact source footprint.
  // Gaps outside that footprint are not missing nights inside this operation.
  if (config.scopeDates !== undefined && (!Array.isArray(config.scopeDates)
      || new Set(config.scopeDates).size !== config.scopeDates.length
      || config.scopeDates.some(date => dateMilliseconds(date) === null || date.slice(0, 4) !== config.sheetName))) {
    issue(conflicts, 'invalid_config', 'Le date dell’importazione non sono un elenco ISO valido per il calendario.');
    return finish();
  }
  const scopeDates = config.scopeDates === undefined ? null : [...config.scopeDates].sort();
  const scopeSet = scopeDates === null ? null : new Set(scopeDates);
  const scopePosition = scopeDates === null ? null : new Map(scopeDates.map((date, index) => [date, index]));
  const scopedNights = (checkIn, checkOut) => {
    const dates = nightDates(checkIn, checkOut, yearStart, yearEnd);
    return dates === null || scopeSet === null ? dates : dates.filter(date => scopeSet.has(date));
  };
  const consecutive = (first, second) => scopePosition === null
    ? dateMilliseconds(second) - dateMilliseconds(first) === DAY_MS
    : scopePosition.has(first) && scopePosition.get(second) === scopePosition.get(first) + 1;

  const sourceState = previousState ?? emptyState();
  if (sourceState.version !== 1 || !sourceState.bindings
    || typeof sourceState.bindings !== 'object' || Array.isArray(sourceState.bindings)) {
    issue(conflicts, 'invalid_state', 'Il registro degli ID non ha il formato previsto (versione 1).');
    return finish();
  }
  nextState = copyState(sourceState);

  const rowsByDate = new Map();
  const rowsSeen = new Set();
  const ambiguousDates = new Set();
  for (const cell of calendar) {
    if (dateMilliseconds(cell?.date) === null || cell.date.slice(0, 4) !== config.sheetName
      || !Number.isInteger(cell?.row) || cell.row < 1) {
      issue(conflicts, 'invalid_calendar_row', 'Il calendario contiene una data o una riga non valida.', null,
        { row: cell?.row ?? null, date: cell?.date ?? null });
      continue;
    }
    if (rowsByDate.has(cell.date) || rowsSeen.has(cell.row)) {
      ambiguousDates.add(cell.date);
      const previousDate = [...rowsByDate.values()].find(row => row.row === cell.row)?.date;
      if (previousDate) ambiguousDates.add(previousDate);
      issue(conflicts, 'duplicate_calendar_row', 'La data o la riga compare più volte nel calendario.', null,
        { row: cell.row, date: cell.date });
      continue;
    }
    rowsSeen.add(cell.row);
    rowsByDate.set(cell.date, { ...cell, guest: text(cell.guest),
      ...(idColumn ? { krossId: text(cell.krossId) } : {}) });
  }

  // A previous binding owns its dates even when absent from a partial export.
  const owners = new Map();
  const invalidBindingIds = new Set();
  const seededBindingIds = new Set();
  for (const [id, binding] of Object.entries(nextState.bindings)) {
    if (!id.trim() || !validBinding(binding)
      || binding.dates.some(date => date.slice(0, 4) !== config.sheetName)) {
      invalidBindingIds.add(id);
      issue(conflicts, 'invalid_binding', 'Il registro di una prenotazione è incompleto o non valido.',
        { id, reference: binding?.reference });
      continue;
    }
    for (const date of binding.dates) {
      if (owners.has(date) && owners.get(date) !== id) {
        invalidBindingIds.add(id);
        invalidBindingIds.add(owners.get(date));
        issue(conflicts, 'overlapping_bindings', 'Due ID registrati possiedono la stessa notte.',
          { id, reference: binding.reference }, { dates: [date], otherBookingId: owners.get(date) });
      } else {
        owners.set(date, id);
      }
    }
  }

  // Relax names only for an existing, fully proven annual ownership and one
  // recognized Kross row. A cancellation may already be free; restoring other
  // manual edits requires the caller's explicit choice for this run.
  const reconcilableIds = new Set();
  if (idColumn) {
    const sourceById = new Map();
    for (const booking of bookings) {
      const id = text(booking?.id).trim();
      const group = sourceById.get(id) ?? [];
      group.push(booking);
      sourceById.set(id, group);
    }
    for (const [id, binding] of Object.entries(sourceState.bindings)) {
      const exported = sourceById.get(id);
      if (invalidBindingIds.has(id) || !validBinding(binding) || exported?.length !== 1) continue;
      const booking = exported[0];
      const status = normalize(booking.status);
      if (booking.room !== config.roomName || (status !== 'confermata' && !CANCELLED.has(status))
        || !scopedNights(booking.checkIn, booking.checkOut)
        || (status === 'confermata' && (!text(booking.reference).trim() || isFree(booking.reference)))) continue;
      if (!config.overwriteManualEdits && !CANCELLED.has(status)) continue;
      const orderedDates = [...binding.dates].sort();
      const validDates = orderedDates.every((date, index) => rowsByDate.has(date) && !ambiguousDates.has(date)
        && (!index || consecutive(orderedDates[index - 1], date)));
      const cellsProven = binding.dates.every(date => {
        const cell = rowsByDate.get(date);
        return cell && !cell.guestFormula && !cell.idFormula && owners.get(date) === id
          && ['', id].includes(cell.krossId.trim())
          && (config.overwriteManualEdits || isFree(cell.guest) || cell.guest === binding.values[date]);
      });
      const extraIdDates = [...rowsByDate.values()].some(cell => cell.krossId.trim() === id
        && !binding.dates.includes(cell.date));
      if (validDates && cellsProven && !extraIdDates) reconcilableIds.add(id);
    }
  }

  if (idColumn) {
    // Persisted IDs recover ownership after losing a local registry. The old
    // registry, when available, still supplies the exact previous guest values.
    const idRows = new Map();
    for (const cell of rowsByDate.values()) {
      const id = cell.krossId.trim();
      if (cell.guestFormula || cell.idFormula) {
        if (id) invalidBindingIds.add(id);
        issue(conflicts, 'calendar_cell_formula', 'Le celle ospite e ID Kross non possono contenere formule.',
          id ? { id } : null, { row: cell.row, date: cell.date,
            column: cell.guestFormula ? 'C' : idColumn });
      }
      if (!id) continue;
      const group = idRows.get(id) ?? [];
      group.push(cell);
      idRows.set(id, group);
    }
    for (const [id, binding] of Object.entries(nextState.bindings)) {
      if (invalidBindingIds.has(id)) continue;
      const differentIds = binding.dates.filter(date => rowsByDate.has(date)
        && rowsByDate.get(date).krossId.trim() !== '' && rowsByDate.get(date).krossId.trim() !== id);
      const extraDates = (idRows.get(id) ?? []).map(cell => cell.date)
        .filter(date => !binding.dates.includes(date));
      if (differentIds.length || extraDates.length) {
        invalidBindingIds.add(id);
        issue(conflicts, 'tracked_id_changed', 'Gli ID nel calendario non coincidono con le notti registrate: la prenotazione viene conservata.',
          { id, reference: binding.reference }, { dates: differentIds, extraDates });
      }
    }
    for (const [id, group] of idRows) {
      group.sort((a, b) => a.date.localeCompare(b.date));
      // Missing IDs within an existing binding are an allowed upgrade. A fresh
      // seed has no such history and therefore requires complete contiguous IDs.
      const continuityDates = Object.hasOwn(nextState.bindings, id)
        && validBinding(nextState.bindings[id]) ? [...nextState.bindings[id].dates].sort() : group.map(cell => cell.date);
      const incoherent = (!reconcilableIds.has(id)
        && group.some(cell => isFree(cell.guest) || !sameName(cell.guest, group[0].guest)))
        || continuityDates.some((date, index) => index > 0
          && !consecutive(continuityDates[index - 1], date));
      if (incoherent) {
        invalidBindingIds.add(id);
        issue(conflicts, 'incoherent_calendar_id', 'Lo stesso ID deve avere notti consecutive e un nome ospite coerente, mai celle libere.',
          { id, reference: group[0].guest }, { dates: group.map(cell => cell.date) });
      }
      const owned = group.filter(cell => owners.has(cell.date) && owners.get(cell.date) !== id);
      if (owned.length) {
        invalidBindingIds.add(id);
        for (const cell of owned) invalidBindingIds.add(owners.get(cell.date));
        issue(conflicts, 'calendar_id_ownership_changed', 'Un ID nel calendario occupa notti registrate per un altro ID.',
          { id, reference: group[0].guest }, { dates: owned.map(cell => cell.date),
            otherBookingIds: [...new Set(owned.map(cell => owners.get(cell.date)))] });
      }
      if (invalidBindingIds.has(id) || Object.hasOwn(nextState.bindings, id)) continue;
      const binding = { reference: group[0].guest, dates: group.map(cell => cell.date),
        values: Object.fromEntries(group.map(cell => [cell.date, cell.guest])) };
      Object.defineProperty(nextState.bindings, id, {
        value: binding, enumerable: true, writable: true, configurable: true,
      });
      seededBindingIds.add(id);
      for (const date of binding.dates) owners.set(date, id);
    }
  }

  const records = bookings.filter(booking => booking?.room === config.roomName).map((booking, index) => ({
    booking,
    index,
    id: text(booking.id).trim(),
    reference: text(booking.reference).trim(),
    status: normalize(booking.status),
    dates: scopedNights(booking.checkIn, booking.checkOut),
    blocked: false,
  }));
  summary.roomBookings = records.length;
  summary.ignoredOtherRooms = bookings.length - records.length;

  // A known ID switching rooms needs a human decision. Absence is a partial
  // export; presence in another room is a material change that must be reported.
  for (const booking of bookings) {
    const id = text(booking?.id).trim();
    if (booking?.room !== config.roomName && Object.hasOwn(nextState.bindings, id)) {
      issue(conflicts, 'tracked_booking_room_changed',
        'Un ID già registrato compare con una camera diversa: le vecchie notti vengono conservate.',
        { id, reference: text(booking?.reference).trim() }, { exportRoom: booking?.room ?? null });
    }
  }

  const byId = new Map();
  for (const record of records) {
    if (!record.id) {
      issue(conflicts, 'missing_id', 'La prenotazione non ha un ID.', record, { bookingIndex: record.index });
    } else {
      const group = byId.get(record.id) ?? [];
      group.push(record);
      byId.set(record.id, group);
    }
    if (!record.dates) {
      issue(conflicts, 'invalid_dates', 'Check-in e check-out devono essere date ISO valide, con soggiorno da 1 a 3660 notti.',
        record, { checkIn: record.booking.checkIn ?? null, checkOut: record.booking.checkOut ?? null });
    }
    if (record.status === 'confermata' && (!record.reference || isFree(record.reference))) {
      issue(conflicts, 'missing_reference', 'La prenotazione confermata non ha un nome utilizzabile.', record);
    }
    if (invalidBindingIds.has(record.id)) record.blocked = true;
    if (record.status !== 'confermata' && !CANCELLED.has(record.status)) {
      issue(warnings, 'unsupported_status', 'Stato non gestito: la prenotazione viene conservata senza importarla.',
        record, { status: text(record.booking.status) });
    }
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      for (const record of group) record.blocked = true;
      issue(conflicts, 'duplicate_id', 'L’ID compare più volte nell’export per questa camera.', group[0],
        { bookingId: id, occurrences: group.length });
    }
  }

  // Detect export overlaps before any adoption, so both bookings are blocked.
  const claims = new Map();
  for (const record of records) {
    if (record.blocked || record.status !== 'confermata') continue;
    for (const date of record.dates) {
      const group = claims.get(date) ?? [];
      group.push(record);
      claims.set(date, group);
    }
  }
  const overlappingRecords = new Map();
  for (const [date, group] of claims) {
    if (group.length < 2) continue;
    for (const record of group) {
      const entry = overlappingRecords.get(record) ?? { dates: [], otherIds: new Set() };
      entry.dates.push(date);
      for (const other of group) if (other !== record) entry.otherIds.add(other.id);
      overlappingRecords.set(record, entry);
    }
  }
  for (const [record, details] of overlappingRecords) {
    issue(conflicts, 'overlapping_bookings', 'La prenotazione si sovrappone a un altro ID nell’export.', record,
      { dates: details.dates, otherBookingIds: [...details.otherIds].sort() });
  }

  const originalGuests = new Map([...rowsByDate].map(([date, cell]) => [date, cell.guest]));
  const originalIds = idColumn
    ? new Map([...rowsByDate].map(([date, cell]) => [date, cell.krossId])) : null;

  function verifyDates(record, dates) {
    const missing = dates.filter(date => !rowsByDate.has(date));
    const ambiguous = dates.filter(date => ambiguousDates.has(date));
    if (missing.length) {
      issue(conflicts, 'missing_calendar_dates', 'Alcune notti della prenotazione non sono presenti nel calendario.',
        record, { dates: missing });
    }
    if (ambiguous.length) {
      issue(conflicts, 'ambiguous_calendar_dates', 'Alcune notti non hanno una riga univoca nel calendario.',
        record, { dates: ambiguous });
    }
    return !missing.length && !ambiguous.length;
  }

  function verifyTracked(record, binding) {
    if (!verifyDates(record, binding.dates)) return false;
    const formulas = binding.dates.filter(date => rowsByDate.get(date).guestFormula || rowsByDate.get(date).idFormula);
    if (formulas.length) {
      issue(conflicts, 'calendar_cell_formula', 'Le celle registrate non possono contenere formule.', record,
        { dates: formulas });
      return false;
    }
    const changed = binding.dates.filter(date => rowsByDate.get(date).guest !== binding.values[date]
      && !reconcilableIds.has(record.id));
    if (changed.length) {
      issue(conflicts, 'tracked_cell_changed', 'Una cella registrata è stata modificata manualmente: l’intera prenotazione viene saltata.',
        record, { dates: changed, cells: changed.map(date => ({
          row: rowsByDate.get(date).row,
          date,
          expected: binding.values[date],
          actual: rowsByDate.get(date).guest,
        })) });
      return false;
    }
    if (idColumn) {
      const changedIds = binding.dates.filter(date => {
        const id = rowsByDate.get(date).krossId.trim();
        return id !== '' && id !== record.id;
      });
      if (changedIds.length) {
        issue(conflicts, 'tracked_id_changed', 'Una cella ID registrata è stata modificata manualmente.',
          record, { dates: changedIds });
        return false;
      }
    }
    return true;
  }

  function commit(record, changes, binding) {
    const previous = nextState.bindings[record.id];
    let changedCells = 0;
    function setCell(date, column, after) {
      const cell = rowsByDate.get(date);
      const field = column === 'C' ? 'guest' : 'krossId';
      if (cell[field] !== after) changedCells += 1;
      cell[field] = after;
      const before = column === 'C' ? originalGuests.get(date) : originalIds.get(date);
      const key = `${date}:${column}`;
      if (before === after) finalPatches.delete(key);
      else finalPatches.set(key, { row: cell.row, column, date, before, after, bookingId: record.id,
        ...(idColumn ? { expectedGuest: originalGuests.get(date), expectedId: originalIds.get(date) } : {}) });
    }
    for (const date of previous?.dates ?? []) {
      if (owners.get(date) === record.id) owners.delete(date);
    }
    for (const [date, after] of changes) {
      setCell(date, 'C', after);
    }
    if (idColumn) {
      const dates = new Set([...(previous?.dates ?? []), ...(binding?.dates ?? [])]);
      const keptDates = new Set(binding?.dates ?? []);
      for (const date of dates) setCell(date, idColumn, keptDates.has(date) ? record.id : '');
    }
    if (binding) {
      // defineProperty also handles externally supplied IDs such as '__proto__'.
      Object.defineProperty(nextState.bindings, record.id, {
        value: binding, enumerable: true, writable: true, configurable: true,
      });
      for (const date of binding.dates) owners.set(date, record.id);
    } else {
      delete nextState.bindings[record.id];
    }
    return changedCells;
  }

  // Releasing tracked cancellations first permits replacement by a new ID.
  const ordered = [...records].sort((a, b) => {
    const priority = record => CANCELLED.has(record.status) ? 0
      : Object.hasOwn(nextState.bindings, record.id) ? 1 : 2;
    return priority(a) - priority(b) || a.index - b.index;
  });

  for (const record of ordered) {
    if (record.blocked || (record.status !== 'confermata' && !CANCELLED.has(record.status))) {
      summary.skipped += 1;
      continue;
    }
    const binding = Object.hasOwn(nextState.bindings, record.id) ? nextState.bindings[record.id] : null;
    let recoveredManualName = false;
    if (binding && seededBindingIds.has(record.id) && Object.hasOwn(manualNames, record.id)) {
      recoveredManualName = binding.dates.every(date => sameName(binding.values[date], manualNames[record.id]));
      const matchesReference = binding.dates.every(date => sameName(binding.values[date], record.reference));
      if (!recoveredManualName && !matchesReference) {
        // Keep the calendar ID ownership for this run, but never persist an
        // unverified recovery as if its manually changed name were trusted.
        delete nextState.bindings[record.id];
        issue(conflicts, 'seeded_manual_name_changed', 'Il nome associato all’ID nel calendario non coincide con la corrispondenza confermata.',
          record, { dates: binding.dates });
        summary.skipped += 1;
        continue;
      }
    }
    if (CANCELLED.has(record.status)) {
      if (!binding) {
        issue(warnings, 'untracked_cancellation', 'La cancellazione non ha celle registrate da liberare.', record);
        summary.skipped += 1;
        continue;
      }
      if (!verifyTracked(record, binding)) {
        summary.skipped += 1;
        continue;
      }
      commit(record, new Map(binding.dates.map(date => [date, 'libero'])), null);
      summary.cancelled += 1;
      summary.releasedNights += binding.dates.length;
      continue;
    }

    if (record.dates.length === 0) {
      if (binding) {
        if (!verifyTracked(record, binding)) {
          summary.skipped += 1;
          continue;
        }
        commit(record, new Map(binding.dates.map(date => [date, 'libero'])), null);
        summary.updated += 1;
        summary.releasedNights += binding.dates.length;
      } else {
        summary.ignoredOutsideYear += 1;
      }
      issue(warnings, 'outside_calendar_year', 'La prenotazione è fuori dall’anno del calendario.', record);
      continue;
    }

    const datesValid = verifyDates(record, record.dates);
    const trackedValid = binding ? verifyTracked(record, binding) : true;
    if (!datesValid || !trackedValid) {
      summary.skipped += 1;
      continue;
    }

    const occupiedByAnotherId = record.dates.filter(date => owners.has(date) && owners.get(date) !== record.id);
    if (occupiedByAnotherId.length) {
      issue(conflicts, 'dates_owned_by_another_id', 'Alcune notti appartengono a un altro ID già registrato.', record,
        { dates: occupiedByAnotherId, otherBookingIds: [...new Set(occupiedByAnotherId.map(date => owners.get(date)))] });
      summary.skipped += 1;
      continue;
    }

    const trackedDates = new Set(binding?.dates ?? []);
    // A user-confirmed abbreviated name belongs only to this exact ID and is
    // permitted only while adopting its complete, untracked manual stay.
    const adoptingManualName = !binding && Object.hasOwn(manualNames, record.id)
      && record.dates.every(date => sameName(rowsByDate.get(date).guest, manualNames[record.id]));
    const adoptionReference = adoptingManualName ? manualNames[record.id] : record.reference;
    const differentGuest = record.dates.filter(date => !trackedDates.has(date)
      && !isFree(rowsByDate.get(date).guest) && !sameName(rowsByDate.get(date).guest, adoptionReference));
    if (differentGuest.length) {
      issue(conflicts, 'occupied_calendar_cells', 'Alcune notti sono occupate da un nome diverso.', record,
        { dates: differentGuest, cells: differentGuest.map(date => ({
          row: rowsByDate.get(date).row, date, actual: rowsByDate.get(date).guest,
        })) });
      summary.skipped += 1;
      continue;
    }

    let adopting = false;
    if (!binding) {
      const occupied = record.dates.filter(date => !isFree(rowsByDate.get(date).guest));
      if (occupied.length && occupied.length !== record.dates.length) {
        issue(conflicts, 'partial_manual_match', 'Solo una parte delle notti contiene già il nome: l’aggancio richiede date complete coincidenti.',
          record, { dates: occupied });
        summary.skipped += 1;
        continue;
      }
      if (occupied.length === record.dates.length) {
        const start = dateMilliseconds(record.booking.checkIn);
        const before = isoDate(start - DAY_MS);
        const after = record.booking.checkOut;
        const extraDates = [before, after].filter(date => rowsByDate.has(date)
          && (sameName(rowsByDate.get(date).guest, record.reference)
            || (Object.hasOwn(manualNames, record.id) && sameName(rowsByDate.get(date).guest, manualNames[record.id])))
          && (!idColumn || !rowsByDate.get(date).krossId.trim()));
        if (extraDates.length) {
          issue(conflicts, 'manual_stay_dates_differ', 'Il nome continua fuori dalle date esportate: non viene agganciata una permanenza parziale.',
            record, { dates: extraDates });
          summary.skipped += 1;
          continue;
        }
        adopting = true;
      }
    }

    const changes = new Map();
    const values = {};
    const sameReference = binding && (recoveredManualName || sameName(binding.reference, record.reference));
    const preferredSpelling = sameReference
      ? binding.values[binding.dates[0]] : record.reference;
    for (const date of binding?.dates ?? []) {
      if (!record.dates.includes(date)) changes.set(date, 'libero');
    }
    for (const date of record.dates) {
      const current = rowsByDate.get(date).guest;
      let after;
      if (trackedDates.has(date)) {
        after = sameReference
          ? (config.overwriteManualEdits && reconcilableIds.has(record.id) ? binding.values[date] : current)
          : record.reference;
      } else {
        after = isFree(current) ? preferredSpelling : current;
      }
      values[date] = after;
      if (current !== after) changes.set(date, after);
    }

    const changedCells = commit(record, changes, { reference: record.reference, dates: [...record.dates], values });
    if (binding) {
      if (changedCells) summary.updated += 1;
      else summary.unchanged += 1;
    } else if (adopting) {
      summary.adopted += 1;
    } else {
      summary.added += 1;
    }
    for (const [date, after] of changes) {
      if (isFree(after)) summary.releasedNights += 1;
      else if (isFree(originalGuests.get(date))) summary.occupiedNights += 1;
    }
  }
  return finish();
}
