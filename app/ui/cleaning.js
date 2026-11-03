'use strict';
(function expose(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.mochiCleaningUI=value;})(typeof window==='object'?window:globalThis,()=>{
  const months=['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const number=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString('it-IT'):'—';
  const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4):'Da verificare';
  function shell(today){const year=Number(today.slice(0,4)),month=Number(today.slice(5,7));return `<div class="mp-heading"><h2>Pulizie</h2><span class="mp-badge">Per appartamento</span></div><p class="mp-intro">Una pulizia per ogni soggiorno in partenza. Il conteggio segue il giorno del check-out. Puoi escludere le righe che non corrispondono a una pulizia.</p><div class="mp-two"><label class="mp-field">Mese<select class="mp-cleaning-month" data-cleaning-control>${months.map((name,index)=>`<option value="${index+1}"${index+1===month?' selected':''}>${name}</option>`).join('')}</select></label><label class="mp-field">Anno<input class="mp-cleaning-year" data-cleaning-control type="number" min="2020" max="2100" value="${year}"></label></div><div class="mp-actions"><button type="button" class="mp-secondary" data-cleaning-action="refresh" data-operation>Rileggi calendari</button></div><p class="mp-small-note">I check-out fino a ieri, quelli di oggi e quelli futuri sono separati. Le date indicano pulizie previste dal calendario, da confrontare con quelle svolte dall’impresa.</p><div class="mp-cleaning-results" aria-live="polite"></div><p class="mp-small-note">Il prezzo delle pulizie pagato dagli ospiti non viene usato per calcolare il compenso dell’impresa.</p>`;}
  function cleaningRow(stay,initial,today){
    const excluded=stay.excluded===true;
    const warning=stay.uncertain===true&&!excluded;
    const canToggle=typeof stay.id==='string'&&/^[a-f0-9]{64}$/.test(stay.revision||'');
    const value=text=>`<span class="mp-cleaning-row-value">${text}</span>`;
    const badge=excluded?'<span class="mp-cleaning-excluded">Non conteggiata</span>':warning?'<span class="mp-cleaning-uncertain">Da verificare · non conteggiata</span>':'';
    return `<tr data-cleaning-row="${escape(stay.id)}" data-excluded="${excluded}"><td>${value(date(stay.departure)+(stay.departure===today?' · oggi':''))}</td><td>${value(escape(stay.name||'Ospite'))}${badge}${stay.warnings?.length?`<small class="mp-cleaning-stay-warning">${stay.warnings.map(escape).join('<br>')}</small>`:''}</td><td>${value(date(stay.arrival)+' → '+date(stay.departure))}</td><td class="mp-cleaning-row-action">${canToggle?`<button type="button" class="mp-link" data-cleaning-toggle="${escape(stay.id)}" data-initial="${escape(initial)}" data-operation aria-label="${excluded?'Reincludi':'Escludi'} ${escape(stay.name||'questa riga')} ${excluded?'nel':'dal'} conteggio">${excluded?'Reincludi':'Escludi'}</button>`:''}</td></tr>`;
  }
  function propertyCard(property,today){
    const metrics=[['past','Fino a ieri'],['todayCount','Oggi'],['upcoming','Prossime'],['total','Totale mese']];
    const stays=Array.isArray(property.stays)?property.stays:[];
    const uncertain=Array.isArray(property.uncertain)?property.uncertain:[];
    const rows=[...stays,...uncertain.map(stay=>({...stay,uncertain:true}))].sort((a,b)=>String(a.departure).localeCompare(String(b.departure))||String(a.id).localeCompare(String(b.id)));
    const excludedCount=rows.filter(stay=>stay.excluded===true).length;
    const summary=excludedCount||uncertain.length?`Vedi ${rows.length} righe${excludedCount?' · '+excludedCount+' non '+(excludedCount===1?'conteggiata':'conteggiate'):''}`:`Vedi ${rows.length} check-out`;
    return `<article class="mp-cleaning-card" data-initial="${escape(property.initial)}"><h3>${escape(property.name||property.initial)}</h3>${property.status==='error'?`<p class="mp-cleaning-error">${escape(property.error||'Calendario non disponibile. Riprova.')}</p>`:''}<div class="mp-cleaning-metrics">${metrics.map(([key,label])=>`<div><strong>${number(property[key])}</strong><span>${label}</span></div>`).join('')}</div>${property.complete===false&&property.status!=='error'?'<p class="mp-cleaning-error">Conteggio parziale: verifica i soggiorni segnalati.</p>':''}${excludedCount?`<p class="mp-small-note mp-cleaning-excluded-count">${excludedCount} ${excludedCount===1?'riga esclusa':'righe escluse'} dal totale. Puoi reincluderle quando vuoi.</p>`:''}${property.warnings?.length?`<ul class="mp-small-note">${property.warnings.map(warning=>`<li>${escape(warning)}</li>`).join('')}</ul>`:''}${rows.length?`<details class="mp-cleaning-details"><summary>${summary}</summary><div class="mp-summary-table"><table><thead><tr><th>Check-out</th><th>Soggiorno</th><th>Periodo</th><th>Conteggio</th></tr></thead><tbody>${rows.map(stay=>cleaningRow(stay,property.initial,today)).join('')}</tbody></table></div></details>`:property.status==='ready'?'<p class="mp-small-note">Nessun check-out nel mese selezionato.</p>':''}</article>`;
  }
  function reportHtml(report){return `<p class="mp-small-note">${escape(months[report.month-1]||'')} ${escape(report.year)} · aggiornato al ${date(report.today)}</p>${report.complete===false?'<p class="mp-cleaning-error">Alcuni calendari richiedono un controllo. I dati mancanti non sono contati come zero.</p>':''}<div class="mp-cleaning-cards">${(report.properties||[]).map(property=>propertyCard(property,report.today)).join('')}</div>`;}
  function create({container,api,today,getBusy=()=>false,setBusy=()=>{},message=()=>{},resize=()=>{}}){
    container.innerHTML=shell(today);
    let running=false,currentReport=null;
    const results=container.querySelector('.mp-cleaning-results');
    const scroll=container.closest('.mp-screen-content');
    function viewState(){return {top:scroll?.scrollTop,open:[...results.querySelectorAll('.mp-cleaning-card')].filter(card=>card.querySelector('details[open]')).map(card=>card.dataset.initial)};}
    function render(report,view){
      currentReport=report;results.innerHTML=reportHtml(report);
      for(const card of results.querySelectorAll('.mp-cleaning-card'))if(view?.open.includes(card.dataset.initial))card.querySelector('details')?.setAttribute('open','');
      if(scroll&&view?.top!==undefined)scroll.scrollTop=view.top;
    }
    async function load(refresh=false){
      if(running||getBusy())return;
      const year=Number(container.querySelector('.mp-cleaning-year').value),month=Number(container.querySelector('.mp-cleaning-month').value);
      if(!Number.isInteger(year)||year<2020||year>2100||!Number.isInteger(month)||month<1||month>12){message('Scegli un mese e un anno validi.',true);return;}
      const view=currentReport?.year===year&&currentReport?.month===month?viewState():null;
      running=true;setBusy(true);results.textContent='Leggo i check-out dai calendari…';message('Leggo le pulizie del mese dai check-out.',false);
      try{
        const report=await api.cleaningLoad({year,month,refresh});
        if(!report?.ok){currentReport=null;results.textContent=report?.error||'Non riesco a leggere i calendari. Premi Rileggi calendari.';message(results.textContent,true);return;}
        render(report,view);
        message(report.complete===false?'Conteggio disponibile con soggiorni da verificare.':'Conteggio delle pulizie aggiornato.',false,report.complete===false?{attention:true,tone:'attention',auth:false}:{});
      }catch{currentReport=null;results.textContent='Lettura non riuscita. Premi Rileggi calendari.';message(results.textContent,true);}
      finally{running=false;setBusy(false);resize();}
    }
    async function toggle(button){
      if(running||getBusy()||button.disabled||!currentReport)return;
      const property=currentReport.properties.find(item=>item.initial===button.dataset.initial);
      const row=[...(property?.stays||[]),...(property?.uncertain||[])].find(item=>item.id===button.dataset.cleaningToggle);
      if(!row)return;
      const input={year:currentReport.year,month:currentReport.month,initial:property.initial,id:row.id,excluded:row.excluded!==true,revision:row.revision};
      const view=viewState();running=true;setBusy(true);message(input.excluded?'Escludo la riga dal conteggio…':'Reincludo la riga nel conteggio…',false);
      try{
        const report=await api.cleaningSetExcluded(input);
        if(!report?.ok){message(report?.error||'Scelta non salvata. Riprova o rileggi i calendari.',true);return;}
        render(report,view);message(report.message||(input.excluded?'Riga esclusa: rimane visibile e non viene conteggiata.':'Riga reinclusa nel conteggio.'),false);
      }catch{message('Scelta non salvata. Riprova o rileggi i calendari.',true);}
      finally{running=false;setBusy(false);resize();}
    }
    container.querySelector('[data-cleaning-action="refresh"]').addEventListener('click',()=>load(true));
    container.addEventListener('click',event=>{const button=event.target.closest('[data-cleaning-toggle]');if(button)toggle(button);});
    for(const input of container.querySelectorAll('[data-cleaning-control]'))input.addEventListener('change',()=>load());
    return {load,invalidate(){currentReport=null;results.replaceChildren();}};
  }
  return {shell,reportHtml,create};
});
