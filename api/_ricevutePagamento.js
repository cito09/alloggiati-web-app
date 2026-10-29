// api/_ricevutePagamento.js — RICEVUTE DI PAGAMENTO agli ospiti (≠ "Ricevute Questura").
//
// Richiesta dell'utente (29/10/2026): un'ospite chiede "la fattura intestata al Maestro Abbado".
// Da privati (locazione turistica senza partita IVA) la fattura non si può fare: si rilascia una
// RICEVUTA, firmata da chi incassa (il proprietario: per Falegnami Eleonora), con la marca da bollo
// da € 2 se il totale supera € 77,47. "Faccio tutto io su KeyFlow: compro le marche, quando c'è da
// firmare glielo giro, lei me lo firma e io mando."
//
// Flusso: l'host prepara la ricevuta (o manda all'ospite un link /r/<codice> dove l'ospite scrive a
// chi intestarla) → KeyFlow le dà il numero e la marca dalla scorta → link /r/<codice> per la firma
// col dito al proprietario → PDF firmato da mandare all'ospite + copia da stampare dove attaccare la
// marca (va conservata 3 anni).
//
// Regole verificate (vedi chat del 29/10/2026):
//  - cedolare secca: sostituisce il bollo SOLO sul contratto (circ. 26/E/2011), sulle ricevute
//    sopra € 77,47 la marca da € 2 resta dovuta; un PDF mandato per email vale come carta → marca
//    sull'originale che tiene l'emittente, numero della marca scritto sulla copia mandata;
//  - la data della marca non può essere successiva a quella della ricevuta; ogni marca una volta sola;
//  - IVA: il soggiorno è fuori campo (art. 4 DPR 633/72, nessuna attività d'impresa), l'imposta di
//    soggiorno incassata dall'host è esclusa (art. 15 DPR 633/72);
//  - importo = lordo pattuito con l'ospite (soggiorno + pulizie), senza i costi del servizio che
//    l'ospite paga ad Airbnb.
//
// KV: chiave "ricevute_pagamento" = { emittenti:{idCasa:{nome,cf,indirizzo,appartamento}},
//   marche:[{codice,data,usata,aggiunta}], lista:[ricevuta] }. Le firme (PNG) stanno su Vercel Blob.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redisCmd } = require("./_kv");

const KEY = "ricevute_pagamento";
const SOGLIA_BOLLO = 7747; // centesimi: oltre € 77,47 serve la marca da € 2
const MAX_RICEVUTE = 500;
const PAGAMENTI = ["Airbnb", "Booking.com", "Bonifico bancario", "Contanti", "Carta di pagamento", "Altro"];

// ---------- piccoli aiuti ----------
const pulisci = (v, max = 120) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const isoOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v + "T00:00:00Z"));
const isoIt = (iso) => { const [a, m, d] = String(iso || "").split("-"); return a ? `${d}/${m}/${a}` : ""; };
const token = () => crypto.randomBytes(18).toString("base64url");
const nuovoId = () => "rp" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
function oggiRoma() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }); // aaaa-mm-gg
}
function notti(dal, al) {
  return Math.round((Date.parse(al + "T00:00:00Z") - Date.parse(dal + "T00:00:00Z")) / 864e5);
}
// "365,50" / "365.50" / "1.250,00" / 365.5 → 36550 centesimi (NaN se non è un importo)
function centesimi(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  let s = String(v == null ? "" : v).replace(/[€\s]/g, "");
  if (!s) return 0;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
const euro = (c) => (Math.round(c) / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// importo in lettere, come sui ricevutari: 36550 → "trecentosessantacinque/50"
const U = ["zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"];
const D = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];
function sotto100(n) {
  if (n < 20) return U[n];
  const d = D[Math.floor(n / 10)], u = n % 10;
  if (!u) return d;
  return (u === 1 || u === 8 ? d.slice(0, -1) : d) + U[u]; // ventuno, ventotto
}
function sotto1000(n) {
  const c = Math.floor(n / 100), r = n % 100;
  let s = c ? (c === 1 ? "cento" : U[c] + "cento") : "";
  if (!r) return s;
  const rr = sotto100(r);
  if (c && /^ott/.test(rr)) s = s.slice(0, -1); // centottanta, centotto
  return s + rr;
}
function intero(n) {
  if (n === 0) return "zero";
  const m = Math.floor(n / 1000), r = n % 1000;
  const s = (m ? (m === 1 ? "mille" : intero(m) + "mila") : "") + (r ? sotto1000(r) : "");
  return s;
}
function inLettere(cent) {
  const e = Math.floor(cent / 100), c = cent % 100;
  return intero(e).replace(/(\w)tre$/, "$1tré") + "/" + String(c).padStart(2, "0");
}

// ---------- archivio ----------
async function leggi(conn) {
  const raw = await redisCmd(conn, ["GET", KEY]);
  let s = {};
  try { s = raw ? JSON.parse(raw) || {} : {}; } catch { s = {}; }
  return { emittenti: s.emittenti || {}, marche: Array.isArray(s.marche) ? s.marche : [], lista: Array.isArray(s.lista) ? s.lista : [] };
}
async function scrivi(conn, s) {
  s.lista = s.lista.slice(-MAX_RICEVUTE);
  await redisCmd(conn, ["SET", KEY, JSON.stringify(s)]);
}

// indirizzo dell'appartamento scritto bene: nel contratto "indirizzoVia" è senza "via" (il testo dice
// "posta in via …") e a volte contiene già la città ("DE'FALEGNAMI 8, Bologna (BO)" + comune "Bologna"
// = Bologna doppio, visto il 29/10/2026). Si toglie la parte ripetuta e si aggiunge "Via" se manca.
function indirizzoBello(a) {
  const norm = (x) => String(x).toLowerCase().replace(/\([a-z]{2}\)/g, "").replace(/[^a-zà-ú0-9]/g, "");
  const parti = [];
  for (const p of String(a || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const n = norm(p);
    if (parti.some((q) => norm(q) === n || (n && norm(q).startsWith(n)))) continue;
    parti.push(p);
  }
  let out = parti.join(", ");
  if (out && !/^(via|viale|vicolo|v\.lo|piazza|piazzale|p\.za|corso|strada|streda|largo|località|loc\.|contrada|borgo|frazione|fraz\.)\b/i.test(out)) out = "Via " + out;
  return out;
}

// chi firma le ricevute di una casa: quello salvato in Impostazioni, sennò i dati del locatore del
// contratto di locazione (CONTRATTI_STRUTTURE: nome, codice fiscale, indirizzo dell'appartamento)
function emittenteDi(s, casa) {
  let cfg = null;
  try { cfg = require("./_contratto").getContrattoStruttura(casa); } catch { cfg = null; }
  const salvato = s.emittenti[casa] || {};
  const app = cfg ? indirizzoBello([cfg.indirizzoVia, cfg.comune].filter(Boolean).join(", ")) : "";
  return {
    nome: salvato.nome != null ? salvato.nome : (cfg && cfg.locatoreNome) || "",
    cf: salvato.cf != null ? salvato.cf : (cfg && cfg.codiceFiscale) || "",
    indirizzo: salvato.indirizzo || "",
    appartamento: salvato.appartamento != null ? salvato.appartamento : app,
    salvato: !!s.emittenti[casa],
  };
}
// le numerazioni sono una per chi firma (codice fiscale) e per anno, come un ricevutario
const chiaveEmittente = (em, casa) => (pulisci(em && em.cf, 20).toUpperCase() || "casa:" + casa);
function prossimoNumero(s, chiave, anno, escludiId) {
  let max = 0;
  for (const r of s.lista) {
    if (r.id === escludiId || !r.numero || r.anno !== anno) continue;
    if (chiaveEmittente(r.emittente, r.casa) !== chiave) continue;
    max = Math.max(max, r.numero);
  }
  return max + 1;
}
const totaleDi = (r) => (r.soggiorno || 0) + (r.tassa || 0);
const serveBollo = (r) => totaleDi(r) > SOGLIA_BOLLO;
const etichetta = (r) => (r.numero ? `n. ${r.numero}/${r.anno}` : "senza numero");

function liberaMarca(s, r) {
  if (!r.marca) return;
  const m = s.marche.find((x) => x.codice === r.marca.codice);
  if (m && m.usata === r.id) m.usata = null;
  r.marca = null;
}
function marcaValida(codice, data) {
  if (!/^\d{14}$/.test(codice)) return "Il codice della marca da bollo ha 14 cifre (è sotto il codice a barre, «IDENTIFICATIVO»)";
  if (!isoOk(data)) return "Manca la data stampata sulla marca da bollo";
  return "";
}
// sceglie la marca: quella indicata (dalla scorta o scritta a mano) oppure la più vecchia libera
function assegnaMarca(s, r, richiesta) {
  if (!serveBollo(r)) { liberaMarca(s, r); return ""; }
  const vuole = richiesta && typeof richiesta === "object" && richiesta.codice ? { codice: String(richiesta.codice).replace(/\D/g, ""), data: String(richiesta.data || "") } : null;
  if (!vuole && r.marca) return ""; // tiene quella che ha
  let scelta = null;
  if (vuole) {
    const inScorta = s.marche.find((m) => m.codice === vuole.codice);
    if (inScorta) {
      if (inScorta.usata && inScorta.usata !== r.id) {
        const altra = s.lista.find((x) => x.id === inScorta.usata);
        return `Questa marca da bollo è già usata${altra ? " nella ricevuta " + etichetta(altra) : ""}: ogni marca vale una volta sola`;
      }
      scelta = inScorta;
    } else {
      const err = marcaValida(vuole.codice, vuole.data);
      if (err) return err;
      scelta = { codice: vuole.codice, data: vuole.data, usata: null, aggiunta: Date.now() };
      s.marche.push(scelta);
    }
  } else {
    scelta = s.marche.filter((m) => !m.usata).sort((a, b) => String(a.data).localeCompare(String(b.data)))[0];
    // nessuna marca in scorta: si va avanti lo stesso (29/10/2026, l'utente: "voglio già mandare
    // all'ospite il modulo, la marca la prendo più tardi"). La firma aspetta che la marca ci sia.
    if (!scelta) return "";
  }
  if (r.marca && r.marca.codice !== scelta.codice) liberaMarca(s, r);
  scelta.usata = r.id;
  r.marca = { codice: scelta.codice, data: scelta.data };
  return "";
}

// la marca è comprata dopo aver preparato la ricevuta (non ancora firmata): la data della ricevuta
// non può essere precedente a quella della marca, quindi si sposta alla data della marca
function allineaData(s, r) {
  if (!r.marca || !r.data || r.marca.data <= r.data || r.stato === "firmata") return "";
  return r.stato === "firmare" ? preparaFirma(s, r, { data: r.marca.data, numero: r.anno === Number(r.marca.data.slice(0, 4)) ? r.numero : "" }) : (r.data = r.marca.data, "");
}
// ricevute in attesa della marca: quando la marca entra nella scorta va da sola alla più vecchia
function assegnaAiInAttesa(s) {
  const fatte = [];
  for (const r of s.lista.filter((x) => (x.stato === "dati" || x.stato === "firmare") && serveBollo(x) && !x.marca).sort((a, b) => (a.creata || 0) - (b.creata || 0))) {
    if (!s.marche.some((m) => !m.usata)) break;
    if (assegnaMarca(s, r, null)) continue;
    allineaData(s, r);
    fatte.push(etichetta(r));
  }
  return fatte;
}
const manca = (r) => serveBollo(r) && !r.marca;

// la ricevuta è completa: numero, data, chi firma (copia dei dati di quel momento), link per la firma
function preparaFirma(s, r, { numero, data } = {}) {
  const em = emittenteDi(s, r.casa);
  if (!pulisci(em.nome) || !pulisci(em.cf)) return "Mancano nome e codice fiscale di chi firma le ricevute di questa casa (sotto, in «Chi firma le ricevute»)";
  if (!pulisci(em.appartamento)) return "Manca l'indirizzo dell'appartamento (sotto, in «Chi firma le ricevute»)";
  const giorno = isoOk(data) ? data : isoOk(r.data) ? r.data : oggiRoma();
  if (r.marca && r.marca.data > giorno) return `La marca da bollo è del ${isoIt(r.marca.data)}: non può essere successiva alla data della ricevuta (${isoIt(giorno)})`;
  const anno = Number(giorno.slice(0, 4));
  const emittente = { nome: pulisci(em.nome, 80), cf: pulisci(em.cf, 20).toUpperCase(), indirizzo: pulisci(em.indirizzo, 160), appartamento: pulisci(em.appartamento, 160) };
  const chiave = chiaveEmittente(emittente, r.casa);
  let n = parseInt(numero, 10);
  if (numero != null && numero !== "" && !(n >= 1 && n <= 99999)) return "Il numero della ricevuta non è valido";
  if (n >= 1) {
    const doppia = s.lista.find((x) => x.id !== r.id && x.stato !== "annullata" && x.numero === n && x.anno === anno && chiaveEmittente(x.emittente, x.casa) === chiave);
    if (doppia) return `Il numero ${n}/${anno} è già usato (ricevuta a ${doppia.intestatario && doppia.intestatario.nome || "?"})`;
  } else if (r.numero && r.anno === anno && chiaveEmittente(r.emittente, r.casa) === chiave) n = r.numero;
  else n = prossimoNumero(s, chiave, anno, r.id);
  Object.assign(r, { emittente, data: giorno, anno, numero: n, stato: "firmare" });
  if (!r.tokFirma) r.tokFirma = token();
  return "";
}

function intestatarioDa(v) {
  const o = v && typeof v === "object" ? v : {};
  return { nome: pulisci(o.nome, 120), indirizzo: pulisci(o.indirizzo, 180), cf: pulisci(o.cf, 30).toUpperCase() };
}

// ---------- azioni del gestionale ----------
async function azioneRicevute(conn, body, { strutture = [] } = {}) {
  const s = await leggi(conn);
  const op = String(body.op || "lista");
  const trova = (id) => s.lista.find((r) => r.id === String(id || ""));
  const vista = () => ({
    ok: true,
    lista: s.lista.slice().reverse(),
    marche: s.marche.slice().sort((a, b) => String(a.data).localeCompare(String(b.data))),
    emittenti: Object.fromEntries(strutture.map((x) => [x.id, emittenteDi(s, x.id)])),
    pagamenti: PAGAMENTI,
  });

  if (op === "lista") return vista();

  if (op === "emittente") {
    const casa = pulisci(body.casa, 40);
    if (!casa) return { ok: false, error: "Casa mancante" };
    const d = body.dati || {};
    const cf = pulisci(d.cf, 20).toUpperCase();
    if (cf && !/^[A-Z0-9]{11,16}$/.test(cf)) return { ok: false, error: "Il codice fiscale non sembra giusto (16 caratteri, o 11 cifre)" };
    s.emittenti[casa] = { nome: pulisci(d.nome, 80), cf, indirizzo: pulisci(d.indirizzo, 160), appartamento: pulisci(d.appartamento, 160) };
    await scrivi(conn, s);
    return vista();
  }

  if (op === "marche") {
    if (body.aggiungi) {
      const codice = String(body.aggiungi.codice || "").replace(/\D/g, "");
      const data = String(body.aggiungi.data || "");
      const err = marcaValida(codice, data);
      if (err) return { ok: false, error: err };
      if (s.marche.some((m) => m.codice === codice)) return { ok: false, error: "Questa marca da bollo è già nella scorta" };
      s.marche.push({ codice, data, usata: null, aggiunta: Date.now() });
      var assegnate = assegnaAiInAttesa(s);
    } else if (body.togli) {
      const m = s.marche.find((x) => x.codice === String(body.togli));
      if (!m) return { ok: false, error: "Marca non trovata" };
      if (m.usata) return { ok: false, error: "Questa marca è già usata in una ricevuta: resta nell'elenco" };
      s.marche = s.marche.filter((x) => x !== m);
    }
    await scrivi(conn, s);
    return { ...vista(), assegnate: assegnate || [] };
  }

  if (op === "salva") {
    const d = body.ricevuta || {};
    let r = d.id ? trova(d.id) : null;
    if (d.id && !r) return { ok: false, error: "Ricevuta non trovata" };
    if (r && (r.stato === "firmata" || r.stato === "annullata")) return { ok: false, error: "Una ricevuta già firmata non si cambia più: annullala e rifalla" };
    const casa = pulisci(d.casa, 40);
    const dal = String(d.dal || ""), al = String(d.al || "");
    const soggiorno = centesimi(d.soggiorno), tassa = centesimi(d.tassa);
    if (!casa) return { ok: false, error: "Scegli la casa" };
    if (!isoOk(dal) || !isoOk(al) || notti(dal, al) < 1) return { ok: false, error: "Controlla le date del soggiorno (la partenza dopo l'arrivo)" };
    if (notti(dal, al) > 90) return { ok: false, error: "Il soggiorno supera i 90 giorni: controlla le date" };
    if (!(soggiorno > 0)) return { ok: false, error: "Scrivi l'importo del soggiorno (es. 340,00)" };
    if (!(tassa >= 0)) return { ok: false, error: "L'imposta di soggiorno non è un importo valido" };
    // (in caso d'errore si esce SENZA scrivere: l'archivio letto a inizio richiesta si butta, quindi
    // le modifiche fatte qui sotto a r e alla scorta delle marche non restano)
    const nuovo = !r;
    if (!r) r = { id: nuovoId(), creata: Date.now() };
    Object.assign(r, {
      casa, dal, al, soggiorno, tassa,
      ospiti: pulisci(d.ospiti, 200),
      pagamento: PAGAMENTI.includes(d.pagamento) ? d.pagamento : "Airbnb",
      nota: pulisci(d.nota, 300),
      modificata: Date.now(),
    });
    const intest = intestatarioDa(d.intestatario);
    if (intest.nome) r.intestatario = intest;
    const chiediDati = !!d.chiediDati && !(r.intestatario && r.intestatario.nome && r.datiOspite);
    if (!chiediDati && !(r.intestatario && r.intestatario.nome)) return { ok: false, error: "Scrivi a chi intestare la ricevuta, oppure fai inserire i dati all'ospite col link" };
    const errMarca = assegnaMarca(s, r, d.marca);
    if (errMarca) return { ok: false, error: errMarca };
    // marca più nuova della data proposta (oggi): la ricevuta prende la data della marca
    if (r.marca && isoOk(d.data) && r.marca.data > d.data && d.data >= oggiRoma()) d.data = r.marca.data;
    if (chiediDati) {
      if (!(r.intestatario && r.intestatario.nome)) r.intestatario = null;
      r.stato = "dati";
      if (!r.tokOspite) r.tokOspite = token();
    } else {
      const err = preparaFirma(s, r, { numero: d.numero, data: d.data });
      if (err) return { ok: false, error: err };
    }
    if (nuovo) s.lista.push(r);
    await scrivi(conn, s);
    return { ...vista(), id: r.id };
  }

  if (op === "annulla") {
    const r = trova(body.id);
    if (!r) return { ok: false, error: "Ricevuta non trovata" };
    // marca già attaccata (ricevuta firmata) = consumata; prima della firma torna nella scorta
    if (r.stato !== "firmata") liberaMarca(s, r);
    r.stato = "annullata";
    r.annullata = Date.now();
    await scrivi(conn, s);
    return vista();
  }

  // togliere una ricevuta annullata = cancellarla del tutto (di solito una prova): la marca torna
  // nella scorta e il numero si libera
  if (op === "togli") {
    const r = trova(body.id);
    if (!r) return { ok: false, error: "Ricevuta non trovata" };
    if (r.stato !== "annullata") return { ok: false, error: "Prima annulla la ricevuta" };
    const m = r.marca && s.marche.find((x) => x.codice === r.marca.codice);
    if (m && (m.usata === r.id || !m.usata)) m.usata = null;
    if (r.firma && r.firma.url) { try { await require("./_blob").eliminaBlob(r.firma.url); } catch { /* resta il file, pazienza */ } }
    s.lista = s.lista.filter((x) => x !== r);
    await scrivi(conn, s);
    return vista();
  }

  // "♻️ Azzera tutto" (29/10/2026, l'utente dopo le prove: "devo cancellare, dammi possibilità di
  // reset"): via tutte le ricevute e le loro firme, le marche tornano libere nella scorta, la
  // numerazione riparte da 1. Restano la scorta delle marche e "Chi firma le ricevute".
  if (op === "azzera") {
    if (body.conferma !== "AZZERA") return { ok: false, error: "Conferma mancante" };
    for (const r of s.lista) if (r.firma && r.firma.url) { try { await require("./_blob").eliminaBlob(r.firma.url); } catch { /* pazienza */ } }
    s.lista = [];
    for (const m of s.marche) m.usata = null;
    await scrivi(conn, s);
    return vista();
  }

  if (op === "linkOspite") {
    const r = trova(body.id);
    if (!r) return { ok: false, error: "Ricevuta non trovata" };
    if (!r.tokOspite) { r.tokOspite = token(); await scrivi(conn, s); }
    return { ...vista(), tok: r.tokOspite };
  }

  if (op === "mandata") {
    const r = trova(body.id);
    if (!r) return { ok: false, error: "Ricevuta non trovata" };
    r.mandata = body.si === false ? null : Date.now();
    await scrivi(conn, s);
    return vista();
  }

  if (op === "pdf") {
    const r = trova(body.id);
    if (!r) return { ok: false, error: "Ricevuta non trovata" };
    if (r.stato !== "firmare" && r.stato !== "firmata") return { ok: false, error: "La ricevuta non è ancora completa" };
    const variante = ["ospite", "archivio"].includes(body.variante) ? body.variante : "ospite";
    let firma = null;
    if (r.stato === "firmata" && r.firma && r.firma.url) {
      const f = await require("./_blob").leggiBlob(r.firma.url);
      firma = f && f.buffer;
    }
    const buf = await pdfRicevuta(r, { variante, firma });
    return { ok: true, nome: nomeFile(r, variante), pdf: buf.toString("base64") };
  }

  return { ok: false, error: "Azione sconosciuta" };
}

function nomeFile(r, variante) {
  const chi = String((r.intestatario && r.intestatario.nome) || "ospite").normalize("NFD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  return `Ricevuta_${r.numero || "bozza"}-${r.anno || ""}_${chi}${variante === "archivio" ? "_ORIGINALE_con_marca" : ""}.pdf`;
}

// ---------- pagina pubblica /r/<codice>: l'ospite scrive i suoi dati, il proprietario firma ----------
function anteprima(r) {
  return {
    numero: r.numero, anno: r.anno, data: r.data, emittente: r.emittente, intestatario: r.intestatario,
    descrizione: descrizione(r), soggiorno: r.soggiorno, tassa: r.tassa, totale: totaleDi(r), lettere: inLettere(totaleDi(r)),
    pagamento: r.pagamento, marca: r.marca, nota: r.nota,
  };
}
async function avvisaHost(testo) {
  const t = process.env.NTFY_TOPIC;
  if (!t) return;
  try { await fetch(`https://ntfy.sh/${encodeURIComponent(t)}`, { method: "POST", headers: { Title: "Ricevute KeyFlow" }, body: testo }); }
  catch { /* l'avviso non è indispensabile */ }
}
async function azionePubblica(conn, body, { ip = "", nomeCasa = (id) => id } = {}) {
  const tok = String(body.tok || "").trim();
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(tok)) return { ok: false, error: "Il link è incompleto: copialo di nuovo per intero" };
  const s = await leggi(conn);
  const r = s.lista.find((x) => x.tokOspite === tok || x.tokFirma === tok);
  if (!r) return { ok: false, error: "Questo link non è valido o non vale più" };
  const modo = r.tokFirma === tok ? "firma" : "ospite";
  if (r.stato === "annullata") return { ok: false, error: "Questa ricevuta è stata annullata: il link non vale più" };
  const op = String(body.op || "apri");

  if (modo === "ospite") {
    const base = { ok: true, modo, casa: nomeCasa(r.casa), dal: r.dal, al: r.al };
    // ricevuta firmata: dallo STESSO link l'ospite la vede e scarica il PDF (29/10/2026, l'utente: "non
    // posso mandare il PDF sulla chat di Airbnb: manda un link per scaricarlo")
    if (r.stato === "firmata") {
      if (op === "pdf") {
        let firma = null;
        if (r.firma && r.firma.url) { const f = await require("./_blob").leggiBlob(r.firma.url); firma = f && f.buffer; }
        if (!r.scaricata) { r.scaricata = Date.now(); await scrivi(conn, s); await avvisaHost(`📥 ${(r.intestatario && r.intestatario.nome) || "L'ospite"} ha aperto la ricevuta ${etichetta(r)}`); }
        return { ok: true, nome: nomeFile(r, "ospite"), pdf: (await pdfRicevuta(r, { variante: "ospite", firma })).toString("base64") };
      }
      return { ...base, pronta: true, numero: r.numero, anno: r.anno };
    }
    if (r.stato !== "dati" || r.datiOspite) return { ...base, fatto: true };
    if (op === "apri") return base;
    if (op !== "dati") return { ok: false, error: "Azione non valida" };
    const intest = intestatarioDa(body.intestatario);
    if (intest.nome.length < 2) return { ok: false, error: "Scrivi il nome o la ragione sociale" };
    if (intest.cf.replace(/[^A-Z0-9]/g, "").length < 11) return { ok: false, error: "Scrivi il codice fiscale o la partita IVA" };
    if (intest.indirizzo.length < 5) return { ok: false, error: "Scrivi l'indirizzo" };
    r.intestatario = intest;
    r.datiOspite = { ts: Date.now(), ip: String(ip).slice(0, 60) };
    // se il resto è già pronto passa subito "da firmare"; sennò l'host completa dal gestionale
    const err = preparaFirma(s, r, {});
    await scrivi(conn, s);
    await avvisaHost(`💶 Dati per la ricevuta arrivati: ${intest.nome}` + (err ? ". Completala in KeyFlow." : manca(r) ? ` · ricevuta ${etichetta(r)}: manca solo la marca da bollo, poi è da firmare` : ` · ricevuta ${etichetta(r)} pronta da far firmare a ${r.emittente.nome}`));
    return { ...base, fatto: true };
  }

  // firma del proprietario
  if (r.stato === "firmata") {
    if (op === "pdf") {
      let firma = null;
      if (r.firma && r.firma.url) { const f = await require("./_blob").leggiBlob(r.firma.url); firma = f && f.buffer; }
      return { ok: true, pdf: (await pdfRicevuta(r, { variante: "ospite", firma })).toString("base64") };
    }
    return { ok: true, modo, firmata: r.firma && r.firma.ts, ricevuta: anteprima(r) };
  }
  if (r.stato !== "firmare") return { ok: false, error: "La ricevuta non è ancora pronta da firmare" };
  if (manca(r)) return { ok: false, error: "La ricevuta aspetta ancora la marca da bollo: si potrà firmare appena c'è" };
  if (op === "apri") return { ok: true, modo, ricevuta: anteprima(r) };
  if (op === "pdf") return { ok: true, pdf: (await pdfRicevuta(r, { variante: "ospite" })).toString("base64") };
  if (op !== "firma") return { ok: false, error: "Azione non valida" };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.png || ""));
  if (!m) return { ok: false, error: "Firma mancante" };
  const png = Buffer.from(m[1], "base64");
  if (png.length < 200 || png.length > 800000) return { ok: false, error: "Firma non valida: riprova" };
  const { salvaBlob } = require("./_blob");
  const salvato = await salvaBlob(`ricevute-pagamento/firma-${r.id}.png`, png, "image/png");
  r.firma = { url: salvato.url, ts: Date.now(), ip: String(ip).slice(0, 60) };
  r.stato = "firmata";
  await scrivi(conn, s);
  await avvisaHost(`✍️ ${r.emittente.nome} ha firmato la ricevuta ${etichetta(r)} per ${(r.intestatario && r.intestatario.nome) || "l'ospite"}: ora puoi mandarla.`);
  return { ok: true, modo, firmata: r.firma.ts, ricevuta: anteprima(r) };
}

// ---------- PDF ----------
function descrizione(r) {
  const n = notti(r.dal, r.al);
  const app = indirizzoBello((r.emittente && r.emittente.appartamento) || "");
  return `Locazione turistica dell'appartamento${app ? " in " + app : ""}, dal ${isoIt(r.dal)} al ${isoIt(r.al)} (${n} nott${n === 1 ? "e" : "i"})`
    + (r.ospiti ? `. Ospiti: ${r.ospiti}` : "") + ".";
}

async function pdfRicevuta(r, { variante = "ospite", firma = null } = {}) {
  const { PDFDocument, rgb } = require("pdf-lib");
  const fontkit = require("@pdf-lib/fontkit");
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(path.join(__dirname, "_fonts", "DejaVuSans.ttf")), { subset: true });
  const bold = await pdf.embedFont(fs.readFileSync(path.join(__dirname, "_fonts", "DejaVuSans-Bold.ttf")), { subset: true });
  pdf.setTitle(`Ricevuta ${r.numero}/${r.anno}`);
  pdf.setAuthor((r.emittente && r.emittente.nome) || "");
  const W = 595.28, H = 841.89, M = 56, LW = W - M * 2;
  const page = pdf.addPage([W, H]);
  const nero = rgb(0.08, 0.08, 0.1), grigio = rgb(0.42, 0.44, 0.48), linea = rgb(0.82, 0.83, 0.86);
  let y = H - M;

  const righe = (testo, size, f, larg) => {
    const out = [];
    for (const par of String(testo).split("\n")) {
      let cur = "";
      for (const w of par.split(" ")) {
        const t = cur ? cur + " " + w : w;
        if (f.widthOfTextAtSize(t, size) > larg && cur) { out.push(cur); cur = w; } else cur = t;
      }
      out.push(cur);
    }
    return out;
  };
  const scrivi = (testo, { x = M, size = 10.5, f = font, colore = nero, larg = LW, interl = 1.42 } = {}) => {
    for (const l of righe(testo, size, f, larg)) { page.drawText(l, { x, y, size, font: f, color: colore }); y -= size * interl; }
  };
  const destra = (testo, yy, size, f, colore = nero) => page.drawText(testo, { x: W - M - f.widthOfTextAtSize(testo, size), y: yy, size, font: f, color: colore });
  const riga = (gap = 10) => { y -= gap / 2; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: linea }); y -= gap; };
  const titoletto = (t) => { scrivi(t.toUpperCase(), { size: 8, f: bold, colore: grigio }); y -= 1; };

  // intestazione
  const anteprimaBozza = r.stato !== "firmata";
  const quale = variante === "archivio" ? "ORIGINALE · conservato dall'emittente" : "Copia per il cliente";
  page.drawText("RICEVUTA DI PAGAMENTO", { x: M, y, size: 19, font: bold, color: nero });
  destra(`N. ${r.numero}/${r.anno}`, y + 1, 15, bold);
  y -= 20;
  page.drawText(quale, { x: M, y, size: 9, font, color: grigio });
  destra(`Data ${isoIt(r.data)}`, y, 10.5, font);
  y -= 8;
  riga(14);

  // chi emette / chi paga, su due colonne
  const colW = LW / 2 - 12, yTop = y;
  const blocco = (x, tit, nome, sotto) => {
    let yy = yTop;
    page.drawText(tit.toUpperCase(), { x, y: yy, size: 8, font: bold, color: grigio }); yy -= 14;
    for (const l of righe(nome, 11.5, bold, colW)) { page.drawText(l, { x, y: yy, size: 11.5, font: bold, color: nero }); yy -= 15; }
    for (const s of sotto.filter(Boolean)) for (const l of righe(s, 10, font, colW)) { page.drawText(l, { x, y: yy, size: 10, font, color: nero }); yy -= 13.5; }
    return yy;
  };
  const em = r.emittente || {}, it = r.intestatario || {};
  const yA = blocco(M, "Emittente", em.nome || "", [em.indirizzo, em.cf && `C.F. ${em.cf}`]);
  const cfIt = it.cf ? (/^\d{11}$/.test(it.cf) ? `P.IVA / C.F. ${it.cf}` : `C.F. / P.IVA ${it.cf}`) : "";
  const yB = blocco(M + LW / 2 + 12, "Ricevuti da", it.nome || "", [it.indirizzo, cfIt]);
  y = Math.min(yA, yB) - 6;
  riga(14);

  // la somma
  const tot = totaleDi(r);
  titoletto("La somma di");
  y -= 14;
  page.drawText(`€ ${euro(tot)}`, { x: M, y, size: 20, font: bold, color: nero });
  y -= 17;
  scrivi(`(${inLettere(tot)} euro)`, { size: 10, colore: grigio });
  y -= 6;
  titoletto("Per");
  scrivi(descrizione(r) + (r.nota ? " " + r.nota : ""), { size: 10.5 });
  y -= 6;

  // dettaglio
  const voce = (nome, imp, nota) => {
    page.drawText(nome, { x: M, y, size: 10.5, font, color: nero });
    destra(`€ ${euro(imp)}`, y, 10.5, font);
    y -= 13;
    if (nota) scrivi(nota, { size: 8.5, colore: grigio, larg: LW - 90 });
    y -= 4;
  };
  riga(18);
  voce("Corrispettivo della locazione", r.soggiorno, "Operazione fuori campo IVA ai sensi dell'art. 4 del D.P.R. 633/1972 (locazione da privato, senza attività d'impresa).");
  if (r.tassa) voce("Imposta di soggiorno", r.tassa, "Esclusa da IVA ai sensi dell'art. 15 del D.P.R. 633/1972.");
  page.drawText("Totale", { x: M, y, size: 11.5, font: bold, color: nero });
  destra(`€ ${euro(tot)}`, y, 11.5, bold);
  y -= 18;
  scrivi(`Pagamento ricevuto tramite: ${r.pagamento || "Airbnb"}.`, { size: 10 });
  y -= 8;

  // marca da bollo
  if (r.marca) {
    const dm = isoIt(r.marca.data);
    if (variante === "archivio") {
      const bw = 118, bh = 132;
      page.drawRectangle({ x: M, y: y - bh, width: bw, height: bh, borderColor: grigio, borderWidth: 0.9, borderDashArray: [4, 3] });
      const t = ["Marca da bollo", "€ 2,00", "", `n. ${r.marca.codice}`, `del ${dm}`];
      let yy = y - 22;
      for (const l of t) { const sz = l.startsWith("n.") ? 7.6 : 9; page.drawText(l, { x: M + (bw - font.widthOfTextAtSize(l, sz)) / 2, y: yy, size: sz, font, color: grigio }); yy -= 13; }
      const yS = y;
      y -= 6;
      scrivi("Imposta di bollo di € 2,00 assolta con il contrassegno applicato su questo originale.", { x: M + bw + 14, size: 9.5, larg: LW - bw - 14 });
      y = Math.min(y, yS - bh) - 10;
    } else {
      scrivi(`Imposta di bollo di € 2,00 assolta sull'originale conservato dall'emittente: contrassegno n. ${r.marca.codice} del ${dm}.`, { size: 9.5, colore: grigio });
      y -= 6;
    }
  }

  // firma
  y -= 10;
  const xF = W - M - 230;
  page.drawText("Firma", { x: xF, y, size: 8, font: bold, color: grigio });
  y -= 6;
  if (firma) {
    try {
      const img = await pdf.embedPng(firma);
      const sc = Math.min(220 / img.width, 80 / img.height);
      page.drawImage(img, { x: xF, y: y - img.height * sc, width: img.width * sc, height: img.height * sc });
      y -= img.height * sc + 4;
    } catch { y -= 60; }
  } else y -= 60;
  page.drawLine({ start: { x: xF, y }, end: { x: W - M, y }, thickness: 0.7, color: linea });
  y -= 13;
  page.drawText(em.nome || "", { x: xF, y, size: 10, font, color: nero });
  y -= 12;
  if (r.firma && r.firma.ts) {
    const q = new Date(r.firma.ts).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    page.drawText(`Firmata elettronicamente il ${q.replace(",", " alle")}`, { x: xF, y, size: 8, font, color: grigio });
  }

  if (anteprimaBozza) {
    const t = "ANTEPRIMA · DA FIRMARE";
    page.drawText(t, { x: W / 2 - bold.widthOfTextAtSize(t, 40) / 2 + 40, y: H / 2 - 120, size: 40, font: bold, color: rgb(0.86, 0.2, 0.3), opacity: 0.16, rotate: { type: "degrees", angle: 30 } });
  }
  return Buffer.from(await pdf.save());
}

module.exports = { indirizzoBello, azioneRicevute, azionePubblica, pdfRicevuta, inLettere, centesimi, euro, descrizione, KEY, SOGLIA_BOLLO };
