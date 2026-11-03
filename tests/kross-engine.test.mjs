// The Kross engine end to end, on the invented properties in examples/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'engines', 'kross', 'codice', 'aggiorna.mjs');
const python = process.env.MOCHI_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-test-'));
  fs.cpSync(path.join(root, 'examples'), dir, { recursive: true });
  return dir;
}
function run(dir, ...args) {
  const result = spawnSync(process.execPath, [engine, path.join(dir, 'kross-export-esempio.xlsx'), '--config', 'config.json', ...args],
    { cwd: path.join(dir, 'calendari'), encoding: 'utf8', env: { ...process.env, KROSS_PYTHON: python } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function guests(dir, name) {
  const script = `import openpyxl,json,sys
ws=openpyxl.load_workbook(sys.argv[1])['2026']
print(json.dumps({ws.cell(r,2).value.date().isoformat():ws.cell(r,3).value for r in range(3,368) if ws.cell(r,3).value}))`;
  const out = spawnSync(python, ['-c', script, path.join(dir, 'calendari', name + '.xlsx')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('a dry run changes nothing', () => {
  const dir = workspace();
  const before = fs.readFileSync(path.join(dir, 'calendari', 'Glicine.xlsx'));
  assert.match(run(dir, '--dry-run'), /Simulazione completata: nessun calendario modificato/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'calendari', 'Glicine.xlsx')), before);
});

test('confirmed bookings fill the nights, never the check-out day; cancellations stay out', () => {
  const dir = workspace();
  run(dir);
  const glicine = guests(dir, 'Glicine');
  assert.equal(glicine['2026-03-06'], 'Mario Esempio');
  assert.equal(glicine['2026-03-08'], 'Mario Esempio');
  assert.equal(glicine['2026-03-09'], undefined); // check-out
  assert.equal(Object.values(guests(dir, 'Lavanda')).includes('Ana Ejemplo'), false); // cancelled
  assert.equal(Object.keys(guests(dir, 'Ortensia')).length, 9);
});

test('importing the same export twice is a no-op', () => {
  const dir = workspace();
  run(dir);
  const once = fs.readFileSync(path.join(dir, 'calendari', 'Ortensia.xlsx'));
  assert.match(run(dir), /0 nuove/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'calendari', 'Ortensia.xlsx')), once);
});

test('only the chosen calendars are touched', () => {
  const dir = workspace();
  const lavanda = fs.readFileSync(path.join(dir, 'calendari', 'Lavanda.xlsx'));
  run(dir, '--calendars', 'G');
  assert.equal(guests(dir, 'Glicine')['2026-03-12'], 'Giulia Prova');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'calendari', 'Lavanda.xlsx')), lavanda);
});
