// api/strutture.js — elenco strutture configurate (solo id+nome, MAI le credenziali)
const { getStrutture } = require("./_alloggiati");

module.exports = async (req, res) => {
  try {
    const list = getStrutture().map((s) => ({ id: s.id, nome: s.nome }));
    return res.status(200).json({ strutture: list });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
