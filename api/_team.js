// api/_team.js — collaboratori (ottobre 2026, l'utente: "una pagina per Sofia, dove le serve solo
// vedere calendario e pulizie; un'impostazione per abilitare altre funzioni con le spunte, come i
// co-host di Airbnb; con un suo codice d'accesso dedicato come quello che ho già").
//
// Ogni collaboratore ha un nome, un codice d'accesso SUO e i permessi a spunta. Entra dallo stesso
// indirizzo del gestionale: il codice lo riconosce /api/admin-code e la pagina mostra solo quello che
// è spuntato. I dati gli arrivano da UNA azione ("team" di /api/promemoria) che manda il minimo:
// date, casa, numero di ospiti, il link alla prenotazione su Airbnb e, se permesso, il nome di
// battesimo (più chiusure e promemoria del calendario). Mai cognomi, documenti, foto, date di
// nascita, telefoni: quelli restano dietro il codice del titolare (o "Accesso completo").
// In KV la chiave "collaboratori" = { lista: [{ id, nome, codice, permessi, creato, accesso }] }.
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.
const { upstash, redisCmd } = require("./_kv");

const KEY = "collaboratori";
// i permessi, nell'ordine in cui li mostra la pagina Impostazioni → Collaboratori
// eventi = può aggiungere, cambiare e segnare fatti promemoria e chiusure del calendario (azione "eventi")
const PERMESSI = ["calendario", "nomi", "eventi", "pulizie", "link", "completo"];
const PREDEFINITI = { calendario: true, nomi: true, eventi: false, pulizie: true, link: false, completo: false };
const MAX = 10;

function pulisciPermessi(p) {
  const out = {};
  for (const k of PERMESSI) out[k] = !!(p && p[k]);
  return out;
}

async function leggiTeam(conn) {
  try {
    const raw = await redisCmd(conn, ["GET", KEY]);
    const d = raw ? JSON.parse(raw) : null;
    return { lista: Array.isArray(d && d.lista) ? d.lista : [] };
  } catch { return { lista: [] }; }
}
const salvaTeam = (conn, d) => redisCmd(conn, ["SET", KEY, JSON.stringify({ lista: d.lista.slice(0, MAX) })]);

// il collaboratore con questo codice (null se nessuno): stesso confronto esatto del codice del titolare
async function trovaCollaboratore(conn, codice) {
  const c = String(codice || "").trim();
  if (c.length < 6) return null;
  const k = conn || upstash();
  if (!k) return null;
  const { lista } = await leggiTeam(k);
  const m = lista.find((x) => x.codice === c);
  return m ? { ...m, permessi: pulisciPermessi(m.permessi) } : null;
}

// Impostazioni → Collaboratori (solo il titolare): { op:"lista" } | { op:"salva", membro:{ id?, nome,
// codice, permessi } } | { op:"togli", id }. Risponde sempre con l'elenco aggiornato.
async function azioneCollaboratori(conn, body, codiceTitolare) {
  const d = await leggiTeam(conn);
  const op = String(body.op || "lista");
  if (op === "salva") {
    const m = body.membro || {};
    const nome = String(m.nome || "").replace(/\s+/g, " ").trim().slice(0, 30);
    const codice = String(m.codice || "").trim();
    if (!nome) return { ok: false, error: "Scrivi il nome del collaboratore" };
    if (codice.length < 6) return { ok: false, error: "Il codice deve avere almeno 6 caratteri" };
    if (/\s/.test(codice)) return { ok: false, error: "Il codice non può avere spazi" };
    if (codiceTitolare && codice === codiceTitolare) return { ok: false, error: "Questo è il TUO codice: scegline un altro" };
    if (d.lista.some((x) => x.codice === codice && x.id !== m.id)) return { ok: false, error: "Questo codice ce l'ha già un altro collaboratore" };
    const i = m.id ? d.lista.findIndex((x) => x.id === m.id) : -1;
    if (i < 0 && d.lista.length >= MAX) return { ok: false, error: `Al massimo ${MAX} collaboratori` };
    const voce = { ...(i >= 0 ? d.lista[i] : { id: "c" + Date.now().toString(36), creato: Date.now() }),
      nome, codice, permessi: pulisciPermessi(m.permessi || PREDEFINITI) };
    if (i >= 0) d.lista[i] = voce; else d.lista.push(voce);
    await salvaTeam(conn, d);
  } else if (op === "togli") {
    const prima = d.lista.length;
    d.lista = d.lista.filter((x) => x.id !== body.id);
    if (d.lista.length !== prima) await salvaTeam(conn, d);
  }
  return { ok: true, permessi: PERMESSI, predefiniti: PREDEFINITI,
    lista: d.lista.map((x) => ({ id: x.id, nome: x.nome, codice: x.codice, permessi: pulisciPermessi(x.permessi), creato: x.creato, accesso: x.accesso || null })) };
}

// "gg/mm/aaaa" da ms (UTC a mezzanotte)
const itDa = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };

// tutto quello che serve alla pagina del collaboratore, secondo i suoi permessi
async function datiTeam(conn, membro, oggiIso) {
  const p = membro.permessi;
  let strutture = [];
  try { strutture = (require("./_alloggiati").getStrutture() || []).map((s) => ({ id: s.id, nome: s.nome })); } catch { strutture = []; }
  const leggi = async (k) => { try { const raw = await redisCmd(conn, ["GET", k]); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const out = { ok: true, nome: membro.nome, permessi: p, strutture };
  // ultimo accesso (per la pagina del titolare), al massimo una scrittura ogni ora
  if (!membro.accesso || Date.now() - membro.accesso > 3600e3) {
    try {
      const d = await leggiTeam(conn);
      const v = d.lista.find((x) => x.id === membro.id);
      if (v) { v.accesso = Date.now(); await salvaTeam(conn, d); }
    } catch { /* non importante */ }
  }
  if (p.calendario || p.pulizie) out.orari = (await leggi("orari_case")) || {};
  if (p.calendario) {
    const { soggiorniPerCasa, msDa } = require("./_pulizie");
    const { leggiCalendari, vistaCalendari } = require("./_calendari");
    const [storico, pending, cal] = await Promise.all([leggi("storico_schedine"), leggi("checkin_pending"), leggiCalendari(conn)]);
    const vista = vistaCalendari(cal);
    const perCasa = soggiorniPerCasa({ storico, pending, esterne: vista.prenotazioni || [], strutture });
    // le chiusure (date bloccate su Airbnb, col motivo) e i promemoria scritti dall'host: solo da leggere
    out.blocchi = vista.blocchi || [];
    out.eventi = await require("./_eventi").leggiEventi(conn);
    const oggi = msDa(oggiIso.split("-").reverse().join("/"));
    const da = oggi - 62 * 864e5, a = oggi + 400 * 864e5;   // ~2 mesi indietro, un anno avanti
    // il link alla prenotazione su Airbnb ("🔗 Apri su Airbnb", come per l'host; l'utente: "Sofia deve
    // avere l'apri su Airbnb come ce l'ho io"). Si apre solo a chi è host/co-host su Airbnb. Per i
    // soggiorni già usciti dal calendario .ics si cerca nell'archivio dei link: stessa casa e date
    // che si accavallano, oppure (link dalle email, senza casa) stesse date d'arrivo e partenza.
    const archivio = vista.linkPrenotazioni || [];
    const linkDi = (casa, s) => {
      if (s.url) return { u: s.url, f: s.fonteUrl || "Airbnb" };
      const arr = itDa(s.arrivo), par = itDa(s.partenza);
      const t = archivio.find((l) => l.s === casa && msDa(l.a) < s.partenza && msDa(l.p) > s.arrivo)
        || (() => { const x = archivio.filter((l) => !l.s && l.a === arr && l.p === par); return x.length === 1 ? x[0] : null; })();
      return t && /^https?:\/\//i.test(t.u || "") ? { u: t.u, f: t.f || "Airbnb" } : null;
    };
    const soggiorni = [];
    for (const [casa, lista] of Object.entries(perCasa)) {
      for (const s of lista) {
        if (s.partenza < da || s.arrivo > a) continue;
        const l = linkDi(casa, s);
        soggiorni.push({ k: `${casa}-${s.arrivo / 864e5}`, s: casa, a: itDa(s.arrivo), p: itDa(s.partenza), o: s.ospiti || null,
          st: s.stato, f: s.stato === "airbnb" ? s.fonte : undefined, n: p.nomi && s.nome ? s.nome : undefined,
          u: l ? l.u : undefined, fu: l ? l.f : undefined });
      }
    }
    out.soggiorni = soggiorni.sort((x, y) => (x.a.split("/").reverse().join("") < y.a.split("/").reverse().join("") ? -1 : 1));
  }
  if (p.pulizie) {
    const { pulizieProssime } = require("./_pulizie");
    try { const pu = await pulizieProssime(conn, oggiIso); out.pulizie = { giorno: pu.giorno, oggi: pu.oggi, settimane: pu.settimane, mandate: pu.mandate }; }
    catch { out.pulizie = null; }
  }
  // il codice del check-in online, per il link da mandare agli ospiti (lo stesso del gestionale)
  if (p.link && process.env.CHECKIN_CODE) out.codiceCheckin = process.env.CHECKIN_CODE;
  return out;
}

module.exports = { trovaCollaboratore, azioneCollaboratori, datiTeam, PERMESSI, PREDEFINITI };
