// api/ricevuta.js — scarica la ricevuta PDF (base64) più recente disponibile
// POST { data?: 'YYYY-MM-DD' (se omessa cerca a ritroso da oggi, come fa il portale), struttura?: id }
// POST { azione:'driveGet' } / { azione:'driveSet', url, secret, cartella } — configura il
//   salvataggio automatico su Google Drive (tramite Apps Script dell'utente, vedi Impostazioni).
const { generateToken, ricevuta, getStruttura, dataItalia } = require("./_alloggiati");
const { checkAdmin } = require("./_admin");
const { upstash, redisCmd } = require("./_kv");

const KEY_DRIVE = "drive_ricevute";

async function leggiConfigDrive() {
  const conn = upstash();
  if (!conn) return null;
  try {
    const raw = await redisCmd(conn, ["GET", KEY_DRIVE]);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// manda il PDF allo script Google dell'utente, che lo salva nella sua cartella Drive.
// Non deve mai far fallire il download: ritorna sempre un esito {ok} o {ok:false, errore}.
async function salvaSuDrive(cfg, nomeFile, pdfBase64, cartella) {
  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      // text/plain: le web app di Apps Script accettano POST semplici senza preflight CORS
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: cfg.secret || "", nomeFile, base64: pdfBase64, cartella: cartella || "" }),
      redirect: "follow", // Apps Script risponde con un redirect 302 verso il contenuto
    });
    const txt = await r.text();
    let esito; try { esito = JSON.parse(txt); } catch { esito = null; }
    if (esito && esito.ok) return { ok: true, nome: esito.nome || nomeFile };
    return { ok: false, errore: (esito && esito.errore) || `risposta inattesa dallo script (${r.status})` };
  } catch (e) {
    return { ok: false, errore: String(e.message || e) };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });
  try {
    const { data, struttura, azione, url, secret, cartelle } = req.body || {};

    // --- configurazione Google Drive (letta/salvata nell'archivio, vale su tutti i dispositivi) ---
    if (azione === "driveGet") {
      const cfg = await leggiConfigDrive();
      return res.status(200).json({ config: cfg ? { url: cfg.url, cartelle: cfg.cartelle || {}, haSecret: !!cfg.secret } : null });
    }
    if (azione === "driveSet") {
      const conn = upstash();
      if (!conn) return res.status(500).json({ error: "Archivio (KV) non configurato" });
      if (!url) { await redisCmd(conn, ["DEL", KEY_DRIVE]); return res.status(200).json({ ok: true, rimosso: true }); }
      if (!/^https:\/\/script\.google\.com\/macros\//.test(String(url))) {
        return res.status(400).json({ error: "L'indirizzo deve essere quello della web app di Apps Script (inizia con https://script.google.com/macros/…)" });
      }
      const vecchia = (await leggiConfigDrive()) || {};
      // cartelle = { idStruttura: nomeCartella } — una cartella per struttura
      const pulite = {};
      if (cartelle && typeof cartelle === "object") {
        for (const [k, v] of Object.entries(cartelle)) {
          const nome = String(v || "").trim();
          if (nome) pulite[String(k)] = nome;
        }
      }
      const cfg = { url: String(url), secret: secret ? String(secret) : (vecchia.secret || ""), cartelle: pulite };
      await redisCmd(conn, ["SET", KEY_DRIVE, JSON.stringify(cfg)]);
      return res.status(200).json({ ok: true });
    }

    // --- download ricevuta ---
    const s = getStruttura(struttura);
    const { token } = await generateToken(s);

    let giorno = data, pdfBase64;
    if (giorno) {
      ({ pdfBase64 } = await ricevuta({ utente: s.utente, token, data: giorno }));
    } else {
      // nessuna data indicata: come fa il portale, propone l'ultima disponibile.
      // prova oggi (ora italiana) e risale fino a una settimana indietro.
      let ultimoErrore;
      for (let giorniIndietro = 0; giorniIndietro < 7; giorniIndietro++) {
        const g = dataItalia(giorniIndietro);
        try {
          ({ pdfBase64 } = await ricevuta({ utente: s.utente, token, data: g }));
          giorno = g; break;
        } catch (e) { ultimoErrore = e; }
      }
      if (!pdfBase64) throw new Error(`Nessuna ricevuta trovata negli ultimi 7 giorni (${ultimoErrore && ultimoErrore.message})`);
    }

    // salvataggio automatico su Drive, se configurato (non blocca mai il download)
    let drive = null;
    const cfg = await leggiConfigDrive();
    if (cfg && cfg.url) {
      const nomeFile = `ricevuta_${giorno}_${(s.nome || s.id || "").replace(/[^\w\- ]+/g, "").trim() || "struttura"}.pdf`;
      // ogni struttura ha la SUA cartella: quella scelta nelle Impostazioni,
      // o in mancanza una di default col nome della struttura (mai una cartella condivisa)
      const cartellaStruttura = (cfg.cartelle && String(cfg.cartelle[s.id] || "").trim()) || `Ricevute ${s.nome || s.id}`;
      drive = await salvaSuDrive(cfg, nomeFile, pdfBase64, cartellaStruttura);
    }

    return res.status(200).json({ data: giorno, pdfBase64, drive });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
