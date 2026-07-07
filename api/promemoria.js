// api/promemoria.js — promemoria automatici via ntfy, chiamato una volta al giorno
// dal cron di Vercel (vercel.json → crons, ore 08:00 UTC ≈ 9/10 di mattina in Italia).
// Avvisa se:
// 1) ci sono check-in ospiti fermi in coda da più di 24 ore
// 2) è il giorno 3 del mese e c'è almeno una struttura Ross1000 (file da caricare entro il 5)
// Se NTFY_TOPIC non è configurato non fa nulla. Con CRON_SECRET impostato, accetta solo
// le chiamate del cron di Vercel (header Authorization: Bearer <segreto>).
const { upstash, redisCmd } = require("./_kv");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Non autorizzato" });
  }
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return res.status(200).json({ ok: true, nota: "NTFY_TOPIC non configurato: nessun promemoria" });

  const avvisi = [];

  // 1) check-in ospiti in attesa da più di 24 ore
  try {
    const conn = upstash();
    if (conn) {
      const raw = await redisCmd(conn, ["GET", "checkin_pending"]);
      const coda = raw ? JSON.parse(raw) : [];
      const vecchi = coda.filter((v) => Date.now() - (v.ts || 0) > 24 * 3600e3);
      if (vecchi.length) {
        avvisi.push(`${vecchi.length} check-in ospit${vecchi.length === 1 ? "e" : "i"} in attesa da più di 24 ore: aprili nel gestionale e registrali in Questura.`);
      }
    }
  } catch (e) { /* archivio non configurato: nessun avviso su questa parte */ }

  // 2) scadenza Ross1000: promemoria il giorno 3 del mese (file del mese scorso entro il 5)
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
