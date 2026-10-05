// api/_codice.js — controllo del codice del link di check-in, condiviso da checkin-verify e
// checkin-submit (file "_": è un aiutante, non conta nel limite delle funzioni di Vercel).
//
// Il link arriva agli ospiti dentro le chat (Airbnb con la traduzione automatica, WhatsApp…),
// che a volte ci attaccano spazi o punteggiatura, o cambiano maiuscole e minuscole. Per non
// respingere un ospite vero si confrontano solo lettere e cifre, senza distinguere
// maiuscole/minuscole. La stessa regola vale all'apertura e all'invio finale: se il link
// passa il primo controllo, deve passare anche il secondo.
function normalizza(v) {
  return String(v || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function codiceValido(fornito) {
  const atteso = process.env.CHECKIN_CODE;
  if (!atteso) return false;
  if (String(fornito || "") === atteso) return true;
  const a = normalizza(atteso);
  return a.length >= 4 && normalizza(fornito) === a;
}
module.exports = { codiceValido, normalizza };
