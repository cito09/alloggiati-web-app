// api/extract.js — estrazione dati dalle foto (Claude vision, chiave lato server)
// POST { images: [dataURL|base64...], kind: 'documento'|'prenotazione' }
const PROMPT_DOC = `Sei un estrattore dati per la schedina italiana Alloggiati Web. Dalle immagini del documento d'identità estrai i dati. Rispondi SOLO con JSON valido, nessun altro testo, nessun backtick:
{"cognome":string|null,"nome":string|null,"sesso":"M"|"F"|null,"data_nascita":"gg/mm/aaaa"|null,"comune_nascita":string|null,"stato_nascita":string|null,"cittadinanza":string|null,"tipo_documento":string|null,"numero_documento":string|null,"luogo_rilascio":string|null}
Regole: date sempre gg/mm/aaaa. Nomi di stati e comuni in ITALIANO MAIUSCOLO (es. ITALIA, GERMANIA, FRANCIA, REGNO UNITO, STATI UNITI, ROMA, MILANO). comune_nascita SOLO se nato in Italia; altrimenti null. stato_nascita sempre. tipo_documento tra: "CARTA DI IDENTITA'","CARTA IDENTITA' ELETTRONICA","PASSAPORTO ORDINARIO","PATENTE DI GUIDA". luogo_rilascio = comune italiano se documento italiano, altrimenti stato emittente. Dato non leggibile = null.`;

const PROMPT_BOOKING = `Dallo screenshot di una prenotazione estrai le date. Rispondi SOLO con JSON: {"data_arrivo":"gg/mm/aaaa"|null,"data_partenza":"gg/mm/aaaa"|null,"numero_notti":number|null}. Se vedi check-in e check-out calcola le notti come differenza.`;

function toBlock(d) {
  const media = (d.match(/^data:(.*?);base64,/) || [])[1] || "image/jpeg";
  const data = d.includes(",") ? d.split(",")[1] : d;
  return { type: "image", source: { type: "base64", media_type: media, data } };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata" });
  try {
    const { images = [], kind = "documento" } = req.body || {};
    if (!images.length) return res.status(400).json({ error: "Nessuna immagine" });
    const content = images.map(toBlock);
    content.push({ type: "text", text: kind === "prenotazione" ? PROMPT_BOOKING : PROMPT_DOC });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, messages: [{ role: "user", content }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "Errore API" });
    const text = (data.content || []).filter((i) => i.type === "text").map((i) => i.text).join("\n");
    const json = JSON.parse(text.replace(/```json|```/g, "").trim());
    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
