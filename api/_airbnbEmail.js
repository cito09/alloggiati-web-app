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

// solo le conferme che arrivano a chi OSPITA ("Prenotazione confermata - Anna Rossi arriverà
// il …"); non quelle dei viaggi fatti come ospite ("La tua prenotazione … è confermata"),
// né richieste, pre-approvazioni o cancellazioni
function eConfermaHost(oggetto) {
  const s = String(oggetto || "");
  return /(prenotazione confermata|reservation confirmed|booking confirmed)\s*[-–—:]/i.test(s)
    && !/cancell|annull|richiesta|request|pre-?approv/i.test(s);
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
async function leggiConfermeAirbnb({ utente, password, stato = {}, ImapFlow, simpleParser }) {
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
      const nuove = [];
      const nuovoStato = { cartelle: {} };
      let lette = 0;
      for (const cartella of [tutta, cestino].filter(Boolean)) {
        const lock = await client.getMailboxLock(cartella);
        try {
          const st = cartelleStato[cartella] || {};
          const uidValidity = String((client.mailbox && client.mailbox.uidValidity) || "");
          const daCapo = st.uidValidity !== uidValidity || !st.ultimoUid;
          // da Airbnb, oppure inoltrate a mano da un'altra casella (allora il mittente è l'host,
          // ma l'oggetto resta "Fwd: Prenotazione confermata - …")
          const quali = { or: [{ from: "airbnb" }, { subject: "Prenotazione confermata" }, { subject: "Reservation confirmed" }] };
          const criteri = daCapo
            ? { ...quali, since: new Date(Date.now() - 400 * 86400000) }
            : { ...quali, uid: `${Number(st.ultimoUid) + 1}:*` };
          const minimo = daCapo ? 0 : Number(st.ultimoUid) || 0;
          const uids = ((await client.search(criteri, { uid: true })) || []).filter((u) => u > minimo);
          let ultimoUid = minimo;
          const daLeggere = [];
          if (uids.length) {
            // prima solo l'oggetto (leggero), poi il testo intero solo delle conferme
            for await (const m of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
              ultimoUid = Math.max(ultimoUid, m.uid);
              if (eConfermaHost(m.envelope && m.envelope.subject)) daLeggere.push(m.uid);
            }
          }
          for (const uid of daLeggere.slice(-200)) {
            const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!m || !m.source) continue;
            const p = await simpleParser(m.source);
            const d = datiDaEmailAirbnb({ subject: p.subject, text: p.text || "", date: p.date });
            if (d) nuove.push(d);
          }
          lette += daLeggere.length;
          nuovoStato.cartelle[cartella] = { uidValidity, ultimoUid: Math.max(ultimoUid, minimo) };
        } finally { lock.release(); }
      }
      return { stato: nuovoStato, nuove, lette };
    } finally { await client.logout().catch(() => {}); }
  })();
  try {
    return await conTempoMassimo(lavoro, ATTESA_MS, "Gmail non ha risposto in tempo");
  } catch (e) {
    try { client.close(); } catch { /* già chiusa */ }
    throw e;
  }
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

module.exports = { eConfermaHost, datiDaEmailAirbnb, dateCheckin, leggiConfermeAirbnb, provaCasella, spiegaErroreGmail };
