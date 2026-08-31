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

## GEIS · imposta di soggiorno Bologna (agosto 2026)

- La comunicazione è **trimestrale** e i trimestri sono quelli dell'anno solare — **trappola già presa una volta: il 2° trimestre è aprile-maggio-giugno, luglio sta nel 3°**. Scadenze: **15 aprile, 15 luglio, 15 ottobre, 15 gennaio** (entro il 15 del mese dopo la fine del trimestre); va mandata anche a zero ospiti.
- I numeri si generano **da soli dalle schedine registrate in KeyFlow** (`storico_schedine`), non serve più caricare il CSV: helper condiviso `api/_geis.js` (file `_*` = non conta nel limite di 12 funzioni serverless). Regole: soggetti = tutti gli ospiti (FAQ D.4), pernottamenti = notti dell'appartamento, soggiorno a cavallo tutto nel mese di **check-out** (FAQ D.5) — quindi arrivo 28/06 con partenza 02/07 finisce nel 3° trimestre.
- Solo la struttura di Bologna (riconosciuta con `/bologna|falegnami/i`, come `emojiStruttura`). Doppioni evitati: stessa `arrivo|titolare` conta una volta sola, vince l'invio ufficiale sul .txt.
- API: `/api/promemoria` azioni **`geisStato`** (dati dei trimestri) e **`geisSet`** (`{trimestre,fatto}` = segna come mandato, `{soggiorno,escluso}` = togli un soggiorno perché non arrivato da Airbnb). In KV solo la chiave **`geis_stato`** = `{inviati:{"2026-2":{ts}}, esclusi:{chiave:1}}`: i numeri si ricalcolano sempre.
- Frontend: funzioni `geis*` in index.html, pagina `geisOverlay` (pastiglie dei trimestri, nota da copiare, dettaglio per mese e per soggiorno), card "Imposta di soggiorno (GEIS)" nella pagina Oggi e pallino "da mandare" nel menu Impostazioni.
- Promemoria push (cron di `api/promemoria.js`): avvisa 14/7/3/1/0 giorni prima della scadenza, poi ogni giorno per una settimana e infine una volta a settimana finché non si segna "L'ho mandata". Niente avvisi per i trimestri precedenti ai primi dati in KeyFlow.

## Altre funzioni fatte in questa serie di sessioni

- **GEIS** (imposta di soggiorno Bologna): vedi la sezione dedicata qui sotto. Il CSV Airbnb ora è solo un controllo facoltativo (funzioni `is*` in index.html, dentro il `<details>` in fondo alla pagina GEIS).
- **Step "titolare"** nel check-in ospiti: si sceglie chi è l'intestatario, contratto e selfie si verificano su di lui.
- **"Ospiti in attesa"**: due colonne parallele colorate per struttura, anteprime brevi, tap per dettaglio.
- **Home = dashboard** (agosto 2026): data + 4 riquadri `.kpi` (arrivi, partenze, ospiti in casa, da fare) da `renderSintesi()`; **calendario stile Google Calendar** (`renderCalendario`, classi `gcal-*`): griglia mensile con barrette colorate per casa dentro i giorni (piena = arrivo, vuota = partenza; sopra i 560px diventano pastiglie col nome), tocco su un giorno = dettaglio, altrimenti agenda "prossimi giorni"; scheda **Scadenze** unica (righe `.scad-riga` per Ross1000 e GEIS); "Azioni rapide" con l'ultimo invio in fondo. Unica fonte dati: `soggiorniHome()` (storico + check-in in attesa, doppioni tolti per arrivo+titolare).
- **Home "Da fare"**: solo titolare + 👤 conteggio ospiti, pulsante a 3 stati (Registra/Da inviare/Riaggiungi).
- **Si riparte sempre dalla Home**: all'avvio `mostraTab('oggi')` e, se l'app resta in sottofondo più di 30 minuti, al rientro torna alla Home (a meno che ci sia una registrazione a metà).
- **Revisione GDPR** fatta: file privati, cookie/localStorage ok per uso personale.
- **Statistiche** (`renderStatistiche` + funzioni `stat*` in index.html): filtri periodo (ultimi 30/60/90 giorni, 12 mesi, anno, mesi scelti a pastiglie, date libere, tutto), casa e nazionalità; metrica commutabile ospiti/presenze/soggiorni. Stato nelle variabili `statsF`/`statsStrutt`/`statsNaz`/`statsMetrica`. `nomeStrutturaCanonico()` unisce i vecchi nomi delle strutture ai nuovi.
- **App Android (TWA `app.keyflow.gestionale`)**: se compare la barra del browser con la X, è la verifica Digital Asset Links fallita. La config (assetlinks, fingerprint `28:70:28:79:…`, `asset_statements` nell'APK, Chrome forzato) è già stata verificata corretta: la causa era `/.well-known/assetlinks.json` servito con `max-age=0, must-revalidate` → ora `vercel.json` gli mette una `Cache-Control` lunga. Non toccare quella regola.

## Idee discusse ma NON ancora fatte

- Versione "installabile per altri host" (ognuno col proprio account Vercel/KV/Blob → dati e responsabilità restano al cliente; ~1-2 settimane: rendere configurabili strutture/testi + guida installazione). È la strada scelta come primo passo per un'eventuale vendita, invece del SaaS multi-utente (3-5 mesi) o dell'app desktop (perderebbe il self check-in).
