'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const failure='Controllo colori non completato. Verifica il collegamento Google e riprova.';
const identifier=value=>typeof value==='string'&&/^[\p{L}\p{N}_-]{1,120}$/u.test(value);
const safeText=value=>typeof value==='string'&&!/[a-z]:[\\/]|\\\\|(?:https?|file):\/\//i.test(value)
  ?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,240):'';
const iso=value=>typeof value==='string'&&/^(?:20|21)\d{2}-\d{2}-\d{2}$/.test(value)
  &&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

function normalizeAudit(value){
  if(!value||value.ok!==true||!Array.isArray(value.bookings)||value.bookings.length>1500)throw Error();
  return {ok:true,sourceFile:safeText(value.sourceFile),checkedAt:typeof value.checkedAt==='string'
      &&Number.isFinite(Date.parse(value.checkedAt))&&new Date(value.checkedAt).toISOString()===value.checkedAt?value.checkedAt:null,
    skipped:Number.isSafeInteger(value.skipped)&&value.skipped>=0?value.skipped:0,
    bookings:value.bookings.map(item=>{
      if(!item||!identifier(item.calendarId)||!identifier(item.bookingId)||!/^[A-Z]$/.test(item.initial)
          ||!Number.isInteger(item.year)||item.year<2000||item.year>2199||!Array.isArray(item.dates)
          ||!item.dates.length||item.dates.length>366||new Set(item.dates).size!==item.dates.length
          ||item.dates.some(date=>!iso(date)||date.slice(0,4)!==String(item.year))
          ||!Number.isInteger(item.nonYellowNights)||item.nonYellowNights<0||item.nonYellowNights>item.dates.length
          ||typeof item.revision!=='string'||!(/^[a-f0-9]{64}$/).test(item.revision))throw Error();
      return {calendarId:item.calendarId,bookingId:item.bookingId,initial:item.initial,year:item.year,
        reference:safeText(item.reference)||'Prenotazione',dates:[...item.dates].sort(),nonYellowNights:item.nonYellowNights,
        revision:item.revision,pending:item.pending===true};
    })};
}

function createKrossColorsAdapter({baseDir,engineDir,pythonPath,spawnImpl=spawn,timeoutMs=180000}={}){
  let busy=false;
  async function run(input,operation){
    if(busy)return {ok:false,error:'Un controllo colori è già in corso.'};
    const calendars=input?.calendars??['T','B','D'];
    if(!Array.isArray(calendars)||!calendars.length||calendars.length>26
        ||calendars.some(value=>typeof value!=='string'||!/^[A-Z]$/.test(value)))return {ok:false,error:'Seleziona almeno un calendario valido.'};
    const request={operation,calendars:[...new Set(calendars)]};
    if(operation==='apply'){
      if(input?.confirmed!==true||!identifier(input.calendarId)||!identifier(input.bookingId)
          ||typeof input.revision!=='string'||!/^[a-f0-9]{64}$/.test(input.revision))return {ok:false,error:'Scegli una prenotazione e conferma il ripristino del giallo.'};
      Object.assign(request,{calendarId:input.calendarId,bookingId:input.bookingId,revision:input.revision,confirmed:true});
    }
    if([baseDir,engineDir,pythonPath].some(value=>typeof value!=='string'||!path.isAbsolute(value)))return {ok:false,error:'Motore colori non disponibile.'};
    busy=true;
    try{
      try{for(const file of [path.join(baseDir,'config.json'),pythonPath,path.join(engineDir,'google_sheets.py')])if(!(await fs.stat(file)).isFile())throw Error();}
      catch{return {ok:false,error:'Motore colori non disponibile.'};}
      const child=spawnImpl(pythonPath,['-B',path.join(__dirname,'kross-colors.py'),'--engine-dir',engineDir,'--config',path.join(baseDir,'config.json')],
        {cwd:baseDir,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      return await new Promise(resolve=>{
        let output='',done=false;
        const finish=value=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
        const failed=()=>finish({ok:false,error:failure,...(operation==='apply'?{outcomeUnknown:true}:{})});
        const timer=setTimeout(()=>{child.kill?.();failed();},timeoutMs);timer.unref?.();
        child.stdout.on('data',data=>{output+=String(data);if(Buffer.byteLength(output,'utf8')>2*1024*1024){child.kill?.();failed();}});
        child.stderr.on('data',()=>{});child.stdin.on('error',failed);child.once('error',failed);
        child.once('close',code=>{
          try{
            const result=JSON.parse(output);
            if(result.ok===false){finish({ok:false,error:safeText(result.error)||failure,...(result.outcomeUnknown===true?{outcomeUnknown:true}:{})});return;}
            if(code!==0||result.ok!==true)throw Error();
            if(operation==='audit'){finish(normalizeAudit(result));return;}
            if(!Number.isInteger(result.updatedCells)||result.updatedCells<0||result.updatedCells>3660
                ||!Array.isArray(result.dates)||!result.dates.length||result.dates.length>366
                ||new Set(result.dates).size!==result.dates.length||result.dates.some(date=>!iso(date))
                ||result.updatedCells>result.dates.length*10)throw Error();
            finish({ok:true,message:safeText(result.message)||'Giallo riapplicato.',updatedCells:result.updatedCells,dates:result.dates});
          }catch{failed();}
        });
        child.stdin.end(JSON.stringify(request));
      });
    }catch{return {ok:false,error:failure,...(operation==='apply'?{outcomeUnknown:true}:{})};}
    finally{busy=false;}
  }
  return {audit:input=>run(input,'audit'),apply:input=>run(input,'apply')};
}
module.exports={createKrossColorsAdapter};
