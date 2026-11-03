// Runtimes for the Kross engine. Mochi always passes the configured Python in
// KROSS_PYTHON; when the engine runs on its own, the first python on PATH is used,
// by absolute path and never from the current folder (Windows would otherwise
// run a python.exe planted next to the calendars).
import fs from 'node:fs';
import path from 'node:path';

function findOnPath(names) {
  const here = path.resolve(process.cwd()).toLowerCase();
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || path.resolve(dir).toLowerCase() === here) continue;
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(dir, name + extension);
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not in this folder */ }
      }
    }
  }
  return null;
}

export const nodeExecutable = process.execPath;
export const pythonExecutable = process.env.KROSS_PYTHON
  || findOnPath(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])
  || 'python';
