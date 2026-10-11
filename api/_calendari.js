// api/_calendari.js — prenotazioni in anticipo dai calendari di Airbnb (e Booking, Vrbo…).
// Ogni portale dà un link "esporta calendario" (.ics, formato iCal): lo si incolla in
// KeyFlow (Impostazioni → Calendari Airbnb) e il server lo legge da solo, così il
// calendario della Home si riempie con le prenotazioni PRIMA che gli ospiti facciano il
// check-in. Airbnb nel file non mette nome né numero di ospiti: solo le date, il codice
// della prenotazione e le ultime 4 cifre del telefono. Il nome arriva col check-in.
// File che inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.
//
// In KV (chiave calendari_esterni):
//   { link: { idStruttura: ["https://…ics", …] },
//     prenotazioni: [{ uid, strutturaId, sorgente, fonte, arrivo, partenza, notti, codice, telefono4, url }],
//     esiti: { sorgente: { ok, quante, errore, ts } }, aggiornato: ts,
//     email: { attivo, stato:{casella,uidValidity,ultimoUid}, conferme:{HM…:{nome,ospiti,arrivo,partenza,ts}}, esito } }
// Con "email" attivo i nomi e il numero di ospiti arrivano dalle email di Airbnb (_airbnbEmail.js).
//     prohost: { chiave, case:{listingId: idStruttura|"-"}, annunci:[…], esito } — con la chiave di
//              ProhostAI (_prohost.js) arrivano tutte le prenotazioni con nome e ospiti (sorgente "prohost")
const crypto = require("crypto");
const { redisCmd } = require("./_kv");
const { leggiConfermeAirbnb, provaCasella, spiegaErroreGmail } = require("./_airbnbEmail");
const { leggiProhost, chiaveMascherata } = require("./_prohost");

const KEY = "calendari_esterni";
const ATTESA_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;
// rilettura automatica quando si apre l'app (oltre a quella di ogni mattina)
const VECCHIO_MS = 30 * 60 * 1000;

const sorgenteDi = (url) => crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 10);
function fonteDi(url) {
  const h = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (/airbnb\./i.test(h)) return "Airbnb";
  if (/booking\.com/i.test(h)) return "Booking";
  if (/vrbo|homeaway|abritel|fewo/i.test(h)) return "Vrbo";
  return "Calendario";
}

// link incollati dall'utente: solo indirizzi https, uno per riga (o separati da spazi)
function pulisciLink(testo) {
  const out = [];
  String(testo || "").split(/[\s,]+/).forEach((x) => {
    const t = x.trim().replace(/^webcal:\/\//i, "https://");
    if (!t) return;
    try {
      const u = new URL(t);
      if (u.protocol === "https:" && t.length < 2000 && !out.includes(t)) out.push(t);
    } catch { /* non è un indirizzo: lo ignoro */ }
  });
  return out;
}

// --- lettura del formato iCal (RFC 5545), quanto basta per i calendari dei portali ---
function leggiIcal(testo) {
  // le righe lunghe sono spezzate e continuano con uno spazio (o tab) all'inizio
  const righe = String(testo || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const eventi = [];
  let ev = null;
  for (const r of righe) {
    if (/^BEGIN:VEVENT/i.test(r)) { ev = {}; continue; }
    if (/^END:VEVENT/i.test(r)) { if (ev) eventi.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = r.indexOf(":"); if (i < 0) continue;
    const nome = r.slice(0, i).split(";")[0].toUpperCase();
    const valore = r.slice(i + 1).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    if (nome === "DTSTART") ev.inizio = valore.replace(/\D/g, "").slice(0, 8);
    else if (nome === "DTEND") ev.fine = valore.replace(/\D/g, "").slice(0, 8);
    else if (nome === "UID") ev.uid = valore.trim();
    else if (nome === "SUMMARY") ev.titolo = valore.trim();
    else if (nome === "DESCRIPTION") ev.descrizione = valore;
  }
  return eventi;
}
const ggmmaaaa = (s) => `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
const giornoUtc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

// dagli eventi del calendario alle prenotazioni vere: via i blocchi ("Airbnb (Not
// available)", date chiuse a mano), via le date sbagliate e quelle ormai lontane
function prenotazioniDaEventi(eventi, { strutturaId, url, oggi = Date.now() }) {
  const fonte = fonteDi(url), sorgente = sorgenteDi(url);
  const limitePassato = oggi - 45 * 86400000;
  const out = [];
  for (const ev of eventi) {
    if (!/^\d{8}$/.test(ev.inizio || "") || !/^\d{8}$/.test(ev.fine || "")) continue;
    const descr = ev.descrizione || "";
    const linkPren = (/https?:\/\/\S*\/reservations\/details\/[A-Z0-9]+/i.exec(descr) || [])[0] || "";
    const titolo = ev.titolo || "";
    // Airbnb: "Reserved" = prenotazione, "Airbnb (Not available)" = data bloccata.
    // Booking chiama "CLOSED - Not available" anche le prenotazioni: lì si tiene tutto.
    if (!linkPren && fonte !== "Booking" && /not available|non disponibile|blocked|bloccat/i.test(titolo)) continue;
    const notti = Math.round((giornoUtc(ev.fine) - giornoUtc(ev.inizio)) / 86400000);
    if (!(notti > 0 && notti <= 90)) continue;
    if (giornoUtc(ev.fine) < limitePassato) continue;
    out.push({
      uid: String(ev.uid || `${sorgente}-${ev.inizio}`).slice(0, 200),
      strutturaId, sorgente, fonte,
      arrivo: ggmmaaaa(ev.inizio), partenza: ggmmaaaa(ev.fine), notti,
      codice: (/details\/([A-Z0-9]+)/i.exec(linkPren) || [])[1] || "",
      telefono4: (/Last 4 Digits\)?:?\s*(\d{4})/i.exec(descr) || [])[1] || "",
      url: linkPren,
    });
  }
  return out;
}

async function scaricaCalendario(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (KeyFlow; calendario host)", Accept: "text/calendar, text/plain, */*" },
    redirect: "follow",
    signal: AbortSignal.timeout(ATTESA_MS),
  });
  if (!r.ok) {
    throw new Error(r.status === 404 || r.status === 410
      ? "il link non esiste più (rigeneralo dal portale e incollalo di nuovo)"
      : `il portale ha risposto con un errore (HTTP ${r.status})`);
  }
  const testo = await r.text();
  if (testo.length > MAX_BYTES) throw new Error("file del calendario troppo grande");
  if (!/BEGIN:VCALENDAR/i.test(testo)) throw new Error("questo link non è un calendario (.ics): copia quello di \"Esporta calendario\"");
  return testo;
}
function spiegaErrore(e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return "il portale non ha risposto in tempo";
  if (e && e.message === "fetch failed") return "il portale non è raggiungibile in questo momento";
  return String((e && e.message) || e);
}

async function leggiCalendari(conn) {
  try {
    const raw = await redisCmd(conn, ["GET", KEY]);
    const s = raw ? JSON.parse(raw) : {};
    return { link: s.link || {}, prenotazioni: s.prenotazioni || [], esiti: s.esiti || {}, aggiornato: s.aggiornato || 0, email: s.email || {}, prohost: s.prohost || {} };
  } catch { return { link: {}, prenotazioni: [], esiti: {}, aggiornato: 0, email: {}, prohost: {} }; }
}
async function salvaCalendari(conn, stato) {
  await redisCmd(conn, ["SET", KEY, JSON.stringify(stato)]);
}

const gmailConfigurato = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
// accesa da sola: si spegne solo se l'host lo chiede (attivo:false)
const emailAccesa = (em) => !em || em.attivo !== false;
// Le caselle da cui leggere: quella di KeyFlow (GMAIL_USER, la stessa che manda le email) più
// quelle aggiunte dall'host nella pagina Calendari (es. la casella di Bologna), salvate in KV
// con la loro password per le app. Le password non tornano mai al telefono.
function caselleEmail(em) {
  const lista = [];
  if (gmailConfigurato()) lista.push({ utente: process.env.GMAIL_USER, password: process.env.GMAIL_APP_PASSWORD, principale: true });
  for (const x of (em && em.extra) || []) {
    if (x && x.utente && x.password && !lista.some((c) => c.utente.toLowerCase() === x.utente.toLowerCase())) lista.push({ utente: x.utente, password: x.password, principale: false });
  }
  return lista;
}
// le conferme di Airbnb lette da tutte le caselle, aggiunte a quelle già lette le volte prima
// (è l'archivio di KeyFlow: se poi l'email si cancella, nome e ospiti restano)
async function aggiornaEmail(email) {
  const e = { ...(email || {}) };
  if (!emailAccesa(e)) return e;
  const caselle = caselleEmail(e);
  if (!caselle.length) { e.esito = { ok: false, errore: "nessuna casella Gmail collegata", ts: Date.now() }; return e; }
  const stati = { ...(e.caselle || {}) };
  // stato salvato dalla versione con una casella sola: era quello di GMAIL_USER
  if (e.stato && process.env.GMAIL_USER && !stati[process.env.GMAIL_USER]) stati[process.env.GMAIL_USER] = { stato: e.stato };
  delete e.stato;
  const conferme = { ...(e.conferme || {}) };
  const risultati = await Promise.all(caselle.map(async (c) => {
    try {
      const r = await leggiConfermeAirbnb({ utente: c.utente, password: c.password, stato: (stati[c.utente] || {}).stato || {} });
      return { c, ok: true, r };
    } catch (err) { return { c, ok: false, errore: spiegaErroreGmail(err) }; }
  }));
  for (const x of risultati) {
    const prima = stati[x.c.utente] || {};
    if (x.ok) {
      x.r.nuove.forEach((c) => { conferme[c.codice] = { nome: c.nome, ospiti: c.ospiti, arrivo: c.arrivo, partenza: c.partenza, ts: c.ts, casella: x.c.utente }; });
      stati[x.c.utente] = { stato: x.r.stato, esito: { ok: true, ts: Date.now(), nuove: x.r.nuove.length } };
    } else {
      stati[x.c.utente] = { stato: prima.stato, esito: { ok: false, ts: Date.now(), errore: x.errore } };
    }
  }
  // via le caselle tolte
  for (const k of Object.keys(stati)) if (!caselle.some((c) => c.utente === k)) delete stati[k];
  // non tengo per sempre le conferme dei soggiorni finiti da mesi
  const limite = Date.now() - 120 * 86400000;
  for (const [k, v] of Object.entries(conferme)) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.partenza || "");
    if ((m && Date.UTC(+m[3], +m[2] - 1, +m[1]) < limite) || (!m && v.ts < limite - 300 * 86400000)) delete conferme[k];
  }
  e.caselle = stati;
  e.conferme = conferme;
  const ko = risultati.filter((x) => !x.ok);
  e.esito = ko.length === risultati.length
    ? { ok: false, ts: Date.now(), errore: ko[0].errore }
    : { ok: true, ts: Date.now(), totali: Object.keys(conferme).length };
  return e;
}

// ProhostAI: annunci e prenotazioni con nome. Se non risponde, pren = null (restano quelle di prima)
function struttureConfigurate() {
  try { return require("./_alloggiati").getStrutture().map((x) => ({ id: x.id, nome: x.nome })); } catch { return []; }
}
async function aggiornaProhost(prohost) {
  const ph = { ...(prohost || {}) };
  if (!ph.chiave) return { prohost: ph, pren: [] };
  try {
    const r = await leggiProhost(ph, struttureConfigurate());
    ph.annunci = r.annunci;
    ph.esito = { ok: true, ts: Date.now(), quante: r.prenotazioni.length, tutte: r.tutte };
    return { prohost: ph, pren: r.prenotazioni };
  } catch (e) {
    // rifiutata = chiave sbagliata, senza permessi o piano insufficiente: riprovare non serve
    ph.esito = { ok: false, ts: Date.now(), errore: String((e && e.message) || e), rifiutata: [401, 402, 403].includes(e && e.status) };
    return { prohost: ph, pren: null };
  }
}
const haFonti = (stato) => Object.values(stato.link || {}).some((l) => (l || []).length) || !!(stato.prohost && stato.prohost.chiave);

// Rilegge tutti i link. Se un link non risponde, le prenotazioni lette l'ultima volta da
// quel link restano (un portale giù per un'ora non deve svuotare il calendario).
async function sincronizzaCalendari(conn, stato) {
  stato = stato || (await leggiCalendari(conn));
  const emailInArrivo = aggiornaEmail(stato.email);   // in parallelo ai calendari
  const prohostInArrivo = aggiornaProhost(stato.prohost);
  const lavori = [];
  for (const [strutturaId, links] of Object.entries(stato.link || {})) {
    for (const url of links || []) lavori.push({ strutturaId, url, sorgente: sorgenteDi(url) });
  }
  const risultati = await Promise.all(lavori.map(async (l) => {
    try {
      const pren = prenotazioniDaEventi(leggiIcal(await scaricaCalendario(l.url)), l);
      return { ...l, ok: true, pren };
    } catch (e) { return { ...l, ok: false, errore: spiegaErrore(e) }; }
  }));
  const sorgentiAttive = new Set(lavori.map((l) => l.sorgente));
  const fallite = new Set(risultati.filter((r) => !r.ok).map((r) => r.sorgente));
  const prenotazioni = (stato.prenotazioni || []).filter((p) => sorgentiAttive.has(p.sorgente) && fallite.has(p.sorgente));
  const esiti = {};
  for (const r of risultati) {
    if (r.ok) prenotazioni.push(...r.pren);
    esiti[r.sorgente] = r.ok
      ? { ok: true, quante: r.pren.length, ts: Date.now(), strutturaId: r.strutturaId, fonte: fonteDi(r.url) }
      : { ok: false, errore: r.errore, ts: Date.now(), strutturaId: r.strutturaId, fonte: fonteDi(r.url),
          quante: (stato.prenotazioni || []).filter((p) => p.sorgente === r.sorgente).length };
  }
  const ph = await prohostInArrivo;
  // ProhostAI non ha risposto: restano le sue prenotazioni lette l'ultima volta
  prenotazioni.push(...(ph.pren || (stato.prenotazioni || []).filter((p) => p.sorgente === "prohost")));
  const nuovo = { link: stato.link || {}, prenotazioni, esiti, aggiornato: Date.now(), email: await emailInArrivo, prohost: ph.prohost };
  await salvaCalendari(conn, nuovo);
  return nuovo;
}

// risposta per il gestionale: i link con l'esito di ciascuno (senza ripetere gli indirizzi
// nell'elenco delle prenotazioni) e le prenotazioni
// Ogni prenotazione del calendario prende nome e ospiti dalla sua email di conferma: prima
// per codice (HM…, è lo stesso nei due posti), poi, se manca, per date d'arrivo e partenza
// uguali (solo se c'è una sola prenotazione con quelle date, sennò meglio non indovinare).
function conNomi(prenotazioni, conferme) {
  const lista = Object.entries(conferme || {}).map(([codice, c]) => ({ codice, ...c }));
  return (prenotazioni || []).map((p) => {
    if (p.nome) return p;   // ha già il nome (da ProhostAI)
    let c = p.codice && conferme && conferme[String(p.codice).toUpperCase()];
    if (!c) {
      const stesse = lista.filter((x) => x.arrivo && x.arrivo === p.arrivo && x.partenza === p.partenza);
      const altre = (prenotazioni || []).filter((q) => q.arrivo === p.arrivo && q.partenza === p.partenza);
      if (stesse.length === 1 && altre.length === 1) c = stesse[0];
    }
    return c ? { ...p, nome: c.nome || "", ospiti: c.ospiti || null } : p;
  });
}
function vistaCalendari(stato) {
  const link = {};
  for (const [id, links] of Object.entries(stato.link || {})) {
    link[id] = (links || []).map((url) => ({ url, fonte: fonteDi(url), esito: (stato.esiti || {})[sorgenteDi(url)] || null }));
  }
  const em = stato.email || {};
  const prenotazioni = emailAccesa(em) ? conNomi(stato.prenotazioni, em.conferme) : (stato.prenotazioni || []);
  return { ok: true, link, prenotazioni, aggiornato: stato.aggiornato || 0,
    email: { attivo: emailAccesa(em), configurato: caselleEmail(em).length > 0, casella: process.env.GMAIL_USER || "",
      esito: em.esito || null, conferme: Object.keys(em.conferme || {}).length,
      conNome: prenotazioni.filter((p) => p.nome).length,
      // una riga per casella: indirizzo, com'è andata e quante conferme ha dato (mai la password)
      caselle: caselleEmail(em).map((c) => ({ utente: c.utente, principale: c.principale,
        esito: ((em.caselle || {})[c.utente] || {}).esito || null,
        conferme: Object.values(em.conferme || {}).filter((x) => x.casella === c.utente).length })),
      errore: null },
    // la chiave di ProhostAI non torna mai al telefono: solo l'inizio e la fine, per riconoscerla
    prohost: { collegato: !!(stato.prohost && stato.prohost.chiave), chiave: chiaveMascherata(stato.prohost && stato.prohost.chiave),
      annunci: (stato.prohost && stato.prohost.annunci) || [], esito: (stato.prohost && stato.prohost.esito) || null } };
}

// azione 'calendari' di /api/promemoria: { link?:{idStruttura:"testo con i link"}, aggiorna?:true }
async function azioneCalendari(conn, corpo) {
  let stato = await leggiCalendari(conn);
  let cambiati = false;
  // nomi dalle email di Airbnb: acceso o spento dal gestionale (riaccendendolo si rilegge tutto)
  if (corpo && typeof corpo.email === "boolean") {
    // spenta: via anche i nomi letti; le caselle aggiunte restano collegate
    stato = { ...stato, email: corpo.email ? { attivo: true, extra: (stato.email || {}).extra } : { attivo: false, extra: (stato.email || {}).extra } };
    cambiati = true;
  }
  // un'altra casella Gmail da leggere: { email:{ aggiungi:{utente, password} } } oppure { email:{ togli:"indirizzo" } }
  let erroreCasella = null;
  if (corpo && corpo.email && typeof corpo.email === "object") {
    const em = { ...(stato.email || {}) };
    const extra = [...(em.extra || [])];
    const ag = corpo.email.aggiungi;
    if (ag && ag.utente && ag.password) {
      const utente = String(ag.utente).trim().toLowerCase();
      const password = String(ag.password).replace(/\s+/g, "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(utente)) erroreCasella = "indirizzo email non valido";
      else if (password.length < 12) erroreCasella = "la password per le app ha 16 lettere: copiala tutta";
      else {
        try {
          await provaCasella({ utente, password });
          const i = extra.findIndex((x) => x.utente === utente);
          if (i >= 0) extra[i] = { utente, password }; else extra.push({ utente, password });
          if (em.caselle) delete em.caselle[utente];   // si rilegge da capo
          cambiati = true;
        } catch (err) { erroreCasella = spiegaErroreGmail(err); }
      }
    }
    if (corpo.email.togli) {
      const t = String(corpo.email.togli).trim().toLowerCase();
      const i = extra.findIndex((x) => x.utente === t);
      if (i >= 0) {
        extra.splice(i, 1);
        // via anche i nomi arrivati da quella casella
        em.conferme = Object.fromEntries(Object.entries(em.conferme || {}).filter(([, v]) => v.casella !== t));
        cambiati = true;
      }
    }
    stato = { ...stato, email: { ...em, extra } };
  }
  // ProhostAI: { chiave } collega, { scollega:true } toglie tutto, { case:{listingId:idStruttura|"-"} } abbina gli annunci
  if (corpo && corpo.prohost && typeof corpo.prohost === "object") {
    const q = corpo.prohost;
    let ph = { ...(stato.prohost || {}) };
    if (q.scollega) ph = {};
    if (typeof q.chiave === "string" && q.chiave.trim()) ph = { ...ph, chiave: q.chiave.trim().slice(0, 300), esito: null };
    if (q.case && typeof q.case === "object") {
      const casi = { ...(ph.case || {}) };
      for (const [k, v] of Object.entries(q.case)) if (/^[\w-]{1,80}$/.test(k) && /^[\w-]{0,40}$/.test(String(v))) casi[k] = String(v);
      ph.case = casi;
    }
    stato = { ...stato, prohost: ph };
    if (!ph.chiave) stato.prenotazioni = (stato.prenotazioni || []).filter((p) => p.sorgente !== "prohost");
    cambiati = true;
  }
  if (corpo && corpo.link && typeof corpo.link === "object") {
    const link = {};
    for (const [id, testo] of Object.entries(corpo.link)) {
      const l = pulisciLink(Array.isArray(testo) ? testo.join("\n") : testo);
      if (l.length && /^[\w-]{1,40}$/.test(id)) link[id] = l.slice(0, 5);
    }
    stato = { ...stato, link };
    cambiati = true;
  }
  const chiaveNuova = !!(corpo && corpo.prohost && typeof corpo.prohost.chiave === "string" && corpo.prohost.chiave.trim());
  if (haFonti(stato) && (cambiati || (corpo && corpo.aggiorna) || Date.now() - (stato.aggiornato || 0) > VECCHIO_MS)) {
    stato = await sincronizzaCalendari(conn, stato);
    // una chiave appena incollata che ProhostAI rifiuta non si tiene: si mostra l'errore e basta
    const e = stato.prohost && stato.prohost.esito;
    if (chiaveNuova && e && e.rifiutata) {
      stato = { ...stato, prohost: { esito: e }, prenotazioni: (stato.prenotazioni || []).filter((p) => p.sorgente !== "prohost") };
      await salvaCalendari(conn, stato);
    }
  } else if (cambiati) {
    stato = { ...stato, prenotazioni: [], esiti: {}, aggiornato: Date.now() };
    await salvaCalendari(conn, stato);
  }
  const vista = vistaCalendari(stato);
  if (erroreCasella) vista.email.errore = erroreCasella;
  return vista;
}

module.exports = { leggiIcal, prenotazioniDaEventi, pulisciLink, fonteDi, sincronizzaCalendari, leggiCalendari, azioneCalendari, conNomi, haFonti };
