// api/checkin-code.js — espone il codice di accesso al check-in SOLO all'app admin,
// per comodità (mostrare/copiare il link completo). Non è un endpoint pubblico linkato
// da nessuna parte: chi ha già l'URL dell'app admin ha già accesso a tutto il resto.
module.exports = async (req, res) => {
  const codice = process.env.CHECKIN_CODE || null;
  return res.status(200).json({ configurato: !!codice, codice });
};
