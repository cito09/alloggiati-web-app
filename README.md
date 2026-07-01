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

### Self check-in ospiti (link fisso + notifica)

Un link sempre uguale (`/checkin.html`) che puoi incollare in un messaggio automatico Airbnb/Booking: l'ospite carica il documento o compila a mano, e la sua richiesta finisce in una coda "Ospiti in attesa" nell'app admin. **Nessun invio automatico alla Questura**: tu la rivedi e la aggiungi alla prenotazione con un tap, poi Verifica/Invia come sempre.

Richiede due cose in più:

1. **Vercel Blob** (per le foto): Storage → **Blob** → crea/collega al progetto. Aggiunge da sola la variabile `BLOB_READ_WRITE_TOKEN`.
2. **Notifica push (facoltativa)**: installa l'app gratuita **ntfy** (Play Store/App Store), scegli un nome di canale privato e a caso (es. `alloggiati-canazei-7f2a`), iscriviti a quel canale nell'app. Poi su Vercel → Environment Variables aggiungi:

   | Variabile | Valore |
   |---|---|
   | `NTFY_TOPIC` | il nome del canale scelto (es. `alloggiati-canazei-7f2a`) |

   Senza questa variabile il check-in funziona lo stesso, semplicemente non arriva la notifica push: dovrai controllare la sezione "Ospiti in attesa" a mano.

> Il canale ntfy scelto è come una password leggera: usa un nome non ovvio, chiunque lo indovini può mandarti notifiche (non può però vedere i tuoi dati).

## Uso

1. **Aggiungi prenotazione** → screenshot → *Estrai date* (compila arrivo + notti). Scegli singolo / famiglia / gruppo.
2. **Aggiungi ospite** → foto documento → *Estrai dati*. Controlla i campi: accanto a ognuno compare il codice ufficiale risolto (verde = ok, `?` rosso = da correggere).
3. **Verifica**: chiama il metodo *Test* del portale (controlla senza inviare).
4. **Invia ufficialmente**: trasmette davvero (chiede conferma, è irreversibile).
5. **Scarica ricevuta PDF** e conservala (obbligo di legge: 5 anni).

Resta disponibile anche **Scarica .txt** per il caricamento manuale dal portale, come fallback.

### Self check-in ospiti

1. Copia il link `https://tuo-dominio.vercel.app/checkin.html` e incollalo nel messaggio automatico che mandi agli ospiti (es. programmato su Airbnb per qualche ora/giorno prima del check-in). È sempre lo stesso link, non va rigenerato per ogni prenotazione.
2. L'ospite carica il documento (o compila a mano) e conferma: arriva una notifica (se hai configurato ntfy) e la richiesta compare in **"📥 Ospiti in attesa"** in cima all'app.
3. Controlli foto e dati, poi **"✓ Aggiungi alla prenotazione"** (li porta nella prenotazione corrente, pronti per Verifica/Invio) oppure **"Scarta"** se non validi.

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
