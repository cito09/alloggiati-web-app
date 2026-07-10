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

function testoDE(cfg, d) {
  return [
    { t: "titolo", v: "TOURISTISCHER MIETVERTRAG" },
    { t: "p", v: `Herr/Frau ${cfg.locatoreNome}, im Folgenden „Vermieter" genannt` },
    { t: "p", v: `Steuernummer ${cfg.codiceFiscale}` },
    { t: "p", v: `E-Mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Vermietet an" },
    { t: "sep" },
    { t: "p", v: `Herrn/Frau ${d.conduttoreNome}, im Folgenden „Mieter" genannt` },
    { t: "p", v: `Ausweisnummer ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "DER/DIE ANNIMMT" },
    { t: "sep" },
    {
      t: "p",
      v: `Die Immobilieneinheit in ${cfg.indirizzoVia}, bestehend aus ${cfg.vani ? `${cfg.vani} Zimmern, ` : ""}${cfg.postiLetto} Schlafplätzen und ${cfg.wc} Badezimmer(n). ${cfg.accessori ? `Möblierte Einheit, die neben der Küche folgende Nebenräume umfasst (${cfg.accessori})` : "Möblierte Einheit mit Küche"}. Eingetragen im Gebäudekataster der Gemeinde ${cfg.comune}, Blatt ${cfg.foglio}, Parzelle ${cfg.particella}, Untereinheit ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "Für die Vermietung gelten die folgenden Vereinbarungen:" },
    { t: "sep" },
    { t: "p", v: `1. Der Vertrag wird vom ${d.arrivo} bis zum ${d.partenza} geschlossen und endet ohne jegliche Kündigung.` },
    {
      t: "p",
      v: `2. Die Immobilie darf ausschließlich zu touristischen Zwecken genutzt werden; einschließlich des Mieters ${d.numOspiti === 1 ? "wird 1 Person untergebracht" : `werden ${d.numOspiti} Personen untergebracht`}.`,
    },
    {
      t: "p",
      v: "3. Der Mieter darf die Immobilieneinheit weder ganz noch teilweise untervermieten oder unentgeltlich überlassen; andernfalls wird der Vertrag von Rechts wegen aufgelöst.",
    },
    {
      t: "p",
      v: `4. Der Mietpreis ist der bereits bei der Buchung gezahlte Betrag und ergibt sich aus den Transaktionsdetails der genutzten Plattform ${cfg.piattaforma}. Dieser Betrag gilt als von beiden Parteien akzeptiert, ohne dass eine weitere Bestätigung erforderlich ist.`,
    },
    {
      t: "p",
      v: "5. Der Mieter muss den Eigentümer oder dessen Vertreter innerhalb von achtundvierzig Stunden nach Schlüsselübergabe über etwaige Mängel der Immobilie und des Mobiliars informieren.",
    },
    {
      t: "p",
      v: "6. Die Kosten für Versorgungsleistungen wie Strom, Wasser, Gas und Nebenkosten trägt der Vermieter (Eigentümer).",
    },
    { t: "sep" },
    { t: "p", v: `Gelesen, genehmigt und unterzeichnet in ${cfg.comune}, am ${d.dataFirma}` },
  ];
}

function testoRO(cfg, d) {
  return [
    { t: "titolo", v: "CONTRACT DE ÎNCHIRIERE TURISTICĂ" },
    { t: "p", v: `Dl./Dna. ${cfg.locatoreNome}, denumit(ă) Locator` },
    { t: "p", v: `Cod fiscal ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Închiriază către" },
    { t: "sep" },
    { t: "p", v: `Dl./Dna. ${d.conduttoreNome}, denumit(ă) Chiriaș` },
    { t: "p", v: `Număr document de identitate ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "CARE ACCEPTĂ" },
    { t: "sep" },
    {
      t: "p",
      v: `Unitatea imobiliară situată în ${cfg.indirizzoVia}, compusă din ${cfg.vani ? `${cfg.vani} camere, ` : ""}${cfg.postiLetto} locuri de dormit și ${cfg.wc} băi. ${cfg.accessori ? `Spațiu mobilat care include, pe lângă bucătărie, următoarele elemente accesorii (${cfg.accessori})` : "Spațiu mobilat cu bucătărie"}. Identificată în cadastrul clădirilor al Municipiului ${cfg.comune}, foaia ${cfg.foglio}, parcela ${cfg.particella}, subalternul ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "Închirierea va fi guvernată de următoarele clauze:" },
    { t: "sep" },
    { t: "p", v: `1. Contractul este încheiat de la ${d.arrivo} până la ${d.partenza} și va înceta fără niciun preaviz.` },
    {
      t: "p",
      v: `2. Imobilul va fi destinat exclusiv scopurilor turistice și, inclusiv chiriașul, ${d.numOspiti === 1 ? "va fi găzduită 1 persoană" : `vor fi găzduite ${d.numOspiti} persoane`}.`,
    },
    {
      t: "p",
      v: "3. Chiriașul NU poate subînchiria sau împrumuta, în tot sau în parte, unitatea imobiliară, sub sancțiunea rezilierii de drept a contractului.",
    },
    {
      t: "p",
      v: `4. Chiria este cea deja achitată la momentul rezervării și rezultă din detaliile tranzacției de pe platforma utilizată ${cfg.piattaforma}. Această sumă se consideră acceptată de ambele părți fără a fi necesară o confirmare suplimentară.`,
    },
    {
      t: "p",
      v: "5. Chiriașul trebuie să informeze proprietarul sau reprezentantul acestuia despre eventualele defecte ale imobilului și ale mobilierului în termen de patruzeci și opt de ore de la predarea cheilor.",
    },
    {
      t: "p",
      v: "6. Costurile aferente furnizării serviciilor precum electricitate, apă, gaz și cheltuieli de întreținere sunt suportate de locator (proprietar).",
    },
    { t: "sep" },
    { t: "p", v: `Citit, aprobat și semnat la ${cfg.comune}, la data de ${d.dataFirma}` },
  ];
}

function testoPT(cfg, d) {
  return [
    { t: "titolo", v: "CONTRATO DE LOCAÇÃO TURÍSTICA" },
    { t: "p", v: `O/A Sr./Sra. ${cfg.locatoreNome}, denominado/a Locador` },
    { t: "p", v: `Código fiscal ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Dá em locação" },
    { t: "sep" },
    { t: "p", v: `Ao/À Sr./Sra. ${d.conduttoreNome}, denominado/a Locatário` },
    { t: "p", v: `Número do documento de identidade ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "QUE ACEITA" },
    { t: "sep" },
    {
      t: "p",
      v: `A unidade imobiliária situada em ${cfg.indirizzoVia}, composta por ${cfg.vani ? `${cfg.vani} divisões, ` : ""}${cfg.postiLetto} camas e ${cfg.wc} casa(s) de banho. ${cfg.accessori ? `Imóvel mobilado que inclui, além da cozinha, os seguintes elementos acessórios (${cfg.accessori})` : "Imóvel mobilado com cozinha"}. Identificada no cadastro de edifícios do Município de ${cfg.comune}, folha ${cfg.foglio}, parcela ${cfg.particella}, subalterno ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "A locação será regida pelas seguintes cláusulas:" },
    { t: "sep" },
    { t: "p", v: `1. O contrato é estipulado de ${d.arrivo} a ${d.partenza} e cessará sem necessidade de qualquer aviso.` },
    {
      t: "p",
      v: `2. O imóvel deverá ser destinado exclusivamente a fins turísticos e, incluindo o locatário, ${d.numOspiti === 1 ? "será alojada 1 pessoa" : `serão alojadas ${d.numOspiti} pessoas`}.`,
    },
    {
      t: "p",
      v: "3. O locatário NÃO poderá sublocar nem emprestar, no todo ou em parte, a unidade imobiliária, sob pena de resolução de pleno direito do contrato.",
    },
    {
      t: "p",
      v: `4. O valor da locação é o já pago no momento da reserva e consta nos detalhes da transação na plataforma utilizada ${cfg.piattaforma}. Este valor considera-se aceite por ambas as partes sem necessidade de confirmação adicional.`,
    },
    {
      t: "p",
      v: "5. O locatário deverá avisar o proprietário, ou quem o represente, sobre eventuais defeitos do imóvel e do mobiliário no prazo de quarenta e oito horas após a entrega das chaves.",
    },
    {
      t: "p",
      v: "6. As despesas relativas ao fornecimento de serviços como luz, água, gás e despesas de condomínio ficam a cargo do locador (proprietário).",
    },
    { t: "sep" },
    { t: "p", v: `Lido, aprovado e assinado em ${cfg.comune}, em ${d.dataFirma}` },
  ];
}

function testoPL(cfg, d) {
  const persone = d.numOspiti === 1 ? "zakwaterowana będzie 1 osoba" : d.numOspiti < 5 ? `zakwaterowane będą ${d.numOspiti} osoby` : `zakwaterowanych będzie ${d.numOspiti} osób`;
  return [
    { t: "titolo", v: "UMOWA NAJMU TURYSTYCZNEGO" },
    { t: "p", v: `Pan/Pani ${cfg.locatoreNome}, zwany/a dalej Wynajmującym` },
    { t: "p", v: `Kod podatkowy ${cfg.codiceFiscale}` },
    { t: "p", v: `E-mail ${cfg.email}` },
    { t: "sep" },
    { t: "b", v: "Oddaje w najem" },
    { t: "sep" },
    { t: "p", v: `Panu/Pani ${d.conduttoreNome}, zwanemu/ej dalej Najemcą` },
    { t: "p", v: `Numer dokumentu tożsamości ${d.conduttoreDoc || "—"}` },
    { t: "sep" },
    { t: "b", v: "KTÓRY/A AKCEPTUJE" },
    { t: "sep" },
    {
      t: "p",
      v: `Lokal położony w ${cfg.indirizzoVia}, składający się z ${cfg.vani ? `${cfg.vani} pokoi, ` : ""}${cfg.postiLetto} miejsc do spania i ${cfg.wc} łazienki/łazienek. ${cfg.accessori ? `Lokal umeblowany, obejmujący oprócz kuchni następujące pomieszczenia dodatkowe (${cfg.accessori})` : "Lokal umeblowany z kuchnią"}. Ujęty w katastrze budynków Gminy ${cfg.comune}, arkusz ${cfg.foglio}, działka ${cfg.particella}, jednostka ${cfg.subalterno}.`,
    },
    { t: "sep" },
    { t: "p", v: "Najem podlega następującym postanowieniom:" },
    { t: "sep" },
    { t: "p", v: `1. Umowa zostaje zawarta od ${d.arrivo} do ${d.partenza} i wygasa bez konieczności wypowiedzenia.` },
    {
      t: "p",
      v: `2. Nieruchomość może być wykorzystywana wyłącznie w celach turystycznych; łącznie z najemcą ${persone}.`,
    },
    {
      t: "p",
      v: "3. Najemca NIE może podnajmować ani użyczać, w całości ani w części, lokalu, pod rygorem rozwiązania umowy z mocy prawa.",
    },
    {
      t: "p",
      v: `4. Czynsz najmu został już zapłacony w momencie rezerwacji i wynika ze szczegółów transakcji na wykorzystanej platformie ${cfg.piattaforma}. Kwota ta uznawana jest za zaakceptowaną przez obie strony bez potrzeby dodatkowego potwierdzenia.`,
    },
    {
      t: "p",
      v: "5. Najemca powinien powiadomić właściciela lub jego przedstawiciela o ewentualnych wadach lokalu i wyposażenia w ciągu czterdziestu ośmiu godzin od przekazania kluczy.",
    },
    {
      t: "p",
      v: "6. Koszty dostawy mediów, takich jak prąd, woda, gaz oraz opłaty wspólnotowe, ponosi wynajmujący (właściciel).",
    },
    { t: "sep" },
    { t: "p", v: `Przeczytano, zatwierdzono i podpisano w ${cfg.comune}, dnia ${d.dataFirma}` },
  ];
}

// etichetta della riga firma nel PDF, per lingua
const FIRMA_LABEL = {
  it: "Firma del conduttore:",
  en: "Tenant's signature:",
  fr: "Signature du locataire :",
  es: "Firma del arrendatario:",
  de: "Unterschrift des Mieters:",
  ro: "Semnătura chiriașului:",
  pt: "Assinatura do locatário:",
  pl: "Podpis najemcy:",
};

// restituisce i blocchi del contratto nella lingua chiesta (default italiano)
function testoContratto(cfg, d, lang) {
  const fn = { it: testoIT, en: testoEN, fr: testoFR, es: testoES, de: testoDE, ro: testoRO, pt: testoPT, pl: testoPL }[lang] || testoIT;
  return fn(cfg, d);
}
function firmaLabel(lang) {
  return FIRMA_LABEL[lang] || FIRMA_LABEL.it;
}

module.exports = { getContrattiStrutture, getContrattoStruttura, campiPubbliciContratto, testoIT, testoEN, testoContratto, firmaLabel };
