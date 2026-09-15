const $ = id => document.getElementById(id);
const fmt = n => new Intl.NumberFormat('en-GB').format(n);
let dataset, filtered;
const state = Object.fromEntries(new URLSearchParams(location.search));

async function load() {
  try { const response = await fetch('data/data.json'); if (!response.ok) throw Error('Data artifact unavailable'); dataset = await response.json(); }
  catch (error) { showStatus('The dashboard data artifact is unavailable. Run the build-time backfill before deploying.', true); return; }
  const age = Date.now() - new Date(dataset.metadata.generated_at).getTime();
  if (age > 36 * 60 * 60 * 1000) {
    showStatus('We\'re just updating the London Data Store information…');
    const refreshed = await requestWorker(dataset.metadata.generated_at);
    if (refreshed) dataset = refreshed;
    else showStatus(`Using data last updated ${relativeAge(dataset.metadata.generated_at)} — the London Data Store could not currently be refreshed.`);
  } else if (dataset.metadata.demo) showStatus('Demo artifact loaded. Run `npm run build:data` with PLD access to publish live data.');
  $('updated').textContent = `Last successful refresh: ${new Date(dataset.metadata.generated_at).toLocaleDateString('en-GB')}`;
  setupFilters(); render();
}
async function requestWorker(previousTimestamp) {
  try {
    const first = await fetch('/api/data', { cache: 'no-store' });
    if (!first.ok) return null;
    let latest = await first.json();
    if (latest.metadata?.generated_at && latest.metadata.generated_at !== previousTimestamp && !latest.metadata.refresh_in_progress) return latest;
    for (let i=0; i<10; i++) { await new Promise(resolve=>setTimeout(resolve, 1500)); const response=await fetch('/api/data',{cache:'no-store'}); if (!response.ok) return null; latest=await response.json(); if (latest.metadata?.generated_at !== previousTimestamp && !latest.metadata?.refresh_in_progress) return latest; }
  } catch (_) { return null; }
  return null;
}
function relativeAge(timestamp) { const hours=Math.max(1,Math.floor((Date.now()-new Date(timestamp).getTime())/3600000)); return hours<48?`${hours} hours ago`:`${Math.floor(hours/24)} days ago`; }
function showStatus(message, error=false) { const el=$('status'); el.hidden=false; el.textContent=message; el.classList.toggle('error',error); }
function setupFilters() {
  const years=dataset.annual_summary.map(x=>x.year); const authorities=[...new Set((dataset.records||[]).map(x=>x.authority))].sort();
  authorities.forEach(x=>$('authority').append(new Option(x,x))); years.forEach(x=>{ $('fromYear').append(new Option(x,x)); $('toYear').append(new Option(x,x)); });
  [...new Set(dataset.annual_summary.flatMap(x=>Object.keys(x.affordability||{})))].forEach(x=>$('affordability').append(new Option(x,x)));
  $('fromYear').value=state.from||years[0]; $('toYear').value=state.to||years.at(-1); $('authority').value=state.authority||'all'; $('affordability').value=state.affordability||'all';
  ['authority','fromYear','toYear','affordability'].forEach(id=>$(id).addEventListener('change',()=>{syncUrl();render();})); $('clear').onclick=()=>{history.replaceState({},'',location.pathname); location.reload()}; $('search').addEventListener('input',renderTable); $('download').onclick=download;
}
function summaryRows() { const a=$('authority').value, from=$('fromYear').value, to=$('toYear').value; return dataset.annual_summary.filter(x=>(a==='all'||x.authority===a||a==='all') && x.year>=from&&x.year<=to); }
function render() { filtered=summaryRows(); const total=filtered.reduce((n,x)=>n+x.completions,0), target=filtered.reduce((n,x)=>n+x.target,0); $('total').textContent=fmt(total); $('target').textContent=fmt(target); $('percent').textContent=target?`${Math.round(total/target*100)}%`:'—'; $('years').textContent=filtered.length; $('period').textContent=filtered.length?`${filtered[0].year}–${filtered.at(-1).year}`:'No years selected'; renderChart(); renderBars('affordability-chart','affordability'); renderBars('dwelling-chart','dwelling_type'); renderTable(); }
function renderChart(){const el=$('completion-chart');el.innerHTML='';const max=Math.max(...filtered.flatMap(x=>[x.completions,x.target]),1);filtered.forEach(row=>{const col=document.createElement('div');col.className='chart-column';[['completion',row.completions],['target',row.target]].forEach(([kind,value])=>{const b=document.createElement('div');b.className=`bar ${kind}`;b.style.height=`${value/max*100}%`;b.title=`${kind}: ${fmt(value)}`;col.append(b)});const l=document.createElement('span');l.className='chart-label';l.textContent=row.year.replace('20','');col.append(l);el.append(col)});}
function renderBars(id,key){const totals={};filtered.forEach(row=>Object.entries(row[key]||{}).forEach(([name,value])=>totals[name]=(totals[name]||0)+value));const max=Math.max(...Object.values(totals),1);$(id).innerHTML=Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([name,value])=>`<div class="bar-row"><span>${name}</span><span class="bar-track"><span class="bar-fill" style="width:${value/max*100}%"></span></span><strong>${fmt(value)}</strong></div>`).join('')||'<p class="muted">No data for these filters.</p>';}
function renderTable(){const query=$('search').value.toLowerCase();const authority=$('authority').value;const from=$('fromYear').value,to=$('toYear').value;const aff=$('affordability').value;const rows=(dataset.records||[]).filter(x=>(!query||`${x.address} ${x.authority}`.toLowerCase().includes(query))&&(authority==='all'||x.authority===authority)&&x.year>=from&&x.year<=to&&(aff==='all'||x.affordability===aff));$('records').innerHTML=rows.map(x=>`<tr><td>${esc(x.address)}</td><td>${esc(x.authority)}</td><td>${x.year}</td><td>${fmt(x.units)}</td><td>${fmt(x.units_lp2021)}</td><td>${esc(x.affordability)}</td></tr>`).join('')||'<tr><td colspan="6">No records match these filters.</td></tr>';$('record-count').textContent=`Showing ${rows.length} record${rows.length===1?'':'s'}`;}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function syncUrl(){const p=new URLSearchParams();[['authority','all'],['fromYear',$('fromYear').options[0].value],['toYear',$('toYear').options.at(-1).value],['affordability','all']].forEach(([id,defaultValue])=>{if($(id).value!==defaultValue)p.set(id==='fromYear'?'from':id==='toYear'?'to':id,$(id).value)});history.replaceState({},'',`${location.pathname}${p.size?'?'+p:''}`);}
function download(){const rows=[...$('records').querySelectorAll('tr')].filter(x=>x.children.length===6);const csv=[['Address','Authority','Financial year','Units','Units LP2021','Affordability'],...rows.map(r=>[...r.children].map(c=>`"${c.textContent.replaceAll('"','""')}"`))].map(x=>x.join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='london-residential-completions.csv';a.click();URL.revokeObjectURL(a.href);}
load();
