'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createGoogleLogin } = require('./google-login.cjs');
const { createKrossAdapter } = require('./kross.cjs');
const { createAlloggiatiAdapter } = require('./alloggiati.cjs');
const { createReceiptAdapter, normalizeProfile } = require('./receipt.cjs');
const { createReceiptCalendarAdapter } = require('./receipt-calendar.cjs');
const { createTouristTaxLedger } = require('./tourist-tax.cjs');
const { createTouristTaxSource } = require('./tourist-tax-source.cjs');
const { renderTouristTaxReport } = require('./tourist-tax-report.cjs');
const { quickConfirmation } = require('./shared/tourist-tax-quick.js');
const { createCancellationRegistry } = require('./kross-cancellations.cjs');
const { createCleaningSource } = require('./cleaning-source.cjs');
const { createCleaningExclusions, CleaningExclusionError } = require('./cleaning-exclusions.cjs');
const { createKrossColorsAdapter } = require('./kross-colors.cjs');
class KrossCancellationValidationError extends Error {}

async function readJson(file, fallback) {
  try { const s=await fs.stat(file);if(s.size>4*1024*1024)return fallback;return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'')); } catch { return fallback; }
}
async function atomicJson(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);
}
// A program on PATH, by absolute path, never from the current folder.
function findProgram(names) {
  const here=path.resolve(process.cwd()).toLowerCase();
  const exts=process.platform==='win32'?['.exe']:[''];
  for(const dir of String(process.env.PATH||'').split(path.delimiter)){
    if(!dir||!path.isAbsolute(dir)||path.resolve(dir).toLowerCase()===here)continue;
    for(const name of names)for(const ext of exts){
      const candidate=path.join(dir,name+ext);
      try{if(require('node:fs').statSync(candidate).isFile())return candidate;}catch{/* not here */}
    }
  }
  return '';
}
function defaults(home=os.homedir()) {
  // Every path can be changed in Impostazioni (saved in settings.json); these are only the first guesses.
  return {krossBase:path.join(home,'Documents','Mochi Pocket','calendari'),alloggiatiState:path.join(home,'AppData','Local','MochiPocket','alloggiati'),
    nodePath:process.env.MOCHI_NODE||findProgram(['node']),pythonPath:process.env.MOCHI_PYTHON||findProgram(process.platform==='win32'?['python','py']:['python3','python']),
    powershellPath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')};
}
function createService({appDir,dataDir,outputDir,profilePath:providedProfilePath,onProgress=()=>{},adapters={},runtimeDefaults=defaults()}={}) {
  const settingsFile=path.join(dataDir,'settings.json'),historyFile=path.join(dataDir,'history.json'),profilePath=providedProfilePath||path.join(dataDir,'receipt-profiles.json');
  let settings={...runtimeDefaults},selectedFile=null,history=[],busy=null,outputs=new Map(),kross,alloggiati,receipt,receiptCalendar,googleCheck=null,touristTax,touristTaxSource,cleaningSource,cleaningExclusions,krossColors;
  const googleLogin=adapters.googleLogin||createGoogleLogin();
  let googleAttempt=null;
  function setupAdapters(){
    kross=adapters.kross||createKrossAdapter({baseDir:settings.krossBase,engineDir:path.join(appDir,'engines','kross','codice'),nodePath:settings.nodePath,pythonPath:settings.pythonPath});
    alloggiati=adapters.alloggiati||createAlloggiatiAdapter({engineDir:path.join(appDir,'engines','alloggiati'),stateRoot:settings.alloggiatiState,powershellPath:settings.powershellPath});
    receipt=adapters.receipt||createReceiptAdapter({pythonPath:settings.pythonPath,outputDir,profilePath});
    receiptCalendar=adapters.receiptCalendar||createReceiptCalendarAdapter({baseDir:settings.krossBase,engineDir:path.join(appDir,'engines','kross','codice'),pythonPath:settings.pythonPath});
    touristTax=adapters.touristTax||createTouristTaxLedger({filePath:path.join(settings.krossBase,'.local','rendiconti','tassa-soggiorno.json')});
    touristTaxSource=adapters.touristTaxSource||createTouristTaxSource({baseDir:settings.krossBase,engineDir:path.join(appDir,'engines','kross','codice'),pythonPath:settings.pythonPath});
    cleaningSource=adapters.cleaningSource||createCleaningSource({baseDir:settings.krossBase,engineDir:path.join(appDir,'engines','kross','codice'),pythonPath:settings.pythonPath});
    cleaningExclusions=adapters.cleaningExclusions||createCleaningExclusions({filePath:path.join(settings.krossBase,'.local','pulizie-esclusioni.json')});
    krossColors=adapters.krossColors||createKrossColorsAdapter({baseDir:settings.krossBase,engineDir:path.join(appDir,'engines','kross','codice'),pythonPath:settings.pythonPath});
  }
  async function initialize({inspect=true}={}){
    await fs.mkdir(dataDir,{recursive:true});
    const saved=await readJson(settingsFile,{})||{};
    for(const key of Object.keys(runtimeDefaults)){
      if(typeof saved[key]==='string'&&path.isAbsolute(saved[key]))settings[key]=saved[key];
    }
    const savedHistory=await readJson(historyFile,[]);
    history=Array.isArray(savedHistory)?savedHistory.filter(item=>item&&typeof item==='object'
      &&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.time==='string').slice(0,100):[];
    for(const item of history){
      if(typeof item.outputId==='string'&&typeof item.privateOutputPath==='string'&&path.isAbsolute(item.privateOutputPath)
        &&/\.(pdf|json|html)$/i.test(item.privateOutputPath))outputs.set(item.outputId,item.privateOutputPath);
    }
    setupAdapters();
    // The desktop renderer requests the first overview itself. Other callers
    // retain the existing initialization-and-overview contract by default.
    return inspect?overview():undefined;
  }
  async function overview(){
    const [k,a,r,rc]=await Promise.all([kross.inspect(),alloggiati.inspect(),receipt.inspectProfiles(),receiptCalendar.inspect()]);
    return {kross:k,alloggiati:a,receipt:r,receiptCalendar:rc,busy,selectedFile:selectedFile?path.basename(selectedFile):null,history:history.map(({id,time,module,title,detail,ok,outputId})=>({id,time,module,title,detail,ok,outputId})),paths:{krossBase:settings.krossBase,alloggiatiState:settings.alloggiatiState,outputDir,profilePath}};
  }
  async function selectKross(file){if(busy)return {ok:false,error:'Aspetta il termine dell’operazione in corso.'};if(typeof file!=='string'||!path.isAbsolute(file)||!/\.xlsx$/i.test(file))return {ok:false,error:'Scegli un file Excel .xlsx esportato da Kross.'};try{if(!(await fs.stat(file)).isFile())throw Error();}catch{return {ok:false,error:'Il file selezionato non è disponibile.'};}selectedFile=file;return {ok:true,name:path.basename(file)};}
  async function addHistory(module,title,detail,ok,outputPath){const id=crypto.randomUUID();const outputId=outputPath?crypto.randomUUID():null;if(outputId)outputs.set(outputId,outputPath);const item={id,time:new Date().toISOString(),module,title,detail,ok,outputId,privateOutputPath:outputPath||null};history.unshift(item);history=history.slice(0,100);try{await atomicJson(historyFile,history);}catch{item.warning='Operazione conclusa, ma il diario non è stato salvato su disco.';}return item;}
  function progress(module,value){const message=typeof value==='string'?value:value?.message;if(typeof message==='string')try{onProgress({module,message:message.slice(0,400)});}catch{/* Display failures must not interrupt a running engine. */}}
  async function action(module,fn){if(busy)return {ok:false,error:'Un’operazione è già in corso.'};busy=module;try{progress(module,'Avvio operazione…');return await fn();}catch{return {ok:false,error:'Operazione interrotta per un errore locale. Controlla configurazione e cartelle.'};}finally{busy=null;}}
  async function cancellationContext(){const config=await readJson(path.join(settings.krossBase,'config.json'),null);if(config?.version!==1||!Array.isArray(config.calendars))throw new KrossCancellationValidationError('Configurazione Kross non disponibile.');const local=path.resolve(settings.krossBase,config.dataDirectory??'.local');return {config,local,registry:createCancellationRegistry({filePath:path.join(local,'annullamenti.json')})};}
  async function decorateCancellations(result){
    if(!result?.summary?.conflictDetails?.some(item=>item.otherBookings?.some(booking=>booking.canCancel)))return result;
    const {registry}=await cancellationContext(),entries=await registry.list(),known=new Map(entries.map(entry=>[entry.calendarId+':'+entry.bookingId,entry.revision]));
    for(const conflict of result.summary.conflictDetails)for(const booking of conflict.otherBookings??[])if(booking.canCancel&&typeof booking.revision==='string'&&known.get(conflict.calendarId+':'+booking.id)===booking.revision){booking.canCancel=false;booking.cancellationConfirmed=true;}
    return result;
  }
  async function runKross(input={}){if(googleCheck)await googleCheck;return action('calendari',async()=>{
    if(!selectedFile)return {ok:false,error:'Scegli prima l’Excel delle prenotazioni.'};
    if(!Array.isArray(input.calendars)||!input.calendars.length||input.calendars.some(c=>typeof c!=='string'||!/^[A-Z]$/.test(c)))return {ok:false,error:'Seleziona almeno un calendario valido.'};
    const result=await kross.run({filePath:selectedFile,calendars:input.calendars,dryRun:input.dryRun!==false,overwriteManual:input.overwriteManual===true},p=>progress('calendari',p));
    if(input.dryRun===false)cleaningSource.invalidate?.();
    const s=result.summary;const detail=s?`${s.added} nuove · ${s.updated} modificate · ${s.cancelled} cancellate · ${s.conflicts} conflitti`:(result.message||'Controlla il rapporto dell’operazione.');
    const item=await addHistory('calendari',input.dryRun!==false?'Simulazione calendari':'Aggiornamento calendari',detail,result.ok,result.reportPath);
    return decorateCancellations({...result,outputId:item.outputId,warning:item.warning});
  });}
  async function latestKrossReport(){
    if(busy)return {ok:false,error:'Aspetta il termine dell’operazione in corso.'};
    if(typeof kross.latestReport!=='function')return {ok:false,error:'Riepilogo non disponibile. Riapri Mochi aggiornato.'};
    try{return await decorateCancellations(await kross.latestReport());}catch{return {ok:false,error:'Non riesco a leggere l’ultimo riepilogo. Usa Simula per preparare un nuovo controllo.'};}
  }
  async function confirmKrossCancellation(input){return action('calendari',async()=>{
    try{
      if(input?.confirmed!==true||typeof input.calendarId!=='string'||typeof input.bookingId!=='string'||typeof input.revision!=='string')throw new KrossCancellationValidationError('Conferma esplicitamente la cancellazione della prenotazione indicata.');
      const {config,local,registry}=await cancellationContext();
      if(!config.calendars.some(calendar=>calendar.id===input.calendarId))throw new KrossCancellationValidationError('Calendario non disponibile.');
      const report=await kross.latestReport(),candidate=report?.summary?.conflictDetails?.find(conflict=>conflict.calendarId===input.calendarId
        &&conflict.otherBookings?.some(booking=>booking.id===input.bookingId&&booking.canCancel&&booking.revision===input.revision));
      if(!candidate)throw new KrossCancellationValidationError('Il conflitto è cambiato. Rileggi il riepilogo prima di confermare.');
      const state=await readJson(path.join(local,input.calendarId+'.state.json'),null),binding=state?.planner?.bindings?.[input.bookingId];
      if(!binding)throw new KrossCancellationValidationError('Il soggiorno non è più registrato. Ripeti la simulazione.');
      const revision=crypto.createHash('sha256').update(JSON.stringify([input.calendarId,input.bookingId,
        String(binding.reference??'').trim(),[...(binding.dates??[])].sort()])).digest('hex');
      if(revision!==input.revision)throw new KrossCancellationValidationError('Le date sono cambiate. Ripeti il controllo prima di confermare.');
      const entry=await registry.confirm({calendarId:input.calendarId,bookingId:input.bookingId,reference:binding.reference,dates:binding.dates,confirmed:true});
      if(entry.revision!==input.revision)throw new KrossCancellationValidationError('Le date sono cambiate. Ripeti il controllo prima di confermare.');
      return {...await decorateCancellations(await kross.latestReport()),ok:true,cancellationSaved:true,message:'Cancellazione registrata. Il prossimo aggiornamento libera soltanto le date presenti nell’Excel.'};
    }catch(error){const known=error instanceof KrossCancellationValidationError||typeof error?.code==='string'&&error.code.startsWith('KROSS_CANCELLATION_');return {ok:false,error:known?error.message:'Cancellazione non registrata. Ripeti il controllo o riprova.'};}
  });}
  async function runAlloggiati(){return action('alloggiati',async()=>{const result=await alloggiati.run({force:true},p=>progress('alloggiati',p));const item=await addHistory('alloggiati','Recupero ricevute Alloggiati',result.message||'Controllo concluso.',result.ok);return {...result,warning:item.warning};});}
  async function generateReceipt(input){return action('ricevuta',async()=>{progress('ricevuta','Controllo i dati e preparo il PDF…');const result=await receipt.generate(input);if(!result.ok)return result;const item=await addHistory('ricevuta','Ricevuta PDF creata',`N. ${result.number} · totale ${Number(result.total).toLocaleString('it-IT',{style:'currency',currency:'EUR'})}`,true,result.path);return {ok:true,total:result.total,number:result.number,filename:path.basename(result.path),outputId:item.outputId,warning:item.warning};});}
  async function suggestReceiptNumber(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.profileId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(input.profileId)||typeof input.issueDate!=='string')return {ok:false,error:'Scegli una struttura e una data di emissione valide.'};
    if(typeof receipt.suggestNumber!=='function')return {ok:false,error:'Suggerimento del numero non disponibile. Riapri Mochi aggiornato.'};
    return receipt.suggestNumber({profileId:input.profileId,issueDate:input.issueDate});
  }
  async function lookupReceiptBooking(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.initial!=='string'||!/^[A-Z]$/.test(input.initial))return {ok:false,error:'Scegli una struttura valida.'};
    if(typeof input.date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(input.date))return {ok:false,error:'Scegli una data valida nel calendario.'};
    const parsed=new Date(input.date+'T00:00:00.000Z');
    if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==input.date)return {ok:false,error:'Scegli una data valida nel calendario.'};
    if(googleCheck)await googleCheck;
    return action('ricevuta',async()=>{
      progress('ricevuta','Cerco le prenotazioni per la data selezionata…');
      return receiptCalendar.lookup({initial:input.initial,date:input.date},p=>progress('ricevuta',p));
    });
  }
  async function profileDetails(){const value=await readJson(profilePath,null);if(!value||typeof value!=='object'||!Array.isArray(value.profiles)){let code='PROFILES_UNREADABLE';try{await fs.access(profilePath);}catch(e){if(e.code==='ENOENT')code='PROFILES_MISSING';}return {ok:false,code,profiles:[],error:code==='PROFILES_MISSING'?'Aggiungi il primo profilo emittente.':'Profili non disponibili. Rileggi i dati o apri la cartella di Mochi.'};}return {ok:true,profiles:value.profiles};}
  async function saveProfile(source){return action('settings',async()=>{
    try{
      const normalized=normalizeProfile(source),data=await profileDetails();
      if(data.code==='PROFILES_UNREADABLE')return {ok:false,error:'I profili esistenti non sono leggibili. Nessun dato è stato sostituito.'};
      const others=data.profiles.filter(profile=>profile.id!==normalized.id);
      await atomicJson(profilePath,{schemaVersion:1,profiles:[...others,normalized]});
      return {ok:true,receipt:await receipt.inspectProfiles()};
    }catch(error){return {ok:false,error:error.message||'Controlla i campi del profilo.'};}
  });}
  async function setKrossFolder(folder){
    const result=await action('settings',async()=>{
      if(googleCheck)await googleCheck;
      if(typeof folder!=='string'||!path.isAbsolute(folder))return {ok:false,error:'Cartella non valida.'};
      const config=await readJson(path.join(folder,'config.json'),null);
      if(!config||!Array.isArray(config.calendars))return {ok:false,error:'La cartella non contiene una configurazione Kross.'};
      const updated={...settings,krossBase:folder};
      await atomicJson(settingsFile,updated);
      settings=updated;selectedFile=null;setupAdapters();
      return {ok:true};
    });
    return result.ok?{...result,overview:await overview()}:result;
  }
  const googleCanceled=()=>({ok:false,canceled:true,reason:'canceled',message:'Collegamento Google annullato. Puoi riprovare quando vuoi.'});
  async function reconnectGoogle(){return action('google',async()=>{
    const attempt={canceled:false};
    attempt.cancellation=new Promise(resolve=>{attempt.release=resolve;});
    googleAttempt=attempt;
    try{
      if(googleCheck)await Promise.race([googleCheck,attempt.cancellation]);
      if(attempt.canceled)return googleCanceled();
      const config=await readJson(path.join(settings.krossBase,'config.json'),null);const target=config?.calendars?.find(c=>c.type==='google'&&c.credentials);
      if(attempt.canceled)return googleCanceled();
      if(!target)return {ok:false,error:'Configurazione Google non trovata.'};
      const credentials=path.resolve(settings.krossBase,target.credentials),token=path.resolve(settings.krossBase,target.token||'Google/token.json');
      progress('google','Completa l’accesso nel browser. Se non risponde, premi Riprova oppure Annulla. L’attesa termina dopo 2 minuti.');
      return await googleLogin.run({pythonPath:settings.pythonPath,scriptPath:path.join(appDir,'engines','kross','codice','google_sheets.py'),credentials,token});
    }finally{if(googleAttempt===attempt)googleAttempt=null;}
  });}
  async function cancelGoogleConnection(){
    const attempt=googleAttempt;
    if(!attempt)return {ok:true,canceled:false};
    attempt.canceled=true;attempt.release();
    await googleLogin.cancel();
    return {ok:true,canceled:true};
  }
  function googleUnknown(reason,message){return {ok:false,status:'unknown',reason,message,checkedAt:new Date().toISOString()};}
  async function checkGoogleConnection(){
    if(googleCheck)return googleCheck;
    if(busy)return googleUnknown('busy','Aspetta il termine dell’operazione per verificare Google.');
    if(typeof kross.checkGoogleConnection!=='function')return googleUnknown('runtime','Controllo Google non disponibile. Riapri Mochi aggiornato.');
    googleCheck=(async()=>{
      try{return await kross.checkGoogleConnection();}
      catch{return googleUnknown('network','Non riesco a verificare Google in questo momento. Riprova tra poco.');}
    })().finally(()=>{googleCheck=null;});
    return googleCheck;
  }
  function taxSelection(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.initial!=='string'||!/^[A-Z]$/.test(input.initial)
      ||!Number.isInteger(input.year)||input.year<2020||input.year>2100||![1,2,3,4].includes(input.quarter))throw Error('Scegli struttura, anno e trimestre validi.');
    if(input.month!==undefined&&(!Number.isInteger(input.month)||input.month<1||input.month>12||Math.ceil(input.month/3)!==input.quarter))throw Error('Scegli un mese valido nel trimestre.');
    const allocation=input.allocation??'arrival';
    if(!['arrival','nights'].includes(allocation))throw Error('Scegli un criterio di conteggio valido.');
    return {initial:input.initial,year:input.year,quarter:input.quarter,...(input.month!==undefined?{month:input.month}:{}),allocation};
  }
  async function taxResult(selection){
    const report=await touristTax.report(selection);
    return {ok:true,stays:report.stays,report,properties:await touristTaxSource.properties()};
  }
  async function taxAction(fn){
    if(googleCheck)await googleCheck;
    return action('tasse',async()=>{try{return await fn();}catch(error){return {ok:false,error:error?.code?'Archivio dei rendiconti non accessibile. Controlla la cartella Kross e riprova.':error?.message||'Rendiconto non disponibile. Controlla i dati e riprova.'};}});
  }
  async function taxLoad(input){return taxAction(async()=>{
    const selection=taxSelection(input);
    if(input.refresh===true){
      const fromExport=input.source==='kross';
      if(fromExport&&!selectedFile)throw Error('Scegli prima l’Excel delle prenotazioni Kross.');
      progress('tasse',fromExport?'Leggo i soggiorni dall’Excel Kross…':'Leggo i soggiorni del trimestre dai calendari…');
      // The source is complete for the quarter even when the view shows one
      // month. A monthly filter must never mark sibling-month bookings missing.
      const sourceSelection={initial:selection.initial,year:selection.year,quarter:selection.quarter};
      const sourceStays=await touristTaxSource.read(sourceSelection,fromExport?{exportPath:selectedFile}:{});
      await touristTax.load({...sourceSelection,sourceStays,completeSource:!fromExport});
    }else await touristTax.load(selection);
    return taxResult(selection);
  });}
  async function taxSaveStay(input){return taxAction(async()=>{
    const selection=taxSelection(input);
    await touristTax.saveStay(input);
    return taxResult(selection);
  });}
  async function taxQuickConfirm(input){return taxAction(async()=>{
    const selection=taxSelection(input);
    if(input.confirmed!==true||!Array.isArray(input.rows)||!input.rows.length||input.rows.length>1500)throw Error('Conferma le righe visualizzate prima di aggiornare i conteggi.');
    const report=await touristTax.report(selection),catalog=new Map(report.stays.map(stay=>[stay.id,stay])),seen=new Set();
    const confirmations=input.rows.map(row=>{
      if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||seen.has(row.id))throw Error('Elenco soggiorni non valido.');
      seen.add(row.id);
      const stay=catalog.get(row.id);
      if(!stay||row.sourceFingerprint!==stay.sourceFingerprint)throw Error('Un soggiorno è cambiato. Rileggi i conteggi prima di confermare.');
      return quickConfirmation(stay,{confirmed:true,minors:row.minors,collection:row.collection,total:row.total});
    });
    await touristTax.saveStays(confirmations);
    return {...await taxResult(selection),savedCount:confirmations.length};
  });}
  async function taxSaveCoverage(input){return taxAction(async()=>{
    const selection=taxSelection(input);
    await touristTax.saveCoverage({...selection,months:input.months});
    return taxResult(selection);
  });}
  async function taxExcludeStay(input){return taxAction(async()=>{
    const selection=taxSelection(input);
    await touristTax.excludeStay(input);
    return taxResult(selection);
  });}
  async function taxExport(input){return taxAction(async()=>{
    const selection=taxSelection(input),report=await touristTax.report(selection);
    const properties=await touristTaxSource.properties(),property=properties.find(item=>item.initial===selection.initial);
    const directory=path.join(settings.krossBase,'.local','rendiconti','esportazioni');
    await fs.mkdir(directory,{recursive:true});
    const periodLabel=selection.month?`M${String(selection.month).padStart(2,'0')}`:`T${selection.quarter}`;
    const allocationLabel=selection.allocation==='arrival'?'Arrivo':'Notti';
    const filename=`Tassa soggiorno - ${selection.initial} - ${selection.year} ${periodLabel} - ${allocationLabel} - ${crypto.randomUUID()}.html`;
    const target=path.join(directory,filename);
    await fs.writeFile(target,renderTouristTaxReport(report,{propertyName:property?.name||selection.initial}),{encoding:'utf8',flag:'wx',mode:0o600});
    const item=await addHistory('tasse',report.ready?'Riepilogo tassa confermato':'Riepilogo tassa provvisorio',
      `${property?.name||selection.initial} · ${selection.year} ${periodLabel} · ${allocationLabel} · ${report.pendingCount} da verificare`,true,target);
    return {ok:true,outputId:item.outputId,filename,message:report.ready?'Riepilogo confermato salvato.':'Riepilogo provvisorio salvato: completa i dati prima della dichiarazione.',warning:item.warning};
  });}
  async function cleaningLoad(input={}){if(googleCheck)await googleCheck;return action('pulizie',async()=>{
    progress('pulizie','Leggo le partenze dai calendari…');
    try{return await cleaningExclusions.decorate(await cleaningSource.load(input));}catch(error){return {ok:false,error:error instanceof CleaningExclusionError?error.message:'Conteggio pulizie non disponibile. Verifica mese, collegamento Google e riprova.'};}
  });}
  async function cleaningSetExcluded(input){if(googleCheck)await googleCheck;return action('pulizie',async()=>{
    try{
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.excluded!=='boolean'
          ||!Number.isInteger(input.year)||input.year<2020||input.year>2100||!Number.isInteger(input.month)||input.month<1||input.month>12
          ||typeof input.initial!=='string'||!/^[A-Z]$/.test(input.initial)||typeof input.id!=='string'||!/^[a-f0-9]{32}$/.test(input.id)
          ||typeof input.revision!=='string'||!/^[a-f0-9]{64}$/.test(input.revision))throw new CleaningExclusionError('Seleziona una riga valida delle pulizie.');
      const report=await cleaningSource.load({year:input.year,month:input.month,refresh:true});
      return {...await cleaningExclusions.setExcluded(report,input),message:input.excluded?'Riga esclusa dal conteggio. Rimane visibile e puoi reincluderla.':'Riga reinclusa nel conteggio.'};
    }catch(error){return {ok:false,error:error instanceof CleaningExclusionError?error.message:'Scelta non salvata. Rileggi i calendari e riprova.'};}
  });}
  async function krossColorsLoad(input={}){if(googleCheck)await googleCheck;return action('calendari',async()=>{
    progress('calendari','Controllo i colori delle prenotazioni…');
    return krossColors.audit(input);
  });}
  async function krossColorsApply(input){if(googleCheck)await googleCheck;return action('calendari',async()=>{
    if(input?.confirmed!==true)return {ok:false,error:'Conferma la prenotazione da colorare.'};
    progress('calendari','Applico il giallo alla prenotazione selezionata…');
    return krossColors.apply(input);
  });}
  function outputPath(id){return typeof id==='string'?outputs.get(id)||null:null;}
  function folderPath(kind,profileId){if(kind==='receipts'&&profileId!==undefined)return typeof profileId==='string'&&profileId?receipt.outputDirectory?.(profileId)||null:null;const folders={receipts:outputDir,kross:settings.krossBase,alloggiati:settings.alloggiatiState,app:appDir};return typeof kind==='string'&&Object.hasOwn(folders,kind)?folders[kind]:null;}
  async function alloggiatiFolderPath(profileId){
    if(typeof profileId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId))return null;
    return typeof alloggiati.receiptFolder==='function'?await alloggiati.receiptFolder(profileId):null;
  }
  return {initialize,overview,selectKross,runKross,latestKrossReport,confirmKrossCancellation,krossColorsLoad,krossColorsApply,runAlloggiati,generateReceipt,suggestReceiptNumber,lookupReceiptBooking,profileDetails,saveProfile,setKrossFolder,reconnectGoogle,cancelGoogleConnection,checkGoogleConnection,taxLoad,taxSaveStay,taxQuickConfirm,taxSaveCoverage,taxExcludeStay,taxExport,cleaningLoad,cleaningSetExcluded,outputPath,folderPath,alloggiatiFolderPath,get busy(){return busy;}};
}
module.exports={createService,defaults,atomicJson};
