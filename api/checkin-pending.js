// api/checkin-pending.js — coda ospiti in attesa di verifica (self check-in), uso lato admin
// GET -> { configurato, coda }
// DELETE { id } -> rimuove una voce (dopo l'invio ufficiale alla Questura, o se scartata)
// POST { azione:'presa', id } -> segna una voce come "già aggiunta alla prenotazione" (resta
//        in coda finché non viene inviata: se l'app si chiude prima dell'invio, nulla si perde)
// POST { azione:'ripristina' } -> RECUPERO: ricostruisce le voci perse ripescando dall'archivio
//        foto (Vercel Blob) i contratti firmati e le foto documenti non più presenti in coda.
//        Il nome file del contratto contiene arrivo e nome dell'ospite; le foto vengono
//        riagganciate per vicinanza temporale (stesso invio di check-in).
const { list } = require("@vercel/blob");
const { upstash, redisCmd } = require("./_kv");
const { checkAdmin } = require("./_admin");
const { leggiBlob, salvaBlob, eliminaBlob, isBlobUrl, isPrivateBlob, HA_STORE_PRIVATO } = require("./_blob");

const KEY = "checkin_pending";
// URL (foto/contratti/selfie) delle voci ELIMINATE dalla coda: il recupero non deve
// più ripescarle dall'archivio Blob, altrimenti i check-in scartati "risorgono" a ogni
// ripristino (test, doppioni, voci già gestite).
const KEY_SCARTATI = "checkin_scartati";
function urlDiVoce(v) {
  const out = [];
  if (v.contrattoUrl) out.push(v.contrattoUrl);
  if (v.deVisu && v.deVisu.selfieUrl) out.push(v.deVisu.selfieUrl);
  (v.ospiti || []).forEach((o) => (o.fotoUrls || []).forEach((u) => out.push(u)));
  return out;
}

async function ripristinaDaBlob(coda, scartati) {
  const GIORNI = 21;
  const soglia = Date.now() - GIORNI * 86400000;
  // stesso "invio" di check-in = file caricati a pochi secondi/minuti l'uno dall'altro.
  // Raggruppando per vicinanza temporale, foto e contratto dello stesso ospite restano uniti.
  const GAP = 20 * 60 * 1000;
  const tsDaPath = (p) => { const m = /(?:^|\/)(\d{13})-/.exec(p); return m ? Number(m[1]) : 0; };

  const [contratti, foto] = await Promise.all([
    list({ prefix: "contratti/", limit: 1000 }),
    list({ prefix: "checkin/", limit: 1000 }),
  ]);

  const urlInCoda = new Set(scartati || []);
  coda.forEach((v) => urlDiVoce(v).forEach((u) => urlInCoda.add(u)));

  const item = (b, tipo) => ({ tipo, url: b.url, pathname: b.pathname, ts: tsDaPath(b.pathname) || new Date(b.uploadedAt).getTime() });
  const blobs = [
    ...foto.blobs.map((b) => item(b, "foto")),
    ...contratti.blobs.map((b) => item(b, "contratto")),
  ]
    .filter((b) => b.ts > soglia && !urlInCoda.has(b.url))
    .sort((a, b) => a.ts - b.ts);

  // raggruppa i blob in "invii": nuovo gruppo quando il salto dal file precedente supera GAP
  const gruppi = [];
  let g = null;
  for (const b of blobs) {
    if (!g || b.ts - g.tsUltimo > GAP) { g = { items: [b], tsUltimo: b.ts }; gruppi.push(g); }
    else { g.items.push(b); g.tsUltimo = b.ts; }
  }

  const datiDaContratto = (pathname) => {
    const m = /contratto_(\d{2})-(\d{2})-(\d{4})_(.+)\.pdf$/.exec(pathname);
    return m ? { arrivo: `${m[1]}/${m[2]}/${m[3]}`, nome: m[4].replace(/_/g, " ") } : null;
  };
  const dataIt = (ts) => new Date(ts).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  const nuove = [];
  for (const gr of gruppi) {
    const contrattiGr = gr.items.filter((b) => b.tipo === "contratto");
    const fotoUrls = gr.items.filter((b) => b.tipo === "foto").map((f) => f.url);
    const tsGr = gr.items[0].ts;

    if (contrattiGr.length) {
      // invio con contratto: nome/arrivo dal contratto, foto dello stesso invio già agganciate.
      // Il primo contratto tiene le foto; eventuali contratti extra (raro) diventano voci a parte.
      contrattiGr.forEach((c, idx) => {
        const d = datiDaContratto(c.pathname);
        nuove.push({
          id: `recupero-${tsGr}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          ts: Date.now(),
          strutturaId: "",
          strutturaNome: "recuperato — verifica struttura",
          arrivo: d ? d.arrivo : "",
          partenza: "",
          notti: 0,
          ospiti: [{ cognome: d ? d.nome : "ospite", nome: "", fotoUrls: idx === 0 ? fotoUrls : [], incertezze: [] }],
          contrattoRichiesto: true,
          contrattoInviato: true,
          contrattoUrl: c.url,
          recuperato: true,
        });
      });
    } else if (fotoUrls.length) {
      // invio di sole foto (nessun contratto): una voce da smistare per invio, con la data
      // così l'host capisce a quale arrivo appartengono senza mescolare invii diversi.
      nuove.push({
        id: `recupero-foto-${tsGr}`,
        ts: Date.now(),
        strutturaId: "",
        strutturaNome: `foto recuperate — da smistare (${dataIt(tsGr)})`,
        arrivo: "",
        partenza: "",
        notti: 0,
        ospiti: [{ cognome: "FOTO RECUPERATE", nome: "", fotoUrls, incertezze: [] }],
        recuperato: true,
      });
    }
  }

  return nuove;
}

module.exports = async (req, res) => {
  if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });

  // Proxy foto/contratti: i file del check-in sono privati (non apribili da link diretto).
  // Il gestionale li richiede qui — solo dopo checkAdmin — e noi li rileggiamo col token e li
  // restituiamo. Così documenti e selfie non sono più pubblici, ma tu li vedi comunque.
  if (req.method === "GET" && req.query && req.query.img) {
    const url = String(req.query.img || "");
    if (!isBlobUrl(url)) return res.status(400).json({ error: "url non valido" });
    try {
      const r = await leggiBlob(url);
      if (!r) return res.status(404).json({ error: "file non trovato" });
      res.setHeader("Content-Type", r.contentType || (/\.pdf(\?|$)/i.test(url) ? "application/pdf" : "image/jpeg"));
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.status(200).send(r.buffer);
    } catch (e) {
      return res.status(502).json({ error: "errore lettura file" });
    }
  }

  const conn = upstash();
  if (!conn) return res.status(200).json({ configurato: false, coda: [] });

  try {
    if (req.method === "GET") {
      const raw = await redisCmd(conn, ["GET", KEY]);
      return res.status(200).json({ configurato: true, coda: raw ? JSON.parse(raw) : [] });
    }
    if (req.method === "DELETE") {
      // { id } per una voce sola, { ids:[...] } per la pulizia multipla dal pannello recupero.
      // Con { definitivo:true } (invio ufficiale avvenuto o pulizia) gli URL delle voci rimosse
      // finiscono tra gli scartati e non verranno più ripescati dall'archivio; lo "Scarta"
      // normale invece resta recuperabile con il ripristino.
      const { id, ids, definitivo } = req.body || {};
      const daEliminare = new Set(Array.isArray(ids) ? ids : id ? [id] : []);
      const raw = await redisCmd(conn, ["GET", KEY]);
      const tutte = raw ? JSON.parse(raw) : [];
      const rimosse = tutte.filter((v) => daEliminare.has(v.id));
      const coda = tutte.filter((v) => !daEliminare.has(v.id));
      await redisCmd(conn, ["SET", KEY, JSON.stringify(coda)]);
      if (rimosse.length && definitivo) {
        try {
          const rawS = await redisCmd(conn, ["GET", KEY_SCARTATI]);
          let scartati = rawS ? JSON.parse(rawS) : [];
          rimosse.forEach((v) => scartati.push(...urlDiVoce(v)));
          scartati = [...new Set(scartati)];
          if (scartati.length > 3000) scartati = scartati.slice(-3000);
          await redisCmd(conn, ["SET", KEY_SCARTATI, JSON.stringify(scartati)]);
        } catch (e) {
          /* lista scartati non aggiornata: la voce resta comunque eliminata dalla coda */
        }
      }
      return res.status(200).json({ configurato: true, coda });
    }
    if (req.method === "POST") {
      const { azione, id } = req.body || {};
      const raw = await redisCmd(conn, ["GET", KEY]);
      let coda = raw ? JSON.parse(raw) : [];

      if (azione === "presa") {
        coda = coda.map((v) => (v.id === id ? { ...v, presa: true } : v));
        await redisCmd(conn, ["SET", KEY, JSON.stringify(coda)]);
        return res.status(200).json({ configurato: true, coda });
      }

      if (azione === "diagnosi") {
        // controllo rapido dell'archivio foto: dice se lo store privato è configurato e
        // dove finiscono DAVVERO i nuovi file (fa un mini-upload di prova e lo cancella).
        const out = { configurato: true, privatoConfigurato: HA_STORE_PRIVATO, tokenPubblico: !!process.env.BLOB_READ_WRITE_TOKEN };
        try {
          const test = await salvaBlob("diagnosi/test.txt", Buffer.from("ok"), "text/plain");
          out.testUrl = test.url;
          out.testPrivato = isPrivateBlob(test.url);
          try { await eliminaBlob(test.url); } catch (e) { /* file di prova non cancellato: innocuo */ }
        } catch (e) { out.testErrore = String((e && e.message) || e); }
        return res.status(200).json(out);
      }

      if (azione === "privatizza") {
        // sposta i file PUBBLICI già caricati (vecchio store) nel NUOVO store privato:
        // legge l'originale pubblico, lo ricarica come privato (salvaBlob usa il token del nuovo
        // store) e cancella l'originale SOLO dopo. A lotti, richiamato finché restano file.
        if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(400).json({ error: "Archivio foto (Blob) non configurato" });
        if (!HA_STORE_PRIVATO) return res.status(400).json({ error: "Lo store privato non è ancora collegato: crea lo store Blob con accesso Private, spunta il token (BLOB_PRIVATE_READ_WRITE_TOKEN) e rifai il deploy." });
        const LOTTO = 10;
        const pubblici = [];
        let cursor;
        do {
          const r = await list({ limit: 1000, cursor });
          for (const b of r.blobs) if (/\.public\.blob\.vercel-storage\.com\//i.test(b.url)) pubblici.push(b);
          cursor = r.hasMore ? r.cursor : null;
        } while (cursor);

        const lotto = pubblici.slice(0, LOTTO);
        const mappa = {};
        let primoErrore = "", esempioNuovo = "";
        for (const b of lotto) {
          try {
            const resp = await fetch(b.url);                     // l'originale è pubblico: si legge con un fetch
            if (!resp.ok) throw new Error("lettura originale HTTP " + resp.status);
            const buf = Buffer.from(await resp.arrayBuffer());
            const isPdf = /\.pdf$/i.test(b.pathname);
            const nuovo = await salvaBlob(b.pathname, buf, isPdf ? "application/pdf" : "image/jpeg");
            if (!esempioNuovo) esempioNuovo = nuovo.url;
            if (!isPrivateBlob(nuovo.url)) {
              // il file di prova è tornato pubblico: lo store privato non sta funzionando, fermarsi.
              try { await eliminaBlob(nuovo.url); } catch (e) { /* pulizia del doppione */ }
              return res.status(200).json({ configurato: true, migrati: 0, restano: pubblici.length, privateNonSupportato: true, esempioNuovo: nuovo.url });
            }
            mappa[b.url] = nuovo.url;
            try { await eliminaBlob(b.url); } catch (e) { /* originale non cancellato: resterà, si ritenta dopo */ }
          } catch (e) { if (!primoErrore) primoErrore = String((e && e.message) || e); }
        }
        const migrati = Object.keys(mappa).length;
        if (migrati) {
          const sostituisci = (v) => {
            if (typeof v === "string") return mappa[v] || v;
            if (Array.isArray(v)) return v.map(sostituisci);
            if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = sostituisci(v[k]); return o; }
            return v;
          };
          // aggiorna i riferimenti agli URL nei tre archivi server: coda, scartati, storico
          for (const K of [KEY, KEY_SCARTATI, "storico_schedine"]) {
            try {
              const raw = await redisCmd(conn, ["GET", K]);
              if (raw) { const upd = sostituisci(JSON.parse(raw)); await redisCmd(conn, ["SET", K, JSON.stringify(upd)]); }
            } catch (e) { /* un archivio non aggiornato non blocca gli altri */ }
          }
        }
        return res.status(200).json({ configurato: true, migrati, restano: pubblici.length - migrati, mappa, pubbliciTotali: pubblici.length, esempioNuovo, errore: primoErrore });
      }

      if (azione === "ripristina") {
        if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(400).json({ error: "Archivio foto (Blob) non configurato" });
        let scartati = [];
        try { const rawS = await redisCmd(conn, ["GET", KEY_SCARTATI]); scartati = rawS ? JSON.parse(rawS) : []; } catch (e) {}
        const nuove = await ripristinaDaBlob(coda, scartati);
        coda = [...nuove, ...coda];
        await redisCmd(conn, ["SET", KEY, JSON.stringify(coda)]);
        return res.status(200).json({ configurato: true, coda, ripristinate: nuove.length });
      }

      return res.status(400).json({ error: "Azione sconosciuta" });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
