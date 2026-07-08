// api/ross.js — integrazione Ross1000 (rilevazione flussi turistici ISTAT, es. Emilia-Romagna)
// POST { azione:'file'|'invia', struttura:'bologna', arrivo:'gg/mm/aaaa', notti:N,
//        ospiti:[{idswh,tipoalloggiato,idcapo,cognome,nome,sesso,cittadinanza,statoresidenza,
//                 luogoresidenza,datanascita,statonascita,comunenascita}] }
// - 'file'  → restituisce l'XML nel tracciato ufficiale GIES/Ross1000, da importare a mano
//             sul portale (check-in → importa file gestionale)
// - 'invia' → trasmette direttamente via web service SOAP (operazione inviaMovimentazione,
//             autenticazione HTTP Basic), endpoint .../ws/checkinV2
// Config nella variabile d'ambiente ROSS_STRUTTURE (JSON su una riga):
// [{"id":"bologna","codice":"CODICE_STRUTTURA","utente":"...","password":"...",
//   "cameredisponibili":2,"lettidisponibili":4,
//   "endpoint":"https://datiturismo.regione.emilia-romagna.it"}]
// "codice" è l'identificativo struttura assegnato dalla Regione (obbligatorio per il file);
// "utente"/"password" sono le credenziali di trasmissione web service (servono solo per 'invia').

const { checkAdmin } = require("./_admin");

const ENDPOINT_DEFAULT = "https://datiturismo.regione.emilia-romagna.it";
const PRODOTTO = "KeyFlow";
const ITALIA = "100000100";

function getRossStrutture() {
  try { return JSON.parse(process.env.ROSS_STRUTTURE || "[]"); } catch { return []; }
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function parseGgMmAaaa(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || "");
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}
function aaaammgg(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function xmlArrivo(o) {
  return `<arrivo>
<idswh>${esc(o.idswh)}</idswh>
<tipoalloggiato>${esc(o.tipoalloggiato)}</tipoalloggiato>
<idcapo>${esc(o.idcapo || "")}</idcapo>
<cognome>${esc(o.cognome)}</cognome>
<nome>${esc(o.nome)}</nome>
<sesso>${esc(o.sesso)}</sesso>
<cittadinanza>${esc(o.cittadinanza)}</cittadinanza>
<statoresidenza>${esc(o.statoresidenza)}</statoresidenza>
<luogoresidenza>${esc(o.luogoresidenza)}</luogoresidenza>
<datanascita>${esc(o.datanascita)}</datanascita>
<statonascita>${esc(o.statonascita)}</statonascita>
<comunenascita>${esc(o.statonascita === ITALIA ? o.comunenascita || "" : "")}</comunenascita>
<tipoturismo>Non specificato</tipoturismo>
<mezzotrasporto>Non Specificato</mezzotrasporto>
<canaleprenotazione>Indiretta web</canaleprenotazione>
<titolostudio></titolostudio>
<professione></professione>
<esenzioneimposta></esenzioneimposta>
</arrivo>`;
}

// Un <movimento> per ogni giorno del soggiorno: il giorno di arrivo contiene gli <arrivi>,
// quello di partenza le <partenze>, i giorni intermedi solo l'occupazione della struttura.
function buildMovimenti(conf, arrivoDate, notti, ospiti) {
  const out = [];
  for (let i = 0; i <= notti; i++) {
    const d = new Date(arrivoDate.getTime());
    d.setDate(d.getDate() + i);
    const isArrivo = i === 0;
    const isPartenza = i === notti;
    const occupate = isPartenza ? 0 : Number(conf.cameredisponibili) || 1;
    let m = `<movimento>
<data>${aaaammgg(d)}</data>
<struttura>
<apertura>SI</apertura>
<camereoccupate>${occupate}</camereoccupate>
<cameredisponibili>${Number(conf.cameredisponibili) || 1}</cameredisponibili>
<lettidisponibili>${Number(conf.lettidisponibili) || 2}</lettidisponibili>
</struttura>`;
    if (isArrivo) m += `\n<arrivi>\n${ospiti.map(xmlArrivo).join("\n")}\n</arrivi>`;
    if (isPartenza) m += `\n<partenze>\n${ospiti.map((o) =>
      `<partenza>\n<idswh>${esc(o.idswh)}</idswh>\n<tipoalloggiato>${esc(o.tipoalloggiato)}</tipoalloggiato>\n<arrivo>${aaaammgg(arrivoDate)}</arrivo>\n</partenza>`).join("\n")}\n</partenze>`;
    m += `\n</movimento>`;
    out.push(m);
  }
  return out.join("\n");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAdmin(req)) return res.status(401).json({ error: "Accesso non autorizzato" });
  try {
    const { azione, struttura, arrivo, notti, ospiti = [] } = req.body || {};
    const conf = getRossStrutture().find((s) => s.id === struttura);
    if (!conf) return res.status(400).json({ error: "Ross1000 non configurato per questa struttura (variabile ROSS_STRUTTURE)" });
    if (!conf.codice) return res.status(400).json({ error: "Manca il codice struttura Ross1000 (campo \"codice\" in ROSS_STRUTTURE)" });

    const arrivoDate = parseGgMmAaaa(arrivo);
    const n = Number(notti);
    if (!arrivoDate || !(n > 0)) return res.status(400).json({ error: "Date del soggiorno non valide" });
    if (!ospiti.length) return res.status(400).json({ error: "Nessun ospite completo da trasmettere" });

    const movimenti = buildMovimenti(conf, arrivoDate, n, ospiti);
    const corpo = `<codice>${esc(conf.codice)}</codice>\n<prodotto>${PRODOTTO}</prodotto>\n${movimenti}`;

    if (azione === "file") {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<movimenti>\n${corpo}\n</movimenti>\n`;
      return res.status(200).json({ ok: true, xml, filename: `ross1000_${aaaammgg(arrivoDate)}.xml` });
    }

    // azione 'invia': web service SOAP con HTTP Basic
    if (!conf.utente || !conf.password) {
      return res.status(400).json({ error: "Credenziali web service Ross1000 non configurate: usa \"Scarica Ross1000 (.xml)\" e importa il file dal portale, oppure aggiungi utente/password in ROSS_STRUTTURE" });
    }
    const soap = `<?xml version="1.0"?>\n<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">\n<S:Body>\n<ns2:inviaMovimentazione xmlns:ns2="http://checkin.ws.service.turismo5.gies.it/">\n<movimentazione>\n${corpo}\n</movimentazione>\n</ns2:inviaMovimentazione>\n</S:Body>\n</S:Envelope>`;
    const endpoint = (conf.endpoint || ENDPOINT_DEFAULT).replace(/\/$/, "") + "/ws/checkinV2";
    const auth = Buffer.from(`${conf.utente}:${conf.password}`).toString("base64");
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=UTF-8", Authorization: `Basic ${auth}` },
      body: soap,
    });
    const testo = await r.text();
    const fault = /<\s*\S*:?fault/i.test(testo);
    if (!r.ok || fault) {
      const dettaglio = testo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      return res.status(502).json({ error: `Ross1000 ha risposto con un errore (HTTP ${r.status}): ${dettaglio || "nessun dettaglio"}` });
    }
    return res.status(200).json({ ok: true, esito: testo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
