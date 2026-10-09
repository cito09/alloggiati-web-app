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
//     esiti: { sorgente: { ok, quante, errore, ts } }, aggiornato: ts }
const crypto = require("crypto");
const { redisCmd } = require("./_kv");

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
    return { link: s.link || {}, prenotazioni: s.prenotazioni || [], esiti: s.esiti || {}, aggiornato: s.aggiornato || 0 };
  } catch { return { link: {}, prenotazioni: [], esiti: {}, aggiornato: 0 }; }
}
async function salvaCalendari(conn, stato) {
  await redisCmd(conn, ["SET", KEY, JSON.stringify(stato)]);
}

// Rilegge tutti i link. Se un link non risponde, le prenotazioni lette l'ultima volta da
// quel link restano (un portale giù per un'ora non deve svuotare il calendario).
async function sincronizzaCalendari(conn, stato) {
  stato = stato || (await leggiCalendari(conn));
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
  const nuovo = { link: stato.link || {}, prenotazioni, esiti, aggiornato: Date.now() };
  await salvaCalendari(conn, nuovo);
  return nuovo;
}

// risposta per il gestionale: i link con l'esito di ciascuno (senza ripetere gli indirizzi
// nell'elenco delle prenotazioni) e le prenotazioni
function vistaCalendari(stato) {
  const link = {};
  for (const [id, links] of Object.entries(stato.link || {})) {
    link[id] = (links || []).map((url) => ({ url, fonte: fonteDi(url), esito: (stato.esiti || {})[sorgenteDi(url)] || null }));
  }
  return { ok: true, link, prenotazioni: stato.prenotazioni || [], aggiornato: stato.aggiornato || 0 };
}

// azione 'calendari' di /api/promemoria: { link?:{idStruttura:"testo con i link"}, aggiorna?:true }
async function azioneCalendari(conn, corpo) {
  let stato = await leggiCalendari(conn);
  let cambiati = false;
  if (corpo && corpo.link && typeof corpo.link === "object") {
    const link = {};
    for (const [id, testo] of Object.entries(corpo.link)) {
      const l = pulisciLink(Array.isArray(testo) ? testo.join("\n") : testo);
      if (l.length && /^[\w-]{1,40}$/.test(id)) link[id] = l.slice(0, 5);
    }
    stato = { ...stato, link };
    cambiati = true;
  }
  const haLink = Object.values(stato.link || {}).some((l) => (l || []).length);
  if (haLink && (cambiati || (corpo && corpo.aggiorna) || Date.now() - (stato.aggiornato || 0) > VECCHIO_MS)) {
    stato = await sincronizzaCalendari(conn, stato);
  } else if (cambiati) {
    stato = { ...stato, prenotazioni: [], esiti: {}, aggiornato: Date.now() };
    await salvaCalendari(conn, stato);
  }
  return vistaCalendari(stato);
}

module.exports = { leggiIcal, prenotazioniDaEventi, pulisciLink, fonteDi, sincronizzaCalendari, leggiCalendari, azioneCalendari };
