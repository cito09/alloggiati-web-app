// api/_pdf.js — genera il PDF del contratto firmato (pagine per lingua + immagine della firma).
// Usa pdf-lib (libreria pura JS, nessun binario nativo: va bene su Vercel serverless) con il
// font DejaVu Sans incorporato: il font standard dei PDF (Helvetica/WinAnsi) non copre le
// lettere del romeno (ș, ț, ă) e avrebbe fatto fallire la generazione. subset:true tiene
// il PDF piccolo (incorpora solo i caratteri usati davvero).
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const fs = require("fs");
const path = require("path");

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 50;
const MAX_W = PAGE_W - MARGIN * 2;

function wrapLines(text, size, font) {
  const words = String(text).split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > MAX_W && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// "pagine" è un array di { blocchi, firmaLabel }: la prima nella lingua dell'ospite,
// l'eventuale seconda in italiano (omessa se l'ospite ha già firmato in italiano).
async function generaContrattoPdf({ pagine, firmaPngBuffer, dataFirma, ip }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(path.join(__dirname, "_fonts", "DejaVuSans.ttf")), { subset: true });
  const fontBold = await pdf.embedFont(fs.readFileSync(path.join(__dirname, "_fonts", "DejaVuSans-Bold.ttf")), { subset: true });

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const lineHeight = 14;
  const bodySize = 10.5;

  function nuovaPagina() {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  function assicuraSpazio(altezza) {
    if (y - altezza < MARGIN) nuovaPagina();
  }
  function scriviBlocchi(blocchi) {
    for (const b of blocchi) {
      if (b.t === "sep") {
        y -= lineHeight * 0.5;
        continue;
      }
      const isTitolo = b.t === "titolo";
      const useFont = isTitolo || b.t === "b" ? fontBold : font;
      const size = isTitolo ? 15 : bodySize;
      const lines = wrapLines(b.v, size, useFont);
      for (const line of lines) {
        assicuraSpazio(lineHeight + 4);
        page.drawText(line, { x: MARGIN, y, size, font: useFont, color: rgb(0.06, 0.1, 0.16) });
        y -= isTitolo ? lineHeight + 6 : lineHeight;
      }
      y -= 3;
    }
  }

  // la firma va disegnata in fondo a OGNI versione linguistica del contratto
  const firmaImg = firmaPngBuffer ? await pdf.embedPng(firmaPngBuffer) : null;
  function disegnaFirma(label) {
    assicuraSpazio(140);
    y -= 12;
    page.drawText(label || "Firma del conduttore:", { x: MARGIN, y, size: 11, font: fontBold });
    y -= 10;
    if (firmaImg) {
      const scale = Math.min(220 / firmaImg.width, 90 / firmaImg.height);
      const w = firmaImg.width * scale;
      const h = firmaImg.height * scale;
      assicuraSpazio(h + 12);
      page.drawImage(firmaImg, { x: MARGIN, y: y - h, width: w, height: h });
      y -= h + 8;
    }
    page.drawText(`Firmato elettronicamente · Electronically signed — ${dataFirma}${ip ? " · IP " + ip : ""}`, {
      x: MARGIN,
      y,
      size: 8.5,
      font,
      color: rgb(0.4, 0.45, 0.5),
    });
  }

  pagine.forEach((p, i) => {
    if (i > 0) nuovaPagina();
    scriviBlocchi(p.blocchi);
    disegnaFirma(p.firmaLabel);
  });

  return Buffer.from(await pdf.save());
}

module.exports = { generaContrattoPdf };
