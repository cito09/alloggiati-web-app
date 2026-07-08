// api/admin-change-code.js — permette di cambiare il codice d'accesso del gestionale
// direttamente dall'app, senza toccare le variabili d'ambiente su Vercel.
// POST { codiceAttuale, codiceNuovo } -> { ok:true }
// Richiede l'archivio online (Upstash) configurato: il nuovo codice viene salvato lì
// e da quel momento "vince" sulla variabile d'ambiente ADMIN_CODE (che resta comunque
// come ripiego se l'archivio online non è raggiungibile).
const { upstash, redisCmd } = require("./_kv");
const { getAdminCode } = require("./_admin");

const KEY = "admin_code";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const conn = upstash();
  if (!conn)
    return res.status(400).json({
      error: "Serve l'archivio online (Upstash) collegato per cambiare il codice da qui. In alternativa, cambia ADMIN_CODE su Vercel.",
    });
  const atteso = await getAdminCode();
  const { codiceAttuale, codiceNuovo } = req.body || {};
  if (!atteso || codiceAttuale !== atteso) return res.status(401).json({ error: "Codice attuale errato" });
  const nuovo = String(codiceNuovo || "").trim();
  if (nuovo.length < 6) return res.status(400).json({ error: "Il nuovo codice deve avere almeno 6 caratteri" });
  await redisCmd(conn, ["SET", KEY, nuovo]);
  return res.status(200).json({ ok: true });
};
