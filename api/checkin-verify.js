// api/checkin-verify.js — controlla il codice d'accesso della pagina pubblica /checkin.html
// GET ?c=CODICE -> { ok:true } se combacia, { ok:false, configurato:false } se manca CHECKIN_CODE lato server,
// { ok:false } se il codice è sbagliato/mancante. Non rivela mai il codice vero.
// GET ?c=CODICE&s=casa&a=gg/mm/aaaa&p=gg/mm/aaaa -> in più { ospiti:N } = quanti ospiti ha la
// prenotazione di quella casa con quell'arrivo (dall'email di conferma di Airbnb), così il check-in
// chiede i documenti di tutti (1/11/2026: un ospite di un gruppo di 3 aveva inserito solo se stesso).
// Solo il numero, e solo a chi ha il codice giusto.
const { codiceValido } = require("./_codice");
const { upstash } = require("./_kv");

module.exports = async (req, res) => {
  const codiceAtteso = process.env.CHECKIN_CODE;
  if (!codiceAtteso) return res.status(200).json({ ok: false, configurato: false });
  const q = req.query || {};
  // confronto tollerante (spazi, punteggiatura, maiuscole aggiunti dalle chat): vedi _codice.js
  const ok = codiceValido(q.c);
  if (!ok || !q.s || !q.a) return res.status(200).json({ ok, configurato: true });
  let ospiti = null, gia = 0;
  try {
    const conn = upstash();
    if (conn) {
      const { leggiCalendari, ospitiPrenotazione } = require("./_calendari");
      ospiti = ospitiPrenotazione(await leggiCalendari(conn), q.s, q.a, q.p);
      // quanti di quella prenotazione hanno GIÀ fatto il check-in (es. l'altra coppia del gruppo,
      // col suo telefono): si chiedono solo i documenti che mancano
      if (ospiti) gia = await giaFatti(conn, q.s, q.a);
    }
  } catch { ospiti = null; gia = 0; }   // senza il numero il check-in va avanti come prima
  return res.status(200).json({ ok, configurato: true, ospiti, gia });
};

// persone già arrivate a KeyFlow (check-in in attesa o registrati) per la casa e il giorno d'arrivo
async function giaFatti(conn, casa, arrivo) {
  try {
    const { redisCmd } = require("./_kv");
    const { personeGiaFatte } = require("./_pulizie");
    const { getStrutture } = require("./_alloggiati");
    const leggi = async (k) => { try { const raw = await redisCmd(conn, ["GET", k]); const d = raw ? JSON.parse(raw) : []; return Array.isArray(d) ? d : []; } catch { return []; } };
    const [storico, pending] = await Promise.all([leggi("storico_schedine"), leggi("checkin_pending")]);
    let strutture = [];
    try { strutture = getStrutture() || []; } catch { strutture = []; }
    return personeGiaFatte({ storico, pending, strutture }, casa, arrivo);
  } catch { return 0; }
}
