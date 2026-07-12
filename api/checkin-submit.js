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
const { getContrattoStruttura, testoContratto, firmaLabel } = require("./_contratto");
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

// testo della mail INVIATA ALL'OSPITE, nella lingua in cui ha fatto il check-in.
// (La mail all'host resta sempre in italiano.)
function emailOspiteTesti(lang, { nomeStruttura, arrivo, partenza }) {
  const M = {
    it: {
      subject: `La tua copia del contratto · ${nomeStruttura}`,
      testo: `In allegato la tua copia del contratto di locazione turistica firmato per il soggiorno dal ${arrivo} al ${partenza}.`,
    },
    en: {
      subject: `Your copy of the agreement · ${nomeStruttura}`,
      testo: `Attached is your copy of the signed tourist rental agreement for your stay from ${arrivo} to ${partenza}.`,
    },
    fr: {
      subject: `Votre copie du contrat · ${nomeStruttura}`,
      testo: `Vous trouverez en pièce jointe votre copie du contrat de location touristique signé pour votre séjour du ${arrivo} au ${partenza}.`,
    },
    es: {
      subject: `Tu copia del contrato · ${nomeStruttura}`,
      testo: `Adjunto encontrarás tu copia del contrato de alquiler turístico firmado para tu estancia del ${arrivo} al ${partenza}.`,
    },
    de: {
      subject: `Ihre Vertragskopie · ${nomeStruttura}`,
      testo: `Im Anhang finden Sie Ihre Kopie des unterzeichneten touristischen Mietvertrags für Ihren Aufenthalt vom ${arrivo} bis zum ${partenza}.`,
    },
    ro: {
      subject: `Copia contractului dumneavoastră · ${nomeStruttura}`,
      testo: `Atașat găsiți copia contractului de închiriere turistică semnat pentru sejurul dumneavoastră din ${arrivo} până în ${partenza}.`,
    },
    pt: {
      subject: `A sua cópia do contrato · ${nomeStruttura}`,
      testo: `Em anexo encontra a sua cópia do contrato de locação turística assinado para a estadia de ${arrivo} a ${partenza}.`,
    },
    pl: {
      subject: `Twoja kopia umowy · ${nomeStruttura}`,
      testo: `W załączniku znajdziesz kopię podpisanej umowy najmu turystycznego na pobyt od ${arrivo} do ${partenza}.`,
    },
  };
  return M[lang] || M.it;
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
    const { arrivo, partenza, notti, struttura, lang = "it", ospiti = [] } = req.body || {};
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

    // verifica identità "de visu": selfie del capogruppo (confronto fatto nel browser
    // dell'ospite). Salviamo il selfie su Blob come prova + l'esito del confronto.
    let deVisuSalvata = null;
    const dv = (req.body || {}).deVisu;
    if (dv && dv.selfie) {
      let selfieUrl = "";
      try {
        const blobSelfie = await put(`devisu/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`, toBuffer(dv.selfie), {
          access: "public",
          contentType: "image/jpeg",
        });
        selfieUrl = blobSelfie.url;
      } catch (e) {
        /* selfie non salvato: la verifica resta registrata con il solo esito */
      }
      deVisuSalvata = {
        esito: String(dv.esito || "non_disponibile"),
        distanza: typeof dv.distanza === "number" ? dv.distanza : null,
        tentativi: Number(dv.tentativi) || 0,
        ts: Number(dv.ts) || Date.now(),
        selfieUrl,
      };
    }

    // contratto di locazione turistica: solo se la struttura ha una config (CONTRATTI_STRUTTURE)
    // e l'ospite ha effettivamente firmato. Il PDF viene generato, mandato via email e
    // salvato su Blob insieme alle foto, così resta consultabile nell'archivio della prenotazione.
    const cfgContratto = getContrattoStruttura(struttura);
    const firma = (req.body || {}).firma;
    const emailOspite = String((req.body || {}).emailOspite || "").trim();
    let contrattoInviato = false;
    let contrattoErrore = "";
    let contrattoPdfBase64 = ""; // restituito al browser per il pulsante "Scarica PDF" dell'ospite
    let contrattoUrl = ""; // URL su Blob, per rivedere il contratto dall'archivio admin
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
          // prima pagina nella lingua in cui l'ospite ha letto e firmato; se non è
          // l'italiano, segue una seconda pagina in italiano (copia per il locatore)
          const pagine = [{ blocchi: testoContratto(cfgContratto, dati, lang), firmaLabel: firmaLabel(lang) }];
          if (lang !== "it") pagine.push({ blocchi: testoContratto(cfgContratto, dati, "it"), firmaLabel: firmaLabel("it") });
          const pdfBuffer = await generaContrattoPdf({
            pagine,
            firmaPngBuffer: toBuffer(firma),
            dataFirma: dati.dataFirma,
            ip: clientIp(req),
          });
          contrattoPdfBase64 = pdfBuffer.toString("base64");
          const nomeOspiteFile = (dati.conduttoreNome || "ospite").trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, "");
          const nomeFilePdf = `contratto_${dati.arrivo}_${nomeOspiteFile}.pdf`;
          // salva il contratto su Blob, così resta nell'archivio della prenotazione (non solo via email)
          try {
            const blobPdf = await put(`contratti/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nomeFilePdf}`, pdfBuffer, {
              access: "public",
              contentType: "application/pdf",
            });
            contrattoUrl = blobPdf.url;
          } catch (e) {
            /* salvataggio non riuscito: il contratto parte comunque via email, non blocca il check-in */
          }
          const nomeStruttura = strutturaInfo ? strutturaInfo.nome : struttura;
          const testiOspite = emailOspiteTesti(lang, { nomeStruttura, arrivo, partenza });
          // Host (obbligatoria, sempre in italiano) + eventuale copia all'ospite (nella SUA lingua),
          // IN PARALLELO ma ENTRAMBE attese: su Vercel un invio non atteso verrebbe interrotto
          // quando la funzione risponde (era il motivo per cui all'ospite non arrivava nulla).
          const [esitoHost] = await Promise.all([
            inviaEmailConAllegato({
              to: cfgContratto.email,
              subject: `Contratto firmato · ${nomeStruttura} · ${dati.conduttoreNome}`,
              testo: `In allegato il contratto di locazione turistica firmato da ${dati.conduttoreNome}, soggiorno dal ${arrivo} al ${partenza}.\n\nInviato automaticamente da KeyFlow: non è stato salvato altrove.`,
              allegatoNome: nomeFilePdf,
              allegatoBuffer: pdfBuffer,
            }),
            emailOspite
              ? inviaEmailConAllegato({
                  to: emailOspite,
                  subject: testiOspite.subject,
                  testo: testiOspite.testo,
                  allegatoNome: nomeFilePdf,
                  allegatoBuffer: pdfBuffer,
                })
              : Promise.resolve(null),
          ]);
          contrattoInviato = esitoHost.ok;
          if (!esitoHost.ok) contrattoErrore = esitoHost.error || "invio email non riuscito";
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
      contrattoUrl,
      deVisu: deVisuSalvata,
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

    return res.status(200).json({ ok: true, contrattoPdfBase64 });
  } catch (e) {
    return res.status(500).json({ error: `Errore generico: ${String(e.message || e)}` });
  }
};
