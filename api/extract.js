// api/extract.js — estrazione dati dalle foto (Claude vision, chiave lato server)
// POST { images: [dataURL|base64...], kind: 'documento'|'prenotazione'|'auto' }
const CAMPI_OSPITE = `{"cognome":string|null,"nome":string|null,"sesso":"M"|"F"|null,"data_nascita":"gg/mm/aaaa"|null,"comune_nascita":string|null,"stato_nascita":string|null,"cittadinanza":string|null,"tipo_documento":string|null,"numero_documento":string|null,"luogo_rilascio":string|null,"incertezze":string[]}`;
const REGOLE_OSPITE = `date sempre gg/mm/aaaa, ANNO A 4 CIFRE letto con attenzione dal documento (non indovinare, non arrotondare, non confondere con l'anno corrente). Nomi di stati SEMPRE per esteso nella forma ufficiale italiana usata dall'anagrafica della Polizia di Stato (es. "STATI UNITI D'AMERICA" non "Stati Uniti", "REGNO UNITO" non "Inghilterra", "PAESI BASSI" non "Olanda"); nomi di comuni in ITALIANO MAIUSCOLO (es. ROMA, MILANO). ATTENZIONE cittadinanza (e stato_nascita): metti sempre il NOME DELLO STATO, MAI l'aggettivo di nazionalità. I documenti riportano la nazionalità come aggettivo nella lingua locale (es. "POLSKIE", "POLISH", "DEUTSCH", "ESPAÑOLA", "FRANÇAISE"): tu convertila SEMPRE nel nome dello stato in italiano. Esempi: "POLSKIE"→"POLONIA" (NON "POLACCA"), "DEUTSCH"→"GERMANIA" (NON "TEDESCA"), "ESPAÑOLA"→"SPAGNA" (NON "SPAGNOLA"), "FRANÇAISE"→"FRANCIA" (NON "FRANCESE"). Scrivere l'aggettivo ("POLACCA", "TEDESCA", ecc.) è un ERRORE che blocca la pratica. comune_nascita SOLO se nato in Italia; altrimenti null. stato_nascita sempre. tipo_documento tra: "CARTA DI IDENTITA'","CARTA IDENTITA' ELETTRONICA","PASSAPORTO ORDINARIO","PATENTE DI GUIDA". luogo_rilascio = comune italiano se documento italiano, altrimenti stato emittente. Dato non leggibile = null.
DOPPIA VERIFICA numero_documento: molti documenti (in particolare i passaporti) riportano il numero documento DUE VOLTE nella stessa immagine: una volta stampato in chiaro vicino alla foto, e una volta dentro le righe MRZ in fondo alla pagina (la striscia con tanti simboli "<", sono i primi 9 caratteri della seconda riga). Se l'immagine mostra entrambe, leggile e confrontale carattere per carattere prima di rispondere. Se coincidono, usa quel valore con sicurezza. Se differiscono anche di un solo carattere, o se vedi una sola delle due fonti e non sei certo al 100% di ogni cifra, scrivi comunque la lettura più probabile MA aggiungi "numero_documento" all'array "incertezze".
COGNOME E NOME COMPOSTI (molto importante, errore frequente): per cognome e nome usa SEMPRE come fonte principale i campi stampati in chiaro sul documento con etichetta esplicita (es. "Cognome"/"Surname"/"Nom"/"Apellidos" per il cognome; "Nome"/"Given names"/"Prénoms"/"Nombres" per il nome) — sono più affidabili della zona MRZ. Riporta cognome e nome COMPLETI, anche se composti da più parole (es. cognome doppio "SMITH-COOK", nome doppio "AMIRA LEE"): non spezzare mai un cognome doppio mettendone una parte nel campo nome, e non perdere nessuna parola del nome. Se usi anche la zona MRZ come riferimento, ricorda la sua sintassi: il cognome e il nome sono separati dal DOPPIO simbolo "<<", mentre un SINGOLO "<" dentro la stessa parte è solo uno spazio tra parole dello STESSO campo (es. tra le due parole di un cognome o nome composto) — non confondere mai un singolo "<" con il separatore tra cognome e nome. Se il campo stampato in chiaro e la lettura della MRZ non coincidono per cognome o nome, aggiungi quel campo a "incertezze".
Per ogni altro campo dove non sei sicuro di aver letto bene (foto sfocata, riflesso, carattere ambiguo), aggiungi il nome di quel campo (es. "data_nascita", "cognome") all'array "incertezze". Se sei sicuro di tutto, "incertezze" è un array vuoto [].`;

const PROMPT_DOC = `Sei un estrattore dati per la schedina italiana Alloggiati Web. Dalle immagini del documento d'identità estrai i dati. Rispondi SOLO con JSON valido, nessun altro testo, nessun backtick:
${CAMPI_OSPITE}
Regole: ${REGOLE_OSPITE}`;

function promptBooking(oggi) {
  return `Oggi è ${oggi}. Dallo screenshot di una prenotazione estrai le date di un soggiorno futuro o recente (vicino a oggi). Rispondi SOLO con JSON: {"data_arrivo":"gg/mm/aaaa"|null,"data_partenza":"gg/mm/aaaa"|null,"numero_notti":number|null}. Se vedi check-in e check-out calcola le notti come differenza. Se l'anno non è scritto esplicitamente nello screenshot, usa l'anno più vicino a oggi (oggi o il prossimo) che renda coerenti le date del soggiorno: NON usare mai un anno passato a caso, e non confondere l'anno con quello di altre cifre presenti nello screenshot.`;
}

// 'auto': riceve immagini MISTE (screenshot prenotazione + foto documenti) e le separa da solo.
function promptAuto(oggi) {
  return `Oggi è ${oggi}. Ricevi una o più immagini che possono essere di due tipi: (a) screenshot di una prenotazione (Airbnb, Booking, ecc.) oppure (b) foto di documenti d'identità (passaporto, carta d'identità, patente). Classifica ogni immagine ed estrai i dati. Rispondi SOLO con JSON valido, nessun altro testo, nessun backtick:
{"prenotazione":{"data_arrivo":"gg/mm/aaaa"|null,"data_partenza":"gg/mm/aaaa"|null,"numero_notti":number|null},"ospiti":[${CAMPI_OSPITE}]}
Regole:
- "ospiti": UNA voce per ogni DOCUMENTO d'identità. NON creare ospiti dagli screenshot di prenotazione (i nomi nello screenshot NON sono ospiti).
- Se due foto sono fronte/retro o due pagine dello STESSO documento, sono UN solo ospite.
- "prenotazione": ricava le date dallo screenshot, un soggiorno futuro o recente (vicino a oggi). Se vedi check-in e check-out calcola numero_notti come differenza. Se l'anno non è scritto esplicitamente, usa l'anno più vicino a oggi (oggi o il prossimo) che renda coerenti le date: NON usare mai un anno passato a caso. Se non c'è nessuno screenshot, metti i campi a null.
- Se non ci sono documenti, "ospiti": [].
- Per ogni ospite (data di nascita: leggi l'anno con attenzione dal documento, può essere molto nel passato, va bene così): ${REGOLE_OSPITE}`;
}

// accetta sia data-URL (foto caricate dal browser) sia URL http(s) (foto gia' su Vercel Blob,
// es. quelle arrivate dal self check-in): in quel caso le scarica e le converte lato server.
async function toBlock(d) {
  if (/^https?:\/\//i.test(d)) {
    const r = await fetch(d);
    const buf = Buffer.from(await r.arrayBuffer());
    const media = r.headers.get("content-type") || "image/jpeg";
    return { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } };
  }
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
    const content = await Promise.all(images.map(toBlock));
    const oggi = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
    const prompt = kind === "prenotazione" ? promptBooking(oggi) : kind === "auto" ? promptAuto(oggi) : PROMPT_DOC;
    content.push({ type: "text", text: prompt });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 2000, messages: [{ role: "user", content }] }),
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
