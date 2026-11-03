'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createTouristTaxSource({ baseDir, engineDir, pythonPath, spawnImpl = spawn } = {}) {
  let busy = false;
  async function properties() {
    try {
      const configPath = path.join(baseDir, 'config.json');
      if ((await fs.stat(configPath)).size > 1024 * 1024) throw Error();
      const config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
      if (config.version !== 1 || !Array.isArray(config.calendars)) throw Error();
      const unique = new Map();
      for (const item of config.calendars) {
        if (item.type !== 'google' || typeof item.name !== 'string') continue;
        const name = item.name.replace(/\s+Google.*$/i, '').trim();
        const initial = item.name.trim()[0]?.toUpperCase();
        if (/^[A-Z]$/.test(initial) && name) unique.set(initial, { initial, name: name.slice(0, 100) });
      }
      return [...unique.values()];
    } catch { return []; }
  }
  async function read(input, { exportPath } = {}) {
    if (busy) throw Error('La lettura dei soggiorni è già in corso.');
    if (!input || !/^[A-Z]$/.test(input.initial) || !Number.isInteger(input.year)
        || input.year < 2020 || input.year > 2100 || ![1, 2, 3, 4].includes(input.quarter)) {
      throw Error('Seleziona struttura, anno e trimestre validi.');
    }
    if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)
        || typeof engineDir !== 'string' || !path.isAbsolute(engineDir)
        || typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath)) throw Error('Motore calendari non configurato.');
    // Acquire before local file checks: simultaneous callers must not both
    // pass the asynchronous configuration check and launch duplicate readers.
    busy = true;
    try {
      if (!(await properties()).some(property => property.initial === input.initial)) throw Error('Struttura non configurata.');
      if (exportPath !== undefined) {
        if (typeof exportPath !== 'string' || !path.isAbsolute(exportPath) || !/\.xlsx$/i.test(exportPath)
            || !(await fs.stat(exportPath)).isFile()) throw Error('Scegli un export Kross .xlsx valido.');
      }
      const child = spawnImpl(pythonPath, ['-B', path.join(__dirname, 'tourist-tax-calendar.py'),
        '--engine-dir', engineDir, '--config', path.join(baseDir, 'config.json'), ...(exportPath ? ['--export', exportPath] : [])],
      { cwd: baseDir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const result = await new Promise((resolve, reject) => {
        let output = '', done = false;
        const finish = (error, value) => { if (!done) { done = true; clearTimeout(timer); error ? reject(error) : resolve(value); } };
        const failure = () => Error(exportPath?'Export Kross non leggibile. Scegli un Excel delle prenotazioni valido e riprova.':'Lettura non completata. Verifica il collegamento Google e riprova.');
        const timer = setTimeout(() => { child.kill?.(); finish(failure()); }, 180000);
        timer.unref?.();
        child.stdout.on('data', data => {
          output += String(data);
          if (Buffer.byteLength(output, 'utf8') > 2 * 1024 * 1024) { child.kill?.(); finish(failure()); }
        });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => finish(failure()));
        child.once('error', () => finish(failure()));
        child.once('close', code => {
          try {
            const parsed = JSON.parse(output);
            if (parsed.ok === false && parsed.errorCode === 'google_auth') {
              finish(Error('Google richiede un nuovo accesso. Apri Impostazioni e premi Collega Google, poi ripeti la lettura.'));
              return;
            }
            if (code !== 0 || parsed.ok !== true || !Array.isArray(parsed.stays) || parsed.stays.length > 1500) throw Error();
            finish(null, parsed.stays);
          } catch { finish(failure()); }
        });
        child.stdin.end(JSON.stringify(input));
      });
      return result;
    } finally { busy = false; }
  }
  return { properties, read };
}
module.exports = { createTouristTaxSource };
