// Writes guest names (and optional booking IDs) into an Excel calendar while
// preserving the original XLSX archive, including cached dates and native styles.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonExecutable } from './runtime.mjs';

export async function writeCalendar(source, destination, sheetName, patches, { preview, idColumn } = {}) {
  const columnIndex = column => [...column].reduce((index, character) => index * 26 + character.charCodeAt(0) - 64, 0);
  if (idColumn !== undefined && (typeof idColumn !== 'string' || !/^[A-Z]{1,3}$/.test(idColumn)
      || columnIndex(idColumn) < 4 || columnIndex(idColumn) > 16384)) {
    throw new Error('Colonna ID non valida: deve essere da D a XFD.');
  }
  const allowedColumns = new Set(['C', ...(idColumn ? [idColumn] : [])]);
  const seenCells = new Set();
  for (const patch of patches) {
    const coordinate = `${patch.column}${patch.row}`;
    if (!allowedColumns.has(patch.column) || !Number.isInteger(patch.row) || patch.row < 1
        || typeof patch.before !== 'string' || typeof patch.after !== 'string' || seenCells.has(coordinate)) {
      throw new Error('Modifica non valida: consentite soltanto stringhe nelle colonne ospite e ID configurate.');
    }
    if (idColumn && (typeof patch.expectedGuest !== 'string' || typeof patch.expectedId !== 'string')) {
      throw new Error('Modifica non valida: manca la coppia originale ospite/ID da verificare.');
    }
    seenCells.add(coordinate);
  }
  if (!patches.length) {
    if (path.resolve(source) !== path.resolve(destination)) await fs.copyFile(source, destination);
    return;
  }
  // preserve_xlsx.py writes the new strings straight into the sheet XML and proves that
  // nothing else in the archive changed: styles, formulas and other cells stay byte-identical.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mochi-calendari-'));
  try {
    const manifest = path.join(scratch, 'modifiche.json');
    await fs.writeFile(manifest, JSON.stringify(patches), 'utf8');
    const merger = fileURLToPath(new URL('./preserve_xlsx.py', import.meta.url));
    const output = path.resolve(source) === path.resolve(destination) ? path.join(scratch, 'calendario.xlsx') : destination;
    const mergerArguments = [merger, '--source', source, '--output', output, '--sheet', sheetName, '--patches', manifest];
    if (idColumn) mergerArguments.push('--id-column', idColumn);
    const result = spawnSync(pythonExecutable, mergerArguments, { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
    if (output !== destination) await fs.copyFile(output, destination);
    if (preview) console.log('Anteprima PNG non disponibile in questa versione: apri il calendario per controllare.');
  } finally {
    const resolvedScratch = path.resolve(scratch);
    if (path.dirname(resolvedScratch) !== path.resolve(os.tmpdir()) || !path.basename(resolvedScratch).startsWith('mochi-calendari-')) {
      throw new Error('Percorso temporaneo inatteso: pulizia interrotta.');
    }
    await fs.rm(resolvedScratch, { recursive: true, force: true });
  }
}
