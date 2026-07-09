// api/promemoria.js — due funzioni in un solo file (per restare sotto il limite di
// funzioni serverless del piano Vercel):
//
// GET  → promemoria automatici via ntfy, chiamato una volta al giorno dal cron di Vercel
//        (vercel.json → crons, ore 08:00 UTC ≈ 9/10 di mattina in Italia). Avvisa se:
//        1) ci sono check-in ospiti fermi in coda da più di 24 ore (non ancora accettati)
//        2) ci sono prenotazioni accettate ma NON ANCORA INVIATE alla Questura, con la
//           scadenza (giorno dopo l'arrivo) che scade oggi o è già passata
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

const KEY_PENDENTI = "bookings_pending";
const MAX_PENDENTI = 200;

// scadenza semplificata: il giorno DOPO l'arrivo, a fine giornata (ora italiana) —
// coerente con l'obbligo di comunicazione entro 24 ore, con un margine pratico.
function scadenzaDaArrivo(arrivoStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(arrivoStr || "");
  if (!m) return null;
  const arrivo = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return new Date(arrivo.getTime() + 2 * 86400000 - 1000); // arrivo + 2 giorni - 1s
}

module.exports = async (req, res) => {
  const conn = upstash();

  if (req.method === "POST") {
    if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });
    if (!conn) return res.status(200).json({ configurato: false });
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

  // 1) check-in ospiti in attesa da più di 24 ore (non ancora accettati nella prenotazione)
  try {
    if (conn) {
      const raw = await redisCmd(conn, ["GET", "checkin_pending"]);
      const coda = raw ? JSON.parse(raw) : [];
      const vecchi = coda.filter((v) => Date.now() - (v.ts || 0) > 24 * 3600e3);
      if (vecchi.length) {
        avvisi.push(`${vecchi.length} check-in ospit${vecchi.length === 1 ? "e" : "i"} in attesa da più di 24 ore: aprili nel gestionale e registrali in Questura.`);
      }
    }
  } catch (e) { /* archivio non configurato: nessun avviso su questa parte */ }

  // 2) prenotazioni accettate ma non ancora inviate, con scadenza oggi o già passata
  try {
    if (conn) {
      const raw = await redisCmd(conn, ["GET", KEY_PENDENTI]);
      const lista = raw ? JSON.parse(raw) : [];
      const oggi = Date.now();
      for (const b of lista) {
        const scad = scadenzaDaArrivo(b.arrivo);
        if (!scad) continue;
        const nomi = (b.ospiti || []).filter(Boolean).join(", ") || "ospiti senza nome";
        if (scad.getTime() < oggi) {
          avvisi.push(`⚠️ SCADUTA: le schedine di ${nomi}${b.strutturaNome ? " (" + b.strutturaNome + ")" : ""}, arrivo ${b.arrivo}, non risultano ancora inviate alla Questura. Invia appena possibile.`);
        } else if (scad.getTime() - oggi < 24 * 3600e3) {
          avvisi.push(`⏰ Scade oggi: invia le schedine di ${nomi}${b.strutturaNome ? " (" + b.strutturaNome + ")" : ""}, arrivo ${b.arrivo}, alla Questura.`);
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

  for (const testo of avvisi) {
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { Title: "Promemoria KeyFlow" },
        body: testo,
      });
    } catch (e) { /* notifica non riuscita: riproverà domani */ }
  }
  return res.status(200).json({ ok: true, inviati: avvisi.length });
};
