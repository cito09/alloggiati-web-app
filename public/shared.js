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

async function apiExtract(images,kind,text){
  const n=images.length;
  // con poche foto teniamo alta la qualità; con molte foto rimpiccioliamo per stare
  // sotto il limite di dimensione della richiesta di Vercel (~4.5MB), altrimenti
  // la connessione cade e il browser mostra "Failed to fetch".
  let max=n<=2?1600:1400, q=n<=2?0.82:0.72;
  let small=await Promise.all(images.map(d=>downscale(d,max,q)));
  const LIMITE=3.8*1024*1024; // margine di sicurezza sotto i 4.5MB
  // se è ancora troppo, riduciamo progressivamente finché ci sta (le foto restano leggibili)
  for(let tent=0; tent<3 && small.reduce((s,d)=>s+dataUrlBytes(d),0)>LIMITE; tent++){
    max=Math.round(max*0.8); q=Math.max(0.55,q-0.08);
    small=await Promise.all(images.map(d=>downscale(d,max,q)));
  }
  const resp=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({images:small,kind,text:text||''})});
  const data=await resp.json();
  if(!resp.ok) throw new Error(data.error||'Errore estrazione');
  return data;
}

// accetta immagini e PDF (documenti salvati come file): il PDF passa cosi' com'e',
// downscale() lo lascia intatto (img.onerror) e il server lo manda all'AI come documento
function onlyImages(files){return [...(files||[])].filter(f=>f&&f.type&&(f.type.startsWith('image/')||f.type==='application/pdf'));}

/* selettore calendario: converte tra gg/mm/aaaa (usato ovunque nell'app) e aaaa-mm-gg (input type=date) */
function dateToItalian(iso){ if(!iso)return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function italianToIso(gg){ const m=(gg||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m?`${m[3]}-${m[2]}-${m[1]}`:''; }
