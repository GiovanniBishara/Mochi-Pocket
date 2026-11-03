'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OUTPUT = 2 * 1024 * 1024;
const failure = () => Error('Conteggio pulizie non disponibile. Verifica Google e riprova.');

function romeDate(now) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Rome', year:'numeric', month:'2-digit', day:'2-digit'}).format(now);
}
function selection(input, today) {
  const year = input?.year ?? Number(today.slice(0, 4));
  const month = input?.month ?? Number(today.slice(5, 7));
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw Error('Seleziona anno e mese validi.');
  }
  return {year, month};
}
function isIso(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}
function safeText(value, maximum=180) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw failure();
  return value;
}
function validateStay(stay, period, seen) {
  if (!stay || typeof stay !== 'object' || typeof stay.id !== 'string' || !/^[a-f0-9]{32}$/.test(stay.id)
      || seen.has(stay.id) || !isIso(stay.arrival) || !isIso(stay.departure) || stay.arrival >= stay.departure
      || !stay.departure.startsWith(`${period.year}-${String(period.month).padStart(2,'0')}-`)
      || !Array.isArray(stay.warnings) || stay.warnings.length > 20) throw failure();
  seen.add(stay.id);
  return {id:stay.id, name:safeText(stay.name), arrival:stay.arrival, departure:stay.departure,
    warnings:stay.warnings.map(item=>safeText(item,400))};
}
function summarize(result, period, today) {
  if (result?.ok !== true || result.year !== period.year || result.month !== period.month
      || !Array.isArray(result.properties) || !result.properties.length || result.properties.length > 26) throw failure();
  const initials = new Set();
  const properties = result.properties.map(property=>{
    if (!property || !/^[A-Z]$/.test(property.initial) || initials.has(property.initial)
        || !['ready','partial','error'].includes(property.status)) throw failure();
    initials.add(property.initial);
    const header = {initial:property.initial, name:safeText(property.name,100), status:property.status};
    if (property.status === 'error') return {...header, complete:false,
      error:property.error==='Google richiede un nuovo accesso. Premi Collega Google e riprova.'?property.error:'Calendario non leggibile. Verifica il collegamento Google e la configurazione.',
      total:null, past:null, todayCount:null, upcoming:null, stays:[], uncertain:[], warnings:[]};
    if (!Array.isArray(property.stays) || property.stays.length > 1500 || !Array.isArray(property.uncertain)
        || property.uncertain.length > 1500 || !Array.isArray(property.warnings) || property.warnings.length > 20
        || typeof property.complete !== 'boolean' || property.complete !== (property.status === 'ready')) throw failure();
    const seen = new Set();
    const stays = property.stays.map(stay=>validateStay(stay,period,seen));
    const uncertain = property.uncertain.map(stay=>validateStay(stay,period,seen));
    const past = stays.filter(stay=>stay.departure < today).length;
    const todayCount = stays.filter(stay=>stay.departure === today).length;
    return {...header, complete:property.complete, total:stays.length, past, todayCount, upcoming:stays.length-past-todayCount,
      stays, uncertain, warnings:property.warnings.map(item=>safeText(item,400))};
  });
  const ready = properties.filter(property=>property.status !== 'error');
  const totals = Object.fromEntries(['total','past','todayCount','upcoming'].map(key=>[key,
    ready.length ? ready.reduce((sum,property)=>sum+property[key],0) : null]));
  return {ok:true, ...period, today, properties, totals, complete:properties.every(property=>property.complete)};
}

function createCleaningSource({baseDir, engineDir, pythonPath, spawnImpl=spawn, now=()=>new Date(), timeoutMs=180000}={}) {
  let busy = false;
  const cache = new Map();
  async function load(input={}) {
    if (!input || typeof input!=='object' || Array.isArray(input)) throw Error('Seleziona anno e mese validi.');
    const today = romeDate(now()), period = selection(input,today), key = `${period.year}-${period.month}`;
    const saved = cache.get(key);
    if (input.refresh !== true && saved && Date.now()-saved.at < 60000) return summarize(saved.result,period,today);
    if (busy) throw Error('Il conteggio delle pulizie è già in corso.');
    if (![baseDir,engineDir,pythonPath].every(item=>typeof item==='string'&&path.isAbsolute(item))) throw failure();
    busy = true;
    try {
      const child = spawnImpl(pythonPath,['-B',path.join(__dirname,'cleaning-calendar.py'),'--engine-dir',engineDir,
        '--config',path.join(baseDir,'config.json')],{cwd:baseDir,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      const result = await new Promise((resolve,reject)=>{
        let output = '', done = false;
        const finish = (error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
        const timer = setTimeout(()=>{child.kill?.();finish(failure());},timeoutMs);timer.unref?.();
        child.stdout.on('data',chunk=>{output+=String(chunk);if(Buffer.byteLength(output,'utf8')>MAX_OUTPUT){child.kill?.();finish(failure());}});
        child.stderr.on('data',()=>{});
        child.stdin.on('error',()=>finish(failure()));
        child.once('error',()=>finish(failure()));
        child.once('close',code=>{try{const value=JSON.parse(output);if(code!==0)throw failure();summarize(value,period,today);finish(null,value);}catch{finish(failure());}});
        child.stdin.end(JSON.stringify(period));
      });
      if(result.properties.every(property=>property.status!=='error'))cache.set(key,{at:Date.now(),result});
      return summarize(result,period,today);
    } finally {busy=false;}
  }
  function invalidate(){cache.clear();}
  return {load,invalidate};
}
module.exports = {createCleaningSource, summarize, selection, romeDate};
