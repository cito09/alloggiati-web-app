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
// Nel testo niente nomi degli ospiti: a chi pulisce bastano orari e numeri.
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.
const { redisCmd } = require("./_kv");
const { leggiCalendari, vistaCalendari } = require("./_calendari");

// uguali a ORARI_PREDEFINITI in public/index.html (orari degli annunci su Airbnb)
const ORARI_PREDEFINITI = { canazei: { in: "16:00", out: "10:00" }, bologna: { in: "15:00", out: "10:00" } };
const GIORNO = 86400000;
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const SETTIMANA = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

// "gg/mm/aaaa" → giorno in ms (UTC a mezzanotte); null se non è una data
function msDa(it) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(it || "").trim());
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}
const msDaIso = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
const isoDa = (ms) => new Date(ms).toISOString().slice(0, 10);
function giornoParole(ms) {
  const d = new Date(ms);
  return `${SETTIMANA[d.getUTCDay()]} ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`;
}

// a quale casa appartiene un nome o un id ("Falegnami House", "bologna", nomi vecchi che
// contengono l'id): come nomeStrutturaCanonico() del gestionale
function idCasa(nomeOId, strutture) {
  const n = String(nomeOId || "").trim().toLowerCase();
  if (!n) return "";
  const s = strutture.find((c) => String(c.id || "").toLowerCase() === n || String(c.nome || "").toLowerCase() === n)
    || strutture.find((c) => c.id && n.includes(String(c.id).toLowerCase()));
  return s ? s.id : n;
}
function emojiCasa(id, nome) {
  const s = `${id || ""} ${nome || ""}`.toLowerCase();
  return /canazei|alba/.test(s) ? "🟢" : /bologna|falegnami/.test(s) ? "🔴" : "🔵";
}

// tutti i soggiorni che KeyFlow conosce, casa per casa: registrati, check-in in attesa e
// prenotazioni lette dai calendari di Airbnb. Una casa non ha due soggiorni accavallati:
// se si accavallano è lo stesso, e vince il più preciso (registrato > check-in > Airbnb).
function soggiorniPerCasa({ storico, pending, esterne, strutture }) {
  const tutti = [];
  for (const e of storico || []) {
    const recs = (e.records || []).filter((r) => r && r.length === 168);
    const arr = msDa(e.arrivo || (recs[0] || "").slice(2, 12));
    const notti = parseInt((recs[0] || "").slice(12, 14), 10) || 0;
    if (!arr || !notti) continue;
    tutti.push({ casa: idCasa(e.struttura, strutture), arrivo: arr, partenza: arr + notti * GIORNO, ospiti: recs.length || e.valide || null, peso: 3 });
  }
  for (const v of pending || []) {
    const arr = msDa(v.arrivo); if (!arr) continue;
    const par = msDa(v.partenza) || (v.notti ? arr + Number(v.notti) * GIORNO : null);
    if (!par || par <= arr) continue;
    tutti.push({ casa: idCasa(v.strutturaId || v.strutturaNome, strutture), arrivo: arr, partenza: par, ospiti: (v.ospiti || []).length || null, peso: 2 });
  }
  for (const p of esterne || []) {
    const arr = msDa(p.arrivo), par = msDa(p.partenza);
    if (!arr || !par || par <= arr) continue;
    tutti.push({ casa: idCasa(p.strutturaId, strutture), arrivo: arr, partenza: par, ospiti: p.ospiti || null, peso: 1 });
  }
  const perCasa = {};
  for (const s of tutti.sort((a, b) => b.peso - a.peso)) {
    if (!s.casa) continue;
    const lista = perCasa[s.casa] || (perCasa[s.casa] = []);
    const uguale = lista.find((x) => x.arrivo < s.partenza && x.partenza > s.arrivo);
    if (!uguale) { lista.push(s); continue; }
    // lo stesso soggiorno, ma col check-in fatto si sa quanti sono anche se l'altro non lo sa
    if (!uguale.ospiti && s.ospiti) uguale.ospiti = s.ospiti;
  }
  return perCasa;
}

// le pulizie di un giorno: una voce per casa in cui parte qualcuno
function pulizieDelGiorno(perCasa, giornoMs, strutture, orari) {
  const out = [];
  const ordine = (strutture || []).map((c) => c.id);
  const case_ = Object.keys(perCasa).sort((a, b) => (ordine.indexOf(a) + 1 || 99) - (ordine.indexOf(b) + 1 || 99));
  for (const casa of case_) {
    const lista = perCasa[casa];
    const partono = lista.filter((s) => s.partenza === giornoMs);
    if (!partono.length) continue;
    const prossimo = lista.filter((s) => s.arrivo >= giornoMs).sort((a, b) => a.arrivo - b.arrivo)[0] || null;
    const st = (strutture || []).find((c) => c.id === casa) || {};
    const o = { ...(ORARI_PREDEFINITI[casa] || {}), ...((orari || {})[casa] || {}) };
    const escono = partono.every((s) => s.ospiti) ? partono.reduce((a, s) => a + s.ospiti, 0) : null;
    out.push({ casa, nome: st.nome || casa, escono, uscita: o.out || "",
      arrivo: prossimo ? { giorno: isoDa(prossimo.arrivo), oggi: prossimo.arrivo === giornoMs, ospiti: prossimo.ospiti || null, ora: o.in || "" } : null });
  }
  return out;
}

const ospitiN = (n) => `${n} ospit${n === 1 ? "e" : "i"}`;
// il messaggio per il gruppo di chi pulisce
function testoPulizie(giornoIso, pulizie, { oggi = true } = {}) {
  if (!pulizie.length) return "";
  const ms = msDaIso(giornoIso);
  const righe = pulizie.map((p) => {
    const esce = `${p.escono ? `escono ${ospitiN(p.escono)}` : "escono gli ospiti"}${p.uscita ? ` entro le ${p.uscita}` : ""}`;
    let dopo;
    if (!p.arrivo) dopo = "Nessun nuovo arrivo in calendario.";
    else {
      const quando = p.arrivo.oggi ? `${p.arrivo.ora ? `Alle ${p.arrivo.ora}` : "Oggi"}` : `Prossimo arrivo ${giornoParole(msDaIso(p.arrivo.giorno))}${p.arrivo.ora ? ` alle ${p.arrivo.ora}` : ""}`;
      dopo = p.arrivo.ospiti
        ? `${quando} ${p.arrivo.oggi ? "arrivano" : "con"} ${ospitiN(p.arrivo.ospiti)} → preparare per ${p.arrivo.ospiti}.`
        : `${quando} ${p.arrivo.oggi ? "arrivano nuovi ospiti" : ""} (numero di ospiti non ancora noto).`.replace(/\s+\(/, " (");
    }
    return `${emojiCasa(p.casa, p.nome)} *${p.nome}*: ${esce}. ${dopo}`;
  });
  return [`🧹 ${oggi ? "Pulizie di oggi" : "Pulizie di domani"}, ${giornoParole(ms)}`, "", ...righe].join("\n");
}
const linkWhatsApp = (testo) => `https://wa.me/?text=${encodeURIComponent(testo)}`;

// le pulizie di oggi e di domani, con il testo pronto: per la Home e per la notifica del mattino
async function pulizieProssime(conn, oggiIso) {
  let strutture = [];
  try { strutture = require("./_alloggiati").getStrutture() || []; } catch { strutture = []; }
  const leggi = async (k) => { try { const raw = await redisCmd(conn, ["GET", k]); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const [storico, pending, orari, cal] = await Promise.all([leggi("storico_schedine"), leggi("checkin_pending"), leggi("orari_case"), leggiCalendari(conn)]);
  const esterne = vistaCalendari(cal).prenotazioni || [];
  const perCasa = soggiorniPerCasa({ storico, pending, esterne, strutture });
  const oggiMs = msDaIso(oggiIso);
  return [0, 1].map((d) => {
    const giorno = isoDa(oggiMs + d * GIORNO);
    const pulizie = pulizieDelGiorno(perCasa, oggiMs + d * GIORNO, strutture, orari || {});
    const testo = testoPulizie(giorno, pulizie, { oggi: d === 0 });
    return { giorno, quando: d === 0 ? "oggi" : "domani", pulizie, testo, whatsapp: testo ? linkWhatsApp(testo) : "" };
  }).filter((g) => g.pulizie.length);
}

module.exports = { pulizieProssime, soggiorniPerCasa, pulizieDelGiorno, testoPulizie, linkWhatsApp, idCasa, ORARI_PREDEFINITI };
