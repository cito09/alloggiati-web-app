// api/checkin-pending.js — coda ospiti in attesa di verifica (self check-in), uso lato admin
// GET -> { configurato, coda }
// DELETE { id } -> rimuove una voce (dopo che l'host l'ha accettata nella prenotazione o scartata)
const { upstash, redisCmd } = require("./_kv");
const { checkAdmin } = require("./_admin");

const KEY = "checkin_pending";

module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Accesso non autorizzato" });
  const conn = upstash();
  if (!conn) return res.status(200).json({ configurato: false, coda: [] });

  try {
    if (req.method === "GET") {
      const raw = await redisCmd(conn, ["GET", KEY]);
      return res.status(200).json({ configurato: true, coda: raw ? JSON.parse(raw) : [] });
    }
    if (req.method === "DELETE") {
      const { id } = req.body || {};
      const raw = await redisCmd(conn, ["GET", KEY]);
      const coda = (raw ? JSON.parse(raw) : []).filter((v) => v.id !== id);
      await redisCmd(conn, ["SET", KEY, JSON.stringify(coda)]);
      return res.status(200).json({ configurato: true, coda });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
