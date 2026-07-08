// api/_contratto.js — dati e testo del contratto di locazione turistica, per struttura.
// Config nella variabile d'ambiente CONTRATTI_STRUTTURE (JSON su una riga), un oggetto per
// struttura (stesso "id" usato in ALLOGGIATI_STRUTTURE/ROSS_STRUTTURE):
// [{"id":"canazei","locatoreNome":"Nicola Chirco","codiceFiscale":"CHRNCL73L01A944D",
//   "email":"canazeibnb25@gmail.com","indirizzoVia":"STREDA DE COSTA n.71, interno n° 25",
//   "comune":"Canazei","vani":2,"postiLetto":4,"wc":1,
//   "accessori":"cantina, autorimessa singola, posto macchina in comune, parcheggio coperto",
//   "foglio":"817","particella":"66","subalterno":"43","piattaforma":"Airbnb"}]
// Le strutture senza voce qui semplicemente non hanno il passo "firma contratto" nel check-in.
function getContrattiStrutture() {
  try {
    return JSON.parse(process.env.CONTRATTI_STRUTTURE || "[]");
  } catch {
    return [];
  }
}

function getContrattoStruttura(id) {
  return getContrattiStrutture().find((c) => c.id === id) || null;
}

// campi mostrati nell'anteprima del contratto all'ospite. Sono tutti dati che compaiono
// comunque stampati sul contratto (incluso l'email del locatore), quindi non c'è nulla di segreto.
function campiPubbliciContratto(cfg) {
  if (!cfg) return null;
  return { ...cfg };
}

function testoIT(cfg, d) {
  return [
    { t: "titolo", v: "CONTRATTO DI LOCAZIONE TURISTICA" },
    { t: "p", v: `Il/la Sig. ${cfg.locatoreNome} denominato Locatore` },
    { t: "p", v: `Codice Fiscale ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Concede in Locazione" },
    { t: "sep" },
    { t: "p", v: `Alla/al Sig. ${d.conduttoreNome} denominato conduttore` },
    { t: "p", v: `Numero Doc. Identità ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "CHE ACCETTA" },
    { t: "sep" },
    {
      t: "p",
      v: `L'unità immobiliare posta in via ${cfg.indirizzoVia}. Locale composto di n. ${cfg.vani} vani, di n. ${cfg.postiLetto} posti letto, di n. ${cfg.wc} wc. Locale ammobiliato che include oltre alla cucina i seguenti elementi accessori (${cfg.accessori}). Identificata al catasto fabbricati del Comune di ${cfg.comune}, nel Foglio di mappa ${cfg.foglio} particella ${cfg.particella} subalterno ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "La locazione sarà regolata dalle seguenti pattuizioni:" },
    { t: "sep" },
    { t: "p", v: `1. Il contratto è stipulato dal ${d.arrivo} al ${d.partenza} e cesserà senza disdetta alcuna.` },
    {
      t: "p",
      v: `2. L'immobile dovrà essere destinato esclusivamente per finalità turistiche, e incluso il conduttore ${d.numOspiti === 1 ? "sarà ospitato un numero di 1 persona" : `saranno ospitate un numero di ${d.numOspiti} persone`}.`,
    },
    {
      t: "p",
      v: "3. Il conduttore NON potrà sublocare o dare in comodato, in tutto o in parte, l'unità immobiliare, pena la risoluzione di diritto del contratto.",
    },
    {
      t: "p",
      v: `4. Il canone di locazione è quello già corrisposto al momento della prenotazione e risulta dal dettaglio della transazione sulla piattaforma utilizzata ${cfg.piattaforma}. Tale importo è considerato accettato da entrambe le parti senza necessità di ulteriore conferma.`,
    },
    {
      t: "p",
      v: "5. Il conduttore dovrà avvisare il proprietario o chi ne fa le veci degli eventuali difetti dell'immobile e dei mobili entro quarantotto ore dalla consegna delle chiavi.",
    },
    {
      t: "p",
      v: "6. Le spese inerenti all'erogazione di servizi, quali: luce; acqua; gas; spese condominiali; sono a carico del locatore (proprietario).",
    },
    { t: "sep" },
    { t: "p", v: `Letto, approvato e sottoscritto ${cfg.comune}, li ${d.dataFirma}` },
  ];
}

function testoEN(cfg, d) {
  const indirizzoEN = cfg.indirizzoViaEN || cfg.indirizzoVia;
  return [
    { t: "titolo", v: "TOURIST RENTAL AGREEMENT" },
    { t: "p", v: `Mr./Ms. ${cfg.locatoreNome}, referred to as the Landlord` },
    { t: "p", v: `Tax Code ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Leases to" },
    { t: "sep" },
    { t: "p", v: `Mr./Ms. ${d.conduttoreNome} referred to as the Tenant` },
    { t: "p", v: `Identity Document Number ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "WHO ACCEPTS" },
    { t: "sep" },
    {
      t: "p",
      v: `The real estate unit located at ${indirizzoEN}, consisting of ${cfg.vani} rooms, ${cfg.postiLetto} beds, and ${cfg.wc} bathroom(s). The furnished unit includes, in addition to the kitchen, the following accessory elements (${cfg.accessori}). Identified in the property registry of the Municipality of ${cfg.comune}, in Map Sheet ${cfg.foglio}, Parcel ${cfg.particella}, Subordinate ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "The lease shall be governed by the following terms:" },
    { t: "sep" },
    { t: "p", v: `1. The contract is stipulated from ${d.arrivo} to ${d.partenza} and will terminate without any notice.` },
    {
      t: "p",
      v: `2. The property must be used exclusively for tourist purposes, and including the tenant, a total of ${d.numOspiti} ${d.numOspiti === 1 ? "person" : "people"} will be accommodated.`,
    },
    {
      t: "p",
      v: "3. The tenant is NOT allowed to sublet or lend, in whole or in part, the property, under penalty of automatic termination of the contract.",
    },
    {
      t: "p",
      v: `4. The rental fee is the amount already paid at the time of booking and is recorded in the transaction details on the platform used ${cfg.piattaforma}. This amount is considered accepted by both parties without the need for further confirmation.`,
    },
    {
      t: "p",
      v: "5. The tenant must inform the owner or their representative of any defects in the property and furniture within forty-eight hours of receiving the keys.",
    },
    {
      t: "p",
      v: "6. The costs related to the provision of services, such as electricity, water, gas, and condominium fees, are borne by the landlord (owner).",
    },
    { t: "sep" },
    { t: "p", v: `Read, approved, and signed in ${cfg.comune}, on ${d.dataFirma}` },
  ];
}

module.exports = { getContrattiStrutture, getContrattoStruttura, campiPubbliciContratto, testoIT, testoEN };
