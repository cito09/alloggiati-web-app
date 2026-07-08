// api/_email.js — invio email con allegato via Resend (https://resend.com), solo fetch,
// nessuna libreria: coerente con lo stile del resto del progetto.
// Richiede la variabile d'ambiente RESEND_API_KEY. Se manca, l'invio viene semplicemente
// saltato (non blocca il check-in dell'ospite): il contratto resta comunque nella coda
// "Ospiti in attesa" per l'host, solo senza la copia via email.
async function inviaEmailConAllegato({ to, subject, testo, allegatoNome, allegatoBuffer }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY non configurata" };
  if (!to) return { ok: false, error: "Nessun indirizzo email di destinazione" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "KeyFlow <onboarding@resend.dev>",
        to: [to],
        subject,
        text: testo,
        attachments: [{ filename: allegatoNome, content: allegatoBuffer.toString("base64") }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data && data.message ? data.message : `Errore invio email (HTTP ${r.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { inviaEmailConAllegato };
