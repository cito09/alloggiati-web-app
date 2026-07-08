// api/ricevuta.js — scarica la ricevuta PDF (base64) più recente disponibile
// POST { data?: 'YYYY-MM-DD' (se omessa cerca a ritroso da oggi, come fa il portale), struttura?: id }
const { generateToken, ricevuta, getStruttura, dataItalia } = require("./_alloggiati");
const { checkAdmin } = require("./_admin");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAdmin(req)) return res.status(401).json({ error: "Accesso non autorizzato" });
  try {
    const { data, struttura } = req.body || {};
    const s = getStruttura(struttura);
    const { token } = await generateToken(s);

    if (data) {
      const { pdfBase64 } = await ricevuta({ utente: s.utente, token, data });
      return res.status(200).json({ data, pdfBase64 });
    }

    // nessuna data indicata: come fa il portale, propone l'ultima disponibile.
    // prova oggi (ora italiana) e risale fino a una settimana indietro.
    let ultimoErrore;
    for (let giorniIndietro = 0; giorniIndietro < 7; giorniIndietro++) {
      const giorno = dataItalia(giorniIndietro);
      try {
        const { pdfBase64 } = await ricevuta({ utente: s.utente, token, data: giorno });
        return res.status(200).json({ data: giorno, pdfBase64 });
      } catch (e) {
        ultimoErrore = e;
      }
    }
    throw new Error(`Nessuna ricevuta trovata negli ultimi 7 giorni (${ultimoErrore && ultimoErrore.message})`);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
