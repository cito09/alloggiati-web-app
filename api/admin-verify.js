// api/admin-verify.js — controlla il codice d'accesso del gestionale admin (index.html)
// GET ?c=CODICE -> { ok:true, configurato:true } se combacia,
//                  { ok:false, configurato:false } se manca ADMIN_CODE lato server,
//                  { ok:false, configurato:true } se il codice è sbagliato/mancante.
// Non rivela mai il codice vero.
module.exports = async (req, res) => {
  const atteso = process.env.ADMIN_CODE;
  if (!atteso) return res.status(200).json({ ok: false, configurato: false });
  const codice = (req.query || {}).c;
  return res.status(200).json({ ok: codice === atteso, configurato: true });
};
