/**
 * Pure planner for explicitly enabled booking details in Google calendars.
 * It only proposes D (stay), J (description) and K (cleaning) changes.
 * The caller must abort the entire import if either planner has conflicts, and
 * persist nextState only after the complete, guarded Google write succeeds.
 */

const DAY_MS = 86_400_000;
const COLUMNS = ['D', 'J', 'K'];
const CANCELLED = new Set(['cancellata', 'cancellato', 'annullata']);
const DIRECT_CHANNELS = new Set(['', 'diretta', 'manuale', 'sito', 'telefono', 'direct', 'frontoffice', 'prenotazione diretta']);

const string = value => value == null ? '' : String(value);
const normalize = value => string(value).normalize('NFD').replace(/\p{M}/gu, '')
  .trim().toLowerCase().replace(/\s+/g, ' ');
const own = (object, key) => object != null && Object.hasOwn(object, key);
const clone = value => JSON.parse(JSON.stringify(value));
const emptyState = () => ({ version: 1, bindings: {} });
const isGuestFree = value => normalize(value) === '' || normalize(value) === 'libero';
const isBlank = value => value === null || (typeof value === 'string' && value.trim() === '');
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isCount = value => Number.isInteger(value) && value >= 0;
const validValue = value => value === null || typeof value === 'string' || isFiniteNumber(value);

function isMoneyFree(value) {
  return isBlank(value) || value === 0
    || (typeof value === 'string' && /^[+-]?0+(?:[.,]0+)?$/.test(value.trim()));
}

function dateMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds : null;
}

/** Round decimal currency to cents, including negative half cents. */
function money(value) {
  const absolute = Math.abs(value);
  const cents = Math.round((absolute + Number.EPSILON * Math.max(1, absolute)) * 100);
  const rounded = (Math.sign(value) * cents) / 100;
  return rounded === 0 ? 0 : rounded;
}

function annualDates(booking, sheetName) {
  const checkIn = dateMilliseconds(booking.checkIn);
  const checkOut = dateMilliseconds(booking.checkOut);
  if (checkIn === null || checkOut === null || checkOut <= checkIn) return null;
  const startOfYear = dateMilliseconds(`${sheetName}-01-01`);
  const endOfYear = dateMilliseconds(`${sheetName}-12-31`) + DAY_MS;
  if (startOfYear === null || !Number.isFinite(endOfYear)) return null;
  const dates = [];
  for (let date = Math.max(checkIn, startOfYear); date < Math.min(checkOut, endOfYear); date += DAY_MS) {
    dates.push(new Date(date).toISOString().slice(0, 10));
  }
  return dates;
}

function channelName(channel) {
  if (typeof channel !== 'string') return null;
  const name = normalize(channel);
  if (name === 'airbnb' || name === 'airbnb.com') return 'Airbnb';
  if (name === 'booking' || name === 'booking.com') return 'Booking';
  return DIRECT_CHANNELS.has(name) ? 'Prenotazione diretta' : null;
}

function description(booking, channel) {
  const counts = [booking.adultCount, booking.childCount, booking.infantCount];
  if (counts.every(isCount) && counts.some(count => count > 0)) {
    const labels = [['adulto', 'adulti'], ['bambino', 'bambini'], ['neonato', 'neonati']];
    const guests = counts.map((count, index) => count
      ? `${count} ${labels[index][count === 1 ? 0 : 1]}` : null).filter(Boolean);
    return `${channel} - ${guests.join(', ')}`;
  }
  if (isCount(booking.guestCount) && booking.guestCount > 0) {
    return `${channel} - ${booking.guestCount} ${booking.guestCount === 1 ? 'ospite' : 'ospiti'}`;
  }
  return channel;
}

function validDetails(details) {
  if (!details || details.version !== 1 || !isFiniteNumber(details.cleaningFee) || details.cleaningFee < 0
    || dateMilliseconds(details.anchorDate) === null || !Array.isArray(details.cells)) return false;
  const protectedColumns = details.protectedColumns ?? [];
  if (!Array.isArray(protectedColumns) || new Set(protectedColumns).size !== protectedColumns.length
    || protectedColumns.some(column => !COLUMNS.includes(column))) return false;
  const columns = new Set();
  for (const cell of details.cells) {
    if (!cell || !COLUMNS.includes(cell.column) || columns.has(cell.column) || protectedColumns.includes(cell.column)
      || !Number.isInteger(cell.row) || cell.row < 1 || cell.date !== details.anchorDate
      || !validValue(cell.value) || !validValue(cell.baseValue)) return false;
    if (cell.column === 'J' ? typeof cell.value !== 'string' || !isBlank(cell.baseValue)
      : !isFiniteNumber(cell.value) || !isMoneyFree(cell.baseValue)) return false;
    if (cell.column === 'K' && cell.value !== details.cleaningFee) return false;
    columns.add(cell.column);
  }
  return columns.has('K') || protectedColumns.includes('K');
}

/**
 * Inputs and outputs are plain JSON data and remain unmodified.
 * Calendar rows contain guest, krossId and cells D/J/K { value, formula }.
 * A details cell stores both its last written value and its original base value.
 */
export function planBookingDetails(bookings, calendar, previousState, occupancyPlan, config) {
  const conflicts = [];
  const warnings = [];
  const summary = {
    enabled: Boolean(config?.bookingDetails),
    added: 0, updated: 0, unchanged: 0, released: 0,
    skippedExisting: 0, skippedBeforeDate: 0, skippedOutsideAnchor: 0,
    skippedOccupancyConflicts: false, patches: 0, conflicts: 0, warnings: 0,
  };
  const sourceState = previousState ?? emptyState();
  let nextState = clone(occupancyPlan?.nextState ?? sourceState);
  const patchesByCell = new Map();

  function issue(list, type, message, id, extra = {}) {
    list.push({ type, message, ...(config?.sheetName ? { sheetName: config.sheetName } : {}),
      ...(id ? { bookingId: id } : {}), ...extra });
  }

  function finish() {
    const patches = [...patchesByCell.values()].sort((first, second) => first.row - second.row
      || COLUMNS.indexOf(first.column) - COLUMNS.indexOf(second.column));
    summary.patches = patches.length;
    summary.conflicts = conflicts.length;
    summary.warnings = warnings.length;
    return { patches, nextState, conflicts, warnings, summary };
  }

  // Occupancy commits replace bindings. Restore only already-managed metadata.
  if (sourceState?.bindings && nextState?.bindings) {
    for (const [id, binding] of Object.entries(sourceState.bindings)) {
      if (own(binding, 'details') && own(nextState.bindings, id)) {
        nextState.bindings[id].details = clone(binding.details);
      }
    }
  }
  if (!config?.bookingDetails) return finish();
  if (occupancyPlan?.conflicts?.length) {
    summary.skippedOccupancyConflicts = true;
    return finish();
  }

  const options = config.bookingDetails;
  const fillMissing = options.fillMissing === true;
  const overwriteManualEdits = config.overwriteManualEdits === true;
  if (config.idColumn !== 'S' || typeof config.sheetName !== 'string' || !/^\d{4}$/.test(config.sheetName)
    || dateMilliseconds(options.fromDate) === null || !isFiniteNumber(options.cleaningFee)
    || options.cleaningFee < 0 || !Number.isFinite(money(options.cleaningFee))) {
    issue(conflicts, 'invalid_booking_details_config',
      'I dettagli richiedono colonna ID S, anno, data iniziale ISO e quota pulizie numerica non negativa.');
    return finish();
  }
  if (!Array.isArray(bookings) || !Array.isArray(calendar) || sourceState.version !== 1
    || !sourceState.bindings || Array.isArray(sourceState.bindings)
    || nextState?.version !== 1 || !nextState.bindings || Array.isArray(nextState.bindings)) {
    issue(conflicts, 'invalid_booking_details_input', 'Il piano occupazione o il registro dei dettagli non è valido.');
    return finish();
  }

  const rowsByDate = new Map();
  const rowNumbers = new Set();
  for (const row of calendar) {
    if (dateMilliseconds(row?.date) === null || row.date.slice(0, 4) !== config.sheetName
      || !Number.isInteger(row.row) || row.row < 1 || rowsByDate.has(row.date) || rowNumbers.has(row.row)) {
      issue(conflicts, 'invalid_booking_details_calendar', 'Il calendario non ha date e righe univoche valide.', null,
        { date: row?.date ?? null, row: row?.row ?? null });
      continue;
    }
    rowsByDate.set(row.date, row);
    rowNumbers.add(row.row);
  }
  if (conflicts.length) return finish();

  // Original values are kept separate from transaction values; guards always
  // refer to original C/S even when the occupancy planner changes either cell.
  const workingValues = new Map();
  for (const row of rowsByDate.values()) {
    for (const column of COLUMNS) {
      if (row.cells?.[column]) workingValues.set(`${row.date}:${column}`, row.cells[column].value);
    }
  }
  const originalCell = (date, column) => rowsByDate.get(date)?.cells?.[column];
  const key = (date, column) => `${date}:${column}`;

  // Every previously managed cell is checked before any release or update.
  const managed = new Map();
  const releasedDetailBindings = new Set();
  const explicitCancellations = new Set(bookings.filter(booking => booking?.room === config.roomName
    && CANCELLED.has(normalize(booking.status))).map(booking => string(booking.id).trim()));
  for (const [id, binding] of Object.entries(sourceState.bindings)) {
    if (!own(binding, 'details')) continue;
    const details = binding.details;
    if (!validDetails(details)) {
      issue(conflicts, 'invalid_booking_details_state', 'Il registro dei dettagli della prenotazione è incompleto.', id);
      continue;
    }
    for (const cell of details.cells) {
      const row = rowsByDate.get(cell.date);
      const current = originalCell(cell.date, cell.column);
      const ownershipValid = row && typeof row.guest === 'string' && typeof row.krossId === 'string'
        && row.krossId === row.krossId.trim() && (row.krossId === '' || row.krossId === id)
        && !row.guestFormula && !row.idFormula;
      // Reconcile an explicitly cancelled stay that was already cleared by
      // hand, but only at the exact recorded restoration base. Nonbaseline
      // values, formulas, another owner or another guest remain conflicts.
      const alreadyReleasedCell = explicitCancellations.has(id) && ownershipValid
        && isGuestFree(row.guest) && current?.formula === false && current.value === cell.baseValue;
      if (!row || row.row !== cell.row || !current || current.formula !== false
        || !validValue(current.value) || !ownershipValid
        || (current.value !== cell.value && !overwriteManualEdits && !alreadyReleasedCell)) {
        issue(conflicts, 'managed_booking_detail_changed',
          'Un dettaglio registrato è stato modificato manualmente o contiene una formula: importazione bloccata.', id,
          { date: cell.date, row: cell.row, column: cell.column, expected: cell.value,
            actual: current?.value ?? null, formula: current?.formula ?? null });
      }
      const cellKey = key(cell.date, cell.column);
      if (managed.has(cellKey)) {
        issue(conflicts, 'overlapping_booking_details', 'Due ID possiedono la stessa cella di dettaglio.', id,
          { date: cell.date, row: cell.row, column: cell.column, otherBookingId: managed.get(cellKey) });
      } else {
        managed.set(cellKey, id);
      }
    }
  }
  if (conflicts.length) return finish();

  function commit(id, changes) {
    for (const change of changes) {
      const row = rowsByDate.get(change.date);
      const before = originalCell(change.date, change.column).value;
      workingValues.set(key(change.date, change.column), change.value);
      if (before === change.value) patchesByCell.delete(key(change.date, change.column));
      else patchesByCell.set(key(change.date, change.column), {
        row: row.row, column: change.column, date: change.date, before, after: change.value, bookingId: id,
        expectedGuest: string(row.guest), expectedId: string(row.krossId),
      });
    }
  }

  function computedValues(booking, fee, id) {
    const values = new Map([['K', fee]]);
    const channel = channelName(booking.channel);
    let amountSource;
    if (!channel) {
      issue(warnings, 'unknown_booking_channel',
        'Canale assente o non riconosciuto: importo e descrizione omessi; quota pulizie disponibile.', id,
        { channel: booking.channel ?? null });
      return { values, amountSource };
    }
    values.set('J', description(booking, channel));
    if (channel === 'Airbnb') {
      if (isFiniteNumber(booking.hostPayoutBeforeWithholding)
        && booking.hostPayoutSource === 'notes_cancellation_payout') {
        const amount = money(booking.hostPayoutBeforeWithholding - fee);
        if (Number.isFinite(amount)) {
          values.set('D', amount);
          amountSource = 'notes_cancellation_payout_minus_cleaning';
        } else {
          issue(warnings, 'invalid_booking_amount', 'L’importo calcolato non è finito: importo omesso.', id);
        }
      } else {
        issue(warnings, 'missing_airbnb_cancellation_payout',
          'Manca il payout Airbnb prima della ritenuta ricavato dalle note di cancellazione: importo omesso.', id);
      }
    } else if (isFiniteNumber(booking.stayAmount) && isFiniteNumber(booking.commission)) {
      const amount = money(booking.stayAmount - booking.commission);
      if (Number.isFinite(amount)) {
        values.set('D', amount);
        amountSource = 'stay_amount_minus_commission';
      } else {
        issue(warnings, 'invalid_booking_amount', 'L’importo calcolato non è finito: importo omesso.', id);
      }
    } else {
      issue(warnings, 'missing_booking_amount',
        'Manca il soggiorno o la commissione: importo omesso senza assumere commissione zero.', id,
        { stayAmount: booking.stayAmount ?? null, commission: booking.commission ?? null });
    }
    return { values, amountSource };
  }

  function targetAllowed(id, date, column, previousCells) {
    const row = rowsByDate.get(date);
    const current = originalCell(date, column);
    if (!row || !current || current.formula !== false || !validValue(current.value)) {
      issue(conflicts, 'booking_detail_target_formula_or_missing',
        'La destinazione di un dettaglio manca o contiene una formula: importazione bloccata.', id,
        { date, row: row?.row ?? null, column, formula: current?.formula ?? null });
      return false;
    }
    if (previousCells.some(cell => cell.date === date && cell.column === column)) return true;
    const value = workingValues.get(key(date, column));
    if (column === 'J' ? !isBlank(value) : !isMoneyFree(value)) {
      issue(conflicts, 'booking_detail_target_occupied',
        'La destinazione contiene un dettaglio non registrato: il valore manuale viene protetto.', id,
        { date, row: row.row, column, actual: value });
      return false;
    }
    const owner = managed.get(key(date, column));
    if (owner && owner !== id) {
      issue(conflicts, 'booking_detail_target_owned', 'La destinazione appartiene a un altro ID.', id,
        { date, row: row.row, column, otherBookingId: owner });
      return false;
    }
    return true;
  }

  function release(id, details) {
    commit(id, details.cells.map(cell => ({ ...cell, value: cell.baseValue })));
    for (const cell of details.cells) managed.delete(key(cell.date, cell.column));
    if (own(nextState.bindings, id)) delete nextState.bindings[id].details;
    releasedDetailBindings.add(id);
    summary.released += 1;
  }

  const records = bookings.filter(booking => booking?.room === config.roomName)
    .map(booking => ({ booking, id: string(booking.id).trim(), status: normalize(booking.status) }));
  function verifiedOccupancyRelease(owner, date, replacementId) {
    const record = records.find(record => record.id === owner);
    if (!record) return false;
    const exportedDates = record.status === 'confermata' ? annualDates(record.booking, config.sheetName) : null;
    const explicitRelease = CANCELLED.has(record.status)
      || (record.status === 'confermata' && exportedDates !== null && !exportedDates.includes(date));
    if (!explicitRelease) return false;
    // A projected import can omit the old financial anchor while retaining
    // occupancy on overlapping dates. Require the verified occupancy plan's
    // exact old-ID -> replacement-ID patch rather than treating absence from
    // nextState, by itself, as evidence that the old owner was released.
    const row = rowsByDate.get(date);
    return Array.isArray(occupancyPlan.patches) && occupancyPlan.patches.some(patch =>
      patch.column === config.idColumn && patch.date === date && patch.row === row?.row
      && patch.before === owner && patch.after === replacementId
      && patch.expectedId === owner && patch.expectedGuest === row.guest);
  }
  // Release confirmed cancellations and moves outside this annual anchor first.
  const order = record => {
    const binding = own(sourceState.bindings, record.id) ? sourceState.bindings[record.id] : null;
    return binding?.details && (CANCELLED.has(record.status)
      || (record.status === 'confermata' && (!own(nextState.bindings, record.id)
        || !rowsByDate.has(record.booking.checkIn)))) ? 0 : binding?.details ? 1 : 2;
  };
  records.sort((first, second) => order(first) - order(second));

  for (const { booking, id, status } of records) {
    if (!id || (status !== 'confermata' && !CANCELLED.has(status))) continue;
    const prior = own(sourceState.bindings, id) ? sourceState.bindings[id] : null;
    const nextBinding = own(nextState.bindings, id) ? nextState.bindings[id] : null;
    const previousDetails = prior?.details ?? null;
    if (previousDetails && (!nextBinding || !rowsByDate.has(booking.checkIn)
      || !nextBinding.dates.includes(booking.checkIn))) {
      if (CANCELLED.has(status) || status === 'confermata') release(id, previousDetails);
      continue;
    }
    if (status !== 'confermata' || !nextBinding) continue;

    let backfill = false;
    if (!previousDetails) {
      // A recovered ID, an adoption, and a legacy binding all retain their
      // entire manual finance data, even if they are future bookings.
      if (prior && !fillMissing) {
        summary.skippedExisting += 1;
        continue;
      }
      if (dateMilliseconds(booking.checkIn) === null || booking.checkIn < options.fromDate) {
        summary.skippedBeforeDate += 1;
        continue;
      }
      if (!rowsByDate.has(booking.checkIn) || !nextBinding.dates.includes(booking.checkIn)) {
        summary.skippedOutsideAnchor += 1;
        continue;
      }
      const dates = annualDates(booking, config.sheetName);
      const annualBinding = [...nextBinding.dates].sort();
      const exactBinding = dates?.length && dates.length === annualBinding.length
        && dates.every((date, index) => date === annualBinding[index]
          && rowsByDate.has(date) && !rowsByDate.get(date).guestFormula && !rowsByDate.get(date).idFormula);
      const fullyNew = exactBinding && dates.every(date =>
          isGuestFree(rowsByDate.get(date).guest)
          && string(rowsByDate.get(date).krossId).trim() === ''
          && !rowsByDate.get(date).guestFormula && !rowsByDate.get(date).idFormula);
      if ((!fullyNew && !fillMissing) || !exactBinding) {
        summary.skippedExisting += 1;
        continue;
      }
      backfill = Boolean(prior) || !fullyNew;
    }

    let fee = previousDetails ? previousDetails.cleaningFee : money(options.cleaningFee);
    const anchorDate = booking.checkIn;
    const anchorRow = rowsByDate.get(anchorDate);
    const previousCells = previousDetails?.cells ?? [];
    const moved = previousDetails && previousDetails.anchorDate !== anchorDate;
    const protectedColumns = new Set(previousDetails?.protectedColumns ?? []);
    if (backfill) {
      const originalOwner = string(anchorRow.krossId).trim();
      // A cancellation can free an anchor and assign its dates to another ID
      // in the same guarded transaction. The original snapshot still contains
      // the old owner; only an explicitly verified details release permits it.
      const releasedAnchor = sourceState.bindings[originalOwner]?.dates.includes(anchorDate)
        && !nextState.bindings[originalOwner]?.dates.includes(anchorDate)
        && (releasedDetailBindings.has(originalOwner)
          || verifiedOccupancyRelease(originalOwner, anchorDate, id));
      const validAnchor = typeof anchorRow.guest === 'string' && typeof anchorRow.krossId === 'string'
        && (anchorRow.krossId === '' || anchorRow.krossId === id || releasedAnchor)
        && COLUMNS.every(column => {
          const cell = originalCell(anchorDate, column);
          return cell && typeof cell.formula === 'boolean' && validValue(cell.value);
        });
      // Inspect the transaction's current financial values after that release,
      // while commit() and the final writer keep the untouched original guards.
      const currentDetail = column => ({ ...originalCell(anchorDate, column),
        value: workingValues.get(key(anchorDate, column)) });
      const cleaning = currentDetail('K');
      if (!validAnchor || cleaning.formula || (!isMoneyFree(cleaning.value)
        && (!isFiniteNumber(cleaning.value) || cleaning.value < 0))) {
        issue(warnings, 'missing_details_cleaning_unknown',
          'Dettagli mancanti non recuperati: quota pulizie manuale non numerica, formula o struttura incompleta.', id);
        summary.skippedExisting += 1;
        continue;
      }
      if (!isMoneyFree(cleaning.value)) {
        fee = cleaning.value;
        protectedColumns.add('K');
      }
      for (const column of ['D', 'J']) {
        const cell = currentDetail(column);
        if (cell.formula || (column === 'J' ? !isBlank(cell.value) : !isMoneyFree(cell.value))) {
          protectedColumns.add(column);
        }
      }
    }
    const { values, amountSource } = computedValues(booking, fee, id);
    if (previousDetails && !moved) {
      // Incomplete fresh source data must not erase a previously known amount
      // or description at the same anchor. Its original restoration base stays.
      for (const cell of previousCells) {
        if (!values.has(cell.column)) values.set(cell.column, cell.value);
      }
    } else if (moved && previousCells.some(cell => cell.column === 'D') && !values.has('D')) {
      issue(warnings, 'moved_booking_amount_omitted',
        'Le date sono cambiate ma il nuovo importo manca: ripristinato il vecchio importo, nuova destinazione lasciata vuota.', id,
        { previousAnchorDate: previousDetails.anchorDate, anchorDate });
    }
    // A protected column is never owned or released, including when a later
    // run explicitly permits overwriting edits to cells already managed.
    if (fillMissing && previousDetails) {
      for (const column of values.keys()) {
        if (previousCells.some(cell => cell.date === anchorDate && cell.column === column)) continue;
        const cell = originalCell(anchorDate, column);
        if (cell && validValue(cell.value) && (cell.formula
          || (column === 'J' ? !isBlank(cell.value) : !isMoneyFree(cell.value)))) {
          protectedColumns.add(column);
        }
      }
    }
    for (const column of protectedColumns) values.delete(column);
    if (!previousDetails && !values.size && !protectedColumns.has('K')) {
      summary.skippedExisting += 1;
      continue;
    }

    let allowed = true;
    for (const column of values.keys()) {
      if (!targetAllowed(id, anchorDate, column, previousCells)) allowed = false;
    }
    if (!allowed) continue;

    const changes = [];
    if (moved) {
      for (const cell of previousCells) changes.push({ ...cell, value: cell.baseValue });
    }
    const detailCells = [];
    for (const column of COLUMNS) {
      if (!values.has(column)) continue;
      const previousCell = previousCells.find(cell => cell.column === column && cell.date === anchorDate);
      const value = values.get(column);
      const baseValue = previousCell ? previousCell.baseValue : workingValues.get(key(anchorDate, column));
      detailCells.push({ column, row: anchorRow.row, date: anchorDate, value, baseValue });
      if (workingValues.get(key(anchorDate, column)) !== value) {
        changes.push({ column, date: anchorDate, value });
      }
    }
    const details = { version: 1, cleaningFee: fee, anchorDate, cells: detailCells,
      ...(protectedColumns.size ? { protectedColumns: COLUMNS.filter(column => protectedColumns.has(column)) } : {}),
      ...((amountSource || (!moved && previousDetails?.amountSource))
        ? { amountSource: amountSource || previousDetails.amountSource } : {}) };
    commit(id, changes);
    for (const cell of previousCells) managed.delete(key(cell.date, cell.column));
    for (const cell of detailCells) managed.set(key(cell.date, cell.column), id);
    nextBinding.details = details;
    if (!previousDetails) summary.added += 1;
    else if (changes.length) summary.updated += 1;
    else summary.unchanged += 1;
  }
  return finish();
}
