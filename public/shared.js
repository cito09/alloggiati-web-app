// shared.js — funzioni riusate sia dall'app admin (index.html) sia dalla pagina
// pubblica di self check-in (checkin.html), per non duplicare la stessa logica.

function fileToDataURL(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});}

// riduce l'immagine prima dell'upload (payload piu' leggero, meno costo AI)
function downscale(dataURL,max=1600,q=0.82){return new Promise(res=>{const img=new Image();
  img.onload=()=>{let{width:w,height:h}=img; if(Math.max(w,h)>max){const r=max/Math.max(w,h);w=Math.round(w*r);h=Math.round(h*r);}
    const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
    res(c.toDataURL('image/jpeg',q));};
  img.onerror=()=>res(dataURL); img.src=dataURL;});}

async function apiExtract(images,kind){
  const small=await Promise.all(images.map(d=>downscale(d)));
  const resp=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({images:small,kind})});
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
