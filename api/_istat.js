// api/_istat.js — compila la "COMUNICAZIONE ISTAT · Presenze turistiche negli alloggi privati"
// che per Canazei va mandata via email all'APT Val di Fassa.
//
// Il modulo è quello ufficiale già precompilato con i dati della struttura (proprietario,
// indirizzo, codice CIPAT): qui sopra ci scriviamo solo le cinque cose che cambiano ogni
// volta, nelle stesse posizioni in cui le scriveva a mano l'utente:
//   numero persone · residenza · data di arrivo · data di partenza · data di compilazione
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fs = require("fs");
const path = require("path");

// coordinate ricavate dai moduli già inviati (punti PDF, origine in basso a sinistra)
const POS = {
  persone:      { x: 150, y: 400 },
  residenza:    { x: 230, y: 400 },
  arrivo:       { x: 350, y: 400 },
  partenza:     { x: 450, y: 400 },
  compilazione: { x: 260, y: 90 },
};
const CORPO = 10;

const DIR_MODULI = path.join(process.cwd(), "public", "vendor", "istat");

// Il modulo è PRECOMPILATO con i dati di UNA struttura (proprietario, indirizzo, codice
// CIPAT): esiste quindi solo per le strutture per cui abbiamo il loro modulo. Niente
// ripieghi su un modulo di un'altra casa, sarebbe una comunicazione sbagliata.
function percorsoModulo(idStruttura) {
  const id = String(idStruttura || "").replace(/[^\w-]/g, "");
  if (!id) return null;
  const suo = path.join(DIR_MODULI, `modulo-${id}.pdf`);
  return fs.existsSync(suo) ? suo : null;
}
// id delle strutture che hanno il proprio modulo (oggi: canazei)
function struttureConModulo() {
  try {
    return fs.readdirSync(DIR_MODULI)
      .map((f) => /^modulo-(.+)\.pdf$/i.exec(f))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch { return []; }
}

// "2026-03-25" oppure "25/03/2026" -> "25/03/2026"
function dataIt(v) {
  const s = String(v || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? s : "";
}

function oggiIt() {
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date());
}

async function costruisciModuloIstat({ struttura, persone, residenza, arrivo, partenza, compilazione }) {
  const percorso = percorsoModulo(struttura);
  if (!percorso) throw new Error("Per questa struttura non c'è il modulo ISTAT precompilato");
  const base = fs.readFileSync(percorso);
  const doc = await PDFDocument.load(base);
  const pagina = doc.getPages()[0];
  // Helvetica basta: sul modulo vanno numeri, date e nomi di luoghi
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const scrivi = (chiave, testo) => {
    const t = String(testo == null ? "" : testo).trim();
    if (!t) return;
    pagina.drawText(t, { x: POS[chiave].x, y: POS[chiave].y, size: CORPO, font, color: rgb(0, 0, 0) });
  };
  scrivi("persone", persone);
  scrivi("residenza", residenza);
  scrivi("arrivo", dataIt(arrivo));
  scrivi("partenza", dataIt(partenza));
  scrivi("compilazione", dataIt(compilazione) || oggiIt());
  return Buffer.from(await doc.save());
}

// nome file come quelli già mandati finora: 2026-03-25_31.pdf (arrivo + giorno di partenza)
function nomeFileIstat(arrivo, partenza) {
  const a = dataIt(arrivo), p = dataIt(partenza);
  if (!a) return "comunicazione_istat.pdf";
  const [ga, ma, aa] = a.split("/");
  const gp = p ? p.split("/")[0] : "";
  return `${aa}-${ma}-${ga}${gp ? "_" + gp : ""}.pdf`;
}

module.exports = { costruisciModuloIstat, nomeFileIstat, struttureConModulo, dataIt, oggiIt };
