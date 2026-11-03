'use strict';
(() => {
  function create({ check, onChange = () => {}, now = () => Date.now(), cacheTtlMs = 60000 } = {}) {
    let state = { status: 'unknown', checking: false, message: 'Verifica il collegamento prima di accedere a Google.', checkedAt: null };
    let checkedAtMs = null, generation = 0, pending = null;
    const snapshot = () => ({ ...state });
    const publish = () => { onChange(snapshot()); return snapshot(); };
    function invalidate(message = 'Verifica di nuovo il collegamento Google.') {
      generation += 1;
      checkedAtMs = null;
      state = { status: 'unknown', checking: false, message, checkedAt: null };
      return publish();
    }
    function verify(force = false) {
      if (pending) {
        return force && pending.generation !== generation
          ? pending.promise.then(() => verify(true)) : pending.promise;
      }
      if (!force && checkedAtMs !== null && now() - checkedAtMs < cacheTtlMs) return Promise.resolve(snapshot());
      const request = { generation };
      state = { status: 'unknown', checking: true, message: 'Controllo l’accesso a Google…', checkedAt: null };
      publish();
      request.promise = Promise.resolve().then(() => check()).then(result => {
        if (request.generation !== generation) return snapshot();
        const status = result?.status === 'connected' && result.ok === true ? 'connected'
          : result?.status === 'disconnected' ? 'disconnected' : 'unknown';
        const fallback = status === 'connected' ? 'Accesso a Google verificato.'
          : status === 'disconnected' ? 'Collega Google per accedere ai calendari.'
            : 'Non riesco a verificare Google adesso. Riprova tra poco.';
        const timestamp = typeof result?.checkedAt === 'string' ? Date.parse(result.checkedAt) : NaN;
        state = { status, checking: false,
          message: typeof result?.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 400) : fallback,
          checkedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null };
        checkedAtMs = now();
        return publish();
      }).catch(() => {
        if (request.generation !== generation) return snapshot();
        state = { status: 'unknown', checking: false, message: 'Verifica non riuscita. Controlla la connessione e riprova.', checkedAt: null };
        checkedAtMs = now();
        return publish();
      }).finally(() => { if (pending === request) pending = null; });
      pending = request;
      return request.promise;
    }
    return { verify, invalidate, getState: snapshot };
  }
  window.mochiGoogleStatus = { create };
})();
