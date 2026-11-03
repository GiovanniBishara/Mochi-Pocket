'use strict';
(function expose(root,factory){
  const value=factory();
  if(typeof module==='object'&&module.exports)module.exports=value;
  else root.mochiTaxUI=value;
})(typeof window==='object'?window:globalThis,()=>{
  const taxMonths=['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function shell(today){return `<div class="mp-heading"><h2>Tassa di soggiorno</h2><span class="mp-badge mp-tax-status">Provvisorio</span></div>
    <p class="mp-intro">Controlla le righe e conferma i conteggi insieme. Correggi qui i minori esenti; i soggiorni già confermati si aggiornano da soli quando li modifichi.</p>
    <p class="mp-tax-rate">Milano · CAV / locazioni brevi · 2026: 9,50 € a persona per notte, massimo 14 notti consecutive.</p>
    <div class="mp-tax-filters"><label class="mp-field">Struttura<select class="mp-tax-property" data-tax-control></select></label><label class="mp-field">Anno<select class="mp-tax-year" data-tax-control>${[2026,2027].map(year=>`<option value="${year}" ${year===Number(today.slice(0,4))?'selected':''}>${year}</option>`).join('')}</select></label><label class="mp-field">Mese o trimestre<select class="mp-tax-period-picker" data-tax-control><optgroup label="Mesi">${taxMonths.map((month,index)=>`<option value="M${index+1}" ${index+1===Number(today.slice(5,7))?'selected':''}>${month}</option>`).join('')}</optgroup><optgroup label="Trimestri">${[1,2,3,4].map(quarter=>`<option value="Q${quarter}">${quarter}° trimestre</option>`).join('')}</optgroup></select></label></div>
    <label class="mp-field mp-tax-allocation-field">Attribuisci il soggiorno<select class="mp-tax-allocation" data-tax-control><option value="arrival" selected>Mese di arrivo · intero soggiorno</option><option value="nights">Date effettive dei pernottamenti</option></select></label><p class="mp-small-note mp-tax-allocation-note">L’intero soggiorno viene conteggiato una sola volta nel mese in cui inizia.</p>
    <div class="mp-actions mp-tax-tools"><button type="button" class="mp-primary" data-action="tax-load" data-operation>Leggi calendario</button><button type="button" class="mp-secondary" data-action="tax-kross" data-operation>Importa Excel Kross</button><button type="button" class="mp-secondary" data-action="tax-add" data-operation>Aggiungi soggiorno</button></div>
    <p class="mp-small-note">Le proposte da Kross restano da confermare. Dove manca il dettaglio, sono proposti tutti adulti: indica gli eventuali minori prima di confermare. “Portale” mantiene separata l’imposta gestita da Airbnb.</p>
    <p class="mp-result" data-result="tasse" role="status" aria-live="polite"></p>
    <section class="mp-tax-summary" aria-label="Riepilogo del periodo"><p class="mp-tax-pending">Leggi i soggiorni o aggiungine uno per iniziare.</p><div class="mp-tax-metrics mp-tax-simple-metrics"><div><span>Adulti paganti · arrivi</span><strong class="mp-tax-adult-total">—</strong><small class="mp-tax-adult-nights"></small></div><div><span>Ospiti esenti · arrivi</span><strong class="mp-tax-exempt-total">—</strong><small class="mp-tax-exempt-nights"></small></div><div><span class="mp-tax-host-label">Imposta a mio carico</span><strong class="mp-tax-host">—</strong><small class="mp-tax-host-people"></small></div></div><p class="mp-small-note mp-tax-portal-note">Gestito dal portale: <strong class="mp-tax-portal">—</strong> <span class="mp-tax-portal-people"></span></p><p class="mp-small-note mp-tax-period"></p><div class="mp-summary-table mp-tax-table"></div><ul class="mp-tax-issues" hidden></ul></section>
    <div class="mp-tax-list-heading"><h3>Controllo soggiorni</h3><span class="mp-tax-stay-count">0</span></div><p class="mp-small-note mp-tax-quick-note">Confermare una riga significa aver verificato date, adulti, minori ed esenzioni e chi versa l’imposta. Per date diverse o altre esenzioni usa Dettagli.</p><div class="mp-tax-bulk"><button type="button" class="mp-primary" data-action="tax-confirm-visible" data-operation disabled>Conferma conteggi</button><span class="mp-tax-bulk-note"></span></div><div class="mp-tax-stays" aria-label="Conteggi dei soggiorni"></div>
    <details class="mp-tax-completeness"><summary>Controllo di completezza del periodo</summary><fieldset class="mp-tax-coverage"><legend>Mesi controllati</legend><p class="mp-small-note">Indica i mesi conclusi per cui hai verificato che non manchino soggiorni. Il mese in corso è sempre consultabile.</p><div class="mp-tax-month-checks"></div><button type="button" class="mp-secondary" data-action="tax-coverage" data-operation>Conferma controllo mesi</button></fieldset></details>
    <section class="mp-tax-editor" hidden aria-label="Conferma dati del soggiorno"><div class="mp-tax-editor-heading"><h3>Conteggi del soggiorno</h3><button type="button" class="mp-link" data-action="tax-cancel">Chiudi</button></div>
    <form id="tax-stay-form"><label class="mp-field">Nome / riferimento<input name="name" maxlength="160" required data-tax-control autocomplete="off"></label><div class="mp-two"><label class="mp-field">Arrivo<input name="arrival" type="date" required data-tax-control></label><label class="mp-field">Partenza<input name="departure" type="date" required data-tax-control></label></div><p class="mp-small-note mp-tax-source"></p>
    <div class="mp-two"><label class="mp-field">Adulti · 18 anni o più<input name="adults" type="number" min="0" step="1" required data-tax-control inputmode="numeric" placeholder="Da confermare"></label><label class="mp-field">Minori · da 0 a 17 anni<input name="minors" type="number" min="0" step="1" required data-tax-control inputmode="numeric" placeholder="Da confermare"></label></div>
    <label class="mp-field">Altri adulti esenti<input name="otherExemptAdults" type="number" min="0" step="1" value="0" required data-tax-control inputmode="numeric"></label><p class="mp-small-note">Sono compresi negli adulti indicati sopra. I minori sono conteggiati separatamente.</p><label class="mp-field">Motivo dell’esenzione degli adulti<input name="exemptionReason" maxlength="600" data-tax-control placeholder="Obbligatorio se ci sono adulti esenti"></label>
    <label class="mp-field">Chi gestisce il versamento?<select name="collection" required data-tax-control><option value="">Scegli dopo aver verificato</option><option value="host">Da versare da me</option><option value="portal">Gestito dal portale</option></select></label>
    <details class="mp-tax-advanced"><summary>Soggiorno consecutivo già iniziato</summary><label class="mp-field">Notti consecutive precedenti<input name="previousConsecutiveNights" type="number" min="0" step="1" value="0" required data-tax-control inputmode="numeric"></label><p class="mp-small-note">Indica le notti già trascorse nella stessa struttura prima di questo segmento. La continuazione mantiene il limite di 14 notti e non conta un nuovo arrivo.</p></details>
    <ul class="mp-tax-stay-warnings" hidden></ul><label class="mp-tax-confirm"><input name="confirmation" type="checkbox" required data-tax-control><span>Confermo date, conteggi, esenzioni e gestione del versamento. Tutti gli ospiti hanno le stesse date; la fascia d’età di ciascuno resta invariata per tutto il soggiorno.</span></label><p class="mp-small-note">Se le date sono diverse o un ospite compie 18 anni durante il soggiorno, registra segmenti separati.</p><div class="mp-actions"><button type="button" class="mp-primary" data-action="tax-save" data-operation>Salva conferma</button><button type="button" class="mp-secondary" data-action="tax-cancel">Annulla</button></div>
    <details class="mp-tax-advanced mp-tax-exclude"><summary>Soggiorno non effettuato o inserito per errore</summary><p class="mp-small-note">L’esclusione conserva il soggiorno e il motivo. Puoi riaprirlo e confermare nuovamente i conteggi.</p><label class="mp-field">Motivo dell’esclusione<textarea name="exclusionReason" maxlength="600" data-tax-control></textarea></label><label class="mp-tax-confirm"><input name="exclusionConfirmation" type="checkbox" data-tax-control><span>Confermo che questo soggiorno deve essere escluso dal riepilogo.</span></label><button type="button" class="mp-secondary" data-action="tax-exclude" data-operation>Escludi dal riepilogo</button></details></form></section>
    <div class="mp-actions mp-tax-export"><button type="button" class="mp-secondary" data-action="tax-export" data-operation disabled>Esporta riepilogo provvisorio</button><button type="button" class="mp-link" data-action="tax-open" hidden>Apri riepilogo</button></div>`;}

  function create({container,api,today,houseNames,getBusy=()=>false,setBusy=()=>{},message=()=>{},clearAlert=()=>{},resize=()=>{},sfx=()=>{},quick=globalThis.mochiTaxQuick}){
    container.innerHTML=shell(today);
    const q=selector=>container.querySelector(selector);
    const qa=selector=>[...container.querySelectorAll(selector)];
    const scrollContainer=container.closest('.mp-screen-content');
    const taxQuick=quick,taxQuickDrafts=new Map();
    let taxStays=[],taxReport=null,taxDraft=null,taxSelected=-1,taxOutput=null,taxContextKey='';

    const taxStaleReasons={source_changed:'Il calendario è cambiato: ricontrolla i dati.',source_missing:'Il soggiorno non compare più nel calendario: verifica o escludilo.'};
    function taxContext(){const period=q('.mp-tax-period-picker').value,month=period.startsWith('M')?Number(period.slice(1)):undefined;return {initial:q('.mp-tax-property').value,year:Number(q('.mp-tax-year').value),quarter:month?Math.ceil(month/3):Number(period.slice(1)),...(month?{month}:{}),allocation:q('.mp-tax-allocation').value};}
    function taxKey(context=taxContext()){return [context.initial,context.year,context.quarter,context.month||'Q',context.allocation].join(':');}
    function taxMoney(cents){return Number.isSafeInteger(cents)?(cents/100).toLocaleString('it-IT',{style:'currency',currency:'EUR'}):'—';}
    function taxNumber(value){return Number.isSafeInteger(value)&&value>=0?value.toLocaleString('it-IT'):'—';}
    function taxDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4):'Date da verificare';}
    function syncTaxButtons(){q('[data-action="tax-export"]').disabled=getBusy()||!taxReport;q('[data-action="tax-open"]').hidden=!taxOutput;syncTaxQuickButtons();}
    function renderTaxCoverage(){
      const context=taxContext(),months=taxReport?.coverage?.months||[];
      q('.mp-tax-month-checks').innerHTML=(context.month?[context.month]:Array.from({length:3},(_,index)=>(context.quarter-1)*3+index+1)).map(month=>{
        const end=`${context.year+(month===12?1:0)}-${String(month===12?1:month+1).padStart(2,'0')}-01`,available=today>=end;
        return `<label><input type="checkbox" value="${month}" ${available&&months.includes(month)?'checked':''} ${available?'':'disabled data-tax-unavailable="true"'} data-tax-control>${taxMonths[month-1]}${available?'':' · da concludere'}</label>`;
      }).join('');
    }
    function renderTaxReport(){
      const report=taxReport,provisional=!report||report.isProvisional!==false,arrival=taxContext().allocation==='arrival';
      q('.mp-tax-allocation-note').textContent=arrival?'L’intero soggiorno viene conteggiato una sola volta nel mese in cui inizia, anche se termina nel mese, trimestre o anno successivo.':'I pernottamenti sono ripartiti nei mesi in cui avvengono. Gli ospiti si contano come arrivi solo all’inizio del soggiorno.';
      q('.mp-tax-host-label').textContent=arrival?'Imposta a mio carico':'Da versare da me';
      q('.mp-tax-rate').textContent=report?.rate?.nightlyCents===null?'Tariffa da verificare per tutte le date del soggiorno; importi non disponibili.':taxContext().year===2026?'Milano · CAV / locazioni brevi · 2026: 9,50 € a persona per notte, massimo 14 notti consecutive.':'Milano · CAV / locazioni brevi · 2027: tariffa da verificare; importi non calcolati.';
      q('.mp-tax-status').textContent=provisional?'Provvisorio':'Completo';q('.mp-tax-status').dataset.complete=String(!provisional);
      q('.mp-tax-pending').textContent=!report?'Leggi i soggiorni o aggiungine uno per iniziare.':`${taxNumber(report.confirmedCount)} soggiorni confermati · ${taxNumber(report.pendingCount)} da verificare`;
      q('.mp-tax-host').textContent=taxMoney(report?.totals?.hostDueCents);q('.mp-tax-portal').textContent=taxMoney(report?.totals?.portalTaxCents);
      q('.mp-tax-adult-total').textContent=taxNumber(report?.totals?.arrivalsLiableAdults);q('.mp-tax-exempt-total').textContent=taxNumber(report?.totals?.arrivalsExemptGuests);
      q('.mp-tax-adult-nights').textContent=report?taxNumber(report.totals.taxableNights)+' pernottamenti imponibili':'';q('.mp-tax-exempt-nights').textContent=report?taxNumber(report.totals.exemptNights)+' pernottamenti esenti':'';
      for(const prefix of ['host','portal']){const totals=report?.totals,adults=totals?.[prefix+'ArrivalsAdults'],minors=totals?.[prefix+'ArrivalsMinors'],nights=totals?.[prefix+'GuestNights'];q('.mp-tax-'+prefix+'-people').textContent=[adults,minors,nights].every(value=>Number.isSafeInteger(value)&&value>=0)?taxNumber(adults+minors)+' arrivi · '+taxNumber(nights)+' pernottamenti':'';}
      const context=taxContext(),label=context.month?taxMonths[context.month-1]+' '+context.year:context.quarter+'° trimestre '+context.year;
      q('.mp-tax-period').textContent=!report?'':label+' · '+(report.period?.ended===false?'periodo in corso; conteggi provvisori sui soggiorni confermati.':provisional?'conteggi dei soggiorni confermati; completa il controllo del periodo.':'conteggi e completezza verificati.');
      const months=Array.isArray(report?.months)?report.months:[];
      const councilRow=(value,prefix,label)=>`<tr><th>${escape(label)}</th><td>${taxNumber(value[prefix+'ArrivalsLiableAdults'])}</td><td>${taxNumber(value[prefix+'ArrivalsExemptGuests'])}</td><td>${taxNumber(value[prefix+'TaxableNights'])}</td><td>${taxNumber(value[prefix+'ExemptNights'])}</td><td>${taxMoney(value[prefix==='host'?'hostDueCents':'portalTaxCents'])}</td></tr>`;
      q('.mp-tax-table').innerHTML=report?`<table><caption>${arrival?'Interi soggiorni iniziati nel periodo':'Pernottamenti nelle date effettive'} · gli arrivi sono persone, i pernottamenti sono persone × notti</caption><thead><tr><th>Gestione</th><th>Adulti<br>paganti</th><th>Ospiti<br>esenti</th><th>Pernott.<br>imponibili</th><th>Pernott.<br>esenti</th><th>Imposta</th></tr></thead><tbody>${councilRow(report.totals,'host',arrival?'Imposta a mio carico':'Da versare da me')}${councilRow(report.totals,'portal','Gestito dal portale')}</tbody></table>${months.length>1?`<table class="mp-tax-month-totals"><caption>Controllo mensile</caption><thead><tr><th>Mese</th><th>Adulti</th><th>Esenti</th><th>Notti imponibili</th><th>Notti esenti</th><th>Da versare</th></tr></thead><tbody>${months.map(month=>`<tr><th>${escape(taxMonths[month.month-1])}</th><td>${taxNumber(month.arrivalsLiableAdults)}</td><td>${taxNumber(month.arrivalsExemptGuests)}</td><td>${taxNumber(month.taxableNights)}</td><td>${taxNumber(month.exemptNights)}</td><td>${taxMoney(month.hostDueCents)}</td></tr>`).join('')}</tbody></table>`:''}`:'';
      const issues=(Array.isArray(report?.issues)?report.issues:[]).filter(issue=>!['coverage_incomplete','period_not_ended','unconfirmed_stays'].includes(issue.code));q('.mp-tax-issues').hidden=!issues.length;q('.mp-tax-issues').innerHTML=issues.map(issue=>`<li>${escape(typeof issue==='string'?issue:issue.message||'Dato da verificare.')}</li>`).join('');
      q('[data-action="tax-export"]').textContent=provisional?'Esporta riepilogo provvisorio':'Esporta riepilogo';renderTaxCoverage();syncTaxButtons();
    }
    function renderTaxStays(){
      const container=q('.mp-tax-stays'),context=taxContext(),periodLabel=context.month?'mese':'trimestre';q('.mp-tax-stay-count').textContent=String(taxStays.length);
      container.innerHTML=taxStays.length?taxStays.map((stay,index)=>{
        const nights=taxQuick.periodNights(stay,context);
        const proposal=taxQuick.quickProposal(stay),data=taxQuickValues(stay),status=stay.status,label=status==='confirmed'?'Confermato':status==='stale'?'Da rivedere':status==='excluded'?'Escluso':'Proposta da confermare',editable=proposal.eligible||proposal.editableTotal;
        const origin=proposal.basis==='notes'?'Proposta dalle note Kross':proposal.basis==='kross'?'Proposta da Kross':proposal.basis==='saved'?'Conteggi confermati':'Proposta: tutti adulti';
        return `<article class="mp-tax-quick-row" data-quick-row="${index}" data-status="${escape(status)}"><div class="mp-tax-quick-heading"><strong>${escape(stay.name||'Soggiorno senza nome')}</strong><span class="mp-tax-stay-badge">${label}</span></div><p class="mp-tax-quick-dates">${taxDate(stay.arrival)} → ${taxDate(stay.departure)} · ${escape(stay.channel||'Canale da verificare')}${Number.isSafeInteger(proposal.total)?' · '+proposal.total+' ospiti':''}</p>${nights?`<p class="mp-tax-period-nights">${nights.inPeriod} ${nights.inPeriod===1?'notte':'notti'} ${context.allocation==='arrival'?'attribuite al':'nel'} ${periodLabel}${nights.outsidePeriod?' · '+nights.total+' nell’intero soggiorno':''}</p>`:''}${editable?`<div class="mp-tax-quick-fields">${proposal.editableTotal?`<label>Ospiti totali<input type="number" min="1" step="1" data-quick-field="total" data-tax-control value="${escape(data.total??'')}" aria-label="Ospiti totali di ${escape(stay.name)}"></label>`:''}<label>Adulti 18+<output class="mp-tax-quick-adults">${taxNumber(taxQuickAdultCount(data))}</output></label><label>Minori esenti<input type="number" min="0" ${Number.isSafeInteger(Number(data.total))?'max="'+Number(data.total)+'"':''} step="1" data-quick-field="minors" data-tax-control value="${escape(data.minors??'')}" aria-label="Minori esenti di ${escape(stay.name)}"></label><label>Versamento<select data-quick-field="collection" data-tax-control aria-label="Gestione imposta di ${escape(stay.name)}"><option value="" ${!data.collection?'selected':''}>Scegli</option><option value="host" ${data.collection==='host'?'selected':''}>Da me</option><option value="portal" ${data.collection==='portal'?'selected':''}>Portale</option></select></label><button type="button" class="mp-secondary mp-tax-quick-confirm" data-quick-confirm="${index}" data-operation>${status==='confirmed'?'Confermato ✓':'Conferma'}</button></div><p class="mp-tax-quick-source">${escape(origin)}${proposal.otherExemptAdults?' · '+proposal.otherExemptAdults+' adulti esenti già registrati':''}</p>`:`<p class="mp-tax-quick-source">${escape(stay.status==='excluded'?'Escluso dal riepilogo.':proposal.reason||'Controlla i dettagli.')}</p>`}<div class="mp-tax-quick-footer"><span class="mp-tax-quick-feedback" role="status"></span><button type="button" class="mp-link" data-tax-stay="${index}">Dettagli</button></div></article>`;
      }).join(''):'<p class="mp-tax-empty">Nessun soggiorno in questo periodo. Leggi il calendario o importa l’Excel Kross.</p>';
      syncTaxQuickButtons();
    }
    function taxQuickValues(stay){const proposal=taxQuick.quickProposal(stay),draft=taxQuickDrafts.get(stay.id);return draft&&draft.sourceFingerprint===stay.sourceFingerprint?draft:{total:proposal.total,minors:proposal.minors??0,collection:proposal.collection,sourceFingerprint:stay.sourceFingerprint};}
    function taxQuickInteger(value){return value!==null&&value!==undefined&&String(value).trim()!==''&&/^\d+$/.test(String(value))?Number(value):NaN;}
    function taxQuickAdultCount(data){const total=taxQuickInteger(data.total),minors=taxQuickInteger(data.minors);return Number.isSafeInteger(total)&&Number.isSafeInteger(minors)&&total>=minors?total-minors:null;}
    function taxQuickRow(stay){const data=taxQuickValues(stay),row={id:stay.id,sourceFingerprint:stay.sourceFingerprint,total:taxQuickInteger(data.total),minors:taxQuickInteger(data.minors),collection:data.collection};try{taxQuick.quickConfirmation(stay,{...row,confirmed:true});return row;}catch{return null;}}
    function taxQuickChanged(stay){const data=taxQuickValues(stay),proposal=taxQuick.quickProposal(stay);return stay.status!=='confirmed'||taxQuickInteger(data.minors)!==proposal.minors||data.collection!==proposal.collection;}
    function syncTaxQuickButtons(){
      if(!q('[data-action="tax-confirm-visible"]'))return;
      const rows=taxStays.filter(stay=>taxQuickChanged(stay)&&taxQuickRow(stay));
      const bulk=q('[data-action="tax-confirm-visible"]');bulk.disabled=getBusy()||!rows.length;bulk.textContent=rows.length?'Conferma '+rows.length+' '+(rows.length===1?'riga':'righe'):taxReport?.pendingCount?'Completa i conteggi':'Conteggi confermati';
      q('.mp-tax-bulk-note').textContent=rows.length?'Verifica adulti, esenti e versamento nelle righe qui sotto.':taxReport?.pendingCount?'Completa le righe mancanti o apri i dettagli indicati.':'Le modifiche ai conteggi confermati si salvano automaticamente.';
      for(const button of qa('[data-quick-confirm]')){const stay=taxStays[Number(button.dataset.quickConfirm)],valid=taxQuickRow(stay),changed=taxQuickChanged(stay),done=stay.status==='confirmed'&&!changed;button.disabled=getBusy()||!valid||!changed;button.textContent=done?'✓':'Conferma';button.setAttribute('aria-label',done?'Conteggi confermati':'Conferma conteggi di '+stay.name);button.classList.toggle('mp-tax-quick-done',done);}
    }
    async function confirmTaxQuick(index){
      if(getBusy())return;
      const selected=index===undefined
        ?taxStays.filter(stay=>taxQuickChanged(stay)&&taxQuickRow(stay))
        :[taxStays[index]];
      const rows=selected.map(stay=>taxQuickRow(stay));
      if(!rows.length||rows.some(row=>!row))return;
      const context=taxContext();
      const scrollTop=scrollContainer.scrollTop;
      const result=await taxOperation('Aggiorno i conteggi…',
        ()=>api.taxQuickConfirm({...context,confirmed:true,rows}));
      if(!result)return;
      for(const stay of selected)taxQuickDrafts.delete(stay.id);
      if(acceptTaxResult(result,context)){
        scrollContainer.scrollTop=scrollTop;
        message(rows.length===1?'Conteggi aggiornati.':'Conteggi confermati: '+rows.length+' soggiorni.',
          false,{tone:'success'});
      }
    }
    function closeTaxEditor(){taxDraft=null;taxSelected=-1;q('.mp-tax-editor').hidden=true;renderTaxStays();}
    function editTaxStay(stay,index=-1){
      if(getBusy())return;taxDraft={...stay};taxSelected=index;const form=q('#tax-stay-form');form.reset();
      for(const name of ['name','arrival','departure','exemptionReason'])form.elements[name].value=typeof stay[name]==='string'?stay[name]:'';
      for(const name of ['adults','minors'])form.elements[name].value=Number.isSafeInteger(stay[name])&&stay[name]>=0?String(stay[name]):'';
      form.elements.otherExemptAdults.value=Number.isSafeInteger(stay.otherExemptAdults)?String(stay.otherExemptAdults):'0';form.elements.previousConsecutiveNights.value=Number.isSafeInteger(stay.previousConsecutiveNights)?String(stay.previousConsecutiveNights):'0';
      form.elements.collection.value=['host','portal'].includes(stay.collection)?stay.collection:'';form.elements.confirmation.checked=false;
      form.elements.exclusionReason.value=typeof stay.exclusion?.reason==='string'?stay.exclusion.reason:'';form.elements.exclusionReason.setCustomValidity('');form.elements.exclusionConfirmation.checked=false;form.elements.exclusionConfirmation.setCustomValidity('');q('.mp-tax-exclude').hidden=!stay.id;q('.mp-tax-exclude').open=false;
      form.elements.exemptionReason.required=Number(form.elements.otherExemptAdults.value)>0;form.elements.otherExemptAdults.setCustomValidity('');form.elements.adults.setCustomValidity('');form.elements.departure.setCustomValidity('');
      q('.mp-tax-source').textContent=stay.manual?'Soggiorno aggiunto a mano. Conferma date e persone presenti.':`Date lette dal calendario${Number.isSafeInteger(stay.guestCount)?' · '+stay.guestCount+' '+(stay.guestCount===1?'ospite indicato':'ospiti indicati'):''}. Verifica e conferma le persone effettivamente presenti.`;
      const warnings=[...(Array.isArray(stay.warnings)?stay.warnings:[]),...(stay.staleReason?[taxStaleReasons[stay.staleReason]||'I dati del soggiorno richiedono una nuova verifica.']:[])];q('.mp-tax-stay-warnings').hidden=!warnings.length;q('.mp-tax-stay-warnings').innerHTML=warnings.map(warning=>`<li>${escape(typeof warning==='string'?warning:warning.message||'Dato da verificare.')}</li>`).join('');
      q('.mp-tax-editor').hidden=false;renderTaxStays();q('.mp-tax-editor').scrollIntoView({block:'start'});form.elements.name.focus();
    }
    function acceptTaxResult(result,context){
      if(taxKey(context)!==taxKey())return false;
      taxContextKey=taxKey(context);
      taxStays=Array.isArray(result.stays)?result.stays:[];
      taxReport=result.report||null;
      taxOutput=null;
      for(const [id,draft] of taxQuickDrafts){
        const stay=taxStays.find(stay=>stay.id===id);
        const proposal=stay?taxQuick.quickProposal(stay):null;
        if(!stay||draft.sourceFingerprint!==stay.sourceFingerprint
            ||(!proposal.editableTotal&&proposal.total!==taxQuickInteger(draft.total))){
          taxQuickDrafts.delete(id);
        }
      }
      closeTaxEditor();
      if(Array.isArray(result.properties)&&result.properties.length){
        q('.mp-tax-property').innerHTML=result.properties
          .filter(property=>['T','B','D'].includes(property.initial))
          .map(property=>`<option value="${escape(property.initial)}">${escape(property.name||houseNames[property.initial])}</option>`)
          .join('');
        q('.mp-tax-property').value=context.initial;
      }
      renderTaxReport();
      return true;
    }
    async function taxOperation(text,callback){
      if(getBusy())return null;
      clearAlert();
      setBusy(true);
      message(text,false,{tone:'working'});
      try{
        const result=await callback();
        if(!result?.ok){
          message(result?.error||result?.message||'Operazione non completata. I dati salvati restano disponibili.',true);
          return null;
        }
        clearAlert();
        return result;
      }catch{
        message('Non riesco a completare l’operazione. Riprova dalla tassa di soggiorno.',true,{auth:false});
        return null;
      }finally{
        setBusy(false);
        resize();
      }
    }
    async function loadTaxes(refreshSource=false){
      const picker=q('.mp-tax-property');
      if(!picker.options.length)picker.innerHTML=Object.entries(houseNames).map(([initial,name])=>`<option value="${escape(initial)}">${escape(name)}</option>`).join('');
      const context=taxContext(),key=taxKey(context);
      if(key!==taxContextKey){
        taxQuickDrafts.clear();
        taxStays=[];
        taxReport=null;
        taxOutput=null;
        closeTaxEditor();
        renderTaxReport();
      }
      const result=await taxOperation(
        refreshSource?'Leggo i soggiorni del periodo…':'Leggo i conteggi salvati…',
        ()=>typeof api.taxLoad==='function'?api.taxLoad({...context,refresh:refreshSource})
          :{ok:false,error:'La tassa di soggiorno non è disponibile in questa versione dell’app.'});
      if(result&&acceptTaxResult(result,context)){
        message(refreshSource?'Soggiorni letti. Controlla e conferma i conteggi.':'Conteggi salvati caricati.',false);
      }
      return result;
    }
    async function importTaxKross(){
      if(getBusy())return;
      const selection=await api.chooseKross();
      if(!selection?.ok){if(!selection?.canceled)message(selection?.error||'Non riesco ad aprire l’Excel Kross.',true);return;}
      const context=taxContext();
      const result=await taxOperation('Leggo i soggiorni dall’Excel Kross…',()=>api.taxLoad({...context,refresh:true,source:'kross'}));
      if(result&&acceptTaxResult(result,context))message('Excel letto. Conferma i conteggi e ricontrolla i mesi coperti.',false,{tone:'success'});
    }
    async function saveTaxStay(){
      if(!taxDraft||getBusy())return;const form=q('#tax-stay-form'),adults=Number(form.elements.adults.value),minors=Number(form.elements.minors.value),exempt=Number(form.elements.otherExemptAdults.value);
      form.elements.adults.setCustomValidity(form.elements.adults.value!==''&&form.elements.minors.value!==''&&adults+minors===0?'Indica almeno un ospite.':'');form.elements.otherExemptAdults.setCustomValidity(exempt>adults?'Gli adulti esenti devono essere compresi nel numero degli adulti.':'');form.elements.departure.setCustomValidity(form.elements.departure.value<=form.elements.arrival.value?'La partenza deve essere dopo l’arrivo.':'');form.elements.exemptionReason.required=exempt>0;if(!form.reportValidity())return;
      const context=taxContext(),record={...taxDraft,...context,name:form.elements.name.value.trim(),arrival:form.elements.arrival.value,departure:form.elements.departure.value,adults,minors,otherExemptAdults:exempt,exemptionReason:form.elements.exemptionReason.value.trim(),collection:form.elements.collection.value,previousConsecutiveNights:Number(form.elements.previousConsecutiveNights.value),confirmed:true,sameDatesConfirmed:true};
      const result=await taxOperation('Salvo la conferma del soggiorno…',()=>api.taxSaveStay(record));if(result&&acceptTaxResult(result,context)){message('Conteggi confermati e salvati in Mochi.',false,{tone:'success'});sfx('success');}
    }
    async function saveTaxCoverage(){const context=taxContext(),months=qa('.mp-tax-month-checks input:checked').map(input=>Number(input.value));const result=await taxOperation('Salvo il controllo dei mesi…',()=>api.taxSaveCoverage({...context,months}));if(result&&acceptTaxResult(result,context)){message('Controllo dei mesi salvato.',false,{tone:'success'});sfx('success');}}
    async function excludeTaxStay(){
      if(!taxDraft?.id||getBusy())return;const form=q('#tax-stay-form'),reason=form.elements.exclusionReason.value.trim();form.elements.exclusionReason.setCustomValidity(reason?'':'Indica il motivo dell’esclusione.');form.elements.exclusionConfirmation.setCustomValidity(form.elements.exclusionConfirmation.checked?'':'Conferma esplicitamente l’esclusione.');if(!form.elements.exclusionReason.reportValidity()||!form.elements.exclusionConfirmation.reportValidity())return;
      const context=taxContext(),result=await taxOperation('Salvo l’esclusione del soggiorno…',()=>api.taxExcludeStay({...context,id:taxDraft.id,sourceFingerprint:taxDraft.sourceFingerprint??null,reason,confirmed:true}));if(result&&acceptTaxResult(result,context)){message('Soggiorno escluso dal riepilogo. Il motivo resta salvato in Mochi.',false,{tone:'success'});sfx('success');}
    }
    async function exportTaxes(){const context=taxContext();const result=await taxOperation('Preparo il riepilogo…',()=>api.taxExport(context));if(result&&taxKey(context)===taxKey()){taxOutput=result.outputId||null;syncTaxButtons();message(result.message||'Riepilogo salvato: '+(result.filename||'documento HTML'),false,{tone:'success'});sfx('success');}}
    for(const selector of ['.mp-tax-property','.mp-tax-year','.mp-tax-period-picker','.mp-tax-allocation'])q(selector).addEventListener('change',()=>loadTaxes(false));
    function captureTaxQuickInput(input){
      const row=input.closest('[data-quick-row]');if(!row||getBusy())return null;
      const stay=taxStays[Number(row.dataset.quickRow)],data={...taxQuickValues(stay),[input.dataset.quickField]:input.value,sourceFingerprint:stay.sourceFingerprint};taxQuickDrafts.set(stay.id,data);
      const minorInput=row.querySelector('[data-quick-field="minors"]'),total=taxQuickInteger(data.total);if(Number.isSafeInteger(total))minorInput.max=String(total);else minorInput.removeAttribute('max');
      row.querySelector('.mp-tax-quick-adults').textContent=taxNumber(taxQuickAdultCount(data));row.querySelector('.mp-tax-quick-feedback').textContent=taxQuickRow(stay)?stay.status==='confirmed'?'La modifica si salva uscendo dal campo.':'Da confermare.':'Controlla i conteggi e il versamento.';if(stay.status==='confirmed')row.querySelector('.mp-tax-stay-badge').textContent=taxQuickChanged(stay)?'Modifica da confermare':'Confermato';syncTaxQuickButtons();return {stay,index:Number(row.dataset.quickRow)};
    }
    container.addEventListener('input',event=>{if(event.target.matches('[data-quick-field]'))captureTaxQuickInput(event.target);});
    container.addEventListener('change',event=>{if(!event.target.matches('[data-quick-field]'))return;const changed=captureTaxQuickInput(event.target);if(changed?.stay.status==='confirmed'&&taxQuickRow(changed.stay)&&taxQuickChanged(changed.stay))confirmTaxQuick(changed.index);});
    q('#tax-stay-form').addEventListener('input',event=>{const form=event.currentTarget;if(event.target.name!=='confirmation')form.elements.confirmation.checked=false;if(event.target.name!=='exclusionConfirmation')form.elements.exclusionConfirmation.checked=false;form.elements.exemptionReason.required=Number(form.elements.otherExemptAdults.value)>0;form.elements.adults.setCustomValidity('');form.elements.otherExemptAdults.setCustomValidity('');form.elements.departure.setCustomValidity('');form.elements.exclusionReason.setCustomValidity('');form.elements.exclusionConfirmation.setCustomValidity('');});
    renderTaxCoverage();

    const actions={
      'tax-load':()=>loadTaxes(true),
      'tax-kross':importTaxKross,
      'tax-add':()=>editTaxStay({id:null,manual:true,initial:taxContext().initial,name:'',arrival:'',departure:'',channel:'',guestCount:null,sourceFingerprint:null,adults:null,minors:null,otherExemptAdults:0,exemptionReason:'',collection:null,confirmed:false,sameDatesConfirmed:false,previousConsecutiveNights:0,warnings:[]}),
      'tax-save':saveTaxStay,
      'tax-cancel':closeTaxEditor,
      'tax-coverage':saveTaxCoverage,
      'tax-exclude':excludeTaxStay,
      'tax-export':exportTaxes,
      'tax-confirm-visible':()=>confirmTaxQuick(),
      'tax-open':()=>taxOutput?api.openOutput(taxOutput):null
    };
    container.addEventListener('click',event=>{
      const button=event.target.closest('button');
      if(!button||button.disabled)return;
      const action=actions[button.dataset.action];
      if(action){action();return;}
      if(getBusy())return;
      if(button.dataset.taxStay!==undefined){
        const index=Number(button.dataset.taxStay),stay=taxStays[index];
        if(stay)editTaxStay(stay,index);
      }else if(button.dataset.quickConfirm!==undefined){
        confirmTaxQuick(Number(button.dataset.quickConfirm));
      }
    });
    function back(){
      if(!taxDraft)return false;
      closeTaxEditor();
      return true;
    }
    function primary(){return taxDraft?saveTaxStay():confirmTaxQuick();}
    function move(direction){
      if(getBusy())return;
      const backwards=direction==='up'||direction==='left';
      if(taxDraft){scrollContainer.scrollBy({top:backwards?-100:100});return;}
      if(!taxStays.length)return;
      taxSelected=taxSelected<0?(backwards?taxStays.length-1:0)
        :(taxSelected+(backwards?-1:1)+taxStays.length)%taxStays.length;
      const row=q('[data-quick-row="'+taxSelected+'"]');
      row?.scrollIntoView({block:'nearest'});
      row?.querySelector('[data-quick-field],button')?.focus();
    }
    return {load:loadTaxes,syncBusy:syncTaxButtons,back,primary,move};
  }
  return {shell,create};
});
