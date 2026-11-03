import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCalendars, calendarSelectionLegend } from '../engines/kross/codice/calendar_selection.mjs';

const calendars = [{ name: 'Glicine' }, { name: 'Lavanda Google 2026' }, { name: 'Ortensia' }];

test('initials pick calendars; "tutti" or nothing picks all', () => {
  assert.deepEqual(selectCalendars(calendars, 'g, o').map(c => c.name), ['Glicine', 'Ortensia']);
  assert.equal(selectCalendars(calendars, 'tutti').length, 3);
  assert.equal(selectCalendars(calendars, null).length, 3);
});

test('unknown or malformed initials are refused', () => {
  assert.throws(() => selectCalendars(calendars, 'X'), /Iniziale sconosciuta/);
  assert.throws(() => selectCalendars(calendars, 'GL'), /Selezione non valida/);
});

test('the legend drops the "Google 2026" suffix', () => {
  assert.equal(calendarSelectionLegend(calendars), 'G = Glicine; L = Lavanda; O = Ortensia');
});
