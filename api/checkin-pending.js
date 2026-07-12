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

const KEY = "checkin_pending";

async function ripristinaDaBlob(coda) {
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

  const urlInCoda = new Set();
  coda.forEach((v) => {
    if (v.contrattoUrl) urlInCoda.add(v.contrattoUrl);
    (v.ospiti || []).forEach((o) => (o.fotoUrls || []).forEach((u) => urlInCoda.add(u)));
  });

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
  const conn = upstash();
  if (!conn) return res.status(200).json({ configurato: false, coda: [] });

  try {
    if (req.method === "GET") {
      const raw = await redisCmd(conn, ["GET", KEY]);
      return res.status(200).json({ configurato: true, coda: raw ? JSON.parse(raw) : [] });
    }
    if (req.method === "DELETE") {
      // { id } per una voce sola, { ids:[...] } per la pulizia multipla dal pannello recupero
      const { id, ids } = req.body || {};
      const daEliminare = new Set(Array.isArray(ids) ? ids : id ? [id] : []);
      const raw = await redisCmd(conn, ["GET", KEY]);
      const coda = (raw ? JSON.parse(raw) : []).filter((v) => !daEliminare.has(v.id));
      await redisCmd(conn, ["SET", KEY, JSON.stringify(coda)]);
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

      if (azione === "ripristina") {
        if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(400).json({ error: "Archivio foto (Blob) non configurato" });
        const nuove = await ripristinaDaBlob(coda);
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
