// api/_pdf.js — genera il PDF del contratto firmato (testo IT + EN + immagine della firma).
// Usa pdf-lib (libreria pura JS, nessun binario nativo: va bene su Vercel serverless).
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

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

async function generaContrattoPdf({ blocchiIT, blocchiEN, firmaPngBuffer, dataFirma, ip }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

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

  // la firma va disegnata in fondo a ENTRAMBE le versioni (italiana e inglese), come
  // nel contratto originale che aveva la riga della firma su tutte e due le pagine.
  const firmaImg = firmaPngBuffer ? await pdf.embedPng(firmaPngBuffer) : null;
  function disegnaFirma() {
    assicuraSpazio(140);
    y -= 12;
    page.drawText("Firma del conduttore / Tenant's signature:", { x: MARGIN, y, size: 11, font: fontBold });
    y -= 10;
    if (firmaImg) {
      const scale = Math.min(220 / firmaImg.width, 90 / firmaImg.height);
      const w = firmaImg.width * scale;
      const h = firmaImg.height * scale;
      assicuraSpazio(h + 12);
      page.drawImage(firmaImg, { x: MARGIN, y: y - h, width: w, height: h });
      y -= h + 8;
    }
    page.drawText(`Firmato elettronicamente il ${dataFirma}${ip ? " · IP " + ip : ""}`, {
      x: MARGIN,
      y,
      size: 8.5,
      font,
      color: rgb(0.4, 0.45, 0.5),
    });
  }

  scriviBlocchi(blocchiIT);
  disegnaFirma();
  nuovaPagina();
  scriviBlocchi(blocchiEN);
  disegnaFirma();

  return Buffer.from(await pdf.save());
}

module.exports = { generaContrattoPdf };
