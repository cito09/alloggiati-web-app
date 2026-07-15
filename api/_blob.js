// api/_blob.js — helper condiviso per leggere i file su Vercel Blob.
// I file NUOVI vengono caricati con access:'private' (non apribili da link diretto):
// per rileggerli lato server serve la SDK con il token. I file VECCHI erano 'public'
// (hostname *.public.blob.vercel-storage.com) e restano leggibili con un semplice fetch.
// Questo helper gestisce entrambi i casi in modo trasparente.
const { get } = require("@vercel/blob");

const RE_BLOB = /^https:\/\/[a-z0-9-]+\.(?:public\.)?blob\.vercel-storage\.com\//i;
const RE_PUBLIC = /\.public\.blob\.vercel-storage\.com\//i;

function isBlobUrl(u) { return RE_BLOB.test(String(u || "")); }
// privato = è un blob del nostro store ma NON sull'host pubblico
function isPrivateBlob(u) { return isBlobUrl(u) && !RE_PUBLIC.test(String(u)); }

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  // Web ReadableStream (caso tipico della SDK nel runtime Node di Vercel)
  if (typeof stream.getReader === "function") {
    const ab = await new Response(stream).arrayBuffer();
    return Buffer.from(ab);
  }
  // fallback: Node Readable / async-iterable
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// Ritorna { buffer, contentType } oppure null se non trovato.
async function leggiBlob(url) {
  if (isPrivateBlob(url)) {
    // get() su store privato: ritorna { stream, blob, statusCode } (doc Vercel Blob).
    const r = await get(url, { access: "private" });
    if (!r || (r.statusCode && r.statusCode !== 200)) return null;
    const buffer = await streamToBuffer(r.stream);
    const contentType = (r.blob && r.blob.contentType) || "";
    return { buffer, contentType };
  }
  // blob pubblico o URL esterno: fetch normale
  const r = await fetch(url);
  if (!r.ok) return null;
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, contentType: r.headers.get("content-type") || "" };
}

module.exports = { leggiBlob, isBlobUrl, isPrivateBlob };
