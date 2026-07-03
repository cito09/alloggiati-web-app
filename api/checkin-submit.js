// api/checkin-submit.js — riceve il check-in compilato dall'ospite (pagina pubblica /checkin.html)
// POST { arrivo:'gg/mm/aaaa', ospiti:[{cognome,nome,sesso,dataNascita,comuneNascita,statoNascita,
//        cittadinanza,tipoDoc,numeroDoc,luogoRilascio, immagini:[dataURL,...]}, ...] }
// - carica le foto su Vercel Blob (@vercel/blob: SDK ufficiale, l'unica eccezione al "solo fetch"
//   perché il protocollo di upload non è pubblico/stabile come una REST API generica)
// - salva la voce nella coda 'checkin_pending' (Upstash), che l'host revisiona e conferma a mano
// - non invia MAI nulla alla Questura da qui: resta sempre una richiesta di verifica per l'host
// - avvisa l'host con una notifica push (ntfy.sh, se NTFY_TOPIC è configurato)
const { put } = require("@vercel/blob");
const { upstash, redisCmd } = require("./_kv");
const { getStrutture } = require("./_alloggiati");

const KEY = "checkin_pending";
const MAX_VOCI = 200;

function toBuffer(dataUrl) {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return Buffer.from(base64, "base64");
}

async function notificaHost(testo) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { Title: "Nuovo check-in ospite" },
      body: testo,
    });
  } catch (e) {
    /* notifica non riuscita: non deve bloccare il check-in dell'ospite */
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const codiceAtteso = process.env.CHECKIN_CODE;
  if (!codiceAtteso) return res.status(403).json({ error: "Check-in non configurato: manca CHECKIN_CODE" });
  if ((req.body || {}).codice !== codiceAtteso) return res.status(403).json({ error: "Link non valido" });

  const conn = upstash();
  if (!conn) return res.status(500).json({ error: "Archivio non configurato (Upstash KV)" });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: "Archivio foto non configurato (Vercel Blob)" });

  try {
    const { arrivo, partenza, notti, struttura, ospiti = [] } = req.body || {};
    const validi = ospiti.filter((o) => o && (o.cognome || o.nome));
    if (!validi.length) return res.status(400).json({ error: "Nessun ospite compilato" });

    const strutturaInfo = getStrutture().find((s) => s.id === struttura);

    const ospitiSalvati = [];
    for (const o of validi) {
      const immagini = Array.isArray(o.immagini) ? o.immagini : [];
      const fotoUrls = [];
      for (let i = 0; i < immagini.length; i++) {
        try {
          const buf = toBuffer(immagini[i]);
          const nomeFile = `checkin/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}.jpg`;
          const blob = await put(nomeFile, buf, { access: "public", contentType: "image/jpeg" });
          fotoUrls.push(blob.url);
        } catch (e) {
          /* una foto non caricata non deve bloccare le altre: l'host la vedrà mancante e potrà richiederla */
        }
      }
      const { immagini: _omit, ...campi } = o;
      ospitiSalvati.push({ ...campi, fotoUrls });
    }

    const voce = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      strutturaId: struttura || "",
      strutturaNome: strutturaInfo ? strutturaInfo.nome : "",
      arrivo: arrivo || "",
      partenza: partenza || "",
      notti: Number(notti) || 0,
      ospiti: ospitiSalvati,
    };

    let raw;
    try {
      raw = await redisCmd(conn, ["GET", KEY]);
    } catch (e) {
      return res.status(500).json({ error: `Errore lettura coda (KV GET): ${String(e.message || e)}` });
    }
    const coda = raw ? JSON.parse(raw) : [];
    coda.unshift(voce);
    if (coda.length > MAX_VOCI) coda.length = MAX_VOCI;
    try {
      await redisCmd(conn, ["SET", KEY, JSON.stringify(coda)]);
    } catch (e) {
      return res.status(500).json({ error: `Errore scrittura coda (KV SET): ${String(e.message || e)}` });
    }

    const nomi = ospitiSalvati.map((o) => [o.cognome, o.nome].filter(Boolean).join(" ")).filter(Boolean).join(", ");
    await notificaHost(`${nomi || "Nuovo ospite"}${strutturaInfo ? " · " + strutturaInfo.nome : ""}${arrivo ? " · arrivo " + arrivo : ""} ha completato il check-in`);

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: `Errore generico: ${String(e.message || e)}` });
  }
};
