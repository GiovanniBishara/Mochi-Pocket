# Architettura di Mochi Pocket

Versione 0.13.0.

L'app è un'applicazione desktop locale con servizi organizzati per funzione. Questa struttura è adeguata alle dimensioni e alle operazioni di Mochi: non richiede un nuovo framework, un server permanente o servizi separati.

## Confini e responsabilità

| Livello | File principali | Responsabilità |
| --- | --- | --- |
| Electron | `app/main.cjs`, `app/preload.cjs` | Finestra, dialoghi, origine delle richieste IPC, apertura dei risultati. Il bridge espone operazioni nominate, senza accesso generico a file o comandi. |
| Interfaccia | `app/ui/renderer.js`, controller `receipt.js`, `tourist-tax.js`, `cleaning.js`, `kross-colors.js` | Il coordinatore collega le schermate; ogni controller possiede il proprio DOM, stato ed eventi. Nessun accesso diretto alla rete; i conteggi salvati sono validati nel backend. |
| Regole condivise pure | `app/shared/tourist-tax-quick.js` | Proposte e conferme rapide, usate dal browser e dal servizio senza dipendenze da DOM, Electron, file o processi. |
| Coordinamento | `app/service.cjs` | Configurazione degli adapter, esclusione delle operazioni incompatibili, diario, invalidazione delle letture e composizione dei risultati. |
| Accesso alle fonti | `app/*-source.cjs`, adapter ricevute/Kross/Alloggiati e helper Python | Runtime, processi, protocolli JSON, validazione delle risposte, timeout e messaggi utilizzabili nell'interfaccia. |
| Archivi e calcoli | `app/tourist-tax.cjs`, `app/cleaning-exclusions.cjs`, motore Kross | Regole fiscali, identità delle righe, conferme, revisioni e persistenza. |

I motori operativi si trovano in `engines/`; le cartelle dati dell'utente restano esterne al codice e nessuna struttura, percorso o credenziale è scritta nel programma: case e calendari arrivano da `config.json`, gli emittenti da `receipt-profiles.json`. Python è quello installato sul PC; Node non serve, perché il motore Kross gira dentro Electron (`ELECTRON_RUN_AS_NODE`).

## Ottimizzazioni mantenute dalla versione 0.12

- Un solo overview all'avvio; ricerca delle vecchie cartelle profilo soltanto quando manca il file attuale.
- Ricerca del numero ricevuta quando serve e aggiornamenti degli elenchi soltanto se i dati cambiano.
- Letture delle pulizie concorrenti con massimo tre attività, ordine stabile e rinnovo OAuth coordinato per token.
- Blocco acquisito prima delle verifiche asincrone nelle fonti tasse e colori; modifiche alla configurazione coordinate dal servizio.
- Regole della conferma rapida spostate dalla UI al modulo condiviso, mantenendo un'unica implementazione per browser e backend.

## Moduli delle schermate, versione 0.13

`receipt.js` possiede il percorso della ricevuta: template, passaggi del modulo, scelta emittente, ricerca del soggiorno, numerazione e collegamento al PDF. Riceve il riepilogo corrente tramite una funzione di lettura; la modifica dell'emittente e le operazioni generali sono callback esplicite verso il coordinatore. Le risposte della numerazione sono accettate soltanto se generazione e contesto sono ancora validi. Un numero manuale resta protetto e la ricerca dell'archivio parte soltanto nel percorso ricevute.

`tourist-tax.js` possiede filtri, bozze, riepilogo, righe rapide, editor dettagliato e azioni fiscali della schermata. Usa il modulo puro `shared/tourist-tax-quick.js` per le proposte; il servizio resta responsabile della validazione e del salvataggio. Una risposta relativa a un altro periodo non sostituisce i dati del periodo selezionato.

Entrambi i controller cercano elementi soltanto nel proprio contenitore e registrano lì gli eventi. Le stesse azioni sono state rimosse dal dispatcher generale, evitando chiamate duplicate. La navigazione della console usa metodi dedicati (`back`, `primary`, `move`), senza accedere alle bozze interne. Il blocco delle operazioni e i messaggi restano coordinati nell'app; i controller ricevono funzioni specifiche per usarli.

`renderer.js` conserva avvio, navigazione, stato generale, collegamento Google, editor dei profili e le parti preesistenti dei calendari/Alloggiati/diario. È passato da circa 104 KB a 49 KB. Questa riduzione riguarda la concentrazione delle responsabilità: il codice delle due schermate viene ancora caricato normalmente, senza promettere un guadagno di velocità dalla sola separazione. Non sono state aggiunte dipendenze.

## Vincoli da preservare

Le scritture dei calendari richiedono letture e controlli aggiornati. Una cache utile per mostrare i dati non sostituisce questi controlli. L'esclusione delle pulizie rilegge la fonte e verifica la revisione della riga prima di salvare.

Le operazioni potenzialmente incompatibili passano dal coordinatore del servizio; ogni adapter protegge anche il proprio processo. Le letture parallele riguardano fonti indipendenti e non autorizzano scritture concorrenti. OAuth mantiene il proprio ciclo di annullamento, timeout e pubblicazione del token.

Le differenze di contratto tra adapter sono intenzionali: esito incerto di una scrittura, errore di autenticazione, lettura parziale e archivio non disponibile richiedono trattamenti distinti. Gli errori destinati all'interfaccia non riportano stderr o credenziali.

Le regole concordate restano nei moduli di dominio: importazione limitata alle date presenti nell'export, colori manuali modificabili, tassa attribuita per arrivo, esclusioni delle pulizie visibili e reversibili.

## Miglioramenti successivi, in ordine

1. **Applicare gli stessi confini alle prossime modifiche delle altre schermate.** Tasse e ricevute sono già separate. Calendari, Alloggiati, diario ed editor dei profili possono seguire il medesimo modello quando si interviene su quelle funzioni, mantenendo il coordinamento nel renderer. Evitare di frammentare funzioni brevi senza una responsabilità autonoma.
2. **Condividere il solo trasporto JSON dei lettori Python.** Avvio, limiti di output e timeout sono ripetuti. Un helper circoscritto ai lettori potrebbe ridurre le divergenze, lasciando validazione, errori, cache e blocchi nei singoli adapter. Non includere nello stesso passaggio login OAuth e operazioni di scrittura.
3. **Separare gli algoritmi Python dai comandi.** Le pulizie riusano il raggruppamento dei soggiorni importando il comando delle tasse. Un modulo puro comune renderebbe esplicito il riuso, con test di equivalenza dei risultati.

Non sono necessari endpoint aggiuntivi o nuove cache finché le misure non ne dimostrano l'utilità. Nel campione Google il costo principale era l'attesa di rete; la decodifica locale richiedeva circa 26 ms su una lettura di 2,6 s. Mantenere le copie e i controlli protettivi è preferibile a ridurli per un guadagno trascurabile.

## Verifica delle modifiche

I test dei servizi usano adapter iniettati e dati temporanei; quelli degli adapter simulano processi e risposte. I controlli desktop usano un profilo QA separato. Le misure prestazionali distinguono conteggi delle operazioni, latenza controllata e letture reali. Le letture reali confrontano i risultati completi e verificano che configurazioni e registri restino identici.

Nel repository: `tests/` prova il motore Kross dall'inizio alla fine sulle strutture inventate di `examples/` (simulazione, idempotenza, check-out escluso, cancellazioni, scelta dei calendari) e il controllo privacy. `scripts/demo-browser.cjs` avvia il vero backend e la vera interfaccia in Chromium, senza Electron, sugli stessi dati inventati.
