// api/_pulizie.js — promemoria delle pulizie (ottobre 2026, l'utente: "un reminder che tutti i
// giorni che c'è una pulizia mi manda un messaggio: ricordo che oggi c'è la pulizia per 5 ospiti",
// da girare al gruppo WhatsApp di chi pulisce).
// Un "utente automatico" dentro un gruppo WhatsApp non si può avere gratis e nelle regole di
// WhatsApp, quindi KeyFlow prepara il testo e lo dà all'host: con la notifica del mattino (cron di
// promemoria.js) e nella Home, col pulsante "Manda su WhatsApp" (link wa.me col testo già scritto:
// si sceglie il gruppo e si preme invia). Gratis, dal WhatsApp dell'host.
//
// Giorno di pulizia = in una casa parte qualcuno. "Per quanti" = gli ospiti del prossimo arrivo
// in quella casa (oggi stesso o più avanti): sono quelli per cui preparare letti e asciugamani.
// Nel testo niente nomi degli ospiti: a chi pulisce bastano giorni e numeri.
// Un messaggio per casa, scritto come li scrive l'host nei gruppi (ogni casa ha il suo gruppo e
// la sua persona: Betti ad Alba Loft, Claudia a Falegnami; si cambia in Impostazioni → Le case):
//  - ogni giorno di pulizia: "Buongiorno Betti ☀️ ricordo la pulizia di oggi, per 3 ospiti 🧹 Grazie! 😊"
//  - ogni lunedì il riepilogo delle pulizie delle prossime 3 settimane ("• sab 31/10 × 3 ospiti";
//    erano 2, l'utente il 27/10/2026: "pulizie mettile di 3 settimane").
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.
const { redisCmd } = require("./_kv");
const { leggiCalendari, vistaCalendari } = require("./_calendari");

// chi fa le pulizie in ogni casa (uguale a PULIZIE_PREDEFINITE in public/index.html)
const PULIZIE_PREDEFINITE = { canazei: "Betti", bologna: "Claudia" };
const GIORNI_RIEPILOGO = 21;
const SETT_BREVE = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const GIORNO = 86400000;

// "gg/mm/aaaa" → giorno in ms (UTC a mezzanotte); null se non è una data
function msDa(it) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(it || "").trim());
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}
const msDaIso = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
const isoDa = (ms) => new Date(ms).toISOString().slice(0, 10);

// solo il nome di battesimo ("SIMONE ANN" → "SIMONE", "Marie-Inez Dupont" → "Marie-Inez"): mai il cognome
const primoNome = (n) => String(n || "").trim().split(/\s+/)[0].slice(0, 30);

// a quale casa appartiene un nome o un id ("Falegnami House", "bologna", nomi vecchi che
// contengono l'id): come nomeStrutturaCanonico() del gestionale
function idCasa(nomeOId, strutture) {
  const n = String(nomeOId || "").trim().toLowerCase();
  if (!n) return "";
  const s = strutture.find((c) => String(c.id || "").toLowerCase() === n || String(c.nome || "").toLowerCase() === n)
    || strutture.find((c) => c.id && n.includes(String(c.id).toLowerCase()));
  return s ? s.id : n;
}

/* Le PERSONE di uno stesso soggiorno, senza contarne nessuna due volte (1/11/2026). Lo stesso
   gruppo può arrivare a KeyFlow in più pezzi: due check-in separati (es. due coppie con una sola
   prenotazione), "➕ Aggiungi altri ospiti" dopo l'invio, una parte già registrata e una ancora in
   attesa, l'invio ufficiale e il .txt della stessa schedina. Stessa persona = stesso numero di
   documento, oppure stesso cognome e nome (salvo due documenti diversi: allora sono due persone). */
const normTesto = (x) => String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
function contaPersone(persone) {
  const viste = [];
  for (const p of persone || []) {
    const d = normTesto(p.doc).replace(/ /g, ""), k = normTesto(p.cognome) + "|" + normTesto(p.nome);
    const haNome = k !== "|";
    const gia = viste.find((v) => (d && v.d && v.d === d) || (haNome && v.k === k && !(d && v.d && d !== v.d)));
    if (gia) { if (!gia.d && d) gia.d = d; continue; }
    viste.push({ d, k: haNome ? k : `#${viste.length}` });
  }
  return viste.length;
}
// schedina (168 caratteri): cognome 14-64, nome 64-94, numero del documento 139-159
const personeDaRecords = (recs) => recs.map((r) => ({ cognome: r.slice(14, 64), nome: r.slice(64, 94), doc: r.slice(139, 159) }));
const personeDaCheckin = (v) => (v.ospiti || []).map((o) => ({ cognome: o && o.cognome, nome: o && o.nome, doc: o && o.numeroDoc }));
const recordsValidi = (e) => (e.records || []).filter((r) => typeof r === "string" && r.length === 168);

// Quanti ospiti hanno GIÀ fatto il check-in (in attesa o registrati) per la prenotazione di una
// casa con quel giorno d'arrivo: il check-in di chi arriva dopo chiede solo i documenti che mancano.
function personeGiaFatte({ storico, pending, strutture }, casa, arrivo) {
  const arr = msDa(arrivo), c = String(casa || "").trim().toLowerCase();
  if (!arr || !c) return 0;
  const persone = [];
  for (const e of storico || []) {
    const recs = recordsValidi(e);
    if (!recs.length || String(idCasa(e.struttura, strutture)).toLowerCase() !== c) continue;
    if (msDa(e.arrivo || recs[0].slice(2, 12)) !== arr) continue;
    persone.push(...personeDaRecords(recs));
  }
  for (const v of pending || []) {
    if (!v || String(idCasa(v.strutturaId || v.strutturaNome, strutture)).toLowerCase() !== c || msDa(v.arrivo) !== arr) continue;
    persone.push(...personeDaCheckin(v));
  }
  return contaPersone(persone);
}

// tutti i soggiorni che KeyFlow conosce, casa per casa: registrati, check-in in attesa e
// prenotazioni lette dai calendari di Airbnb. Una casa non ha due soggiorni accavallati:
// se si accavallano è lo stesso, e vince il più preciso (registrato > check-in > Airbnb).
function soggiorniPerCasa({ storico, pending, esterne, strutture }) {
  const tutti = [];
  // Registrati e check-in con la stessa casa e lo stesso giorno d'arrivo sono LO STESSO soggiorno
  // (una casa non ha due arrivi nello stesso giorno): un soggiorno solo, con le persone di tutti i
  // pezzi contate una volta (vedi contaPersone). Date e nome vengono dal pezzo più preciso.
  const gruppi = new Map();
  const metti = (s, persone) => {
    if (!s.casa) return;
    const k = s.casa + "|" + s.arrivo, g = gruppi.get(k);
    if (!g) { gruppi.set(k, { s, persone: persone.slice() }); return; }
    g.persone.push(...persone);
    if (s.peso > g.s.peso) g.s = s;   // il registrato vince sul check-in
  };
  for (const e of storico || []) {
    const recs = recordsValidi(e);
    const arr = msDa(e.arrivo || (recs[0] || "").slice(2, 12));
    const notti = parseInt((recs[0] || "").slice(12, 14), 10) || 0;
    if (!arr || !notti) continue;
    // nome = solo il nome di battesimo (schedina, caratteri 64-94): serve al calendario dei collaboratori
    metti({ casa: idCasa(e.struttura, strutture), arrivo: arr, partenza: arr + notti * GIORNO, ospiti: recs.length || e.valide || null, peso: 3,
      nome: primoNome((recs[0] || "").slice(64, 94)), stato: "registrato" }, personeDaRecords(recs));
  }
  // prima i check-in "veri", poi gli ospiti aggiunti dopo ("➕ Aggiungi altri ospiti"): il nome
  // del soggiorno resta quello del titolare del primo check-in
  const pend = (pending || []).filter(Boolean).slice().sort((a, b) => (a.aggiunta ? 1 : 0) - (b.aggiunta ? 1 : 0));
  for (const v of pend) {
    const arr = msDa(v.arrivo); if (!arr) continue;
    const par = msDa(v.partenza) || (v.notti ? arr + Number(v.notti) * GIORNO : null);
    if (!par || par <= arr) continue;
    metti({ casa: idCasa(v.strutturaId || v.strutturaNome, strutture), arrivo: arr, partenza: par, ospiti: (v.ospiti || []).length || null, peso: 2,
      nome: primoNome(((v.ospiti || [])[0] || {}).nome), stato: "checkin" }, personeDaCheckin(v));
  }
  for (const g of gruppi.values()) tutti.push({ ...g.s, ospiti: contaPersone(g.persone) || g.s.ospiti || null });
  for (const p of esterne || []) {
    const arr = msDa(p.arrivo), par = msDa(p.partenza);
    if (!arr || !par || par <= arr) continue;
    // url = la prenotazione su Airbnb (serve al calendario dei collaboratori: "🔗 Apri su Airbnb")
    tutti.push({ casa: idCasa(p.strutturaId, strutture), arrivo: arr, partenza: par, ospiti: p.ospiti || null, peso: 1,
      nome: primoNome(p.nome), stato: "airbnb", fonte: p.fonte || "Airbnb",
      url: /^https?:\/\//i.test(p.url || "") ? p.url : "", fonteUrl: p.fonte || "Airbnb" });
  }
  // Una notte (o due) CHIUSA fra due ospiti non è un soggiorno (l'utente: "se c'è solo una notte
  // libera tra le due prenotazioni ed è chiusa, non contarla: metti il × ospiti di quella dopo").
  // Su Airbnb i blocchi si riconoscono e non arrivano qui, ma Booking & co. chiamano "CLOSED" sia le
  // prenotazioni sia le date chiuse: una "prenotazione" di 1-2 notti senza link, senza nome e senza
  // ospiti, attaccata a un altro soggiorno della stessa casa, è una notte chiusa. Via.
  const chiusaBreve = (x) => x.peso === 1 && !x.url && !x.nome && !x.ospiti && x.partenza - x.arrivo <= 2 * GIORNO
    && tutti.some((y) => y !== x && y.casa === x.casa && (y.partenza === x.arrivo || y.arrivo === x.partenza));
  for (let i = tutti.length - 1; i >= 0; i--) if (chiusaBreve(tutti[i])) tutti.splice(i, 1);
  const perCasa = {};
  for (const s of tutti.sort((a, b) => b.peso - a.peso)) {
    if (!s.casa) continue;
    const lista = perCasa[s.casa] || (perCasa[s.casa] = []);
    const uguale = lista.find((x) => x.arrivo < s.partenza && x.partenza > s.arrivo);
    if (!uguale) { lista.push(s); continue; }
    // lo stesso soggiorno, ma col check-in fatto si sa quanti sono anche se l'altro non lo sa.
    // Il numero della prenotazione di Airbnb (email di conferma) però non scende MAI (1/11/2026,
    // l'utente: "se uno carica solo un documento e sono di più, non deve modificarsi il messaggio
    // delle pulizie: deve prevalere quello della prenotazione di Airbnb"). Se invece al check-in
    // sono di più (un bambino aggiunto…) vale il numero più alto: letti e asciugamani per tutti.
    if (s.ospiti && (!uguale.ospiti || (s.peso === 1 && s.ospiti > uguale.ospiti))) uguale.ospiti = s.ospiti;
    if (!uguale.nome && s.nome) uguale.nome = s.nome;
    // dopo il check-in la prenotazione su Airbnb resta apribile (come nel gestionale dell'host)
    if (!uguale.url && s.url) { uguale.url = s.url; uguale.fonteUrl = s.fonteUrl; }
  }
  return perCasa;
}

// le pulizie di una casa tra due giorni (compresi): una voce per ogni giorno in cui parte qualcuno,
// con gli ospiti del prossimo arrivo (null se non si sa ancora o se non c'è nessun arrivo).
// stato = da dove viene il prossimo arrivo ("airbnb" = solo dal calendario: senza email di conferma
// letta né check-in fatto il numero non c'è ancora) → il gestionale spiega all'host perché manca.
function pulizieCasa(lista, daMs, aMs) {
  const giorni = [...new Set(lista.filter((s) => s.partenza >= daMs && s.partenza <= aMs).map((s) => s.partenza))].sort((a, b) => a - b);
  return giorni.map((g) => {
    const prossimo = lista.filter((s) => s.arrivo >= g).sort((a, b) => a.arrivo - b.arrivo)[0] || null;
    return { giorno: g, ospiti: (prossimo && prossimo.ospiti) || null, arrivo: prossimo ? prossimo.arrivo : null,
      stato: prossimo ? prossimo.stato : null, fonte: prossimo ? prossimo.fonte || "" : "" };
  });
}
function datiCasa(casa, strutture, orari) {
  const st = (strutture || []).find((c) => c.id === casa) || {};
  const o = (orari || {})[casa] || {};
  return { casa, nome: st.nome || casa, chi: String(o.chi || PULIZIE_PREDEFINITE[casa] || "").trim() };
}
const ospitiN = (n) => `${n} ospit${n === 1 ? "e" : "i"}`;
const saluto = (chi) => `Buongiorno${chi ? ` ${chi}` : ""} ☀️`;
// "Buongiorno Betti ☀️ ricordo la pulizia di oggi, per 3 ospiti 🧹 Grazie! 😊"
function testoOggi(c, p) {
  return `${saluto(c.chi)} ricordo la pulizia di oggi${p.ospiti ? `, per ${ospitiN(p.ospiti)}` : ""} 🧹 Grazie! 😊`;
}
// il riepilogo delle prossime 2 settimane, come lo scrive l'host: "• sab 31/10 × 3 ospiti"
function testoSettimane(c, voci) {
  const riga = (v) => { const d = new Date(v.giorno);
    return `• ${SETT_BREVE[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}${v.ospiti ? ` × ${ospitiN(v.ospiti)}` : ""}`; };
  return [saluto(c.chi), "Aggiorno le prossime pulizie:", "", ...voci.map(riga), "", "Grazie! 😊"].join("\n");
}
const linkWhatsApp = (testo) => `https://wa.me/?text=${encodeURIComponent(testo)}`;

// "✓ Mandato a Claudia alle 9:12" (l'utente: "dopo che clicchi su manda a Claudia ti dà confermato
// mandato, come le recensioni"): chi ha toccato "Manda"/"Copia" e quando, uguale su tutti i telefoni
// (anche per Sofia, che coordina le pulizie). KV "pulizie_mandate" = { chiave: { ts, h, da } }:
// chiave "o|aaaa-mm-gg|casa" = messaggio di oggi, "s|casa" = ultimo riepilogo delle settimane;
// h = impronta del testo mandato (se il riepilogo cambia, il gestionale dice "rimandalo"); da = nome
// del collaboratore ("" = l'host). Quelli di oggi spariscono dopo 30 giorni.
const KEY_MANDATE = "pulizie_mandate";
async function leggiMandate(conn) {
  try { const raw = await redisCmd(conn, ["GET", KEY_MANDATE]); const d = raw ? JSON.parse(raw) : {}; return d && typeof d === "object" ? d : {}; }
  catch { return {}; }
}
async function segnaMandato(conn, { chiave, h, annulla, voci } = {}, da = "", oggiIso = "") {
  const k = String(chiave || "");
  if (!/^(o\|\d{4}-\d{2}-\d{2}|s)\|[\w-]{1,40}$/.test(k)) return { ok: false, error: "Messaggio non riconosciuto" };
  const d = await leggiMandate(conn);
  if (annulla) delete d[k];
  else {
    d[k] = { ts: Date.now(), h: String(h || "").slice(0, 40), da: String(da || "").slice(0, 30) };
    // riepilogo delle settimane: si tengono anche i giorni mandati (v) e fin dove arrivava il messaggio
    // (fino), così poi si sa se è cambiato davvero qualcosa o se sono solo arrivate pulizie nuove oltre
    // le 3 settimane (8/11/2026, l'utente: "non è cambiato niente, se ne sono aggiunte perché siamo
    // andati avanti di una settimana")
    const v = vociMandate(voci);
    if (k.startsWith("s|") && v && msDaIso(oggiIso)) { d[k].v = v; d[k].fino = isoDa(msDaIso(oggiIso) + (GIORNI_RIEPILOGO - 1) * GIORNO); }
  }
  const limite = Date.now() - 30 * 864e5;
  for (const [kk, v] of Object.entries(d)) if (kk.startsWith("o|") && (!v || v.ts < limite)) delete d[kk];
  await redisCmd(conn, ["SET", KEY_MANDATE, JSON.stringify(d)]);
  return { ok: true, mandate: d };
}
// [[aaaa-mm-gg, ospiti|0], …] dal telefono, controllati
function vociMandate(voci) {
  if (!Array.isArray(voci) || voci.length > 60) return null;
  const out = [];
  for (const x of voci) {
    const g = Array.isArray(x) ? x[0] : x && x.giorno, n = Array.isArray(x) ? x[1] : x && x.ospiti;
    if (!msDaIso(g)) return null;
    out.push([g, Math.max(0, Math.min(99, parseInt(n, 10) || 0))]);
  }
  return out;
}
// la stessa impronta del gestionale (index.html → impronta): se il testo cambia, cambia
function impronta(t) { let h = 5381; t = String(t || ""); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + "." + t.length; }
const isoRoma = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
// riepiloghi mandati prima che si tenessero i giorni (solo l'impronta): si rifà il messaggio come
// sarebbe stato il giorno dell'invio, coi dati di adesso; se l'impronta è la stessa, quei giorni
// sono proprio quelli mandati e si tengono (una volta sola, poi restano salvati)
function completaMandato(rec, c, lista) {
  if (!rec || rec.v || !rec.h || !rec.ts) return false;
  const dal = msDaIso(isoRoma(rec.ts)), al = dal + (GIORNI_RIEPILOGO - 1) * GIORNO;
  const voci = pulizieCasa(lista, dal, al);
  if (!voci.length || impronta(testoSettimane(c, voci)) !== rec.h) return false;
  rec.v = voci.map((x) => [isoDa(x.giorno), x.ospiti || 0]);
  rec.fino = isoDa(al);
  return true;
}

// le pulizie di oggi e quelle delle prossime 3 settimane, casa per casa, coi messaggi pronti:
// per la Home e per le notifiche del mattino
async function pulizieProssime(conn, oggiIso) {
  let strutture = [];
  try { strutture = require("./_alloggiati").getStrutture() || []; } catch { strutture = []; }
  const leggi = async (k) => { try { const raw = await redisCmd(conn, ["GET", k]); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const [storico, pending, orari, cal, mandate] = await Promise.all([leggi("storico_schedine"), leggi("checkin_pending"), leggi("orari_case"), leggiCalendari(conn), leggiMandate(conn)]);
  const esterne = vistaCalendari(cal).prenotazioni || [];
  const perCasa = soggiorniPerCasa({ storico, pending, esterne, strutture });
  const oggiMs = msDaIso(oggiIso);
  const ordine = strutture.map((c) => c.id);
  const case_ = Object.keys(perCasa).sort((a, b) => (ordine.indexOf(a) + 1 || 99) - (ordine.indexOf(b) + 1 || 99));
  const oggi = [], settimane = [];
  let mandateCompletate = false;
  for (const casa of case_) {
    const c = datiCasa(casa, strutture, orari);
    if (completaMandato(mandate[`s|${casa}`], c, perCasa[casa])) mandateCompletate = true;
    const voci = pulizieCasa(perCasa[casa], oggiMs, oggiMs + (GIORNI_RIEPILOGO - 1) * GIORNO);
    if (!voci.length) continue;
    const vociIso = voci.map((v) => ({ giorno: isoDa(v.giorno), ospiti: v.ospiti,
      prossimo: v.arrivo ? isoDa(v.arrivo) : null, stato: v.stato, fonte: v.fonte }));
    const tS = testoSettimane(c, voci);
    settimane.push({ ...c, voci: vociIso, testo: tS, whatsapp: linkWhatsApp(tS) });
    if (voci[0].giorno === oggiMs) {
      const tO = testoOggi(c, voci[0]);
      oggi.push({ ...c, ospiti: voci[0].ospiti, prossimo: vociIso[0].prossimo, stato: vociIso[0].stato, fonte: vociIso[0].fonte, testo: tO, whatsapp: linkWhatsApp(tO) });
    }
  }
  if (mandateCompletate) { try { await redisCmd(conn, ["SET", KEY_MANDATE, JSON.stringify(mandate)]); } catch { /* resta solo in questa risposta */ } }
  return { giorno: oggiIso, lunedi: new Date(oggiMs).getUTCDay() === 1, oggi, settimane, mandate };
}

module.exports = { pulizieProssime, segnaMandato, impronta, completaMandato, soggiorniPerCasa, personeGiaFatte, contaPersone, msDa, pulizieCasa, testoOggi, testoSettimane, linkWhatsApp, idCasa, PULIZIE_PREDEFINITE };
