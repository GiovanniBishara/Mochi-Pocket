'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY_MS = 86_400_000;
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const own = (object, key) => Object.hasOwn(object, key);
const keyOf = (initial, id) => `${initial}:${id}`;

function bounded(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
      || (!empty && !value.trim())) fail(`${label} non valido.`);
  return value.trim();
}

function initialOf(value) {
  if (typeof value !== 'string' || !/^[A-Z]$/.test(value)) fail('Struttura non valida.');
  return value;
}

function count(value, label, fallback) {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}: inserisci un numero intero non negativo.`);
  return value;
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Data non valida.');
  const result = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) fail('Data non valida.');
  return result;
}

function dates(arrival, departure) {
  const start = day(arrival), end = day(departure);
  const nights = (end - start) / DAY_MS;
  if (nights < 1 || nights > 365) fail('Il soggiorno deve durare da 1 a 365 notti.');
  return { start, end, nights };
}

function romeToday(now) {
  const timestamp=now();
  if(!(timestamp instanceof Date)||!Number.isFinite(timestamp.getTime()))fail('Data corrente non valida.');
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(timestamp);
  const part=type=>parts.find(item=>item.type===type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function periodOf({ initial, year, quarter, month, allocation = 'arrival' }) {
  if (!['arrival', 'nights'].includes(allocation)) fail('Criterio del riepilogo non valido.');
  initialOf(initial);
  if (!Number.isInteger(year) || year < 1900 || year > 9998
      || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) fail('Anno o trimestre non valido.');
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12
      || Math.ceil(month / 3) !== quarter)) fail('Mese non valido per il trimestre selezionato.');
  const firstMonth = month ?? (quarter - 1) * 3 + 1;
  const nextMonth = firstMonth + (month === undefined ? 3 : 1);
  const start = `${year}-${String(firstMonth).padStart(2, '0')}-01`;
  const endExclusive = nextMonth > 12 ? `${year + 1}-01-01`
    : `${year}-${String(nextMonth).padStart(2, '0')}-01`;
  return { initial, year, quarter, ...(month === undefined ? {} : { month }), allocation, start, endExclusive,
    months: month === undefined ? [firstMonth, firstMonth + 1, firstMonth + 2] : [month] };
}

function overlaps(stay, period) {
  return stay.arrival < period.endExclusive && stay.departure > period.start;
}

function belongsToPeriod(stay, period) {
  return period.allocation === 'arrival'
    ? stay.arrival >= period.start && stay.arrival < period.endExclusive
    : overlaps(stay, period);
}

function coverageKeyOf(period) {
  return `${period.initial}:${period.year}:Q${period.quarter}${period.allocation === 'arrival' ? ':arrival' : ''}`;
}

function sourceOf(input, initial) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Prenotazione sorgente non valida.');
  if (input.initial !== initial) fail('La prenotazione appartiene a una struttura diversa.');
  const id = bounded(input.id, 'ID prenotazione', 200);
  const name = bounded(input.name, 'Nome', 200);
  dates(input.arrival, input.departure);
  const channel = bounded(input.channel ?? '', 'Canale', 100, { empty: true });
  const sourceFingerprint = bounded(input.sourceFingerprint, 'Versione della fonte', 512);
  const guestCount = input.guestCount === null || input.guestCount === undefined ? null
    : count(input.guestCount, 'Ospiti della fonte');
  let guestBreakdown;
  if (input.guestBreakdown !== undefined) {
    const hint = input.guestBreakdown;
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)
        || !['kross','notes'].includes(hint.basis)) fail('Proposta dei conteggi non valida.');
    const adults = count(hint.adults, 'Adulti proposti'), minors = count(hint.minors, 'Minori proposti');
    if (!Number.isSafeInteger(adults + minors) || adults + minors <= 0 || adults + minors !== guestCount) {
      fail('La proposta dei conteggi non coincide con gli ospiti della fonte.');
    }
    guestBreakdown = { adults, minors, basis: hint.basis };
  }
  if (!Array.isArray(input.warnings ?? []) || (input.warnings ?? []).length > 100) fail('Avvisi della fonte non validi.');
  const warnings = (input.warnings ?? []).map(warning => bounded(warning, 'Avviso', 1000));
  if(input.cancelled!==undefined&&typeof input.cancelled!=='boolean')fail('Stato della fonte non valido.');
  return { id, initial, name, arrival: input.arrival, departure: input.departure,
    channel, guestCount, ...(guestBreakdown ? { guestBreakdown } : {}),
    sourceFingerprint, warnings, cancelled:input.cancelled===true };
}

function confirmationOf(input) {
  if (input.confirmed !== true || input.sameDatesConfirmed !== true) {
    fail('Conferma i conteggi, le date e che tutti gli ospiti condividano le stesse date.');
  }
  const name = bounded(input.name, 'Nome', 200);
  dates(input.arrival, input.departure);
  const adults = count(input.adults, 'Adulti');
  const minors = count(input.minors, 'Minorenni');
  if (!Number.isSafeInteger(adults + minors) || adults + minors === 0) fail('Indica almeno un ospite.');
  if (!Number.isSafeInteger((adults + minors) * 365 * 950)) fail('Conteggi troppo elevati: controlla il numero di ospiti.');
  const otherExemptAdults = count(input.otherExemptAdults, 'Adulti esenti', 0);
  if (otherExemptAdults > adults) fail('Gli adulti esenti non possono superare gli adulti.');
  const exemptionReason = bounded(input.exemptionReason ?? '', 'Motivo esenzione', 1000,
    { empty: otherExemptAdults === 0 });
  if (!['host', 'portal'].includes(input.collection)) fail('Indica chi riscuote la tassa.');
  const previousConsecutiveNights = count(input.previousConsecutiveNights, 'Notti consecutive precedenti', 0);
  const channel = bounded(input.channel ?? '', 'Canale', 100, { empty: true });
  return { name, arrival: input.arrival, departure: input.departure, adults, minors,
    otherExemptAdults, exemptionReason, collection: input.collection, channel,
    previousConsecutiveNights, confirmed: true, sameDatesConfirmed: true };
}

function checkStore(value) {
  if (!value || value.version !== 1 || !value.records || Array.isArray(value.records)
      || typeof value.records !== 'object' || !value.coverage || Array.isArray(value.coverage)
      || typeof value.coverage !== 'object') fail('Archivio tassa di soggiorno non valido: nessun dato sovrascritto.');
  try {
    for (const [key, record] of Object.entries(value.records)) {
      if (!record || typeof record.manual !== 'boolean' || typeof record.missing !== 'boolean'
          || (record.needsReview !== undefined && typeof record.needsReview !== 'boolean')) throw new Error();
      const source = sourceOf(record.source, initialOf(record.source?.initial));
      if (key !== keyOf(source.initial, source.id)) throw new Error();
      if (record.confirmation !== null) {
        confirmationOf(record.confirmation);
        bounded(record.confirmation.sourceFingerprint, 'Versione confermata', 512);
      }
      if (record.exclusion !== undefined && record.exclusion !== null) {
        if (typeof record.exclusion !== 'object' || typeof record.exclusion.missing !== 'boolean') throw new Error();
        bounded(record.exclusion.reason, 'Motivo esclusione', 1000);
        bounded(record.exclusion.sourceFingerprint, 'Versione esclusa', 512);
      }
    }
    for (const [key, coverage] of Object.entries(value.coverage)) {
      const period = periodOf({ ...coverage, allocation: coverage.allocation ?? 'nights' });
      if (key !== coverageKeyOf(period)
          || !Array.isArray(coverage.months) || new Set(coverage.months).size !== coverage.months.length
          || coverage.months.some(month => !period.months.includes(month))) throw new Error();
    }
  } catch {
    fail('Archivio tassa di soggiorno non valido: nessun dato sovrascritto.');
  }
  return value;
}

function statusOf(record) {
  if (record.exclusion) {
    if (!record.needsReview && record.exclusion.sourceFingerprint === record.source.sourceFingerprint
        && record.exclusion.missing === record.missing) return { status: 'excluded', staleReason: null };
    return { status: 'stale', staleReason: record.missing ? 'source_missing' : 'source_changed' };
  }
  if (record.missing) return { status: 'stale', staleReason: 'source_missing' };
  if (!record.confirmation) return { status: 'pending', staleReason: null };
  if (record.needsReview || record.confirmation.sourceFingerprint !== record.source.sourceFingerprint) {
    return { status: 'stale', staleReason: 'source_changed' };
  }
  return { status: 'confirmed', staleReason: null };
}

function viewOf(record) {
  const state = statusOf(record);
  const saved = record.confirmation;
  const verified = state.status === 'confirmed';
  return { ...clone(record.source), ...(verified ? clone(saved) : {}),
    adults: saved?.adults ?? null, minors: saved?.minors ?? null,
    otherExemptAdults: saved?.otherExemptAdults ?? 0,
    exemptionReason: saved?.exemptionReason ?? '', collection: saved?.collection ?? null,
    previousConsecutiveNights: saved?.previousConsecutiveNights ?? 0,
    confirmed: verified, sameDatesConfirmed: verified, manual: record.manual, ...state,
    source: clone(record.source), previousConfirmation: saved ? clone(saved) : null,
    exclusion: record.exclusion ? clone(record.exclusion) : null };
}

function metrics(month, knownRate) {
  return { ...(month === undefined ? {} : { month }), arrivalsAdults: 0, arrivalsMinors: 0,
    hostArrivalsAdults: 0, hostArrivalsMinors: 0, portalArrivalsAdults: 0, portalArrivalsMinors: 0,
    hostArrivalsOtherExemptAdults: 0, portalArrivalsOtherExemptAdults: 0,
    hostArrivalsLiableAdults: 0, portalArrivalsLiableAdults: 0,
    hostArrivalsExemptGuests: 0, portalArrivalsExemptGuests: 0,
    arrivalsOtherExemptAdults: 0, arrivalsLiableAdults: 0, arrivalsExemptGuests: 0,
    adultNights: 0, minorNights: 0, guestNights: 0, exemptNights: 0,
    hostAdultNights: 0, hostMinorNights: 0, portalAdultNights: 0, portalMinorNights: 0,
    hostGuestNights: 0, portalGuestNights: 0, hostExemptAdultNights: 0, portalExemptAdultNights: 0,
    hostExemptNights: 0, portalExemptNights: 0,
    exemptAdultNights: 0, otherExemptAdultNights: 0, overLimitAdultNights: 0, taxableNights: 0,
    hostTaxableNights: 0, portalTaxableNights: 0,
    hostDueCents: knownRate ? 0 : null, portalTaxCents: knownRate ? 0 : null };
}

function add(target, key, amount) {
  const next = target[key] + amount;
  if (!Number.isSafeInteger(next)) fail('Totale troppo elevato: controlla i conteggi inseriti.');
  target[key] = next;
}

function reportOf(store, input, now) {
  const period = periodOf(input);
  const knownRate = period.year === 2026;
  const unknownRateYears = new Set(knownRate ? [] : [period.year]);
  const all = Object.values(store.records).filter(record => record.source.initial === period.initial);
  const records = all.filter(record => statusOf(record).status === 'confirmed'
    ? belongsToPeriod(record.confirmation, period)
    : belongsToPeriod(record.source, period) || (record.confirmation && belongsToPeriod(record.confirmation, period)));
  const stays = records.map(viewOf).sort((left, right) => left.arrival.localeCompare(right.arrival)
    || left.id.localeCompare(right.id));
  const months = period.months.map(month => metrics(month, knownRate));
  const byMonth = new Map(months.map(month => [month.month, month]));
  for (const record of records) {
    if (statusOf(record).status !== 'confirmed') continue;
    const stay = record.confirmation;
    const target = stay.previousConsecutiveNights === 0 && stay.arrival >= period.start && stay.arrival < period.endExclusive
      ? byMonth.get(Number(stay.arrival.slice(5, 7))) : null;
    if (target) {
      add(target, 'arrivalsAdults', stay.adults);
      add(target, 'arrivalsMinors', stay.minors);
      add(target, 'arrivalsOtherExemptAdults', stay.otherExemptAdults);
      add(target, 'arrivalsLiableAdults', stay.adults - stay.otherExemptAdults);
      add(target, 'arrivalsExemptGuests', stay.minors + stay.otherExemptAdults);
      add(target, `${stay.collection}ArrivalsAdults`, stay.adults);
      add(target, `${stay.collection}ArrivalsMinors`, stay.minors);
      add(target, `${stay.collection}ArrivalsOtherExemptAdults`, stay.otherExemptAdults);
      add(target, `${stay.collection}ArrivalsLiableAdults`, stay.adults - stay.otherExemptAdults);
      add(target, `${stay.collection}ArrivalsExemptGuests`, stay.minors + stay.otherExemptAdults);
    }
    const { start, end } = dates(stay.arrival, stay.departure);
    const firstNight = period.allocation === 'arrival' ? start : Math.max(start, day(period.start));
    const endNight = period.allocation === 'arrival' ? end : Math.min(end, day(period.endExclusive));
    for (let night = firstNight; night < endNight; night += DAY_MS) {
      const date = new Date(night).toISOString().slice(0, 10);
      const month = byMonth.get(Number((period.allocation === 'arrival' ? stay.arrival : date).slice(5, 7)));
      const offset = (night - start) / DAY_MS;
      const withinCap = stay.previousConsecutiveNights < 14
        && offset < 14 - stay.previousConsecutiveNights;
      const liableAdults = stay.adults - stay.otherExemptAdults;
      const taxable = withinCap ? liableAdults : 0;
      for (const [key, amount] of Object.entries({ adultNights: stay.adults, minorNights: stay.minors,
        guestNights: stay.adults + stay.minors,
        exemptAdultNights: stay.otherExemptAdults + (withinCap ? 0 : liableAdults),
        exemptNights: stay.minors + stay.otherExemptAdults + (withinCap ? 0 : liableAdults),
        [`${stay.collection}AdultNights`]: stay.adults,
        [`${stay.collection}MinorNights`]: stay.minors,
        [`${stay.collection}GuestNights`]: stay.adults + stay.minors,
        [`${stay.collection}ExemptAdultNights`]: stay.otherExemptAdults + (withinCap ? 0 : liableAdults),
        [`${stay.collection}ExemptNights`]: stay.minors + stay.otherExemptAdults + (withinCap ? 0 : liableAdults),
        otherExemptAdultNights: stay.otherExemptAdults,
        overLimitAdultNights: withinCap ? 0 : liableAdults, taxableNights: taxable,
        [stay.collection === 'host' ? 'hostTaxableNights' : 'portalTaxableNights']: taxable })) add(month, key, amount);
      const amountKey = stay.collection === 'host' ? 'hostDueCents' : 'portalTaxCents';
      if (taxable > 0 && Number(date.slice(0, 4)) !== 2026) {
        unknownRateYears.add(Number(date.slice(0, 4)));
        month[amountKey] = null;
      } else if (knownRate && month[amountKey] !== null) add(month, amountKey, taxable * 950);
    }
  }
  const totals = metrics(undefined, knownRate);
  for (const month of months) for (const key of Object.keys(totals)) {
    if (month[key] === null) totals[key] = null;
    else if (totals[key] !== null) add(totals, key, month[key]);
  }
  const coverageKey = coverageKeyOf(period);
  const covered = [...(store.coverage[coverageKey]?.months ?? [])]
    .filter(month => period.months.includes(month)).sort((a, b) => a - b);
  const coverage = { months: covered, complete: period.months.every(month => covered.includes(month)) };
  const today = romeToday(now);
  const ended = today >= period.endExclusive;
  const pendingCount = stays.filter(stay => ['pending', 'stale'].includes(stay.status)).length;
  const confirmedCount = stays.filter(stay => stay.status === 'confirmed').length;
  const excludedCount = stays.filter(stay => stay.status === 'excluded').length;
  const confirmedGroups = new Map();
  for (const record of records) {
    if (statusOf(record).status !== 'confirmed' || !belongsToPeriod(record.confirmation, period)) continue;
    const saved = record.confirmation;
    const normalizedName = saved.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
    const duplicateKey = JSON.stringify([normalizedName, saved.arrival, saved.departure]);
    const group = confirmedGroups.get(duplicateKey) ?? [];
    group.push(record.source.id);
    confirmedGroups.set(duplicateKey, group);
  }
  const duplicateGroups = [...confirmedGroups.values()].filter(ids => ids.length > 1);
  const issues = [];
  if (pendingCount) issues.push({ code: 'unconfirmed_stays', message: `${pendingCount} soggiorni da verificare.` });
  if (duplicateGroups.length) issues.push({ code: 'duplicate_confirmed_stays',
    message: 'Ci sono soggiorni confermati con lo stesso nome e le stesse date: verifica ed escludi gli eventuali duplicati.',
    stayIds: duplicateGroups.flat() });
  if (!coverage.complete) issues.push({ code: 'coverage_incomplete', message: period.month === undefined
    ? 'Conferma la copertura di tutti e tre i mesi.' : 'Conferma la copertura del mese selezionato.' });
  if (!ended) issues.push({ code: 'period_not_ended', message: period.month === undefined
    ? 'Il trimestre non è ancora concluso.' : 'Il mese non è ancora concluso.' });
  if (unknownRateYears.size) issues.push({ code: 'rate_not_configured',
    message: `Tariffa non configurata per ${[...unknownRateYears].sort().join(', ')}: importi da verificare.`,
    years: [...unknownRateYears].sort() });
  const ready = issues.length === 0;
  return { initial: period.initial, year: period.year, quarter: period.quarter,
    ...(period.month === undefined ? {} : { month: period.month }),
    allocation: period.allocation,
    allocationBasis: { mode: period.allocation, label: period.allocation === 'arrival'
      ? 'Intero soggiorno nel mese di arrivo' : 'Pernottamenti nei mesi effettivi', continuations: 'segment_arrival' },
    period: { start: period.start, endExclusive: period.endExclusive, ended },
    stays, coverage, months, totals, pendingCount, confirmedCount, excludedCount,
    duplicateCount: duplicateGroups.length,
    issues, ready, isProvisional: !ready, definitiveDueCents: ready ? totals.hostDueCents : null,
    rate: { municipality: 'Milano', category: 'CAV / locazioni brevi', year: period.year,
      nightlyCents: knownRate && unknownRateYears.size === 0 ? 950 : null, maxConsecutiveNights: 14,
      source: 'https://www.comune.milano.it/documents/20118/1016509/Tariffe%2B2026%2Bdecorrenza%2B1%C2%B0aprile%2B2026.pdf/d101078f-26b0-4446-d16b-787845b76bca?download=true&t=1771602332605&version=1.1' } };
}

function createTouristTaxLedger({ filePath, now = () => new Date() } = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof now !== 'function') fail('Archivio locale non configurato.');
  const target = path.resolve(filePath);
  async function read() {
    let raw;
    try { raw = await fs.readFile(target, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, records: {}, coverage: {} };
      throw error;
    }
    try { return checkStore(JSON.parse(raw.replace(/^\uFEFF/, ''))); }
    catch { fail('Archivio tassa di soggiorno non leggibile o danneggiato: nessun dato sovrascritto.'); }
  }
  async function write(store) {
    checkStore(store);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(store, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; ; attempt += 1) {
        try { await fs.rename(temporary, target); break; }
        catch (error) {
          // Windows antivirus/indexing may briefly hold the old file open.
          // Retry the atomic replace; never unlink the existing ledger first.
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
              || attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
        }
      }
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  function serialized(operation) {
    const pending = (queues.get(target) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(target, pending);
    const cleanup = () => { if (queues.get(target) === pending) queues.delete(target); };
    pending.then(cleanup, cleanup);
    return pending;
  }
  function applyStay(store, input) {
    if (!input || typeof input !== 'object') fail('Soggiorno non valido.');
    const initial = initialOf(input.initial);
    const confirmation = confirmationOf(input);
    const id = input.manual === true && (input.id === undefined || input.id === null || input.id === '')
      ? `manual-${crypto.randomUUID()}` : bounded(input.id, 'ID prenotazione', 200);
    const key = keyOf(initial, id);
    let record = store.records[key];
    if (record && record.manual !== (input.manual === true)) fail('Origine del soggiorno non valida.');
    if (!record && input.manual !== true) fail('Ricarica le prenotazioni prima di confermare questo soggiorno.');
    if (input.manual === true) {
      const source = sourceOf({ ...confirmation, id, initial, guestCount: null,
        sourceFingerprint: `manual:${id}`, warnings: [] }, initial);
      record = { source, manual: true, missing: false, needsReview: false, confirmation: null };
    } else {
      if (record.missing) fail('La prenotazione non è più presente nella fonte: verifica il calendario.');
      if (record.source.cancelled) fail('La prenotazione è cancellata nella fonte: verifica il soggiorno oppure escludilo.');
      if (typeof input.sourceFingerprint !== 'string'
          || input.sourceFingerprint !== record.source.sourceFingerprint) fail('La fonte è cambiata: ricarica e verifica nuovamente il soggiorno.');
    }
    record.confirmation = { ...confirmation, sourceFingerprint: record.source.sourceFingerprint };
    record.needsReview = false;
    delete record.exclusion;
    store.records[key] = record;
    return viewOf(record);
  }
  return {
    load(input) {
      return serialized(async () => {
        const period = periodOf(input);
        const store = await read();
        if (own(input, 'sourceStays')) {
          if (!Array.isArray(input.sourceStays)) fail('Elenco delle prenotazioni non valido.');
          const incoming = new Map();
          for (const value of input.sourceStays) {
            const source = sourceOf(value, period.initial);
            if (!overlaps(source, period)) continue;
            const key = keyOf(source.initial, source.id);
            if (incoming.has(key)) fail('La fonte contiene ID duplicati: ricarica il calendario.');
            incoming.set(key, source);
          }
          for (const [key, record] of Object.entries(store.records)) {
            if (record.manual || record.source.initial !== period.initial
                || !overlaps(record.source, period)) continue;
            if (input.completeSource!==false&&!incoming.has(key)) {
              if (!record.missing && (record.confirmation || record.exclusion)) record.needsReview = true;
              record.missing = true;
            }
          }
          for (const [key, source] of incoming) {
            const current = store.records[key];
            if(source.cancelled&&!current)continue;
            if (current?.manual) fail('Un ID della fonte coincide con un soggiorno manuale.');
            // Calendar rows may omit the proposal supplied by a Kross export.
            // Keep that hint only while the fiscal identity and guest total
            // still match, and the new source has no unresolved warnings.
            if (!own(source, 'guestBreakdown') && current?.source.guestBreakdown
                && current.source.sourceFingerprint === source.sourceFingerprint
                && current.source.guestCount === source.guestCount && source.warnings.length === 0) {
              source.guestBreakdown = clone(current.source.guestBreakdown);
            }
            const needsReview = Boolean(current?.needsReview || ((current?.confirmation || current?.exclusion)
              && (current.missing || current.source.sourceFingerprint !== source.sourceFingerprint)));
            store.records[key] = { source, manual: false, missing: false,
              needsReview, confirmation: current?.confirmation ?? null,
              ...(current?.exclusion ? { exclusion: clone(current.exclusion) } : {}) };
          }
          if(input.completeSource===false){
            for (const allocation of ['arrival', 'nights']) {
              const coverageKey=coverageKeyOf({...period, allocation});
              if(period.month===undefined)delete store.coverage[coverageKey];
              else if(store.coverage[coverageKey])store.coverage[coverageKey].months=
                store.coverage[coverageKey].months.filter(month=>month!==period.month);
            }
          }
          await write(store);
        }
        return reportOf(store, period, now);
      });
    },
    saveStay(input) {
      return serialized(async () => {
        const store = await read();
        const result = applyStay(store, input);
        await write(store);
        return result;
      });
    },
    saveStays(inputs) {
      return serialized(async () => {
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 1500) fail('Seleziona da 1 a 1500 soggiorni da confermare.');
        const store = await read(), seen = new Set(), results = [];
        for (const input of inputs) {
          const result = applyStay(store, input);
          const key = keyOf(result.initial, result.id);
          if (seen.has(key)) fail('La conferma contiene lo stesso soggiorno più volte.');
          seen.add(key);results.push(result);
        }
        await write(store);
        return results;
      });
    },
    excludeStay(input) {
      return serialized(async () => {
        if (!input || input.confirmed !== true) fail('Conferma esplicitamente l’esclusione del soggiorno.');
        const initial = initialOf(input.initial);
        const id = bounded(input.id, 'ID prenotazione', 200);
        const reason = bounded(input.reason, 'Motivo esclusione', 1000);
        const sourceFingerprint = bounded(input.sourceFingerprint, 'Versione della fonte', 512);
        const store = await read();
        const record = store.records[keyOf(initial, id)];
        if (!record || sourceFingerprint !== record.source.sourceFingerprint) {
          fail('La fonte è cambiata: ricarica e verifica nuovamente il soggiorno.');
        }
        record.exclusion = { reason, sourceFingerprint, missing: record.missing };
        record.needsReview = false;
        await write(store);
        return viewOf(record);
      });
    },
    saveCoverage(input) {
      return serialized(async () => {
        const period = periodOf(input);
        if (!Array.isArray(input.months) || new Set(input.months).size !== input.months.length
            || input.months.some(month => !period.months.includes(month))) fail('Seleziona soltanto mesi del trimestre, senza duplicati.');
        const today=romeToday(now);
        if(input.months.some(month=>today<`${period.year+(month===12?1:0)}-${String(month===12?1:month+1).padStart(2,'0')}-01`)){
          fail('Puoi confermare la copertura soltanto dei mesi già conclusi.');
        }
        const store = await read();
        const coverageKey=coverageKeyOf(period);
        const existing=period.month===undefined?[]:(store.coverage[coverageKey]?.months??[])
          .filter(month=>month!==period.month);
        const months = [...existing,...input.months].sort((a, b) => a - b);
        store.coverage[coverageKey] = {
          initial: period.initial, year: period.year, quarter: period.quarter,
          ...(period.allocation === 'arrival' ? {allocation:'arrival'} : {}), months };
        await write(store);
        return { months: months.filter(month=>period.months.includes(month)),
          complete: period.months.every(month=>months.includes(month)) };
      });
    },
    report(input) { return serialized(async () => reportOf(await read(), input, now)); },
  };
}

module.exports = { createTouristTaxLedger };
