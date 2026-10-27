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
//  - ogni lunedì il riepilogo delle pulizie delle prossime 2 settimane ("• sab 31/10 × 3 ospiti").
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.
const { redisCmd } = require("./_kv");
const { leggiCalendari, vistaCalendari } = require("./_calendari");

// chi fa le pulizie in ogni casa (uguale a PULIZIE_PREDEFINITE in public/index.html)
const PULIZIE_PREDEFINITE = { canazei: "Betti", bologna: "Claudia" };
const GIORNI_RIEPILOGO = 14;
const SETT_BREVE = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const GIORNO = 86400000;

// "gg/mm/aaaa" → giorno in ms (UTC a mezzanotte); null se non è una data
function msDa(it) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(it || "").trim());
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}
const msDaIso = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
const isoDa = (ms) => new Date(ms).toISOString().slice(0, 10);

// a quale casa appartiene un nome o un id ("Falegnami House", "bologna", nomi vecchi che
// contengono l'id): come nomeStrutturaCanonico() del gestionale
function idCasa(nomeOId, strutture) {
  const n = String(nomeOId || "").trim().toLowerCase();
  if (!n) return "";
  const s = strutture.find((c) => String(c.id || "").toLowerCase() === n || String(c.nome || "").toLowerCase() === n)
    || strutture.find((c) => c.id && n.includes(String(c.id).toLowerCase()));
  return s ? s.id : n;
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

// le pulizie di una casa tra due giorni (compresi): una voce per ogni giorno in cui parte qualcuno,
// con gli ospiti del prossimo arrivo (null se non si sa ancora o se non c'è nessun arrivo)
function pulizieCasa(lista, daMs, aMs) {
  const giorni = [...new Set(lista.filter((s) => s.partenza >= daMs && s.partenza <= aMs).map((s) => s.partenza))].sort((a, b) => a - b);
  return giorni.map((g) => {
    const prossimo = lista.filter((s) => s.arrivo >= g).sort((a, b) => a.arrivo - b.arrivo)[0] || null;
    return { giorno: g, ospiti: (prossimo && prossimo.ospiti) || null, arrivo: prossimo ? prossimo.arrivo : null };
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

// le pulizie di oggi e quelle delle prossime 2 settimane, casa per casa, coi messaggi pronti:
// per la Home e per le notifiche del mattino
async function pulizieProssime(conn, oggiIso) {
  let strutture = [];
  try { strutture = require("./_alloggiati").getStrutture() || []; } catch { strutture = []; }
  const leggi = async (k) => { try { const raw = await redisCmd(conn, ["GET", k]); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const [storico, pending, orari, cal] = await Promise.all([leggi("storico_schedine"), leggi("checkin_pending"), leggi("orari_case"), leggiCalendari(conn)]);
  const esterne = vistaCalendari(cal).prenotazioni || [];
  const perCasa = soggiorniPerCasa({ storico, pending, esterne, strutture });
  const oggiMs = msDaIso(oggiIso);
  const ordine = strutture.map((c) => c.id);
  const case_ = Object.keys(perCasa).sort((a, b) => (ordine.indexOf(a) + 1 || 99) - (ordine.indexOf(b) + 1 || 99));
  const oggi = [], settimane = [];
  for (const casa of case_) {
    const c = datiCasa(casa, strutture, orari);
    const voci = pulizieCasa(perCasa[casa], oggiMs, oggiMs + (GIORNI_RIEPILOGO - 1) * GIORNO);
    if (!voci.length) continue;
    const vociIso = voci.map((v) => ({ giorno: isoDa(v.giorno), ospiti: v.ospiti }));
    const tS = testoSettimane(c, voci);
    settimane.push({ ...c, voci: vociIso, testo: tS, whatsapp: linkWhatsApp(tS) });
    if (voci[0].giorno === oggiMs) {
      const tO = testoOggi(c, voci[0]);
      oggi.push({ ...c, ospiti: voci[0].ospiti, testo: tO, whatsapp: linkWhatsApp(tO) });
    }
  }
  return { giorno: oggiIso, lunedi: new Date(oggiMs).getUTCDay() === 1, oggi, settimane };
}

module.exports = { pulizieProssime, soggiorniPerCasa, pulizieCasa, testoOggi, testoSettimane, linkWhatsApp, idCasa, PULIZIE_PREDEFINITE };
