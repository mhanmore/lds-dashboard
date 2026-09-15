const $ = id => document.getElementById(id);
const fmt = number => new Intl.NumberFormat('en-GB').format(Math.round(number));
const state = Object.fromEntries(new URLSearchParams(location.search));
const colours = ['#007f5f', '#f0a202', '#dc2f72', '#5271ff', '#6f4e9c', '#00a6a6', '#8a9a5b', '#6b7280'];
const dimensionLabels = { affordability: 'Affordability', dwelling_type: 'Unit type', use_class: 'Inferred use class' };
let dataset;
let filtered = [];
let tableRows = [];
const yearRecords = new Map();
let tableRequest = 0;
let defaultFromYear;
let dimension = state.view && dimensionLabels[state.view] ? state.view : 'affordability';

document.querySelector('.publication-note-close')?.addEventListener('click', event => {
  event.currentTarget.closest('.publication-note').hidden = true;
});

async function load() {
  try {
    const response = await fetch('data/index.json');
    if (!response.ok) throw Error('Data artifact unavailable');
    dataset = await response.json();
  } catch (_) {
    showStatus('The local dashboard data is unavailable. Run the data build before publishing.', true);
    return;
  }
  const age = Date.now() - new Date(dataset.metadata.generated_at).getTime();
  if (age > 10 * 24 * 60 * 60 * 1000) showStatus(`The published snapshot is ${relativeAge(dataset.metadata.generated_at)}. The weekly update may need attention.`);
  $('updated').textContent = `Snapshot ${new Date(dataset.metadata.generated_at).toLocaleDateString('en-GB')}`;
  setupFilters();
  setDimension(dimension);
}

function setupFilters() {
  const allLondon = dataset.annual_summary.filter(row => row.authority === 'All London');
  const years = [...new Set(allLondon.map(row => row.year))];
  defaultFromYear = years[Math.max(0, years.length - 7)];
  const authorities = [...new Set(dataset.annual_summary.map(row => row.authority).filter(name => name !== 'All London'))].sort();
  fillSelect('authority', authorities);
  years.forEach(year => { $('fromYear').append(new Option(year, year)); $('toYear').append(new Option(year, year)); });
  fillSelect('affordability', categories(allLondon, 'affordability'));
  fillSelect('dwellingType', categories(allLondon, 'dwelling_type'));
  fillSelect('useClass', categories(allLondon, 'use_class'));
  $('fromYear').value = state.from || defaultFromYear;
  $('toYear').value = state.to || years.at(-1);
  $('authority').value = state.authority || 'all';
  $('affordability').value = state.affordability || 'all';
  $('dwellingType').value = state.type || 'all';
  $('useClass').value = state.use || 'all';
  ['authority', 'fromYear', 'toYear', 'affordability', 'dwellingType', 'useClass'].forEach(id => $(id).addEventListener('change', () => { syncUrl(); render(); }));
  document.querySelectorAll('[data-dimension]').forEach(button => button.addEventListener('click', () => setDimension(button.dataset.dimension)));
  $('clear').onclick = resetFilters;
  $('records-panel').addEventListener('toggle', () => { if ($('records-panel').open) void renderTable(); });
  $('search').addEventListener('input', () => void renderTable());
  $('download').onclick = download;
}

function fillSelect(id, values) { values.forEach(value => $(id).append(new Option(value, value))); }
function categories(rows, key) { return [...new Set(rows.flatMap(row => Object.keys(row[key] || {})))].sort(); }

function currentFilters() {
  return {
    authority: $('authority').value === 'all' ? 'All London' : $('authority').value,
    affordability: $('affordability').value,
    dwellingType: $('dwellingType').value,
    useClass: $('useClass').value,
    from: $('fromYear').value,
    to: $('toYear').value
  };
}

function filteredSummary(authority = currentFilters().authority) {
  const filters = currentFilters();
  return dataset.annual_summary
    .filter(row => row.authority === authority && row.year >= filters.from && row.year <= filters.to)
    .map(row => filterCube(row, filters));
}

function filterCube(row, filters) {
  const result = { ...row, completions: 0, affordability: {}, dwelling_type: {}, use_class: {} };
  for (const [affordability, dwellings] of Object.entries(row.cube || {})) {
    if (filters.affordability !== 'all' && affordability !== filters.affordability) continue;
    for (const [dwellingType, useClasses] of Object.entries(dwellings)) {
      if (filters.dwellingType !== 'all' && dwellingType !== filters.dwellingType) continue;
      for (const [useClass, value] of Object.entries(useClasses)) {
        if (filters.useClass !== 'all' && useClass !== filters.useClass) continue;
        result.completions += value;
        add(result.affordability, affordability, value);
        add(result.dwelling_type, dwellingType, value);
        add(result.use_class, useClass, value);
      }
    }
  }
  const unfiltered = filters.affordability === 'all' && filters.dwellingType === 'all' && filters.useClass === 'all';
  result.target = authorityIsLondon(row.authority) && unfiltered ? row.target : null;
  return result;
}

function add(object, key, value) { object[key] = (object[key] || 0) + value; }
function authorityIsLondon(authority) { return authority === 'All London'; }

function render() {
  filtered = filteredSummary();
  renderMetrics();
  renderComposition();
  renderMix();
  renderRanking();
  renderAnnualTable();
  void renderTable();
}

function renderMetrics() {
  const total = sum(filtered.map(row => row.completions));
  const latest = filtered.at(-1);
  const affordable = sum(filtered.map(row => row.affordability.Affordable || 0));
  const target = filtered.every(row => row.target !== null) ? sum(filtered.map(row => row.target)) : null;
  $('total').textContent = fmt(total);
  $('period').textContent = filtered.length ? `${filtered[0].year}–${latest.year}` : 'No years selected';
  $('latest').textContent = latest ? fmt(latest.completions) : '—';
  $('latest-year').textContent = latest?.year || 'Financial year';
  $('affordable-share').textContent = total ? `${(affordable / total * 100).toFixed(1)}%` : '—';
  $('percent').textContent = target ? `${Math.round(total / target * 100)}%` : '—';
  $('target-note').textContent = target ? `${fmt(total)} of ${fmt(target)}` : 'Target hidden for filtered mix';
}

function renderComposition() {
  const totals = totalsFor(dimension, filtered);
  const names = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const palette = Object.fromEntries(names.map((name, index) => [name, colours[index % colours.length]]));
  const maximum = Math.max(...filtered.map(row => Math.max(0, sum(Object.values(row[dimension] || {})))), 1);
  $('composition-title').textContent = `Completions by ${dimensionLabels[dimension].toLowerCase()}`;
  $('stack-legend').innerHTML = names.map(name => `<button type="button" data-category="${esc(name)}" data-filter="${dimension}" title="Filter by ${esc(name)}"><i style="background:${palette[name]}"></i>${esc(name)} <b>${fmt(totals[name])}</b></button>`).join('');
  $('composition-chart').innerHTML = filtered.map(row => {
    const values = row[dimension] || {};
    const height = Math.max(0, sum(Object.values(values))) / maximum * 100;
    const segments = names.map(name => {
      const value = Math.max(0, values[name] || 0);
      const share = sum(Object.values(values)) > 0 ? value / sum(Object.values(values)) * 100 : 0;
      return value ? `<button class="stack-segment" type="button" data-category="${esc(name)}" data-filter="${dimension}" style="height:${share}%;background:${palette[name]}" aria-label="${esc(row.year)}, ${esc(name)}: ${fmt(value)} completions" title="${esc(row.year)} · ${esc(name)}: ${fmt(value)}"></button>` : '';
    }).join('');
    const target = row.target ? `<span class="target-tick" style="bottom:${Math.min(100, row.target / maximum * 100)}%" title="Target: ${fmt(row.target)}"></span>` : '';
    return `<div class="year-column"><div class="column-value">${fmt(row.completions)}</div><div class="stack-shell" style="height:${height}%">${segments}</div>${target}<span class="year-label">${esc(row.year.replace('20', ''))}</span></div>`;
  }).join('') || '<p class="empty">No data for these filters.</p>';
  document.querySelectorAll('#stack-legend [data-category], #composition-chart [data-category]').forEach(button => button.addEventListener('click', () => applyCategoryFilter(button.dataset.filter, button.dataset.category)));
}

function renderMix() {
  const totals = totalsFor(dimension, filtered);
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const total = sum(entries.map(([, value]) => value));
  $('mix-title').textContent = `${dimensionLabels[dimension]} mix`;
  $('mix-total').textContent = fmt(total);
  $('mix-strip').innerHTML = entries.map(([, value], index) => `<i style="width:${total ? Math.max(0, value) / total * 100 : 0}%;background:${colours[index % colours.length]}"></i>`).join('');
  $('mix-list').innerHTML = entries.map(([name, value], index) => `<button type="button" data-category="${esc(name)}"><i style="background:${colours[index % colours.length]}"></i><span>${esc(name)}</span><strong>${fmt(value)}</strong><small>${total ? (value / total * 100).toFixed(1) : '0.0'}%</small></button>`).join('');
  document.querySelectorAll('#mix-list [data-category]').forEach(button => button.addEventListener('click', () => applyCategoryFilter(dimension, button.dataset.category)));
}

function renderRanking() {
  const filters = currentFilters();
  const authorities = [...new Set(dataset.annual_summary.map(row => row.authority).filter(name => name !== 'All London'))];
  const ranked = authorities.map(authority => ({ authority, value: sum(filteredSummary(authority).map(row => row.completions)) })).sort((a, b) => b.value - a.value).map((row, index) => ({ ...row, rank: index + 1 }));
  let rows = ranked.slice(0, 10);
  if (filters.authority !== 'All London') {
    const selectedIndex = ranked.findIndex(row => row.authority === filters.authority);
    const selected = ranked[selectedIndex];
    const comparisons = [...ranked.slice(Math.max(0, selectedIndex - 5), selectedIndex), ...ranked.slice(selectedIndex + 1, selectedIndex + 6)];
    if (comparisons.length < 10) {
      const chosen = new Set(comparisons.map(row => row.authority));
      comparisons.push(...ranked.filter(row => row.authority !== selected.authority && !chosen.has(row.authority)).sort((a, b) => Math.abs(a.value - selected.value) - Math.abs(b.value - selected.value)).slice(0, 10 - comparisons.length));
    }
    rows = [...comparisons, selected].sort((a, b) => b.value - a.value);
  }
  const maximum = Math.max(...rows.map(row => row.value), 1);
  $('borough-title').textContent = filters.authority === 'All London' ? 'Leading authorities' : '10 nearest delivery totals';
  $('borough-ranking').innerHTML = rows.map(row => { const current = row.authority === filters.authority; return `<button type="button" data-authority="${esc(row.authority)}"${current ? ' class="current" aria-current="true"' : ''}><span>${row.rank}</span><strong><span>${esc(row.authority)}</span>${current ? '<small>Focus</small>' : ''}</strong><i><b style="width:${Math.max(0, row.value) / maximum * 100}%"></b></i><em>${fmt(row.value)}</em></button>`; }).join('');
  document.querySelectorAll('#borough-ranking [data-authority]').forEach(button => button.addEventListener('click', () => { $('authority').value = button.dataset.authority; syncUrl(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
}

function renderAnnualTable() {
  $('annual-caption').textContent = currentFilters().authority;
  $('annual-values').innerHTML = filtered.map(row => {
    const affordable = row.affordability.Affordable || 0;
    const market = row.affordability.Market || 0;
    return `<tr><th>${esc(row.year)}</th><td>${fmt(row.completions)}</td><td>${fmt(affordable)}</td><td>${fmt(market)}</td><td>${row.target === null ? '—' : fmt(row.target)}</td><td>${row.target ? `${Math.round(row.completions / row.target * 100)}%` : '—'}</td></tr>`;
  }).join('');
}

async function renderTable() {
  if (!$('records-panel').open) return;
  const request = ++tableRequest;
  const query = $('search').value.toLowerCase();
  const filters = currentFilters();
  $('record-count').textContent = 'Loading local year files…';
  $('download').disabled = true;
  try { await loadYearRecords(filters.from, filters.to); }
  catch (_) { if (request === tableRequest) $('record-count').textContent = 'The selected local year files could not be loaded.'; return; }
  if (request !== tableRequest) return;
  const records = [...yearRecords.entries()].filter(([year]) => year >= filters.from && year <= filters.to).flatMap(([, rows]) => rows);
  tableRows = records.filter(row => (!query || `${row.address} ${row.authority}`.toLowerCase().includes(query)) && (filters.authority === 'All London' || row.authority === filters.authority) && (filters.affordability === 'all' || row.affordability === filters.affordability) && (filters.dwellingType === 'all' || row.dwelling_type === filters.dwellingType) && (filters.useClass === 'all' || row.use_class === filters.useClass));
  $('records').innerHTML = tableRows.slice(0, 500).map(row => `<tr><td>${esc(row.address)}</td><td>${esc(row.authority)}</td><td>${esc(row.year)}</td><td>${fmt(row.units)}</td><td>${esc(row.affordability)}</td><td>${esc(row.dwelling_type)}</td><td>${esc(row.use_class)}</td></tr>`).join('') || '<tr><td colspan="7">No sites match these filters.</td></tr>';
  $('record-count').textContent = tableRows.length > 500 ? `Showing the first 500 of ${fmt(tableRows.length)} address-grouped records. CSV includes all filtered rows.` : `${fmt(tableRows.length)} address-grouped record${tableRows.length === 1 ? '' : 's'}`;
  $('download').disabled = false;
}

async function loadYearRecords(from, to) {
  const needed = dataset.years.filter(entry => entry.year >= from && entry.year <= to && !yearRecords.has(entry.year));
  await Promise.all(needed.map(async entry => {
    const response = await fetch(`data/${entry.file}`);
    if (!response.ok) throw Error(`Unable to load ${entry.year}`);
    const shard = await response.json();
    yearRecords.set(entry.year, shard.records || []);
  }));
}

function totalsFor(key, rows) { const totals = {}; rows.forEach(row => Object.entries(row[key] || {}).forEach(([name, value]) => add(totals, name, value))); return totals; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function setDimension(next) { dimension = next; document.querySelectorAll('[data-dimension]').forEach(button => button.classList.toggle('active', button.dataset.dimension === dimension)); syncUrl(); render(); }
function applyCategoryFilter(key, value) { const id = key === 'affordability' ? 'affordability' : key === 'dwelling_type' ? 'dwellingType' : 'useClass'; $(id).value = value; syncUrl(); render(); }

function resetFilters() { ['authority', 'affordability', 'dwellingType', 'useClass'].forEach(id => $(id).value = 'all'); $('fromYear').value = defaultFromYear; $('toYear').selectedIndex = $('toYear').options.length - 1; syncUrl(); render(); }
function syncUrl() { const filters = currentFilters(), params = new URLSearchParams(); if (filters.authority !== 'All London') params.set('authority', filters.authority); if (filters.from !== defaultFromYear) params.set('from', filters.from); if ($('toYear').selectedIndex !== $('toYear').options.length - 1) params.set('to', filters.to); if (filters.affordability !== 'all') params.set('affordability', filters.affordability); if (filters.dwellingType !== 'all') params.set('type', filters.dwellingType); if (filters.useClass !== 'all') params.set('use', filters.useClass); if (dimension !== 'affordability') params.set('view', dimension); history.replaceState({}, '', `${location.pathname}${params.size ? `?${params}` : ''}`); }

function showStatus(message, error = false) { const element = $('status'); element.hidden = false; element.textContent = message; element.classList.toggle('error', error); }
function relativeAge(timestamp) { const days = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 86400000)); return days < 1 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

function download() { const rows = tableRows.map(row => [row.address, row.authority, row.year, row.units, row.affordability, row.dwelling_type, row.use_class]); const csv = [['Address', 'Authority', 'Financial year', 'Net units', 'Affordability', 'Unit type', 'Use class'], ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'london-residential-completions.csv'; link.click(); URL.revokeObjectURL(link.href); }

load();
