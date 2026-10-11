// api/_prohost.js — prenotazioni con nome e ospiti da ProhostAI (API ufficiale).
// ProhostAI è già collegato ad Airbnb dell'host e ha tutte le prenotazioni di tutti gli
// annunci, con nome, adulti/bambini/neonati e date. L'host crea una "chiave API" nel suo
// pannello (app.prohost.ai → Impostazioni → 🔑 API Keys, permessi di sola lettura) e la
// incolla in KeyFlow (Impostazioni → Calendari Airbnb). Documentazione: connect.prohost.ai/docs
// Si tengono solo i dati che servono al calendario: nome, numero di ospiti, date, codice,
// ultime 4 cifre del telefono. Mai email, telefono intero o importi.
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.

const BASE = "https://connect.prohost.ai/v1";
const ATTESA_MS = 15000;
const PAROLE_GENERICHE = new Set(["house", "loft", "casa", "home", "apartment", "appartamento", "suite", "villa", "room", "camera", "studio", "centro"]);

// errori spiegati come li capisce l'host
function erroreProhost(status, corpo) {
  if (status === 401) return "ProhostAI non riconosce la chiave: ricontrolla di averla copiata tutta, o creane una nuova";
  if (status === 402) return "il tuo piano di ProhostAI non permette questo accesso: serve un piano superiore";
  if (status === 403) return "la chiave non ha il permesso di leggere prenotazioni e annunci: creane una con quei permessi";
  if (status === 429) return "troppe richieste a ProhostAI in poco tempo: riprovo più tardi";
  if (status >= 500) return `ProhostAI ha un problema in questo momento (HTTP ${status})`;
  const dettaglio = corpo && (corpo.detail || corpo.error || corpo.message);
  return `ProhostAI ha risposto con un errore (HTTP ${status})${dettaglio ? ": " + String(typeof dettaglio === "string" ? dettaglio : JSON.stringify(dettaglio)).slice(0, 120) : ""}`;
}

async function chiamata(chiave, percorso, parametri) {
  const url = new URL(BASE + percorso);
  for (const [k, v] of Object.entries(parametri || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let r;
  try {
    r = await fetch(url, { headers: { "X-API-Key": chiave, Accept: "application/json" }, signal: AbortSignal.timeout(ATTESA_MS) });
  } catch (e) {
    throw new Error(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "ProhostAI non ha risposto in tempo" : "ProhostAI non è raggiungibile in questo momento");
  }
  let corpo = null;
  try { corpo = await r.json(); } catch { /* risposta non JSON */ }
  if (!r.ok) { const e = new Error(erroreProhost(r.status, corpo)); e.status = r.status; throw e; }
  return corpo || {};
}
// tutte le pagine (con un limite, per non far durare troppo la lettura)
async function tutteLePagine(chiave, percorso, parametri, maxPagine = 10) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < maxPagine; i++) {
    const d = await chiamata(chiave, percorso, { ...parametri, limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...(d.items || []));
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  return out;
}

// giorno (gg/mm/aaaa) nel fuso dell'appartamento: "2026-10-22T22:00:00Z" a Roma è già il 23
function giornoLocale(iso, fuso) {
  if (!iso) return "";
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || !/[T ]\d{2}:\d{2}/.test(s)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  }
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  if (isNaN(d)) return "";
  let p;
  try {
    p = new Intl.DateTimeFormat("en-CA", { timeZone: fuso || "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  } catch {
    p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  }
  return `${p.day}/${p.month}/${p.year}`;
}
const giornoUtc = (g) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(g || ""); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : NaN; };

function fonteCanale(r) {
  const c = String(r.channel || r.source || "").toLowerCase();
  if (/airbnb/.test(c)) return "Airbnb";
  if (/booking/.test(c)) return "Booking";
  if (/vrbo|homeaway/.test(c)) return "Vrbo";
  if (/expedia/.test(c)) return "Expedia";
  if (/direct/.test(c)) return "Diretta";
  return "ProhostAI";
}

// a quale casa di KeyFlow corrisponde un annuncio: dalla città o dal nome (es. "Canazei",
// "Falegnami"); se più case o nessuna corrispondono, lo sceglie l'host
function casaSuggerita(listing, strutture) {
  const testo = [listing.title, listing.internal_title, listing.city, listing.address].filter(Boolean).join(" ").toLowerCase();
  const trovate = (strutture || []).filter((s) => {
    const parole = [String(s.id || "").toLowerCase(), ...String(s.nome || "").toLowerCase().split(/[^a-zà-ù0-9]+/)]
      .filter((w) => w.length >= 4 && !PAROLE_GENERICHE.has(w));
    return parole.some((w) => testo.includes(w));
  });
  return trovate.length === 1 ? trovate[0].id : "";
}

function prenotazioneDaProhost(r, strutturaId, fuso) {
  const arrivo = giornoLocale(r.check_in_at, fuso), partenza = giornoLocale(r.check_out_at, fuso);
  const notti = Math.round((giornoUtc(partenza) - giornoUtc(arrivo)) / 86400000);
  if (!arrivo || !partenza || !(notti > 0 && notti <= 90)) return null;
  const fonte = fonteCanale(r);
  const codice = String(r.channel_reservation_id || "").trim();
  const ospiti = (Number(r.num_adults) || 0) + (Number(r.num_children) || 0) + (Number(r.num_infants) || 0);
  const tel = String(r.guest_phone || "").replace(/\D/g, "");
  return {
    uid: "ph-" + r.id, strutturaId, sorgente: "prohost", fonte,
    arrivo, partenza, notti, codice,
    nome: [r.guest_first_name, r.guest_last_name].filter(Boolean).join(" ").trim().replace(/\s+/g, " ").slice(0, 80),
    ospiti: ospiti > 0 && ospiti <= 30 ? ospiti : null,
    telefono4: tel.length >= 4 ? tel.slice(-4) : "",
    url: fonte === "Airbnb" && /^HM[A-Z0-9]+$/i.test(codice) ? `https://www.airbnb.it/hosting/reservations/details/${codice}` : "",
  };
}

// Legge annunci e prenotazioni confermate (dall'arrivo di 60 giorni fa in poi).
// stato = { chiave, case:{listingId: strutturaId|"-"} } → { listings, prenotazioni }
async function leggiProhost(stato, strutture, oggi = Date.now()) {
  const chiave = String((stato && stato.chiave) || "").trim();
  if (!chiave) throw new Error("manca la chiave di ProhostAI");
  const listings = await tutteLePagine(chiave, "/listings", {}, 5);
  const da = new Date(oggi - 60 * 86400000).toISOString();
  const items = await tutteLePagine(chiave, "/reservations", { status: "confirmed", start_date: da }, 10);
  const scelte = (stato && stato.case) || {};
  const annunci = listings.map((l) => {
    const suggerita = casaSuggerita(l, strutture);
    const scelta = Object.prototype.hasOwnProperty.call(scelte, l.id) ? scelte[l.id] : suggerita;
    return { id: l.id, titolo: l.internal_title || l.title || "Annuncio", citta: l.city || "", fuso: l.timezone || "", suggerita, casa: scelta || "" };
  });
  const perId = new Map(annunci.map((a) => [a.id, a]));
  const prenotazioni = [];
  for (const r of items) {
    if (r.status && String(r.status).toLowerCase() !== "confirmed") continue;
    const a = perId.get(r.listing_id);
    if (!a || !a.casa || a.casa === "-") continue;   // annuncio non abbinato a una casa (o escluso)
    const p = prenotazioneDaProhost(r, a.casa, a.fuso);
    if (p && giornoUtc(p.partenza) >= oggi - 45 * 86400000) prenotazioni.push(p);
  }
  return { annunci, prenotazioni, tutte: items.length };
}

const chiaveMascherata = (k) => { const s = String(k || ""); return s ? `${s.slice(0, 8)}…${s.slice(-4)}` : ""; };

module.exports = { leggiProhost, prenotazioneDaProhost, casaSuggerita, giornoLocale, erroreProhost, chiaveMascherata };
