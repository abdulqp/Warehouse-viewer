// ---------- Imports ----------
import * as THREE from 'three';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
window.THREE = THREE; // optional

// ---------- Config ----------
const LAYOUT_URL    = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRzha8xG_h2ykIvkRP1D8JKW8xDt1IwBR3eNQLkTGlyQrSH--eQpeZlMvcghyVhOqiG5n52oAZTAQ-A/pub?gid=1735579934&single=true&output=csv';
const INVENTORY_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRzha8xG_h2ykIvkRP1D8JKW8xDt1IwBR3eNQLkTGlyQrSH--eQpeZlMvcghyVhOqiG5n52oAZTAQ-A/pub?gid=761377476&single=true&output=csv';

// Auto-refresh (ms)
const POLL_MS = 0;

// SKU header detection (flexible)
const SKU_FIELDS = ['SKU','ITEM NO','ITEM_NO','ITEMNO','ITEM CODE','ITEM','SKU NO','SKU#','PRODUCT CODE','PRODUCT','CODE'];

// ---------- State ----------
const state = {
  layout: [],
  inventory: new Map(),   // LOCATION -> row
  objects: [],
  scene: null, camera: null, renderer: null, controls: null,
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),
  tooltip: null,
  polling: null
};
const skuIndex = new Map();
const originalMats = new WeakMap();
let lastHash = { layout:'', inventory:'' };

// ---------- DOM helpers ----------
const $ = (id)=> document.getElementById(id);
function setStatus(msg){ const el=$('status'); if (el) el.textContent = msg; }

// ---------- CSV ----------
function parseCSV(text){
  const rows=[]; let i=0, field='', row=[], inQ=false;
  while(i<text.length){
    const c=text[i];
    if(c==='"'){ if(inQ && text[i+1]==='"'){ field+='"'; i+=2; continue; } inQ=!inQ; i++; continue; }
    if(!inQ && c===','){ row.push(field); field=''; i++; continue; }
    if(!inQ && (c==='\n'||c==='\r')){ if(field.length||row.length){ row.push(field); rows.push(row); row=[]; field=''; }
      if(c==='\r'&&text[i+1]==='\n') i++; i++; continue; }
    field+=c; i++;
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  const header = rows.shift().map(h=>h.trim());
  return rows.filter(r=>r.length && r.some(c=>c.trim().length)).map(cols=>{
    const o={}; cols.forEach((v,idx)=>o[header[idx]||`COL${idx}`]=v.trim()); return o;
  });
}
function addCacheBust(url){ return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(); }
async function loadCSV(url){
  const res = await fetch(addCacheBust(url), { cache:'no-store', mode:'cors' });
  if(!res.ok) throw new Error('Fetch failed '+url+' '+res.status);
  return parseCSV(await res.text());
}
function buildInventoryMap(items){
  const m=new Map();
  for(const r of items){ const loc=(r.LOCATION||'').trim(); if(loc) m.set(loc, r); }
  return m;
}
function getSkuKey(row){
  const keys = Object.keys(row||{});
  for(const k of keys){ if (SKU_FIELDS.includes(k.toUpperCase())) return k; }
  return keys.find(k=>/sku|item.?no|code/i.test(k)) || null;
}
function buildSkuIndex(invenRows){
  skuIndex.clear();
  for(const r of invenRows){
    const loc=(r.LOCATION||'').trim(); if(!loc) continue;
    const k=getSkuKey(r); if(!k) continue;
    const sku=String(r[k]||'').trim().toLowerCase(); if(!sku) continue;
    if(!skuIndex.has(sku)) skuIndex.set(sku,[]);
    skuIndex.get(sku).push(loc);
  }
}
function hashRows(rows){
  const s = JSON.stringify(rows.map(r=>Object.entries(r).sort()));
  let h=0; for(let i=0;i<s.length;i++){ h=(h*31 + s.charCodeAt(i))|0; }
  return String(h);
}

// ---------- Three helpers ----------
function createBox(w,d,h,color){
  const geom=new THREE.BoxGeometry(w,h,d);
  const mat=new THREE.MeshStandardMaterial({ color: color||0x6FA8DC, metalness:0.1, roughness:0.7 });
  const m=new THREE.Mesh(geom,mat); m.castShadow=true; m.receiveShadow=true; return m;
}
function addRoom(scene,b){
  const {xmin,xmax,ymin,ymax,zmin,zmax}=b;
  const C=[[xmin,ymin,zmin],[xmax,ymin,zmin],[xmax,ymax,zmin],[xmin,ymax,zmin],[xmin,ymin,zmax],[xmax,ymin,zmax],[xmax,ymax,zmax],[xmin,ymax,zmax]];
  const E=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const verts=[]; E.forEach(([a,b])=>verts.push(...C[a],...C[b]));
  const g=new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts),3));
  scene.add(new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:0x2a466f})));
}
function initScene(){
  const el=$('scene'); state.tooltip=$('tooltip');
  const w=el.clientWidth, h=el.clientHeight;
  const scene=new THREE.Scene(); scene.background=new THREE.Color(0x0b0f14);
  const camera=new THREE.PerspectiveCamera(50,w/h,0.1,1000); camera.position.set(12,10,16);
  const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setSize(w,h); renderer.shadowMap.enabled=true;
  el.innerHTML=''; el.appendChild(renderer.domElement);
  const controls=new OrbitControls(camera,renderer.domElement); controls.target.set(5,1.2,6); controls.update();
  const hemi=new THREE.HemisphereLight(0xbccfe8,0x0e1521,0.7); scene.add(hemi);
  const dir=new THREE.DirectionalLight(0xffffff,0.8); dir.position.set(8,10,6); dir.castShadow=true; scene.add(dir);
  state.scene=scene; state.camera=camera; state.renderer=renderer; state.controls=controls;

  window.addEventListener('resize',()=>{ const w2=el.clientWidth,h2=el.clientHeight; renderer.setSize(w2,h2); camera.aspect=w2/h2; camera.updateProjectionMatrix(); });
  renderer.domElement.addEventListener('mousemove',onMouseMove);
  renderer.domElement.addEventListener('click', onClick);
  animate();
}
function onMouseMove(ev){
  const r=state.renderer.domElement.getBoundingClientRect();
  state.mouse.x=((ev.clientX-r.left)/r.width)*2-1; state.mouse.y=-((ev.clientY-r.top)/r.height)*2+1;
  state.raycaster.setFromCamera(state.mouse,state.camera);
  const hits=state.raycaster.intersectObjects(state.objects,false);
  if(hits.length){ const o=hits[0].object, d=o.userData||{}; showTip(ev.clientX,ev.clientY,d.tip||d.LOCATION||'Slot'); } else hideTip();
}
function onClick(ev){
  const r=state.renderer.domElement.getBoundingClientRect();
  state.mouse.x=((ev.clientX-r.left)/r.width)*2-1; state.mouse.y=-((ev.clientY-r.top)/r.height)*2+1;
  state.raycaster.setFromCamera(state.mouse,state.camera);
  const hits=state.raycaster.intersectObjects(state.objects,false);
  if(!hits.length) return;
  const loc = (hits[0].object.userData.LOCATION || '').trim();
  openDetails(loc);
}
function showTip(x,y,html){ const t=state.tooltip; t.innerHTML=html; t.style.left=(x+12)+'px'; t.style.top=(y+12)+'px'; t.hidden=false; }
function hideTip(){ state.tooltip.hidden=true; }

function clearSceneMeshes(){
  for(const m of state.objects){
    m.geometry.dispose?.(); m.material.dispose?.();
    state.scene.remove(m);
  }
  state.objects.length=0;
}
function renderLayout(){
  clearSceneMeshes();

  const xs=state.layout.map(r=>parseFloat(r.X)).filter(n=>!isNaN(n));
  const ys=state.layout.map(r=>parseFloat(r.Y)).filter(n=>!isNaN(n));
  const ws=state.layout.map(r=>parseFloat(r.WIDTH)).filter(n=>!isNaN(n));
  const ds=state.layout.map(r=>parseFloat(r.DEPTH)).filter(n=>!isNaN(n));
  const zs=state.layout.map(r=>parseFloat(r.Z)).filter(n=>!isNaN(n));
  const hs=state.layout.map(r=>parseFloat(r.HEIGHT)).filter(n=>!isNaN(n));
  const xmin=Math.min(...xs,0), xmax=Math.max(...xs.map((x,i)=>x+(ws[i]||0)),10);
  const ymin=Math.min(...ys,0), ymax=Math.max(...ys.map((y,i)=>y+(ds[i]||0)),12);
  const zmin=0, zmax=Math.max(...zs.map((z,i)=>z+(hs[i]||0)),3);
  addRoom(state.scene,{xmin,xmax,ymin,ymax,zmin,zmax});

  const color=0x6FA8DC;
  for(const row of state.layout){
    const loc=row.LOCATION||'';
    const w=parseFloat(row.WIDTH)||0.5, d=parseFloat(row.DEPTH)||0.5, h=parseFloat(row.HEIGHT)||0.4;
    const x=parseFloat(row.X)||0, y=parseFloat(row.Y)||0, z=parseFloat(row.Z)||0;
    const m=createBox(w,d,h,color);
    m.position.set(x+w/2, z+h/2, y+d/2);
    m.userData.LOCATION=loc;

    const inv=state.inventory.get(loc);
    m.userData.tip = inv
      ? `<b>${loc}</b><br>${Object.entries(inv).map(([k,v])=>`${k}: ${v}`).join('<br>')}`
      : `<b>${loc}</b><br>(no inventory row)`;

    state.scene.add(m); state.objects.push(m);
  }

  // Re-apply highlight if a query is active
  const q=($('searchBox')?.value||'').trim().toLowerCase();
  if(q) runSearch(q);
}
function animate(){ requestAnimationFrame(animate); state.renderer.render(state.scene,state.camera); }

// ---------- Search / Highlight ----------
function clearHighlights(){
  for(const m of state.objects){
    if(originalMats.has(m)){ m.material.dispose?.(); m.material=originalMats.get(m); }
    m.scale.set(1,1,1);
  }
  state.controls?.update();
}
function highlightLocations(locs){
  clearHighlights();
  if(!locs||!locs.length){ setStatus('No matches'); return; }
  const targets=[];
  for(const m of state.objects){
    const loc=(m.userData.LOCATION||'').trim();
    if(locs.includes(loc)){
      if(!originalMats.has(m)) originalMats.set(m,m.material);
      m.material=new THREE.MeshStandardMaterial({ color:0xffd166, metalness:0.1, roughness:0.6, emissive:0x332200, emissiveIntensity:0.25 });
      m.scale.set(1.05,1.05,1.05);
      targets.push(m);
    }
  }
  if(targets.length){
    const p=targets[0].position.clone();
    state.controls.target.copy(p);
    state.camera.position.copy(p.clone().add(new THREE.Vector3(2,1.2,2).multiplyScalar(3)));
    state.camera.updateProjectionMatrix(); state.controls.update();
    setStatus(`Found ${targets.length} match${targets.length>1?'es':''}`);
  } else setStatus('No matches');
}
function runSearch(q){
  let locs = skuIndex.get(q) || [];
  if(locs.length===0){ for(const [sku,arr] of skuIndex.entries()){ if(sku.includes(q)) locs=locs.concat(arr); } }
  const locs2 = state.layout.map(r=>r.LOCATION).filter(Boolean).filter(loc=>loc.toLowerCase().includes(q));
  highlightLocations([...new Set(locs.concat(locs2))]);
}
function wireSearch(){
  const box=$('searchBox'); const btn=$('searchBtn'); const rst=$('resetBtn');
  const doSearch=()=>{ const q=(box?.value||'').trim().toLowerCase(); if(!q){ clearHighlights(); setStatus(''); return; } runSearch(q); };
  btn?.addEventListener('click',doSearch);
  box?.addEventListener('keydown',e=>{ if(e.key==='Enter') doSearch(); });
  rst?.addEventListener('click',()=>{ box.value=''; clearHighlights(); setStatus(''); });
}

// ---------- Details panel (read-only) ----------
function openDetails(location){
  const inv = state.inventory.get(location) || {};
  const skuKey = getSkuKey(inv) || 'SKU';
  const qtyKey = 'QUANTITY';
  $('d_location').value = location;
  $('d_sku').value      = String(inv[skuKey] || '');
  $('d_qty').value      = String(inv[qtyKey] || 0);
  $('details').style.display = 'block';
}
function closeDetails(){ $('details').style.display = 'none'; }

// ---------- Polling (auto refresh) ----------
async function refreshIfChanged(){
  try{
    const [layoutRows, invenRows] = await Promise.all([loadCSV(LAYOUT_URL), loadCSV(INVENTORY_URL)]);
    const hL = hashRows(layoutRows), hI = hashRows(invenRows);
    if (hL!==lastHash.layout || hI!==lastHash.inventory){
      const camPos = state.camera?.position.clone();
      const target = state.controls?.target.clone();

      state.layout = layoutRows;
      state.inventory = buildInventoryMap(invenRows);
      buildSkuIndex(invenRows);
      renderLayout();

      if(camPos && target){ state.camera.position.copy(camPos); state.controls.target.copy(target); state.controls.update(); }
      lastHash = { layout:hL, inventory:hI };
      setStatus('Updated'); setTimeout(()=>setStatus(''), 1000);
    }
  }catch(e){
    console.warn('Auto-refresh error:', e);
    setStatus('Error');
  }
}
function startAutoRefresh(){
  if(state.polling) clearInterval(state.polling);
  const tick = ()=>{ if(document.visibilityState==='visible') refreshIfChanged(); };
  state.polling = setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') tick(); });
}

// ---------- Boot ----------
function wireDetailsButtons(){
  $('closeDetails')?.addEventListener('click', closeDetails);
}
async function start(){
  try{
    setStatus('Loading…');
    const [layoutRows, invenRows] = await Promise.all([loadCSV(LAYOUT_URL), loadCSV(INVENTORY_URL)]);
    state.layout=layoutRows; state.inventory=buildInventoryMap(invenRows); buildSkuIndex(invenRows);
    lastHash = { layout: hashRows(layoutRows), inventory: hashRows(invenRows) };

    setStatus('Rendering…'); initScene(); renderLayout(); wireSearch(); wireDetailsButtons();
    setStatus('Done'); // if (POLL_MS) startAutoRefresh();
  }catch(e){
    console.error(e); setStatus('Error: '+e.message); alert('Error: '+e.message);
  }
}
start();

console.log('*** READ-ONLY BUILD (search + details + autosync) ***');
