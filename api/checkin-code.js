// api/checkin-code.js — espone il codice di accesso al check-in SOLO all'app admin,
// per comodità (mostrare/copiare il link completo).
const { checkAdmin } = require("./_admin");

module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Accesso non autorizzato" });
  const codice = process.env.CHECKIN_CODE || null;
  return res.status(200).json({ configurato: !!codice, codice });
};
