const $ = id => document.getElementById(id);
const fmt = value => new Intl.NumberFormat('en-GB').format(Math.round(value));
const AUTHORITY = document.body.dataset.authority;
const TARGET = 35;

document.querySelector('.publication-note-close')?.addEventListener('click', event => {
  event.currentTarget.closest('.publication-note').hidden = true;
});

async function load() {
  try {
    const response = await fetch('../data/index.json');
    if (!response.ok) throw Error('Data unavailable');
    const dataset = await response.json();
    $('updated').textContent = `Snapshot ${new Date(dataset.metadata.generated_at).toLocaleDateString('en-GB')}`;
    const rows = dataset.annual_summary
      .filter(row => row.authority === AUTHORITY)
      .sort((a, b) => a.year.localeCompare(b.year));
    if (!rows.length) throw Error(`No data found for ${AUTHORITY}`);

    const detailResponse = await fetch('../data/borough-affordability.json');
    if (!detailResponse.ok) throw Error('Borough affordability summary unavailable');
    const detail = await detailResponse.json();
    const positiveByYear = new Map(detail.annual
      .filter(row => row.authority === AUTHORITY)
      .map(row => [row.year, row]));
    render(rows.map(row => enrich(row, positiveByYear.get(row.year))));
  } catch (error) {
    $('updated').textContent = 'Data unavailable';
    $('annual-table').innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
  }
}

function enrich(row, positive = {}) {
  const positiveTotal = positive.positive_completions || 0;
  const positiveAffordable = positive.positive_affordable || 0;
  const netAffordable = row.affordability?.Affordable || 0;
  const netShare = row.completions > 0 ? netAffordable / row.completions * 100 : null;
  const positiveShare = positiveTotal > 0 ? positiveAffordable / positiveTotal * 100 : null;
  const topAffordable = positive.top_affordable_contributor || null;
  const lossDistorted = netShare === null || Math.abs(netShare - positiveShare) >= 15;
  const majorContributor = topAffordable && topAffordable.units >= 50
    && topAffordable.units / positiveAffordable >= .5;
  return {
    ...row,
    netAffordable,
    netShare,
    positiveTotal,
    positiveAffordable,
    positiveShare,
    topAffordable,
    flags: { lossDistorted, majorContributor }
  };
}

function render(rows) {
  const period = aggregate(rows);
  const latest = rows.at(-1);
  $('net-share').textContent = percent(period.netShare);
  $('positive-share').textContent = percent(period.positiveShare);
  $('total-completions').textContent = fmt(period.netTotal);
  $('period-label').textContent = `${rows[0].year}–${latest.year}`;
  $('latest-year-completions').textContent = fmt(latest.completions);
  $('latest-year-label').textContent = latest.year;
  renderAnnualChart(rows);
  renderPeriodChart(rows);
  renderOutliers(rows);
  renderTable(rows);
}

function aggregate(rows) {
  const netTotal = sum(rows.map(row => row.completions));
  const netAffordable = sum(rows.map(row => row.netAffordable));
  const positiveTotal = sum(rows.map(row => row.positiveTotal));
  const positiveAffordable = sum(rows.map(row => row.positiveAffordable));
  return {
    netTotal,
    netShare: netTotal > 0 ? netAffordable / netTotal * 100 : null,
    positiveShare: positiveTotal > 0 ? positiveAffordable / positiveTotal * 100 : null
  };
}

function renderAnnualChart(rows) {
  const labels = rows.map(row => row.year.replace('20', ''));
  const flagged = rows.map(row => row.flags.lossDistorted || row.flags.majorContributor);
  const belowTwentyBand = {
    id: 'belowTwentyBand',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.y) return;
      const threshold = scales.y.getPixelForValue(20);
      ctx.save();
      ctx.fillStyle = 'rgba(82, 113, 255, 0.10)';
      ctx.fillRect(chartArea.left, threshold, chartArea.right - chartArea.left, chartArea.bottom - threshold);
      ctx.restore();
    }
  };
  new Chart($('proportion-chart').getContext('2d'), {
    type: 'line',
    plugins: [belowTwentyBand],
    data: {
      labels,
      datasets: [
        {
          label: 'Net share (signed gains and losses)',
          data: rows.map(row => row.netShare),
          borderColor: '#007f5f',
          pointBackgroundColor: flagged.map(value => value ? '#f0a202' : '#007f5f'),
          pointBorderColor: flagged.map(value => value ? '#7a4f00' : '#ffffff'),
          pointBorderWidth: flagged.map(value => value ? 2 : 1),
          pointRadius: flagged.map(value => value ? 5 : 3),
          fill: false,
          spanGaps: false,
          tension: .2
        },
        {
          label: 'Positive completions only',
          data: rows.map(row => row.positiveShare),
          borderColor: '#5271ff',
          backgroundColor: '#5271ff',
          borderDash: [5, 4],
          pointStyle: 'rectRot',
          pointRadius: 3,
          tension: .2
        },
        {
          label: '20% comparison level',
          data: labels.map(() => 20),
          borderColor: 'rgba(82,113,255,.65)',
          borderDash: [2, 4],
          pointRadius: 0,
          borderWidth: 1
        },
        {
          label: '35% benchmark',
          data: labels.map(() => TARGET),
          borderColor: '#dc2f72',
          borderDash: [8, 5],
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            afterBody: items => {
              const row = rows[items[0]?.dataIndex];
              if (!row) return '';
              const notes = [];
              if (row.flags.lossDistorted) notes.push('Loss effect: net and positive-only shares differ by 15+ points.');
              if (row.flags.majorContributor) notes.push(`Major contributor: ${shortAddress(row.topAffordable.address)} (${fmt(row.topAffordable.units)} affordable).`);
              return notes;
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          title: { display: true, text: 'Affordable dwellings (%)' }
        }
      }
    }
  });
}

function renderPeriodChart(rows) {
  const start2014 = rows.findIndex(row => row.year === '2014/15');
  const periods = [
    { label: 'Entire series', rows },
    { label: 'Since 2014/15', rows: rows.slice(Math.max(0, start2014)) },
    { label: 'Latest 5 years', rows: rows.slice(-5) },
    { label: 'Latest 3 years', rows: rows.slice(-3) }
  ].map(period => ({ ...period, values: aggregate(period.rows) }));

  new Chart($('period-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: periods.map(period => period.label),
      datasets: [
        { label: 'Net share', data: periods.map(period => period.values.netShare), backgroundColor: '#007f5f' },
        { label: 'Positive completions only', data: periods.map(period => period.values.positiveShare), backgroundColor: '#5271ff' },
        { label: '35% benchmark', data: periods.map(() => TARGET), backgroundColor: '#f4b7ce' }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      scales: { x: { min: 0, max: 40, title: { display: true, text: 'Affordable dwellings (%)' } } }
    }
  });
}

function renderOutliers(rows) {
  const exceptions = rows.filter(row => row.flags.lossDistorted || row.flags.majorContributor);
  $('outlier-notes').innerHTML = exceptions.map(row => {
    const notes = [];
    if (row.flags.lossDistorted) {
      notes.push(`<span class="flag loss">Loss effect</span> net ${percent(row.netShare)} versus ${percent(row.positiveShare)} among positive completions`);
    }
    if (row.flags.majorContributor) {
      notes.push(`<span class="flag scheme">Major scheme</span> ${escapeHtml(shortAddress(row.topAffordable.address))} supplied ${fmt(row.topAffordable.units)} affordable dwellings`);
    }
    return `<article class="outlier-card"><strong>${escapeHtml(row.year)}</strong><div>${notes.join('<br>')}</div></article>`;
  }).join('');
}

function renderTable(rows) {
  $('annual-table').innerHTML = rows.map(row => {
    const context = [];
    if (row.flags.lossDistorted) context.push('<span class="flag loss">Loss effect</span>');
    if (row.flags.majorContributor) context.push('<span class="flag scheme">Major scheme</span>');
    return `<tr>
      <td>${escapeHtml(row.year)}</td>
      <td>${fmt(row.completions)}</td>
      <td>${fmt(row.netAffordable)}</td>
      <td>${percent(row.netShare)}</td>
      <td>${fmt(row.positiveTotal)}</td>
      <td>${percent(row.positiveShare)}</td>
      <td>${context.join(' ') || '—'}</td>
    </tr>`;
  }).join('');
}

function sum(values) { return values.reduce((total, value) => total + value, 0); }
function percent(value) { return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`; }
function shortAddress(address) { return String(address || '').split(',').slice(0, 2).join(',').trim(); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

load();
