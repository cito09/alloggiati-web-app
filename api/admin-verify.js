// api/admin-verify.js — controlla il codice d'accesso del gestionale admin (index.html)
// GET ?c=CODICE -> { ok:true, configurato:true } se combacia,
//                  { ok:false, configurato:false } se non è configurato nessun codice,
//                  { ok:false, configurato:true } se il codice è sbagliato/mancante.
// Non rivela mai il codice vero.
const { getAdminCode } = require("./_admin");

module.exports = async (req, res) => {
  const atteso = await getAdminCode();
  if (!atteso) return res.status(200).json({ ok: false, configurato: false });
  const codice = (req.query || {}).c;
  return res.status(200).json({ ok: codice === atteso, configurato: true });
};
