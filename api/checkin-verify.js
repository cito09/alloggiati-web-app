// api/checkin-verify.js — controlla il codice d'accesso della pagina pubblica /checkin.html
// GET ?c=CODICE -> { ok:true } se combacia, { ok:false, configurato:false } se manca CHECKIN_CODE lato server,
// { ok:false } se il codice è sbagliato/mancante. Non rivela mai il codice vero.
const { codiceValido } = require("./_codice");

module.exports = async (req, res) => {
  const codiceAtteso = process.env.CHECKIN_CODE;
  if (!codiceAtteso) return res.status(200).json({ ok: false, configurato: false });
  const codice = (req.query || {}).c;
  // confronto tollerante (spazi, punteggiatura, maiuscole aggiunti dalle chat): vedi _codice.js
  return res.status(200).json({ ok: codiceValido(codice), configurato: true });
};
