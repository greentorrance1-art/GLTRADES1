// ─── Global State ────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentUser = null;
let userRole = null;
let editingTradeId = null;

window.trades = [];
window.playbooks = [];
window.journalEntries = [];

// ─── App Entry Point ──────────────────────────────────────────────────────────
window.initializeApp = async function () {
  currentUser = authManager.getUserId();
  userRole = authManager.userRole;

  await loadAllData();
  setupNavigation();
  setupTradeModal();
  setupPlaybookModal();
  setupJournalModal();
  setupSettingsButtons();
  setupRoleBasedUI();
  updateDashboard();
  showPage('dashboard');
};

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function loadAllData() {
  if (!currentUser) return;
  try {
    const [tradesSnap, playbooksSnap, journalSnap] = await Promise.all([
      db.collection('users').doc(currentUser).collection('trades').orderBy('date', 'desc').get(),
      db.collection('users').doc(currentUser).collection('playbooks').get(),
      db.collection('users').doc(currentUser).collection('journal').orderBy('date', 'desc').get()
    ]);
    window.trades = tradesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.playbooks = playbooksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.journalEntries = journalSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('Error loading data:', err);
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item:not(.logout-item)').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      showPage(item.dataset.page);
    });
  });
}

function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(i =>
    i.classList.toggle('active', i.dataset.page === page)
  );
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`${page}-page`);
  if (target) target.classList.add('active');

  if (page === 'dashboard') updateDashboard();
  if (page === 'trades') displayTrades();
  if (page === 'reports') updateReport();
  if (page === 'playbooks') displayPlaybooks();
  if (page === 'journal') displayJournal();
  if (page === 'university') displayGLUniversity();
}

// ─── Trade Modal ──────────────────────────────────────────────────────────────
function openTradeModal(tradeId) {
  editingTradeId = tradeId || null;
  const modal = document.getElementById('trade-modal');
  const titleEl = document.getElementById('modal-title');

  if (editingTradeId) {
    titleEl.textContent = 'Edit Trade';
    const t = window.trades.find(t => t.id === editingTradeId);
    if (t) {
      document.getElementById('trade-date').value = t.date || '';
      document.getElementById('trade-symbol').value = t.symbol || '';
      document.getElementById('trade-side').value = t.side || 'long';
      document.getElementById('trade-quantity').value = t.quantity || '';
      document.getElementById('trade-entry').value = t.entryPrice || '';
      document.getElementById('trade-exit').value = t.exitPrice || '';
      document.getElementById('trade-stop').value = t.stopLoss || '';
      document.getElementById('trade-strategy').value = t.strategy || '';
      document.getElementById('trade-tags').value = (t.tags || []).join(', ');
      document.getElementById('trade-notes').value = t.notes || '';
    }
  } else {
    titleEl.textContent = 'Add Trade';
    document.getElementById('trade-form').reset();
    document.getElementById('trade-date').value = new Date().toISOString().split('T')[0];
  }

  modal.classList.add('active');
}

function closeTradeModal() {
  document.getElementById('trade-modal').classList.remove('active');
  document.getElementById('trade-form').reset();
  editingTradeId = null;
}

function setupTradeModal() {
  // Open buttons
  document.getElementById('add-trade-btn').addEventListener('click', () => openTradeModal());
  document.getElementById('add-trade-btn-2').addEventListener('click', () => openTradeModal());

  // Close buttons
  document.getElementById('close-modal').addEventListener('click', closeTradeModal);
  document.getElementById('cancel-trade-btn').addEventListener('click', closeTradeModal);

  // Close on backdrop click
  document.getElementById('trade-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('trade-modal')) closeTradeModal();
  });

  // Form submit
  document.getElementById('trade-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveTrade();
  });
}

async function saveTrade() {
  const submitBtn = document.querySelector('#trade-form button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  try {
    const entryPrice = parseFloat(document.getElementById('trade-entry').value);
    const exitPrice = parseFloat(document.getElementById('trade-exit').value);
    const quantity = parseFloat(document.getElementById('trade-quantity').value);
    const side = document.getElementById('trade-side').value;
    const stopLoss = parseFloat(document.getElementById('trade-stop').value) || null;
    const tagsRaw = document.getElementById('trade-tags').value;

    // P/L calculation
    let pl = 0;
    if (side === 'long') {
      pl = (exitPrice - entryPrice) * quantity;
    } else {
      pl = (entryPrice - exitPrice) * quantity;
    }

    // R-multiple
    let rMultiple = null;
    if (stopLoss) {
      const risk = Math.abs(entryPrice - stopLoss) * quantity;
      rMultiple = risk > 0 ? parseFloat((pl / risk).toFixed(2)) : null;
    }

    // Outcome
    let outcome = 'breakeven';
    if (pl > 0) outcome = 'win';
    else if (pl < 0) outcome = 'loss';

    const tradeData = {
      date: document.getElementById('trade-date').value,
      symbol: document.getElementById('trade-symbol').value.toUpperCase().trim(),
      side,
      quantity,
      entryPrice,
      exitPrice,
      stopLoss,
      pl: parseFloat(pl.toFixed(2)),
      rMultiple,
      outcome,
      strategy: document.getElementById('trade-strategy').value.trim(),
      tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
      notes: document.getElementById('trade-notes').value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const userTradesRef = db.collection('users').doc(currentUser).collection('trades');

    if (editingTradeId) {
      await userTradesRef.doc(editingTradeId).update(tradeData);
      const idx = window.trades.findIndex(t => t.id === editingTradeId);
      if (idx !== -1) window.trades[idx] = { id: editingTradeId, ...tradeData };
    } else {
      tradeData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const docRef = await userTradesRef.add(tradeData);
      window.trades.unshift({ id: docRef.id, ...tradeData });
    }

    closeTradeModal();

    // Refresh current view
    if (currentPage === 'dashboard') updateDashboard();
    if (currentPage === 'trades') displayTrades();

  } catch (err) {
    console.error('Error saving trade:', err);
    alert('Error saving trade. Please try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Trade';
  }
}

async function deleteTrade(tradeId) {
  if (!confirm('Delete this trade?')) return;
  try {
    await db.collection('users').doc(currentUser).collection('trades').doc(tradeId).delete();
    window.trades = window.trades.filter(t => t.id !== tradeId);
    displayTrades();
    if (currentPage === 'dashboard') updateDashboard();
  } catch (err) {
    console.error('Error deleting trade:', err);
    alert('Error deleting trade.');
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function updateDashboard() {
  const trades = window.trades || [];

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const totalPL = trades.reduce((sum, t) => sum + (t.pl || 0), 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pl || 0), 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;
  const expectancy = trades.length
    ? (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss
    : 0;

  // Max drawdown
  let peak = 0, maxDD = 0, running = 0;
  [...trades].reverse().forEach(t => {
    running += (t.pl || 0);
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  });

  const avgWinLoss = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '0.00';

  document.getElementById('metric-net-pl').textContent = formatCurrency(totalPL);
  document.getElementById('metric-net-pl').className = `metric-value ${totalPL >= 0 ? 'trade-positive' : 'trade-negative'}`;

  document.getElementById('metric-win-rate').textContent = winRate.toFixed(1) + '%';
  document.getElementById('metric-expectancy').textContent = formatCurrency(expectancy);
  document.getElementById('metric-profit-factor').textContent = profitFactor.toFixed(2);
  document.getElementById('metric-max-drawdown').textContent = formatCurrency(maxDD);
  document.getElementById('metric-avg-win-loss').textContent = avgWinLoss;

  renderEquityChart(trades);
  renderWinLossChart(wins.length, losses.length, trades.filter(t => t.outcome === 'breakeven').length);
  renderRecentTrades(trades.slice(0, 10));
}

function renderRecentTrades(trades) {
  const tbody = document.querySelector('#recent-trades-table tbody');
  if (!tbody) return;
  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);padding:2rem;">No trades yet. Click "+ Add Trade" to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = trades.map(t => `
    <tr>
      <td>${t.date || ''}</td>
      <td><strong>${t.symbol || ''}</strong></td>
      <td><span class="tag">${t.side || ''}</span></td>
      <td>${t.quantity || ''}</td>
      <td>${formatCurrency(t.entryPrice)}</td>
      <td>${formatCurrency(t.exitPrice)}</td>
      <td class="${t.pl >= 0 ? 'trade-positive' : 'trade-negative'}">${formatCurrency(t.pl)}</td>
      <td>${t.strategy || '—'}</td>
    </tr>
  `).join('');
}

// ─── Trades Page ──────────────────────────────────────────────────────────────
function displayTrades() {
  const search = (document.getElementById('trade-search')?.value || '').toLowerCase();
  const filter = document.getElementById('trade-filter')?.value || 'all';

  let filtered = window.trades.filter(t => {
    const matchFilter =
      filter === 'all' ||
      (filter === 'winning' && t.outcome === 'win') ||
      (filter === 'losing' && t.outcome === 'loss') ||
      (filter === 'breakeven' && t.outcome === 'breakeven');
    const matchSearch =
      !search ||
      (t.symbol || '').toLowerCase().includes(search) ||
      (t.strategy || '').toLowerCase().includes(search) ||
      (t.tags || []).some(tag => tag.toLowerCase().includes(search));
    return matchFilter && matchSearch;
  });

  const tbody = document.querySelector('#all-trades-table tbody');
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-secondary);padding:2rem;">No trades found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(t => `
    <tr>
      <td>${t.date || ''}</td>
      <td><strong>${t.symbol || ''}</strong></td>
      <td><span class="tag">${t.side || ''}</span></td>
      <td>${t.quantity || ''}</td>
      <td>${formatCurrency(t.entryPrice)}</td>
      <td>${formatCurrency(t.exitPrice)}</td>
      <td class="${t.pl >= 0 ? 'trade-positive' : 'trade-negative'}">${formatCurrency(t.pl)}</td>
      <td>${t.rMultiple !== null && t.rMultiple !== undefined ? t.rMultiple + 'R' : '—'}</td>
      <td>${t.strategy || '—'}</td>
      <td>${(t.tags || []).map(tag => `<span class="tag">${tag}</span>`).join('')}</td>
      <td>
        <button class="btn btn-secondary action-btn" onclick="openTradeModal('${t.id}')">Edit</button>
        <button class="btn btn-danger action-btn" onclick="deleteTrade('${t.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

// Set up live search/filter on trades page
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('trade-search');
  const filterSelect = document.getElementById('trade-filter');
  if (searchInput) searchInput.addEventListener('input', displayTrades);
  if (filterSelect) filterSelect.addEventListener('change', displayTrades);
});

// ─── Charts ───────────────────────────────────────────────────────────────────
let equityChartInstance = null;
let winlossChartInstance = null;
let reportChartInstance = null;

function renderEquityChart(trades) {
  const ctx = document.getElementById('equity-chart');
  if (!ctx) return;
  if (equityChartInstance) equityChartInstance.destroy();

  const sorted = [...trades].reverse();
  let running = 0;
  const labels = [];
  const data = [];
  sorted.forEach(t => {
    running += (t.pl || 0);
    labels.push(t.date || '');
    data.push(parseFloat(running.toFixed(2)));
  });

  equityChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Equity ($)',
        data,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: data.length > 30 ? 0 : 4
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: v => '$' + v.toLocaleString() } }
      }
    }
  });
}

function renderWinLossChart(wins, losses, breakeven) {
  const ctx = document.getElementById('winloss-chart');
  if (!ctx) return;
  if (winlossChartInstance) winlossChartInstance.destroy();

  winlossChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Wins', 'Losses', 'Breakeven'],
      datasets: [{
        data: [wins, losses, breakeven],
        backgroundColor: ['#10b981', '#ef4444', '#6b7280'],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

// ─── Reports ──────────────────────────────────────────────────────────────────
function updateReport() {
  const type = document.getElementById('report-type')?.value || 'drawdown';
  const ctx = document.getElementById('report-chart');
  if (!ctx) return;
  if (reportChartInstance) reportChartInstance.destroy();

  const trades = [...window.trades].reverse();

  if (type === 'drawdown') {
    let peak = 0, running = 0;
    const labels = [], data = [];
    trades.forEach(t => {
      running += (t.pl || 0);
      if (running > peak) peak = running;
      labels.push(t.date || '');
      data.push(parseFloat(((peak - running)).toFixed(2)));
    });
    reportChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{ label: 'Drawdown ($)', data, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });

  } else if (type === 'risk_reward') {
    const rTrades = trades.filter(t => t.rMultiple !== null && t.rMultiple !== undefined);
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rTrades.map(t => t.symbol + ' ' + t.date),
        datasets: [{ label: 'R-Multiple', data: rTrades.map(t => t.rMultiple), backgroundColor: rTrades.map(t => t.rMultiple >= 0 ? '#10b981' : '#ef4444') }]
      },
      options: { responsive: true }
    });

  } else if (type === 'strategy_comparison') {
    const strategies = {};
    trades.forEach(t => {
      const s = t.strategy || 'Unknown';
      if (!strategies[s]) strategies[s] = 0;
      strategies[s] += (t.pl || 0);
    });
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(strategies),
        datasets: [{ label: 'P/L by Strategy', data: Object.values(strategies).map(v => parseFloat(v.toFixed(2))), backgroundColor: '#10b981' }]
      },
      options: { responsive: true }
    });

  } else if (type === 'day_of_week') {
    const days = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };
    trades.forEach(t => {
      if (t.date) {
        const d = new Date(t.date + 'T00:00:00');
        const name = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
        if (days[name] !== undefined) days[name] += (t.pl || 0);
      }
    });
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(days),
        datasets: [{ label: 'P/L by Day', data: Object.values(days).map(v => parseFloat(v.toFixed(2))), backgroundColor: '#10b981' }]
      },
      options: { responsive: true }
    });

  } else if (type === 'performance_time') {
    const monthly = {};
    trades.forEach(t => {
      if (t.date) {
        const m = t.date.substring(0, 7);
        if (!monthly[m]) monthly[m] = 0;
        monthly[m] += (t.pl || 0);
      }
    });
    const sortedKeys = Object.keys(monthly).sort();
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sortedKeys,
        datasets: [{ label: 'Monthly P/L', data: sortedKeys.map(k => parseFloat(monthly[k].toFixed(2))), backgroundColor: sortedKeys.map(k => monthly[k] >= 0 ? '#10b981' : '#ef4444') }]
      },
      options: { responsive: true }
    });

  } else if (type === 'tag_performance') {
    const tagMap = {};
    trades.forEach(t => {
      (t.tags || []).forEach(tag => {
        if (!tagMap[tag]) tagMap[tag] = 0;
        tagMap[tag] += (t.pl || 0);
      });
    });
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(tagMap),
        datasets: [{ label: 'P/L by Tag', data: Object.values(tagMap).map(v => parseFloat(v.toFixed(2))), backgroundColor: '#10b981' }]
      },
      options: { responsive: true }
    });

  } else if (type === 'time_of_day') {
    reportChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Pre-Market', 'Open (9:30-11)', 'Mid-Day (11-2)', 'Afternoon (2-4)', 'After Hours'],
        datasets: [{ label: 'P/L by Session', data: [0, 0, 0, 0, 0], backgroundColor: '#10b981' }]
      },
      options: { responsive: true }
    });
  }

  document.getElementById('report-type')?.removeEventListener('change', updateReport);
  document.getElementById('report-type')?.addEventListener('change', updateReport);
}

document.addEventListener('DOMContentLoaded', () => {
  const reportType = document.getElementById('report-type');
  if (reportType) reportType.addEventListener('change', updateReport);
  const exportReportBtn = document.getElementById('export-report-btn');
  if (exportReportBtn) exportReportBtn.addEventListener('click', exportReport);
});

function exportReport() {
  const ctx = document.getElementById('report-chart');
  if (!ctx || !reportChartInstance) return;
  const link = document.createElement('a');
  link.download = 'gltrades-report.png';
  link.href = ctx.toDataURL();
  link.click();
}

// ─── Playbooks ────────────────────────────────────────────────────────────────
function setupPlaybookModal() {
  document.getElementById('add-playbook-btn').addEventListener('click', () => {
    document.getElementById('playbook-form').reset();
    document.getElementById('playbook-modal').classList.add('active');
  });
  document.getElementById('close-playbook-modal').addEventListener('click', () => {
    document.getElementById('playbook-modal').classList.remove('active');
  });
  document.getElementById('cancel-playbook-btn').addEventListener('click', () => {
    document.getElementById('playbook-modal').classList.remove('active');
  });
  document.getElementById('playbook-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('playbook-modal'))
      document.getElementById('playbook-modal').classList.remove('active');
  });
  document.getElementById('playbook-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await savePlaybook();
  });
}

async function savePlaybook() {
  const submitBtn = document.querySelector('#playbook-form button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';
  try {
    const data = {
      name: document.getElementById('playbook-name').value.trim(),
      description: document.getElementById('playbook-description').value.trim(),
      entryCriteria: document.getElementById('playbook-entry').value.trim(),
      exitCriteria: document.getElementById('playbook-exit').value.trim(),
      riskManagement: document.getElementById('playbook-risk').value.trim(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('users').doc(currentUser).collection('playbooks').add(data);
    window.playbooks.unshift({ id: docRef.id, ...data });
    document.getElementById('playbook-modal').classList.remove('active');
    displayPlaybooks();
  } catch (err) {
    console.error('Error saving playbook:', err);
    alert('Error saving playbook.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Playbook';
  }
}

async function deletePlaybook(id) {
  if (!confirm('Delete this playbook?')) return;
  try {
    await db.collection('users').doc(currentUser).collection('playbooks').doc(id).delete();
    window.playbooks = window.playbooks.filter(p => p.id !== id);
    displayPlaybooks();
  } catch (err) {
    console.error('Error deleting playbook:', err);
  }
}

function displayPlaybooks() {
  const grid = document.getElementById('playbooks-grid');
  if (!grid) return;
  if (!window.playbooks.length) {
    grid.innerHTML = '<div style="color:var(--text-secondary);padding:2rem;">No playbooks yet. Click "+ New Playbook" to create one.</div>';
    return;
  }
  grid.innerHTML = window.playbooks.map(p => `
    <div class="playbook-card">
      <h3>${p.name || 'Untitled'}</h3>
      <p>${p.description || ''}</p>
      <div class="playbook-section">
        <h4>Entry Criteria</h4>
        <p>${p.entryCriteria || ''}</p>
      </div>
      <div class="playbook-section">
        <h4>Exit Criteria</h4>
        <p>${p.exitCriteria || ''}</p>
      </div>
      <div class="playbook-section">
        <h4>Risk Management</h4>
        <p>${p.riskManagement || ''}</p>
      </div>
      <div class="playbook-actions">
        <button class="btn btn-danger action-btn" onclick="deletePlaybook('${p.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

// ─── Journal ──────────────────────────────────────────────────────────────────
function setupJournalModal() {
  document.getElementById('add-journal-btn').addEventListener('click', () => {
    document.getElementById('journal-form').reset();
    document.getElementById('journal-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('journal-modal').classList.add('active');
  });
  document.getElementById('close-journal-modal').addEventListener('click', () => {
    document.getElementById('journal-modal').classList.remove('active');
  });
  document.getElementById('cancel-journal-btn').addEventListener('click', () => {
    document.getElementById('journal-modal').classList.remove('active');
  });
  document.getElementById('journal-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('journal-modal'))
      document.getElementById('journal-modal').classList.remove('active');
  });
  document.getElementById('journal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveJournalEntry();
  });
}

async function saveJournalEntry() {
  const submitBtn = document.querySelector('#journal-form button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';
  try {
    const data = {
      date: document.getElementById('journal-date').value,
      title: document.getElementById('journal-title').value.trim(),
      entry: document.getElementById('journal-entry').value.trim(),
      mood: document.getElementById('journal-mood').value,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('users').doc(currentUser).collection('journal').add(data);
    window.journalEntries.unshift({ id: docRef.id, ...data });
    document.getElementById('journal-modal').classList.remove('active');
    displayJournal();
  } catch (err) {
    console.error('Error saving journal entry:', err);
    alert('Error saving journal entry.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Entry';
  }
}

async function deleteJournalEntry(id) {
  if (!confirm('Delete this journal entry?')) return;
  try {
    await db.collection('users').doc(currentUser).collection('journal').doc(id).delete();
    window.journalEntries = window.journalEntries.filter(j => j.id !== id);
    displayJournal();
  } catch (err) {
    console.error('Error deleting journal entry:', err);
  }
}

function displayJournal() {
  const container = document.getElementById('journal-entries');
  if (!container) return;
  if (!window.journalEntries.length) {
    container.innerHTML = '<div style="color:var(--text-secondary);padding:2rem;">No journal entries yet. Click "+ New Entry" to start journaling.</div>';
    return;
  }
  container.innerHTML = window.journalEntries.map(j => `
    <div class="journal-card">
      <div class="journal-header">
        <div>
          <h3>${j.title || 'Untitled'}</h3>
          <div class="journal-date">${j.date || ''}</div>
          <span class="journal-mood">${j.mood || ''}</span>
        </div>
        <button class="btn btn-danger action-btn" onclick="deleteJournalEntry('${j.id}')">Delete</button>
      </div>
      <div class="journal-content">${j.entry || ''}</div>
    </div>
  `).join('');
}

// ─── GL University ────────────────────────────────────────────────────────────
// Default categories (rendered in HTML, editable by admin via Firestore)
const DEFAULT_COURSES = [
  { id: 'risk_management', icon: '📊', title: 'Risk Management Fundamentals', description: 'Learn the essential principles of position sizing, stop losses, and portfolio risk management.', lessons: '8 Lessons', level: 'Beginner' },
  { id: 'technical_analysis', icon: '📈', title: 'Technical Analysis Mastery', description: 'Master chart patterns, indicators, and price action trading strategies.', lessons: '12 Lessons', level: 'Intermediate' },
  { id: 'psychology', icon: '🧠', title: 'Trading Psychology', description: 'Develop mental discipline, emotional control, and winning trading habits.', lessons: '10 Lessons', level: 'All Levels' },
  { id: 'options', icon: '💰', title: 'Options Trading Strategies', description: 'Understand options mechanics, spreads, and advanced trading strategies.', lessons: '15 Lessons', level: 'Advanced' },
  { id: 'systems', icon: '🎯', title: 'Building Trading Systems', description: 'Create, backtest, and optimize profitable trading systems and strategies.', lessons: '10 Lessons', level: 'Advanced' },
  { id: 'market_analysis', icon: '📉', title: 'Market Analysis & Research', description: 'Develop skills in fundamental analysis, market research, and trade idea generation.', lessons: '9 Lessons', level: 'Intermediate' }
];

let glData = { courses: [], readingList: [], externalLinks: [] };

async function loadGLUniversityData() {
  try {
    const doc = await db.collection('global').doc('gl_university').get();
    if (doc.exists) {
      const d = doc.data();
      glData.courses = d.courses || [];
      glData.readingList = d.readingList || [];
      glData.externalLinks = d.externalLinks || [];
    } else {
      glData = { courses: [], readingList: [], externalLinks: [] };
    }
  } catch (err) {
    console.error('GL University load error:', err);
    glData = { courses: [], readingList: [], externalLinks: [] };
  }
}

async function displayGLUniversity() {
  await loadGLUniversityData();
  const isAdmin = authManager.isAdmin();

  // Course grid
  const grid = document.getElementById('university-grid');
  if (grid) {
    const coursesToShow = glData.courses.length ? glData.courses : DEFAULT_COURSES;
    grid.innerHTML = coursesToShow.map((c, idx) => `
      <div class="course-card">
        <div class="course-icon">${c.icon || '📚'}</div>
        <h3>${c.title || ''}</h3>
        <p>${c.description || ''}</p>
        <div class="course-meta">
          <span>${c.lessons || ''}</span>
          <span>${c.level || ''}</span>
        </div>
        <button class="btn btn-outline">Start Learning</button>
        ${isAdmin ? `
          <div class="admin-course-actions">
            <button class="btn btn-secondary action-btn" onclick="openEditCourseModal(${idx})">Edit</button>
            <button class="btn btn-danger action-btn" onclick="deleteCourse(${idx})">Delete</button>
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  // Reading list
  const readingList = document.getElementById('reading-list');
  if (readingList) {
    if (glData.readingList.length) {
      readingList.innerHTML = glData.readingList.map((item, idx) => `
        <li>
          <span>${item.title}${item.author ? ' — ' + item.author : ''}</span>
          ${isAdmin ? `<button class="admin-inline-btn" onclick="deleteReadingItem(${idx})">✕</button>` : ''}
        </li>
      `).join('');
    } else {
      readingList.innerHTML = `
        <li>Trading in the Zone — Mark Douglas</li>
        <li>Market Wizards — Jack Schwager</li>
        <li>Reminiscences of a Stock Operator — Edwin Lefèvre</li>
        <li>The Disciplined Trader — Mark Douglas</li>
      `;
    }
  }

  // External links
  const extLinks = document.getElementById('external-links');
  if (extLinks) {
    if (glData.externalLinks.length) {
      extLinks.innerHTML = glData.externalLinks.map((item, idx) => `
        <li>
          <a href="${item.url}" target="_blank" rel="noopener">${item.title}</a>
          ${isAdmin ? `<button class="admin-inline-btn" onclick="deleteLinkItem(${idx})">✕</button>` : ''}
        </li>
      `).join('');
    } else {
      extLinks.innerHTML = `
        <li><a href="https://www.tradingview.com" target="_blank">TradingView — Charting Platform</a></li>
        <li><a href="https://finviz.com" target="_blank">Finviz — Market Screener</a></li>
        <li><a href="https://www.investopedia.com" target="_blank">Investopedia — Education</a></li>
        <li><a href="https://www.sec.gov/edgar" target="_blank">SEC EDGAR — Filings</a></li>
      `;
    }
  }

  // Admin controls panel
  const adminPanel = document.getElementById('admin-university-panel');
  if (adminPanel) adminPanel.style.display = isAdmin ? 'block' : 'none';
}

// ─── Admin UI Setup ───────────────────────────────────────────────────────────
function setupRoleBasedUI() {
  buildAdminPanel();
  if (authManager.isAdmin()) {
    document.getElementById('admin-university-panel').style.display = 'block';
  }
}

function buildAdminPanel() {
  // Insert admin panel into university page if not already there
  const universityPage = document.getElementById('university-page');
  if (!universityPage || document.getElementById('admin-university-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'admin-university-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="settings-section admin-panel-box">
      <h3 style="color:var(--primary-color);margin-bottom:1.5rem;">Admin — GL University Controls</h3>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="openAddCourseModal()">+ Add Course</button>
        <button class="btn btn-secondary" onclick="openAddReadingModal()">+ Add Reading</button>
        <button class="btn btn-secondary" onclick="openAddLinkModal()">+ Add Link</button>
      </div>
    </div>
  `;
  // Insert at the top of the university page, after the page-header
  const pageHeader = universityPage.querySelector('.page-header');
  if (pageHeader) {
    pageHeader.insertAdjacentElement('afterend', panel);
  } else {
    universityPage.prepend(panel);
  }
}

// ─── Admin: Course CRUD ───────────────────────────────────────────────────────
function openAddCourseModal() {
  const icons = ['📊','📈','🧠','💰','🎯','📉','📚','🔗','⚡','🎓'];
  const html = `
    <div id="course-modal" class="modal active">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Course</h3>
          <button class="modal-close" onclick="document.getElementById('course-modal').remove()">&times;</button>
        </div>
        <form id="course-form" style="padding:1.5rem;">
          <div class="form-group">
            <label>Icon</label>
            <select id="course-icon-input" class="setting-input">
              ${icons.map(i => `<option value="${i}">${i}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Title</label>
            <input type="text" id="course-title-input" class="setting-input" required placeholder="Course title">
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Description</label>
            <textarea id="course-desc-input" class="setting-input" rows="3" required placeholder="Short description"></textarea>
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Lessons (e.g. "8 Lessons")</label>
            <input type="text" id="course-lessons-input" class="setting-input" placeholder="8 Lessons">
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Level</label>
            <select id="course-level-input" class="setting-input">
              <option>Beginner</option>
              <option>Intermediate</option>
              <option>Advanced</option>
              <option>All Levels</option>
            </select>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('course-modal').remove()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Course</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('course-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newCourse = {
      icon: document.getElementById('course-icon-input').value,
      title: document.getElementById('course-title-input').value.trim(),
      description: document.getElementById('course-desc-input').value.trim(),
      lessons: document.getElementById('course-lessons-input').value.trim(),
      level: document.getElementById('course-level-input').value
    };
    const courses = glData.courses.length ? [...glData.courses] : [...DEFAULT_COURSES];
    courses.push(newCourse);
    await saveGLData({ courses });
    document.getElementById('course-modal').remove();
    displayGLUniversity();
  });
}

function openEditCourseModal(idx) {
  const courses = glData.courses.length ? glData.courses : DEFAULT_COURSES;
  const c = courses[idx];
  const icons = ['📊','📈','🧠','💰','🎯','📉','📚','🔗','⚡','🎓'];
  const html = `
    <div id="course-modal" class="modal active">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Edit Course</h3>
          <button class="modal-close" onclick="document.getElementById('course-modal').remove()">&times;</button>
        </div>
        <form id="course-form" style="padding:1.5rem;">
          <div class="form-group">
            <label>Icon</label>
            <select id="course-icon-input" class="setting-input">
              ${icons.map(i => `<option value="${i}" ${i === c.icon ? 'selected' : ''}>${i}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Title</label>
            <input type="text" id="course-title-input" class="setting-input" required value="${c.title || ''}">
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Description</label>
            <textarea id="course-desc-input" class="setting-input" rows="3" required>${c.description || ''}</textarea>
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Lessons</label>
            <input type="text" id="course-lessons-input" class="setting-input" value="${c.lessons || ''}">
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Level</label>
            <select id="course-level-input" class="setting-input">
              ${['Beginner','Intermediate','Advanced','All Levels'].map(l => `<option ${l === c.level ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('course-modal').remove()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('course-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const updatedCourses = glData.courses.length ? [...glData.courses] : [...DEFAULT_COURSES];
    updatedCourses[idx] = {
      icon: document.getElementById('course-icon-input').value,
      title: document.getElementById('course-title-input').value.trim(),
      description: document.getElementById('course-desc-input').value.trim(),
      lessons: document.getElementById('course-lessons-input').value.trim(),
      level: document.getElementById('course-level-input').value
    };
    await saveGLData({ courses: updatedCourses });
    document.getElementById('course-modal').remove();
    displayGLUniversity();
  });
}

async function deleteCourse(idx) {
  if (!confirm('Delete this course?')) return;
  const courses = glData.courses.length ? [...glData.courses] : [...DEFAULT_COURSES];
  courses.splice(idx, 1);
  await saveGLData({ courses });
  displayGLUniversity();
}

// ─── Admin: Reading List CRUD ─────────────────────────────────────────────────
function openAddReadingModal() {
  const html = `
    <div id="reading-modal" class="modal active">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Reading</h3>
          <button class="modal-close" onclick="document.getElementById('reading-modal').remove()">&times;</button>
        </div>
        <form id="reading-form" style="padding:1.5rem;">
          <div class="form-group">
            <label>Title</label>
            <input type="text" id="reading-title-input" class="setting-input" required placeholder="Book or article title">
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>Author (optional)</label>
            <input type="text" id="reading-author-input" class="setting-input" placeholder="Author name">
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('reading-modal').remove()">Cancel</button>
            <button type="submit" class="btn btn-primary">Add</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('reading-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const list = [...glData.readingList];
    list.push({
      title: document.getElementById('reading-title-input').value.trim(),
      author: document.getElementById('reading-author-input').value.trim()
    });
    await saveGLData({ readingList: list });
    document.getElementById('reading-modal').remove();
    displayGLUniversity();
  });
}

async function deleteReadingItem(idx) {
  if (!confirm('Remove this reading item?')) return;
  const list = [...glData.readingList];
  list.splice(idx, 1);
  await saveGLData({ readingList: list });
  displayGLUniversity();
}

// ─── Admin: Links CRUD ────────────────────────────────────────────────────────
function openAddLinkModal() {
  const html = `
    <div id="link-modal" class="modal active">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Link</h3>
          <button class="modal-close" onclick="document.getElementById('link-modal').remove()">&times;</button>
        </div>
        <form id="link-form" style="padding:1.5rem;">
          <div class="form-group">
            <label>Title</label>
            <input type="text" id="link-title-input" class="setting-input" required placeholder="Link title">
          </div>
          <div class="form-group" style="margin-top:1rem;">
            <label>URL</label>
            <input type="url" id="link-url-input" class="setting-input" required placeholder="https://...">
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('link-modal').remove()">Cancel</button>
            <button type="submit" class="btn btn-primary">Add</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('link-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const list = [...glData.externalLinks];
    list.push({
      title: document.getElementById('link-title-input').value.trim(),
      url: document.getElementById('link-url-input').value.trim()
    });
    await saveGLData({ externalLinks: list });
    document.getElementById('link-modal').remove();
    displayGLUniversity();
  });
}

async function deleteLinkItem(idx) {
  if (!confirm('Remove this link?')) return;
  const list = [...glData.externalLinks];
  list.splice(idx, 1);
  await saveGLData({ externalLinks: list });
  displayGLUniversity();
}

// ─── Firestore GL Save (merges so partial updates work) ───────────────────────
async function saveGLData(partial) {
  // Merge partial changes into glData first
  if (partial.courses !== undefined) glData.courses = partial.courses;
  if (partial.readingList !== undefined) glData.readingList = partial.readingList;
  if (partial.externalLinks !== undefined) glData.externalLinks = partial.externalLinks;

  await db.collection('global').doc('gl_university').set({
    courses: glData.courses,
    readingList: glData.readingList,
    externalLinks: glData.externalLinks,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function setupSettingsButtons() {
  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const settings = {
          platformName: document.getElementById('setting-platform-name').value,
          currency: document.getElementById('setting-currency').value,
          brandColor: document.getElementById('setting-brand-color').value,
          educationalEnabled: document.getElementById('setting-educational').checked,
          sampleData: document.getElementById('setting-sample-data').checked
        };
        await db.collection('users').doc(currentUser).set({ settings }, { merge: true });
        // Apply brand color live
        document.documentElement.style.setProperty('--primary-color', settings.brandColor);
        alert('Settings saved!');
      } catch (err) {
        console.error('Error saving settings:', err);
        alert('Error saving settings.');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Settings';
      }
    });
  }

  const exportBtn = document.getElementById('export-data-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const data = {
        trades: window.trades,
        playbooks: window.playbooks,
        journal: window.journalEntries
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gltrades-export.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const importBtn = document.getElementById('import-data-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          alert('Import is read successfully. Full import with Firestore sync coming soon.');
          console.log('Import data:', data);
        } catch (err) {
          alert('Invalid JSON file.');
        }
      };
      input.click();
    });
  }

  const resetBtn = document.getElementById('reset-data-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to reset ALL your data? This cannot be undone.')) return;
      if (!confirm('Second confirmation: This will permanently delete all your trades, playbooks, and journal entries.')) return;
      try {
        const batch = db.batch();
        window.trades.forEach(t => batch.delete(db.collection('users').doc(currentUser).collection('trades').doc(t.id)));
        window.playbooks.forEach(p => batch.delete(db.collection('users').doc(currentUser).collection('playbooks').doc(p.id)));
        window.journalEntries.forEach(j => batch.delete(db.collection('users').doc(currentUser).collection('journal').doc(j.id)));
        await batch.commit();
        window.trades = [];
        window.playbooks = [];
        window.journalEntries = [];
        updateDashboard();
        alert('All data has been reset.');
      } catch (err) {
        console.error('Error resetting data:', err);
        alert('Error resetting data.');
      }
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatCurrency(val) {
  if (val === null || val === undefined || isNaN(val)) return '$0.00';
  const n = parseFloat(val);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
