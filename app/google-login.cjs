'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const failure = reason => ({ ok: false, reason,
  ...(reason === 'canceled' ? { canceled: true } : {}),
  error: reason === 'timeout'
    ? 'Google non ha risposto in tempo. Premi Riprova per aprire un nuovo collegamento.'
    : reason === 'canceled' ? 'Collegamento Google annullato. Puoi riprovare quando vuoi.'
      : reason === 'busy' ? 'Un collegamento Google è già in corso.'
        : 'Collegamento Google non completato. Controlla il consenso nel browser e riprova.' });

// The login child can only write its private staging token. A cancelled process,
// even if Windows cannot terminate it, can never replace the live authorization.
function createGoogleLogin({ spawnProcess = spawn, timeoutMs = 120000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = null;
  function cleanup(attempt) {
    // This is an exact, per-attempt UUID directory created by this controller.
    return fs.rm(attempt.directory, { recursive: true, force: true }).catch(() => {});
  }
  function stop(attempt) { try { attempt.child?.kill(); } catch { /* Staging still isolates a surviving process. */ } }
  function finish(attempt, result) {
    if (attempt.done) return;
    attempt.done = true;
    clearTimer(attempt.timer);
    if (active === attempt) active = null;
    void cleanup(attempt);
    attempt.resolve(result);
  }
  async function promote(attempt) {
    if (attempt.done || active !== attempt) return cleanup(attempt);
    try {
      const info = await fs.stat(attempt.staging);
      if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) throw Error();
      const value = JSON.parse(await fs.readFile(attempt.staging, 'utf8'));
      if (!value || value.version !== 1 || !['windows-dpapi', 'user-file'].includes(value.protection)
        || (value.protection === 'windows-dpapi' ? typeof value.data !== 'string' || !value.data
          : !value.token || typeof value.token !== 'object' || Array.isArray(value.token))) throw Error();
      if (attempt.done || active !== attempt) return cleanup(attempt);
      // Promotion is the completion boundary: a cancel arriving after this point
      // waits for the atomic replacement and reports its actual result.
      attempt.committing = true;
      clearTimer(attempt.timer);
      await fs.rename(attempt.staging, attempt.token);
      finish(attempt, { ok: true, message: 'Collegamento Google completato.' });
    } catch { finish(attempt, failure('failed')); }
  }
  function run(input = {}) {
    if (active) return Promise.resolve(failure('busy'));
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !['pythonPath', 'scriptPath', 'credentials', 'token'].every(key =>
      typeof input[key] === 'string' && path.isAbsolute(input[key]))) return Promise.resolve(failure('failed'));
    const directory = path.join(path.dirname(input.token), '.mochi-google-login-' + crypto.randomUUID());
    const attempt = { directory, staging: path.join(directory, 'token.json'), token: input.token,
      child: null, done: false, committing: false, timer: null };
    attempt.promise = new Promise(resolve => { attempt.resolve = resolve; });
    active = attempt;
    attempt.timer = setTimer(() => {
      if (attempt.done || attempt.committing) return;
      finish(attempt, failure('timeout'));
      stop(attempt);
    }, timeoutMs);
    void (async () => {
      try {
        await fs.mkdir(path.dirname(directory), { recursive: true });
        if (attempt.done) return cleanup(attempt);
        await fs.mkdir(directory, { mode: 0o700 });
        if (attempt.done) return cleanup(attempt);
        const child = spawnProcess(input.pythonPath,
          ['-B', input.scriptPath, 'login', '--credentials', input.credentials, '--token', attempt.staging],
          { windowsHide: true, shell: false, stdio: 'ignore' });
        attempt.child = child;
        child.once('error', () => {
          if (attempt.done) void cleanup(attempt);
          else if (!attempt.exited) finish(attempt, failure('failed'));
        });
        child.once('close', code => {
          attempt.exited = true;
          if (attempt.done) { void cleanup(attempt); return; }
          if (code === 0) void promote(attempt);
          else finish(attempt, failure('failed'));
        });
      } catch { finish(attempt, failure('failed')); }
    })();
    return attempt.promise;
  }
  async function cancel() {
    const attempt = active;
    if (!attempt) return { ok: true, canceled: false, message: 'Nessun collegamento Google in corso.' };
    if (attempt.committing) return attempt.promise;
    finish(attempt, failure('canceled'));
    stop(attempt);
    return attempt.promise;
  }
  return { run, cancel, get running() { return active !== null; } };
}

module.exports = { createGoogleLogin };
