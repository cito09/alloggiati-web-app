# Schedine → Alloggiati Web

App mobile per registrare gli ospiti delle strutture ricettive: carichi le foto del documento + lo screenshot della prenotazione, l'app estrae i dati, costruisce le schedine nel tracciato ufficiale (168 caratteri) e le **invia direttamente** al web service della Polizia di Stato. Niente più accesso manuale al portale.

Tabelle ufficiali (11.284 comuni, 236 stati, 95 tipi documento) già incorporate: i codici si risolvono da soli.

## Come funziona

1. **Frontend** (`public/index.html`): interfaccia, costruzione delle schedine e validazione 168 char — tutto lato client.
2. **`/api/extract`**: lettura con Claude (modello **Sonnet 5**, più preciso) di screenshot prenotazione e foto documenti. La chiave API resta lato server.
3. **`/api/send`**: `GenerateToken` → `Test` (verifica) o `Send` (invio) verso `Service.asmx`. Credenziali Alloggiati solo lato server.
4. **`/api/ricevuta`**: scarica la ricevuta PDF firmata.
5. **`public/checkin.html`**: pagina pubblica di self check-in (link fisso da mandare agli ospiti, es. via messaggio automatico Airbnb). L'ospite carica il documento o compila a mano; i dati finiscono in una coda di verifica, **mai** inviati automaticamente alla Questura.
6. **`/api/checkin-submit`** e **`/api/checkin-pending`**: ricevono i check-in, caricano le foto su Vercel Blob e gestiscono la coda "Ospiti in attesa" che compare nell'app admin per la conferma.

Le credenziali non passano MAI dal browser: stanno nelle variabili d'ambiente di Vercel.

## Prerequisiti

- Account **Alloggiati Web** attivo (utente + password + codici).
- **WSKey** generata nel portale: profilo in alto a destra → *Chiave Web Service* → *Genera Nuovo Codice*. Nota: a ogni cambio password va rigenerata; se ne può generare una al giorno.
- Una **API key Anthropic**, usata per leggere foto documenti e screenshot prenotazione.

### Lettura documenti

Ogni foto (documento o screenshot prenotazione) passa dall'AI (modello Sonnet 5). In passato l'app provava prima una lettura gratuita via MRZ (Tesseract.js nel browser), poi è passata al modello Haiku 4.5 economico, ma su nomi/date composti o documenti meno nitidi serviva più precisione — quindi ora si usa Sonnet 5.

**Costi AI (modello Sonnet 5):** circa il doppio del precedente Haiku 4.5 a parità di immagine (~$0,01 per foto invece di ~$0,005). Su ~60 ospiti/mese, sotto 1€/mese totale. Vercel resta nel piano gratuito. Volendo, puoi anche compilare a mano: l'app fa comunque codici, validazione 168 e invio.

## Deploy su Vercel

1. Carica questa cartella su un repo GitHub (o `vercel` da CLI).
2. Su Vercel → *Add New Project* → importa il repo. Non serve build: è statico + funzioni serverless.
3. In *Settings → Environment Variables* aggiungi:

   | Variabile | Valore |
   |---|---|
   | `ANTHROPIC_API_KEY` | la tua chiave Anthropic |
   | `ALLOGGIATI_UTENTE` | utente del portale |
   | `ALLOGGIATI_PASSWORD` | password del portale |
   | `ALLOGGIATI_WSKEY` | la WSKey generata |
   | `ALLOGGIATI_NOME` | (facoltativo) nome struttura |

4. Deploy. Apri l'URL dal telefono e *Aggiungi a Home* per usarla come app.

## Più strutture (es. Bologna + Canazei)

Strutture in province diverse hanno Questure e quindi credenziali diverse. Invece delle variabili singole, usa **una** variabile:

```
ALLOGGIATI_STRUTTURE = [
  {"id":"bologna","nome":"Bologna centro","utente":"...","password":"...","wskey":"..."},
  {"id":"canazei","nome":"Canazei","utente":"...","password":"...","wskey":"..."}
]
```

(JSON su una riga). Comparirà un selettore di struttura prima dell'invio. L'endpoint `/api/strutture` espone solo `id` e `nome`, mai le credenziali.

## Storico e self check-in (facoltativi, ma consigliati)

Due funzioni in più, entrambe **opzionali**: se non configuri niente l'app funziona lo stesso (storico solo nel browser, self check-in disattivato senza errori).

### Storico persistente (Upstash Redis)

Senza configurazione, lo Storico (invii/download registrati) resta solo nel browser che hai usato. Per vederlo anche da un altro telefono:

1. Sul progetto Vercel → **Storage** → cerca **Upstash** (non "Redis Cloud", quello è a pagamento) → **Upstash for Redis - Free**.
2. Collega il database al progetto: crea da solo le variabili `KV_REST_API_URL` e `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, entrambe le forme sono supportate). Non serve scrivere nulla a mano.

### Proteggere il gestionale admin (login con codice)

Senza configurazione, chiunque conosca l'indirizzo dell'app admin (`/index.html`, la home del sito) può aprirla e vedere i dati degli ospiti. Per bloccarla dietro un codice d'accesso:

1. Su Vercel → Environment Variables aggiungi:

   | Variabile | Valore |
   |---|---|
   | `ADMIN_CODE` | una stringa lunga e casuale a tua scelta (diversa da `CHECKIN_CODE`), es. `q8vt2nrz61ph` |

2. Dopo il redeploy, aprendo l'app admin comparirà una schermata "Accesso gestionale" che chiede il codice. Va inserito una volta per dispositivo/browser (resta salvato finché non chiudi la scheda). La pagina pubblica di check-in ospiti (`/checkin.html`) **non è toccata**: resta raggiungibile dagli ospiti come prima, con il suo `CHECKIN_CODE`.

> Senza `ADMIN_CODE` configurata, l'app admin resta aperta a chiunque abbia il link, come sempre finora: è una protezione facoltativa che si attiva solo impostando la variabile.

**Cambiare il codice più avanti**: se hai già collegato l'archivio online (Upstash, vedi sotto), una volta dentro il gestionale trovi nella scheda **Oggi** la card "🔒 Codice d'accesso gestionale": lì puoi cambiare il codice inserendo quello attuale e il nuovo, senza dover tornare su Vercel. Se l'archivio online non è collegato, l'unico modo per cambiarlo resta modificare `ADMIN_CODE` su Vercel.

### Self check-in ospiti (link fisso + notifica)

Un link sempre uguale (`/checkin.html`) che puoi incollare in un messaggio automatico Airbnb/Booking: l'ospite carica il documento o compila a mano, e la sua richiesta finisce in una coda "Ospiti in attesa" nell'app admin. **Nessun invio automatico alla Questura**: tu la rivedi e la aggiungi alla prenotazione con un tap, poi Verifica/Invia come sempre.

Richiede queste cose in più:

1. **Vercel Blob** (per le foto): Storage → **Blob** → crea/collega al progetto. Aggiunge da sola la variabile `BLOB_READ_WRITE_TOKEN`.
2. **Codice di accesso (obbligatorio per usare il check-in)**: senza questo, `/checkin.html` rifiuta ogni invio. Scegli una stringa lunga e casuale (es. generata da un password manager) e su Vercel → Environment Variables aggiungi:

   | Variabile | Valore |
   |---|---|
   | `CHECKIN_CODE` | una stringa lunga e casuale a tua scelta, es. `k7f2m9qzx4wp` |

   Il link da dare agli ospiti diventa `https://tuo-dominio.vercel.app/checkin.html?c=IL_TUO_CODICE` — resta sempre lo stesso, ma senza il codice esatto nella URL la pagina mostra "Link non valido" e il server rifiuta comunque l'invio (doppio controllo: pagina *e* server). **Il modo più comodo per trovarlo**: apri l'app admin, nella card "Ospiti in attesa" c'è il link già pronto con il pulsante *Copia*.
3. **Notifica push (facoltativa)**: installa l'app gratuita **ntfy** (Play Store/App Store), scegli un nome di canale privato e a caso (es. `alloggiati-canazei-7f2a`), iscriviti a quel canale nell'app. Poi su Vercel → Environment Variables aggiungi:

   | Variabile | Valore |
   |---|---|
   | `NTFY_TOPIC` | il nome del canale scelto (es. `alloggiati-canazei-7f2a`) |

   Senza questa variabile il check-in funziona lo stesso, semplicemente non arriva la notifica push: dovrai controllare la sezione "Ospiti in attesa" a mano.

> `CHECKIN_CODE` e il canale ntfy sono "segreti leggeri" incorporati nel link/canale: proteggono da chi trova la pagina per caso o la scansiona automaticamente, ma se il link finisce in mani sbagliate va rigenerato (cambi `CHECKIN_CODE` e ridai il nuovo link ai prossimi ospiti).

### Contratto di locazione turistica con firma (facoltativo)

Nell'ultimo passo del check-in, se la struttura è configurata, l'ospite vede il testo del contratto (bilingue IT/EN) già compilato con i suoi dati e firma con il dito/mouse. Il PDF firmato viene generato al volo e **mandato via email**, mai salvato sul sito (nessun accumulo su Vercel) — esattamente come succedeva con Jotform.

1. **Dati del contratto per struttura**: su Vercel → Environment Variables aggiungi `CONTRATTI_STRUTTURE` (JSON su una riga, un oggetto per struttura, stesso `id` usato altrove):

   ```json
   [{"id":"canazei","locatoreNome":"Nicola Chirco","codiceFiscale":"CHRNCL73L01A944D",
     "email":"canazeibnb25@gmail.com","indirizzoVia":"STREDA DE COSTA n.71, interno n° 25",
     "comune":"Canazei","vani":2,"postiLetto":4,"wc":1,
     "accessori":"cantina, autorimessa singola, posto macchina in comune, parcheggio coperto",
     "foglio":"817","particella":"66","subalterno":"43","piattaforma":"Airbnb"}]
   ```

   Una struttura senza voce qui semplicemente non ha il passo del contratto nel suo check-in (utile finché non hai ancora i dati di tutte le strutture).

2. **Invio email (Resend)**: registrati gratis su [resend.com](https://resend.com) (fino a 3.000 email/mese gratis), crea una API key, e su Vercel aggiungi:

   | Variabile | Valore |
   |---|---|
   | `RESEND_API_KEY` | la chiave presa da Resend |

   Il contratto firmato arriva via email all'indirizzo indicato in `email` per quella struttura in `CONTRATTI_STRUTTURE`. Senza `RESEND_API_KEY` il check-in funziona lo stesso (l'ospite firma comunque), semplicemente l'email non parte: nella coda "Ospiti in attesa" dell'app admin trovi comunque un'etichetta "📝 contratto non inviato" per accorgertene.

### Ross1000 — flussi turistici ISTAT (es. Emilia-Romagna, facoltativo)

Per le strutture in regioni che usano **Ross1000** (es. Bologna/Emilia-Romagna) esiste anche l'obbligo statistico ISTAT, separato da Alloggiati Web, con scadenza il giorno 5 del mese successivo. L'app lo copre in due modi:

- **Scarica Ross1000 (.xml)**: genera il file nel tracciato ufficiale, da caricare sul portale (menu check-in → *importa file gestionale*). Basta configurare il `codice` struttura.
- **Invio automatico via web service**: con le credenziali di trasmissione rilasciate dalla Regione, il pulsante *Invia ufficialmente* trasmette prima le schedine alla Questura e poi i dati a Ross1000, in un colpo solo. (Endpoint Emilia-Romagna già preimpostato; per altre regioni si può indicare `endpoint`.)

Configurazione, variabile `ROSS_STRUTTURE` (JSON su una riga):

```
ROSS_STRUTTURE = [{"id":"bologna","codice":"CODICE_ASSEGNATO_DALLA_REGIONE","utente":"...","password":"...","cameredisponibili":2,"lettidisponibili":4}]
```

- `id` deve coincidere con l'`id` usato in `ALLOGGIATI_STRUTTURE`.
- `codice` = identificativo struttura assegnato dalla Regione al momento della registrazione su Ross1000.
- `utente`/`password` = credenziali di **trasmissione web service** (da chiedere alla Regione: per l'Emilia-Romagna StatisticaTurismo@regione.emilia-romagna.it). Senza di esse resta comunque disponibile il download del file .xml.
- `cameredisponibili`/`lettidisponibili` = capacità della struttura (camere e posti letto), richieste dal tracciato per ogni giornata.

Note: la residenza degli ospiti (campo obbligatorio del tracciato, non presente sui documenti) viene approssimata con il luogo di nascita; tipo turismo e mezzo di trasporto sono trasmessi come "Non specificato" (valori ammessi dal tracciato).

### Promemoria automatici (facoltativi)

Un cron giornaliero di Vercel (`vercel.json` → `/api/promemoria`, ore 8 UTC) manda una notifica ntfy se ci sono check-in ospiti fermi da più di 24 ore, e il giorno 3 del mese ricorda la scadenza Ross1000 (se configurato). Richiede solo `NTFY_TOPIC`. Consigliato: aggiungi anche una variabile `CRON_SECRET` (stringa casuale) — Vercel la usa da solo per firmare le chiamate del cron, ed evita che estranei possano far scattare notifiche chiamando l'endpoint.

### App sul telefono (PWA)

Il gestionale è installabile dalla home: aprilo dal telefono → menu del browser → "Aggiungi a schermata Home". Icona KeyFlow e schermo intero, senza barra del browser (manifest + icone incluse nel progetto).

### ⚠️ Identificazione "de visu": leggi prima di affidarti solo a questo modulo

Una sentenza del Consiglio di Stato (n. 5732/2025, 21 novembre 2025) ha stabilito che l'identificazione degli ospiti deve avvenire **de visu**, anche a distanza ma **solo se in tempo reale** (videochiamata, videocitofono): **non basta** l'invio di una foto del documento rivista in un secondo momento, che è esattamente il funzionamento base di questo modulo. Questo self check-in resta utile come **aiuto alla raccolta dati** (l'ospite scrive/carica, tu non ritrascrivi), ma se il check-in è interamente da remoto senza nessun contatto dal vivo (nemmeno una breve videochiamata), da solo probabilmente **non basta** a soddisfare l'obbligo di legge. Non è una consulenza legale: verifica con un professionista specializzato in affitti brevi prima di affidarti solo a questo flusso per l'identificazione.

## Uso

1. **Aggiungi prenotazione** → screenshot → *Estrai date* (compila arrivo + notti). Scegli singolo / famiglia / gruppo.
2. **Aggiungi ospite** → foto documento → *Estrai dati*. Controlla i campi: accanto a ognuno compare il codice ufficiale risolto (verde = ok, `?` rosso = da correggere).
3. **Verifica**: chiama il metodo *Test* del portale (controlla senza inviare).
4. **Invia ufficialmente**: trasmette davvero (chiede conferma, è irreversibile).
5. **Scarica ricevuta PDF** e conservala (obbligo di legge: 5 anni).

Resta disponibile anche **Scarica .txt** per il caricamento manuale dal portale, come fallback.

### Self check-in ospiti

Con più strutture configurate (`ALLOGGIATI_STRUTTURE`), la card **"📥 Ospiti in attesa"** mostra **un link diverso per struttura**, con il pulsante *Copia* pronto per ognuno — usa il campo `nome` di ogni struttura anche come nome mostrato all'ospite in cima alla pagina di check-in. Vuoi che l'ospite veda "Falegnami House" invece di "Bologna centro"? Basta rinominare quel campo `nome` nella variabile `ALLOGGIATI_STRUTTURE`, non serve altro.

1. Copia il link della struttura giusta e incollalo nel messaggio automatico che mandi agli ospiti (es. programmato su Airbnb per qualche ora/giorno prima del check-in). È sempre lo stesso link per quella struttura, non va rigenerato per ogni prenotazione (a meno che tu non cambi `CHECKIN_CODE`).
2. L'ospite vede il nome della struttura in cima alla pagina, carica il documento (o compila a mano) e conferma: arriva una notifica (se hai configurato ntfy) e la richiesta compare in **"📥 Ospiti in attesa"**, già etichettata con la struttura giusta.
3. Controlli foto e dati, poi **"✓ Aggiungi alla prenotazione"** (porta i dati nella prenotazione corrente e pre-seleziona la struttura giusta per l'invio) oppure **"Scarta"** se non validi.

## Note tecniche

- Tracciato: 168 caratteri/riga, UTF-8, CR+LF tra le righe tranne l'ultima (conforme al manuale Polizia, par. 12).
- Web service: endpoint `https://alloggiatiweb.poliziadistato.it/service/Service.asmx`, namespace `AlloggiatiService`, SOAP 1.1.
- Le foto vengono ridimensionate (max 1600px) prima dell'upload per stare nei limiti di payload di Vercel.
- Per il multi-appartamento sullo stesso account esiste anche il *File Unico* (174 char con IDAppartamento) tramite i metodi `GestioneAppartamenti_FileUnico_*`: non ancora cablato, si aggiunge se serve.

## Struttura del progetto

```
.
├── public/index.html        app admin (tabelle ufficiali incluse)
├── public/checkin.html      pagina pubblica di self check-in (link fisso per gli ospiti)
├── public/shared.js         funzioni condivise tra le due pagine (estrazione AI, date)
├── api/_alloggiati.js       helper SOAP (token, Test/Send, Ricevuta, strutture)
├── api/_kv.js               helper condiviso per l'archivio Upstash Redis
├── api/extract.js           estrazione foto (Claude vision)
├── api/send.js               Test / Send
├── api/ricevuta.js           ricevuta PDF
├── api/strutture.js          elenco strutture (no segreti)
├── api/storico.js            log persistente invii/download (Upstash, facoltativo)
├── api/checkin-submit.js     riceve un check-in ospite, foto su Blob, notifica ntfy
├── api/checkin-pending.js    coda ospiti in attesa (lettura/rimozione lato admin)
├── vercel.json
└── package.json
```
