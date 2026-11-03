'use strict';
(function expose(root,factory){
  const value=factory();
  if(typeof module==='object'&&module.exports)module.exports=value;
  else root.mochiReceiptUI=value;
})(typeof window==='object'?window:globalThis,()=>{
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function shell(today){return `<div class="mp-heading"><h2>Ricevuta ospite</h2><span class="mp-step-label">1 / 3</span></div>
    <form id="receipt-form"><div class="mp-receipt-step" data-step="0">
      <label class="mp-field">Struttura / emittente<select name="profileId" required></select></label>
      <div class="mp-selected-profile" aria-live="polite"><p class="mp-selected-profile-title"></p><p class="mp-selected-profile-info"></p><div class="mp-number-preview"><span>Numero suggerito</span><strong class="mp-number-proposed">—</strong><small class="mp-number-source">Leggo la numerazione delle ricevute…</small></div><div class="mp-profile-actions"><button type="button" class="mp-secondary" data-action="edit-receipt-profile">Modifica dati</button><button type="button" class="mp-primary" data-action="use-receipt-profile">Usa questo profilo →</button></div></div>
      <div class="mp-profile-load-error" hidden><p class="mp-small-note mp-profile-error-text" role="status"></p><button type="button" class="mp-link" data-action="reload-profiles">Rileggi profili salvati</button></div>
      <button type="button" class="mp-link mp-add-property" data-action="add-property">+ Aggiungi una struttura</button>
      <details class="mp-booking-search" open><summary>Compila dal calendario</summary><p class="mp-small-note">Scegli la casa e un giorno del soggiorno.</p><div class="mp-two"><label class="mp-field">Appartamento<select class="mp-booking-property"></select></label><label class="mp-field">Data nel calendario<input type="date" class="mp-booking-date" value="${today}"></label></div><div class="mp-actions"><button type="button" class="mp-secondary" data-action="find-booking" data-operation>Cerca soggiorno</button></div><p class="mp-result" data-result="booking" role="status" aria-live="polite"></p><div class="mp-booking-choices"></div></details>
      <p class="mp-small-note mp-booking-filled" hidden></p>
      <div class="mp-two mp-recipient-fields"><label class="mp-field">Nome o referente<input name="recipientName" maxlength="160" autocomplete="off"></label><label class="mp-field">Azienda (se presente)<input name="recipientCompany" maxlength="160" autocomplete="off"></label></div>
      <p class="mp-small-note mp-recipient-salutation" aria-live="polite"></p>
      <label class="mp-field">Via e numero destinatario<textarea name="recipientAddress" placeholder="Via e numero civico" required maxlength="600" autocomplete="street-address"></textarea></label>
      <div class="mp-two"><label class="mp-field">CAP / codice postale<input name="recipientPostalCode" maxlength="32" autocomplete="postal-code" placeholder="es. 20100 oppure SW1A 1AA"></label><label class="mp-field">Città<input name="recipientCity" required maxlength="100" autocomplete="address-level2" placeholder="es. Milano"></label></div>
      <label class="mp-field">Paese (facoltativo)<input name="recipientCountry" maxlength="100" autocomplete="country-name" placeholder="es. Italia"></label>
      <label class="mp-field">Codice fiscale / P. IVA destinatario<input name="recipientTaxId" maxlength="64" autocomplete="off"></label>
      <div class="mp-actions"><button type="button" class="mp-primary" data-action="receipt-next">Continua →</button></div></div>
    <div class="mp-receipt-step" data-step="1" hidden><p class="mp-intro">Numero, emissione e periodo del soggiorno.</p>
      <div class="mp-two"><label class="mp-field">Numero ricevuta<input name="number" placeholder="es. 8/26" required maxlength="32"></label><label class="mp-field">Data emissione<input type="date" name="issueDate" value="${today}" required></label></div>
      <section class="mp-number-suggestion" aria-label="Suggerimento numero ricevuta"><div class="mp-number-status" role="status" aria-live="polite"><span>Numero suggerito</span><strong class="mp-number-proposed">—</strong><p class="mp-number-source">Leggo la numerazione delle ricevute…</p></div><div class="mp-number-actions"><button type="button" class="mp-secondary" data-action="use-suggested-number" disabled>Usa suggerito</button><button type="button" class="mp-secondary" data-action="refresh-number">Rileggi numerazione</button></div><p class="mp-small-note">Il suggerimento non riserva un numero. Controllalo prima di creare il PDF.</p></section>
      <div class="mp-two"><label class="mp-field">Arrivo<input type="date" name="arrival" required></label><label class="mp-field">Partenza<input type="date" name="departure" required></label></div>
      <div class="mp-actions"><button type="button" class="mp-secondary" data-action="receipt-prev">← Destinatario</button><button type="button" class="mp-primary" data-action="receipt-next">Continua →</button></div></div>
    <div class="mp-receipt-step" data-step="2" hidden><p class="mp-intro">Controlla gli importi prima di creare il PDF.</p>
      <div class="mp-two"><label class="mp-field">Canone (€)<input name="rent" inputmode="decimal" placeholder="0,00" required></label><label class="mp-field">Tassa soggiorno (€)<input name="cityTax" inputmode="decimal" value="0,00" required></label></div>
      <label class="mp-field">Pagamento (facoltativo)<input name="paymentMethod" placeholder="es. bonifico / portale" maxlength="120"></label>
      <div class="mp-total"><span>Totale ricevuta</span><output>—</output></div><p class="mp-small-note mp-receipt-summary"></p>
      <div class="mp-actions"><button type="button" class="mp-secondary" data-action="receipt-prev">← Dati</button><button type="button" class="mp-primary" data-action="generate" data-operation>Crea PDF ↓</button></div><p class="mp-small-note mp-receipt-output"></p><button type="button" class="mp-link" data-folder="receipts">Apri cartella ricevute</button></div></form>
      <p class="mp-result" data-result="ricevuta" role="status" aria-live="polite"></p><div class="mp-file-actions mp-receipt-files" hidden><button type="button" class="mp-primary" data-action="open-pdf">Apri PDF</button><button type="button" class="mp-secondary" data-folder="receipts">Apri cartella</button></div>`;}

  // The controller owns the receipt draft and its asynchronous archive lookup.
  // Shared application navigation, task status and profile editing are injected.
  function create({container,api,today,houseNames,getOverview=()=>null,getBusy=()=>false,
    setBusy=()=>{},isActive=()=>false,message=()=>{},sfx=()=>{},resize=()=>{},
    showReceipt=()=>{},editProfile=()=>{},addProperty=()=>{},reloadProfiles=()=>{},runTask=async fn=>fn()}){
    container.innerHTML=shell(today);
    const q=selector=>container.querySelector(selector);
    const qa=selector=>[...container.querySelectorAll(selector)];
    const scroll=container.closest('.mp-screen-content');
    let step=0,bookingInitial=null,bookingChoices=[],lastPdf=null;
    let numberSuggestion=null,numberSuggestionKey='',numberSuggestionGeneration=0,
      numberSuggestionPending=null,autoNumber='',numberTouched=false,receiptCreated=false,numberSuggestionLoading=false;
    const renderedMarkup=new WeakMap();
    function updateMarkup(node,markup){if(renderedMarkup.get(node)===markup)return;node.innerHTML=markup;renderedMarkup.set(node,markup);}

    function setStep(value){
      step=Math.max(0,Math.min(2,value));
      qa('[data-step]').forEach(panel=>panel.hidden=Number(panel.dataset.step)!==step);
      q('.mp-step-label').textContent=(step+1)+' / 3';
      if(step===2){
        const data=new FormData(q('#receipt-form'));
        q('.mp-receipt-summary').textContent=[data.get('recipientCompany')||data.get('recipientName'),data.get('number')].filter(Boolean).join(' · ');
      }
      showReceipt();
    }
    function nextReceipt(){
      const form=q('#receipt-form');
      const fields=qa(`[data-step="${step}"] input,[data-step="${step}"] select,[data-step="${step}"] textarea`);
      if(step===0&&form.elements.profileId.value.startsWith('pending-')){
        message('Apri Modifica dati per completare questo emittente.',true,'ricevuta');return;
      }
      if(!fields.every(field=>field.reportValidity()))return;
      if(step===0&&bookingInitial&&profileInitial(form.elements.profileId.value)!==bookingInitial){
        message('Configura e seleziona il profilo emittente di '+(houseNames[bookingInitial]||bookingInitial)+'.',true);return;
      }
      if(step===0&&!form.elements.recipientName.value.trim()&&!form.elements.recipientCompany.value.trim()){
        message('Inserisci il nome o l’azienda del destinatario.',true);return;
      }
      if(step===1&&form.elements.departure.value<form.elements.arrival.value){
        message('La partenza non può essere prima dell’arrivo.',true);return;
      }
      message('');setStep(step+1);
    }
    q('#receipt-form').addEventListener('input',()=>{
      const form=q('#receipt-form');
      const cents=value=>{
        const text=value.trim().replace(',','.');
        if(!/^\d+(?:\.\d{1,2})?$/.test(text))return null;
        const [a,b='']=text.split('.');
        return Number(a)*100+Number(b.padEnd(2,'0'));
      };
      const rent=cents(form.elements.rent.value),cityTax=cents(form.elements.cityTax.value);
      q('.mp-total output').textContent=rent!==null&&cityTax!==null
        ?((rent+cityTax)/100).toLocaleString('it-IT',{style:'currency',currency:'EUR'}):'—';
    });
    function renderRecipientSalutation(){
      const form=q('#receipt-form');
      const company=form.elements.recipientCompany.value.trim(),name=form.elements.recipientName.value.trim();
      q('.mp-recipient-salutation').textContent=company?'Intestazione: Spett.le '+company:name?'Intestazione: Gent. '+name:'';
    }
    function receiptNumberContext(){
      const form=q('#receipt-form'),profileId=form.elements.profileId.value,issueDate=form.elements.issueDate.value;
      return getOverview()?.receipt.profiles?.some(profile=>profile.id===profileId)&&/^\d{4}-\d{2}-\d{2}$/.test(issueDate)
        ?{profileId,issueDate,key:profileId+'|'+issueDate.slice(0,4)}:null;
    }
    function renderNumberSuggestion(){
      const context=receiptNumberContext(),available=!!numberSuggestion?.ok&&typeof numberSuggestion.number==='string';
      const number=available?numberSuggestion.number:'—';
      const source=numberSuggestionLoading?'Controllo l’archivio delle ricevute…'
        :available?(numberSuggestion.lastNumber?'Ultima trovata: '+numberSuggestion.lastNumber+'. ':'Nessuna ricevuta trovata per questo anno. ')
          +(numberSuggestion.message||'Puoi usare o modificare il numero proposto.')
        :numberSuggestion?.message||'Scegli una struttura e una data di emissione per leggere la numerazione.';
      qa('.mp-number-proposed').forEach(node=>node.textContent=number);
      qa('.mp-number-source').forEach(node=>node.textContent=source);
      q('.mp-number-preview').hidden=!context;
      const panel=q('.mp-number-suggestion');
      panel.dataset.state=numberSuggestionLoading?'loading':available?'ready':'unavailable';
      panel.setAttribute('aria-busy',String(numberSuggestionLoading));
      q('[data-action="use-suggested-number"]').disabled=getBusy()||numberSuggestionLoading||!available;
      q('[data-action="refresh-number"]').disabled=getBusy()||numberSuggestionLoading||!context;
    }
    function requestReceiptNumber(force=false){
      // Archive scans belong to the receipt workflow, never to home/background refreshes.
      if(!isActive()){
        if(force){numberSuggestionGeneration++;numberSuggestionKey='';}
        return Promise.resolve(null);
      }
      const context=receiptNumberContext(),input=q('#receipt-form').elements.number;
      if(!context){
        numberSuggestionGeneration++;numberSuggestionKey='';numberSuggestion=null;numberSuggestionLoading=false;
        renderNumberSuggestion();return Promise.resolve(null);
      }
      if(!force&&context.key===numberSuggestionKey){
        renderNumberSuggestion();return numberSuggestionPending||Promise.resolve(numberSuggestion);
      }
      if(!numberTouched&&!receiptCreated&&input.value===autoNumber){input.value='';autoNumber='';}
      const generation=++numberSuggestionGeneration;
      numberSuggestionKey=context.key;numberSuggestion=null;numberSuggestionLoading=true;
      renderNumberSuggestion();
      const request=Promise.resolve().then(()=>typeof api.suggestReceiptNumber==='function'
        ?api.suggestReceiptNumber({profileId:context.profileId,issueDate:context.issueDate})
        :{ok:false,message:'Numerazione non disponibile in questa versione. Puoi inserire il numero manualmente.'})
        .then(result=>{
          if(generation!==numberSuggestionGeneration||receiptNumberContext()?.key!==context.key)return null;
          const valid=result?.ok===true&&typeof result.number==='string'&&/^\d{1,12}\/(?:\d{2}|\d{4})$/.test(result.number);
          numberSuggestion=valid?{...result,message:typeof result.message==='string'?result.message.slice(0,400):''}
            :{ok:false,message:typeof result?.message==='string'?result.message.slice(0,400)
              :typeof result?.error==='string'?result.error.slice(0,400)
              :'Non riesco a leggere la numerazione. Puoi inserire il numero manualmente.'};
          numberSuggestionLoading=false;
          if(valid&&!receiptCreated&&(!input.value.trim()||(!numberTouched&&input.value===autoNumber))){
            input.value=result.number;autoNumber=result.number;numberTouched=false;
          }
          renderNumberSuggestion();return numberSuggestion;
        }).catch(()=>{
          if(generation!==numberSuggestionGeneration)return null;
          numberSuggestion={ok:false,message:'Archivio non disponibile. Controlla la cartella delle ricevute oppure inserisci il numero manualmente.'};
          numberSuggestionLoading=false;renderNumberSuggestion();return numberSuggestion;
        }).finally(()=>{if(numberSuggestionPending===request)numberSuggestionPending=null;});
      numberSuggestionPending=request;return request;
    }
    function splitImportedRecipientAddress(){
      const form=q('#receipt-form');
      if(form.elements.recipientCity.value.trim())return;
      const lines=form.elements.recipientAddress.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      for(let index=1;index<lines.length;index++){
        const match=/^(\d{4,6}(?:-\d{3,4})?|[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}|[A-Z]\d[A-Z]\s?\d[A-Z]\d)\s+(.{1,100})$/i.exec(lines[index]);
        const trailing=lines.slice(index+1);
        if(!match||trailing.length>1||trailing.length===1&&!/^[\p{L}][\p{L} .’'-]{1,99}$/u.test(trailing[0]))continue;
        form.elements.recipientAddress.value=lines.slice(0,index).join('\n');
        form.elements.recipientPostalCode.value=match[1];
        form.elements.recipientCity.value=match[2];
        form.elements.recipientCountry.value=trailing[0]||'';
        return;
      }
    }
    for(const key of ['recipientName','recipientCompany'])q('#receipt-form').elements[key].addEventListener('input',renderRecipientSalutation);
    q('#receipt-form').elements.number.addEventListener('input',()=>{numberTouched=true;receiptCreated=false;});
    q('#receipt-form').elements.issueDate.addEventListener('change',()=>requestReceiptNumber());
    function profilesUnreadable(){return getOverview()?.receipt.ok===false&&getOverview().receipt.code!=='RECEIPT_PROFILE_MISSING';}
    function pendingProfileLabel(){return profilesUnreadable()?'profili non leggibili':'completa dati';}
    function renderMetadata(){
      const overview=getOverview();
      if(!overview)return;
      const select=q('#receipt-form').elements.profileId,selected=select.value;
      const configured=(overview.receipt.profiles||[]).map(profile=>`<option value="${escape(profile.id)}">${escape(profile.label)}</option>`).join('');
      const pending=Object.entries(houseNames)
        .filter(([initial])=>!overview.receipt.profiles?.some(profile=>profileInitial(profile.id)===initial))
        .map(([initial,label])=>`<option value="pending-${escape(initial)}">${escape(label)} — ${pendingProfileLabel()}</option>`).join('');
      updateMarkup(select,'<option value="">Scegli un profilo emittente</option>'+configured+pending);
      select.value=[...select.options].some(option=>option.value===selected)&&selected?selected
        :bookingInitial?'':(overview.receipt.profiles?.[0]?.id||'');
      q('.mp-profile-load-error').hidden=overview.receipt.ok!==false;
      q('.mp-profile-error-text').textContent=overview.receipt.error||'Non riesco a leggere i profili salvati.';
      renderSelectedProfile();
      const calendars=[...new Map((overview.receiptCalendar?.calendars||overview.kross.calendars||[]).map(calendar=>[calendar.initial,calendar])).values()];
      const calendarSelect=q('.mp-booking-property'),previousCalendar=calendarSelect.value;
      updateMarkup(calendarSelect,calendars.map(calendar=>`<option value="${escape(calendar.initial)}">${escape(houseNames[calendar.initial]||calendar.name)}</option>`).join(''));
      if(calendars.some(calendar=>calendar.initial===(previousCalendar||profileInitial(select.value)))){
        calendarSelect.value=previousCalendar||profileInitial(select.value);
      }
      renderReceiptDestination();
    }
    function profileInitial(id){
      const profile=getOverview()?.receipt.profiles?.find(profile=>profile.id===id);
      return profile?.calendarInitial||'';
    }
    function renderReceiptDestination(){
      const id=q('#receipt-form').elements.profileId.value;
      const profile=getOverview()?.receipt.profiles?.find(profile=>profile.id===id);
      q('.mp-receipt-output').textContent='I PDF vengono salvati in: '+(profile?.outputDir||getOverview()?.paths.outputDir||'cartella da configurare');
    }
    function renderSelectedProfile(){
      const id=q('#receipt-form').elements.profileId.value;
      const profile=getOverview()?.receipt.profiles?.find(profile=>profile.id===id),pending=id.startsWith('pending-');
      q('.mp-selected-profile').hidden=!profile&&!pending;
      q('.mp-selected-profile-title').textContent=profile?profile.label+' · dati pronti'
        :pending?(houseNames[id.slice(8)]||'Struttura')+' · '+pendingProfileLabel():'';
      q('.mp-selected-profile-info').textContent=profile?profile.issuerName+' · '+profile.propertyName
        :pending?(profilesUnreadable()?getOverview().receipt.error||'Rileggi i profili salvati prima di modificare i dati.'
          :'Apri Modifica dati per completare questo emittente.'):'';
      q('[data-action="use-receipt-profile"]').hidden=!profile;
      renderReceiptDestination();renderRecipientSalutation();requestReceiptNumber();
    }
    function clearImportedReceipt(){
      const form=q('#receipt-form');
      for(const key of ['recipientName','recipientCompany','recipientAddress','recipientPostalCode','recipientCity','recipientCountry','recipientTaxId','arrival','departure','rent','cityTax','paymentMethod','number']){
        form.elements[key].value='';
      }
      bookingInitial=null;lastPdf=null;
      numberSuggestionGeneration++;numberSuggestionKey='';numberSuggestion=null;numberSuggestionLoading=false;
      autoNumber='';numberTouched=false;receiptCreated=false;
      q('.mp-receipt-files').hidden=true;q('.mp-booking-filled').hidden=true;
      renderRecipientSalutation();form.dispatchEvent(new Event('input'));
    }
    function useBooking(booking,initial){
      const form=q('#receipt-form'),previousProfile=form.elements.profileId.value;
      clearImportedReceipt();bookingInitial=initial;
      for(const key of ['recipientName','recipientCompany','recipientAddress','recipientPostalCode','recipientCity','recipientCountry','recipientTaxId','arrival','departure','rent','cityTax','paymentMethod']){
        const value=booking[key];
        form.elements[key].value=Array.isArray(value)?value.join('\n'):typeof value==='string'||typeof value==='number'?String(value):'';
      }
      splitImportedRecipientAddress();renderRecipientSalutation();
      const matching=getOverview().receipt.profiles?.filter(profile=>profileInitial(profile.id)===initial)||[];
      const profile=matching.find(profile=>profile.id===previousProfile)||(matching.length===1?matching[0]:null);
      form.elements.profileId.value=profile?.id||'';
      renderSelectedProfile();
      form.dispatchEvent(new Event('input'));
      q('.mp-booking-search').open=false;q('.mp-booking-filled').hidden=false;
      const missingNames={recipientAddress:'indirizzo destinatario',recipientPostalCode:'CAP destinatario',recipientCity:'città destinatario',recipientCountry:'paese destinatario',recipientTaxId:'codice fiscale / P. IVA',arrival:'arrivo',departure:'partenza',rent:'canone',cityTax:'tassa soggiorno',recipientName:'nome destinatario'};
      const missing=(booking.missingFields||[]).filter(key=>key!=='recipientTaxId').map(key=>missingNames[key]||key);
      if(!form.elements.recipientCity.value.trim()&&!missing.includes('città destinatario'))missing.push('città destinatario');
      q('.mp-booking-filled').textContent='Dal calendario '+(houseNames[initial]||initial)+': '+(booking.recipientName||'soggiorno selezionato')+'. '
        +(missing.length?'Da completare: '+missing.join(', ')+'. ':'Controlla i dati prima del PDF.')
        +(profile?'':matching.length?' Scegli il profilo emittente di questa casa.':' Configura il profilo emittente di questa casa.');
      sfx('confirm');
      message((booking.warnings||[]).join(' ')||'Soggiorno caricato. Completa i campi mancanti.',false,'ricevuta');
      scroll.scrollTop=0;
    }
    async function findBooking(){
      if(getBusy())return;
      const initial=q('.mp-booking-property').value,date=q('.mp-booking-date').value;
      if(!initial||!date){message('Scegli appartamento e data.',true,'booking');return;}
      if(!q('.mp-booking-date').reportValidity())return;
      setBusy(true);bookingChoices=[];
      q('.mp-booking-choices').replaceChildren();
      message('Leggo il calendario…',false,'booking');
      try{
        const result=await api.lookupReceiptBooking({initial,date});
        if(initial!==q('.mp-booking-property').value||date!==q('.mp-booking-date').value){
          message('La selezione è cambiata. Premi di nuovo Cerca soggiorno.',false,'booking');return;
        }
        if(!result.ok){
          message(result.error||result.message||'Non riesco a leggere il calendario. Ricollega Google dalle Impostazioni.',true,'booking');return;
        }
        bookingChoices=result.bookings||[];
        if(!bookingChoices.length){
          message(result.message||'Nessun soggiorno presente in questa data.',false,'booking');return;
        }
        if(bookingChoices.length===1){
          useBooking(bookingChoices[0],initial);message('Soggiorno caricato.',false,'booking');return;
        }
        message('Scegli il soggiorno da usare per la ricevuta.',false,'booking');
        for(const [index,booking] of bookingChoices.entries()){
          const button=document.createElement('button');
          button.type='button';button.className='mp-secondary mp-booking-choice';
          button.dataset.bookingIndex=String(index);button.dataset.initial=initial;
          button.textContent=[booking.recipientName||'Ospite',booking.arrival,booking.departure].filter(Boolean).join(' · ');
          q('.mp-booking-choices').append(button);
        }
      }catch{
        message('Lettura del calendario non riuscita. Controlla il collegamento Google.',true,'booking');
      }finally{setBusy(false);resize();}
    }
    q('#receipt-form').elements.profileId.addEventListener('change',event=>{
      const id=event.target.value,initial=profileInitial(id)||(id.startsWith('pending-')?id.slice(8):'');
      if(bookingInitial&&initial!==bookingInitial)clearImportedReceipt();
      if(initial)q('.mp-booking-property').value=initial;
      renderSelectedProfile();
    });
    async function generate(){
      const form=q('#receipt-form');
      if(form.elements.profileId.value.startsWith('pending-')){
        message('Completa prima i dati di questa struttura.',true,'ricevuta');return;
      }
      if(!form.reportValidity())return;
      const data=Object.fromEntries(new FormData(form));
      return runTask(()=>api.generateReceipt(data));
    }

    function acceptGenerated(result){
      lastPdf=result.outputId;
      receiptCreated=true;
      numberTouched=true;
      q('.mp-receipt-files').hidden=false;
    }
    function useSuggestedNumber(){
      if(!numberSuggestion?.ok)return;
      const input=q('#receipt-form').elements.number;
      input.value=numberSuggestion.number;autoNumber=numberSuggestion.number;
      numberTouched=false;receiptCreated=false;input.focus();
    }
    function editSelectedProfile(){
      const id=q('#receipt-form').elements.profileId.value;
      if(!id){message('Scegli prima una struttura.',true,'ricevuta');return;}
      return editProfile(id);
    }
    async function reload(){
      await reloadProfiles();
      const receipt=getOverview()?.receipt;
      message(receipt?.configured?'Profili riletti. Scegli la struttura.':receipt?.error,!receipt?.configured,'ricevuta');
    }
    function selectProfile(id){
      q('#receipt-form').elements.profileId.value=id;
      renderSelectedProfile();
    }
    function back(){if(step<=0)return false;setStep(step-1);return true;}
    function move(direction){
      if(direction==='left'&&step>0)setStep(step-1);
      else if(direction==='right'&&step<2)nextReceipt();
    }
    function primary(){return step<2?nextReceipt():generate();}
    const actions={
      'receipt-next':nextReceipt,
      'receipt-prev':()=>setStep(step-1),
      generate,
      'find-booking':findBooking,
      'edit-receipt-profile':editSelectedProfile,
      'use-receipt-profile':()=>{
        q('.mp-booking-search').open=false;
        q('.mp-recipient-fields').scrollIntoView({block:'start'});
        q('#receipt-form').elements.recipientName.focus();
        message('Profilo selezionato. Inserisci l’ospite oppure cercalo dal calendario.',false,'ricevuta');
      },
      'add-property':()=>addProperty(q('.mp-booking-property').value),
      'reload-profiles':reload,
      'refresh-number':()=>requestReceiptNumber(true),
      'use-suggested-number':useSuggestedNumber,
      'open-pdf':()=>api.openOutput(lastPdf)
    };
    container.addEventListener('click',async event=>{
      const button=event.target.closest('button');
      if(!button)return;
      if(Object.hasOwn(actions,button.dataset.action))await actions[button.dataset.action]();
      if(button.dataset.bookingIndex!==undefined&&!getBusy()){
        const booking=bookingChoices[Number(button.dataset.bookingIndex)];
        if(booking)useBooking(booking,button.dataset.initial);
      }
    });
    q('#receipt-form').addEventListener('submit',event=>event.preventDefault());
    return {
      renderMetadata,renderBusy:renderNumberSuggestion,profileInitial,
      profileId:()=>q('#receipt-form').elements.profileId.value,
      selectProfile,step:()=>step,next:nextReceipt,back,move,primary,
      acceptGenerated,requestNumber:requestReceiptNumber
    };
  }
  return {shell,create};
});
