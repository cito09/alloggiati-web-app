// api/strutture.js — elenco strutture configurate (solo id+nome, MAI le credenziali)
// Il flag "ross" indica se per la struttura è configurato anche Ross1000 (ROSS_STRUTTURE).
// "contratto" contiene i dati pubblici (mai l'email) per mostrare il contratto di locazione
// nel check-in, solo se la struttura è presente in CONTRATTI_STRUTTURE.
const { getStrutture } = require("./_alloggiati");
const { getContrattoStruttura, campiPubbliciContratto } = require("./_contratto");

function rossIds() {
  try { return new Set(JSON.parse(process.env.ROSS_STRUTTURE || "[]").map((s) => s.id)); }
  catch { return new Set(); }
}

module.exports = async (req, res) => {
  try {
    const ross = rossIds();
    const list = getStrutture().map((s) => ({
      id: s.id,
      nome: s.nome,
      ross: ross.has(s.id),
      contratto: campiPubbliciContratto(getContrattoStruttura(s.id)),
    }));
    return res.status(200).json({ strutture: list });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
