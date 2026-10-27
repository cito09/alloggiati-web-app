// api/_airbnbEmail.js — nome e numero di ospiti delle prenotazioni, dalle email di Airbnb.
// Il calendario di Airbnb (.ics, vedi _calendari.js) dà solo le date e il codice della
// prenotazione (HM…). L'email "Prenotazione confermata - Nome Cognome arriverà il …" che
// Airbnb manda all'host ha invece nome, ospiti, date e LO STESSO codice: si abbinano così.
// Si leggono dalla casella Gmail già usata da KeyFlow per mandare le email (GMAIL_USER +
// GMAIL_APP_PASSWORD: la password per le app vale anche per leggere, via IMAP), solo i
// messaggi che arrivano da Airbnb, e di ognuno si tengono solo codice, nome, ospiti e date.
// Il nome inizia con "_": è un aiuto, non conta nel limite di 12 funzioni del piano Vercel.

const MESI = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
  jan: 1, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, dec: 12 };
const ATTESA_MS = 28000;
const VERSIONE_LETTURA = 4;   // 2 = si leggono anche le email di cancellazione; 3 = si ripassano le conferme vecchie per l'archivio dei link ad Airbnb; 4 = anche le modifiche (numero di ospiti)

// solo le conferme che arrivano a chi OSPITA ("Prenotazione confermata - Anna Rossi arriverà
// il …"); non quelle dei viaggi fatti come ospite ("La tua prenotazione … è confermata"),
// né richieste, pre-approvazioni o cancellazioni
function eConfermaHost(oggetto) {
  const s = String(oggetto || "");
  return /(prenotazione confermata|reservation confirmed|booking confirmed)\s*[-–—:]/i.test(s)
    && !/cancell|annull|richiesta|request|pre-?approv/i.test(s);
}

// Cancellazioni (ottobre 2026, l'utente: "se arriva una cancellazione si aggiorna in automatico il
// calendario?"). Il calendario .ics di Airbnb toglie da solo la prenotazione cancellata, ma solo
// alla lettura dopo; l'email di Airbnb arriva subito e ha lo STESSO codice HM…: appena KeyFlow la
// legge, la prenotazione sparisce dal calendario e il nome esce dall'archivio. Non contano le
// richieste di cancellazione (non ancora cancellata) né le email sulle regole di cancellazione.
function eCancellazione(oggetto) {
  const s = String(oggetto || "");
  return /cancellat|annullat|cancel+ed\b|cancel+ation/i.test(s)
    && !/richiesta|request|politic|policy|termini|terms/i.test(s);
}
function datiCancellazione({ subject, text, date }) {
  if (!eCancellazione(subject)) return null;
  const t = `${subject || ""}\n${String(text || "")}`;
  const codice = ((/(?:codice di conferma|confirmation code)\s*:?\s*([A-Z0-9]{6,14})\b/i.exec(t))
    || (/reservations\/details\/([A-Z0-9]{6,14})/i.exec(t)) || (/\b(HM[A-Z0-9]{8})\b/.exec(t)) || [])[1];
  if (!codice) return null;
  return { codice: codice.toUpperCase(), ts: date instanceof Date && !isNaN(date) ? date.getTime() : Date.now() };
}

// Modifiche della prenotazione (ottobre 2026, caso Marie-Inez: da 2 ospiti a 1, e nel calendario
// di KeyFlow restava 2). Airbnb manda DUE email: la richiesta dell'ospite "Marie-Inez vorrebbe
// modificare la sua prenotazione" con "OSPITI RICHIESTI · 1 ospite" ma SENZA il codice HM…, e,
// quando l'host accetta, "Prenotazione aggiornata" ("La tua prenotazione con Marie-Inez è stata
// aggiornata") col codice ma SENZA il numero. Si abbinano per nome in _calendari.js (aggiornaEmail).
// Se l'host rifiuta, la seconda email non arriva e non cambia niente. Le date cambiate le porta
// già il calendario .ics.
const PRIMA_FWD = "^(?:\\s*(?:fwd?|i|r|tr):\\s*)*";
function eRichiestaModifica(oggetto) {
  return /vorrebbe modificare|would like to (?:change|alter|modify)|wants to (?:change|alter|modify)/i.test(String(oggetto || ""));
}
function eModificaAccettata(oggetto) {
  return new RegExp(PRIMA_FWD + "(?:prenotazione aggiornata|reservation (?:updated|altered|changed)|booking updated)", "i").test(String(oggetto || ""));
}
// la riga sotto (o accanto) a un'etichetta: "OSPITI RICHIESTI\n\n2 adulti, 1 bambino" → 3
function ospitiDopo(t, etichetta) {
  const m = new RegExp("(?:^|\\n)\\s*(?:" + etichetta + ")\\s*:?\\s*(?:\\n\\s*)*([^\\n]+)", "i").exec(t);
  const n = m ? (m[1].match(/\d+/g) || []).reduce((a, x) => a + Number(x), 0) : 0;
  return n > 0 && n <= 30 ? n : null;
}
const tsDi = (date) => (date instanceof Date && !isNaN(date) ? date.getTime() : Date.now());
function datiRichiestaModifica({ subject, text, date }) {
  if (!eRichiestaModifica(subject)) return null;
  const nome = (new RegExp(PRIMA_FWD + "(.+?)\\s+(?:vorrebbe modificare|would like to|wants to)", "i").exec(subject || "") || [])[1];
  const t = String(text || "").replace(/\r/g, "");
  const ospiti = ospitiDopo(t, "ospiti richiesti|requested guests|new guests");
  if (!nome || !ospiti) return null;   // es. solo le date: ci pensa il calendario .ics
  return { nome: nome.trim().slice(0, 80), ospiti, prima: ospitiDopo(t, "ospiti originari|original guests"), ts: tsDi(date) };
}
function datiModificaAccettata({ subject, text, date }) {
  if (!eModificaAccettata(subject)) return null;
  const t = String(text || "").replace(/\r/g, "");
  const codice = ((/reservations\/details\/([A-Z0-9]{6,14})/i.exec(t)) || (/\b(HM[A-Z0-9]{8})\b/.exec(t)) || [])[1];
  if (!codice) return null;
  const nome = ((/prenotazione con\s+(.+?)\s+è stata aggiornata/i.exec(t)) || (/reservation with\s+(.+?)\s+(?:has been|was)\s+(?:updated|changed|altered)/i.exec(t))
    || (/reservations\/details\/[A-Z0-9]+\S*\s+([^\n[\]]{2,80})/i.exec(t)) || [])[1] || "";
  return { codice: codice.toUpperCase(), nome: nome.trim().slice(0, 80), ts: tsDi(date) };
}

const due = (n) => String(n).padStart(2, "0");
// "ven 23 ott mar 27 ott" oppure "Fri, Oct 23 Tue, Oct 27": l'anno lo deduco dalla data dell'email
function dateCheckin(riga, dataEmail) {
  const coppie = [];
  const re1 = /(\d{1,2})\s+([a-zà-ù]{3})[a-zà-ù]*\.?/gi;   // 23 ott
  const re2 = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/gi;      // Oct 23
  let m;
  while ((m = re1.exec(riga))) { const mm = MESI[m[2].toLowerCase()]; if (mm) coppie.push([+m[1], mm]); }
  if (coppie.length < 2) {
    coppie.length = 0;
    while ((m = re2.exec(riga))) { const mm = MESI[m[1].toLowerCase()]; if (mm) coppie.push([+m[2], mm]); }
  }
  if (coppie.length < 2) return null;
  const base = dataEmail instanceof Date && !isNaN(dataEmail) ? dataEmail : new Date();
  let anno = base.getUTCFullYear();
  // una prenotazione si fa prima dell'arrivo: se il mese è "prima" di quello dell'email è l'anno dopo
  if (coppie[0][1] < base.getUTCMonth() + 1) anno++;
  const annoPart = coppie[1][1] < coppie[0][1] ? anno + 1 : anno;
  return { arrivo: `${due(coppie[0][0])}/${due(coppie[0][1])}/${anno}`, partenza: `${due(coppie[1][0])}/${due(coppie[1][1])}/${annoPart}` };
}

// dal testo dell'email ai dati che servono; null se non è una conferma riconoscibile
function datiDaEmailAirbnb({ subject, text, date }) {
  if (!eConfermaHost(subject)) return null;
  const t = String(text || "").replace(/\r/g, "");
  const codice = ((/(?:codice di conferma|confirmation code)\s*:?\s*([A-Z0-9]{6,14})\b/i.exec(t))
    || (/reservations\/details\/([A-Z0-9]{6,14})/i.exec(t)) || [])[1];
  if (!codice) return null;
  let nome = ((/(?:confermata|confirmed)\s*[-–—:]\s*(.+?)\s+(?:arriverà|arriva|arrives|will arrive|is arriving)(?=[\s.,!]|$)/i.exec(subject || "")) || [])[1];
  if (!nome) nome = ((/reservations\/details\/[A-Z0-9]+\S*\s+([^\n[\]]{2,80})/i.exec(t)) || [])[1];
  const rigaOspiti = ((/(?:^|\n)\s*(?:ospiti|guests)\s*\n+\s*([^\n]+)/i.exec(t)) || [])[1] || "";
  const ospiti = (rigaOspiti.match(/\d+/g) || []).reduce((a, n) => a + Number(n), 0) || null;
  const rigaDate = ((/check-?in\s+check-?out\s*\n+\s*([^\n]+)/i.exec(t)) || [])[1] || "";
  const date_ = rigaDate ? dateCheckin(rigaDate, date) : null;
  return {
    codice: codice.toUpperCase(),
    nome: nome ? String(nome).trim().replace(/\s+/g, " ").slice(0, 80) : "",
    ospiti: ospiti && ospiti <= 30 ? ospiti : null,
    arrivo: date_ ? date_.arrivo : "", partenza: date_ ? date_.partenza : "",
    ts: date instanceof Date && !isNaN(date) ? date.getTime() : Date.now(),
  };
}

function conTempoMassimo(promessa, ms, messaggio) {
  let t;
  return Promise.race([promessa, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(messaggio)), ms); })])
    .finally(() => clearTimeout(t));
}

// Legge le conferme NUOVE dall'ultima volta da UNA casella Gmail.
// stato = { cartelle: { "<cartella>": { uidValidity, ultimoUid } } }
// Guarda in "Tutti i messaggi" (anche le email archiviate o spostate da un filtro) e nel
// Cestino (le email cancellate restano lì 30 giorni). La prima volta, 13 mesi indietro.
async function leggiConfermeAirbnb({ utente, password, stato = {}, cartelle, ImapFlow, simpleParser }) {
  ImapFlow = ImapFlow || require("imapflow").ImapFlow;
  simpleParser = simpleParser || require("mailparser").simpleParser;
  // stato salvato dalla versione di prima: una cartella sola
  const cartelleStato = { ...((stato && stato.cartelle) || {}) };
  if (stato && stato.casella && !cartelleStato[stato.casella]) cartelleStato[stato.casella] = { uidValidity: stato.uidValidity, ultimoUid: stato.ultimoUid };
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true, logger: false,
    auth: { user: utente, pass: String(password || "").replace(/\s+/g, "") },
  });
  const lavoro = (async () => {
    await client.connect();
    try {
      const caselle = (await client.list()) || [];
      const tutta = (caselle.find((c) => c.specialUse === "\\All") || {}).path || "INBOX";
      const cestino = (caselle.find((c) => c.specialUse === "\\Trash") || {}).path;
      // le cartelle (etichette) che l'host ha già in questa casella: le email vanno lì
      const etichetteGmail = etichetteUtente(caselle);
      const dest = cartelle ? destinazioni(etichetteGmail, cartelle.scelte) : null;
      const nuove = [], cancellate = [], richieste = [], modifiche = [];
      const nuovoStato = { cartelle: {}, etichette: (stato && stato.etichette) || {} };
      let lette = 0;
      let archiviate = null, erroreCartelle = null, fuoriInbox = null;
      for (const cartella of [tutta, cestino].filter(Boolean)) {
        const lock = await client.getMailboxLock(cartella);
        try {
          const st = cartelleStato[cartella] || {};
          const uidValidity = String((client.mailbox && client.mailbox.uidValidity) || "");
          // v2 = si leggono anche le cancellazioni: la prima volta si ripassano tutte le email
          const daCapo = st.uidValidity !== uidValidity || !st.ultimoUid || (st.v || 1) < VERSIONE_LETTURA;
          // da Airbnb, oppure inoltrate a mano da un'altra casella (allora il mittente è l'host,
          // ma l'oggetto resta "Fwd: Prenotazione confermata - …")
          const quali = { or: [{ from: "airbnb" }, { subject: "Prenotazione confermata" }, { subject: "Reservation confirmed" },
            { subject: "cancellat" }, { subject: "canceled" }, { subject: "cancelled" }] };
          const criteri = daCapo
            ? { ...quali, since: new Date(Date.now() - 400 * 86400000) }
            : { ...quali, uid: `${Number(st.ultimoUid) + 1}:*` };
          const minimo = daCapo ? 0 : Number(st.ultimoUid) || 0;
          const uids = ((await client.search(criteri, { uid: true })) || []).filter((u) => u > minimo);
          let ultimoUid = minimo;
          const daLeggere = [], daCancellare = [], daModifiche = [];
          if (uids.length) {
            // prima solo l'oggetto (leggero), poi il testo intero solo delle conferme e delle cancellazioni
            for await (const m of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
              ultimoUid = Math.max(ultimoUid, m.uid);
              const ogg = m.envelope && m.envelope.subject;
              if (eConfermaHost(ogg)) daLeggere.push(m.uid);
              else if (eCancellazione(ogg)) daCancellare.push(m.uid);
              else if (eRichiestaModifica(ogg) || eModificaAccettata(ogg)) daModifiche.push(m.uid);
            }
          }
          for (const uid of daCancellare.slice(-100)) {
            const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!m || !m.source) continue;
            const p = await simpleParser(m.source);
            const d = datiCancellazione({ subject: p.subject, text: p.text || "", date: p.date });
            if (d) cancellate.push(d);
          }
          for (const uid of daModifiche.slice(-100)) {
            const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!m || !m.source) continue;
            const p = await simpleParser(m.source);
            const dati = { subject: p.subject, text: p.text || "", date: p.date };
            const r = datiRichiestaModifica(dati); if (r) richieste.push(r);
            const a = datiModificaAccettata(dati); if (a) modifiche.push(a);
          }
          for (const uid of daLeggere.slice(-200)) {
            const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!m || !m.source) continue;
            const p = await simpleParser(m.source);
            const d = datiDaEmailAirbnb({ subject: p.subject, text: p.text || "", date: p.date });
            if (d) nuove.push(d);
          }
          lette += daLeggere.length;
          nuovoStato.cartelle[cartella] = { uidValidity, ultimoUid: Math.max(ultimoUid, minimo), v: VERSIONE_LETTURA };
          // cartelle di archivio: solo in "Tutti i messaggi" (il Cestino non si etichetta)
          if (cartelle && cartella === tutta) {
            try {
              const a = await archiviaInCartelle(client, nuovoStato.etichette, { ...cartelle, destinazioni: dest });
              nuovoStato.etichette = a.stato; archiviate = a.conteggi; fuoriInbox = a.fuori;
            } catch (e) { erroreCartelle = String((e && (e.responseText || e.message)) || e).slice(0, 160); }
          }
        } finally { lock.release(); }
      }
      // le email finite nelle cartelle "KeyFlow/…" create le prime volte passano nelle cartelle
      // dell'host, e le cartelle doppie si tolgono (fuori dal lock di "Tutti i messaggi")
      let spostate = [];
      if (dest && !erroreCartelle) {
        try { spostate = await traslocaCartelleKeyFlow(client, caselle.map((c) => c.path), dest); }
        catch (e) { erroreCartelle = String((e && (e.responseText || e.message)) || e).slice(0, 160); }
      }
      return { stato: nuovoStato, nuove, cancellate, richieste, modifiche, lette, archiviate, fuoriInbox, erroreCartelle, etichetteGmail, destinazioni: dest, spostate };
    } finally { await client.logout().catch(() => {}); }
  })();
  try {
    return await conTempoMassimo(lavoro, ATTESA_MS, "Gmail non ha risposto in tempo");
  } catch (e) {
    try { client.close(); } catch { /* già chiusa */ }
    throw e;
  }
}

/* ===== cartelle di archivio automatico in Gmail (etichette) =====
   Richiesta dell'utente: in ogni casella una cartella per le prenotazioni di Airbnb e una per i
   contratti degli ospiti, e in quella di Canazei anche una per i moduli ISTAT mandati all'APT.
   Ogni volta che KeyFlow legge la casella mette l'etichetta alle email nuove e le toglie da Posta
   in arrivo (spostate davvero, vedi archiviaInCartelle).
   ⚠️ Ottobre 2026, l'utente: "avevo già la cartella contratti ospiti, sia a Bologna sia a
   Canazei (e l'APT a Canazei): non farne di nuove, mettile in quelle che ci sono". Quindi si usa
   la cartella che l'host HA GIÀ (riconosciuta dal nome, es. "CONTRATTI LT", o scelta a mano nella
   pagina Calendari); "KeyFlow/…" si crea solo se in quella casella non c'è niente di adatto. */
const CARTELLE = {
  prenotazioni: "KeyFlow/Prenotazioni Airbnb",
  contratti: "KeyFlow/Contratti ospiti",
  apt: "KeyFlow/APT moduli ISTAT",
};
// come riconosco tra le cartelle dell'host quella giusta per ogni tipo: il nome deve contenere
// la parola chiave; a parità vince quella con più parole "di contorno" (es. "CONTRATTI LT" =
// locazione turistica, "Contratti ospiti")
const REGOLE_CARTELLE = {
  prenotazioni: { serve: /prenotazion/i, bonus: [/airbnb/i, /ospit/i] },
  contratti: { serve: /contratt/i, bonus: [/ospit/i, /\blt\b/i, /locaz/i, /turist/i, /check.?in/i, /airbnb/i] },
  apt: { serve: /\bapt\b|istat/i, bonus: [/\bapt\b/i, /istat/i, /modul/i] },
};
const eKeyFlow = (n) => /^keyflow(\/|$)/i.test(String(n || ""));
// le etichette create dall'host: niente cartelle di sistema ([Gmail]/…, Posta in arrivo) né quelle di KeyFlow
function etichetteUtente(caselle) {
  return (caselle || [])
    .filter((c) => c && c.path && !c.specialUse && !/^inbox$/i.test(c.path) && !/^\[(gmail|google mail)\]/i.test(c.path)
      && !((c.flags && (c.flags.has ? c.flags.has("\\Noselect") : [].concat(c.flags).includes("\\Noselect")))) && !eKeyFlow(c.path))
    .map((c) => c.path);
}
function cartellaEsistente(tipo, nomi) {
  const r = REGOLE_CARTELLE[tipo]; if (!r) return "";
  let meglio = "", punti = -1;
  for (const n of nomi || []) {
    if (eKeyFlow(n) || !r.serve.test(n)) continue;
    const p = r.bonus.filter((b) => b.test(n)).length;
    if (p > punti || (p === punti && n.length < meglio.length)) { meglio = n; punti = p; }
  }
  return meglio;
}
// dove va ogni tipo: la scelta a mano (se la cartella c'è ancora; "-" = non archiviare), sennò
// la cartella dell'host riconosciuta dal nome, sennò "KeyFlow/…"
function destinazioni(nomi, scelte) {
  const d = {};
  for (const k of Object.keys(CARTELLE)) {
    const s = String((scelte || {})[k] || "");
    d[k] = s === "-" ? "-" : (s && (nomi || []).includes(s)) ? s : (cartellaEsistente(k, nomi) || CARTELLE[k]);
  }
  return d;
}
// oggetti delle email dei contratti (copia all'host e all'ospite, nelle 12 lingue del check-in)
const OGGETTI_CONTRATTO = ["Contratto firmato", "copia del contratto", "copy of the agreement", "copie du contrat",
  "copia del contrato", "Vertragskopie", "Copia contractului", "do contrato", "kopia umowy",
  "kopie smlouvy", "kopija pogodbe", "kopija ugovora", "szerződés másolata"];
const unoOPiu = (lista) => (lista.length === 1 ? lista[0] : { or: lista });
// viaggi fatti dall'host come OSPITE: non sono prenotazioni delle case
const viaggioDaOspite = (o) => /^(?:\s*(?:fwd?|i|r|re|tr):\s*)*(la tua prenotazione|your reservation|your trip|il tuo viaggio)/i.test(String(o || ""));

// opz = { apt: indirizzo dell'APT (solo nella casella che manda i moduli), nomiCasa: [nomi delle
// case di questa casella] (per tenere solo i contratti suoi), fascicolo: true se qui arrivano i fascicoli,
// destinazioni: {tipo: cartella} (vedi destinazioni()) }
//
// Ottobre 2026, l'utente: "sposta anche quelle vecchie, fai un check generale (APT, contratti,
// prenotazioni), e voglio che si spostino davvero, non solo il flag". Quindi:
// - CONTROLLO GENERALE una volta (VERSIONE_ARCHIVIO): tutte le email della casella, senza limite
//   di date; poi solo le nuove + quelle degli ultimi 7 giorni (per spostare quelle lette dopo);
// - SPOSTATE DAVVERO: oltre all'etichetta della cartella si toglie "Posta in arrivo" (è quello che
//   fa "Sposta in" di Gmail). Le non lette restano in Posta in arrivo per 3 giorni, per non
//   perdersi una prenotazione nuova; poi escono anche loro.
// - si tocca solo ciò che KeyFlow riconosce (stesse regole di sempre): le altre email che l'host ha
//   messo nelle sue cartelle restano dove sono.
const VERSIONE_ARCHIVIO = 2;
// 21/10/2026, l'utente: "voglio che cadano direttamente in quell'etichetta" → niente più attesa
// per le non lette (prima restavano 3 giorni in Posta in arrivo). Si vedono comunque in grassetto,
// col numero accanto alla cartella.
const GIORNI_NON_LETTE = 0;
async function archiviaInCartelle(client, stato, opz) {
  const st = stato || {};
  const dest = { ...CARTELLE, ...((opz && opz.destinazioni) || {}) };
  const destPrima = { ...CARTELLE, ...(st.dest || {}) };
  const uidValidity = String((client.mailbox && client.mailbox.uidValidity) || "");
  const fino = Number(client.mailbox && client.mailbox.uidNext) - 1;
  const daCapo = st.uidValidity !== uidValidity || !st.ultimoUid || (st.versione || 1) < VERSIONE_ARCHIVIO;
  const minimo = daCapo ? 0 : Number(st.ultimoUid) || 0;
  const settimanaFa = new Date(Date.now() - 7 * 86400000);
  const limiteNonLette = Date.now() - GIORNI_NON_LETTE * 86400000;
  const gruppi = {
    prenotazioni: { or: [{ from: "airbnb", subject: "prenotazion" }, { from: "airbnb", subject: "reservation" }, { subject: "Prenotazione confermata" }] },
    contratti: unoOPiu([...OGGETTI_CONTRATTO, ...(opz.fascicolo ? ["Fascicolo KeyFlow"] : [])].map((x) => ({ subject: x }))),
  };
  // APT: i moduli mandati e anche le risposte che arrivano dall'APT
  if (opz.apt) gruppi.apt = { or: [{ to: opz.apt }, { from: opz.apt }] };
  const nomi = (opz.nomiCasa || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  const conteggi = {}, fuori = {};
  for (const [k, criteri] of Object.entries(gruppi)) {
    if (dest[k] === "-") continue;   // l'host ha scelto di non archiviare questo tipo
    // cartella cambiata (es. da "KeyFlow/Contratti ospiti" a "CONTRATTI LT"): questo tipo si rifà tutto
    const tutto = daCapo || destPrima[k] !== dest[k];
    let uids;
    if (tutto) uids = (await client.search(criteri, { uid: true })) || [];
    else {
      const nuove = (await client.search({ ...criteri, uid: `${minimo + 1}:*` }, { uid: true })) || [];
      const recenti = (await client.search({ ...criteri, since: settimanaFa }, { uid: true })) || [];
      uids = [...new Set([...nuove.filter((u) => u > minimo), ...recenti])];
    }
    if (!uids.length) continue;
    const daEtichettare = [], daSpostare = [];
    for await (const m of client.fetch(uids, { envelope: true, uid: true, flags: true, labels: true, internalDate: true }, { uid: true })) {
      const ogg = String((m.envelope && m.envelope.subject) || "");
      if (k === "prenotazioni" && viaggioDaOspite(ogg)) continue;
      // i messaggi degli ospiti ("RE: Prenotazione per Elegante Suite…") restano in Posta in arrivo:
      // sono conversazioni a cui rispondere, non avvisi da archiviare
      if (k === "prenotazioni" && /^\s*(re|r|aw|sv)\s*:/i.test(ogg)) continue;
      // un contratto di un'altra casa (es. la copia mandata all'ospite di Bologna dalla casella di Canazei)
      if (k === "contratti" && nomi.length && !/fascicolo keyflow/i.test(ogg) && !nomi.some((n) => ogg.toLowerCase().includes(n))) continue;
      const etichette = m.labels instanceof Set ? m.labels : new Set(m.labels || []);
      if (!etichette.has(dest[k])) daEtichettare.push(m.uid);
      const letta = m.flags instanceof Set ? m.flags.has("\\Seen") : [].concat(m.flags || []).includes("\\Seen");
      const quando = m.internalDate ? new Date(m.internalDate).getTime() : 0;
      if (etichette.has("\\Inbox") && (letta || (quando && quando < limiteNonLette))) daSpostare.push(m.uid);
    }
    if (daEtichettare.length) {
      // la cartella si crea solo se è quella di KeyFlow: quelle dell'host ci sono già
      if (eKeyFlow(dest[k])) { try { await client.mailboxCreate(dest[k]); } catch (e) { /* c'è già */ } }
      await client.messageFlagsAdd(daEtichettare.join(","), [dest[k]], { uid: true, useLabels: true });
      conteggi[k] = daEtichettare.length;
    }
    // "Sposta in": via da Posta in arrivo (l'etichetta della cartella c'è già, quindi le email restano lì)
    if (daSpostare.length) {
      await client.messageFlagsRemove(daSpostare.join(","), ["\\Inbox"], { uid: true, useLabels: true });
      fuori[k] = daSpostare.length;
    }
  }
  return { stato: { uidValidity, ultimoUid: fino > 0 ? Math.max(fino, minimo) : minimo, dest, versione: VERSIONE_ARCHIVIO }, conteggi, fuori };
}

/* Filtri di Gmail (21/10/2026, l'utente: "perché non le categorizza? voglio che cadano DIRETTAMENTE
   in quell'etichetta"). KeyFlow sistema la posta solo quando la legge (apertura dell'app, cron del
   mattino): per farle finire nella cartella nell'istante in cui arrivano serve un filtro di Gmail.
   Con la password per le app i filtri non si possono creare (serve l'API di Gmail con un altro
   permesso), quindi KeyFlow prepara il FILE da importare in Gmail (Impostazioni → Filtri e indirizzi
   bloccati → Importa filtri), con le stesse regole e le stesse cartelle di archiviaInCartelle. */
function filtriGmailXml({ utente, dest, mittente, apt, nomiCasa, fascicolo }) {
  const x = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
  const ora = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const filtri = [];
  const metti = (criteri, cartella) => { if (cartella && cartella !== "-") filtri.push({ ...criteri, label: cartella }); };
  const d = dest || {};
  // prenotazioni: le conferme (anche inoltrate a mano) e i promemoria/cancellazioni di Airbnb;
  // NON i messaggi degli ospiti né i viaggi fatti da ospite ("La tua prenotazione … è confermata")
  metti({ hasTheWord: 'subject:("prenotazione confermata" OR "reservation confirmed")' }, d.prenotazioni);
  metti({ from: "airbnb.com", hasTheWord: 'subject:("promemoria di prenotazione" OR "prenotazione cancellata" OR "prenotazione annullata" OR "reservation reminder" OR "reservation canceled" OR "reservation cancelled")' }, d.prenotazioni);
  // contratti firmati che KeyFlow manda a questa casella (uno per casa, così non entrano quelli delle altre)
  const case_ = (nomiCasa || []).filter(Boolean);
  if (case_.length) case_.forEach((n) => metti({ ...(mittente ? { from: mittente } : {}), hasTheWord: `subject:("contratto firmato" "${n}")` }, d.contratti));
  else metti({ ...(mittente ? { from: mittente } : {}), hasTheWord: 'subject:("contratto firmato")' }, d.contratti);
  if (fascicolo) metti({ ...(mittente ? { from: mittente } : {}), hasTheWord: 'subject:("fascicolo keyflow")' }, d.contratti);
  // APT: le risposte dell'ufficio (i moduli mandati stanno già in Posta inviata)
  if (apt) metti({ from: apt }, d.apt);
  const voce = (f, i) => `  <entry>
    <category term='filter'></category>
    <title>Mail Filter</title>
    <id>tag:mail.google.com,2008:filter:keyflow${i + 1}</id>
    <updated>${ora}</updated>
    <content></content>
${f.from ? `    <apps:property name='from' value='${x(f.from)}'/>\n` : ""}${f.hasTheWord ? `    <apps:property name='hasTheWord' value='${x(f.hasTheWord)}'/>\n` : ""}    <apps:property name='label' value='${x(f.label)}'/>
    <apps:property name='shouldArchive' value='true'/>
    <apps:property name='sizeOperator' value='s_sl'/>
    <apps:property name='sizeUnit' value='s_smb'/>
  </entry>`;
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>
  <title>Mail Filters</title>
  <id>tag:mail.google.com,2008:filters:keyflow</id>
  <updated>${ora}</updated>
  <author>
    <name>KeyFlow</name>
    <email>${x(utente || "")}</email>
  </author>
${filtri.map(voce).join("\n")}
</feed>
`;
}

const cartellaSparita = (e) => /unknown mailbox|nonexistent|doesn'?t exist|does not exist|not found/i.test(String((e && (e.responseText || e.message)) || e));
// Trasloco: le email che KeyFlow aveva messo in "KeyFlow/Contratti ospiti" (ecc.) ricevono
// l'etichetta della cartella dell'host, poi la cartella "KeyFlow/…" si cancella. Le email NON si
// cancellano mai: in Gmail togliere una cartella toglie solo l'etichetta. Si tocca solo una
// cartella di KeyFlow, e solo dopo che tutte le sue email sono già nell'altra.
async function traslocaCartelleKeyFlow(client, percorsi, dest) {
  const fatti = [];
  const esiste = new Set(percorsi || []);
  for (const [k, vecchia] of Object.entries(CARTELLE)) {
    const nuova = dest && dest[k];
    if (!esiste.has(vecchia) || !nuova || nuova === "-" || eKeyFlow(nuova) || !esiste.has(nuova)) continue;
    let uids = [];
    let lock;
    // già tolta (da un'altra lettura, o Gmail la elenca ancora per qualche istante): niente da fare
    try { lock = await client.getMailboxLock(vecchia); }
    catch (e) { if (cartellaSparita(e)) { esiste.delete(vecchia); continue; } throw e; }
    try {
      uids = (await client.search({ all: true }, { uid: true })) || [];
      if (uids.length) await client.messageFlagsAdd(uids.join(","), [nuova], { uid: true, useLabels: true });
    } finally { lock.release(); }
    try { await client.mailboxDelete(vecchia); }
    catch (e) { if (!cartellaSparita(e)) throw e; }
    esiste.delete(vecchia);
    fatti.push({ tipo: k, da: vecchia, a: nuova, email: uids.length });
  }
  // "KeyFlow" senza più niente dentro: via anche quella
  if (fatti.length && esiste.has("KeyFlow") && ![...esiste].some((p) => /^keyflow\//i.test(p))) {
    try { await client.mailboxDelete("KeyFlow"); } catch (e) { /* non c'era come cartella vera */ }
  }
  return fatti;
}

// prova che indirizzo e password per le app funzionino (prima di salvarli)
async function provaCasella({ utente, password, ImapFlow }) {
  ImapFlow = ImapFlow || require("imapflow").ImapFlow;
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, logger: false,
    auth: { user: utente, pass: String(password || "").replace(/\s+/g, "") } });
  const lavoro = (async () => { await client.connect(); await client.logout().catch(() => {}); return true; })();
  try { return await conTempoMassimo(lavoro, 15000, "Gmail non ha risposto in tempo"); }
  catch (e) { try { client.close(); } catch { /* già chiusa */ } throw e; }
}

function spiegaErroreGmail(e) {
  const s = String((e && (e.responseText || e.message)) || e || "");
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Application-specific password/i.test(s)) {
    return "Gmail non accetta indirizzo e password per le app: ricontrolla di aver copiato le 16 lettere della casella giusta, o creane una nuova";
  }
  if (/timeout|non ha risposto/i.test(s)) return "Gmail non ha risposto in tempo: riprovo alla prossima lettura";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i.test(s)) return "Gmail non è raggiungibile in questo momento";
  return s.slice(0, 160) || "errore sconosciuto";
}

module.exports = { eConfermaHost, datiDaEmailAirbnb, eCancellazione, datiCancellazione, dateCheckin, leggiConfermeAirbnb, provaCasella, spiegaErroreGmail,
  eRichiestaModifica, eModificaAccettata, datiRichiestaModifica, datiModificaAccettata,
  archiviaInCartelle, traslocaCartelleKeyFlow, destinazioni, filtriGmailXml, cartellaEsistente, etichetteUtente, CARTELLE, VERSIONE_ARCHIVIO };
