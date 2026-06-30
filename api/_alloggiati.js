// api/_alloggiati.js — helper condiviso per il web service Alloggiati Web (SOAP 1.1)
const ENDPOINT = "https://alloggiatiweb.poliziadistato.it/service/Service.asmx";
const NS = "AlloggiatiService";

const xmlEsc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// data 'YYYY-MM-DD' nel fuso orario italiano (non UTC: vicino a mezzanotte sarebbero giorni diversi),
// con possibilità di andare indietro di N giorni
function dataItalia(giorniIndietro = 0) {
  const d = new Date(Date.now() - giorniIndietro * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function envelope(inner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${inner}</soap:Body>
</soap:Envelope>`;
}

async function soap(action, inner) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"${NS}/${action}"`,
    },
    body: envelope(inner),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SOAP ${action} HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text;
}

// estrai tutti i match di un tag (flat)
const allTags = (xml, tag) => {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};
const oneTag = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
};

// Genera un token valido a partire dalle credenziali della struttura
async function generateToken({ utente, password, wskey }) {
  if (!utente || !password || !wskey) {
    const mancanti = [!utente && "utente", !password && "password", !wskey && "wskey"].filter(Boolean).join(", ");
    throw new Error(`GenerateToken: credenziali incomplete per questa struttura (manca: ${mancanti})`);
  }
  const inner = `<GenerateToken xmlns="${NS}"><Utente>${xmlEsc(utente)}</Utente><Password>${xmlEsc(password)}</Password><WsKey>${xmlEsc(wskey)}</WsKey></GenerateToken>`;
  const xml = await soap("GenerateToken", inner);
  const err = oneTag(xml, "ErroreDettaglio") || oneTag(xml, "Errore") || oneTag(xml, "Message");
  if (err && err.trim()) throw new Error(`GenerateToken: ${err}`);
  const token = oneTag(xml, "token") || oneTag(xml, "Token");
  if (!token) throw new Error(`GenerateToken: token non ricevuto. Risposta del portale: ${xml.replace(/\s+/g, " ").slice(0, 600)}`);
  return { token, expires: oneTag(xml, "expires") || oneTag(xml, "Expires") };
}

// Test (validazione) o Send (invio reale) di un elenco di schedine (righe da 168 char)
async function sendSchedine({ utente, token, records, mode }) {
  const action = mode === "send" ? "Send" : "Test";
  const elenco = records.map((r) => `<string>${xmlEsc(r)}</string>`).join("");
  const inner = `<${action} xmlns="${NS}"><Utente>${xmlEsc(utente)}</Utente><token>${xmlEsc(token)}</token><ElencoSchedine>${elenco}</ElencoSchedine></${action}>`;
  const xml = await soap(action, inner);

  // errore generale (es. token scaduto)
  const resultBlock = oneTag(xml, `${action}Result`) || "";
  const topErr = oneTag(resultBlock, "ErroreDettaglio");
  if (topErr && topErr.trim()) throw new Error(`${action}: ${topErr}`);

  const valide = parseInt(oneTag(xml, "SchedineValide") || "0", 10);
  // dettaglio per riga: ErroreDettaglio vuoto = riga ok
  const dettaglioBlock = (xml.match(/<Dettaglio>([\s\S]*?)<\/Dettaglio>/) || [])[1] || "";
  const righe = allTags(dettaglioBlock, "EsitoOperazioneServizio").map((blk, i) => {
    const e = (oneTag(blk, "ErroreDettaglio") || "").trim();
    return { riga: i, ok: e === "", errore: e };
  });
  return { action, valide, totali: records.length, righe };
}

// Ricevuta PDF (base64) per una data 'YYYY-MM-DD'
async function ricevuta({ utente, token, data: giorno }) {
  const inner = `<Ricevuta xmlns="${NS}"><Utente>${xmlEsc(utente)}</Utente><token>${xmlEsc(token)}</token><Data>${giorno}</Data></Ricevuta>`;
  const xml = await soap("Ricevuta", inner);
  const err = oneTag(oneTag(xml, "RicevutaResult") || "", "ErroreDettaglio");
  if (err && err.trim()) throw new Error(`Ricevuta: ${err}`);
  const pdf = oneTag(xml, "PDF");
  if (!pdf || !pdf.trim()) throw new Error("Ricevuta: nessun PDF disponibile per questa data");
  return { pdfBase64: pdf.trim() };
}

// Risolve le credenziali della struttura richiesta dalle env vars.
// Supporta sia una singola struttura (ALLOGGIATI_UTENTE/PASSWORD/WSKEY)
// sia più strutture in ALLOGGIATI_STRUTTURE = JSON [{id,nome,utente,password,wskey}]
function getStrutture() {
  const raw = process.env.ALLOGGIATI_STRUTTURE;
  if (raw) {
    try { return JSON.parse(raw); } catch { /* ignore */ }
  }
  if (process.env.ALLOGGIATI_UTENTE) {
    return [{
      id: "default",
      nome: process.env.ALLOGGIATI_NOME || "Struttura",
      utente: process.env.ALLOGGIATI_UTENTE,
      password: process.env.ALLOGGIATI_PASSWORD,
      wskey: process.env.ALLOGGIATI_WSKEY,
    }];
  }
  return [];
}
function getStruttura(id) {
  const list = getStrutture();
  if (!list.length) throw new Error("Nessuna struttura configurata nelle variabili d'ambiente");
  if (!id || id === "default") return list[0];
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`Struttura '${id}' non trovata`);
  return s;
}

module.exports = { generateToken, sendSchedine, ricevuta, getStrutture, getStruttura, dataItalia };
