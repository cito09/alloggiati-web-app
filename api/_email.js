// api/_email.js — invio email con allegato. Due modi possibili:
//   1) Gmail (SMTP con "password per le app"): variabili GMAIL_USER + GMAIL_APP_PASSWORD.
//      Manda dal tuo indirizzo Gmail vero a CHIUNQUE (host e ospite), gratis, senza dominio.
//   2) Resend (https://resend.com): variabile RESEND_API_KEY. Senza dominio verificato
//      manda solo al tuo stesso indirizzo.
// Se sono configurati entrambi vince Gmail (più flessibile). Se non è configurato nessuno,
// l'invio viene saltato senza bloccare il check-in.
const nodemailer = require("nodemailer");

// Accetta un allegato solo (allegatoNome + allegatoBuffer) oppure più allegati
// (allegati: [{nome, buffer}]), come quando si mandano insieme più moduli ISTAT.
async function inviaEmailConAllegato({ to, subject, testo, allegatoNome, allegatoBuffer, allegati, mittente }) {
  if (!to) return { ok: false, error: "Nessun indirizzo email di destinazione" };
  const lista = (allegati && allegati.length)
    ? allegati.map((a) => ({ filename: a.nome, content: a.buffer }))
    : (allegatoBuffer ? [{ filename: allegatoNome, content: allegatoBuffer }] : []);

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (gmailUser && gmailPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        // Google mostra la password per le app con spazi (es. "abcd efgh ijkl mnop"):
        // li togliamo, così va bene anche se viene incollata così com'è.
        auth: { user: gmailUser, pass: gmailPass.replace(/\s+/g, "") },
      });
      await transporter.sendMail({
        // il nome che vede chi riceve: l'indirizzo resta il tuo Gmail (obbligatorio),
        // ma l'etichetta si può cambiare (es. "Loft Canazei" invece di "KeyFlow")
        from: `${(mittente || "KeyFlow").replace(/["<>\r\n]/g, " ").trim() || "KeyFlow"} <${gmailUser}>`,
        to,
        subject,
        text: testo,
        attachments: lista,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Gmail: ${String(e.message || e)}` };
    }
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "Invio email non configurato (GMAIL_APP_PASSWORD o RESEND_API_KEY)" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: mittente
          ? `${mittente.replace(/["<>\r\n]/g, " ").trim()} <${(process.env.RESEND_FROM || "onboarding@resend.dev").replace(/^.*<|>.*$/g, "")}>`
          : (process.env.RESEND_FROM || "KeyFlow <onboarding@resend.dev>"),
        to: [to],
        subject,
        text: testo,
        attachments: lista.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
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
