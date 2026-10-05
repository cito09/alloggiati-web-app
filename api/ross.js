// api/ross.js — integrazione Ross1000 (rilevazione flussi turistici ISTAT, es. Emilia-Romagna)
// POST { azione:'file'|'invia', struttura:'bologna', arrivo:'gg/mm/aaaa', notti:N,
//        ospiti:[{idswh,tipoalloggiato,idcapo,cognome,nome,sesso,cittadinanza,statoresidenza,
//                 luogoresidenza,datanascita,statonascita,comunenascita}],
//        soggiorni?:[{arrivo,notti,ospiti}], ts?:<voce dell'Archivio> }
// - 'file'  → restituisce l'XML nel tracciato ufficiale GIES/Ross1000, da importare a mano
//             sul portale (check-in → importa file gestionale)
// - 'invia' → trasmette direttamente via web service SOAP (operazione inviaMovimentazione,
//             autenticazione HTTP Basic), endpoint .../ws/checkinV2
// Con "ts" l'esito dell'invio si segna sulla voce dell'Archivio (storico_schedine): se la
// Regione non risponde, l'invio resta "in coda" con i suoi dati e si rimanda da solo (dal
// gestionale appena lo si apre, e dal promemoria giornaliero del server).
// Config e tracciato: vedi api/_ross.js.

const { checkAdmin } = require("./_admin");
const { upstash } = require("./_kv");
const {
  getRossStrutture, validaSoggiorni, corpoMovimenti, aaaammgg, trasmettiMovimenti,
  aggiornaVoceStorico, campiEsitoRoss, datiDaRimandare,
} = require("./_ross");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await checkAdmin(req))) return res.status(401).json({ error: "Accesso non autorizzato" });
  try {
    const { azione, struttura, arrivo, notti, ospiti = [], soggiorni, ts } = req.body || {};
    const conf = getRossStrutture().find((s) => s.id === struttura);
    if (!conf) return res.status(400).json({ error: "Ross1000 non configurato per questa struttura (variabile ROSS_STRUTTURE)" });
    if (!conf.codice) return res.status(400).json({ error: "Manca il codice struttura Ross1000 (campo \"codice\" in ROSS_STRUTTURE)" });

    // uno o più soggiorni: il file unico "arretrati" ne manda diversi in una volta sola
    const grezzi = Array.isArray(soggiorni) && soggiorni.length ? soggiorni : [{ arrivo, notti, ospiti }];
    const { validati, errore } = validaSoggiorni(grezzi);

    if (azione === "file") {
      if (errore) return res.status(400).json({ error: errore });
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<movimenti>\n${corpoMovimenti(conf, validati)}\n</movimenti>\n`;
      const nome = validati.length > 1
        ? `ross1000_unico_${validati.length}_soggiorni.xml`
        : `ross1000_${aaaammgg(validati[0].arrivoDate)}.xml`;
      return res.status(200).json({ ok: true, xml, filename: nome });
    }

    // azione 'invia': web service SOAP con HTTP Basic (con un tempo massimo di attesa)
    const esito = errore ? { ok: false, status: 400, temporaneo: false, error: errore } : await trasmettiMovimenti(conf, validati);

    // com'è andata si scrive sulla voce dell'Archivio, anche se intanto l'app è stata chiusa
    let registrato = false;
    const voceTs = Number(ts);
    const conn = upstash();
    if (conn && Number.isFinite(voceTs) && voceTs > 0) {
      // dati sbagliati: non li conservo, il gestionale li ricostruisce dalle schedine
      const dati = errore ? null : datiDaRimandare(struttura, grezzi);
      try { registrato = await aggiornaVoceStorico(conn, voceTs, campiEsitoRoss(esito, dati)); }
      catch (e) { /* archivio irraggiungibile: lo segna il gestionale */ }
    }
    if (!esito.ok) {
      return res.status(esito.status || 502).json({ error: esito.error, irraggiungibile: !!esito.temporaneo, registrato });
    }
    return res.status(200).json({ ok: true, esito: esito.esito, registrato });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
