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
      // "vani" e "accessori" sono facoltativi: Canazei li ha, Bologna no —
      // il testo si adatta di conseguenza (come nei rispettivi contratti originali)
      v: `L'unità immobiliare posta in via ${cfg.indirizzoVia}. Locale composto di ${cfg.vani ? `n. ${cfg.vani} vani, di ` : ""}n. ${cfg.postiLetto} posti letto, di n. ${cfg.wc} wc. Locale ammobiliato ${cfg.accessori ? `che include oltre alla cucina i seguenti elementi accessori (${cfg.accessori})` : "dotato di cucina"}. Identificata al catasto fabbricati del Comune di ${cfg.comune}, nel Foglio di mappa ${cfg.foglio} particella ${cfg.particella} subalterno ${cfg.subalterno}.`,
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
      v: `The real estate unit located at ${indirizzoEN}, consisting of ${cfg.vani ? `${cfg.vani} rooms, ` : ""}${cfg.postiLetto} beds, and ${cfg.wc} bathroom(s). ${cfg.accessori ? `The furnished unit includes, in addition to the kitchen, the following accessory elements (${cfg.accessori})` : "Furnished unit with kitchen"}. Identified in the property registry of the Municipality of ${cfg.comune}, in Map Sheet ${cfg.foglio}, Parcel ${cfg.particella}, Subordinate ${cfg.subalterno}.`,
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

function testoFR(cfg, d) {
  return [
    { t: "titolo", v: "CONTRAT DE LOCATION TOURISTIQUE" },
    { t: "p", v: `M./Mme ${cfg.locatoreNome}, dénommé(e) le Bailleur` },
    { t: "p", v: `Code fiscal ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Donne en location" },
    { t: "sep" },
    { t: "p", v: `À M./Mme ${d.conduttoreNome}, dénommé(e) le Locataire` },
    { t: "p", v: `Numéro de pièce d'identité ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "QUI ACCEPTE" },
    { t: "sep" },
    {
      t: "p",
      v: `L'unité immobilière située à ${cfg.indirizzoVia}, composée de ${cfg.vani ? `${cfg.vani} pièces, ` : ""}${cfg.postiLetto} couchages et ${cfg.wc} salle(s) de bain. ${cfg.accessori ? `Local meublé comprenant, outre la cuisine, les éléments accessoires suivants (${cfg.accessori})` : "Local meublé avec cuisine"}. Identifiée au cadastre des bâtiments de la Commune de ${cfg.comune}, feuille ${cfg.foglio}, parcelle ${cfg.particella}, subalterne ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "La location sera régie par les clauses suivantes :" },
    { t: "sep" },
    { t: "p", v: `1. Le contrat est stipulé du ${d.arrivo} au ${d.partenza} et prendra fin sans aucun préavis.` },
    {
      t: "p",
      v: `2. L'immeuble devra être destiné exclusivement à des fins touristiques et, locataire inclus, ${d.numOspiti === 1 ? "1 personne sera hébergée" : `${d.numOspiti} personnes seront hébergées`}.`,
    },
    {
      t: "p",
      v: "3. Le locataire NE pourra PAS sous-louer ni prêter, en tout ou en partie, l'unité immobilière, sous peine de résolution de plein droit du contrat.",
    },
    {
      t: "p",
      v: `4. Le loyer est celui déjà versé au moment de la réservation et résulte du détail de la transaction sur la plateforme utilisée ${cfg.piattaforma}. Ce montant est considéré comme accepté par les deux parties sans qu'aucune confirmation supplémentaire ne soit nécessaire.`,
    },
    {
      t: "p",
      v: "5. Le locataire devra signaler au propriétaire, ou à son représentant, les éventuels défauts de l'immeuble et du mobilier dans les quarante-huit heures suivant la remise des clés.",
    },
    {
      t: "p",
      v: "6. Les frais liés à la fourniture des services (électricité, eau, gaz, charges de copropriété) sont à la charge du bailleur (propriétaire).",
    },
    { t: "sep" },
    { t: "p", v: `Lu, approuvé et signé à ${cfg.comune}, le ${d.dataFirma}` },
  ];
}

function testoES(cfg, d) {
  return [
    { t: "titolo", v: "CONTRATO DE ALQUILER TURÍSTICO" },
    { t: "p", v: `El/La Sr./Sra. ${cfg.locatoreNome}, denominado/a Arrendador` },
    { t: "p", v: `Código fiscal ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Cede en alquiler" },
    { t: "sep" },
    { t: "p", v: `Al/A la Sr./Sra. ${d.conduttoreNome}, denominado/a Arrendatario` },
    { t: "p", v: `Número de documento de identidad ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "QUE ACEPTA" },
    { t: "sep" },
    {
      t: "p",
      v: `La unidad inmobiliaria situada en ${cfg.indirizzoVia}, compuesta por ${cfg.vani ? `${cfg.vani} habitaciones, ` : ""}${cfg.postiLetto} plazas y ${cfg.wc} baño(s). ${cfg.accessori ? `Local amueblado que incluye, además de la cocina, los siguientes elementos accesorios (${cfg.accessori})` : "Local amueblado con cocina"}. Identificada en el catastro de edificios del Municipio de ${cfg.comune}, hoja ${cfg.foglio}, parcela ${cfg.particella}, subalterno ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "El alquiler se regirá por los siguientes pactos:" },
    { t: "sep" },
    { t: "p", v: `1. El contrato se estipula desde el ${d.arrivo} hasta el ${d.partenza} y cesará sin necesidad de aviso alguno.` },
    {
      t: "p",
      v: `2. El inmueble deberá destinarse exclusivamente a fines turísticos y, incluido el arrendatario, se alojará ${d.numOspiti === 1 ? "1 persona" : `un total de ${d.numOspiti} personas`}.`,
    },
    {
      t: "p",
      v: "3. El arrendatario NO podrá subarrendar ni ceder en comodato, total o parcialmente, la unidad inmobiliaria, bajo pena de resolución de pleno derecho del contrato.",
    },
    {
      t: "p",
      v: `4. La renta es la ya abonada en el momento de la reserva y consta en el detalle de la transacción de la plataforma utilizada ${cfg.piattaforma}. Dicho importe se considera aceptado por ambas partes sin necesidad de confirmación adicional.`,
    },
    {
      t: "p",
      v: "5. El arrendatario deberá avisar al propietario, o a quien lo represente, de los posibles defectos del inmueble y del mobiliario dentro de las cuarenta y ocho horas siguientes a la entrega de las llaves.",
    },
    {
      t: "p",
      v: "6. Los gastos relativos al suministro de servicios (luz, agua, gas, gastos de comunidad) corren a cargo del arrendador (propietario).",
    },
    { t: "sep" },
    { t: "p", v: `Leído, aprobado y firmado en ${cfg.comune}, el ${d.dataFirma}` },
  ];
}

// etichetta della riga firma nel PDF, per lingua
const FIRMA_LABEL = {
  it: "Firma del conduttore:",
  en: "Tenant's signature:",
  fr: "Signature du locataire :",
  es: "Firma del arrendatario:",
};

// restituisce i blocchi del contratto nella lingua chiesta (default italiano)
function testoContratto(cfg, d, lang) {
  const fn = { it: testoIT, en: testoEN, fr: testoFR, es: testoES }[lang] || testoIT;
  return fn(cfg, d);
}
function firmaLabel(lang) {
  return FIRMA_LABEL[lang] || FIRMA_LABEL.it;
}

module.exports = { getContrattiStrutture, getContrattoStruttura, campiPubbliciContratto, testoIT, testoEN, testoContratto, firmaLabel };
