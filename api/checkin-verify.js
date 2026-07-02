// api/checkin-verify.js — controlla il codice d'accesso della pagina pubblica /checkin.html
// GET ?c=CODICE -> { ok:true } se combacia, { ok:false, configurato:false } se manca CHECKIN_CODE lato server,
// { ok:false } se il codice è sbagliato/mancante. Non rivela mai il codice vero.
module.exports = async (req, res) => {
  const codiceAtteso = process.env.CHECKIN_CODE;
  if (!codiceAtteso) return res.status(200).json({ ok: false, configurato: false });
  const codice = (req.query || {}).c;
  return res.status(200).json({ ok: codice === codiceAtteso, configurato: true });
};
