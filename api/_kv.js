// api/_kv.js — helper condiviso per l'archivio chiave-valore (Upstash Redis via REST, nessuna libreria)
// Usato da api/storico.js e api/checkin-*.js. Se le env var non sono configurate,
// upstash() ritorna null e chi lo usa deve degradare senza errori (funzione opzionale).
function upstash() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

// invia il comando come corpo JSON (non nel path): i valori possono essere lunghi
// (centinaia di voci con nomi ospiti/foto) e un path troppo lungo si romperebbe.
async function redisCmd(conn, command) {
  const res = await fetch(conn.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

module.exports = { upstash, redisCmd };
