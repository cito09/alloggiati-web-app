// api/storico.js — log persistente di invii ufficiali e download .txt
// Usa Upstash Redis via REST (nessuna libreria: stesso stile "solo fetch" di _alloggiati.js).
// Se non è configurato nessun archivio, risponde { configurato:false } e il frontend
// resta sullo storico salvato solo nel browser (localStorage), senza errori.
// GET  -> { configurato, storico }
// POST { ...voce } -> aggiunge una voce in testa, risponde { configurato, storico }
// DELETE { ts } -> rimuove la voce con quel timestamp, risponde { configurato, storico }
const KEY = "storico_schedine";
const MAX_VOCI = 500;

function upstash() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

// invia il comando come corpo JSON (non nel path): i valori possono essere lunghi
// (centinaia di voci con nomi ospiti) e un path troppo lungo si romperebbe.
async function redisCmd(conn, command) {
  const res = await fetch(conn.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

module.exports = async (req, res) => {
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
