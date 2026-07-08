// api/_admin.js — protegge gli endpoint del gestionale admin con un codice condiviso
// (variabile d'ambiente ADMIN_CODE). Se ADMIN_CODE non è configurata, non blocca nulla:
// è così finché l'host non decide di attivare la protezione impostando la variabile.
function checkAdmin(req) {
  const atteso = process.env.ADMIN_CODE;
  if (!atteso) return true;
  return req.headers["x-admin-code"] === atteso;
}
module.exports = { checkAdmin };
