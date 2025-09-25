// ----- UI refs
const uploadBtn = document.getElementById('uploadBtn');
const resetBtn  = document.getElementById('resetBtn');
const exportBtn = document.getElementById('exportBtn');
const fileInput = document.getElementById('fileInput');

const preview   = document.getElementById('preview');
const pctx      = preview.getContext('2d');
const nav       = document.getElementById('nav');
const nctx      = nav.getContext('2d');
const hist      = document.getElementById('hist');
const hctx      = hist.getContext('2d');
const dimsEl    = document.getElementById('dims');
const sizeInfo  = document.getElementById('sizeInfo');
const fitPctEl  = document.getElementById('fitPct');
const zoomLabel = document.getElementById('zoomLabel');
const catAll    = document.getElementById('catAll');
const catPrev   = document.getElementById('catPrev');

const basicHost = document.getElementById('basic');
const colorHost = document.getElementById('color');

// ----- State
const MAX_PREVIEW = 1400;
let catalog = [];
let current = -1;

const srcCanvas = document.createElement('canvas');
const srcCtx    = srcCanvas.getContext('2d');

let zoom = 1, panX = 0, panY = 0;

// Core settings (kept small to avoid overload)
let S = {
  exposure: 0,        // EV
  contrast: 0,        // -100..100
  highlights: 0,      // -100..100
  shadows: 0,         // -100..100
  temperature: 0,     // -100 cool .. +100 warm
  tint: 0,            // -100 magenta .. +100 green
  saturation: 0,      // -100..100
  vibrance: 0         // -100..100
};

// ----- Controls
const groups = {
  basic: [
    ['exposure',   -4,   4, 0, 0.01],
    ['contrast', -100, 100, 0, 1],
    ['highlights',-100, 100, 0, 1],
    ['shadows',  -100, 100, 0, 1]
  ],
  color: [
    ['temperature',-100,100, 0, 1],
    ['tint',       -100,100, 0, 1],
    ['saturation', -100,100, 0, 1],
    ['vibrance',   -100,100, 0, 1]
  ]
};

buildControls(basicHost, groups.basic);
buildControls(colorHost, groups.color);

function buildControls(host, defs){
  defs.forEach(([key,min,max,val,step])=>{
    const wrap = document.createElement('div'); wrap.className='control';
    const label = document.createElement('label'); label.textContent = key[0].toUpperCase()+key.slice(1);
    const v = document.createElement('div'); v.className='val'; v.id=key+'Val'; v.textContent=S[key];
    const r = document.createElement('input'); r.type='range'; r.min=min; r.max=max; r.step=step; r.value=S[key]; r.id=key;
    r.oninput = ()=>{ S[key] = parseFloat(r.value); v.textContent = r.value; render(); };
    wrap.appendChild(label); wrap.appendChild(v); host.appendChild(wrap); host.appendChild(r);
  });
}

// ----- Import
uploadBtn.onclick = ()=> fileInput.click();
fileInput.onchange = async (e)=>{
  const f = e.target.files[0];
  if(!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  await new Promise(res => { img.onload = res; img.src = url; });

  srcCanvas.width  = img.naturalWidth;
  srcCanvas.height = img.naturalHeight;
  srcCtx.drawImage(img, 0, 0);

  catalog.push({ name:f.name, w:img.naturalWidth, h:img.naturalHeight });
  current = catalog.length-1;
  catAll.textContent = catalog.length;
  catPrev.textContent = 1;

  dimsEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
  sizeInfo.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
  resetBtn.disabled = false; exportBtn.disabled = true; // enable after first render

  zoom = 1; panX = 0; panY = 0;
  render();
};

// ----- Render preview
function render(){
  if(!srcCanvas.width) return;

  // scale to preview
  const scale = Math.min(MAX_PREVIEW/srcCanvas.width, MAX_PREVIEW/srcCanvas.height, 1);
  const pw = Math.round(srcCanvas.width*scale);
  const ph = Math.round(srcCanvas.height*scale);

  // Draw source to temp canvas for speed
  const temp = document.createElement('canvas');
  temp.width = pw; temp.height = ph;
  const tctx = temp.getContext('2d');
  tctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, pw, ph);

  // Get pixels and apply adjustments (small but real)
  let imgData = tctx.getImageData(0,0,pw,ph);
  imgData = applyAdjustments(imgData, S);
  tctx.putImageData(imgData,0,0);

  // draw onto preview respecting zoom/pan
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const fit = Math.min((stage.width-24)/pw, (stage.height-24)/ph);
  fitPctEl.textContent = Math.round(fit*100)+'%';
  zoomLabel.textContent = zoom < 1 ? 'FIT' : (Math.abs(zoom-1)<0.01 ? '1:1' : 'ZOOM');

  const dw = Math.round(pw*fit*zoom);
  const dh = Math.round(ph*fit*zoom);
  preview.width = Math.max(dw,1);
  preview.height= Math.max(dh,1);
  pctx.clearRect(0,0,preview.width,preview.height);
  pctx.drawImage(temp, 0,0,pw,ph, panX,panY,dw,dh);

  // histogram + navigator
  drawHistogram(imgData);
  drawNavigator(temp);
  exportBtn.disabled = false; // ready to export
}

// ----- Pixel operations (lean)
function applyAdjustments(imageData, s){
  const d = imageData.data;
  const expK = Math.pow(2, s.exposure||0);
  const cK = 1 + (s.contrast||0)/100;
  const satK = (s.saturation||0)/100;
  const vibK = (s.vibrance||0)/100;
  const tempK = (s.temperature||0)/100; // -1..1
  const tintK = (s.tint||0)/100;       // -1..1

  for(let i=0;i<d.length;i+=4){
    let r = d[i]/255, g = d[i+1]/255, b = d[i+2]/255;

    // Exposure
    r*=expK; g*=expK; b*=expK;

    // White balance approx
    r *= 1 + 0.12*tempK - 0.05*tintK; // warm shifts red
    g *= 1 + 0.10*tintK;              // tint shifts green
    b *= 1 - 0.12*tempK - 0.05*tintK; // cool shifts blue
    r = clamp(r,0,1); g = clamp(g,0,1); b = clamp(b,0,1);

    // Highlights/Shadows (luma mask)
    let l = 0.299*r+0.587*g+0.114*b;
    if(s.shadows) {
      const m = 1 - smoothstep(0,0.6,l);
      const a = 1 + (s.shadows/100)*m;
      r*=a; g*=a; b*=a;
    }
    if(s.highlights){
      const m = smoothstep(0.4,1.0,l);
      const a = 1 - (s.highlights/100)*m;
      r*=a; g*=a; b*=a;
    }

    // Contrast (soft around 0.5)
    r = softContrast(r,cK); g = softContrast(g,cK); b = softContrast(b,cK);

    // Vibrance then Saturation (HSV-ish)
    let mx=Math.max(r,g,b), mn=Math.min(r,g,b), C=mx-mn;
    let V=mx, S = mx===0?0: C/mx;
    S = S + (1 - S) * Math.max(0, vibK);
    S = clamp(S*(1+satK), 0, 1);
    // Rebuild rgb with original hue/value quick method:
    // (cheap blend towards grey by 1-S)
    const grey = V;
    r = mix(grey, r, S); g = mix(grey, g, S); b = mix(grey, b, S);

    d[i]=Math.round(255*clamp(r,0,1));
    d[i+1]=Math.round(255*clamp(g,0,1));
    d[i+2]=Math.round(255*clamp(b,0,1));
  }
  return imageData;
}

function softContrast(v,k){ const m=0.5; return clamp((v-m)*k+m,0,1); }
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function mix(a,b,t){ return a*(1-t)+b*t; }
function smoothstep(a,b,x){ x=clamp((x-a)/(b-a),0,1); return x*x*(3-2*x); }

// ----- Histogram (RGB lines)
function drawHistogram(imgData){
  const w = hist.width = hist.clientWidth || 300;
  const h = hist.height = hist.clientHeight || 70;
  const bins = 256;
  const rArr=new Uint32Array(bins), gArr=new Uint32Array(bins), bArr=new Uint32Array(bins);
  const d = imgData.data;
  for(let i=0;i<d.length;i+=4){ rArr[d[i]]++; gArr[d[i+1]]++; bArr[d[i+2]]++; }
  const max = Math.max(Math.max(...rArr),Math.max(...gArr),Math.max(...bArr));
  hctx.clearRect(0,0,w,h);
  drawLine(rArr,'#ff7b7b'); drawLine(gArr,'#5bf0b8'); drawLine(bArr,'#7aa8ff');
  function drawLine(arr,color){
    hctx.beginPath();
    for(let i=0;i<bins;i++){
      const v = arr[i]/max; const y = h - v*h;
      i===0 ? hctx.moveTo(0,y) : hctx.lineTo((i/bins)*w, y);
    }
    hctx.strokeStyle=color; hctx.lineWidth=1; hctx.stroke();
  }
}

// ----- Navigator
function drawNavigator(temp){
  const w = nav.width = nav.clientWidth || 260;
  const h = nav.height = 180;
  nctx.fillStyle='#000'; nctx.fillRect(0,0,w,h);

  const s = Math.min(w/temp.width, h/temp.height);
  const dw = temp.width*s, dh = temp.height*s;
  const ox = (w-dw)/2, oy=(h-dh)/2;
  nctx.drawImage(temp, 0,0,temp.width,temp.height, ox,oy,dw,dh);

  // viewport (approx)
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const fit = Math.min((stage.width-24)/temp.width, (stage.height-24)/temp.height);
  const vw = (stage.width-24) / (1/fit); // not perfect but close
  const vh = (stage.height-24)/ (1/fit);
  const rw = (dw / temp.width) * (temp.width*fit*zoom) / (1/fit);
  const rh = (dh / temp.height)* (temp.height*fit*zoom) / (1/fit);
  const rx = ox - panX*s/fit/zoom;
  const ry = oy - panY*s/fit/zoom;
  nctx.strokeStyle='rgba(255,255,255,.85)'; nctx.lineWidth=1.5;
  nctx.strokeRect(rx, ry, Math.max(20,rw), Math.max(20,rh));

  // click to pan
  nav.onclick = (e)=>{
    const r = nav.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const imgX = (x-ox)/s, imgY = (y-oy)/s;
    panX = Math.round((stage.width-24)/2 - imgX*fit*zoom);
    panY = Math.round((stage.height-24)/2 - imgY*fit*zoom);
    render();
  };
}

// ----- Reset & Export
resetBtn.onclick = ()=>{
  S = {exposure:0,contrast:0,highlights:0,shadows:0,temperature:0,tint:0,saturation:0,vibrance:0};
  Object.keys(S).forEach(k=>{
    const el = document.getElementById(k);
    const v  = document.getElementById(k+'Val');
    if(el){ el.value = S[k]; }
    if(v){ v.textContent = S[k]; }
  });
  zoom = 1; panX=0; panY=0;
  render();
};

exportBtn.onclick = ()=>{
  if(!srcCanvas.width) return;
  // Re-apply at full-res
  const out = document.createElement('canvas');
  out.width = srcCanvas.width; out.height = srcCanvas.height;
  const octx = out.getContext('2d');
  octx.drawImage(srcCanvas,0,0);
  let data = octx.getImageData(0,0,out.width,out.height);
  data = applyAdjustments(data, S);
  octx.putImageData(data,0,0);
  const a = document.createElement('a');
  a.download = (catalog[current]?.name || 'nile_edited')+'.png';
  a.href = out.toDataURL('image/png');
  a.click();
};
