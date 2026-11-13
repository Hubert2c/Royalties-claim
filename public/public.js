// =============================================================================
// public/public.js — public transparency dashboard (no login)
// =============================================================================

const { esc, money, percent, dateTime, label, pill, table, toast } = UI;

async function loadDashboard() {
  const { summary: s, runs, collectionsByCategory, monthly } = await UI.api('/api/public/summary');

  UIWidgets.flowBar('#pFlow', { collected: s.collected, adminFees: s.adminFees, paid: s.distributedPaid, held: s.held });
  UIWidgets.barChart('#pMonthly', {
    labels: monthly.months,
    series: [{ name: 'Collected', values: monthly.collections, tone: 'primary' }, { name: 'Paid to creators', values: monthly.payouts, tone: 'paid' }]
  });

  const max = Math.max(1, ...collectionsByCategory.map((c) => Number(c.amount)));
  document.querySelector('#pByCategory').innerHTML = collectionsByCategory.length
    ? collectionsByCategory.map((c) => `
        <div class="bar-row"><span>${label(c.category)}</span>
          <div class="bar"><div class="bar-fill" style="width:${(Number(c.amount) / max) * 100}%"></div></div>
          <strong>${money(c.amount)}</strong></div>`).join('')
    : '<p class="empty-state">No collections yet.</p>';

  document.querySelector('#pRegistry').innerHTML = [
    ['Registered works', s.registeredWorks], ['Rights holders', s.rightsHolders],
    ['Music users', s.licensees], ['Paid licences', s.paidLicences], ['Unclaimed plays', s.unmatchedUsage]
  ].map(([name, value]) => `<article class="mini-stat"><span>${esc(name)}</span><strong>${esc(value)}</strong></article>`).join('');

  table('#pRuns', [
    { title: 'Period', render: (r) => esc(r.period) },
    { title: 'Collected (pool)', render: (r) => money(r.total_pool) },
    { title: 'Admin fee', render: (r) => `${money(r.admin_fee)} <small>(${percent(r.admin_fee_rate, 1)})</small>` },
    { title: 'For creators', render: (r) => money(r.distributable) },
    { title: 'Held', render: (r) => money(r.held_amount) },
    { title: 'Plays counted', render: (r) => esc(r.usage_count) },
    { title: 'Status', render: (r) => pill(r.status) }
  ], runs, 'No approved distribution runs yet.');

  const { usage } = await UI.api('/api/public/unclaimed');
  table('#pUnclaimed', [
    { title: 'Reported title', render: (u) => `<strong>${esc(u.raw_title || '—')}</strong><br /><small>${esc(u.raw_artist || '')}</small>` },
    { title: 'Where', render: (u) => `${esc(u.licensee_name || '—')}<br /><small>${label(u.category)}</small>` },
    { title: 'When', render: (u) => dateTime(u.played_at) }
  ], usage, 'No unclaimed plays right now.');
}

document.querySelector('#clearanceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = UI.formData(event.target).code.trim();
  try {
    const result = await UI.api(`/api/public/clearance/${encodeURIComponent(code)}`);
    const l = result.licence;
    document.querySelector('#clearanceResult').innerHTML = `
      <div class="notice ${result.valid ? 'notice-good' : 'notice-bad'}">
        <strong>${result.valid ? 'VALID' : 'NOT VALID'}</strong> — ${esc(result.message)}
        ${l ? `<br />${esc(l.licensee_name)} (${label(l.category)}) · ${esc(l.tariff_name)} · ${esc(l.period_start)} to ${esc(l.period_end)}${l.description ? ` · ${esc(l.description)}` : ''}` : ''}
      </div>`;
  } catch (error) { toast(error.message, true); }
});

loadDashboard().catch((error) => toast(error.message, true));
