# Schedine → Alloggiati Web

App mobile per registrare gli ospiti delle strutture ricettive: carichi le foto del documento + lo screenshot della prenotazione, l'app estrae i dati, costruisce le schedine nel tracciato ufficiale (168 caratteri) e le **invia direttamente** al web service della Polizia di Stato. Niente più accesso manuale al portale.

Tabelle ufficiali (11.284 comuni, 236 stati, 95 tipi documento) già incorporate: i codici si risolvono da soli.

## Come funziona

1. **Frontend** (`public/index.html`): interfaccia, costruzione delle schedine e validazione 168 char — tutto lato client.
2. **`/api/extract`**: fallback di lettura con Claude (modello **Haiku 4.5**, economico) quando il documento non ha MRZ. La chiave API resta lato server.
3. **`/api/send`**: `GenerateToken` → `Test` (verifica) o `Send` (invio) verso `Service.asmx`. Credenziali Alloggiati solo lato server.
4. **`/api/ricevuta`**: scarica la ricevuta PDF firmata.

Le credenziali non passano MAI dal browser: stanno nelle variabili d'ambiente di Vercel.

## Prerequisiti

- Account **Alloggiati Web** attivo (utente + password + codici).
- **WSKey** generata nel portale: profilo in alto a destra → *Chiave Web Service* → *Genera Nuovo Codice*. Nota: a ogni cambio password va rigenerata; se ne può generare una al giorno.
- Una **API key Anthropic**, usata solo come fallback quando un documento non ha l'MRZ.

### Lettura gratuita (MRZ) vs AI

Passaporti e carte d'identità elettroniche hanno in fondo la zona a lettura ottica (le righe con i `<<<`). L'app la legge **nel browser con Tesseract.js, a costo zero** (nessuna chiamata API). Copre la gran parte degli ospiti stranieri. Solo per i documenti senza MRZ (alcune carte cartacee, patenti) si usa l'AI come fallback.

**Costi AI (solo fallback, modello Haiku 4.5):** ~$0,005 per ospite. Su ~60 ospiti/mese, sotto $0,40/mese. Vercel resta nel piano gratuito. Volendo, puoi anche compilare a mano: l'app fa comunque codici, validazione 168 e invio. Per nazionalità non mappate dall'MRZ il campo resta da scegliere dal menù (è incluso un set di 100 paesi).

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

## Uso

1. **Aggiungi prenotazione** → screenshot → *Estrai date* (compila arrivo + notti). Scegli singolo / famiglia / gruppo.
2. **Aggiungi ospite** → foto documento → *Estrai dati*. Controlla i campi: accanto a ognuno compare il codice ufficiale risolto (verde = ok, `?` rosso = da correggere).
3. **Verifica**: chiama il metodo *Test* del portale (controlla senza inviare).
4. **Invia ufficialmente**: trasmette davvero (chiede conferma, è irreversibile).
5. **Scarica ricevuta PDF** e conservala (obbligo di legge: 5 anni).

Resta disponibile anche **Scarica .txt** per il caricamento manuale dal portale, come fallback.

## Note tecniche

- Tracciato: 168 caratteri/riga, UTF-8, CR+LF tra le righe tranne l'ultima (conforme al manuale Polizia, par. 12).
- Web service: endpoint `https://alloggiatiweb.poliziadistato.it/service/Service.asmx`, namespace `AlloggiatiService`, SOAP 1.1.
- Le foto vengono ridimensionate (max 1600px) prima dell'upload per stare nei limiti di payload di Vercel.
- Per il multi-appartamento sullo stesso account esiste anche il *File Unico* (174 char con IDAppartamento) tramite i metodi `GestioneAppartamenti_FileUnico_*`: non ancora cablato, si aggiunge se serve.

## Struttura del progetto

```
.
├── public/index.html      frontend (tabelle ufficiali incluse)
├── api/_alloggiati.js      helper SOAP (token, Test/Send, Ricevuta, strutture)
├── api/extract.js          estrazione foto (Claude vision)
├── api/send.js             Test / Send
├── api/ricevuta.js         ricevuta PDF
├── api/strutture.js        elenco strutture (no segreti)
├── vercel.json
└── package.json
```
