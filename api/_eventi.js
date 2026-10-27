// api/_eventi.js — eventi del calendario scritti dall'host (ottobre 2026, l'utente: "aggiungi al
// calendario eventi manuali: la settimana dal 30/11 al 6/1 Falegnami è bloccata su Airbnb perché
// facciamo lavori; prima riconosci da solo le date bloccate, poi posso mettere il perché è chiuso;
// e posso aggiungere eventi anche in date occupate, cose da fare o scadenze: viene l'idraulico,
// manutenzione estintore").
//  - promemoria: una cosa da fare in un giorno (o in più giorni), anche con ospiti in casa;
//    si segna "fatto". Compare nel calendario, nel giorno, nelle Scadenze della Home e nella
//    notifica del mattino (oggi e domani).
//  - chiusura: la casa non è disponibile (lavori, uso personale) anche se su Airbnb non è bloccata.
//  - blocchi: il motivo scritto dall'host per una chiusura letta da Airbnb (chiave "casa|aaaa-mm-gg"
//    del primo giorno), oppure "nascosto" se quel blocco non è una chiusura vera.
// In KV la chiave "eventi_calendario" = { lista:[{ id, tipo, s, titolo, dal, al, ora, nota, fatto,
// creato }], blocchi:{ chiave:{ motivo, nascosto, ts } } }. dal/al = "gg/mm/aaaa", al compreso.
// s = id della casa, "" = tutte le case. Il nome inizia con "_": non conta nel limite di 12 funzioni.
const { redisCmd } = require("./_kv");

const KEY = "eventi_calendario";
const MAX = 500;
const GIORNO = 86400000;

const ms = (d) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(d || "").trim()); if (!m) return null;
  const t = Date.UTC(+m[3], +m[2] - 1, +m[1]); const x = new Date(t);
  return x.getUTCDate() === +m[1] && x.getUTCMonth() === +m[2] - 1 ? t : null; };
const testo = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);

async function leggiEventi(conn) {
  try {
    const raw = await redisCmd(conn, ["GET", KEY]);
    const d = raw ? JSON.parse(raw) : {};
    return { lista: Array.isArray(d.lista) ? d.lista : [], blocchi: d.blocchi && typeof d.blocchi === "object" ? d.blocchi : {} };
  } catch { return { lista: [], blocchi: {} }; }
}
async function salvaEventi(conn, d) {
  // via quelli finiti da più di 400 giorni (il calendario guarda indietro poco)
  const limite = Date.now() - 400 * GIORNO;
  d.lista = d.lista.filter((e) => (ms(e.al) || ms(e.dal) || 0) >= limite).slice(-MAX);
  await redisCmd(conn, ["SET", KEY, JSON.stringify(d)]);
}

// { op:"lista" } | { op:"salva", evento } | { op:"togli", id } | { op:"fatto", id, fatto } |
// { op:"blocco", chiave, motivo?, nascosto? } — risponde sempre con tutto aggiornato.
// autore = il nome del collaboratore che fa la modifica (permesso "eventi", es. Sofia): resta scritto
// sull'evento (da, modDa, fattoDa) così l'host sa chi l'ha messo; vuoto = l'host stesso.
async function azioneEventi(conn, body, { autore = "" } = {}) {
  const d = await leggiEventi(conn);
  const op = String(body.op || "lista");
  if (op === "salva") {
    const e = body.evento || {};
    const tipo = e.tipo === "chiusura" ? "chiusura" : "promemoria";
    const s = /^[\w-]{0,40}$/.test(String(e.s || "")) ? String(e.s || "") : "";
    const dal = ms(e.dal); let al = e.al ? ms(e.al) : dal;
    if (!dal) return { ok: false, error: "Data di inizio non valida" };
    if (!al) return { ok: false, error: "Data di fine non valida" };
    if (al < dal) return { ok: false, error: "La fine viene prima dell'inizio" };
    if (al - dal > 366 * GIORNO) return { ok: false, error: "Al massimo un anno" };
    const titolo = testo(e.titolo, 80) || (tipo === "chiusura" ? "Chiusa" : "");
    if (!titolo) return { ok: false, error: "Scrivi cosa c'è da fare" };
    const ora = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.ora || "")) ? e.ora : "";
    const voce = { tipo, s, titolo, dal: e.dal.trim(), al: (e.al || e.dal).trim(), ora: tipo === "promemoria" ? ora : "", nota: testo(e.nota, 300) };
    const i = e.id ? d.lista.findIndex((x) => x.id === e.id) : -1;
    if (i >= 0) d.lista[i] = { ...d.lista[i], ...voce, modDa: autore || "" };
    else {
      if (d.lista.length >= MAX) return { ok: false, error: "Troppi eventi" };
      d.lista.push({ id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ...voce, fatto: null, creato: Date.now(), da: autore || "" });
    }
    await salvaEventi(conn, d);
  } else if (op === "togli") {
    const prima = d.lista.length;
    d.lista = d.lista.filter((x) => x.id !== body.id);
    if (d.lista.length !== prima) await salvaEventi(conn, d);
  } else if (op === "fatto") {
    const v = d.lista.find((x) => x.id === body.id);
    if (v) { v.fatto = body.fatto ? Date.now() : null; v.fattoDa = body.fatto ? autore || "" : ""; await salvaEventi(conn, d); }
  } else if (op === "blocco") {
    const k = String(body.chiave || "");
    if (!/^[\w-]{1,40}\|\d{4}-\d{2}-\d{2}$/.test(k)) return { ok: false, error: "Chiusura non riconosciuta" };
    const motivo = testo(body.motivo, 60), nascosto = !!body.nascosto;
    if (motivo || nascosto) d.blocchi[k] = { motivo, nascosto, ts: Date.now(), da: autore || "" };
    else delete d.blocchi[k];
    await salvaEventi(conn, d);
  }
  return { ok: true, lista: d.lista, blocchi: d.blocchi };
}

// per la notifica del mattino: i promemoria non fatti di un giorno ("aaaa-mm-gg")
function promemoriaDelGiorno(d, iso) {
  const g = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return (d.lista || []).filter((e) => e.tipo === "promemoria" && !e.fatto && ms(e.dal) <= g && (ms(e.al) || ms(e.dal)) >= g)
    .sort((a, b) => String(a.ora || "99").localeCompare(String(b.ora || "99")));
}

// la riga della notifica all'host quando un collaboratore cambia il calendario ("" = niente da dire)
function descriviModifica(prima, dopo, body, nome) {
  const op = String(body.op || "");
  const trova = (d, id) => (d.lista || []).find((x) => x.id === id);
  const quando = (e) => (e.dal === e.al || !e.al ? e.dal : `${e.dal}–${e.al}`).replace(/\/\d{4}/g, "");
  const cosa = (e) => `${e.tipo === "chiusura" ? "🔒 chiusura" : "📌"} ${e.titolo} (${quando(e)}${e.ora ? " alle " + e.ora : ""})`;
  if (op === "salva") {
    const id = body.evento && body.evento.id;
    const e = id ? trova(dopo, id) : (dopo.lista || []).filter((x) => !trova(prima, x.id)).pop();
    return e ? `✏️ ${nome} ha ${id ? "cambiato" : "aggiunto"} nel calendario: ${cosa(e)}` : "";
  }
  if (op === "togli") { const e = trova(prima, body.id); return e ? `🗑 ${nome} ha tolto dal calendario: ${cosa(e)}` : ""; }
  if (op === "fatto") { const e = trova(dopo, body.id); return e && body.fatto ? `✅ ${nome} ha segnato fatto: ${cosa(e)}` : ""; }
  if (op === "blocco") return `🔒 ${nome} ha ${body.nascosto ? "tolto dal calendario una chiusura di Airbnb" : "scritto il motivo di una chiusura: " + (body.motivo || "(tolto)")}`;
  return "";
}

module.exports = { leggiEventi, azioneEventi, promemoriaDelGiorno, descriviModifica };
