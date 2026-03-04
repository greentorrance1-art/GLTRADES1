// ─── Global State ────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentUser = null;
let userRole = null;
let editingTradeId = null;

window.trades = [];
window.playbooks = [];
window.journalEntries = [];

// Journal image upload (client-side)
let journalImageFiles = [];

// User-level settings document (users/{uid}.settings)
window.userSettings = {};

// Journal image staging (files selected before save)
let pendingJournalImages = [];

// Journal images (current implementation uses this array)
let journalImageFiles = [];

// TradingView market overview state
let currentMarketSymbol = 'NASDAQ:AAPL';

// ─── App Entry Point ──────────────────────────────────────────────────────────
window.initializeApp = async function () {
  currentUser = authManager.getUserId();

  // Ensure role + settings are loaded before building role-based UI
  userRole = await ensureUserRoleLoaded();
  await loadUserSettings();

  await loadAllData();
  setupNavigation();
  setupTradeModal();
  setupPlaybookModal();
  setupJournalModal();
  setupSettingsButtons();
  setupRoleBasedUI();

  // Enable admin controls for GL University
  if (auth.currentUser?.email === ADMIN_EMAIL) {
    enableUniversityAdmin();
  }

  // Build TradingView widgets on dashboard
  initMarketOverview();

  updateDashboard();
  showPage('dashboard');
};

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function loadAllData() {
  if (!currentUser) return;
  try {
    const userDocRef = db.collection('users').doc(currentUser);
    const [tradesSnap, playbooksSnap, journalSnap, userDoc] = await Promise.all([
      userDocRef.collection('trades').orderBy('date', 'desc').get(),
      userDocRef.collection('playbooks').get(),
      userDocRef.collection('journal').orderBy('date', 'desc').get(),
      userDocRef.get()
    ]);
    window.trades = tradesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.playbooks = playbooksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.journalEntries = journalSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Pull user settings (for Market Overview watchlist, etc.)
    window.userSettings = (userDoc.exists && userDoc.data().settings) ? userDoc.data().settings : {};
  } catch (err) {
    console.error('Error loading data:', err);
  }
}


// ─── User Settings / Role bootstrap ───────────────────────────────────────────
async function ensureUserRoleLoaded() {
  // Prefer authManager role if available; otherwise read from Firestore user doc
  if (authManager && typeof authManager.userRole !== 'undefined' && authManager.userRole) {
    return authManager.userRole;
  }
  if (!currentUser) return null;
  try {
    const snap = await db.collection('users').doc(currentUser).get();
    const role = snap.exists ? (snap.data().role || snap.data().userRole || null) : null;
    if (authManager && role) authManager.userRole = role;
    return role;
  } catch (e) {
    console.warn('Role load fallback failed:', e);
    return null;
  }
}

async function loadUserSettings() {
  if (!currentUser) return {};
  try {
    const snap = await db.collection('users').doc(currentUser).get();
    const s = snap.exists ? (snap.data().settings || {}) : {};
    window.userSettings = s;
    return s;
  } catch (e) {
    console.warn('Settings load failed:', e);
    window.userSettings = {};
    return {};
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

  if (page === 'dashboard') {
    updateDashboard();
    renderMarketOverviewWidgets();
  }
  if (page === 'trades') displayTrades();
  if (page === 'reports') updateReport();
  if (page === 'playbooks') displayPlaybooks();
  if (page === 'journal') displayJournal();
  if (page === 'university') displayGLUniversity();
  if (page === 'settings' && authManager.isAdmin()) {
    injectSettingsGLShortcut();
    refreshSettingsGLEditor();
    injectMarketOverviewSettings();
  }
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

// ─── TradingView Market Overview ───────────────────────────────────────────
function setupMarketOverviewUI() {
  // Default watchlist (can be overridden by user settings)
  const symbols = getMarketOverviewSymbols();
  if (symbols.length && !currentMarketSymbol) currentMarketSymbol = symbols[0];

  const watchEl = document.getElementById('tv-watchlist');
  if (!watchEl) return;

  // Investopedia-style ticker tape (TradingView widget)
  // Ticker tape doesn't provide a reliable click callback to drive the chart.
  // The Advanced Chart below still supports symbol switching + has a built-in watchlist.
  const tvSymbols = symbols.map(s => ({ proName: s, title: s }));

  injectTradingViewWidget('tv-watchlist',
    'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js',
    {
      symbols: tvSymbols,
      showSymbolLogo: true,
      colorTheme: 'dark',
      isTransparent: true,
      displayMode: 'adaptive',
      locale: 'en'
    }
  );
}

function getMarketOverviewSymbols() {
  // Stored as comma-separated string in user settings (admin can set their defaults)
  const raw = (window.userSettings && window.userSettings.marketOverviewSymbols) ? window.userSettings.marketOverviewSymbols : '';
  const parsed = raw
    ? raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
    : [];

  // Sensible defaults (heavy hitters + broad index + futures)
  return parsed.length ? parsed : [
    'AMEX:SPY',
    'NASDAQ:QQQ',
    'AMEX:DIA',
    'AMEX:IWM',
    'NASDAQ:AAPL',
    'NASDAQ:NVDA',
    'NASDAQ:MSFT',
    'NASDAQ:AMZN',
    'NASDAQ:TSLA',
    'CME_MINI:ES1!',
    'CME_MINI:NQ1!',
    'CME_MINI:MNQ1!',
    'TVC:GOLD',
    'FX:EURUSD',
    'CRYPTO:BTCUSD'
  ];
}

function injectTradingViewWidget(containerId, scriptSrc, configObj) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = scriptSrc;
  script.innerHTML = JSON.stringify(configObj);
  el.appendChild(script);
}

function renderMarketOverviewWidgets() {
  // Only render if dashboard containers exist
  const chartEl = document.getElementById('tv-advanced-chart');
  const heatEl  = document.getElementById('tv-heatmap');
  if (!chartEl || !heatEl) return;

  // Advanced Chart: full toolbar (candles, Heikin Ashi, indicators, intervals)
  injectTradingViewWidget('tv-advanced-chart',
    'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
    {
      autosize: true,
      symbol: currentMarketSymbol,
      interval: 'D',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      hide_side_toolbar: false,
      withdateranges: true,
      watchlist: getMarketOverviewSymbols(),
      details: true,
      hotlist: false,
      calendar: true,
      support_host: 'https://www.tradingview.com'
    }
  );

  // Heatmap
  injectTradingViewWidget('tv-heatmap',
    'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js',
    {
      autosize: true,
      exchange: 'US',
      dataSource: 'SPX500',
      grouping: 'sector',
      blockSize: 'market_cap_basic',
      blockColor: 'change',
      locale: 'en',
      colorTheme: 'dark',
      hasTopBar: true,
      isDataSetEnabled: true,
      isZoomEnabled: true,
      hasSymbolTooltip: true
    }
  );
}

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
      maintainAspectRatio: false,
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
  const modal = document.getElementById('journal-modal');
  const form = document.getElementById('journal-form');
  const addBtn = document.getElementById('add-journal-btn');

  const dropzone = document.getElementById('journal-dropzone');
  const fileInput = document.getElementById('journal-images');
  const previews = document.getElementById('journal-image-preview');
  const entryField = document.getElementById('journal-entry');

  const resetImages = () => {
    journalImageFiles = [];
    if (fileInput) fileInput.value = '';
    if (previews) previews.innerHTML = '';
  };

  const renderPreviews = () => {
    if (!previews) return;
    previews.innerHTML = '';
    journalImageFiles.forEach((file, idx) => {
      const url = URL.createObjectURL(file);
      const wrap = document.createElement('div');
      wrap.className = 'preview-thumb';
      wrap.innerHTML = `<img src="${url}" alt="Screenshot ${idx + 1}"><button type="button" class="preview-remove" title="Remove">×</button>`;
      wrap.querySelector('button').addEventListener('click', () => {
        journalImageFiles.splice(idx, 1);
        renderPreviews();
      });
      previews.appendChild(wrap);
    });
  };

  const addFiles = (files) => {
    const list = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
    if (!list.length) return;
    journalImageFiles = [...journalImageFiles, ...list].slice(0, 6);
    renderPreviews();
  };

  addBtn?.addEventListener('click', () => {
    form.reset();
    document.getElementById('journal-date').value = new Date().toISOString().split('T')[0];
    resetImages();
    modal.classList.add('active');
  });

  document.getElementById('close-journal-modal')?.addEventListener('click', () => { modal.classList.remove('active'); resetImages(); });
  document.getElementById('cancel-journal-btn')?.addEventListener('click', () => { modal.classList.remove('active'); resetImages(); });
  modal?.addEventListener('click', (e) => { if (e.target === modal) { modal.classList.remove('active'); resetImages(); } });

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); addFiles(e.dataTransfer.files); });
    fileInput.addEventListener('change', (e) => addFiles(e.target.files));
  }

  // Prevent browsers from inserting a file path/link into the textarea on drop.
  // Instead, treat drops as image uploads.
  if (entryField) {
    entryField.addEventListener('dragover', (e) => e.preventDefault());
    entryField.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveJournalEntry();
  });
}

async function uploadJournalImages(files) {
  const uploads = [];
  for (const file of files) {
    const ref = storage.ref().child(`journal/${Date.now()}_${file.name}`);
    uploads.push(
      ref.put(file).then(s => s.ref.getDownloadURL())
    );
  }
  return Promise.all(uploads);
}

async function saveJournalEntry() {
  const submitBtn = document.querySelector('#journal-form button[type="submit"]');
  if (!submitBtn) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  try {
    if (!currentUser) throw new Error('Not signed in');

    const files = journalImageFiles;
    let imageUrls = [];
    if (files.length > 0) {
      imageUrls = await uploadJournalImages(files);
    }

    const data = {
      date: document.getElementById('journal-date').value,
      title: document.getElementById('journal-title').value.trim(),
      entry: document.getElementById('journal-entry').value.trim(),
      mood: document.getElementById('journal-mood').value,
      images: imageUrls,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('users').doc(currentUser).collection('journal').add(data);
    window.journalEntries.unshift({ id: docRef.id, ...data });

    document.getElementById('journal-modal').classList.remove('active');
    journalImageFiles = [];
    const previews = document.getElementById('journal-image-preview');
    if (previews) previews.innerHTML = '';

    displayJournal();
  } catch (err) {
    console.error('Error saving journal entry:', err);
    alert('Error saving entry. Please try again.');
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
  container.innerHTML = window.journalEntries.map(j => {
    const imgs = Array.isArray(j.images) && j.images.length
      ? j.images
      : (Array.isArray(j.screenshots) ? j.screenshots : []);
    return `
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
      ${(imgs && imgs.length) ? `
        <div class="journal-images">
          ${imgs.map(url => `<a href="${escAttr(url)}" target="_blank" rel="noopener"><img src="${escAttr(url)}" alt="journal-image" /></a>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
}

// ─── GL University ─────────────────────────────────────────────────────────────
// ── These are the hardcoded defaults shown until admin saves custom content ──
const DEFAULT_COURSES = [
  { icon: '📊', title: 'Risk Management Fundamentals',  description: 'Learn the essential principles of position sizing, stop losses, and portfolio risk management.', lessons: '8 Lessons',  level: 'Beginner'     },
  { icon: '📈', title: 'Technical Analysis Mastery',    description: 'Master chart patterns, indicators, and price action trading strategies.',                          lessons: '12 Lessons', level: 'Intermediate' },
  { icon: '🧠', title: 'Trading Psychology',            description: 'Develop mental discipline, emotional control, and winning trading habits.',                         lessons: '10 Lessons', level: 'All Levels'   },
  { icon: '💰', title: 'Options Trading Strategies',    description: 'Understand options mechanics, spreads, and advanced trading strategies.',                           lessons: '15 Lessons', level: 'Advanced'     },
  { icon: '🎯', title: 'Building Trading Systems',      description: 'Create, backtest, and optimize profitable trading systems and strategies.',                         lessons: '10 Lessons', level: 'Advanced'     },
  { icon: '📉', title: 'Market Analysis & Research',   description: 'Develop skills in fundamental analysis, market research, and trade idea generation.',               lessons: '9 Lessons',  level: 'Intermediate' }
];

const DEFAULT_READING = [
  { title: 'Trading in the Zone',                      author: 'Mark Douglas'   },
  { title: 'Market Wizards',                           author: 'Jack Schwager'  },
  { title: 'Reminiscences of a Stock Operator',        author: 'Edwin Lefèvre'  },
  { title: 'The Disciplined Trader',                   author: 'Mark Douglas'   }
];

const DEFAULT_LINKS = [
  { title: 'TradingView — Charting Platform', url: 'https://www.tradingview.com' },
  { title: 'Finviz — Market Screener',        url: 'https://finviz.com'          },
  { title: 'Investopedia — Education',        url: 'https://www.investopedia.com'},
  { title: 'SEC EDGAR — Filings',             url: 'https://www.sec.gov/edgar'   }
];

// Live working copy — populated from Firestore or defaults
let glData = { courses: [], readingList: [], externalLinks: [] };

// Returns true when glData has no custom data saved yet (Firestore doc empty / absent)
function glIsUsingDefaults() {
  return glData.courses.length === 0 && glData.readingList.length === 0 && glData.externalLinks.length === 0;
}

// ── Load from Firestore ────────────────────────────────────────────────────────
async function loadGLUniversityData() {
  try {
    const doc = await db.collection('global').doc('gl_university').get();
    if (doc.exists) {
      const d = doc.data();
      // Only pull in arrays that the admin has explicitly saved
      glData.courses      = Array.isArray(d.courses)       ? d.courses      : [];
      glData.readingList  = Array.isArray(d.readingList)   ? d.readingList  : [];
      glData.externalLinks= Array.isArray(d.externalLinks) ? d.externalLinks: [];
    } else {
      glData = { courses: [], readingList: [], externalLinks: [] };
    }
  } catch (err) {
    console.error('GL University load error:', err);
    glData = { courses: [], readingList: [], externalLinks: [] };
  }
}

// ── Render GL University page ─────────────────────────────────────────────────
async function displayGLUniversity() {
  await loadGLUniversityData();

  // Re-read role each time in case it loaded async after app init
  const isAdmin = authManager.isAdmin();

  // ── Course grid ─────────────────────────────────────────────────────────────
  const grid = document.getElementById('university-grid');
  if (grid) {
    const coursesToShow = glData.courses.length ? glData.courses : DEFAULT_COURSES;
    grid.innerHTML = coursesToShow.map((c, idx) => `
      <div class="course-card">
        <div class="course-icon">${escHtml(c.icon || '📚')}</div>
        <h3>${escHtml(c.title || '')}</h3>
        <p>${escHtml(c.description || '')}</p>
        <div class="course-meta">
          <span>${escHtml(c.lessons || '')}</span>
          <span>${escHtml(c.level || '')}</span>
        </div>
        <button class="btn btn-outline">Start Learning</button>
        ${isAdmin ? `
          <div class="admin-course-actions">
            <button class="btn btn-secondary action-btn" onclick="openEditCourseModal(${idx})">Edit</button>
            <button class="btn btn-danger action-btn"    onclick="deleteCourse(${idx})">Delete</button>
          </div>` : ''}
      </div>
    `).join('');
  }

  // ── Reading list ────────────────────────────────────────────────────────────
  const readingEl = document.getElementById('reading-list');
  if (readingEl) {
    const list = glData.readingList.length ? glData.readingList : DEFAULT_READING;
    readingEl.innerHTML = list.map((item, idx) => `
      <li class="gl-resource-row">
        <span>${escHtml(item.title)}${item.author ? ' — ' + escHtml(item.author) : ''}</span>
        ${isAdmin ? `
          <span class="admin-row-btns">
            <button class="admin-inline-btn edit-btn" onclick="openEditReadingModal(${idx})">Edit</button>
            <button class="admin-inline-btn"          onclick="deleteReadingItem(${idx})">✕</button>
          </span>` : ''}
      </li>
    `).join('');
  }

  // ── External links ──────────────────────────────────────────────────────────
  const linksEl = document.getElementById('external-links');
  if (linksEl) {
    const list = glData.externalLinks.length ? glData.externalLinks : DEFAULT_LINKS;
    linksEl.innerHTML = list.map((item, idx) => `
      <li class="gl-resource-row">
        <a href="${escAttr(item.url)}" target="_blank" rel="noopener">${escHtml(item.title)}</a>
        ${isAdmin ? `
          <span class="admin-row-btns">
            <button class="admin-inline-btn edit-btn" onclick="openEditLinkModal(${idx})">Edit</button>
            <button class="admin-inline-btn"          onclick="deleteLinkItem(${idx})">✕</button>
          </span>` : ''}
      </li>
    `).join('');
  }

  // ── Admin controls panel visibility ─────────────────────────────────────────
  // The panel is built once by setupRoleBasedUI; here we just show/hide it
  const adminPanel = document.getElementById('admin-university-panel');
  if (adminPanel) {
    adminPanel.style.display = isAdmin ? 'block' : 'none';
  }
}

// ─── Admin Panel ──────────────────────────────────────────────────────────────
// setupRoleBasedUI is called from initializeApp AFTER userRole is loaded.
// It injects the admin panel into the university page DOM and marks it visible.
function setupRoleBasedUI() {
  buildAdminPanel(); // always inject DOM node (hidden by default)

  // Now that role is guaranteed loaded, show if admin
  if (authManager.isAdmin()) {
    const panel = document.getElementById('admin-university-panel');
    if (panel) panel.style.display = 'block';

    // Also inject a "Manage GL University" shortcut into the Settings page
    injectSettingsGLShortcut();
  }
}

function enableUniversityAdmin() {
  // Enable admin editing tools for GL University
  const panel = document.getElementById('admin-university-panel');
  if (panel) panel.style.display = 'block';

  // Refresh the GL University page to show admin controls
  if (currentPage === 'university') {
    displayGLUniversity();
  }
}

function buildAdminPanel() {
  const universityPage = document.getElementById('university-page');
  if (!universityPage || document.getElementById('admin-university-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'admin-university-panel';
  panel.style.display = 'none'; // hidden until role confirmed
  panel.innerHTML = `
    <div class="settings-section admin-panel-box" style="margin-bottom:2rem;">
      <h3 style="color:var(--primary-color);margin-bottom:1.5rem;">Admin — GL University Controls</h3>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <button class="btn btn-primary"   onclick="openAddCourseModal()">+ Add Course</button>
        <button class="btn btn-secondary" onclick="openAddReadingModal()">+ Add Reading</button>
        <button class="btn btn-secondary" onclick="openAddLinkModal()">+ Add Link</button>
      </div>
      <p style="margin-top:1rem;font-size:0.85rem;color:var(--text-secondary);">
        Edit and Delete buttons appear on each item below when custom content has been saved.
        Adding a new item for the first time will copy the defaults into Firestore automatically.
      </p>
    </div>
  `;

  const pageHeader = universityPage.querySelector('.page-header');
  if (pageHeader) {
    pageHeader.insertAdjacentElement('afterend', panel);
  } else {
    universityPage.prepend(panel);
  }
}

// Inject a shortcut button into Settings so admin can jump to GL University editing
function injectSettingsGLShortcut() {
  if (document.getElementById('settings-gl-shortcut')) return;
  const settingsContainer = document.querySelector('#settings-page .settings-container');
  if (!settingsContainer) return;

  const section = document.createElement('div');
  section.id = 'settings-gl-shortcut';
  section.className = 'settings-section';
  section.innerHTML = `
    <h3>GL University Content</h3>
    <p style="color:var(--text-secondary);margin-bottom:1rem;font-size:0.9rem;">
      As admin, you can edit course categories, lesson counts, reading list items, and useful links directly inside GL University.
    </p>
    <button class="btn btn-primary" onclick="showPage('university')">Open GL University Editor</button>
  `;
  settingsContainer.appendChild(section);
}

// ─── Admin: Course CRUD ────────────────────────────────────────────────────────
function openAddCourseModal() {
  if (!authManager.isAdmin()) return;
  const icons = ['📊','📈','🧠','💰','🎯','📉','📚','🔗','⚡','🎓'];
  _openCourseModal({
    title: 'Add Course',
    course: { icon: '📊', title: '', description: '', lessons: '', level: 'Beginner' },
    icons,
    onSubmit: async (courseObj) => {
      // If still using defaults, seed Firestore with defaults first so edit buttons appear
      const base = glData.courses.length ? [...glData.courses] : [...DEFAULT_COURSES];
      base.push(courseObj);
      await saveGLData({ courses: base });
      displayGLUniversity();
    }
  });
}

function openEditCourseModal(idx) {
  if (!authManager.isAdmin()) return;
  const icons = ['📊','📈','🧠','💰','🎯','📉','📚','🔗','⚡','🎓'];
  const base  = glData.courses.length ? glData.courses : DEFAULT_COURSES;
  _openCourseModal({
    title: 'Edit Course',
    course: base[idx],
    icons,
    submitLabel: 'Save Changes',
    onSubmit: async (courseObj) => {
      const updated = glData.courses.length ? [...glData.courses] : [...DEFAULT_COURSES];
      updated[idx] = courseObj;
      await saveGLData({ courses: updated });
      displayGLUniversity();
    }
  });
}

// Shared modal builder for Add / Edit course
function _openCourseModal({ title, course, icons, submitLabel = 'Save Course', onSubmit }) {
  const existing = document.getElementById('gl-course-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'gl-course-modal';
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${escHtml(title)}</h3>
        <button class="modal-close" id="gl-course-modal-close">&times;</button>
      </div>
      <form id="gl-course-form" style="padding:1.5rem;">
        <div class="form-group">
          <label>Icon</label>
          <select id="gc-icon" class="setting-input">
            ${icons.map(i => `<option value="${i}"${i === course.icon ? ' selected' : ''}>${i}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-top:1rem;">
          <label>Category Name</label>
          <input type="text" id="gc-title" class="setting-input" required
                 placeholder="e.g. Risk Management Fundamentals"
                 value="${escAttr(course.title || '')}">
        </div>
        <div class="form-group" style="margin-top:1rem;">
          <label>Description</label>
          <textarea id="gc-desc" class="setting-input" rows="3" required
                    placeholder="Short description">${escHtml(course.description || '')}</textarea>
        </div>
        <div class="form-group" style="margin-top:1rem;">
          <label>Number of Lessons (e.g. "8 Lessons")</label>
          <input type="text" id="gc-lessons" class="setting-input"
                 placeholder="8 Lessons" value="${escAttr(course.lessons || '')}">
        </div>
        <div class="form-group" style="margin-top:1rem;">
          <label>Level</label>
          <select id="gc-level" class="setting-input">
            ${['Beginner','Intermediate','Advanced','All Levels'].map(l =>
              `<option${l === course.level ? ' selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="gl-course-modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${escHtml(submitLabel)}</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('gl-course-modal-close').addEventListener('click', close);
  document.getElementById('gl-course-modal-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('gl-course-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await onSubmit({
        icon:        document.getElementById('gc-icon').value,
        title:       document.getElementById('gc-title').value.trim(),
        description: document.getElementById('gc-desc').value.trim(),
        lessons:     document.getElementById('gc-lessons').value.trim(),
        level:       document.getElementById('gc-level').value
      });
      close();
    } catch (err) {
      console.error('Error saving course:', err);
      alert('Error saving. Please try again.');
      btn.disabled = false; btn.textContent = submitLabel;
    }
  });
}

async function deleteCourse(idx) {
  if (!authManager.isAdmin()) return;
  if (!confirm('Delete this course?')) return;
  const courses = glData.courses.length ? [...glData.courses] : [...DEFAULT_COURSES];
  courses.splice(idx, 1);
  await saveGLData({ courses });
  displayGLUniversity();
}

// ─── Admin: Reading List CRUD ──────────────────────────────────────────────────
function openAddReadingModal() {
  if (!authManager.isAdmin()) return;
  _openReadingModal({
    title: 'Add Reading Item',
    item: { title: '', author: '' },
    onSubmit: async (item) => {
      // Seed from defaults if first custom save
      const base = glData.readingList.length ? [...glData.readingList] : [...DEFAULT_READING];
      base.push(item);
      await saveGLData({ readingList: base });
      displayGLUniversity();
    }
  });
}

function openEditReadingModal(idx) {
  if (!authManager.isAdmin()) return;
  const list = glData.readingList.length ? glData.readingList : DEFAULT_READING;
  _openReadingModal({
    title: 'Edit Reading Item',
    item: list[idx],
    submitLabel: 'Save Changes',
    onSubmit: async (item) => {
      const updated = glData.readingList.length ? [...glData.readingList] : [...DEFAULT_READING];
      updated[idx] = item;
      await saveGLData({ readingList: updated });
      displayGLUniversity();
    }
  });
}

function _openReadingModal({ title, item, submitLabel = 'Add', onSubmit }) {
  const existing = document.getElementById('gl-reading-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'gl-reading-modal';
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${escHtml(title)}</h3>
        <button class="modal-close" id="gl-reading-modal-close">&times;</button>
      </div>
      <form id="gl-reading-form" style="padding:1.5rem;">
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="gr-title" class="setting-input" required
                 placeholder="Book or article title" value="${escAttr(item.title || '')}">
        </div>
        <div class="form-group" style="margin-top:1rem;">
          <label>Author (optional)</label>
          <input type="text" id="gr-author" class="setting-input"
                 placeholder="Author name" value="${escAttr(item.author || '')}">
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="gl-reading-modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${escHtml(submitLabel)}</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  document.getElementById('gl-reading-modal-close').addEventListener('click', close);
  document.getElementById('gl-reading-modal-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('gl-reading-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await onSubmit({
        title:  document.getElementById('gr-title').value.trim(),
        author: document.getElementById('gr-author').value.trim()
      });
      close();
    } catch (err) {
      console.error('Error saving reading item:', err);
      alert('Error saving. Please try again.');
      btn.disabled = false; btn.textContent = submitLabel;
    }
  });
}

async function deleteReadingItem(idx) {
  if (!authManager.isAdmin()) return;
  if (!confirm('Remove this reading item?')) return;
  const list = glData.readingList.length ? [...glData.readingList] : [...DEFAULT_READING];
  list.splice(idx, 1);
  await saveGLData({ readingList: list });
  displayGLUniversity();
}

// ─── Admin: Links CRUD ─────────────────────────────────────────────────────────
function openAddLinkModal() {
  if (!authManager.isAdmin()) return;
  _openLinkModal({
    title: 'Add Useful Link',
    item: { title: '', url: '' },
    onSubmit: async (item) => {
      const base = glData.externalLinks.length ? [...glData.externalLinks] : [...DEFAULT_LINKS];
      base.push(item);
      await saveGLData({ externalLinks: base });
      displayGLUniversity();
    }
  });
}

function openEditLinkModal(idx) {
  if (!authManager.isAdmin()) return;
  const list = glData.externalLinks.length ? glData.externalLinks : DEFAULT_LINKS;
  _openLinkModal({
    title: 'Edit Useful Link',
    item: list[idx],
    submitLabel: 'Save Changes',
    onSubmit: async (item) => {
      const updated = glData.externalLinks.length ? [...glData.externalLinks] : [...DEFAULT_LINKS];
      updated[idx] = item;
      await saveGLData({ externalLinks: updated });
      displayGLUniversity();
    }
  });
}

function _openLinkModal({ title, item, submitLabel = 'Add', onSubmit }) {
  const existing = document.getElementById('gl-link-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'gl-link-modal';
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${escHtml(title)}</h3>
        <button class="modal-close" id="gl-link-modal-close">&times;</button>
      </div>
      <form id="gl-link-form" style="padding:1.5rem;">
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="gl-link-title" class="setting-input" required
                 placeholder="Link title" value="${escAttr(item.title || '')}">
        </div>
        <div class="form-group" style="margin-top:1rem;">
          <label>URL</label>
          <input type="url" id="gl-link-url" class="setting-input" required
                 placeholder="https://..." value="${escAttr(item.url || '')}">
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="gl-link-modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${escHtml(submitLabel)}</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  document.getElementById('gl-link-modal-close').addEventListener('click', close);
  document.getElementById('gl-link-modal-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('gl-link-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await onSubmit({
        title: document.getElementById('gl-link-title').value.trim(),
        url:   document.getElementById('gl-link-url').value.trim()
      });
      close();
    } catch (err) {
      console.error('Error saving link:', err);
      alert('Error saving. Please try again.');
      btn.disabled = false; btn.textContent = submitLabel;
    }
  });
}

async function deleteLinkItem(idx) {
  if (!authManager.isAdmin()) return;
  if (!confirm('Remove this link?')) return;
  const list = glData.externalLinks.length ? [...glData.externalLinks] : [...DEFAULT_LINKS];
  list.splice(idx, 1);
  await saveGLData({ externalLinks: list });
  displayGLUniversity();
}

// ─── Firestore GL Save ─────────────────────────────────────────────────────────
async function saveGLData(partial) {
  if (!authManager.isAdmin()) {
    console.error('saveGLData: not admin — write blocked');
    return;
  }
  if (partial.courses       !== undefined) glData.courses       = partial.courses;
  if (partial.readingList   !== undefined) glData.readingList   = partial.readingList;
  if (partial.externalLinks !== undefined) glData.externalLinks = partial.externalLinks;

  await db.collection('global').doc('gl_university').set({
    courses:       glData.courses,
    readingList:   glData.readingList,
    externalLinks: glData.externalLinks,
    updatedAt:     firebase.firestore.FieldValue.serverTimestamp()
  });
}

// ─── Settings ──────────────────────────────────────────────────────────────────
function injectMarketOverviewSettings() {
  if (!authManager.isAdmin()) return;
  if (document.getElementById('market-overview-settings')) return;

  const settingsContainer = document.querySelector('#settings-page .settings-container');
  if (!settingsContainer) return;

  const section = document.createElement('div');
  section.id = 'market-overview-settings';
  section.className = 'settings-section admin-panel-box';
  section.innerHTML = `
    <h3 style="color:var(--primary-color);margin-bottom:0.5rem;">Market Overview — Watchlist</h3>
    <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:1rem;">
      Comma-separated TradingView symbols. Example: NASDAQ:AAPL, NASDAQ:NVDA, CME_MINI:NQ1!
    </p>
    <input id="setting-market-symbols" class="setting-input" type="text"
           placeholder="NASDAQ:AAPL, NASDAQ:NVDA, NASDAQ:MSFT, NASDAQ:QQQ, CME_MINI:NQ1!">
  `;

  // Insert near the top of settings (after the first section if possible)
  const firstSection = settingsContainer.querySelector('.settings-section');
  if (firstSection) firstSection.insertAdjacentElement('afterend', section);
  else settingsContainer.prepend(section);

  const input = document.getElementById('setting-market-symbols');
  if (input) {
    input.value = window.userSettings.marketOverviewSymbols || getMarketOverviewSymbols().join(', ');
  }
}

function setupSettingsButtons() {
  // Inject Market Overview settings (admin only)
  injectMarketOverviewSettings();

  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const settings = {
          platformName:       document.getElementById('setting-platform-name')?.value || 'GLTRADES',
          currency:           document.getElementById('setting-currency')?.value || 'USD',
          brandColor:         document.getElementById('setting-brand-color')?.value || '#10b981',
          educationalEnabled: document.getElementById('setting-educational')?.checked || false,
          sampleData:         document.getElementById('setting-sample-data')?.checked || false,

          // Market Overview
          // Stored as a string so admins can easily edit (comma or newline separated)
          marketOverviewSymbols: (document.getElementById('setting-market-symbols')?.value || '').trim()
        };
        await db.collection('users').doc(currentUser).set({ settings }, { merge: true });

        // Keep local copy in sync
        window.userSettings = settings;
        setupMarketOverviewUI();
        if (currentPage === 'dashboard') renderMarketOverviewWidgets();

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
        trades:  window.trades,
        playbooks: window.playbooks,
        journal: window.journalEntries
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'gltrades-export.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const importBtn = document.getElementById('import-data-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const input    = document.createElement('input');
      input.type     = 'file';
      input.accept   = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          alert('Import read successfully. Full Firestore sync coming soon.');
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
        window.trades.forEach(t =>
          batch.delete(db.collection('users').doc(currentUser).collection('trades').doc(t.id))
        );
        window.playbooks.forEach(p =>
          batch.delete(db.collection('users').doc(currentUser).collection('playbooks').doc(p.id))
        );
        window.journalEntries.forEach(j =>
          batch.delete(db.collection('users').doc(currentUser).collection('journal').doc(j.id))
        );
        await batch.commit();
        window.trades         = [];
        window.playbooks      = [];
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

// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatCurrency(val) {
  if (val === null || val === undefined || isNaN(val)) return '$0.00';
  const n = parseFloat(val);
  return (n < 0 ? '-$' : '$') +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Simple HTML-escape helpers to prevent XSS in dynamic innerHTML
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(str) { return escHtml(str); }
