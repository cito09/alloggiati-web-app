// api/_admin.js — protegge gli endpoint del gestionale admin con un codice condiviso.
// Il codice "attivo" è: quello salvato su Upstash (se l'host lo ha cambiato dal gestionale),
// altrimenti la variabile d'ambiente ADMIN_CODE. Se nessuno dei due è configurato, non blocca
// nulla: è così finché l'host non decide di attivare la protezione.
const { upstash, redisCmd } = require("./_kv");

const KEY = "admin_code";

async function getAdminCode() {
  const conn = upstash();
  if (conn) {
    try {
      const salvato = await redisCmd(conn, ["GET", KEY]);
      if (salvato) return salvato;
    } catch (e) {
      /* Upstash non raggiungibile: ripiega sulla variabile d'ambiente */
    }
  }
  return process.env.ADMIN_CODE || "";
}

async function checkAdmin(req) {
  const atteso = await getAdminCode();
  if (!atteso) return true;
  return req.headers["x-admin-code"] === atteso;
}

module.exports = { checkAdmin, getAdminCode };
