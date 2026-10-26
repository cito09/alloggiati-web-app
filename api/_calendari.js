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
//     archivio: { CODICE|uid: { s: idStruttura, f: fonte, a: arrivo, p: partenza, u: link } } — TUTTE le
//              prenotazioni lette dai calendari, anche finite da tanto: il link alla prenotazione su
//              Airbnb resta per sempre al soggiorno (le "prenotazioni" del calendario si fermano a 45 giorni)
const crypto = require("crypto");
const { redisCmd } = require("./_kv");
const { leggiConfermeAirbnb, provaCasella, spiegaErroreGmail, VERSIONE_ARCHIVIO, destinazioni, filtriGmailXml } = require("./_airbnbEmail");
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
const aaaammgg = (d) => String(d || "").split("/").reverse().join("");

// dagli eventi del calendario alle prenotazioni vere: via i blocchi ("Airbnb (Not
// available)", date chiuse a mano), via le date sbagliate e quelle ormai lontane
function prenotazioniDaEventi(eventi, { strutturaId, url, oggi = Date.now(), giorniPassati = 45 }) {
  const fonte = fonteDi(url), sorgente = sorgenteDi(url);
  const limitePassato = oggi - giorniPassati * 86400000;
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
    return { link: s.link || {}, prenotazioni: s.prenotazioni || [], esiti: s.esiti || {}, aggiornato: s.aggiornato || 0, email: s.email || {}, prohost: s.prohost || {}, archivio: s.archivio || {} };
  } catch { return { link: {}, prenotazioni: [], esiti: {}, aggiornato: 0, email: {}, prohost: {}, archivio: {} }; }
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
// Per le cartelle di archivio di ogni casella: di quali case sono i contratti che ci arrivano
// (CONTRATTI_STRUTTURE.email = la casella a cui va la copia firmata) e se è quella che manda i
// moduli ISTAT all'APT (la casella di KeyFlow, GMAIL_USER).
async function opzioniCartelle(conn, c, em) {
  let contratti = [];
  try { contratti = require("./_contratto").getContrattiStrutture(); } catch { contratti = []; }
  const strutture = struttureConfigurate();
  const nomiCasa = contratti.filter((x) => String(x.email || "").toLowerCase() === c.utente.toLowerCase())
    .map((x) => (strutture.find((s) => s.id === x.id) || {}).nome || x.id).filter(Boolean);
  let apt = "";
  if (c.principale && conn) {
    try { const raw = await redisCmd(conn, ["GET", "istat_config"]); apt = String((raw ? JSON.parse(raw) : {}).email || "").trim(); } catch { apt = ""; }
  }
  const fascicolo = c.principale && (!process.env.FASCICOLO_EMAIL || process.env.FASCICOLO_EMAIL.toLowerCase() === c.utente.toLowerCase());
  // cartelle scelte a mano dall'host nella pagina Calendari (sennò si riconoscono dal nome)
  const scelte = ((em && em.cartelleScelte) || {})[c.utente.toLowerCase()] || {};
  return { nomiCasa, apt, fascicolo, scelte };
}

// le conferme di Airbnb lette da tutte le caselle, aggiunte a quelle già lette le volte prima
// (è l'archivio di KeyFlow: se poi l'email si cancella, nome e ospiti restano)
async function aggiornaEmail(email, conn) {
  const e = { ...(email || {}) };
  if (!emailAccesa(e)) return e;
  const caselle = caselleEmail(e);
  if (!caselle.length) { e.esito = { ok: false, errore: "nessuna casella Gmail collegata", ts: Date.now() }; return e; }
  const stati = { ...(e.caselle || {}) };
  // stato salvato dalla versione con una casella sola: era quello di GMAIL_USER
  if (e.stato && process.env.GMAIL_USER && !stati[process.env.GMAIL_USER]) stati[process.env.GMAIL_USER] = { stato: e.stato };
  delete e.stato;
  const conferme = { ...(e.conferme || {}) };
  const cancellate = { ...(e.cancellate || {}) };   // codice HM… → {ts, nome, arrivo, partenza}
  // codici di TUTTE le conferme lette (le "conferme" si tolgono 120 giorni dopo la partenza): servono
  // ad aprire su Airbnb anche i soggiorni vecchi, quelli che il calendario .ics non riporta più
  const codici = { ...(e.codici || {}) };            // codice HM… → {a, p, n, ts}
  const risultati = await Promise.all(caselle.map(async (c) => {
    try {
      const r = await leggiConfermeAirbnb({ utente: c.utente, password: c.password, stato: (stati[c.utente] || {}).stato || {},
        cartelle: await opzioniCartelle(conn, c, e) });
      return { c, ok: true, r };
    } catch (err) { return { c, ok: false, errore: spiegaErroreGmail(err) }; }
  }));
  for (const x of risultati) {
    const prima = stati[x.c.utente] || {};
    if (x.ok) {
      x.r.nuove.forEach((c) => { conferme[c.codice] = { nome: c.nome, ospiti: c.ospiti, arrivo: c.arrivo, partenza: c.partenza, ts: c.ts, casella: x.c.utente };
        if (c.arrivo && c.partenza) codici[c.codice] = { a: c.arrivo, p: c.partenza, n: c.nome || "", ts: c.ts, casella: x.c.utente }; });
      (x.r.cancellate || []).forEach((c) => { if (!cancellate[c.codice] || cancellate[c.codice].ts < c.ts) cancellate[c.codice] = { ts: c.ts, casella: x.c.utente }; });
      // quante email sono finite in ogni cartella di archivio (in tutto, da quando è collegata)
      const tot = { ...(prima.cartelle || {}) };
      for (const [k, n] of Object.entries(x.r.archiviate || {})) tot[k] = (tot[k] || 0) + n;
      // e quante sono passate dalle cartelle "KeyFlow/…" a quelle che l'host aveva già
      const traslochi = [...(prima.traslochi || []), ...(x.r.spostate || []).map((t) => ({ ...t, ts: Date.now() }))].slice(-10);
      // quante sono uscite da Posta in arrivo (spostate davvero nella loro cartella), in tutto
      const fuori = { ...(prima.fuori || {}) };
      for (const [k, n] of Object.entries(x.r.fuoriInbox || {})) fuori[k] = (fuori[k] || 0) + n;
      console.log("cartelle gmail", JSON.stringify({ principale: x.c.principale, destinazioni: x.r.destinazioni,
        archiviate: x.r.archiviate, fuoriInbox: x.r.fuoriInbox, spostate: x.r.spostate, errore: x.r.erroreCartelle || null }));
      stati[x.c.utente] = { stato: x.r.stato, cartelle: tot, traslochi, fuori,
        etichetteGmail: (x.r.etichetteGmail || []).slice(0, 150), destinazioni: x.r.destinazioni || prima.destinazioni || null,
        esito: { ok: true, ts: Date.now(), nuove: x.r.nuove.length, ...(x.r.erroreCartelle ? { erroreCartelle: x.r.erroreCartelle } : {}) } };
    } else {
      stati[x.c.utente] = { ...prima, esito: { ok: false, ts: Date.now(), errore: x.errore } };
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
  // prenotazione cancellata: il nome esce dall'archivio (resta solo nella voce della cancellazione,
  // per dire CHI ha cancellato). Una conferma arrivata DOPO la cancellazione vince (rifatta uguale).
  for (const [codice, c] of Object.entries(cancellate)) {
    if (codici[codice] && !(codici[codice].ts > c.ts)) delete codici[codice];
    const conf = conferme[codice];
    if (conf && conf.ts > c.ts) { delete cancellate[codice]; continue; }
    if (conf) { cancellate[codice] = { ...c, nome: conf.nome, arrivo: conf.arrivo, partenza: conf.partenza, ospiti: conf.ospiti }; delete conferme[codice]; }
    if (c.ts < Date.now() - 120 * 86400000) delete cancellate[codice];
  }
  e.caselle = stati;
  e.conferme = conferme;
  e.cancellate = cancellate;
  const limiteCodici = Date.now() - 3 * 365 * 86400000;
  for (const [k, v] of Object.entries(codici)) if (giornoUtc(aaaammgg(v.p)) < limiteCodici) delete codici[k];
  e.codici = codici;
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
// archivio dei link: una voce per prenotazione (per codice HM…, sennò per uid), mai cancellata
// tranne dopo 3 anni. Si tiene solo cosa serve per riconoscere il soggiorno e aprirlo su Airbnb.
function archivia(archivio, lista) {
  for (const p of lista || []) {
    if (!p || !/^https?:\/\//i.test(p.url || "") || !p.arrivo || !p.partenza) continue;
    archivio[String(p.codice || p.uid).toUpperCase()] = { s: p.strutturaId || "", f: p.fonte || "Airbnb", a: p.arrivo, p: p.partenza, u: p.url };
  }
  const limite = Date.now() - 3 * 365 * 86400000;
  for (const [k, v] of Object.entries(archivio)) if (giornoUtc(aaaammgg(v.p)) < limite) delete archivio[k];
  return archivio;
}
const haFonti = (stato) => Object.values(stato.link || {}).some((l) => (l || []).length) || !!(stato.prohost && stato.prohost.chiave);

// Rilegge tutti i link. Se un link non risponde, le prenotazioni lette l'ultima volta da
// quel link restano (un portale giù per un'ora non deve svuotare il calendario).
async function sincronizzaCalendari(conn, stato) {
  stato = stato || (await leggiCalendari(conn));
  const emailInArrivo = aggiornaEmail(stato.email, conn);   // in parallelo ai calendari
  const prohostInArrivo = aggiornaProhost(stato.prohost);
  const lavori = [];
  for (const [strutturaId, links] of Object.entries(stato.link || {})) {
    for (const url of links || []) lavori.push({ strutturaId, url, sorgente: sorgenteDi(url) });
  }
  const archivio = { ...(stato.archivio || {}) };
  const risultati = await Promise.all(lavori.map(async (l) => {
    try {
      // tutte quelle del file vanno nell'archivio dei link; nel calendario solo le recenti
      const tutte = prenotazioniDaEventi(leggiIcal(await scaricaCalendario(l.url)), { ...l, giorniPassati: 3650 });
      const limite = Date.now() - 45 * 86400000;
      const pren = tutte.filter((p) => giornoUtc(aaaammgg(p.partenza)) >= limite);
      return { ...l, ok: true, pren, tutte };
    } catch (e) { return { ...l, ok: false, errore: spiegaErrore(e) }; }
  }));
  const sorgentiAttive = new Set(lavori.map((l) => l.sorgente));
  const fallite = new Set(risultati.filter((r) => !r.ok).map((r) => r.sorgente));
  const prenotazioni = (stato.prenotazioni || []).filter((p) => sorgentiAttive.has(p.sorgente) && fallite.has(p.sorgente));
  const esiti = {};
  for (const r of risultati) {
    if (r.ok) { prenotazioni.push(...r.pren); archivia(archivio, r.tutte); }
    esiti[r.sorgente] = r.ok
      ? { ok: true, quante: r.pren.length, ts: Date.now(), strutturaId: r.strutturaId, fonte: fonteDi(r.url) }
      : { ok: false, errore: r.errore, ts: Date.now(), strutturaId: r.strutturaId, fonte: fonteDi(r.url),
          quante: (stato.prenotazioni || []).filter((p) => p.sorgente === r.sorgente).length };
  }
  const ph = await prohostInArrivo;
  // ProhostAI non ha risposto: restano le sue prenotazioni lette l'ultima volta
  prenotazioni.push(...(ph.pren || (stato.prenotazioni || []).filter((p) => p.sorgente === "prohost")));
  archivia(archivio, ph.pren || []);
  const nuovo = { link: stato.link || {}, prenotazioni, esiti, aggiornato: Date.now(), email: await emailInArrivo, prohost: ph.prohost, archivio };
  await salvaCalendari(conn, nuovo);
  await avvisaCancellazioni(stato, nuovo);
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
// per il gestionale: tutti i link alle prenotazioni, anche dei soggiorni vecchi.
// s = casa (dai calendari .ics); quelli dalle email non sanno la casa ma hanno il nome (n).
function linkPrenotazioni(stato, canc) {
  const out = [], visti = new Set();
  for (const [k, v] of Object.entries(stato.archivio || {})) {
    if (canc[k]) continue;
    visti.add(k); out.push({ s: v.s, f: v.f, a: v.a, p: v.p, u: v.u });
  }
  const em = stato.email || {};
  if (emailAccesa(em)) {
    for (const [k, v] of Object.entries(em.codici || {})) {
      if (visti.has(k) || canc[k] || !/^HM[A-Z0-9]+$/.test(k)) continue;
      out.push({ s: "", f: "Airbnb", a: v.a, p: v.p, n: v.n || "", u: `https://www.airbnb.it/hosting/reservations/details/${k}` });
    }
  }
  return out;
}
function vistaCalendari(stato) {
  const link = {};
  for (const [id, links] of Object.entries(stato.link || {})) {
    link[id] = (links || []).map((url) => ({ url, fonte: fonteDi(url), esito: (stato.esiti || {})[sorgenteDi(url)] || null }));
  }
  const em = stato.email || {};
  // una prenotazione cancellata (email di Airbnb) sparisce subito, anche se il calendario .ics
  // non si è ancora aggiornato
  const canc = emailAccesa(em) ? (em.cancellate || {}) : {};
  const attive = (stato.prenotazioni || []).filter((p) => !(p.codice && canc[String(p.codice).toUpperCase()]));
  const prenotazioni = emailAccesa(em) ? conNomi(attive, em.conferme) : attive;
  return { ok: true, link, prenotazioni, aggiornato: stato.aggiornato || 0, linkPrenotazioni: linkPrenotazioni(stato, canc),
    email: { attivo: emailAccesa(em), configurato: caselleEmail(em).length > 0, casella: process.env.GMAIL_USER || "",
      esito: em.esito || null, conferme: Object.keys(em.conferme || {}).length,
      conNome: prenotazioni.filter((p) => p.nome).length,
      // le ultime cancellazioni lette dalle email (per la pagina Calendari)
      cancellate: Object.values(canc).sort((a, b) => b.ts - a.ts).slice(0, 5)
        .map((c) => ({ nome: c.nome || "", arrivo: c.arrivo || "", partenza: c.partenza || "", ts: c.ts })),
      // una riga per casella: indirizzo, com'è andata e quante conferme ha dato (mai la password)
      caselle: caselleEmail(em).map((c) => ({ utente: c.utente, principale: c.principale,
        esito: ((em.caselle || {})[c.utente] || {}).esito || null,
        cartelle: ((em.caselle || {})[c.utente] || {}).cartelle || {},
        // in quale cartella Gmail va ogni tipo di email, e tra quali si può scegliere
        destinazioni: ((em.caselle || {})[c.utente] || {}).destinazioni || null,
        scelte: (em.cartelleScelte || {})[c.utente.toLowerCase()] || {},
        etichetteGmail: ((em.caselle || {})[c.utente] || {}).etichetteGmail || [],
        traslochi: ((em.caselle || {})[c.utente] || {}).traslochi || [],
        fuori: ((em.caselle || {})[c.utente] || {}).fuori || {},
        conferme: Object.values(em.conferme || {}).filter((x) => x.casella === c.utente).length })),
      errore: null },
    // la chiave di ProhostAI non torna mai al telefono: solo l'inizio e la fine, per riconoscerla
    prohost: { collegato: !!(stato.prohost && stato.prohost.chiave), chiave: chiaveMascherata(stato.prohost && stato.prohost.chiave),
      annunci: (stato.prohost && stato.prohost.annunci) || [], esito: (stato.prohost && stato.prohost.esito) || null } };
}

// Notifica sul telefono (ntfy) per ogni prenotazione cancellata appena arrivata: solo email delle
// ultime 48 ore (la prima volta si ripassano 13 mesi di email: niente valanga di avvisi vecchi).
async function avvisaCancellazioni(prima, dopo) {
  const topic = process.env.NTFY_TOPIC;
  const vecchie = ((prima && prima.email) || {}).cancellate || {};
  const nuove = Object.entries(((dopo && dopo.email) || {}).cancellate || {})
    .filter(([k, c]) => !vecchie[k] && c.ts > Date.now() - 48 * 3600000);
  if (!topic || !nuove.length) return;
  const strutture = struttureConfigurate();
  for (const [codice, c] of nuove) {
    const p = ((prima && prima.prenotazioni) || []).find((x) => String(x.codice || "").toUpperCase() === codice) || {};
    const casa = ((strutture.find((s) => s.id === p.strutturaId) || {}).nome) || "";
    const arr = c.arrivo || p.arrivo || "", par = c.partenza || p.partenza || "";
    const testo = `❌ Prenotazione cancellata${casa ? " · " + casa : ""}: ${c.nome || "ospite Airbnb"}${arr ? ` (${arr.slice(0, 5)}${par ? "–" + par.slice(0, 5) : ""})` : ""}. Tolta dal calendario di KeyFlow.`;
    try { await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", headers: { Title: "Cancellazione Airbnb" }, body: testo }); } catch { /* si vede comunque nel calendario */ }
  }
}

/* Una lettura alla volta. Caso reale (15/10/2026): due richieste a 4 secondi di distanza
   (apertura dell'app + pagina Calendari) hanno letto le caselle insieme; la seconda ha cercato di
   traslocare una cartella "KeyFlow/…" che la prima aveva appena tolto ("Unknown Mailbox"), e il
   suo risultato con l'errore ha sovrascritto quello buono. Ora chi arriva mentre un'altra lettura
   è in corso aspetta che finisca e riparte dallo stato aggiornato (di solito non deve più
   rileggere niente). Se l'archivio non risponde o l'attesa supera 25 s si va avanti lo stesso. */
const CHIAVE_TURNO = "calendari_lettura_in_corso";
async function conTurno(conn, lavoro, attesaMax = 25000) {
  const token = crypto.randomBytes(6).toString("hex");
  let mio = false;
  if (conn) {
    const inizio = Date.now();
    for (;;) {
      let r = null;
      try { r = await redisCmd(conn, ["SET", CHIAVE_TURNO, token, "NX", "EX", "58"]); } catch { break; }
      if (r === "OK") { mio = true; break; }
      if (Date.now() - inizio > attesaMax) break;
      await new Promise((ok) => setTimeout(ok, 800));
    }
  }
  try { return await lavoro(); }
  finally {
    if (mio) {
      try { if ((await redisCmd(conn, ["GET", CHIAVE_TURNO])) === token) await redisCmd(conn, ["DEL", CHIAVE_TURNO]); } catch { /* scade da solo */ }
    }
  }
}

// azione 'calendari' di /api/promemoria: { link?:{idStruttura:"testo con i link"}, aggiorna?:true }
function azioneCalendari(conn, corpo) {
  return conTurno(conn, () => azioneCalendariInTurno(conn, corpo));
}
async function azioneCalendariInTurno(conn, corpo) {
  let stato = await leggiCalendari(conn);
  // il file dei filtri di Gmail di una casella: { filtriGmail:"indirizzo" } → { ok, nomeFile, xml }
  if (corpo && corpo.filtriGmail) {
    const em = stato.email || {};
    const c = caselleEmail(em).find((x) => x.utente.toLowerCase() === String(corpo.filtriGmail).trim().toLowerCase());
    if (!c) return { ok: false, error: "Casella non collegata a KeyFlow" };
    const opz = await opzioniCartelle(conn, c, em);
    const st = (em.caselle || {})[c.utente] || {};
    const dest = st.destinazioni || destinazioni(st.etichetteGmail || [], opz.scelte);
    return { ok: true, nomeFile: `filtri-gmail-${c.utente.split("@")[0]}.xml`,
      xml: filtriGmailXml({ utente: c.utente, dest, mittente: process.env.GMAIL_USER || "", apt: opz.apt, nomiCasa: opz.nomiCasa, fascicolo: opz.fascicolo }) };
  }
  let cambiati = false;
  // nomi dalle email di Airbnb: acceso o spento dal gestionale (riaccendendolo si rilegge tutto)
  if (corpo && typeof corpo.email === "boolean") {
    // spenta: via anche i nomi letti; le caselle aggiunte restano collegate
    const { extra, cartelleScelte } = stato.email || {};
    stato = { ...stato, email: { attivo: !!corpo.email, extra, cartelleScelte } };
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
    // la cartella Gmail per un tipo di email: { email:{ cartella:{ utente, tipo, nome } } }
    // nome "" = la riconosce KeyFlow, "-" = non archiviare
    const cs = corpo.email.cartella;
    if (cs && cs.utente && ["prenotazioni", "contratti", "apt"].includes(cs.tipo)) {
      const u = String(cs.utente).trim().toLowerCase();
      const scelte = { ...(em.cartelleScelte || {}) };
      const mie = { ...(scelte[u] || {}) };
      const nome = String(cs.nome == null ? "" : cs.nome).slice(0, 120);
      if (nome) mie[cs.tipo] = nome; else delete mie[cs.tipo];
      scelte[u] = mie;
      em.cartelleScelte = scelte;
      cambiati = true;
    }
    if (corpo.email.togli) {
      const t = String(corpo.email.togli).trim().toLowerCase();
      const i = extra.findIndex((x) => x.utente === t);
      if (i >= 0) {
        extra.splice(i, 1);
        // via anche i nomi arrivati da quella casella
        em.conferme = Object.fromEntries(Object.entries(em.conferme || {}).filter(([, v]) => v.casella !== t));
        em.codici = Object.fromEntries(Object.entries(em.codici || {}).filter(([, v]) => v.casella !== t));
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
  // una casella mai letta con le cartelle dell'host (versione di prima: tutto in "KeyFlow/…"):
  // la rileggo subito, senza aspettare la mezz'ora, così le cartelle doppie spariscono appena si
  // apre l'app. Se la lettura fallisce si riprova al massimo ogni 5 minuti.
  const emS = stato.email || {};
  const cartelleDaSistemare = emailAccesa(emS) && caselleEmail(emS).some((c) => {
    const x = (emS.caselle || {})[c.utente] || {};
    // mai letta con le cartelle dell'host, o mai fatto il controllo generale (tutte le email, spostate davvero)
    const versione = (((x.stato || {}).etichette) || {}).versione || 1;
    return (!x.destinazioni || versione < VERSIONE_ARCHIVIO) && !(x.esito && Date.now() - (x.esito.ts || 0) < 5 * 60000);
  });
  if (haFonti(stato) && (cambiati || cartelleDaSistemare || (corpo && corpo.aggiorna) || Date.now() - (stato.aggiornato || 0) > VECCHIO_MS)) {
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

module.exports = { leggiIcal, prenotazioniDaEventi, pulisciLink, fonteDi, sincronizzaCalendari, leggiCalendari, azioneCalendari, conNomi, haFonti, conTurno };
