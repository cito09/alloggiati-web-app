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
  const GIORNI = 14;
  const soglia = Date.now() - GIORNI * 86400000;
  const tsDaPath = (p) => { const m = /\/(\d{13})-/.exec("/" + p); return m ? Number(m[1]) : 0; };

  const [contratti, foto] = await Promise.all([
    list({ prefix: "contratti/", limit: 1000 }),
    list({ prefix: "checkin/", limit: 1000 }),
  ]);

  const urlInCoda = new Set();
  coda.forEach((v) => {
    if (v.contrattoUrl) urlInCoda.add(v.contrattoUrl);
    (v.ospiti || []).forEach((o) => (o.fotoUrls || []).forEach((u) => urlInCoda.add(u)));
  });

  const fotoRecenti = foto.blobs
    .map((b) => ({ url: b.url, ts: tsDaPath(b.pathname) || new Date(b.uploadedAt).getTime() }))
    .filter((f) => f.ts > soglia && !urlInCoda.has(f.url));

  const nuove = [];
  const fotoUsate = new Set();

  for (const c of contratti.blobs) {
    if (urlInCoda.has(c.url)) continue;
    const ts = tsDaPath(c.pathname) || new Date(c.uploadedAt).getTime();
    if (ts < soglia) continue;
    const m = /contratto_(\d{2})-(\d{2})-(\d{4})_(.+)\.pdf$/.exec(c.pathname);
    if (!m) continue;
    const arrivo = `${m[1]}/${m[2]}/${m[3]}`;
    const nome = m[4].replace(/_/g, " ");
    // foto caricate nello stesso invio: entro 30 minuti dal contratto
    const vicine = fotoRecenti.filter((f) => !fotoUsate.has(f.url) && Math.abs(f.ts - ts) < 30 * 60 * 1000);
    vicine.forEach((f) => fotoUsate.add(f.url));
    nuove.push({
      id: `recupero-${ts}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      strutturaId: "",
      strutturaNome: "recuperato — verifica struttura",
      arrivo,
      partenza: "",
      notti: 0,
      ospiti: [{ cognome: nome, nome: "", fotoUrls: vicine.map((f) => f.url), incertezze: [] }],
      contrattoRichiesto: true,
      contrattoInviato: true,
      contrattoUrl: c.url,
      recuperato: true,
    });
  }

  // foto orfane (non vicine a nessun contratto): raggruppate in un'unica voce da smistare
  const orfane = fotoRecenti.filter((f) => !fotoUsate.has(f.url));
  if (orfane.length) {
    nuove.push({
      id: `recupero-foto-${Date.now()}`,
      ts: Date.now(),
      strutturaId: "",
      strutturaNome: "foto recuperate — da smistare",
      arrivo: "",
      partenza: "",
      notti: 0,
      ospiti: [{ cognome: "FOTO RECUPERATE", nome: "", fotoUrls: orfane.map((f) => f.url), incertezze: [] }],
      recuperato: true,
    });
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
      const { id } = req.body || {};
      const raw = await redisCmd(conn, ["GET", KEY]);
      const coda = (raw ? JSON.parse(raw) : []).filter((v) => v.id !== id);
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
