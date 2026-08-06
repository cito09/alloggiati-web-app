// api/storico.js — log persistente di invii ufficiali e download .txt
// Usa Upstash Redis via REST (helper condiviso in _kv.js, nessuna libreria).
// Se non è configurato nessun archivio, risponde { configurato:false } e il frontend
// resta sullo storico salvato solo nel browser (localStorage), senza errori.
// GET  -> { configurato, storico }
// POST { ...voce } -> aggiunge una voce in testa, risponde { configurato, storico }
// POST { azione:"documento", file } -> salva UN documento su Blob, risponde { ok, url }
// DELETE { ts } -> rimuove la voce con quel timestamp, risponde { configurato, storico }
const { upstash, redisCmd } = require("./_kv");
const { checkAdmin } = require("./_admin");
const { salvaBlob } = require("./_blob");

const KEY = "storico_schedine";
const MAX_VOCI = 500;

function toBuffer(dataUrl) {
  const base64 = String(dataUrl).includes(",") ? String(dataUrl).split(",")[1] : String(dataUrl);
  return Buffer.from(base64, "base64");
}

module.exports = async (req, res) => {
  if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });

  // Un documento per volta (le foto caricate a mano nella scheda Registra): il browser lo
  // manda da solo, così la richiesta non supera mai il limite di dimensione (~4,5 MB).
  // Non serve Upstash: risponde con il link del file appena salvato.
  if (req.method === "POST" && (req.body || {}).azione === "documento") {
    const file = (req.body || {}).file;
    if (!file) return res.status(400).json({ error: "Nessun file" });
    try {
      const isPdf = String(file).startsWith("data:application/pdf");
      const nome = `archivio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${isPdf ? "pdf" : "jpg"}`;
      const blob = await salvaBlob(nome, toBuffer(file), isPdf ? "application/pdf" : "image/jpeg");
      return res.status(200).json({ ok: true, url: blob.url });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

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
