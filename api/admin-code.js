// api/admin-code.js — gestisce il codice d'accesso del gestionale admin (index.html)
// GET  ?c=CODICE -> { ok:true, configurato:true } se combacia,
//                    { ok:false, configurato:false } se non è configurato nessun codice,
//                    { ok:false, configurato:true } se il codice è sbagliato/mancante.
//                    Non rivela mai il codice vero.
// POST { codiceAttuale, codiceNuovo } -> { ok:true }. Cambia il codice, salvandolo su
//        Upstash (se collegato): da quel momento "vince" sulla variabile d'ambiente
//        ADMIN_CODE (che resta comunque come ripiego se l'archivio online non è raggiungibile).
const { upstash, redisCmd } = require("./_kv");
const { getAdminCode } = require("./_admin");

const KEY = "admin_code";

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const atteso = await getAdminCode();
    if (!atteso) return res.status(200).json({ ok: false, configurato: false });
    const codice = (req.query || {}).c;
    return res.status(200).json({ ok: codice === atteso, configurato: true });
  }
  if (req.method === "POST") {
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
  }
  return res.status(405).json({ error: "Method not allowed" });
};
