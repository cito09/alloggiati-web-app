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
const { getContrattoStruttura, testoIT, testoEN } = require("./_contratto");
const { generaContrattoPdf } = require("./_pdf");
const { inviaEmailConAllegato } = require("./_email");

const KEY = "checkin_pending";
const MAX_VOCI = 200;

function toBuffer(dataUrl) {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return Buffer.from(base64, "base64");
}

function conTrattini(gg) {
  return String(gg || "").replace(/\//g, "-");
}
function dataOggiTrattini() {
  return new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
}
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0].trim() : req.socket && req.socket.remoteAddress) || "";
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
          const isPdf = String(immagini[i]).startsWith("data:application/pdf");
          const nomeFile = `checkin/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}.${isPdf ? "pdf" : "jpg"}`;
          const blob = await put(nomeFile, buf, { access: "public", contentType: isPdf ? "application/pdf" : "image/jpeg" });
          fotoUrls.push(blob.url);
        } catch (e) {
          /* una foto non caricata non deve bloccare le altre: l'host la vedrà mancante e potrà richiederla */
        }
      }
      const { immagini: _omit, ...campi } = o;
      ospitiSalvati.push({ ...campi, fotoUrls });
    }

    // contratto di locazione turistica: solo se la struttura ha una config (CONTRATTI_STRUTTURE)
    // e l'ospite ha effettivamente firmato. Il PDF viene generato e mandato via email all'host
    // (Resend), MAI salvato sul sito: niente accumulo di file.
    const cfgContratto = getContrattoStruttura(struttura);
    const firma = (req.body || {}).firma;
    let contrattoInviato = false;
    let contrattoErrore = "";
    if (cfgContratto) {
      if (!firma) {
        contrattoErrore = "firma mancante (l'ospite non ha firmato)";
      } else {
        try {
          const capofamiglia = validi[0];
          const dati = {
            conduttoreNome: [capofamiglia.cognome, capofamiglia.nome].filter(Boolean).join(" "),
            conduttoreDoc: capofamiglia.numeroDoc || "",
            arrivo: conTrattini(arrivo),
            partenza: conTrattini(partenza),
            numOspiti: validi.length,
            dataFirma: dataOggiTrattini(),
          };
          const pdfBuffer = await generaContrattoPdf({
            blocchiIT: testoIT(cfgContratto, dati),
            blocchiEN: testoEN(cfgContratto, dati),
            firmaPngBuffer: toBuffer(firma),
            dataFirma: dati.dataFirma,
            ip: clientIp(req),
          });
          const esito = await inviaEmailConAllegato({
            to: cfgContratto.email,
            subject: `Contratto firmato · ${strutturaInfo ? strutturaInfo.nome : struttura} · ${dati.conduttoreNome}`,
            testo: `In allegato il contratto di locazione turistica firmato da ${dati.conduttoreNome}, soggiorno dal ${arrivo} al ${partenza}.\n\nInviato automaticamente da KeyFlow: non è stato salvato altrove.`,
            allegatoNome: `contratto_${(dati.conduttoreNome || "ospite").replace(/\s+/g, "_")}.pdf`,
            allegatoBuffer: pdfBuffer,
          });
          contrattoInviato = esito.ok;
          if (!esito.ok) contrattoErrore = esito.error || "invio email non riuscito";
        } catch (e) {
          // un contratto non generato/inviato non deve bloccare il check-in: l'host lo vede dal badge
          contrattoErrore = String(e.message || e);
        }
      }
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
      contrattoRichiesto: !!cfgContratto,
      contrattoInviato,
      contrattoErrore,
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
