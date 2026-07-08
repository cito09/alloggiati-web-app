// api/send.js — Verifica (Test) o Invio (Send) schedine ad Alloggiati Web
// POST { records: ["...168 char..."], mode: 'test'|'send', struttura?: id }
const { generateToken, sendSchedine, getStruttura } = require("./_alloggiati");
const { checkAdmin } = require("./_admin");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });
  try {
    const { records = [], mode = "test", struttura } = req.body || {};
    if (!Array.isArray(records) || !records.length)
      return res.status(400).json({ error: "Nessuna schedina da inviare" });

    // validazione lunghezza lato server: ogni riga DEVE essere 168
    const lunghezzaErrata = records.findIndex((r) => typeof r !== "string" || r.length !== 168);
    if (lunghezzaErrata !== -1)
      return res.status(400).json({ error: `Riga ${lunghezzaErrata} non è lunga 168 caratteri` });

    const s = getStruttura(struttura);
    const { token } = await generateToken(s);
    const esito = await sendSchedine({ utente: s.utente, token, records, mode });
    return res.status(200).json({ struttura: s.nome, mode, ...esito });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
