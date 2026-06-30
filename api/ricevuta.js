// api/ricevuta.js — scarica la ricevuta PDF (base64) di una data
// POST { data?: 'YYYY-MM-DD', struttura?: id }
const { generateToken, ricevuta, getStruttura } = require("./_alloggiati");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { data, struttura } = req.body || {};
    const s = getStruttura(struttura);
    const { token } = await generateToken(s);
    const giorno = data || new Date().toISOString().slice(0, 10);
    const { pdfBase64 } = await ricevuta({ utente: s.utente, token, data: giorno });
    return res.status(200).json({ data: giorno, pdfBase64 });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
