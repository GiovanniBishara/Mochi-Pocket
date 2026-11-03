'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const queues=new Map();
const clone=value=>JSON.parse(JSON.stringify(value));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
class CleaningExclusionError extends Error {}
const fail=message=>{throw new CleaningExclusionError(message);};
function iso(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
function identity(initial,stay){
  if(!/^[A-Z]$/.test(initial)||!object(stay)||typeof stay.id!=='string'||! /^[a-f0-9]{32}$/.test(stay.id)
      ||typeof stay.name!=='string'||!stay.name.trim()||stay.name.length>180||/[\u0000-\u001f\u007f]/.test(stay.name)
      ||!iso(stay.arrival)||!iso(stay.departure)||stay.arrival>=stay.departure)fail('Riga delle pulizie non valida. Rileggi i calendari.');
  const result={initial,id:stay.id,name:stay.name,arrival:stay.arrival,departure:stay.departure};
  return {...result,revision:crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex')};
}
function validateStore(value){
  if(!object(value)||value.version!==1||!object(value.entries)||Object.keys(value).some(key=>!['version','entries'].includes(key))
      ||Object.keys(value.entries).length>10000)throw Error();
  for(const [key,entry]of Object.entries(value.entries)){
    if(!object(entry))throw Error();const expected=identity(entry.initial,entry);
    if(key!==entry.initial+':'+entry.id||entry.revision!==expected.revision||typeof entry.excludedAt!=='string'
        ||!Number.isFinite(Date.parse(entry.excludedAt))||new Date(entry.excludedAt).toISOString()!==entry.excludedAt
        ||Object.keys(entry).some(field=>!['initial','id','name','arrival','departure','revision','excludedAt'].includes(field)))throw Error();
  }
  return value;
}
function decorateCleaningReport(report,entries={}){
  if(!object(report)||report.ok!==true||!iso(report.today)||!Array.isArray(report.properties))fail('Conteggio pulizie non disponibile. Rileggi i calendari.');
  const result=clone(report);
  for(const property of result.properties){
    if(property.status==='error'){property.excludedCount=0;continue;}
    const originalUncertain=property.uncertain??[],stale=[];
    const decorate=(stay,uncertain)=>{
      const data=identity(property.initial,stay),entry=entries[property.initial+':'+stay.id];
      const excluded=entry?.revision===data.revision,exclusionChanged=!!entry&&!excluded;
      if(exclusionChanged)stale.push(stay.id);
      return {...stay,revision:data.revision,excluded,counted:!uncertain&&!excluded,uncertain,
        ...(exclusionChanged?{exclusionChanged:true,warnings:[...(stay.warnings??[]),'Il soggiorno è cambiato dopo l’esclusione: verifica se va ancora escluso.']}:{})};
    };
    const known=(property.stays??[]).map(stay=>decorate(stay,false));
    const uncertain=originalUncertain.map(stay=>decorate(stay,true));
    property.stays=[...known,...uncertain.filter(stay=>stay.excluded)].sort((a,b)=>a.departure.localeCompare(b.departure)||a.id.localeCompare(b.id));
    property.uncertain=uncertain.filter(stay=>!stay.excluded);
    const counted=known.filter(stay=>stay.counted);
    property.total=counted.length;property.past=counted.filter(stay=>stay.departure<report.today).length;
    property.todayCount=counted.filter(stay=>stay.departure===report.today).length;
    property.upcoming=counted.filter(stay=>stay.departure>report.today).length;
    property.excludedCount=property.stays.filter(stay=>stay.excluded).length;
    const unexplainedPartial=property.complete===false&&!originalUncertain.length&&!(property.warnings??[]).length;
    property.complete=!unexplainedPartial&&!property.uncertain.length&&!(property.warnings??[]).length&&!stale.length;
    property.status=property.complete?'ready':'partial';
  }
  const available=result.properties.filter(property=>property.status!=='error');
  result.totals=Object.fromEntries(['total','past','todayCount','upcoming'].map(key=>[key,available.length?available.reduce((sum,property)=>sum+property[key],0):null]));
  result.complete=result.properties.every(property=>property.complete);
  return result;
}
function createCleaningExclusions({filePath,now=()=>new Date()}={}){
  if(typeof filePath!=='string'||!path.isAbsolute(filePath))fail('Archivio esclusioni non configurato.');
  const target=path.resolve(filePath);
  async function read(){
    try{const stat=await fs.stat(target);if(stat.size>4*1024*1024)throw Error();return validateStore(JSON.parse((await fs.readFile(target,'utf8')).replace(/^\uFEFF/,'')));}
    catch(error){if(error.code==='ENOENT')return{version:1,entries:{}};fail('Archivio delle esclusioni non leggibile: nessuna scelta è stata sovrascritta.');}
  }
  function serialized(operation){const pending=(queues.get(target)??Promise.resolve()).catch(()=>{}).then(operation);queues.set(target,pending);const done=()=>{if(queues.get(target)===pending)queues.delete(target);};pending.then(done,done);return pending;}
  async function write(value){
    validateStore(value);await fs.mkdir(path.dirname(target),{recursive:true});const temporary=target+'.'+crypto.randomUUID()+'.tmp';
    try{const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
      for(let attempt=0;;attempt++){try{await fs.rename(temporary,target);break;}catch(error){if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4)throw error;await new Promise(resolve=>setTimeout(resolve,20*2**attempt));}}
    }finally{await fs.rm(temporary,{force:true});}
  }
  async function decorate(report){return serialized(async()=>decorateCleaningReport(report,(await read()).entries));}
  async function setExcluded(report,input){return serialized(async()=>{
    if(!object(input)||typeof input.excluded!=='boolean'||typeof input.revision!=='string'||!/^[a-f0-9]{64}$/.test(input.revision)
        ||input.year!==report.year||input.month!==report.month)fail('Seleziona una riga valida delle pulizie.');
    const property=report.properties?.find(item=>item.initial===input.initial);
    const matches=[...(property?.stays??[]),...(property?.uncertain??[])].filter(stay=>stay.id===input.id);
    if(!property||property.status==='error'||matches.length!==1)fail('La riga non è più disponibile. Rileggi i calendari.');
    const row=identity(input.initial,matches[0]);
    if(row.revision!==input.revision)fail('La riga è cambiata. Rileggi i calendari prima di modificarla.');
    const store=await read(),key=input.initial+':'+input.id;
    if(input.excluded){const timestamp=now();if(!(timestamp instanceof Date)||!Number.isFinite(timestamp.getTime()))fail('Data non valida.');
      store.entries[key]={...row,excludedAt:store.entries[key]?.revision===row.revision?store.entries[key].excludedAt:timestamp.toISOString()};
    }else delete store.entries[key];
    await write(store);return decorateCleaningReport(report,store.entries);
  });}
  return {decorate,setExcluded};
}
module.exports={createCleaningExclusions,decorateCleaningReport,identity,CleaningExclusionError};
