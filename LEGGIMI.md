# Mochi Pocket: guida alla configurazione

Questa guida porta da zero a Mochi funzionante sul tuo PC, con le tue strutture.
Ci vogliono circa 20 minuti; Google e Alloggiati Web sono facoltativi e si
possono aggiungere dopo.

> Mochi lavora solo sul tuo computer. Le tue strutture, i calendari, le
> credenziali e i dati degli ospiti stanno in cartelle tue, **mai** dentro la
> cartella del programma: puoi aggiornarlo o condividerlo senza portarti dietro
> nessun dato.

## 1. Cosa serve

| | |
| --- | --- |
| **Windows 10 o 11** | Alloggiati Web e la cifratura delle credenziali usano funzioni di Windows. |
| **Python 3.10+** | Da [python.org](https://www.python.org/downloads/) (spunta *Add python.exe to PATH*). Genera i PDF e legge gli Excel. |
| **Node.js 20+** | Solo per installare e avviare dai sorgenti: [nodejs.org](https://nodejs.org). |

## 2. Installazione

```powershell
git clone https://github.com/GiovanniBishara/Mochi-Pocket.git
cd Mochi-Pocket
npm install
pip install -r requirements.txt
npm start
```

Si apre la console di Mochi. **A** conferma, **B** torna indietro, **SELECT**
apre il diario, **START** esegue l'azione principale; va bene anche il mouse.

## 3. Prova con i dati d'esempio (2 minuti)

Nella cartella `examples/` ci sono tre strutture **inventate** (Glicine,
Lavanda, Ortensia) con calendari Excel vuoti e un export Kross con prenotazioni
finte.

1. **⚙ Impostazioni → Trova cartella calendari** e scegli `examples\calendari`.
2. **Calendari Kross → Scegli Excel** e scegli `examples\kross-export-esempio.xlsx`.
3. **Simula prima**: Mochi mostra cosa scriverebbe nei calendari, senza toccarli.
4. **Aggiorna →**: i nomi degli ospiti finiscono nelle notti giuste (il giorno di
   partenza resta libero, la prenotazione cancellata non entra).

Per ricominciare da capo: `python scripts\make_example.py`.

## 4. Le tue strutture

### 4.1 La cartella dei calendari

Crea una cartella, per esempio `Documenti\Mochi Pocket\calendari`, e dentro un
file `config.json`. Un calendario per struttura e per anno:

```json
{
  "version": 1,
  "calendars": [
    {
      "id": "glicine-2026",
      "name": "Glicine",
      "type": "excel",
      "file": "Glicine.xlsx",
      "sheetName": "2026",
      "roomName": "Appartamento Glicine"
    }
  ]
}
```

| Campo | Cosa mettere |
| --- | --- |
| `id` | Un codice tuo, senza spazi (lettere, numeri, `-`). |
| `name` | Il nome che vedi in Mochi. **La prima lettera è la scorciatoia** della struttura: usa iniziali diverse. |
| `type` | `excel` (un file sul PC) oppure `google` (un Foglio Google, vedi 4.3). |
| `file` | Per `excel`: il file, relativo alla cartella dei calendari. |
| `spreadsheet` | Per `google`: l'indirizzo del foglio o il suo ID. |
| `sheetName` | Il nome della scheda dell'anno: `2026`. |
| `roomName` | La camera **esattamente come compare nella colonna "Camere" dell'export Kross**. |
| `idColumn` | Facoltativo: colonna in cui scrivere l'ID della prenotazione Kross (da `D` in poi). |

**Com'è fatto un calendario**: una scheda per anno chiamata con l'anno
(`2026`); nella colonna **B**, dalla riga 3, tutti i giorni dell'anno uno sotto
l'altro; nella colonna **C** il nome dell'ospite (Mochi scrive solo lì). Il resto
del foglio è tuo: formule, colori e note non vengono toccati. Il modo più rapido
per partire è copiare `examples\calendari\Glicine.xlsx`.

Poi in Mochi: **⚙ Impostazioni → Trova cartella calendari**.

### 4.2 L'export di Kross

In Kross esporta le prenotazioni in Excel includendo, se puoi, anche quelle
cancellate. Servono almeno le colonne `ID`, `Camere`, `Riferimento`, `Check in`,
`Check-out`, `Stato`; `Canale`, `Ospiti`, `Addebito soggiorno`, `Commissioni` e
`Note` vengono usate se ci sono. Mochi aggiorna **solo le notti presenti
nell'export**, una struttura alla volta, e con *Proteggi le modifiche manuali*
non sovrascrive quello che hai scritto tu.

### 4.3 Fogli Google (facoltativo)

Servono per usare calendari su Google Sheets, per le **Pulizie del mese** (che
leggono solo calendari Google) e per i colori delle prenotazioni.

1. Su [Google Cloud Console](https://console.cloud.google.com/) crea un progetto,
   attiva **Google Sheets API** e crea credenziali **ID client OAuth** di tipo
   **App desktop**.
2. Scarica il JSON e salvalo come `Google\credentials.json` nella cartella dei
   calendari.
3. Nel calendario in `config.json`: `"type": "google"`, `"spreadsheet": "…"`,
   `"credentials": "Google/credentials.json"`.
4. In Mochi: **⚙ Impostazioni → Collega Google**. Si apre il browser, accedi e
   autorizza. Il token resta in `Google\token.json`, solo sul tuo PC.

### 4.4 Ricevute

In **⚙ Impostazioni → Emittente della ricevuta** crea un profilo per ogni
struttura: chi emette la ricevuta (nome, codice fiscale o partita IVA,
indirizzo), i dati della casa e il calendario collegato (per *Compila dal
calendario*). I profili stanno in `%USERPROFILE%\.mochi-pocket\receipt-profiles.json`;
`examples\receipt-profiles.json` mostra il formato.

I PDF vanno in `Documenti\Ricevute ospiti`, oppure nella cartella scelta per
quel profilo. La numerazione propone il numero successivo leggendo le ricevute
dell'anno già presenti; puoi sempre cambiarlo a mano.

### 4.5 Alloggiati Web (facoltativo)

Mochi **recupera le ricevute PDF** degli invii già fatti (le schedine si inviano
come sempre) e le copia nella cartella di ogni struttura, per esempio una
cartella di Google Drive.

1. Nel portale Alloggiati Web genera la **chiave del web service** (WsKey).
2. Esegui una volta:
   ```powershell
   powershell -ExecutionPolicy Bypass -File engines\alloggiati\configura.ps1
   ```
   Per ogni struttura chiede nome, cartella di destinazione, utente, password e
   WsKey. Le credenziali sono cifrate con DPAPI: le può leggere solo il tuo
   utente Windows su questo PC.
3. Se scegli la pianificazione, il controllo gira anche a Mochi chiuso; il
   recupero vero avviene ogni 15 giorni sugli ultimi 30.

### 4.6 Tassa di soggiorno

Le regole incluse sono quelle di **Milano per CAV e locazioni brevi (2026)**:
9,50 € a persona per notte, massimo 14 notti consecutive, minorenni esenti.
Per un altro comune cambia comune e tariffa in `app/tourist-tax.cjs` (cerca
`nightlyCents`). I conteggi si confermano nella schermata e si esportano in un
riepilogo HTML stampabile.

## 5. Dove stanno i dati

| Cosa | Dove |
| --- | --- |
| Calendari, `config.json`, accesso Google, registri | La cartella dei calendari che hai scelto |
| Conteggi tassa e esclusioni pulizie | `.local\` dentro la cartella dei calendari |
| Profili ricevute | `%USERPROFILE%\.mochi-pocket\receipt-profiles.json` |
| Preferenze e diario di Mochi | `%LOCALAPPDATA%\MochiPocket` |
| Alloggiati: configurazione, credenziali cifrate, archivio | `%LOCALAPPDATA%\MochiPocket\alloggiati` |
| Ricevute PDF | `Documenti\Ricevute ospiti` o la cartella del profilo |

Python viene cercato nel PATH. Per usarne un altro: variabile d'ambiente
`MOCHI_PYTHON`, oppure `pythonPath` in `%LOCALAPPDATA%\MochiPocket\settings.json`.

## 6. Se qualcosa non va

| Messaggio | Cosa fare |
| --- | --- |
| *Configurazione Kross assente o non valida* | Controlla `config.json` (virgole, virgolette) e che la cartella scelta sia quella che lo contiene. |
| *Runtime Node o Python non disponibile* | Installa Python e riapri Mochi, oppure imposta `MOCHI_PYTHON`. |
| *Manca il calendario 2027 configurato* | Aggiungi in `config.json` un calendario con `"sheetName": "2027"` e la scheda nel file. |
| *Google richiede attenzione* | **⚙ Impostazioni → Collega Google** di nuovo. |
| *Configura prima Alloggiati* | Esegui `configura.ps1` (4.5). |

## 7. Prima di condividere modifiche

`npm test` prova il motore sui dati inventati. `npm run privacy` cerca nel
repository codici fiscali, IBAN, email, telefoni, token Google e percorsi
personali. Per bloccare anche i *tuoi* nomi (strutture, vie, cognomi) scrivili,
uno per riga, in un file `.private-words`: è escluso da git, quindi la lista
non finisce online.
