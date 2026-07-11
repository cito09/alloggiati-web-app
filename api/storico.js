// api/storico.js — log persistente di invii ufficiali e download .txt
// Usa Upstash Redis via REST (helper condiviso in _kv.js, nessuna libreria).
// Se non è configurato nessun archivio, risponde { configurato:false } e il frontend
// resta sullo storico salvato solo nel browser (localStorage), senza errori.
// GET  -> { configurato, storico }
// POST { ...voce } -> aggiunge una voce in testa, risponde { configurato, storico }
// DELETE { ts } -> rimuove la voce con quel timestamp, risponde { configurato, storico }
const { upstash, redisCmd } = require("./_kv");
const { checkAdmin } = require("./_admin");

const KEY = "storico_schedine";
const MAX_VOCI = 500;

module.exports = async (req, res) => {
  if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });
  const conn = upstash();
  if (!conn) return res.status(200).json({ configurato: false, storico: [] });

  try {
    if (req.method === "GET") {
      const raw = await redisCmd(conn, ["GET", KEY]);
      return res.status(200).json({ configurato: true, storico: raw ? JSON.parse(raw) : [] });
    }
    if (req.method === "POST") {
      const voce = req.body || {};
      const raw = await redisCmd(conn, ["GET", KEY]);
      const storico = raw ? JSON.parse(raw) : [];
      storico.unshift({ ts: Date.now(), ...voce });
      if (storico.length > MAX_VOCI) storico.length = MAX_VOCI;
      await redisCmd(conn, ["SET", KEY, JSON.stringify(storico)]);
      return res.status(200).json({ configurato: true, storico });
    }
    if (req.method === "PATCH") {
      // aggiorna campi di una voce esistente (es. rossOk:true dopo l'export Ross1000)
      const { ts, campi } = req.body || {};
      const raw = await redisCmd(conn, ["GET", KEY]);
      const storico = raw ? JSON.parse(raw) : [];
      const voce = storico.find((v) => v.ts === ts);
      if (voce && campi && typeof campi === "object") Object.assign(voce, campi);
      await redisCmd(conn, ["SET", KEY, JSON.stringify(storico)]);
      return res.status(200).json({ configurato: true, storico });
    }
    if (req.method === "DELETE") {
      const { ts } = req.body || {};
      const raw = await redisCmd(conn, ["GET", KEY]);
      const storico = (raw ? JSON.parse(raw) : []).filter((v) => v.ts !== ts);
      await redisCmd(conn, ["SET", KEY, JSON.stringify(storico)]);
      return res.status(200).json({ configurato: true, storico });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
