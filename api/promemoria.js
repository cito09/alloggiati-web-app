// api/promemoria.js — due funzioni in un solo file (per restare sotto il limite di
// funzioni serverless del piano Vercel):
//
// GET  → promemoria automatici via ntfy, chiamato una volta al giorno dal cron di Vercel
//        (vercel.json → crons, ore 08:00 UTC ≈ 9/10 di mattina in Italia). Avvisa se:
//        1) è il giorno di arrivo (o un giorno successivo) di una prenotazione NON ancora
//           registrata in Questura — con pallino colorato per struttura (🟢 Canazei/Alba,
//           🔴 Bologna/Falegnami); si ripete ogni giorno finché non viene registrata
//        3) è il giorno 3 del mese e c'è almeno una struttura Ross1000 (file da caricare entro il 5)
//        Se NTFY_TOPIC non è configurato non fa nulla. Con CRON_SECRET impostato, accetta
//        solo le chiamate del cron di Vercel (header Authorization: Bearer <segreto>).
//
// POST → usata dal gestionale per tenere aggiornato l'elenco delle prenotazioni "in corso,
//        non ancora inviate" (server-side, così il promemoria funziona anche se il browser
//        è chiuso). Richiede il login admin.
//        { lista: [{id, arrivo, strutturaNome, ospiti:[nomi]}, ...] } -> sostituisce l'intero
//        elenco con quello mandato dal gestionale (il gestionale manda sempre lo stato
//        attuale completo: quello che non è più nella lista sparisce anche da qui, es.
//        perché è stata inviata ufficialmente o svuotata).
const { upstash, redisCmd } = require("./_kv");
const { checkAdmin } = require("./_admin");
const { inviaEmailConAllegato } = require("./_email");
const { costruisciModuloIstat, nomeFileIstat, dataIt } = require("./_istat");

const KEY_PENDENTI = "bookings_pending";
const KEY_ISTAT = "istat_config";
const MAX_PENDENTI = 200;

// FASCICOLO MENSILE: zip con registro CSV + contratti firmati del mese (per arrivo).
// Parte da solo il giorno 1 (mese precedente) e a richiesta dal gestionale
// (POST { azione:'fascicolo', mese:'aaaa-mm' }).
const MESI_IT = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
async function costruisciFascicolo(conn, meseKey) {
  const raw = await redisCmd(conn, ["GET", "storico_schedine"]);
  const storico = raw ? JSON.parse(raw) : [];
  const del = storico.filter((e) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(e.arrivo || "");
    return m && `${m[3]}-${m[2]}` === meseKey;
  });
  if (!del.length) return null;
  const JSZip = require("jszip");
  const zip = new JSZip();
  const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const righe = [["Data registrazione","Tipo","Struttura","Arrivo","Schedine","Ospiti","Ross1000"].map(cell).join(";")];
  del.forEach((e) => righe.push([
    new Date(e.ts).toLocaleString("it-IT", { timeZone: "Europe/Rome" }),
    e.tipo === "inviata" ? "Inviata in Questura" : "File TXT scaricato",
    e.struttura || "", e.arrivo || "", e.valide || 0, (e.ospiti || []).join(", "), e.rossOk ? "sì" : "",
  ].map(cell).join(";")));
  zip.file(`registro_${meseKey}.csv`, "﻿" + righe.join("\r\n"));
  let contratti = 0, byte = 0;
  for (const e of del) {
    for (const url of e.contratti || []) {
      try {
        const got = await require("./_blob").leggiBlob(url);
        if (!got) continue;
        const buf = got.buffer;
        byte += buf.length;
        if (byte > 15 * 1024 * 1024) break; // limite prudente per l'allegato email
        const nome = decodeURIComponent((url.split("/").pop() || "contratto.pdf").split("?")[0]);
        zip.file("contratti/" + nome, buf);
        contratti++;
      } catch (err) { /* un contratto non scaricato non blocca il fascicolo */ }
    }
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, soggiorni: del.length, contratti };
}
async function inviaFascicolo(conn, meseKey) {
  const dest = process.env.FASCICOLO_EMAIL || process.env.GMAIL_USER;
  if (!dest) return { ok: false, error: "Nessuna email configurata (GMAIL_USER)" };
  const f = await costruisciFascicolo(conn, meseKey);
  if (!f) return { ok: false, error: `Nessun soggiorno con arrivo in ${meseKey}` };
  const [aaaa, mm] = meseKey.split("-");
  const nomeMese = `${MESI_IT[+mm - 1]} ${aaaa}`;
  const esito = await inviaEmailConAllegato({
    to: dest,
    subject: `📦 Fascicolo KeyFlow · ${nomeMese}`,
    testo: `In allegato il fascicolo di ${nomeMese}: registro delle schedine (${f.soggiorni} soggiorn${f.soggiorni === 1 ? "o" : "i"}) e ${f.contratti} contratt${f.contratti === 1 ? "o" : "i"} firmati.\n\nGenerato automaticamente da KeyFlow.`,
    allegatoNome: `fascicolo_keyflow_${meseKey}.zip`,
    allegatoBuffer: f.buffer,
  });
  return esito.ok ? { ok: true, soggiorni: f.soggiorni, contratti: f.contratti } : esito;
}

// scadenza semplificata: il giorno DOPO l'arrivo, a fine giornata (ora italiana) —
// coerente con l'obbligo di comunicazione entro 24 ore, con un margine pratico.
function scadenzaDaArrivo(arrivoStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(arrivoStr || "");
  if (!m) return null;
  const arrivo = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return new Date(arrivo.getTime() + 2 * 86400000 - 1000); // arrivo + 2 giorni - 1s
}

// pallino colorato per distinguere la struttura nelle notifiche:
// 🟢 Alba Loft House (Canazei) · 🔴 Falegnami House (Bologna) · 🔵 altre
function emojiStruttura(nome, id) {
  const s = (String(id || "") + " " + String(nome || "")).toLowerCase();
  if (/canazei|alba/.test(s)) return "🟢";
  if (/bologna|falegnami/.test(s)) return "🔴";
  return "🔵";
}
// giorni tra l'arrivo (GG/MM/AAAA) e oggi in fuso Italia: 0 = oggi, >0 = già passato, <0 = futuro, null = data non valida
function giorniDaArrivoOggi(arrivoStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(arrivoStr || "");
  if (!m) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const oggi = Date.UTC(+p.year, +p.month - 1, +p.day);
  const arr = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return Math.round((oggi - arr) / 86400000);
}

// --- comunicazione ISTAT (presenze turistiche negli alloggi privati) ---
async function leggiConfigIstat(conn) {
  if (!conn) return null;
  try {
    const raw = await redisCmd(conn, ["GET", KEY_ISTAT]);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
// Compila il modulo ufficiale e lo manda all'ufficio del turismo. Non parte nulla finché
// l'utente non ha scritto l'indirizzo e acceso la struttura nelle Impostazioni.
async function inviaModuloIstat(conn, dati) {
  const cfg = await leggiConfigIstat(conn);
  if (!dati.soloPdf && (!cfg || !cfg.email)) {
    return { ok: false, error: "Invio ISTAT non configurato: manca l'indirizzo email (⚙️ Impostazioni → Modulo ISTAT)" };
  }
  const struttura = String(dati.struttura || "");
  if (!dati.prova && !dati.soloPdf && !(cfg.strutture || {})[struttura]) {
    return { ok: false, error: "Invio ISTAT non attivo per questa struttura" };
  }
  const persone = parseInt(dati.persone, 10) || 0;
  if (!persone) return { ok: false, error: "Numero di persone mancante" };
  const arrivo = dataIt(dati.arrivo);
  if (!arrivo) return { ok: false, error: "Data di arrivo mancante o non valida" };
  const partenza = dataIt(dati.partenza);
  const residenza = String(dati.residenza || "").trim();

  const buffer = await costruisciModuloIstat({ struttura, persone, residenza, arrivo, partenza });
  const nomeFile = nomeFileIstat(arrivo, partenza);
  // solo anteprima: restituisce il modulo senza mandare niente a nessuno
  if (dati.soloPdf) {
    return { ok: true, anteprima: true, nomeFile, pdfBase64: buffer.toString("base64"), persone, residenza, arrivo, partenza };
  }
  const dest = dati.prova ? (process.env.GMAIL_USER || cfg.email) : cfg.email;
  const esito = await inviaEmailConAllegato({
    to: dest,
    subject: (cfg.oggetto || "moduli istat") + (dati.prova ? " (PROVA)" : ""),
    testo: (cfg.testo || "Allegato schede ISTAT,\nCordiali saluti") +
      (dati.prova ? "\n\n(Questo è un invio di prova fatto da KeyFlow: il modulo allegato NON è stato mandato all'ufficio del turismo.)" : ""),
    allegatoNome: nomeFile,
    allegatoBuffer: buffer,
  });
  if (!esito.ok) return { ok: false, error: esito.error || "Email non inviata" };
  return { ok: true, destinatario: dest, nomeFile, persone, residenza, arrivo, partenza, prova: !!dati.prova };
}

module.exports = async (req, res) => {
  const conn = upstash();

  if (req.method === "POST") {
    if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });
    if (!conn) return res.status(200).json({ configurato: false });
    // --- comunicazione ISTAT via email (Canazei: l'APT Val di Fassa la vuole così) ---
    if ((req.body || {}).azione === "istatGet") {
      return res.status(200).json({ config: await leggiConfigIstat(conn) });
    }
    if ((req.body || {}).azione === "istatSet") {
      try {
        const { email, strutture, oggetto, testo } = req.body || {};
        const pulite = {};
        if (strutture && typeof strutture === "object") {
          for (const [k, v] of Object.entries(strutture)) if (v) pulite[String(k)] = true;
        }
        const cfg = { email: String(email || "").trim(), strutture: pulite,
          oggetto: String(oggetto || "").trim(), testo: String(testo || "").trim() };
        if (cfg.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.email)) {
          return res.status(400).json({ error: "Indirizzo email non valido" });
        }
        await redisCmd(conn, ["SET", KEY_ISTAT, JSON.stringify(cfg)]);
        return res.status(200).json({ ok: true, config: cfg });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }
    if ((req.body || {}).azione === "istat") {
      try {
        const esito = await inviaModuloIstat(conn, req.body || {});
        if (!esito.ok) return res.status(400).json({ error: esito.error || "Invio non riuscito" });
        return res.status(200).json(esito);
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // fascicolo mensile a richiesta dal gestionale
    if ((req.body || {}).azione === "fascicolo") {
      try {
        const mese = String(req.body.mese || "");
        if (!/^\d{4}-\d{2}$/.test(mese)) return res.status(400).json({ error: "Mese non valido (usa aaaa-mm)" });
        const esito = await inviaFascicolo(conn, mese);
        if (!esito.ok) return res.status(400).json({ error: esito.error || "Invio non riuscito" });
        return res.status(200).json(esito);
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }
    try {
      const { lista = [] } = req.body || {};
      const pulita = lista
        .filter((b) => b && b.id && /^\d{2}\/\d{2}\/\d{4}$/.test(b.arrivo || ""))
        .slice(0, MAX_PENDENTI)
        .map((b) => ({ id: String(b.id), arrivo: b.arrivo, strutturaNome: b.strutturaNome || "", ospiti: (b.ospiti || []).slice(0, 20) }));
      await redisCmd(conn, ["SET", KEY_PENDENTI, JSON.stringify(pulita)]);
      return res.status(200).json({ ok: true, configurato: true });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  // GET: promemoria del cron
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Non autorizzato" });
  }
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return res.status(200).json({ ok: true, nota: "NTFY_TOPIC non configurato: nessun promemoria" });

  const avvisi = [];

  // 1) PROMEMORIA CHECK-IN per struttura: dal giorno di arrivo in poi, per ogni prenotazione
  //    NON ancora registrata in Questura. Il giorno dell'arrivo avvisa "oggi è il check-in";
  //    se resta da registrare, ripete l'avviso ogni giorno successivo finché non è fatta.
  //    Fonti: prenotazioni accettate ma non inviate (bookings_pending) + check-in self-service
  //    non ancora aggiunti a una prenotazione (checkin_pending non "presa").
  try {
    if (conn) {
      const daRegistrare = [];
      const visti = new Set();
      const aggiungi = (arrivo, strutturaNome, strutturaId, nomi) => {
        const lista = (nomi || []).filter(Boolean);
        const key = `${strutturaNome || ""}|${arrivo || ""}|${(lista[0] || "").toUpperCase()}`;
        if (visti.has(key)) return;
        visti.add(key);
        daRegistrare.push({ arrivo, strutturaNome, strutturaId, nomi: lista });
      };
      // a) prenotazioni accettate ma non ancora inviate (sincronizzate dal gestionale)
      const rawB = await redisCmd(conn, ["GET", KEY_PENDENTI]);
      (rawB ? JSON.parse(rawB) : []).forEach((b) => aggiungi(b.arrivo, b.strutturaNome, "", b.ospiti || []));
      // b) check-in self-service non ancora aggiunti a una prenotazione
      const rawC = await redisCmd(conn, ["GET", "checkin_pending"]);
      (rawC ? JSON.parse(rawC) : []).filter((v) => !v.presa).forEach((v) =>
        aggiungi(v.arrivo, v.strutturaNome, v.strutturaId, (v.ospiti || []).map((o) => `${o.cognome || ""} ${o.nome || ""}`.trim())));

      for (const r of daRegistrare) {
        const g = giorniDaArrivoOggi(r.arrivo);
        if (g === null || g < 0) continue; // data non valida o arrivo ancora futuro
        const emoji = emojiStruttura(r.strutturaNome, r.strutturaId);
        const struttura = r.strutturaNome || "struttura da verificare";
        const nomi = r.nomi.join(", ") || "ospiti senza nome";
        if (g === 0) {
          avvisi.push(`${emoji} ${struttura} — OGGI è il check-in di ${nomi}. Ricordati di registrarli in Questura.`);
        } else {
          avvisi.push(`⚠️ ${emoji} ${struttura} — ${nomi} (arrivo ${r.arrivo}) non ancora registrati in Questura. Fallo appena puoi.`);
        }
      }
    }
  } catch (e) { /* archivio non configurato: nessun avviso su questa parte */ }

  // 3) scadenza Ross1000: promemoria il giorno 3 del mese (file del mese scorso entro il 5)
  try {
    const ross = JSON.parse(process.env.ROSS_STRUTTURE || "[]");
    const giornoRoma = Number(new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "numeric" }).format(new Date()));
    if (ross.length && giornoRoma === 3) {
      avvisi.push("Ross1000: ricordati di caricare il file dei flussi del mese scorso entro il giorno 5 (dal gestionale: Scarica .xml, poi importalo sul portale).");
    }
  } catch (e) { /* ROSS_STRUTTURE assente o malformata */ }

  // 4) fascicolo mensile automatico: il giorno 1 manda via email lo zip del mese precedente
  let fascicolo = null;
  try {
    if (conn) {
      const partiRoma = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
      if (+partiRoma.day === 1) {
        const prec = new Date(+partiRoma.year, +partiRoma.month - 2, 1); // mese precedente
        const meseKey = `${prec.getFullYear()}-${String(prec.getMonth() + 1).padStart(2, "0")}`;
        fascicolo = await inviaFascicolo(conn, meseKey);
        if (fascicolo.ok) avvisi.push(`📦 Fascicolo di ${MESI_IT[prec.getMonth()]} inviato via email: registro + ${fascicolo.contratti} contratti.`);
      }
    }
  } catch (e) { /* fascicolo non riuscito: resta disponibile a richiesta dal gestionale */ }

  for (const testo of avvisi) {
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { Title: "Promemoria KeyFlow" },
        body: testo,
      });
    } catch (e) { /* notifica non riuscita: riproverà domani */ }
  }
  return res.status(200).json({ ok: true, inviati: avvisi.length, fascicolo });
};
