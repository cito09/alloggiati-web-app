// shared.js — funzioni riusate sia dall'app admin (index.html) sia dalla pagina
// pubblica di self check-in (checkin.html), per non duplicare la stessa logica.

function fileToDataURL(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});}

// riduce l'immagine prima dell'upload (payload piu' leggero, meno costo AI)
function downscale(dataURL,max=1600,q=0.82){return new Promise(res=>{const img=new Image();
  img.onload=()=>{let{width:w,height:h}=img; if(Math.max(w,h)>max){const r=max/Math.max(w,h);w=Math.round(w*r);h=Math.round(h*r);}
    const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
    res(c.toDataURL('image/jpeg',q));};
  img.onerror=()=>res(dataURL); img.src=dataURL;});}

// stima dei byte di un data-URL base64 (per non superare il limite ~4.5MB di Vercel)
function dataUrlBytes(d){ const i=String(d).indexOf(','); return Math.ceil((String(d).length-(i+1))*0.75); }

// comprime un gruppo di immagini finché il totale sta sotto il limite indicato (i PDF non
// vengono toccati: downscale() li lascia intatti). Usata sia per mandare le foto all'AI
// (apiExtract) sia per l'invio finale del check-in: senza questo, con più foto/documenti
// pesanti si supera il limite di dimensione delle richieste di Vercel (~4.5MB) e l'invio
// fallisce (a volte come "Failed to fetch", a volte con errori diversi a seconda del browser).
// IMPORTANTE: 'limiteBytes' è la dimensione TRASPORTATA (i data-URL viaggiano in base64 dentro
// il JSON, ~+33% rispetto ai byte reali dell'immagine). Misurando la lunghezza della stringa
// misuriamo esattamente ciò che pesa nella richiesta, che è quello che conta per il limite
// di Vercel (~4,5 MB): con la vecchia misura sui byte "decodificati" il conto sballava di 1/3
// e la richiesta poteva sforare pur sembrando sotto soglia.
async function comprimiPerLimite(images,{max=1600,q=0.82,limiteBytes=3.2*1024*1024,tentativi=7}={}){
  const pesoTrasportato=arr=>arr.reduce((s,d)=>s+String(d||'').length,0);
  let out=await Promise.all(images.map(d=>downscale(d,max,q)));
  for(let t=0; t<tentativi && pesoTrasportato(out)>limiteBytes; t++){
    max=Math.round(max*0.8); q=Math.max(0.45,q-0.07);
    out=await Promise.all(images.map(d=>downscale(d,max,q)));
  }
  return out;
}

async function apiExtract(images,kind,text){
  const n=images.length;
  // con poche foto teniamo alta la qualità; con molte foto rimpiccioliamo per stare sotto il limite
  const small=await comprimiPerLimite(images,{max:n<=2?1600:1400, q:n<=2?0.82:0.72, limiteBytes:3.2*1024*1024, tentativi:7});
  let resp;
  try{
    resp=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({images:small,kind,text:text||''})});
  }catch(e){ throw new Error('connessione: '+((e&&e.message)||e)); }
  // il server può rispondere con un errore NON in JSON (es. "Request Entity Too Large"):
  // leggiamo prima come testo, così non usciamo mai col criptico "Unexpected token".
  let testo=''; try{ testo=await resp.text(); }catch(e){}
  let data=null; try{ data=JSON.parse(testo); }catch(e){}
  if(!resp.ok || !data){
    if(resp.status===413 || /request entity too large|payload too large|too large/i.test(testo)){
      const err=new Error('Le foto sono troppo pesanti: riprova con meno foto per volta.');
      err._fotoGrandi=true; throw err;
    }
    throw new Error((data&&data.error)||('Errore estrazione (HTTP '+(resp.status||'?')+')'));
  }
  return data;
}

// accetta immagini e PDF (documenti salvati come file): il PDF passa cosi' com'e',
// downscale() lo lascia intatto (img.onerror) e il server lo manda all'AI come documento
function onlyImages(files){return [...(files||[])].filter(f=>f&&f.type&&(f.type.startsWith('image/')||f.type==='application/pdf'));}

/* selettore calendario: converte tra gg/mm/aaaa (usato ovunque nell'app) e aaaa-mm-gg (input type=date) */
function dateToItalian(iso){ if(!iso)return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function italianToIso(gg){ const m=(gg||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m?`${m[3]}-${m[2]}-${m[1]}`:''; }

/* luogo di rilascio delle patenti: Alloggiati Web vuole un comune o uno stato, non l'ente.
   Se sul documento (campo 4c) c'è la Motorizzazione ("MCTC-BO", "MIT-UCO TN", ecc.),
   convertiamo la sigla provincia nel capoluogo. */
const CAPOLUOGHI_PROVINCIA={AG:"AGRIGENTO",AL:"ALESSANDRIA",AN:"ANCONA",AO:"AOSTA",AP:"ASCOLI PICENO",AQ:"L'AQUILA",AR:"AREZZO",AT:"ASTI",AV:"AVELLINO",BA:"BARI",BG:"BERGAMO",BI:"BIELLA",BL:"BELLUNO",BN:"BENEVENTO",BO:"BOLOGNA",BR:"BRINDISI",BS:"BRESCIA",BT:"BARLETTA",BZ:"BOLZANO",CA:"CAGLIARI",CB:"CAMPOBASSO",CE:"CASERTA",CH:"CHIETI",CL:"CALTANISSETTA",CN:"CUNEO",CO:"COMO",CR:"CREMONA",CS:"COSENZA",CT:"CATANIA",CZ:"CATANZARO",EN:"ENNA",FC:"FORLI'",FE:"FERRARA",FG:"FOGGIA",FI:"FIRENZE",FM:"FERMO",FR:"FROSINONE",GE:"GENOVA",GO:"GORIZIA",GR:"GROSSETO",IM:"IMPERIA",IS:"ISERNIA",KR:"CROTONE",LC:"LECCO",LE:"LECCE",LI:"LIVORNO",LO:"LODI",LT:"LATINA",LU:"LUCCA",MB:"MONZA",MC:"MACERATA",ME:"MESSINA",MI:"MILANO",MN:"MANTOVA",MO:"MODENA",MS:"MASSA",MT:"MATERA",NA:"NAPOLI",NO:"NOVARA",NU:"NUORO",OR:"ORISTANO",PA:"PALERMO",PC:"PIACENZA",PD:"PADOVA",PE:"PESCARA",PG:"PERUGIA",PI:"PISA",PN:"PORDENONE",PO:"PRATO",PR:"PARMA",PT:"PISTOIA",PU:"PESARO",PV:"PAVIA",PZ:"POTENZA",RA:"RAVENNA",RC:"REGGIO DI CALABRIA",RE:"REGGIO NELL'EMILIA",RG:"RAGUSA",RI:"RIETI",RM:"ROMA",RN:"RIMINI",RO:"ROVIGO",SA:"SALERNO",SI:"SIENA",SO:"SONDRIO",SP:"LA SPEZIA",SR:"SIRACUSA",SS:"SASSARI",SU:"CARBONIA",SV:"SAVONA",TA:"TARANTO",TE:"TERAMO",TN:"TRENTO",TO:"TORINO",TP:"TRAPANI",TR:"TERNI",TS:"TRIESTE",TV:"TREVISO",UD:"UDINE",VA:"VARESE",VB:"VERBANIA",VC:"VERCELLI",VE:"VENEZIA",VI:"VICENZA",VR:"VERONA",VT:"VITERBO",VV:"VIBO VALENTIA"};
function normalizzaLuogoRilascio(v){
  const s=String(v||'').trim(); if(!s)return s;
  if(!/\b(MCTC|MC ?- ?TC|MIT|UCO|MOTORIZ)/i.test(s)) return s;
  const sig=/(?:^|[^A-Z])([A-Z]{2})(?:[^A-Z]|$)/.exec(s.toUpperCase().replace(/\bMC\s*-?\s*TC\b/g,' ').replace(/\b(MCTC|MIT|UCO|IT)\b/g,' '));
  const cap=sig&&CAPOLUOGHI_PROVINCIA[sig[1]];
  if(cap)return cap;
  // "Motorizzazione di Bologna" → prova col nome scritto per esteso
  const m=/(?:DI|DEL|DELLA)\s+([A-ZÀ-Ù' ]{3,})$/i.exec(s);
  return m?m[1].trim().toUpperCase():s;
}
