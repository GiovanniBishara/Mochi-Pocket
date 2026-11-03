'use strict';
const crypto=require('node:crypto');

const LIMIT = 100;
const TEXT_LIMIT = 180;
const own = (value, key) => value && typeof value === 'object' && Object.hasOwn(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
function text(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  // Local paths and URLs are never useful as booking names or cell values.
  if (/[a-z]:[\\/]|\\\\|(?:https?|file):\/\//i.test(cleaned)) return '';
  return cleaned.slice(0, limit);
}
function id(value) { const cleaned = text(value, 80); return /^[\p{L}\p{N}_-]{1,80}$/u.test(cleaned) ? cleaned : ''; }
function iso(value) {
  if (typeof value !== 'string' || !/^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function year(value) { const parsed = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : value; return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2199 ? parsed : null; }
function column(value) {
  if (typeof value !== 'string' || !/^[A-Z]{1,3}$/.test(value)) return '';
  let number = 0; for (const char of value) number = number * 26 + char.charCodeAt(0) - 64;
  return number <= 16384 ? value : '';
}
function cell(value, defaultColumn = '') {
  if (typeof value === 'string') return /^([A-Z]{1,3})([1-9]\d{0,6})$/.test(value)
    ? cell({ column: value.match(/^[A-Z]+/)[0], row: Number(value.match(/\d+$/)[0]) }) : '';
  if (!object(value)) return '';
  const col = column(value.column || defaultColumn), row = value.row;
  return col && Number.isInteger(row) && row >= 1 && row <= 1048576 ? col + row : '';
}
function display(value) {
  if (value === null || value === undefined || value === '') return 'Vuoto';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'Non disponibile';
  if (typeof value === 'boolean') return value ? 'Sì' : 'No';
  if (typeof value !== 'string') return 'Non disponibile';
  if (value.trim().startsWith('=')) return 'Formula presente';
  return text(value) || 'Non disponibile';
}

const DESCRIPTIONS = {
  confirmed_cancellation_changed: ['Prenotazione diversa dalla cancellazione confermata', 'Questo ID è già stato segnato come cancellato, ma ora nome o date sono diversi.', 'Verifica se si tratta di una riattivazione prima di modificare la cancellazione registrata.'],
  import_scope_boundary_change: ['Modifica che coinvolge date fuori dal file', 'Per applicare questa modifica servirebbe cambiare anche date non presenti nell’Excel. Quelle date vengono conservate.', 'Esporta anche le date coinvolte nella modifica prima di riprovare.'],
  incoherent_calendar_id: ['ID non coerente nel calendario', 'Lo stesso ID compare su righe libere, con nomi diversi oppure su notti non consecutive.', 'Controlla nome, ID e date. Se il soggiorno è stato annullato, riconcilia insieme l’ID nel calendario e il registro d’importazione: cancellare solo l’ID non basta.'],
  dates_owned_by_another_id: ['Notti già registrate per un altro soggiorno', 'Le notti richieste dalla prenotazione in arrivo risultano già associate nel registro a un altro ID.', 'Verifica se il soggiorno già registrato è stato annullato o modificato e usa un export che includa anche le cancellazioni. L’assenza da un export parziale non conferma l’annullamento.'],
  tracked_cell_changed: ['Nome modificato nel calendario', 'Il nome presente nel calendario è diverso dall’ultimo valore registrato da Mochi. La modifica manuale viene protetta.', 'Confronta il valore registrato con quello attuale e verifica quale nome deve rimanere, poi ripeti la simulazione.'],
  managed_booking_detail_changed: ['Dettaglio modificato nel calendario', 'Un importo o un dettaglio gestito da Mochi è cambiato, contiene una formula oppure non è più nella posizione registrata.', 'Controlla la cella indicata e confronta il valore registrato con quello attuale prima di riprovare.'],
  tracked_id_changed: ['ID modificato nel calendario', 'L’ID o le notti della prenotazione nel calendario non coincidono più con il registro.', 'Confronta ID e date del soggiorno con Kross e verifica la modifica prima di ripetere la simulazione.'],
  calendar_id_ownership_changed: ['ID su notti di un altro soggiorno', 'Un ID presente nel calendario occupa notti che il registro associa a un’altra prenotazione.', 'Confronta le prenotazioni indicate e verifica a quale soggiorno appartengono queste notti.'],
  overlapping_bookings: ['Prenotazioni sovrapposte nell’Excel', 'Nell’Excel Kross due prenotazioni della stessa struttura richiedono almeno una notte in comune.', 'Controlla date e stato delle due prenotazioni in Kross, poi esporta nuovamente il file.'],
  occupied_calendar_cells: ['Nome diverso nelle notti richieste', 'Nel calendario alcune notti richieste contengono già un altro nome. Mochi conserva il contenuto attuale.', 'Confronta il soggiorno in arrivo con il nome presente nelle celle indicate prima di correggere le date.'],
  calendar_cell_formula: ['Formula in una cella del soggiorno', 'Una cella del nome o dell’ID contiene una formula e non può essere aggiornata automaticamente.', 'Controlla la formula nella cella indicata e decidi quale valore deve essere conservato.'],
  missing_calendar_dates: ['Notti mancanti nel calendario', 'Alcune notti del soggiorno non hanno una riga nel calendario selezionato.', 'Controlla anno e date del calendario e ripristina le righe mancanti, poi ripeti la simulazione.'],
  ambiguous_calendar_dates: ['Data ripetuta nel calendario', 'Alcune notti corrispondono a più righe e Mochi non può scegliere quale aggiornare.', 'Verifica le righe con la stessa data nel calendario, poi ripeti la simulazione.'],
  duplicate_calendar_row: ['Riga o data ripetuta', 'Nel calendario una data o una riga è presente più di una volta.', 'Verifica le righe ripetute e assicurati che ogni notte abbia una sola posizione.'],
  partial_manual_match: ['Soggiorno presente solo in parte', 'Il nome del soggiorno è già presente solo su una parte delle notti richieste.', 'Confronta il soggiorno già scritto con tutte le date dell’Excel prima di collegarlo alla prenotazione.'],
  manual_stay_dates_differ: ['Date diverse dal soggiorno manuale', 'Il nome nel calendario continua oltre le date indicate dall’Excel.', 'Verifica le date effettive del soggiorno manuale e della prenotazione esportata.'],
  seeded_manual_name_changed: ['Nome diverso dalla corrispondenza confermata', 'Il nome associato all’ID non coincide con la corrispondenza manuale già confermata.', 'Controlla che ID e nome identifichino la stessa prenotazione prima di riprovare.'],
  duplicate_id: ['ID ripetuto nell’Excel', 'Lo stesso ID compare più volte per questa struttura nell’Excel Kross.', 'Controlla le righe duplicate nell’export e prepara un nuovo file prima di riprovare.'],
  missing_id: ['ID prenotazione mancante', 'Una prenotazione dell’Excel non contiene un ID utilizzabile.', 'Controlla la prenotazione in Kross ed esporta un file completo.'],
  invalid_dates: ['Date del soggiorno non valide', 'Le date di arrivo e partenza non definiscono un soggiorno valido.', 'Controlla check-in e check-out della prenotazione in Kross.'],
  missing_reference: ['Nome ospite mancante', 'Una prenotazione confermata non ha un nome ospite utilizzabile.', 'Completa il riferimento della prenotazione in Kross e prepara un nuovo export.'],
  tracked_booking_room_changed: ['Struttura della prenotazione cambiata', 'Una prenotazione già registrata risulta ora associata a una struttura diversa.', 'Verifica lo spostamento della prenotazione e i due calendari prima di ripetere la simulazione.'],
  overlapping_bindings: ['Registro con notti assegnate a due ID', 'Il registro locale associa la stessa notte a più prenotazioni.', 'Confronta le prenotazioni coinvolte prima di correggere il registro.'],
  overlapping_booking_details: ['Dettaglio assegnato a due prenotazioni', 'La stessa cella di dettaglio risulta gestita da due ID diversi.', 'Confronta i due soggiorni e la cella indicata prima di riprovare.'],
  booking_detail_target_owned: ['Dettaglio di un altro soggiorno', 'La cella di destinazione appartiene a una prenotazione già registrata.', 'Verifica le date e gli ID dei due soggiorni prima di correggere il dettaglio.'],
  booking_detail_target_occupied: ['Dettaglio manuale da conservare', 'La cella di destinazione contiene un valore manuale che Mochi protegge.', 'Controlla il contenuto della cella indicata e quale soggiorno riguarda prima di riprovare.'],
  booking_detail_target_formula_or_missing: ['Cella di dettaglio non disponibile', 'La cella di destinazione manca oppure contiene una formula.', 'Controlla la cella e le date del soggiorno nel calendario prima di riprovare.'],
};
const UNKNOWN = ['Conflitto da verificare', 'Mochi ha rilevato un’incongruenza e ha protetto i dati esistenti.', 'Controlla il calendario e la prenotazione prima di ripetere la simulazione.'];

function describeKrossConflicts(report, selection, { statesByCalendar = {} } = {}) {
  const calendars = Array.isArray(report?.calendars) ? report.calendars.slice(0, LIMIT) : [];
  const selected = Array.isArray(selection) ? selection.filter(object).slice(0, LIMIT) : [];
  const result = [];
  for (const calendar of calendars) {
    if (!object(calendar)) continue;
    const calendarId = id(calendar.id);
    const metadata = selected.find(item => item.id === calendar.id);
    if (selected.length && !metadata) continue;
    const calendarName = text(metadata?.name) || 'Calendario';
    const initial = /^[A-Z]$/.test(metadata?.initial || '') ? metadata.initial
      : /^[A-Za-z]/.test(calendarName) && calendarName !== 'Calendario' ? calendarName[0].toUpperCase() : '';
    const state = statesByCalendar instanceof Map ? statesByCalendar.get(calendar.id)
      : own(statesByCalendar, calendar.id) ? statesByCalendar[calendar.id] : null;
    const bindings = object(state?.planner?.bindings);
    const binding = bookingId => own(bindings, bookingId) ? object(bindings[bookingId]) : null;
    const reference = (bookingId, dates) => {
      const record = binding(bookingId);
      if (!record) return '';
      const direct = text(record.reference); if (direct) return direct;
      for (const date of dates) if (own(record.values, date)) { const value = text(record.values[date]); if (value) return value; }
      return '';
    };
    for (const conflict of (Array.isArray(calendar.conflicts) ? calendar.conflicts.slice(0, LIMIT) : [])) {
      if (result.length >= LIMIT) return result;
      if (!object(conflict)) continue;
      const known = typeof conflict.type === 'string' && own(DESCRIPTIONS, conflict.type);
      const [title, explanation, action] = known ? DESCRIPTIONS[conflict.type] : UNKNOWN;
      const output = { calendarId, calendarName, initial, year: year(metadata?.year) || year(metadata?.sheetName) || (known ? year(conflict.sheetName) : null),
        type: known ? conflict.type : 'unknown', title, explanation, action, dates: [], cells: [], comparisons: [], otherBookings: [] };
      if (!known) { result.push(output); continue; }
      const dates = [...(Array.isArray(conflict.dates) ? conflict.dates.slice(0, LIMIT) : []), conflict.date,
        ...(Array.isArray(conflict.extraDates) ? conflict.extraDates.slice(0, LIMIT) : [])];
      const addDate = value => { const date = iso(value); if (date && !output.dates.includes(date) && output.dates.length < LIMIT) output.dates.push(date); return date; };
      dates.forEach(addDate);
      const bookingId = id(conflict.bookingId);
      if (bookingId) output.bookingId = bookingId;
      const storedReference = reference(bookingId, output.dates);
      const primaryReference = conflict.type === 'incoherent_calendar_id'
        ? storedReference || text(conflict.reference) : text(conflict.reference) || storedReference;
      if (primaryReference) output.reference = primaryReference;
      if (conflict.type === 'incoherent_calendar_id' && text(conflict.reference).toLowerCase() === 'libero') {
        output.title = 'ID rimasto su righe libere';
        output.explanation = 'Nel calendario il nome “libero” compare in almeno una delle righe, ma l’ID della precedente prenotazione è ancora presente. Il controllo riguarda tutte le date indicate.';
      }
      const addCell = value => { if (value && output.cells.length < LIMIT && !output.cells.includes(value)) output.cells.push(value); };
      const addComparison = (raw, defaultColumn = '') => {
        const address = cell(raw, defaultColumn), date = iso(raw?.date);
        addCell(address); if (date) addDate(date);
        if (address && output.comparisons.length < LIMIT && (own(raw, 'expected') || own(raw, 'actual'))) {
          output.comparisons.push({ cell: address, date, expected: display(raw.expected), actual: display(raw.actual) });
        }
      };
      const directCell = cell(conflict, conflict.type === 'tracked_cell_changed' ? 'C' : ''); addCell(directCell);
      const rawCells = Array.isArray(conflict.cells) ? conflict.cells.slice(0, LIMIT) : [];
      for (const raw of rawCells) {
        addCell(cell(raw, ['tracked_cell_changed', 'occupied_calendar_cells'].includes(conflict.type) ? 'C' : ''));
        if (['tracked_cell_changed', 'occupied_calendar_cells'].includes(conflict.type) && object(raw)) {
          const value = { ...raw };
          if (!own(value, 'expected') && conflict.type === 'occupied_calendar_cells') value.expected = primaryReference || undefined;
          addComparison(value, 'C');
        }
      }
      if (['managed_booking_detail_changed', 'booking_detail_target_occupied'].includes(conflict.type)) addComparison(conflict);
      const locations = Array.isArray(conflict.locations) ? conflict.locations.slice(0, LIMIT) : [];
      const declaredDates = new Set(output.dates);
      for (const location of locations) {
        if (!object(location)) continue;
        const date = iso(location.date);
        if (!date || (declaredDates.size && !declaredDates.has(date))) continue;
        addDate(date); addCell(cell(location, 'C'));
        if (conflict.type === 'incoherent_calendar_id') {
          if (location.column === 'C' && own(location, 'guest')) {
            const record = binding(bookingId);
            if (own(record?.values, date) || storedReference) addComparison({ row: location.row, column: 'C', date,
              expected: own(record?.values, date) ? record.values[date] : storedReference, actual: location.guest });
          } else if (location.column === 'S' && bookingId && own(location, 'krossId')) {
            addComparison({ row: location.row, column: 'S', date, expected: bookingId, actual: location.krossId });
          }
        }
      }
      const otherIds = [...(Array.isArray(conflict.otherBookingIds) ? conflict.otherBookingIds.slice(0, 20) : []), conflict.otherBookingId];
      for (const raw of otherIds) {
        const otherId = id(raw); if (!otherId || otherId === bookingId || output.otherBookings.some(item => item.id === otherId) || output.otherBookings.length >= 20) continue;
        const otherReference = reference(otherId, output.dates);
        const oldBinding=binding(otherId),originalReference=typeof oldBinding?.reference==='string'?oldBinding.reference.trim():'',
          originalDates=Array.isArray(oldBinding?.dates)?[...oldBinding.dates].sort():[];
        const canCancel=conflict.type==='dates_owned_by_another_id'&&originalReference&&originalReference===text(originalReference,200)
          &&originalDates.length>0&&originalDates.length<=366&&originalDates.every(date=>iso(date)&&typeof oldBinding.values?.[date]==='string');
        output.otherBookings.push({ id: otherId, ...(otherReference ? { reference: otherReference } : {}),
          ...(canCancel?{canCancel:true,dates:originalDates,revision:crypto.createHash('sha256')
            .update(JSON.stringify([calendarId,otherId,originalReference,originalDates])).digest('hex')}: {}) });
      }
      output.dates.sort();
      result.push(output);
    }
  }
  return result;
}

module.exports = { describeKrossConflicts };
