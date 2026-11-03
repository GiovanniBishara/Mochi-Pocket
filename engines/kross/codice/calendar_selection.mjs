function initial(calendar) {
  const name = typeof calendar?.name === 'string' ? calendar.name.trim() : '';
  const letter = name.slice(0, 1).toUpperCase();
  if (!/^[A-Z]$/.test(letter)) {
    throw new Error('Ogni calendario deve avere un nome che inizia con una lettera.');
  }
  return letter;
}

export function selectCalendars(calendars, raw) {
  if (!Array.isArray(calendars)) {
    throw new Error('La lista dei calendari non è valida.');
  }
  if (raw == null || (typeof raw === 'string' && /^(?:\s*|\s*(?:tutti|all)\s*)$/i.test(raw))) {
    return [...calendars];
  }
  if (typeof raw !== 'string') {
    throw new Error('Scrivi le iniziali dei calendari separate da una virgola, oppure tutti.');
  }
  const available = new Set(calendars.map(initial));
  const selected = new Set();
  for (const token of raw.split(',')) {
    const letter = token.trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) {
      throw new Error('Selezione non valida: scrivi una sola iniziale per calendario, separata da virgole (esempio: T,B).');
    }
    if (!available.has(letter)) {
      throw new Error(`Iniziale sconosciuta: ${letter}. Le iniziali disponibili sono ${[...available].join(', ')}.`);
    }
    selected.add(letter);
  }
  return calendars.filter(calendar => selected.has(initial(calendar)));
}

export function calendarSelectionLegend(calendars) {
  if (!Array.isArray(calendars)) {
    throw new Error('La lista dei calendari non è valida.');
  }
  const labels = new Map();
  for (const calendar of calendars) {
    const letter = initial(calendar);
    const label = calendar.name.trim().replace(/\s+Google(?:\s*\d{4})?$/i, '').trim();
    if (!labels.has(letter)) labels.set(letter, label);
  }
  return [...labels].map(([letter, label]) => `${letter} = ${label}`).join('; ');
}
