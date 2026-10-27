// api/admin-code.js — gestisce il codice d'accesso del gestionale admin (index.html)
// GET  ?c=CODICE -> { ok:true, configurato:true } se combacia,
//                    { ok:false, configurato:false } se non è configurato nessun codice,
//                    { ok:false, configurato:true } se il codice è sbagliato/mancante,
//                    { ok:false, configurato:true, team:{nome,permessi} } se è il codice di un
//                    collaboratore (api/_team.js): la pagina mostra solo quello che gli è permesso.
//                    Non rivela mai il codice vero.
// POST { codiceAttuale, codiceNuovo } -> { ok:true }. Cambia il codice, salvandolo su
//        Upstash (se collegato): da quel momento "vince" sulla variabile d'ambiente
//        ADMIN_CODE (che resta comunque come ripiego se l'archivio online non è raggiungibile).
const { upstash, redisCmd } = require("./_kv");
const { getAdminCode } = require("./_admin");
const { trovaCollaboratore } = require("./_team");

const KEY = "admin_code";

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const atteso = await getAdminCode();
    if (!atteso) return res.status(200).json({ ok: false, configurato: false });
    const codice = (req.query || {}).c;
    if (codice === atteso) return res.status(200).json({ ok: true, configurato: true });
    // il codice di un collaboratore (Impostazioni → Collaboratori): entra con i suoi permessi
    const m = codice ? await trovaCollaboratore(null, codice) : null;
    if (m) return res.status(200).json({ ok: false, configurato: true, team: { nome: m.nome, permessi: m.permessi } });
    return res.status(200).json({ ok: false, configurato: true });
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
