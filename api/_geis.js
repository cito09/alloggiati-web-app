// api/_geis.js — imposta di soggiorno del Comune di Bologna (portale GEIS).
// Calcola da solo la comunicazione TRIMESTRALE partendo dalle schedine già registrate
// in KeyFlow (storico_schedine): niente CSV da caricare, i dati ci sono già.
//
// Regole seguite (FAQ del Comune di Bologna, email 03/10/2024):
// · soggetti      = numero di ospiti, TUTTI (adulti + bambini + neonati) — sez. D.4
// · pernottamenti = notti occupate dall'appartamento (non notti·persona)
// · soggiorno a cavallo di due mesi = tutto nel mese di CHECK-OUT — sez. D.5
// · la comunicazione è TRIMESTRALE e i trimestri sono quelli dell'anno solare:
//     1° gennaio-febbraio-marzo   -> scade il 15 aprile
//     2° aprile-maggio-giugno     -> scade il 15 luglio      (NON comprende luglio!)
//     3° luglio-agosto-settembre  -> scade il 15 ottobre
//     4° ottobre-novembre-dicembre-> scade il 15 gennaio dell'anno dopo
//   Va mandata anche se non c'è stato nessun ospite (si dichiara zero).
//
// Tutte le date sono trattate in UTC "puro" (solo anno/mese/giorno): niente sorprese
// con l'ora legale. L'oggi è calcolato sul fuso italiano.

const MESI = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
const GIORNO = 86400000;

// Solo Bologna paga l'imposta di soggiorno: riconosco la struttura dal nome/id,
// come già fanno le notifiche push (emojiStruttura).
const RE_GEIS = /bologna|falegnami/i;
function eStrutturaGeis(nome, id) {
  return RE_GEIS.test(`${id || ""} ${nome || ""}`);
}

function msDaDataIt(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}
function dataItDaMs(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function chiaveMese(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function isoData(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function giornoIt(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MESI[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// oggi in Italia, ridotto a mezzanotte
function oggiRoma() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day);
}

// --- trimestri ---
function trimestreDiMs(ms) {
  const d = new Date(ms);
  return { anno: d.getUTCFullYear(), q: Math.floor(d.getUTCMonth() / 3) + 1 };
}
function mesiTrimestre(anno, q) {
  return [0, 1, 2].map((i) => ({ key: `${anno}-${String((q - 1) * 3 + 1 + i).padStart(2, "0")}`, nome: MESI[(q - 1) * 3 + i] }));
}
function fineTrimestre(anno, q) { return Date.UTC(anno, q * 3, 0); }          // ultimo giorno del trimestre
function scadenzaTrimestre(anno, q) { return q === 4 ? Date.UTC(anno + 1, 0, 15) : Date.UTC(anno, q * 3, 15); }
function trimestrePrecedente(anno, q) { return q === 1 ? { anno: anno - 1, q: 4 } : { anno, q: q - 1 }; }
function chiaveTrimestre(anno, q) { return `${anno}-${q}`; }
function titoloTrimestre(anno, q) { return `${q}° trimestre ${anno}`; }

// --- soggiorni registrati in KeyFlow ---
// Dallo storico prendo solo la struttura di Bologna e ricavo arrivo, notti e numero di
// ospiti dalle schedine (formato Alloggiati Web: 168 caratteri, arrivo 3-12, notti 13-14).
// Lo stesso soggiorno può comparire due volte (prima il .txt scaricato, poi l'invio
// ufficiale): tengo una sola voce per arrivo+titolare, preferendo quella inviata.
function soggiorniDaStorico(storico) {
  const perChiave = new Map();
  let senzaDati = 0;
  (Array.isArray(storico) ? storico : []).forEach((e) => {
    if (!e || !eStrutturaGeis(e.struttura)) return;
    const rec = (e.records || [])[0];
    const valida = rec && String(rec).length === 168;
    const arrivoMs = msDaDataIt(e.arrivo) || (valida ? msDaDataIt(String(rec).slice(2, 12).trim()) : null);
    const notti = valida ? parseInt(String(rec).slice(12, 14), 10) || 0 : 0;
    const ospiti = (e.records || []).length || (e.ospiti || []).length || parseInt(e.valide, 10) || 0;
    if (!arrivoMs || !notti || !ospiti) { senzaDati++; return; }
    const titolare = String((e.ospiti || [])[0] || "").trim();
    const arrivo = dataItDaMs(arrivoMs);
    const chiave = titolare ? `${arrivo}|${titolare.toUpperCase()}` : `${arrivo}|#${e.ts || 0}`;
    const uscitaMs = arrivoMs + notti * GIORNO;
    const voce = {
      chiave, arrivo, notti, ospiti, titolare,
      uscita: dataItDaMs(uscitaMs),
      mese: chiaveMese(uscitaMs),           // il mese che conta è quello di check-out
      struttura: e.struttura || "",
      ts: e.ts || 0,
      inviata: e.tipo === "inviata",
    };
    const prec = perChiave.get(chiave);
    if (!prec || meglio(voce, prec)) perChiave.set(chiave, voce);
  });
  const soggiorni = [...perChiave.values()].sort((a, b) => msDaDataIt(a.arrivo) - msDaDataIt(b.arrivo));
  return { soggiorni, senzaDati };
}
function meglio(a, b) {
  if (a.inviata !== b.inviata) return a.inviata;      // l'invio ufficiale vince sul .txt
  if (a.ospiti !== b.ospiti) return a.ospiti > b.ospiti; // in caso di correzione tengo la versione completa
  return a.ts > b.ts;
}

// --- dati di un trimestre ---
// esclusi = soggiorni che l'utente ha tolto a mano dal conteggio (es. prenotazione non
// arrivata da Airbnb, per cui l'imposta la versa lui e non va nella nota).
function datiTrimestre(soggiorni, anno, q, esclusi) {
  const mesi = mesiTrimestre(anno, q).map((m) => ({ ...m, sogg: 0, notti: 0 }));
  const dentro = [];
  (soggiorni || []).forEach((s) => {
    const m = mesi.find((x) => x.key === s.mese);
    if (!m) return;
    const escluso = !!(esclusi && esclusi[s.chiave]);
    dentro.push({ ...s, escluso });
    if (escluso) return;
    m.sogg += s.ospiti;
    m.notti += s.notti;
  });
  return {
    mesi,
    sogg: mesi.reduce((a, m) => a + m.sogg, 0),
    notti: mesi.reduce((a, m) => a + m.notti, 0),
    soggiorni: dentro,
  };
}

// Testo pronto per il campo "Note" del GEIS, nel formato chiesto dal Comune:
// "AIRBNB: aprile 12 soggetti/8 pernottamenti - maggio 6 soggetti/4 pernottamenti - ..."
function notaTesto(mesi) {
  const usati = (mesi || []).filter((m) => m.attivo !== false);
  if (!usati.length) return "AIRBNB:";
  return "AIRBNB: " + usati.map((m) => `${m.nome} ${m.sogg || 0} soggetti/${m.notti || 0} pernottamenti`).join(" - ");
}

// stato di un trimestre rispetto a oggi e a quello che è già stato mandato
function statoTrimestre(anno, q, inviati, oggiMs) {
  const fine = fineTrimestre(anno, q);
  const scadenza = scadenzaTrimestre(anno, q);
  const fatto = !!(inviati && inviati[chiaveTrimestre(anno, q)]);
  let stato = "da-fare";
  if (fatto) stato = "fatto";
  else if (oggiMs <= fine) stato = "in-corso";
  else if (oggiMs <= scadenza) stato = "da-fare";
  else stato = "in-ritardo";
  return {
    stato,
    fine: isoData(fine),
    scadenza: isoData(scadenza),
    scadenzaIt: giornoIt(scadenza),
    giorni: Math.round((scadenza - oggiMs) / GIORNO),   // >0 mancano, <0 in ritardo
    inviatoIl: fatto ? inviati[chiaveTrimestre(anno, q)].ts || 0 : 0,
  };
}

// Elenco dei trimestri da mostrare nel gestionale: quello in corso e i precedenti.
function elencoTrimestri(storico, stato, opzioni) {
  const quanti = (opzioni && opzioni.quanti) || 6;
  const oggiMs = (opzioni && opzioni.oggi) || oggiRoma();
  const inviati = (stato && stato.inviati) || {};
  const esclusi = (stato && stato.esclusi) || {};
  const { soggiorni, senzaDati } = soggiorniDaStorico(storico);
  // prima di questa data KeyFlow non registrava ancora niente: quei trimestri li mostro
  // ma non li conto come "da fare" (i dati non ci sono, non è che non c'era nessuno).
  const primo = soggiorni.length ? Math.min(...soggiorni.map((s) => msDaDataIt(s.arrivo))) : null;
  let cur = trimestreDiMs(oggiMs);
  const out = [];
  for (let i = 0; i < quanti; i++) {
    const dati = datiTrimestre(soggiorni, cur.anno, cur.q, esclusi);
    const st = statoTrimestre(cur.anno, cur.q, inviati, oggiMs);
    if (st.stato !== "fatto" && !dati.soggiorni.length && (primo === null || fineTrimestre(cur.anno, cur.q) < primo)) {
      st.stato = "senza-dati";
    }
    out.push({
      chiave: chiaveTrimestre(cur.anno, cur.q),
      anno: cur.anno, q: cur.q,
      titolo: titoloTrimestre(cur.anno, cur.q),
      mesiNomi: dati.mesi.map((m) => m.nome).join(", "),
      ...dati, ...st,
      nota: notaTesto(dati.mesi),
    });
    cur = trimestrePrecedente(cur.anno, cur.q);
  }
  // via i trimestri più vecchi di quando KeyFlow ha cominciato a registrare: sarebbero
  // solo righe vuote (ne tengo comunque quattro, per non lasciare la pagina spoglia)
  while (out.length > 4 && out[out.length - 1].stato === "senza-dati") out.pop();
  return { trimestri: out, senzaDati, oggi: isoData(oggiMs) };
}

// Avvisi da mandare col promemoria giornaliero (ntfy). Ne esce al massimo uno per
// trimestre: si comincia 14 giorni prima della scadenza e si insiste finché non è fatta.
function avvisiGeis(storico, stato, oggiMs) {
  const oggi = oggiMs || oggiRoma();
  const { trimestri } = elencoTrimestri(storico, stato, { quanti: 5, oggi });
  const avvisi = [];
  trimestri.forEach((t) => {
    if (t.stato === "fatto" || t.stato === "in-corso" || t.stato === "senza-dati") return;
    if (t.giorni < -120) return;                       // troppo vecchio: non insisto più
    const mancano = t.giorni;
    if (mancano >= 0) {
      // prima della scadenza: 14, 7, 3, 1 giorni prima e il giorno stesso
      if (![14, 7, 3, 1, 0].includes(mancano)) return;
      const quando = mancano === 0 ? "SCADE OGGI" : `manca${mancano === 1 ? "" : "no"} ${mancano} giorn${mancano === 1 ? "o" : "i"}`;
      avvisi.push(`🔴 Imposta di soggiorno Bologna (GEIS) — ${t.titolo} (${t.mesiNomi}): da comunicare entro il ${t.scadenzaIt}, ${quando}.\n${t.nota}\nQuando l'hai mandata, segnalo in KeyFlow: Impostazioni → GEIS.`);
    } else {
      // in ritardo: ogni giorno per una settimana, poi una volta a settimana
      const ritardo = -mancano;
      if (ritardo > 7 && ritardo % 7 !== 0) return;
      avvisi.push(`⚠️ 🔴 Imposta di soggiorno Bologna (GEIS) — ${t.titolo} (${t.mesiNomi}) NON ancora comunicato: era da mandare entro il ${t.scadenzaIt} (${ritardo} giorn${ritardo === 1 ? "o" : "i"} di ritardo).\n${t.nota}`);
    }
  });
  return avvisi;
}

module.exports = {
  MESI, GIORNO, eStrutturaGeis, oggiRoma, msDaDataIt, dataItDaMs, isoData, giornoIt,
  trimestreDiMs, mesiTrimestre, fineTrimestre, scadenzaTrimestre, trimestrePrecedente,
  chiaveTrimestre, titoloTrimestre, soggiorniDaStorico, datiTrimestre, notaTesto,
  statoTrimestre, elencoTrimestri, avvisiGeis,
};
