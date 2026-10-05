// api/_ross.js — Ross1000 (flussi turistici ISTAT, es. Regione Emilia-Romagna): la parte comune.
// La usano api/ross.js (invio dal gestionale e file .xml) e il cron di api/promemoria.js, che
// rimanda da solo gli invii rimasti indietro perché il server della Regione non rispondeva.
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.
//
// Config nella variabile d'ambiente ROSS_STRUTTURE (JSON su una riga):
// [{"id":"bologna","codice":"CODICE_STRUTTURA","utente":"...","password":"...",
//   "cameredisponibili":2,"lettidisponibili":4,
//   "endpoint":"https://datiturismo.regione.emilia-romagna.it"}]
// "codice" è l'identificativo struttura assegnato dalla Regione (obbligatorio per il file);
// "utente"/"password" sono le credenziali di trasmissione web service (servono solo per l'invio).
//
// Come si segna l'esito sulla voce dell'Archivio (chiave storico_schedine):
//   riuscito → rossOk:true (e spariscono i campi qui sotto)
//   fallito  → rossDaRifare:true, rossErrore, rossTemporaneo (Regione giù / guasto: si riprova
//              da soli), rossTentativo (quando), rossDati (cosa rimandare, identico al primo
//              invio: stessi idswh, così la Regione non lo conta due volte)
const { redisCmd } = require("./_kv");

const ENDPOINT_DEFAULT = "https://datiturismo.regione.emilia-romagna.it";
const PRODOTTO = "KeyFlow";
const ITALIA = "100000100";
const KEY_STORICO = "storico_schedine";
// oltre questo tempo senza risposta la Regione si considera giù (la funzione può durare 60 s)
const ATTESA_MAX_MS = 25000;

function getRossStrutture() {
  try { return JSON.parse(process.env.ROSS_STRUTTURE || "[]"); } catch { return []; }
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function parseGgMmAaaa(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || "");
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}
function aaaammgg(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function xmlArrivo(o) {
  return `<arrivo>
<idswh>${esc(o.idswh)}</idswh>
<tipoalloggiato>${esc(o.tipoalloggiato)}</tipoalloggiato>
<idcapo>${esc(o.idcapo || "")}</idcapo>
<cognome>${esc(o.cognome)}</cognome>
<nome>${esc(o.nome)}</nome>
<sesso>${esc(o.sesso)}</sesso>
<cittadinanza>${esc(o.cittadinanza)}</cittadinanza>
<statoresidenza>${esc(o.statoresidenza)}</statoresidenza>
<luogoresidenza>${esc(o.luogoresidenza)}</luogoresidenza>
<datanascita>${esc(o.datanascita)}</datanascita>
<statonascita>${esc(o.statonascita)}</statonascita>
<comunenascita>${esc(o.statonascita === ITALIA ? o.comunenascita || "" : "")}</comunenascita>
<tipoturismo>Non specificato</tipoturismo>
<mezzotrasporto>Non Specificato</mezzotrasporto>
<canaleprenotazione>Indiretta web</canaleprenotazione>
<titolostudio></titolostudio>
<professione></professione>
<esenzioneimposta></esenzioneimposta>
</arrivo>`;
}

// Un <movimento> per ogni giorno: il giorno di arrivo contiene gli <arrivi>, quello di
// partenza le <partenze>, i giorni intermedi solo l'occupazione. Accetta PIÙ soggiorni
// (per il file unico "arretrati"): le giornate in comune vengono fuse in un solo movimento.
function buildMovimenti(conf, soggiorni) {
  const perData = new Map(); // 'aaaammgg' -> { occ, arrivi:[], partenze:[] }
  for (const s of soggiorni) {
    for (let i = 0; i <= s.notti; i++) {
      const d = new Date(s.arrivoDate.getTime());
      d.setDate(d.getDate() + i);
      const k = aaaammgg(d);
      let m = perData.get(k);
      if (!m) { m = { occ: 0, arrivi: [], partenze: [] }; perData.set(k, m); }
      if (i === 0) m.arrivi.push(...s.ospiti);
      if (i === s.notti) m.partenze.push(...s.ospiti.map((o) =>
        `<partenza>\n<idswh>${esc(o.idswh)}</idswh>\n<tipoalloggiato>${esc(o.tipoalloggiato)}</tipoalloggiato>\n<arrivo>${aaaammgg(s.arrivoDate)}</arrivo>\n</partenza>`));
      if (i < s.notti) m.occ++;
    }
  }
  const disponibili = Number(conf.cameredisponibili) || 1;
  return [...perData.keys()].sort().map((k) => {
    const m = perData.get(k);
    let x = `<movimento>
<data>${k}</data>
<struttura>
<apertura>SI</apertura>
<camereoccupate>${Math.min(m.occ, disponibili)}</camereoccupate>
<cameredisponibili>${disponibili}</cameredisponibili>
<lettidisponibili>${Number(conf.lettidisponibili) || 2}</lettidisponibili>
</struttura>`;
    if (m.arrivi.length) x += `\n<arrivi>\n${m.arrivi.map(xmlArrivo).join("\n")}\n</arrivi>`;
    if (m.partenze.length) x += `\n<partenze>\n${m.partenze.join("\n")}\n</partenze>`;
    return x + `\n</movimento>`;
  }).join("\n");
}

// controlla i soggiorni ricevuti: { validati } oppure { errore }
function validaSoggiorni(grezzi) {
  const validati = [];
  for (const s of grezzi || []) {
    const arrivo = s && s.arrivo;
    const arrivoDate = parseGgMmAaaa(arrivo);
    const n = Number(s && s.notti);
    if (!arrivoDate || !(n > 0)) return { errore: `Date del soggiorno non valide (arrivo ${arrivo || "?"})` };
    if (!((s && s.ospiti) || []).length) return { errore: `Nessun ospite completo da trasmettere (arrivo ${arrivo || "?"})` };
    validati.push({ arrivoDate, notti: n, ospiti: s.ospiti });
  }
  if (!validati.length) return { errore: "Nessun soggiorno da trasmettere" };
  return { validati };
}

function corpoMovimenti(conf, validati) {
  return `<codice>${esc(conf.codice)}</codice>\n<prodotto>${PRODOTTO}</prodotto>\n${buildMovimenti(conf, validati)}`;
}

// Errori di rete = il server della Regione non risponde (spento, in manutenzione, lentissimo).
// Non dipende né dai dati né da KeyFlow: si riprova più tardi. Prima arrivava solo un
// incomprensibile "fetch failed"; ora si dice cosa è successo, col codice tecnico tra parentesi.
function spiegaErroreRete(e, attesaMs = ATTESA_MAX_MS) {
  const nome = (e && e.name) || "";
  const codice = String((e && e.cause && (e.cause.code || e.cause.name)) || (e && e.code) || "");
  if (nome === "TimeoutError" || nome === "AbortError") {
    return `Il server della Regione (Ross1000) non ha risposto entro ${Math.round(attesaMs / 1000)} secondi: in questo momento è giù o sovraccarico`;
  }
  const motivo = /ENOTFOUND|EAI_AGAIN/.test(codice) ? "non si trova in rete"
    : /CONNECT_TIMEOUT|ETIMEDOUT/.test(codice) ? "non risponde (connessione scaduta)"
    : /ECONNREFUSED/.test(codice) ? "rifiuta i collegamenti"
    : /ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(codice) ? "ha chiuso il collegamento a metà"
    : /CERT|SSL|TLS/i.test(codice) ? "ha un problema col certificato di sicurezza"
    : "non è raggiungibile";
  return `Il server della Regione (Ross1000) ${motivo} in questo momento${codice ? ` (${codice})` : ""}`;
}

// Trasmette i movimenti via web service SOAP (operazione inviaMovimentazione, HTTP Basic,
// endpoint .../ws/checkinV2). Non lancia mai eccezioni:
//   { ok:true, esito }  oppure  { ok:false, status, error, temporaneo }
// temporaneo = la colpa è della Regione (giù, guasto): ha senso riprovare da soli più tardi.
async function trasmettiMovimenti(conf, validati, attesaMs = ATTESA_MAX_MS) {
  if (!conf.utente || !conf.password) {
    return { ok: false, status: 400, temporaneo: false,
      error: "Credenziali web service Ross1000 non configurate: usa \"Scarica .xml\" e importa il file dal portale, oppure aggiungi utente/password in ROSS_STRUTTURE" };
  }
  const soap = `<?xml version="1.0"?>\n<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">\n<S:Body>\n<ns2:inviaMovimentazione xmlns:ns2="http://checkin.ws.service.turismo5.gies.it/">\n<movimentazione>\n${corpoMovimenti(conf, validati)}\n</movimentazione>\n</ns2:inviaMovimentazione>\n</S:Body>\n</S:Envelope>`;
  const endpoint = (conf.endpoint || ENDPOINT_DEFAULT).replace(/\/$/, "") + "/ws/checkinV2";
  const auth = Buffer.from(`${conf.utente}:${conf.password}`).toString("base64");
  let r, testo;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=UTF-8", Authorization: `Basic ${auth}` },
      body: soap,
      signal: AbortSignal.timeout(attesaMs),
    });
    testo = await r.text();
  } catch (e) {
    return { ok: false, status: 503, temporaneo: true, error: spiegaErroreRete(e, attesaMs) };
  }
  const fault = /<\s*\S*:?fault/i.test(testo);
  if (!r.ok || fault) {
    const dettaglio = testo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (r.status === 401 || r.status === 403) {
      return { ok: false, status: 502, temporaneo: false,
        error: `Ross1000 non accetta utente e password del web service (HTTP ${r.status}): vanno ricontrollati in ROSS_STRUTTURE` };
    }
    // pagina d'errore del loro server (502/503/504…) senza un errore SOAP: guasto della Regione
    const temporaneo = !fault && (r.status >= 500 || r.status === 408 || r.status === 429);
    return { ok: false, status: 502, temporaneo,
      error: temporaneo
        ? `Il server della Regione (Ross1000) ha un guasto in questo momento (HTTP ${r.status})`
        : `Ross1000 ha risposto con un errore (HTTP ${r.status}): ${dettaglio || "nessun dettaglio"}` };
  }
  return { ok: true, esito: testo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) };
}

// cambia dei campi di una voce dell'Archivio; null = togli il campo
function applicaCampi(voce, campi) {
  for (const [k, v] of Object.entries(campi || {})) {
    if (v === null) delete voce[k]; else voce[k] = v;
  }
}
async function aggiornaVoceStorico(conn, ts, campi) {
  const raw = await redisCmd(conn, ["GET", KEY_STORICO]);
  const storico = raw ? JSON.parse(raw) : [];
  const voce = storico.find((v) => v && v.ts === ts);
  if (!voce) return false;
  applicaCampi(voce, campi);
  await redisCmd(conn, ["SET", KEY_STORICO, JSON.stringify(storico)]);
  return true;
}
// i campi da scrivere sulla voce dopo un tentativo. "dati" (struttura + soggiorni) si tiene
// solo se è un invio da rifare uguale; se i dati stessi erano sbagliati si lascia al gestionale
// di ricostruirli dalle schedine (dati = null).
function campiEsitoRoss(esito, dati) {
  return esito.ok
    ? { rossOk: true, rossDaRifare: null, rossErrore: null, rossTemporaneo: null, rossTentativo: null, rossDati: null }
    : { rossDaRifare: true, rossErrore: String(esito.error || "errore"), rossTemporaneo: !!esito.temporaneo,
        rossTentativo: Date.now(), rossDati: dati || null };
}

// stessa forma per tutti: { struttura, soggiorni:[{arrivo, notti, ospiti}] }
function datiDaRimandare(struttura, grezzi) {
  return { struttura, soggiorni: (grezzi || []).map((s) => ({ arrivo: s.arrivo, notti: Number(s.notti), ospiti: s.ospiti })) };
}

// Prova a mandare UNA voce dell'Archivio rimasta indietro, con i dati salvati al primo tentativo.
async function rimandaDati(dati, attesaMs) {
  const conf = getRossStrutture().find((s) => s.id === (dati && dati.struttura));
  if (!conf || !conf.codice) return { ok: false, temporaneo: false, error: "Ross1000 non è più configurato per questa struttura" };
  const { validati, errore } = validaSoggiorni(dati.soggiorni);
  if (errore) return { ok: false, temporaneo: false, error: errore };
  return trasmettiMovimenti(conf, validati, attesaMs);
}

// Rinvio automatico dal server (cron): tutte le voci con rossDaRifare e i dati salvati.
// Si ferma al primo "Regione giù" (inutile aspettare per ciascuna) e dopo ~30 secondi in
// tutto: il cron ha anche gli altri promemoria da mandare, e la funzione dura al massimo 60 s.
// Risponde { tentati:[{ voce, esito }], inCoda:[voci ancora da mandare] } per le notifiche.
async function rimandaRossInSospeso(conn, { attesaMs = 15000, budgetMs = 30000 } = {}) {
  const inizio = Date.now();
  const raw = await redisCmd(conn, ["GET", KEY_STORICO]);
  const storico = raw ? JSON.parse(raw) : [];
  const voci = storico.filter((v) => v && v.tipo === "inviata" && v.rossDaRifare && !v.rossOk && v.rossDati);
  const tentati = [];
  for (const voce of voci) {
    if (Date.now() - inizio > budgetMs - attesaMs) break;   // il resto domani (o dal gestionale)
    const esito = await rimandaDati(voce.rossDati, attesaMs);
    tentati.push({ voce, esito });
    try { await aggiornaVoceStorico(conn, voce.ts, campiEsitoRoss(esito, voce.rossDati)); } catch (e) { /* riproverà domani */ }
    if (!esito.ok && esito.temporaneo) break;
  }
  const riusciti = new Set(tentati.filter((t) => t.esito.ok).map((t) => t.voce.ts));
  return { tentati, inCoda: voci.filter((v) => !riusciti.has(v.ts)) };
}

module.exports = {
  ITALIA, getRossStrutture, validaSoggiorni, corpoMovimenti, aaaammgg, trasmettiMovimenti,
  aggiornaVoceStorico, applicaCampi, campiEsitoRoss, datiDaRimandare, rimandaRossInSospeso,
};
