'use strict';
(() => {
  const api=window.mochi,root=document.getElementById('mochi-pocket-blue'),q=s=>root.querySelector(s),qa=s=>[...root.querySelectorAll(s)];
  const audio=window.mochiSounds,sfx=type=>audio?.play(type);
  let active='home',selection=0,busy=false,overview=null,historyPage=0,pausedFrom='home',greeting=0,metadataReady=false,returnToReceipt=false;
  let googleConnecting=false,googleStopping=false,googleNeedsRetry=false,googleLoginPending=null,googleLoginDetail='';
  const renderedMarkup=new WeakMap();
  let renderedHouseOptions='',renderedAlloggiati='',renderedHistory='';
  function updateMarkup(node,markup){if(renderedMarkup.get(node)===markup)return;node.innerHTML=markup;renderedMarkup.set(node,markup);}
  // Filled from the configured calendars (config.json): no property is written in the code.
  const houseNames={};
  const houseAddresses={};
  const names={home:'LA SCRIVANIA',ricevuta:'RICEVUTA OSPITE',calendari:'CALENDARI KROSS',alloggiati:'SCHEDINE / ALLOGGIATI',tasse:'TASSA DI SOGGIORNO',pulizie:'PULIZIE DEL MESE',attivita:'IL DIARIO',settings:'IMPOSTAZIONI',sleep:'PAUSA'};
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  function escape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function page(name,html){q(`[data-screen="${name}"]`).innerHTML=html;}
  function googleConnectionPanel(){return `<section class="mp-google-connection" aria-label="Collegamento Google" data-status="unknown"><div class="mp-google-status" role="status" aria-live="polite" aria-atomic="true"><div class="mp-google-heading"><span class="mp-google-led" aria-hidden="true"></span><strong class="mp-google-label">Google da verificare</strong></div><p class="mp-google-detail">Verifica il collegamento prima di accedere a Google.</p></div><button type="button" class="mp-secondary" data-action="check-google">Verifica collegamento</button></section>`;}
  qa('[data-mochi]').forEach(img=>img.src='../../assets/mochi-postino-blue.webp');
  const receiptUI=window.mochiReceiptUI.create({
    container:q('[data-screen="ricevuta"]'),api,today,houseNames,
    getOverview:()=>overview,getBusy:()=>busy,setBusy:lock,isActive:()=>active==='ricevuta',
    message,sfx,resize,showReceipt:()=>show('ricevuta'),
    editProfile:editReceiptProfile,addProperty:addReceiptProperty,
    reloadProfiles:refresh,runTask:fn=>task('ricevuta',fn)
  });
  page('calendari',`<div class="mp-heading"><h2>Calendari Kross</h2><span class="mp-badge mp-kross-ready">Verifico…</span></div>
    <div class="mp-import" aria-label="Trascina qui il file Excel Kross"><div><strong>Export prenotazioni Kross</strong><small class="mp-filename">Nessun Excel selezionato</small><small class="mp-drop-hint">Trascina qui il file .xlsx oppure sceglilo dal PC.</small></div><button type="button" class="mp-secondary" data-action="choose-kross" data-operation>Scegli Excel</button></div>
    <p class="mp-small-note mp-kross-scope">Si aggiornano soltanto le date presenti nell’Excel. Le altre date restano invariate.</p>
    <fieldset class="mp-houses"><legend>Quali calendari aggiorniamo?</legend></fieldset>
    <label class="mp-protection"><input type="checkbox" class="mp-protect" checked><span>Proteggi le modifiche manuali</span></label>
    <div class="mp-actions"><button type="button" class="mp-secondary" data-action="simulate" data-operation>Simula prima</button><button type="button" class="mp-primary" data-action="update" data-operation>Aggiorna →</button></div>
    <p class="mp-result" data-result="calendari" role="status" aria-live="polite">Scegli l’Excel esportato da Kross.</p>
    ${googleConnectionPanel()}<div class="mp-file-actions"><button type="button" class="mp-secondary" data-action="google" data-operation>Collega Google</button><button type="button" class="mp-secondary" data-folder="kross">Apri cartella Kross</button><button type="button" class="mp-secondary mp-report" data-action="show-report" data-operation aria-controls="mp-kross-summary" aria-expanded="false">Vedi ultimo riepilogo</button></div><section id="mp-kross-summary" class="mp-kross-summary" aria-label="Riepilogo calendari" hidden></section><div class="mp-colors-panel"></div>`);
  page('alloggiati',`<div class="mp-heading"><h2>Schedine / Alloggiati</h2></div><p class="mp-intro">Le ricevute degli invii già effettuati alla Polizia, divise per appartamento.</p><p class="mp-small-note">Una ricevuta può comprendere più ospiti. I contatori indicano documenti, non persone.</p>
    <div class="mp-alloggiati-controls"><p class="mp-small-note">Il recupero controlla i 30 giorni precedenti, fino a ieri. Gli invii di oggi non sono inclusi.</p><div class="mp-actions"><button type="button" class="mp-secondary" data-action="refresh">Rileggi stato</button><button type="button" class="mp-primary" data-action="alloggiati" data-operation>Controlla e recupera ↻</button></div><p class="mp-small-note mp-last-check"></p></div>
    <p class="mp-result" data-result="alloggiati" role="status" aria-live="polite"></p><div class="mp-profiles mp-alloggiati-cards" aria-label="Ricevute per appartamento"></div>
    <p class="mp-small-note mp-alloggiati-cloud-note">Drive sincronizza le copie con il cloud. Mochi verifica i file presenti nella cartella locale di Drive.</p><p class="mp-small-note">Per vedere i numeri in ordine, nella cartella scegli Nome ↑.</p><p class="mp-small-note">Gli invii degli ospiti si fanno da ROSS1000. Il recupero automatico continua ogni 15 giorni.</p>
    <details class="mp-alloggiati-technical"><summary>Dati tecnici</summary><p class="mp-small-note">La cartella tecnica contiene configurazione degli account, credenziali protette, registri delle operazioni e copie locali di sicurezza. Per consultare i documenti usa il pulsante nella scheda dell’appartamento.</p><button type="button" class="mp-secondary" data-folder="alloggiati">Apri cartella tecnica</button></details>`);
  const taxUI=window.mochiTaxUI.create({
    container:q('[data-screen="tasse"]'),api,today,houseNames,
    getBusy:()=>busy,setBusy:lock,
    message:(text,error,options)=>message(text,error,'tasse',options),
    clearAlert:()=>alerts.delete('tasse'),resize,sfx
  });
  page('attivita',`<div class="mp-heading"><h2>Il diario di Mochi</h2></div><p class="mp-intro">Esiti reali delle operazioni avviate dall’app.</p><ol class="mp-history"></ol><div class="mp-history-nav" hidden><button type="button" class="mp-secondary" data-history="prev">←</button><span class="mp-history-page"></span><button type="button" class="mp-secondary" data-history="next">→</button></div>`);
  const settings=document.createElement('section');settings.className='mp-page';settings.dataset.screen='settings';settings.hidden=true;settings.innerHTML=`<div class="mp-heading"><h2>Collegamenti e profili</h2></div>
    <div class="mp-audio-settings"><h3>Suoni della console</h3><div class="mp-audio-level"><label for="mochi-volume">Volume</label><input id="mochi-volume" type="range" min="0" max="100" step="5" value="35"><output class="mp-volume-value" for="mochi-volume">35%</output><button type="button" class="mp-secondary" data-action="sound-preview">Ascolta ♪</button></div><p class="mp-small-note">Tasti e menu in stile console. Il pulsante ♪ in alto attiva o silenzia i suoni.</p></div>
    <p class="mp-connected-note mp-kross-path"></p>${googleConnectionPanel()}<div class="mp-actions"><button type="button" class="mp-secondary" data-action="choose-kross-folder">Trova cartella calendari</button><button type="button" class="mp-secondary" data-action="google" data-operation>Collega Google</button></div>
    <div class="mp-profile-editor"><h3>Emittente della ricevuta</h3><label class="mp-field">Profilo<select class="mp-profile-picker"></select></label><button type="button" class="mp-link" data-action="new-profile">+ Nuovo profilo</button>
    <form id="profile-form"><input type="hidden" name="id"><label class="mp-field">Nome del profilo<input name="label" required maxlength="120"></label><label class="mp-field">Calendario da collegare<select name="calendarInitial"><option value="">Nessuno</option></select></label>
    <div class="mp-two"><label class="mp-field">Nome / ragione sociale emittente<input name="issuerName" required maxlength="160"></label><label class="mp-field">Codice fiscale / Partita IVA<input name="issuerTaxId" required maxlength="64"></label></div>
    <label class="mp-field">Indirizzo emittente<textarea name="issuerAddress" required maxlength="600"></textarea></label>
    <label class="mp-field">Nome struttura<input name="propertyName" required maxlength="160"></label><label class="mp-field">Indirizzo struttura<input name="propertyAddress" required maxlength="200"></label>
    <div class="mp-two"><label class="mp-field">Città<input name="propertyCity" required maxlength="100"></label><label class="mp-field">Tipo struttura<input name="propertyKind" value="CAV" required maxlength="50"></label></div>
    <div class="mp-actions"><button type="button" class="mp-secondary mp-return-receipt" data-action="return-receipt" hidden>← Torna alla ricevuta</button><button type="button" class="mp-primary mp-save-profile" data-action="save-profile">Salva profilo</button></div></form></div><p class="mp-result" data-result="settings" role="status" aria-live="polite"></p>`;q('.mp-screen-content').append(settings);
  q('.mp-menu').insertAdjacentHTML('afterend','<div class="mp-home-links"><span class="mp-ready-summary">Collegamento in corso…</span><button type="button" class="mp-link" data-action="settings">Impostazioni</button></div>');
  q('.mp-settings-button').insertAdjacentHTML('beforebegin','<button type="button" class="mp-sound-toggle" data-action="sound-toggle" aria-label="Disattiva suoni" aria-pressed="true" title="Suoni della console">♪</button>');
  function syncAudio(){const state=audio?.getSettings()||{muted:true,volume:0};const enabled=!state.muted&&state.volume>0;const toggle=q('.mp-sound-toggle');toggle.textContent=enabled?'♪':'♪̸';toggle.setAttribute('aria-pressed',String(enabled));toggle.setAttribute('aria-label',enabled?'Disattiva suoni':'Attiva suoni');toggle.title=enabled?'Suoni attivi':'Suoni silenziati';q('#mochi-volume').value=String(Math.round(state.volume*100));q('.mp-volume-value').textContent=Math.round(state.volume*100)+'%';q('[data-action="sound-preview"]').disabled=!enabled;}
  syncAudio();q('#mochi-volume').addEventListener('input',event=>{audio?.setVolume(Number(event.target.value)/100);syncAudio();});q('#mochi-volume').addEventListener('change',()=>sfx('click'));
  root.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled||button.dataset.action?.startsWith('sound-'))return;const type=button.dataset.direction?'move':button.classList.contains('mp-b')||button.dataset.action==='receipt-prev'?'back':button.classList.contains('mp-power')?(active==='sleep'?'power':'back'):button.hasAttribute('data-operation')||button.dataset.module||button.classList.contains('mp-a')||button.classList.contains('mp-start')||button.classList.contains('mp-primary')?'confirm':'click';sfx(type);},{capture:true});
  const menu=qa('[data-module]');let dialogue=window.mochiDialogue.create(q('.mp-screen-status'));
  qa('[data-result]').forEach(node=>{node.removeAttribute('role');node.removeAttribute('aria-live');});
  q('.mp-screen-bar').insertAdjacentHTML('afterend','<div class="mp-attention" hidden><div><strong class="mp-attention-title"></strong><p class="mp-attention-text"></p></div><button type="button" class="mp-secondary mp-attention-google" data-action="google" data-operation hidden>Collega Google</button><button type="button" class="mp-attention-close" data-action="dismiss-alert" aria-label="Chiudi avviso">×</button></div>');
  q('.mp-screen-bar').insertAdjacentHTML('afterend','<section class="mp-google-login" aria-label="Accesso Google" hidden><div role="status" aria-live="polite"><strong class="mp-google-login-title"></strong><p class="mp-google-login-detail"></p></div><div class="mp-google-login-actions"><button type="button" class="mp-secondary" data-action="google-retry">Riprova</button><button type="button" class="mp-secondary" data-action="google-cancel">Annulla</button></div></section>');
  let profiles=[],taskScreen=null;
  function renderGoogleLogin(){const panel=q('.mp-google-login');panel.hidden=!googleConnecting&&!googleNeedsRetry;panel.setAttribute('aria-busy',String(googleStopping));q('.mp-google-login-title').textContent=googleStopping?'Interrompo il tentativo…':googleConnecting?'In attesa del browser':'Collegamento Google da riprovare';q('.mp-google-login-detail').textContent=googleStopping?'Puoi lasciare aperta la pagina del browser.':googleConnecting?'Completa il consenso nel browser. Se non risponde, riprova o annulla. L’attesa termina dopo 2 minuti.':googleLoginDetail;q('[data-action="google-retry"]').disabled=googleStopping||(busy&&!googleConnecting);q('[data-action="google-cancel"]').textContent=googleConnecting?'Annulla':'Chiudi';q('[data-action="google-cancel"]').disabled=googleStopping;}
  function renderGoogleConnection(state){for(const panel of qa('.mp-google-connection')){panel.dataset.status=state.checking?'checking':state.status;panel.setAttribute('aria-busy',String(state.checking));panel.querySelector('.mp-google-label').textContent=state.checking?'Verifica Google…':state.status==='connected'?'Google collegato':state.status==='disconnected'?'Google da collegare':'Google da verificare';panel.querySelector('.mp-google-detail').textContent=state.message+(state.checkedAt?' · Ultimo controllo: '+formatDate(state.checkedAt):'');panel.querySelector('[data-action="check-google"]').disabled=busy||state.checking;}for(const button of qa('[data-screen] [data-action="google"]'))button.textContent=state.status==='connected'?'Ricollega Google':'Collega Google';}
  const googleConnection=window.mochiGoogleStatus.create({check:()=>typeof api.checkGoogleConnection==='function'?api.checkGoogleConnection():{ok:false,status:'unknown',message:'Verifica Google non disponibile in questa versione. Riapri Mochi aggiornato.'},onChange:renderGoogleConnection});
  renderGoogleConnection(googleConnection.getState());
  const messages=new Map(),alerts=new Map();
  const prompts={home:'Mochi è pronto. Scegli uno strumento.',ricevuta:'Scegli la struttura e prepara la ricevuta.',calendari:'Scegli o trascina l’Excel esportato da Kross.',alloggiati:'Leggo lo stato salvato delle ricevute Alloggiati.',tasse:'Conferma i conteggi dei soggiorni e controlla il trimestre.',pulizie:'Conta le pulizie per appartamento dai giorni di partenza.',attivita:'Qui trovi gli esiti delle operazioni.',settings:'Profili, collegamenti e suoni della console.',sleep:'Mochi si riposa. Premi un tasto per tornare.'};
  const screenFor=where=>where==='booking'?'ricevuta':where;
  function renderAlert(){const value=alerts.get(active),banner=q('.mp-attention');banner.hidden=!value;if(!value)return;banner.dataset.tone=value.tone;q('.mp-attention-title').textContent=value.auth?'Google richiede attenzione':value.tone==='error'?'Operazione da controllare':'Attenzione';q('.mp-attention-text').textContent=value.text;q('.mp-attention-google').hidden=!value.auth||busy;}
  function renderMessage(animate=true){const value=messages.get(active)||{text:prompts[active],tone:'info'};dialogue.write(value.text,{tone:value.tone,animate});renderAlert();}
  function message(text,error=false,where=active,options={}){const screen=screenFor(where),auth=options.auth??(error&&/google|accesso|autorizz|consenso/i.test(text)),tone=options.tone||(error?(auth?'attention':'error'):'info');if(error&&auth)googleConnection.invalidate('L’ultima operazione richiede una verifica del collegamento Google.');messages.set(screen,{text,tone});const box=q(`[data-result="${where}"]`);if(box){box.textContent=text;box.dataset.error=String(error);box.dataset.tone=tone;}if((options.attention||error)&&!options.suppressAlert){alerts.set(screen,{text,tone,auth});if(options.sound!==false)sfx(tone==='attention'?'attention':'error');}if(screen===active)renderMessage();}
  function show(name){
    if(!Object.hasOwn(names,name))return;
    const previous=active;active=name;
    if(previous!==name){dialogue.destroy();dialogue=window.mochiDialogue.create(q('.mp-screen-status'));}
    for(const section of qa('[data-screen]'))section.hidden=section.dataset.screen!==name;
    q('.mp-location').textContent=names[name];
    const hints={home:'A Scegli',ricevuta:receiptUI.step()===2?'A Crea PDF':'A Continua',calendari:'A Simula',alloggiati:'A Recupera',tasse:'A Conferma conteggi',pulizie:'A Rileggi'};
    q('.mp-a-hint').textContent=hints[name]||'B Indietro';
    root.classList.toggle('mp-asleep',name==='sleep');q('.mp-power').setAttribute('aria-pressed',String(name==='sleep'));
    q('.mp-screen-content').scrollTop=0;
    if(name==='attivita')renderHistory();
    renderMessage(previous===name);
    let pending;
    if(name==='settings'){
      q('.mp-return-receipt').hidden=!returnToReceipt;q('.mp-save-profile').textContent=returnToReceipt?'Salva e torna alla ricevuta':'Salva profilo';pending=loadProfileEditor();
    }else if(previous!==name&&!busy){
      if(name==='ricevuta')pending=refresh().catch(()=>message('Non riesco a rileggere i profili salvati. Premi Rileggi profili.',true,'ricevuta'));
      else if(name==='tasse')pending=taxUI.load(false);
      else if(name==='pulizie')pending=cleaningUI.load(false);
    }
    if((name==='calendari'||name==='settings')&&!busy)googleConnection.verify();
    resize();return pending;
  }
  const cleaningUI=window.mochiCleaningUI.create({container:q('[data-screen="pulizie"]'),api,today,getBusy:()=>busy,setBusy:lock,message:(text,error,options)=>{if(!error)alerts.delete('pulizie');message(text,error,'pulizie',options);},resize});
  const colorsUI=window.mochiKrossColorsUI.create({container:q('.mp-colors-panel'),api,getBusy:()=>busy,setBusy:lock,calendars:()=>qa('.mp-houses input:checked').map(input=>input.value),message:(text,error)=>{if(!error)alerts.delete('calendari');message(text,error,'calendari');},resize});
  function updateMenu(){menu.forEach((b,i)=>{if(i===selection)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current');});}
  function formatDate(value){return value?new Date(value).toLocaleString('it-IT',{timeZone:'Europe/Rome',dateStyle:'short',timeStyle:'short'}):'—';}
  function renderMetadata(){
    if(!overview)return;
    q('.mp-kross-ready').textContent=overview.kross.configured?'Configurato':'Da configurare';q('.mp-kross-ready').title='Configurazione locale presente. L’accesso Google si verifica durante l’operazione.';
    q('.mp-ready-summary').textContent=[overview.kross.configured?'Kross pronto':'Kross da collegare',overview.alloggiati.configured?'Alloggiati configurato':'Alloggiati da configurare'].join(' · ');
    q('.mp-filename').textContent=overview.selectedFile||'Nessun Excel selezionato';q('.mp-kross-path').textContent='Dati Kross: '+overview.paths.krossBase;
    syncHouseNames(overview);
    const old=new Map(qa('.mp-houses input').map(i=>[i.value,i.checked]));const unique=[...new Map((overview.kross.calendars||[]).map(c=>[c.initial,c])).values()];
    const houseOptions=JSON.stringify(unique.map(c=>[c.initial,houseNames[c.initial]||c.name]));
    if(houseOptions!==renderedHouseOptions){q('.mp-houses').innerHTML='<legend>Quali calendari aggiorniamo?</legend>'+unique.map(c=>`<label><input type="checkbox" value="${escape(c.initial)}" ${old.has(c.initial)?(old.get(c.initial)?'checked':''):'checked'}>${escape(houseNames[c.initial]||c.name)}</label>`).join('');renderedHouseOptions=houseOptions;}
    receiptUI.renderMetadata();
    const calendars=[...new Map((overview.receiptCalendar?.calendars||overview.kross.calendars||[]).map(c=>[c.initial,c])).values()];
    const profileCalendar=q('#profile-form').elements.calendarInitial,previousProfileCalendar=profileCalendar.value;
    updateMarkup(profileCalendar,'<option value="">Nessuno</option>'+calendars.map(c=>`<option value="${escape(c.initial)}">${escape(houseNames[c.initial]||c.name)}</option>`).join(''));
    profileCalendar.value=previousProfileCalendar;
    metadataReady=true;
    renderAlloggiati();renderHistory();
  }
  function renderAlloggiati(){
    const a=overview.alloggiati,key=JSON.stringify(a);if(key===renderedAlloggiati)return;
    const target=q('.mp-profiles');target.replaceChildren();
    const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
    const statuses={completato:'Recupero completato','non dovuto':'In attesa della scadenza',incompleto:'Recupero da verificare',errore:'Errore nel recupero'};
    for(const p of a.profiles||[]){
      const card=document.createElement('article');card.className='mp-profile mp-alloggiati-card';card.setAttribute('aria-label','Ricevute '+p.label);card.dataset.profileId=p.id;
      const tone=p.download==='errore'?'error':p.download==='incompleto'||p.pendingDelivery?'attention':p.download==='completato'?'success':'neutral';card.dataset.tone=tone;
      const heading=document.createElement('div');heading.className='mp-alloggiati-card-heading';const name=document.createElement('h3'),badge=document.createElement('span');name.textContent=p.label;badge.className='mp-alloggiati-badge';badge.textContent=statuses[p.download]||'Stato da verificare';heading.append(name,badge);card.append(heading);
      const metrics=document.createElement('div');metrics.className='mp-alloggiati-metrics';
      const fresh=p.newReceiptsAvailable===true||(p.newReceiptsAvailable===undefined&&integer(p.newReceipts)!==null&&p.download!=='non dovuto');
      const addMetric=(value,label,note)=>{const box=document.createElement('div');box.className='mp-alloggiati-metric';const number=document.createElement('strong'),caption=document.createElement('span');number.className='mp-alloggiati-number';number.textContent=value===null?'—':value.toLocaleString('it-IT');caption.textContent=label;box.append(number,caption);if(note){const small=document.createElement('small');small.textContent=note;box.append(small);}metrics.append(box);};
      const downloaded=fresh?integer(p.newReceipts):null;addMetric(downloaded,'Nuove ricevute',fresh?(downloaded===0?'Nessuna nuova nell’ultimo controllo':'Scaricate nell’ultimo controllo'):'Da verificare con un nuovo controllo');
      const copied=integer(p.copiesWritten);addMetric(copied,'File copiati su Drive',copied===null?'Conteggio non disponibile':'Nell’ultimo controllo');card.append(metrics);
      const dates=document.createElement('dl');dates.className='mp-alloggiati-dates';for(const [label,value]of [['Ultimo recupero',formatDate(p.lastScanUtc)],['Prossimo automatico',formatDate(p.nextScanUtc)]]){const group=document.createElement('div'),term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=value;group.append(term,description);dates.append(group);}card.append(dates);
      const delivery=document.createElement('p');delivery.className='mp-alloggiati-delivery';const copiedOk=p.delivery==='copia locale in Drive verificata; sincronizzazione cloud gestita da Drive'&&p.pendingDelivery===false;delivery.dataset.verified=String(copiedOk);delivery.textContent=copiedOk?'✓ Copia nella cartella Drive verificata':p.delivery==='non controllata'?'Copia su Drive non ancora controllata':'Copia su Drive da verificare';card.append(delivery);
      if(p.errors?.length){const details=document.createElement('details');details.className='mp-alloggiati-errors';const title=document.createElement('summary'),list=document.createElement('ul');title.textContent='Dettagli da controllare ('+p.errors.length+')';for(const error of p.errors){const item=document.createElement('li');item.textContent=error;list.append(item);}details.append(title,list);card.append(details);}
      const folder=document.createElement('button');folder.type='button';folder.className='mp-secondary mp-alloggiati-folder';folder.dataset.alloggiatiProfile=p.id;folder.dataset.available=String(p.folderAvailable!==false&&typeof api.openAlloggiatiFolder==='function');folder.disabled=busy||folder.dataset.available!=='true';folder.textContent='Apri cartella schedine →';folder.setAttribute('aria-label','Apri cartella schedine di '+p.label);if(folder.dataset.available!=='true')folder.title='Cartella non disponibile: controlla la configurazione dell’appartamento.';card.append(folder);target.append(card);
    }
    if(!a.profiles?.length){const empty=document.createElement('p');empty.className='mp-alloggiati-empty';empty.textContent=a.configured?'Non c’è ancora un riepilogo. Premi Controlla e recupera per cercare le ricevute.':'Gli account Alloggiati non sono configurati per questo utente Windows.';target.append(empty);}
    q('.mp-last-check').textContent=a.checkedUtc?'Riepilogo del controllo · '+formatDate(a.checkedUtc):'Nessun controllo ancora disponibile.';renderedAlloggiati=key;
  }
  function renderHistory(){if(!overview)return;const entries=overview.history||[],max=Math.max(1,Math.ceil(entries.length/3));historyPage=Math.max(0,Math.min(max-1,historyPage));const key=JSON.stringify([historyPage,entries]);if(key===renderedHistory)return;const list=q('.mp-history');list.replaceChildren();for(const item of entries.slice(historyPage*3,historyPage*3+3)){const li=document.createElement('li'),time=document.createElement('time'),title=document.createElement('strong'),detail=document.createElement('small');time.textContent=formatDate(item.time);title.textContent=(item.ok?'✓ ':'! ')+item.title;detail.textContent=item.detail;li.append(time,title,detail);if(item.outputId&&item.module==='ricevuta'){const button=document.createElement('button');button.type='button';button.className='mp-link';button.dataset.output=item.outputId;button.textContent=item.module==='ricevuta'?'Apri PDF':'Apri rapporto';li.append(button);}list.append(li);}if(!entries.length){const li=document.createElement('li');li.className='mp-empty';li.textContent='Nessuna operazione avviata da Mochi Pocket.';list.append(li);}q('.mp-history-nav').hidden=max<=1;q('.mp-history-page').textContent=(historyPage+1)+' / '+max;q('[data-history="prev"]').disabled=historyPage===0;q('[data-history="next"]').disabled=historyPage>=max-1;renderedHistory=key;}
  async function refresh(){overview=await api.overview();renderMetadata();return overview;}
  function calendarDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4):'Date da verificare';}
  function lock(value){busy=value;qa('[data-operation],.mp-a,.mp-start,[data-tax-control],[data-cleaning-control]').forEach(b=>b.disabled=value||b.dataset.taxUnavailable==='true');qa('[data-alloggiati-profile]').forEach(b=>b.disabled=value||b.dataset.available!=='true');q('.mp-screen-content').setAttribute('aria-busy',String(value));q('.mp-import').setAttribute('aria-disabled',String(value));renderGoogleConnection(googleConnection.getState());renderGoogleLogin();receiptUI.renderBusy();renderAlert();taxUI.syncBusy();}
  function cancellationControls(conflict){return (conflict.otherBookings||[]).map(booking=>booking.cancellationConfirmed?'<p class="mp-small-note">Cancellazione registrata. Il prossimo aggiornamento riguarda soltanto le date dell’Excel.</p>':booking.canCancel?`<div class="mp-kross-cancel"><p>${escape(booking.reference||'Prenotazione')} · ID ${escape(booking.id)} · Notti: ${(booking.dates||[]).map(calendarDate).map(escape).join(', ')}</p><button type="button" class="mp-secondary" data-action="confirm-kross-cancellation" data-operation data-calendar-id="${escape(conflict.calendarId)}" data-booking-id="${escape(booking.id)}" data-revision="${escape(booking.revision)}">Conferma cancellazione</button><p class="mp-small-note">Usa questo tasto se il soggiorno è stato cancellato. Poi premi Simula o Aggiorna: saranno liberate solo le date presenti nell’Excel.</p></div>`:'').join('');}
  async function confirmCalendarCancellation(button){
    if(busy||button.disabled)return;lock(true);
    try{const result=await api.confirmKrossCancellation({calendarId:button.dataset.calendarId,bookingId:button.dataset.bookingId,revision:button.dataset.revision,confirmed:true});if(result.summary)renderKrossSummary(result);message(result.ok?result.message||'Cancellazione registrata. Premi Simula per controllare.':result.error||'Cancellazione non registrata.',!result.ok,'calendari',{auth:false});}
    catch{message('Cancellazione non registrata. Riprova.',true,'calendari',{auth:false});}
    finally{lock(false);resize();}
  }
  function renderKrossSummary(result){const box=q('.mp-kross-summary'),s=result.summary,button=q('.mp-report');button.hidden=false;if(!s){box.replaceChildren();box.hidden=true;button.textContent='Vedi ultimo riepilogo';button.setAttribute('aria-expanded','false');return;}const hasConflicts=Number(s.conflicts)>0;button.setAttribute('aria-expanded',String(hasConflicts));button.textContent=hasConflicts?'Nascondi riepilogo':'Vedi riepilogo';box.hidden=!hasConflicts;
    const title=hasConflicts?'Perché l’importazione si è fermata':result.ok?(result.dryRun?'Simulazione completata':'Calendari aggiornati'):'Operazione da controllare';
    const explanation=hasConflicts?'Nessun calendario è stato modificato. Anche le nuove prenotazioni elencate sono soltanto previste finché questi conflitti non vengono risolti.':result.dryRun?'Queste sono le modifiche previste. La simulazione non modifica i calendari.':result.ok?'Le modifiche sono state salvate nei calendari selezionati.':result.outcomeUnknown?'Alcune modifiche potrebbero essere già state salvate. Verifica i calendari prima di riprovare.':'Controlla l’esito prima di riprovare.';
    const details=Array.isArray(s.conflictDetails)?s.conflictDetails:[],metadata=[result.checkedAt?'Controllo del '+formatDate(result.checkedAt):'',result.sourceFile?'Excel: '+result.sourceFile:''].filter(Boolean).join(' · ');
    const conflictHtml=hasConflicts?`<div class="mp-kross-conflicts" aria-label="Dettaglio dei conflitti">${details.length?details.map((conflict,index)=>`<article class="mp-kross-conflict"><div class="mp-kross-conflict-heading"><span>${index+1}</span><h4>${escape(houseNames[conflict.initial]||conflict.calendarName)} ${escape(conflict.year||'')} · ${escape(conflict.title)}</h4></div>${conflict.dates?.length?`<p class="mp-kross-conflict-dates">Notti: ${conflict.dates.map(calendarDate).map(escape).join(', ')}${conflict.cells?.length?' · Celle: '+conflict.cells.map(escape).join(', '):''}</p>`:conflict.cells?.length?`<p class="mp-kross-conflict-dates">Celle: ${conflict.cells.map(escape).join(', ')}</p>`:''}${conflict.reference||conflict.bookingId?`<p><strong>Prenotazione:</strong> ${escape(conflict.reference||'Nome non disponibile')}${conflict.bookingId?' · ID '+escape(conflict.bookingId):''}</p>`:''}${conflict.otherBookings?.length?`<p><strong>Già associata alle date:</strong> ${conflict.otherBookings.map(booking=>escape(booking.reference||'Prenotazione')+' · ID '+escape(booking.id)).join('; ')}</p>`:''}<p>${escape(conflict.explanation)}</p>${conflict.comparisons?.length?`<div class="mp-summary-table"><table><thead><tr><th>Cella</th><th>Registrato dallo script</th><th>Nel calendario</th></tr></thead><tbody>${conflict.comparisons.map(cell=>`<tr><th>${escape(cell.cell||calendarDate(cell.date))}</th><td>${escape(cell.expected||'Vuoto')}</td><td>${escape(cell.actual||'Vuoto')}</td></tr>`).join('')}</tbody></table></div>`:''}<p class="mp-kross-conflict-action"><strong>Cosa controllare:</strong> ${escape(conflict.action)}</p>${cancellationControls(conflict)}</article>`).join(''):'<p>Questo rapporto non contiene il dettaglio dei conflitti. Premi Simula per preparare un controllo aggiornato.</p>'}</div>`:'';
    box.innerHTML=`<h3>${escape(title)}</h3><p>${escape(explanation)}</p>${s.scopeMode==='source_dates'?'<p class="mp-small-note">Aggiornamento limitato alle date presenti nell’Excel per ciascuna struttura.</p>':''}${metadata?`<p class="mp-small-note mp-kross-report-source">${escape(metadata)}</p>`:''}${conflictHtml}<div class="mp-summary-counts">${[['added','Nuove previste'],['updated','Modificate'],['cancelled','Cancellate'],['conflicts','Conflitti']].map(([key,label])=>`<div><strong>${Number(s[key])||0}</strong><span>${label==='Nuove previste'&&!hasConflicts&&!result.dryRun?'Nuove':label}</span></div>`).join('')}</div>${s.calendars?.length?`<div class="mp-summary-table"><table><thead><tr><th>Calendario</th><th>Nuove</th><th>Modificate</th><th>Cancellate</th><th>Conflitti</th></tr></thead><tbody>${s.calendars.map(c=>`<tr><th>${escape(houseNames[c.initial]||c.name)} ${escape(c.year||'')}</th><td>${Number(c.added)||0}</td><td>${Number(c.updated)||0}</td><td>${Number(c.cancelled)||0}</td><td>${Number(c.conflicts)||0}</td></tr>`).join('')}</tbody></table></div>`:''}`;
  }
  async function showKrossReport(){
    if(busy)return;const box=q('.mp-kross-summary'),button=q('.mp-report');
    if(!box.childElementCount){lock(true);try{const result=await api.latestKrossReport();if(!result?.summary){message(result?.error||'Nessun riepilogo salvato. Premi Simula per preparare un controllo.',true,'calendari',{auth:false});return;}renderKrossSummary(result);box.hidden=false;message('Riepilogo salvato caricato. Nessuna nuova importazione avviata.',false,'calendari');}catch{message('Non riesco a leggere l’ultimo riepilogo. Premi Simula per preparare un nuovo controllo.',true,'calendari',{auth:false});return;}finally{lock(false);}}
    else box.hidden=!box.hidden;
    button.setAttribute('aria-expanded',String(!box.hidden));button.textContent=box.hidden?'Vedi riepilogo':'Nascondi riepilogo';if(!box.hidden)box.scrollIntoView({block:'start'});
  }
  async function task(module,fn,kind=module){
    let rereadNumber=false;
    if(busy)return;taskScreen=module;alerts.delete(module);lock(true);message('Mochi sta lavorando…',false,module,{tone:'working'});if(kind==='calendari'){q('.mp-report').hidden=true;q('.mp-kross-summary').hidden=true;}
    try{
      const result=await fn();let text;
      if(!result.ok){text=result.error||result.message||'Operazione non completata.';if(result.summary?.conflicts)text=`${result.summary.conflicts} conflitti: nessun calendario aggiornato. Nel riepilogo trovi date, prenotazioni e cosa controllare.`;}
      else if(kind==='ricevuta'){receiptUI.acceptGenerated(result);rereadNumber=true;text='PDF salvato: '+result.filename;}
      else if(kind==='calendari'){const s=result.summary;text=s?`${result.dryRun?'Simulazione':'Aggiornamento'}: ${s.added} nuove, ${s.updated} modificate, ${s.cancelled} cancellate, ${s.conflicts} conflitti.`:result.message||'Operazione completata.';}
      else text=result.message||'Operazione completata.';
      const canceled=kind==='google'&&result.canceled===true;
      if(result.ok||canceled)alerts.delete(module);message(text+(result.warning?' '+result.warning:''),!result.ok&&!canceled,module,{tone:canceled?'info':result.ok?(result.warning?'attention':'success'):undefined,attention:!!result.warning,...(kind==='google'?{auth:!canceled,suppressAlert:true}: {})});
      if(result.ok&&!result.warning)sfx('success');if(kind==='calendari'&&result.ok){colorsUI.invalidate();if(!result.dryRun)cleaningUI.invalidate();}
      if(kind==='calendari'){renderKrossSummary(result);if(result.summary?.conflicts)q('.mp-kross-summary').scrollIntoView({block:'start'});}
      await refresh();return result;
    }catch{message('Il collegamento locale si è interrotto. Riapri l’app e controlla il diario.',true,module);}
    finally{taskScreen=null;lock(false);if(rereadNumber)receiptUI.requestNumber(true);resize();}
  }
  async function connectGoogle(){
    if(busy||googleConnecting||googleStopping)return;
    googleConnecting=true;googleNeedsRetry=false;renderGoogleLogin();
    googleConnection.invalidate('Completa il collegamento Google nel browser.');
    const pending=task(active,()=>api.reconnectGoogle(),'google');googleLoginPending=pending;
    try{
      const result=await pending;
      googleNeedsRetry=!result?.ok&&!result?.canceled;
      googleLoginDetail=result?.error||result?.message||'Collegamento interrotto. Premi Riprova per aprire un nuovo tentativo.';
      if(result?.canceled)googleConnection.invalidate('Collegamento annullato. Puoi riprovare quando vuoi.');
      if(result?.ok)googleConnection.verify(true);
    }finally{if(googleLoginPending===pending)googleLoginPending=null;googleConnecting=false;renderGoogleLogin();}
  }
  async function stopGoogleConnection(retry=false){
    if(googleStopping)return;
    if(!googleConnecting){if(retry)await connectGoogle();else{googleNeedsRetry=false;renderGoogleLogin();}return;}
    googleStopping=true;renderGoogleLogin();
    const pending=googleLoginPending;
    try{
      const result=await api.cancelGoogleConnection();
      if(!result.ok){message(result.error||'Non riesco a interrompere il collegamento. Riprova.',true,taskScreen||active);return;}
      await pending;
    }catch{message('Non riesco a interrompere il collegamento Google. Riprova.',true,taskScreen||active);return;}
    finally{googleStopping=false;renderGoogleLogin();}
    if(retry)await connectGoogle();
  }
  async function runKross(dryRun){return task('calendari',()=>api.runKross({dryRun,calendars:qa('.mp-houses input:checked').map(i=>i.value),overwriteManual:!q('.mp-protect').checked}));}
  async function editReceiptProfile(id){
    returnToReceipt=true;
    await show('settings');
    if([...q('.mp-profile-picker').options].some(option=>option.value===id))q('.mp-profile-picker').value=id;
    selectEditorProfile(id);
    q('.mp-profile-editor').scrollIntoView({block:'start'});
  }
  async function addReceiptProperty(initial){
    await show('settings');
    const pending='pending-'+initial;
    if([...q('.mp-profile-picker').options].some(option=>option.value===pending))q('.mp-profile-picker').value=pending;
    fillProfile(draftProfile(initial));
    q('#profile-form').scrollIntoView({block:'start'});
  }
  function syncHouseNames(data){
    const calendars=[...(data?.kross?.calendars||[]),...(data?.receiptCalendar?.calendars||[])];
    for(const c of calendars){if(c&&typeof c.initial==='string'&&!houseNames[c.initial])houseNames[c.initial]=String(c.name||c.initial).replace(/\s+Google(?:\s*\d{4})?$/i,'').trim();}
    window.mochiKrossColorsUI?.setHouses(houseNames);
  }
  function draftProfile(initial){return {calendarInitial:initial,label:houseNames[initial]||'',property:{name:houseNames[initial]||'',address:houseAddresses[initial]||'',city:'',kind:'CAV'}};}
  function selectEditorProfile(value){fillProfile(value?.startsWith('pending-')?draftProfile(value.slice(8)):profiles.find(p=>p.id===value)||null);}
  async function loadProfileEditor(preferred){const response=await api.profileDetails();profiles=response.profiles||[];const picker=q('.mp-profile-picker');const selected=preferred||picker.value;const missing=Object.entries(houseNames).filter(([initial])=>!overview.receipt.profiles?.some(p=>receiptUI.profileInitial(p.id)===initial));picker.innerHTML=profiles.map(p=>`<option value="${escape(p.id)}">${escape(p.label)}</option>`).join('')+missing.map(([initial,label])=>`<option value="pending-${escape(initial)}">${escape(label)} — da configurare</option>`).join('');if([...picker.options].some(p=>p.value===selected))picker.value=selected;selectEditorProfile(picker.value);}
  function fillProfile(p){const form=q('#profile-form'),values={id:p?.id||'',label:p?.label||'',calendarInitial:p?.calendarInitial||'',issuerName:p?.issuer?.name||'',issuerTaxId:p?.issuer?.taxId||'',issuerAddress:(p?.issuer?.address||[]).join('\n'),propertyName:p?.property?.name||'',propertyAddress:p?.property?.address||'',propertyCity:p?.property?.city||'',propertyKind:p?.property?.kind||'CAV'};for(const [key,value]of Object.entries(values))form.elements[key].value=value;}
  q('.mp-profile-picker').addEventListener('change',()=>selectEditorProfile(q('.mp-profile-picker').value));
  async function saveProfile(){const form=q('#profile-form');if(!form.reportValidity())return;const d=Object.fromEntries(new FormData(form));const previous=profiles.find(p=>p.id===d.id);const profile={id:d.id||'casa-'+Date.now(),label:d.label,calendarInitial:d.calendarInitial,...(previous?.outputDir?{outputDir:previous.outputDir}:{}),issuer:{name:d.issuerName,taxId:d.issuerTaxId,taxLabel:previous?.issuer?.taxLabel||'P. IVA / C.F.',address:d.issuerAddress.split(/\r?\n/)},property:{name:d.propertyName,address:d.propertyAddress,city:d.propertyCity,kind:d.propertyKind}};const result=await api.saveProfile(profile);message(result.ok?'Profilo salvato. Puoi creare le ricevute.':result.error,!result.ok,'settings');if(result.ok){sfx('success');await refresh();await loadProfileEditor(profile.id);if(returnToReceipt){returnToReceipt=false;receiptUI.selectProfile(profile.id);await show('ricevuta');message('Emittente aggiornato. Puoi continuare con la ricevuta.',false,'ricevuta');}}}
  function back(){if(active==='sleep'){show(pausedFrom);return;}if(active==='settings'&&returnToReceipt){returnToReceipt=false;show('ricevuta');return;}if(active==='ricevuta'&&receiptUI.back())return;if(active==='tasse'&&taxUI.back())return;show('home');}
  async function primary(start=false){if(active==='sleep'){show(pausedFrom);return;}if(busy)return;if(active==='home'){show(menu[selection].dataset.module);return;}if(active==='ricevuta'){await receiptUI.primary();}else if(active==='calendari'){if(!overview?.selectedFile)await actions['choose-kross']();else await runKross(!start);}else if(active==='alloggiati')await task('alloggiati',()=>api.runAlloggiati());else if(active==='tasse')await taxUI.primary();else if(active==='pulizie')await cleaningUI.load(true);else if(active==='settings')await saveProfile();else back();}
  function move(direction){if(active==='home'){selection=(selection+(direction==='up'||direction==='left'?-1:1)+menu.length)%menu.length;updateMenu();}else if(active==='ricevuta')receiptUI.move(direction);else if(active==='tasse')taxUI.move(direction);else if(active==='attivita'){historyPage+=direction==='left'||direction==='up'?-1:1;renderHistory();}}
  const actions={
    'simulate':()=>runKross(true),'update':()=>runKross(false),alloggiati:()=>task('alloggiati',()=>api.runAlloggiati()),
    refresh:async()=>{await refresh();message('Stato locale aggiornato.');},
    'choose-kross':async()=>{const r=await api.chooseKross();if(r.ok){colorsUI.invalidate();await refresh();message('Excel selezionato: '+r.name);}else if(!r.canceled)message(r.error,true);},
    settings:()=>{returnToReceipt=false;show('settings');},
    'return-receipt':()=>{returnToReceipt=false;show('ricevuta');},
    'check-google':()=>googleConnection.verify(true),
    google:connectGoogle,'google-retry':()=>stopGoogleConnection(true),'google-cancel':()=>stopGoogleConnection(false),
    'dismiss-alert':()=>{alerts.delete(active);renderAlert();},
    'show-report':showKrossReport,'confirm-kross-cancellation':confirmCalendarCancellation,
    'choose-kross-folder':async()=>{const r=await api.chooseKrossFolder();if(r.ok){googleConnection.invalidate();cleaningUI.invalidate();colorsUI.invalidate();await refresh();message('Cartella Kross collegata.',false,'settings');if(!busy)googleConnection.verify(true);}else if(!r.canceled)message(r.error,true,'settings');},
    'new-profile':()=>fillProfile(null),'save-profile':saveProfile,
    'sound-toggle':()=>{if(!audio)return;const state=audio.getSettings();if(state.muted||state.volume===0){if(state.volume===0)audio.setVolume(.35);audio.setMuted(false);sfx('click');}else audio.setMuted(true);syncAudio();},
    'sound-preview':()=>sfx('confirm'),
  };
  root.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.action&&actions[button.dataset.action])await actions[button.dataset.action](button);if(button.dataset.alloggiatiProfile&&!busy&&!button.disabled){try{const result=await api.openAlloggiatiFolder(button.dataset.alloggiatiProfile);if(!result.ok)message(result.error||'Cartella schedine non disponibile.',true,'alloggiati',{auth:false});}catch{message('Non riesco ad aprire la cartella delle schedine.',true,'alloggiati',{auth:false});}}if(button.dataset.folder){const result=await api.openFolder(button.dataset.folder,button.dataset.folder==='receipts'?receiptUI.profileId():undefined);if(!result.ok)message(result.error||'Cartella non disponibile.',true);}if(button.dataset.output){const r=await api.openOutput(button.dataset.output);if(!r.ok)message(r.error,true);}if(button.dataset.history){historyPage+=button.dataset.history==='prev'?-1:1;renderHistory();}});
  qa('form').forEach(form=>form.addEventListener('submit',e=>e.preventDefault()));
  menu.forEach((button,i)=>button.addEventListener('click',()=>{selection=i;updateMenu();show(button.dataset.module);}));
  qa('[data-direction]').forEach(button=>button.addEventListener('click',()=>move(button.dataset.direction)));
  q('.mp-a').addEventListener('click',()=>primary());q('.mp-start').addEventListener('click',()=>primary(true));q('.mp-b').addEventListener('click',back);q('.mp-select').addEventListener('click',()=>show(active==='attivita'?'home':'attivita'));
  q('.mp-settings-button').addEventListener('click',()=>show('settings'));q('.mp-minimize').addEventListener('click',()=>api.minimize());q('.mp-close').addEventListener('click',()=>api.close());
  q('.mp-power').addEventListener('click',()=>{if(active==='sleep')show(pausedFrom);else{pausedFrom=active;show('sleep');}});
  q('.mp-mochi').addEventListener('click',()=>message(['Ciao, sono Mochi. Mettiamoci al lavoro.','Un file alla volta, tutto in ordine.','Il diario conserva gli esiti delle operazioni.'][greeting++%3]));
  root.addEventListener('keydown',event=>{if(event.target.closest('input,textarea,select')||event.altKey||event.ctrlKey||event.metaKey)return;const keys={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'};if(keys[event.key]){event.preventDefault();sfx('move');move(keys[event.key]);}else if(event.key==='Escape'){event.preventDefault();sfx('back');back();}else if(event.key.toLowerCase()==='a'){event.preventDefault();sfx('confirm');primary();}else if(event.key.toLowerCase()==='b'){event.preventDefault();sfx('back');back();}});
  q('.mp-houses').addEventListener('change',()=>colorsUI.invalidate());
  const dropZone=q('.mp-import');let dragDepth=0;
  for(const type of ['dragover','drop'])document.addEventListener(type,event=>event.preventDefault());
  dropZone.addEventListener('dragenter',event=>{event.preventDefault();if(!busy){dragDepth++;dropZone.classList.add('mp-dragging');}});
  dropZone.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;dropZone.classList.remove('mp-dragging');}});
  dropZone.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=busy?'none':'copy';});
  dropZone.addEventListener('drop',async event=>{event.preventDefault();dragDepth=0;dropZone.classList.remove('mp-dragging');if(busy){message('Aspetta il termine dell’operazione prima di cambiare Excel.',false,'calendari');return;}const files=[...(event.dataTransfer?.files||[])];if(files.length!==1||!files[0].name.toLowerCase().endsWith('.xlsx')){message('Trascina un solo file Excel .xlsx esportato da Kross.',true,'calendari');return;}try{const result=await api.selectDroppedKross(files[0]);if(result.ok){colorsUI.invalidate();await refresh();alerts.delete('calendari');message('Excel pronto: '+result.name,false,'calendari',{tone:'success'});sfx('confirm');}else message(result.error||'Non riesco a leggere questo Excel.',true,'calendari');}catch{message('Trascinamento non riuscito. Usa Scegli Excel.',true,'calendari');}});
  api.onProgress(value=>{const google=value.module==='google',where=google?(taskScreen||active):value.module,attention=google&&!googleConnecting&&/browser|accesso|consenso/i.test(value.message);message(value.message,false,where,{tone:attention?'attention':'working',attention,auth:attention});});
  function resize(){api.resize(Math.ceil(q('.mp-console').getBoundingClientRect().height+42));}
  new ResizeObserver(resize).observe(q('.mp-console'));
  if(globalThis.lucide)lucide.createIcons();
  refresh().then(()=>{lock(false);message('Mochi è pronto. Scegli uno strumento.');resize();}).catch(()=>{lock(false);message('Avvio del collegamento locale non riuscito.',true);});
  setInterval(()=>{if(active==='alloggiati'&&!busy)refresh().catch(()=>{});},30000);
})();
