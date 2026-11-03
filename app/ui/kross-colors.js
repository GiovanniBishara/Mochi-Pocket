'use strict';
(function expose(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.mochiKrossColorsUI=value;})(typeof window==='object'?window:globalThis,()=>{
  const houses={}; // filled by setHouses() from the configured calendars
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value.slice(8,10)+'/'+value.slice(5,7):'Data da verificare';
  function shell(){return `<details class="mp-kross-colors"><summary>Colori delle prenotazioni</summary><p class="mp-small-note">Mochi conserva i colori già presenti. Se vuoi riportare una prenotazione al giallo, controllala qui e usa Riapplica giallo. Questo sostituisce gli sfondi scelti a mano su quelle date; dopo potrai modificarli di nuovo.</p><button type="button" class="mp-secondary" data-colors-action="load" data-operation>Controlla colori</button><div class="mp-colors-results" aria-live="polite"></div></details>`;}
  function auditHtml(audit){
    const candidates=(audit.bookings||[]).filter(booking=>booking.nonYellowNights>0||booking.pending);
    const source=audit.sourceFile?`<p class="mp-small-note">Date dell’ultimo Excel elaborato: ${escape(audit.sourceFile)}</p>`:'';
    const note=audit.skipped?'<p class="mp-small-note">Alcune prenotazioni sono cambiate: ripeti Simula prima di ripristinarne i colori.</p>':'';
    if(!candidates.length)return source+'<p class="mp-small-note">Le prenotazioni controllate sono già gialle.</p>'+note;
    return source+candidates.map((booking,index)=>`<article class="mp-colors-booking"><strong>${escape(houses[booking.initial]||booking.initial)} · ${escape(booking.reference)}</strong><p>${booking.dates.map(date).map(escape).join(', ')} · ${booking.nonYellowNights} ${booking.nonYellowNights===1?'notte con altri colori':'notti con altri colori'}</p><button type="button" class="mp-secondary" data-colors-action="apply" data-candidate="${index}" data-operation>${booking.pending?'Completa ripristino':'Riapplica giallo'}</button></article>`).join('')+note;
  }
  function create({container,api,getBusy=()=>false,setBusy=()=>{},calendars=()=>[],message=()=>{},resize=()=>{}}){
    container.innerHTML=shell();let candidates=[],running=false;
    const results=container.querySelector('.mp-colors-results');
    async function audit(){
      const value=await api.krossColorsLoad({calendars:calendars()});
      if(!value?.ok)throw Error(value?.error||'Controllo colori non disponibile. Riprova.');
      candidates=(value.bookings||[]).filter(booking=>booking.nonYellowNights>0||booking.pending);
      results.innerHTML=auditHtml(value);return value;
    }
    async function load(){
      if(running||getBusy())return;running=true;setBusy(true);results.textContent='Controllo gli sfondi delle prenotazioni…';message('Controllo i colori sulle date dell’ultimo Excel.',false);
      try{await audit();message('Controllo colori completato. Nessuno sfondo modificato.',false);}
      catch(error){candidates=[];results.textContent=error.message;message(error.message,true);}
      finally{running=false;setBusy(false);resize();}
    }
    async function apply(index){
      if(running||getBusy())return;const booking=candidates[index];if(!booking)return;
      running=true;setBusy(true);message('Riapplico il giallo alla prenotazione selezionata.',false);
      try{
        const value=await api.krossColorsApply({calendarId:booking.calendarId,bookingId:booking.bookingId,revision:booking.revision,confirmed:true,calendars:calendars()});
        if(!value?.ok){candidates=[];results.textContent='Premi Controlla colori prima di riprovare.';message(value?.error||'Ripristino non completato. Controlla i colori prima di riprovare.',true);return;}
        // A fresh audit supplies new revisions. Never reuse a stale color selection.
        candidates=[];results.replaceChildren();
        try{await audit();message(value.message||'Giallo riapplicato. Puoi cambiare di nuovo i colori dal foglio.',false);}
        catch{results.textContent='Giallo riapplicato. Premi Controlla colori per rileggere l’elenco.';message(results.textContent,false);}
      }catch{candidates=[];results.textContent='Premi Controlla colori prima di riprovare.';message('Ripristino non verificato. Premi Controlla colori prima di riprovare.',true);}
      finally{running=false;setBusy(false);resize();}
    }
    container.addEventListener('click',event=>{const button=event.target.closest('[data-colors-action]');if(!button||button.disabled)return;if(button.dataset.colorsAction==='load')load();else apply(Number(button.dataset.candidate));});
    return {load,invalidate(){candidates=[];results.replaceChildren();}};
  }
  function setHouses(map){Object.assign(houses,map||{});}
  return {shell,auditHtml,create,setHouses};
});
