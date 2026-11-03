(() => {
  'use strict';

  const TONES = Object.freeze({
    info: { label: 'MOCHI', icon: '◆' },
    working: { label: 'IN CORSO', icon: '···' },
    success: { label: 'FATTO!', icon: '✓' },
    attention: { label: 'ATTENZIONE', icon: '!' },
    error: { label: 'ERRORE', icon: '!' },
  });

  function create(element, options = {}) {
    if (!element?.ownerDocument) throw new TypeError('Serve un elemento per la console Mochi.');
    const document = element.ownerDocument;
    const delay = Math.max(8, Math.min(80, Number(options.characterDelay) || 18));
    const maxDuration = Math.max(200, Math.min(10000, Number(options.maxDuration) || 2200));
    const maxLines = Math.max(1, Math.min(3, Math.trunc(Number(options.maxLines) || 2)));
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const make = (tag, className) => {
      const node = document.createElement(tag);
      node.className = className;
      return node;
    };

    const visual = make('div', 'mp-dialogue-visual');
    visual.setAttribute('aria-hidden', 'true');
    const heading = make('div', 'mp-dialogue-heading');
    const icon = make('span', 'mp-dialogue-icon');
    const label = make('span', 'mp-dialogue-label');
    heading.append(icon, label);
    const history = make('div', 'mp-dialogue-history');
    const text = make('div', 'mp-dialogue-text');
    visual.append(heading, history, text);
    const finishButton = make('button', 'mp-dialogue-finish');
    finishButton.type = 'button';
    finishButton.textContent = '▼';
    finishButton.hidden = true;
    finishButton.setAttribute('aria-label', 'Mostra subito tutto il messaggio');
    finishButton.title = 'Mostra subito tutto il messaggio';
    const live = make('span', 'mp-dialogue-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    element.classList.add('mp-dialogue');
    element.dataset.tone = 'info';
    element.dataset.typing = 'false';
    element.replaceChildren(visual, finishButton, live);

    let timer;
    let revision = 0;
    let destroyed = false;
    let current = '';
    let currentTone = 'info';
    const previous = [];
    const segmenter = typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('it', { granularity: 'grapheme' }) : null;

    function cancel() {
      revision += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    }

    function finish() {
      if (destroyed) return false;
      cancel();
      text.textContent = current;
      element.dataset.typing = 'false';
      finishButton.hidden = true;
      return true;
    }

    function write(value, settings = {}) {
      if (destroyed) return false;
      const message = String(value ?? '').slice(0, 4096);
      const tone = Object.hasOwn(TONES, settings.tone) ? settings.tone : 'info';
      if (message === current && tone === currentTone) {
        if (settings.animate === false) finish();
        return false;
      }
      cancel();
      if (current && current !== message && maxLines > 1) {
        previous.push(current);
        previous.splice(0, Math.max(0, previous.length - maxLines + 1));
      }
      current = message;
      currentTone = tone;
      element.dataset.tone = tone;
      icon.textContent = TONES[tone].icon;
      label.textContent = TONES[tone].label;
      history.replaceChildren(...previous.map(line => {
        const node = make('div', 'mp-dialogue-previous');
        node.textContent = line;
        return node;
      }));
      // Announce the complete line once, independently of the decorative typing.
      live.setAttribute('aria-live', tone === 'attention' || tone === 'error' ? 'assertive' : 'polite');
      live.textContent = message ? `${TONES[tone].label}. ${message}` : '';
      if (!message || settings.animate === false || motion?.matches) return finish();

      const characters = segmenter
        ? [...segmenter.segment(message)].map(part => part.segment) : Array.from(message);
      const interval = Math.min(delay, maxDuration / characters.length);
      let cursor = 1;
      const activeRevision = revision;
      text.textContent = characters[0];
      element.dataset.typing = 'true';
      finishButton.hidden = false;
      const advance = () => {
        if (destroyed || activeRevision !== revision) return;
        cursor += 1;
        text.textContent = characters.slice(0, cursor).join('');
        if (cursor >= characters.length) finish();
        else timer = window.setTimeout(advance, interval);
      };
      if (characters.length === 1) finish();
      else timer = window.setTimeout(advance, interval);
      return true;
    }

    const onMotionChange = event => { if (event.matches) finish(); };
    finishButton.addEventListener('click', finish);
    motion?.addEventListener?.('change', onMotionChange);
    return Object.freeze({
      write,
      finish,
      destroy() {
        if (destroyed) return;
        finish();
        destroyed = true;
        finishButton.removeEventListener('click', finish);
        motion?.removeEventListener?.('change', onMotionChange);
      },
    });
  }

  window.mochiDialogue = Object.freeze({ create });
})();
