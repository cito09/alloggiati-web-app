# KeyFlow — memoria di progetto

Questo file è la memoria del progetto: Claude Code lo legge automaticamente all'inizio di ogni sessione. Aggiornalo quando cambiano decisioni importanti.

## Cos'è

**KeyFlow** è il gestionale personale di un host (utente non tecnico, si comunica in **italiano semplice**, niente gergo) per 2 strutture ricettive:
- 🟢 **Alba Loft House** — Canazei (TN), id `canazei`, colore `#2dc653`
- 🔴 **Falegnami House** — Bologna, id `bologna`, colore `#ef476f`, soggetta anche a Ross1000/ISTAT e imposta di soggiorno GEIS

Produzione: **https://keyflowcheckin.vercel.app** (Vercel, piano Hobby). Repo: `cito09/alloggiati-web-app`.

## Regole di lavoro consolidate

- **Si lavora e si pusha su `main`** (richiesta esplicita dell'utente); il branch `claude/airbnb-csv-parser-30dd1c` va tenuto allineato a main.
- **Limite critico: max 12 serverless functions** su Vercel Hobby (siamo esattamente a 12). MAI aggiungere file nuovi in `api/` che non inizino con `_` — nuove funzionalità si aggiungono come `azione` dentro endpoint esistenti. I file `api/_*.js` sono helper, non contano.
- Prima di ogni commit: sintassi dello script inline di `index.html` verificata con `new Function(...)`, logica testata con Node (estrazione funzioni via brace-matching), grafica verificata con screenshot Chromium (`playwright-core`, browser in `/opt/pw-browsers/chromium`).
- Commit in italiano, descrittivi.

## Architettura (i punti che non si indovinano)

- **Frontend monolitico**: `public/index.html` (~13k righe, admin) e `public/checkin.html` (self check-in pubblico ospiti). Tutto inline (CSS+JS), niente framework/build.
- **Stile grafico**: estetica "N26" — sfondo quasi nero `#0a0a0c`, accento menta `--amber:#84e3d3` (il nome della variabile è storico, NON è più ambra), card senza bordi radius 24, tabbar a pillola flottante. Colori strutture invariati (verde/rosso, vedi `strutturaInfo()`).
- **Impostazioni** = menu a un clic: ogni voce apre una finestra `pagina-piena` (`apriPagina(id)`/`chiudiPagina(id)`): strutturaOverlay, codiceOverlay, geisOverlay (drag&drop CSV agganciato qui), privacyOverlay, statoOverlay, ricevuteOverlay, recuperoOverlay.
- **Dati**: Upstash Redis via `api/_kv.js`. Chiavi: `checkin_pending`, `checkin_scartati`, `storico_schedine`, `bookings_pending`, `drive_ricevute`.
- **File** (foto documenti, selfie, contratti): Vercel Blob **store privato** (helper `api/_blob.js`: `salvaBlob`/`leggiBlob`/`eliminaBlob`; token `BLOB_PRIVATE_READ_WRITE_TOKEN` ecc.). I file si servono all'admin via proxy autenticato `/api/checkin-pending?img=...`; nel frontend usare SEMPRE `fotoSrc(u)`/`fotoHref(u)`, mai URL blob diretti. La migrazione dei vecchi file pubblici → privati è già stata fatta (68 file).
- **i18n checkin.html**: dizionario principale `T` (8 lingue, righe lunghissime fragili) + dizionario separato `T2` per le stringhe aggiunte dopo.
- **Verifica selfie**: face-api.js self-hosted (`public/vendor/faceapi/`), match se distanza ≤ 0.6, confronto SOLO col documento del titolare della prenotazione (`guests[0]`, scelto nello step "titolare").
- **Notifiche push** (`api/promemoria.js`): promemoria il giorno d'arrivo, ripetuti finché non registrati, con pallino colorato per struttura (`emojiStruttura`).

## Ricevute Questura + Google Drive (luglio 2026)

- `/api/ricevuta`: senza data cerca 7 giorni indietro, poi fallback sul giorno dell'ultimo invio in `storico_schedine`. Azioni `driveGet`/`driveSet` per la config Drive (in KV, chiave `drive_ricevute`: `{url, secret, cartelle:{idStruttura:nomeOcartellaLink}}`).
- Il salvataggio su Drive passa da un **Google Apps Script dell'utente** (web app `/exec`, POST text/plain). Il template del codice sta nel textarea `#driveScriptCode` in index.html: accetta come cartella un link Drive/ID/nome, risponde `{ok,v:2,...}` e ha `doGet` diagnostico. Il server avvisa se rileva la versione vecchia (v1) dello script.
- Se il salvataggio Drive riesce, **niente download locale** (l'utente non vuole la finestra "Salva con nome"); se fallisce, download locale di riserva + errore spiegato.
- ⚠️ La parola segreta attiva nello script dell'utente è `CAMBIAMI` (non è mai riuscito a cambiarla per via del meccanismo "Nuova versione" di Apps Script — trappola ricorrente: modificare il codice NON aggiorna lo script online finché non si pubblica una Nuova versione dal deployment esistente).

## Altre funzioni fatte in questa serie di sessioni

- **GEIS** (imposta di soggiorno Bologna): da CSV Airbnb calcola soggetti/pernottamenti per mese secondo le FAQ del Comune (tutti gli ospiti contano, soggiorni a cavallo → mese di check-out). Upload + drag&drop, niente incolla-testo.
- **Step "titolare"** nel check-in ospiti: si sceglie chi è l'intestatario, contratto e selfie si verificano su di lui.
- **"Ospiti in attesa"**: due colonne parallele colorate per struttura, anteprime brevi, tap per dettaglio.
- **Home "Da fare"**: solo titolare + 👤 conteggio ospiti, pulsante a 3 stati (Registra/Da inviare/Riaggiungi).
- **Revisione GDPR** fatta: file privati, cookie/localStorage ok per uso personale.

## Idee discusse ma NON ancora fatte

- Versione "installabile per altri host" (ognuno col proprio account Vercel/KV/Blob → dati e responsabilità restano al cliente; ~1-2 settimane: rendere configurabili strutture/testi + guida installazione). È la strada scelta come primo passo per un'eventuale vendita, invece del SaaS multi-utente (3-5 mesi) o dell'app desktop (perderebbe il self check-in).
