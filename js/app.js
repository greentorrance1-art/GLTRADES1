// ─── Global State ────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentUser = null;
let userRole = null;
let editingTradeId = null;

window.trades = [];
window.playbooks = [];
window.journalEntries = [];

// User-level settings document (users/{uid}.settings)
window.userSettings = {};

// Journal image staging (files selected before save)
let pendingJournalImages = [];

// TradingView market overview state
let currentMarketSymbol = 'NASDAQ:AAPL';

// ─── Auth Manager Compatibility Layer ────────────────────────────────────────
// Provides compatibility if auth.js is not loaded
window.authManager = window.authManager || {
  getUserId: () => currentUser,
  get userRole() { return userRole; },
  isAdmin: () => {
    const user = auth.currentUser;
    if (!user) {
      console.log('⚠️ isAdmin: No current user');
      return false;
    }
    if (typeof ADMIN_EMAIL === 'undefined') {
      console.error('❌ isAdmin: ADMIN_EMAIL is not defined');
      return false;
    }
    const result = user.email === ADMIN_EMAIL;
    console.log(`🔍 isAdmin check: "${user.email}" === "${ADMIN_EMAIL}" = ${result}`);
    return result;
  }
};

// ─── App Entry Point ──────────────────────────────────────────────────────────
window.initializeApp = async function () {
  currentUser = authManager.getUserId();
  userRole = authManager.userRole;

  // FIX: Set admin role in Firestore if user email matches ADMIN_EMAIL
  if (auth.currentUser && auth.currentUser.email === ADMIN_EMAIL) {
    console.log('🔧 Admin email detected, ensuring role is set in Firestore...');
    try {
      await db.collection('users').doc(auth.currentUser.uid).set(
        { role: 'admin' },
        { merge: true }
      );
      console.log('✅ Admin role set successfully');
      // Reload the role
      if (authManager.loadUserRole) {
        await authManager.loadUserRole();
        userRole = authManager.userRole;
        console.log('✅ UserRole reloaded:', userRole);
      }
    } catch (err) {
      console.error('❌ Error setting admin role:', err);
    }
  }

  await loadAllData();
  setupNavigation();
  setupTradeModal();
  setupPlaybookModal();
  setupJournalModal();
  setupSettingsButtons();
  setupRoleBasedUI();
  setupMarketOverviewUI();
  setupDarkMode(); // NEW: Dark mode toggle
  setupExpandModal(); // NEW: Expand modal for Market Intelligence
  updateDashboard();
  showPage('dashboard');

  // Enable GL University admin controls if admin
  if (auth.currentUser && auth.currentUser.email === ADMIN_EMAIL) {
    enableUniversityAdmin();
  }
};

// ─── Enable University Admin Controls ─────────────────────────────────────────
function enableUniversityAdmin() {
  // Admin controls are already injected by setupRoleBasedUI
  // This function ensures they're visible after auth loads
  const adminPanel = document.getElementById('admin-university-panel');
  if (adminPanel) {
    adminPanel.style.display = 'block';
  }

  // Also inject settings shortcuts
  if (currentPage === 'settings') {
    injectSettingsGLShortcut();
    injectMarketOverviewSettings();
  }
}

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
    window.trades = tradesSnap.docs.map(d => normalizeTrade({ id: d.id, ...d.data() }));
    window.playbooks = playbooksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    window.journalEntries = journalSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Pull user settings (for Market Overview watchlist, etc.)
    window.userSettings = (userDoc.exists && userDoc.data().settings) ? userDoc.data().settings : {};
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

  if (page === 'dashboard') {
    updateDashboard();
    renderMarketOverviewWidgets();
    renderMarketIntelligence(); // NEW: Market Intelligence widgets
    // Apply saved widget height
    const savedHeight = window.userSettings.widgetHeight || 700;
    applyWidgetHeight(savedHeight);
  }
  if (page === 'trades') displayTrades();
  if (page === 'reports') updateReport();
  if (page === 'playbooks') displayPlaybooks();
  if (page === 'journal') displayJournal();
  if (page === 'university') displayGLUniversity();
  if (page === 'settings') {
    console.log('📄 Settings page loaded');
    console.log('👤 Current user:', auth.currentUser);
    console.log('📧 Logged in email:', auth.currentUser ? auth.currentUser.email : 'NOT LOGGED IN');
    console.log('🔑 ADMIN_EMAIL constant:', typeof ADMIN_EMAIL !== 'undefined' ? ADMIN_EMAIL : 'UNDEFINED');
    console.log('👤 Admin check:', authManager.isAdmin());
    if (authManager.isAdmin()) {
      console.log('✅ User is admin - injecting admin controls');
      injectSettingsGLShortcut();
      injectMarketOverviewSettings();
    } else {
      console.log('❌ User is NOT admin - skipping admin controls');
    }
  }
}


// ─── Trading Engine: P&L Calculation ─────────────────────────────────────────
//
// Single source of truth for all P&L math across the application.
// Works from executions[] when present; falls back to legacy entryPrice/exitPrice.
// Handles: scaling in, scaling out, partial closes, multiple entries/exits.

const FUTURES_MULTIPLIERS = { MNQ: 2, NQ: 20, MES: 5, ES: 50, CL: 1000 };

function getFuturesMultiplier(symbol) {
  if (!symbol) return 1;
  const s = symbol.toUpperCase();
  for (const [key, val] of Object.entries(FUTURES_MULTIPLIERS)) {
    if (s.startsWith(key)) return val;
  }
  return 1;
}

/**
 * calculateTradePL(trade)
 * Returns { pl, entryPrice, exitPrice, quantity, openQuantity }
 * Commission default: $2.00/contract/side (round-trip = qty * $4.00)
 * Override per-trade via trade.commissionPerSide
 */
function calculateTradePL(trade) {
  const multiplier        = getFuturesMultiplier(trade.symbol);
  const commissionPerSide = (trade.commissionPerSide != null) ? trade.commissionPerSide : 2.00;
  const side              = (trade.side || 'long').toLowerCase();

  // -- Execution-based path --------------------------------------------------
  const execs = Array.isArray(trade.executions) && trade.executions.length > 0
    ? trade.executions : null;

  if (execs) {
    const entries = execs
      .filter(e => e.type === 'entry')
      .sort((a, b) => (a.timestamp || '') < (b.timestamp || '') ? -1 : 1);
    const exits = execs
      .filter(e => e.type === 'exit')
      .sort((a, b) => (a.timestamp || '') < (b.timestamp || '') ? -1 : 1);

    // Work on a copy so we never mutate the stored executions
    const entryQueue = entries.map(e => ({ price: e.price, qty: e.quantity || e.qty || 0 }));

    let realizedPL       = 0;
    let totalEntryQty    = 0;
    let weightedEntrySum = 0;
    let totalExitQty     = 0;
    let weightedExitSum  = 0;

    for (const exit of exits) {
      let remaining = exit.quantity || exit.qty || 0;
      totalExitQty    += remaining;
      weightedExitSum += exit.price * remaining;

      while (remaining > 0 && entryQueue.length > 0) {
        const head    = entryQueue[0];
        const matched = Math.min(head.qty, remaining);

        const rawPL = side === 'long'
          ? (exit.price - head.price) * matched * multiplier
          : (head.price - exit.price) * matched * multiplier;

        // Round-trip commission on matched qty only
        realizedPL += rawPL - (matched * commissionPerSide * 2);

        head.qty  -= matched;
        remaining -= matched;
        if (head.qty <= 0) entryQueue.shift();
      }
    }

    for (const e of entries) {
      const q = e.quantity || e.qty || 0;
      totalEntryQty    += q;
      weightedEntrySum += e.price * q;
    }

    return {
      pl:          parseFloat(realizedPL.toFixed(2)),
      entryPrice:  parseFloat((totalEntryQty > 0 ? weightedEntrySum / totalEntryQty : 0).toFixed(2)),
      exitPrice:   parseFloat((totalExitQty  > 0 ? weightedExitSum  / totalExitQty  : 0).toFixed(2)),
      quantity:    totalEntryQty,
      openQuantity: Math.max(0, totalEntryQty - totalExitQty)
    };
  }

  // -- Legacy entryPrice / exitPrice fallback --------------------------------
  const entryPrice = parseFloat(trade.entryPrice) || 0;
  const exitPrice  = parseFloat(trade.exitPrice)  || 0;
  const quantity   = parseFloat(trade.quantity)   || 0;
  const rawPL      = side === 'long'
    ? (exitPrice - entryPrice) * quantity * multiplier
    : (entryPrice - exitPrice) * quantity * multiplier;

  return {
    pl:          parseFloat((rawPL - (quantity * commissionPerSide * 2)).toFixed(2)),
    entryPrice,
    exitPrice,
    quantity,
    openQuantity: 0
  };
}

/**
 * normalizeTrade(trade)
 * Enriches any trade object (old or new) with recalculated derived fields.
 * Safe to call repeatedly — does NOT write to Firestore.
 */
function normalizeTrade(trade) {
  const calc  = calculateTradePL(trade);
  let outcome = 'breakeven';
  if (calc.pl > 0) outcome = 'win';
  else if (calc.pl < 0) outcome = 'loss';
  return {
    ...trade,
    pl:           calc.pl,
    entryPrice:   calc.entryPrice,
    exitPrice:    calc.exitPrice,
    quantity:     calc.quantity,
    openQuantity: calc.openQuantity,
    outcome
  };
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
      document.getElementById('trade-entry-time').value = t.entryTime || '';
      document.getElementById('trade-exit-time').value = t.exitTime || '';
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
    const exitPrice  = parseFloat(document.getElementById('trade-exit').value);
    const quantity   = parseFloat(document.getElementById('trade-quantity').value);
    const side       = document.getElementById('trade-side').value;
    const stopLoss   = parseFloat(document.getElementById('trade-stop').value) || null;
    const tagsRaw    = document.getElementById('trade-tags').value;
    const symbol     = document.getElementById('trade-symbol').value.toUpperCase().trim();
    const entryTime  = document.getElementById('trade-entry-time').value || null;
    const exitTime   = document.getElementById('trade-exit-time').value || null;
    const date       = document.getElementById('trade-date').value;

    // Build executions[] from the form inputs so this trade is engine-compatible.
    // entryTime/exitTime are HH:MM:SS strings; combine with date for a full timestamp.
    const entryTimestamp = entryTime ? date + 'T' + entryTime : null;
    const exitTimestamp  = exitTime  ? date + 'T' + exitTime  : null;

    const executions = [];
    if (!isNaN(entryPrice) && !isNaN(quantity)) {
      executions.push({ type: 'entry', price: entryPrice, quantity, timestamp: entryTimestamp });
    }
    if (!isNaN(exitPrice) && !isNaN(quantity)) {
      executions.push({ type: 'exit',  price: exitPrice,  quantity, timestamp: exitTimestamp });
    }

    // Run through the canonical P&L engine
    const calc     = calculateTradePL({ symbol, side, executions, commissionPerSide: 2.00 });
    const pl       = calc.pl;
    const multiplier = getFuturesMultiplier(symbol);

    // R-multiple (uses avg entry from engine)
    let rMultiple = null;
    if (stopLoss && calc.quantity > 0) {
      const risk = Math.abs(calc.entryPrice - stopLoss) * calc.quantity * multiplier;
      rMultiple = risk > 0 ? parseFloat((pl / risk).toFixed(2)) : null;
    }

    let outcome = 'breakeven';
    if (pl > 0) outcome = 'win';
    else if (pl < 0) outcome = 'loss';

    const tradeData = {
      date,
      entryTime,
      exitTime,
      symbol,
      side,
      // Keep legacy scalar fields for backward compat with older Firestore docs
      quantity:   calc.quantity,
      entryPrice: calc.entryPrice,
      exitPrice:  calc.exitPrice,
      stopLoss,
      pl,
      rMultiple,
      outcome,
      executions,   // execution array — drives all future P&L recalculations
      strategy: document.getElementById('trade-strategy').value,
      tags:     tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
      notes:    document.getElementById('trade-notes').value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const userTradesRef = db.collection('users').doc(currentUser).collection('trades');

    if (editingTradeId) {
      await userTradesRef.doc(editingTradeId).update(tradeData);
      const idx = window.trades.findIndex(t => t.id === editingTradeId);
      if (idx !== -1) window.trades[idx] = normalizeTrade({ id: editingTradeId, ...tradeData });
    } else {
      tradeData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const docRef = await userTradesRef.add(tradeData);
      window.trades.unshift(normalizeTrade({ id: docRef.id, ...tradeData }));
    }

    closeTradeModal();

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
      <td>${t.date || ''}${t.entryTime ? ' ' + t.entryTime : ''}</td>
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
      <td>
        <div>${t.date || ''}</div>
        ${t.entryTime || t.exitTime ? `<div style="font-size: 0.85em; color: var(--text-secondary);">Entry: ${t.entryTime || '—'} | Exit: ${t.exitTime || '—'}</div>` : ''}
      </td>
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
  if (symbols.length) currentMarketSymbol = symbols[0];

  // Symbol tabs removed - chart now uses allow_symbol_change: true for inline symbol selection
}

function getMarketOverviewSymbols() {
  // Stored as comma-separated string in user settings (admin can set their defaults)
  const raw = (window.userSettings && window.userSettings.marketOverviewSymbols) ? window.userSettings.marketOverviewSymbols : '';
  const parsed = raw
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Sensible defaults (heavy hitters + broad index + futures)
  return parsed.length ? parsed : [
    'NASDAQ:AAPL',
    'NASDAQ:NVDA',
    'NASDAQ:MSFT',
    'NASDAQ:AMZN',
    'NASDAQ:TSLA',
    'NASDAQ:QQQ',
    'SP:SPX',
    'DJ:DJI',
    'CME_MINI:NQ1!',
    'CME_MINI:ES1!'
  ];
}

function injectTradingViewWidget(containerId, scriptSrc, configObj) {
  const el = document.getElementById(containerId);
  if (!el) return;

  // Clear everything to prevent duplicates
  el.innerHTML = '';

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = scriptSrc;
  script.innerHTML = JSON.stringify(configObj);
  el.appendChild(script);

  // Only add resize handle to chart and heatmap widgets (not ticker tape)
  if (containerId === 'tv-advanced-chart' || containerId === 'tv-heatmap') {
    const handle = document.createElement('div');
    handle.className = 'widget-resize-handle';
    handle.setAttribute('data-widget', containerId);
    handle.textContent = '⋮⋮';
    el.appendChild(handle);
  }
}

function renderMarketOverviewWidgets() {
  // Only render if dashboard containers exist
  const chartEl = document.getElementById('tv-advanced-chart');
  const heatEl  = document.getElementById('tv-heatmap');
  if (!chartEl || !heatEl) return;

  // Ticker Tape (Investopedia-style)
  const tickerEl = document.getElementById('tv-ticker-tape');
  if (tickerEl) {
    injectTradingViewWidget('tv-ticker-tape',
      'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js',
      {
        symbols: [
          { proName: "NASDAQ:QQQ", title: "QQQ" },
          { proName: "AMEX:SPY", title: "SPY" },
          { proName: "NASDAQ:NVDA", title: "NVDA" },
          { proName: "NASDAQ:AAPL", title: "AAPL" },
          { proName: "CME_MINI:MNQ1!", title: "MNQ1!" },
          { proName: "COMEX:GC1!", title: "GC1!" },
          { proName: "FX:EURUSD", title: "EURUSD" }
        ],
        showSymbolLogo: true,
        colorTheme: "dark",
        isTransparent: false,
        displayMode: "adaptive",
        locale: "en"
      }
    );
  }

  // Advanced Chart: full toolbar (candles, Heikin Ashi, indicators, intervals)
  injectTradingViewWidget('tv-advanced-chart',
    'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
    {
      width: "100%",
      height: "700",
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
      width: "100%",
      height: "700",
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

  // Setup resize handles after widgets are injected
  setTimeout(() => {
    setupWidgetResizeHandles();
  }, 100);
}

// ─── Widget Resize Handles ────────────────────────────────────────────────────
function setupWidgetResizeHandles() {
  const handles = document.querySelectorAll('.widget-resize-handle');

  handles.forEach(handle => {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    let widget = null;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      startY = e.clientY;

      const widgetId = handle.getAttribute('data-widget');
      widget = document.getElementById(widgetId);
      startHeight = widget.offsetHeight;

      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing || !widget) return;

      const deltaY = e.clientY - startY;
      const newHeight = Math.max(400, Math.min(1200, startHeight + deltaY));

      widget.style.height = newHeight + 'px';
      widget.style.minHeight = newHeight + 'px';

      // Update display text on handle
      handle.setAttribute('title', `${newHeight}px`);
    });

    document.addEventListener('mouseup', () => {
      if (isResizing && widget) {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Save the new height
        const finalHeight = widget.offsetHeight;
        if (window.userSettings) {
          window.userSettings.widgetHeight = finalHeight;
          // Optionally save to Firestore
          if (currentUser) {
            db.collection('users').doc(currentUser).set(
              { settings: { widgetHeight: finalHeight } },
              { merge: true }
            ).catch(err => console.error('Error saving widget height:', err));
          }
        }

        widget = null;
      }
    });
  });
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
      maintainAspectRatio: false,
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
    editingJournalId = null;
    document.getElementById('journal-form').reset();
    document.getElementById('journal-date').value = new Date().toISOString().split('T')[0];
    pendingJournalImages = [];
    renderJournalImagePreview();
    document.getElementById('journal-modal').classList.add('active');
  });
  document.getElementById('close-journal-modal').addEventListener('click', () => {
    editingJournalId = null;
    document.getElementById('journal-modal').classList.remove('active');
  });
  document.getElementById('cancel-journal-btn').addEventListener('click', () => {
    editingJournalId = null;
    document.getElementById('journal-modal').classList.remove('active');
  });
  document.getElementById('journal-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('journal-modal')) {
      editingJournalId = null;
      document.getElementById('journal-modal').classList.remove('active');
    }
  });
  document.getElementById('journal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveJournalEntry();
  });

  setupJournalImageUploader();
}

function setupJournalImageUploader() {
  const dropzone = document.getElementById('journal-dropzone');
  const input = document.getElementById('journal-images');
  if (!dropzone || !input) return;

  // Click to open file picker
  dropzone.addEventListener('click', () => input.click());

  // File picker
  input.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])].filter(f => f.type.startsWith('image/'));
    pendingJournalImages = pendingJournalImages.concat(files);
    renderJournalImagePreview();
    input.value = '';
  });

  // Drag & drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
    pendingJournalImages = pendingJournalImages.concat(files);
    renderJournalImagePreview();
  });
}

function renderJournalImagePreview() {
  const preview = document.getElementById('journal-image-preview');
  if (!preview) return;
  if (!pendingJournalImages.length) {
    preview.innerHTML = '';
    return;
  }
  preview.innerHTML = pendingJournalImages.map((file, idx) => {
    const url = URL.createObjectURL(file);
    return `<img class="thumb" src="${url}" alt="upload-${idx}" />`;
  }).join('');
}

async function uploadJournalImages(files) {
  console.log('📤 Starting upload for', files.length, 'images');
  const uploads = [];

  for (const file of files) {
    console.log('📁 Uploading file:', file.name, 'Size:', file.size, 'bytes');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `users/${currentUser}/journal/${Date.now()}_${safeName}`;
    console.log('📍 Upload path:', path);

    const ref = storage.ref(path);
    const uploadTask = ref.put(file);

    uploads.push(
      uploadTask
        .then(snapshot => {
          console.log('✅ Upload complete:', snapshot.ref.fullPath);
          return snapshot.ref.getDownloadURL();
        })
        .then(url => {
          console.log('🔗 Got download URL:', url);
          return url;
        })
        .catch(err => {
          console.error('❌ Upload failed for', file.name, ':', err);
          throw err;
        })
    );
  }

  const urls = await Promise.all(uploads);
  console.log('✅ All uploads complete. URLs:', urls);
  return urls;
}

let editingJournalId = null;

async function saveJournalEntry() {
  const submitBtn = document.querySelector('#journal-form button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  console.log('💾 Starting journal save...');
  console.log('📊 Pending images:', pendingJournalImages.length);

  try {
    const data = {
      date: document.getElementById('journal-date').value,
      title: document.getElementById('journal-title').value.trim(),
      entry: document.getElementById('journal-entry').value.trim(),
      mood: document.getElementById('journal-mood').value,
      images: []
    };

    console.log('📝 Journal data prepared:', data);

    let imageUrls = [];
    if (pendingJournalImages.length > 0) {
      console.log('📤 Uploading', pendingJournalImages.length, 'images...');
      try {
        imageUrls = await uploadJournalImages(pendingJournalImages);
        console.log('✅ Images uploaded successfully:', imageUrls);
      } catch (uploadErr) {
        console.error('❌ Image upload failed:', uploadErr);
        alert(`Image upload failed: ${uploadErr.message}\n\nCheck Firebase Storage permissions.`);
        return;
      }
    }

    // If editing, keep existing images and add new ones
    if (editingJournalId) {
      const existingEntry = window.journalEntries.find(j => j.id === editingJournalId);
      const existingImages = existingEntry?.images || [];
      data.images = [...existingImages, ...imageUrls];
    } else {
      data.images = imageUrls;
    }

    console.log('💾 Saving to Firestore...');

    if (editingJournalId) {
      // Update existing entry
      await db.collection('users').doc(currentUser).collection('journal').doc(editingJournalId).update(data);
      console.log('✅ Updated Firestore entry:', editingJournalId);

      // Update in local array
      const idx = window.journalEntries.findIndex(j => j.id === editingJournalId);
      if (idx !== -1) {
        window.journalEntries[idx] = { id: editingJournalId, ...data };
      }
      editingJournalId = null;
    } else {
      // Create new entry
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      const docRef = await db.collection('users').doc(currentUser).collection('journal').add(data);
      console.log('✅ Saved to Firestore with ID:', docRef.id);
      window.journalEntries.unshift({ id: docRef.id, ...data });
    }

    pendingJournalImages = [];
    renderJournalImagePreview();
    document.getElementById('journal-modal').classList.remove('active');
    displayJournal();
    console.log('✅ Journal entry saved successfully!');
  } catch (err) {
    console.error('❌ Error saving journal entry:', err);
    console.error('Error details:', err.code, err.message, err.stack);
    alert(`Error saving journal entry:\n\n${err.message}\n\nCheck console for details.`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Entry';
  }
}

function editJournalEntry(id) {
  const entry = window.journalEntries.find(j => j.id === id);
  if (!entry) return;

  // Set editing mode
  editingJournalId = id;

  // Populate form
  document.getElementById('journal-date').value = entry.date || '';
  document.getElementById('journal-title').value = entry.title || '';
  document.getElementById('journal-entry').value = entry.entry || '';
  document.getElementById('journal-mood').value = entry.mood || 'neutral';

  // Clear pending images (existing images are preserved in saveJournalEntry)
  pendingJournalImages = [];
  renderJournalImagePreview();

  // Open modal
  document.getElementById('journal-modal').classList.add('active');
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
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn action-btn" style="background: #3b82f6;" onclick="editJournalEntry('${j.id}')">Edit</button>
          <button class="btn btn-danger action-btn" onclick="deleteJournalEntry('${j.id}')">Delete</button>
        </div>
      </div>
      <div class="journal-content">${j.entry || ''}</div>
      ${(j.images && j.images.length) ? `
        <div class="journal-images">
          ${j.images.map(url => `<a href="${escAttr(url)}" target="_blank" rel="noopener"><img src="${escAttr(url)}" alt="journal-image" /></a>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
}

// ─── GL University ─────────────────────────────────────────────────────────────
// ── These are the hardcoded defaults shown until admin saves custom content ──
const DEFAULT_COURSES = [
  { icon: '📊', title: 'Risk Management Fundamentals',  description: 'Learn the essential principles of position sizing, stop losses, and portfolio risk management.', lessons: '8 Lessons',  level: 'Beginner',     url: '' },
  { icon: '📈', title: 'Technical Analysis Mastery',    description: 'Master chart patterns, indicators, and price action trading strategies.',                          lessons: '12 Lessons', level: 'Intermediate', url: '' },
  { icon: '🧠', title: 'Trading Psychology',            description: 'Develop mental discipline, emotional control, and winning trading habits.',                         lessons: '10 Lessons', level: 'All Levels',   url: '' },
  { icon: '💰', title: 'Options Trading Strategies',    description: 'Understand options mechanics, spreads, and advanced trading strategies.',                           lessons: '15 Lessons', level: 'Advanced',     url: '' },
  { icon: '🎯', title: 'Building Trading Systems',      description: 'Create, backtest, and optimize profitable trading systems and strategies.',                         lessons: '10 Lessons', level: 'Advanced',     url: '' },
  { icon: '📉', title: 'Market Analysis & Research',   description: 'Develop skills in fundamental analysis, market research, and trade idea generation.',               lessons: '9 Lessons',  level: 'Intermediate', url: '' }
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
        <button class="btn btn-outline" onclick="openCourseURL('${escAttr(c.url || '')}')">Start Learning</button>
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
    const usingDefaults = !glData.readingList.length;
    readingEl.innerHTML = list.map((item, idx) => `
      <li class="gl-resource-row">
        <span>${escHtml(item.title)}${item.author ? ' — ' + escHtml(item.author) : ''}</span>
        ${isAdmin && !usingDefaults ? `
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
    const usingDefaults = !glData.externalLinks.length;
    linksEl.innerHTML = list.map((item, idx) => `
      <li class="gl-resource-row">
        <a href="${escAttr(item.url)}" target="_blank" rel="noopener">${escHtml(item.title)}</a>
        ${isAdmin && !usingDefaults ? `
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
  console.log('🔧 injectSettingsGLShortcut called');

  if (document.getElementById('settings-gl-shortcut')) {
    console.log('⚠️ Settings GL shortcut already exists, skipping');
    return;
  }

  const settingsContainer = document.querySelector('#settings-page .settings-container');
  if (!settingsContainer) {
    console.error('❌ Settings container not found');
    return;
  }

  console.log('✅ Creating admin controls section...');
  const section = document.createElement('div');
  section.id = 'settings-gl-shortcut';
  section.className = 'settings-section admin-panel-box';
  section.innerHTML = `
    <h3 style="color:var(--primary-color);margin-bottom:1.5rem;">Admin — GL University Controls</h3>
    <div style="display:flex;gap:1rem;flex-wrap:wrap;">
      <button class="btn btn-primary"   onclick="openAddCourseModal()">+ Add Course</button>
      <button class="btn btn-secondary" onclick="openAddReadingModal()">+ Add Reading</button>
      <button class="btn btn-secondary" onclick="openAddLinkModal()">+ Add Link</button>
    </div>
    <p style="margin-top:1rem;font-size:0.85rem;color:var(--text-secondary);">
      Edit and Delete buttons appear on each item below when custom content has been saved. Adding a new item for the first time will copy the defaults into Firestore automatically.
    </p>
  `;
  settingsContainer.appendChild(section);
  console.log('✅ Admin controls section added to Settings page');
}

// Quick access function for editing resources from settings
function quickEditResources() {
  showPage('university');
  // Scroll to resources section
  setTimeout(() => {
    const resourcesSection = document.querySelector('#university-page .section');
    if (resourcesSection) {
      resourcesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 100);
}

// ─── Admin: Course CRUD ────────────────────────────────────────────────────────
function openAddCourseModal() {
  if (!authManager.isAdmin()) return;
  const icons = ['📊','📈','🧠','💰','🎯','📉','📚','🔗','⚡','🎓'];
  _openCourseModal({
    title: 'Add Course',
    course: { icon: '📊', title: '', description: '', lessons: '', level: 'Beginner', url: '' },
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
        <div class="form-group" style="margin-top:1rem;">
          <label>Start Learning URL</label>
          <input type="url" id="gc-url" class="setting-input"
                 placeholder="https://example.com/course"
                 value="${escAttr(course.url || '')}">
          <small style="display:block;margin-top:0.5rem;color:var(--text-secondary);">When users click "Start Learning", this URL will open in a new tab</small>
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
        level:       document.getElementById('gc-level').value,
        url:         document.getElementById('gc-url').value.trim()
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

// Open course URL when Start Learning is clicked
function openCourseURL(url) {
  if (!url || url.trim() === '') {
    alert('This course does not have a learning URL configured yet. Please contact the administrator.');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
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
      const updated = [...glData.readingList];
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
  const list = [...glData.readingList];
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
      const updated = [...glData.externalLinks];
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
  const list = [...glData.externalLinks];
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

// ─── Widget Size Controls ─────────────────────────────────────────────────────
function injectWidgetSizeControls() {
  if (document.getElementById('widget-size-controls')) return;

  const settingsContainer = document.querySelector('#settings-page .settings-container');
  if (!settingsContainer) return;

  const section = document.createElement('div');
  section.id = 'widget-size-controls';
  section.className = 'settings-section';
  section.innerHTML = `
    <h3>TradingView Widget Size</h3>
    <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:1rem;">
      Adjust the height of your TradingView chart and heatmap widgets. Changes apply immediately.
    </p>
    <div style="margin-bottom:1.5rem;">
      <label style="display:block;margin-bottom:0.5rem;font-weight:500;">Widget Height: <span id="widget-height-value">700</span>px</label>
      <input type="range" id="widget-height-slider" class="widget-size-slider"
             min="400" max="1000" step="50" value="700"
             style="width:100%;height:8px;background:#e5e7eb;border-radius:5px;outline:none;cursor:pointer;">
      <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-secondary);margin-top:0.25rem;">
        <span>400px (Compact)</span>
        <span>1000px (Full Height)</span>
      </div>
    </div>
    <p style="font-size:0.85rem;color:var(--text-secondary);">
      💡 Tip: Increase height to see more details in the heatmap and chart. Changes are saved automatically when you click "Save Settings" below.
    </p>
  `;

  const firstSection = settingsContainer.querySelector('.settings-section');
  if (firstSection) firstSection.insertAdjacentElement('afterend', section);
  else settingsContainer.prepend(section);

  // Setup slider
  const slider = document.getElementById('widget-height-slider');
  const valueDisplay = document.getElementById('widget-height-value');

  // Load saved value
  const savedHeight = window.userSettings.widgetHeight || 700;
  slider.value = savedHeight;
  valueDisplay.textContent = savedHeight;
  applyWidgetHeight(savedHeight);

  // Real-time preview as you drag
  slider.addEventListener('input', (e) => {
    const height = e.target.value;
    valueDisplay.textContent = height;
    applyWidgetHeight(height);
  });
}

function applyWidgetHeight(height) {
  const widgets = document.querySelectorAll('.tv-widget');
  widgets.forEach(widget => {
    widget.style.height = height + 'px';
    widget.style.minHeight = height + 'px';
  });

  const heatmap = document.getElementById('tv-heatmap');
  if (heatmap) {
    heatmap.style.height = height + 'px';
  }
}

// ─── CSV Import Helpers ────────────────────────────────────────────────────────

function _csvParseTime(timeStr) {
  if (!timeStr) return null;
  try {
    const parts = timeStr.trim().split(' ');
    if (parts.length !== 2) return null;
    const dateParts = parts[0].split('/');
    const timeParts = parts[1].split(':');
    if (dateParts.length !== 3 || timeParts.length !== 3) return null;
    return `${dateParts[2]}-${dateParts[0].padStart(2,'0')}-${dateParts[1].padStart(2,'0')}T${timeParts[0].padStart(2,'0')}:${timeParts[1].padStart(2,'0')}:${timeParts[2].padStart(2,'0')}`;
  } catch { return null; }
}

function _csvFuturesMultiplier(symbol) {
  // Delegates to the canonical engine function
  return getFuturesMultiplier(symbol) || 2;
}

function _csvBuildTradeObject(symbol, side, entryPrice, exitPrice, qty, entryISO, exitISO, executions) {
  // Build canonical executions array if caller didn't provide one
  const execs = (executions && executions.length > 0) ? executions : [
    { type: 'entry', price: entryPrice, quantity: qty, timestamp: entryISO },
    { type: 'exit',  price: exitPrice,  quantity: qty, timestamp: exitISO  }
  ];

  // Run through the canonical engine — single source of truth for all P&L math
  const draft = { symbol, side, executions: execs, commissionPerSide: 2.00 };
  const calc  = calculateTradePL(draft);
  const pl    = calc.pl;
  const commission = qty * 2.00 * 2; // for notes display only

  const date      = entryISO ? entryISO.split('T')[0] : new Date().toISOString().split('T')[0];
  const entryTime = entryISO ? entryISO.split('T')[1] : null;
  const exitTime  = exitISO  ? exitISO.split('T')[1]  : null;

  let outcome = 'breakeven';
  if (pl > 0) outcome = 'win';
  else if (pl < 0) outcome = 'loss';

  return {
    date,
    entryTime,
    exitTime,
    symbol,
    side,
    quantity:   calc.quantity,
    entryPrice: calc.entryPrice,
    exitPrice:  calc.exitPrice,
    stopLoss:   null,
    pl,
    rMultiple:  null,
    outcome,
    executions: execs,
    strategy:   'CSV Import',
    tags:       ['imported'],
    notes:      `Imported from Tradovate CSV ($${commission.toFixed(2)} commission) on ${new Date().toISOString().split('T')[0]}`
  };
}

// ─── Main Import Function ──────────────────────────────────────────────────────

async function importTradesFromCSV(csvText) {
  try {
    // Parse CSV
    const lines = csvText.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    if (lines.length < 2) {
      alert('CSV file is empty or invalid.');
      return;
    }

    // Parse header row to find column indices (exact match for Tradovate format)
    const header = lines[0].split(',').map(h => h.trim());

    const symbolIdx    = header.indexOf('symbol');
    const qtyIdx       = header.indexOf('qty');
    const buyPriceIdx  = header.indexOf('buyPrice');
    const sellPriceIdx = header.indexOf('sellPrice');
    const buyTimeIdx   = header.indexOf('boughtTimestamp');
    const sellTimeIdx  = header.indexOf('soldTimestamp');

    // Validate required columns
    if (symbolIdx === -1 || qtyIdx === -1 || buyPriceIdx === -1 || sellPriceIdx === -1) {
      alert('CSV file is missing required columns.\n\nExpected: symbol, qty, buyPrice, sellPrice, boughtTimestamp, soldTimestamp');
      return;
    }

    // ── Step 1: Parse all raw execution rows ──────────────────────────────────
    const rawRows = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map(cell => cell.trim());
      if (row.length < header.length) {
        console.warn(`CSV row ${i + 1}: insufficient columns, skipping`);
        continue;
      }
      try {
        const symbol          = row[symbolIdx];
        const qty             = parseFloat(row[qtyIdx]);
        const buyPrice        = parseFloat(row[buyPriceIdx]);
        const sellPrice       = parseFloat(row[sellPriceIdx]);
        const boughtTimestamp = buyTimeIdx  >= 0 ? row[buyTimeIdx]  : null;
        const soldTimestamp   = sellTimeIdx >= 0 ? row[sellTimeIdx] : null;

        if (!symbol || isNaN(qty) || qty <= 0) {
          console.warn(`CSV row ${i + 1}: invalid symbol or qty, skipping`);
          continue;
        }

        const hasBuy  = !isNaN(buyPrice)  && buyPrice  > 0;
        const hasSell = !isNaN(sellPrice) && sellPrice > 0;

        rawRows.push({ symbol, qty, buyPrice, sellPrice, boughtTimestamp, soldTimestamp, hasBuy, hasSell, rowNum: i + 1 });
      } catch (err) {
        console.error(`CSV row ${i + 1}: parse error`, err);
      }
    }

    // ── Step 2: Execution-level trade pairing ─────────────────────────────────
    //
    // Rule: 1 BUY + 1 SELL = 1 trade. No FIFO. No position merging.
    //
    // Tradovate rows come in two shapes:
    //   A) Both buyPrice + sellPrice present  → self-contained long round-trip
    //   B) Only buyPrice present              → pending long entry
    //   C) Only sellPrice present             → closes most-recent pending long entry
    //
    // Reversal detection: if a pending entry exists and we see another buy-only
    // row before the first is closed, treat prior pending as a standalone entry
    // warning (data gap) and start fresh — prevents silent merging.

    const completedTrades = []; // raw trade objects before saving
    // pendingEntries: stack keyed by symbol, each item = { price, qty, entryISO, executions[] }
    const pendingBySymbol = {};

    for (const row of rawRows) {
      const { symbol, qty, buyPrice, sellPrice, boughtTimestamp, soldTimestamp, hasBuy, hasSell, rowNum } = row;

      if (!pendingBySymbol[symbol]) pendingBySymbol[symbol] = [];
      const pending = pendingBySymbol[symbol];

      // ── Shape A: self-contained round-trip (buyPrice + sellPrice both present)
      if (hasBuy && hasSell) {
        const entryISO = _csvParseTime(boughtTimestamp);
        const exitISO  = _csvParseTime(soldTimestamp);
        const executions = [
          { price: buyPrice,  qty, timestamp: entryISO, type: 'entry' },
          { price: sellPrice, qty, timestamp: exitISO,  type: 'exit'  }
        ];
        completedTrades.push(
          _csvBuildTradeObject(symbol, 'long', buyPrice, sellPrice, qty, entryISO, exitISO, executions)
        );
        continue;
      }

      // ── Shape B: buy-only → store as pending entry
      if (hasBuy && !hasSell) {
        const entryISO = _csvParseTime(boughtTimestamp);
        pending.push({
          price:      buyPrice,
          qty,
          entryISO,
          executions: [{ price: buyPrice, qty, timestamp: entryISO, type: 'entry' }]
        });
        continue;
      }

      // ── Shape C: sell-only → pair with most-recent pending entry (local match)
      if (hasSell && !hasBuy) {
        const exitISO = _csvParseTime(soldTimestamp);

        if (pending.length === 0) {
          // No pending entry — treat as short entry awaiting a buy-to-close.
          // Store as pending short so it can pair with the next buy-only row.
          console.warn(`CSV row ${rowNum}: sell-only with no pending entry for ${symbol} — storing as pending short`);
          pending.push({
            price:      sellPrice,
            qty,
            entryISO:   exitISO, // for a short, "entry" is the sell timestamp
            side:       'short',
            executions: [{ price: sellPrice, qty, timestamp: exitISO, type: 'entry' }]
          });
          continue;
        }

        // Match against the most-recent pending entry (local pairing, not global FIFO)
        const entry = pending.pop();

        if (entry.side === 'short') {
          // Closing a short: entry was a sell, exit is a buy
          const executions = [
            ...entry.executions,
            { price: sellPrice, qty, timestamp: exitISO, type: 'exit' }
          ];
          completedTrades.push(
            _csvBuildTradeObject(symbol, 'short', entry.price, sellPrice, Math.min(entry.qty, qty), entry.entryISO, exitISO, executions)
          );
        } else {
          // Closing a long: entry was a buy, exit is this sell
          const executions = [
            ...entry.executions,
            { price: sellPrice, qty, timestamp: exitISO, type: 'exit' }
          ];
          completedTrades.push(
            _csvBuildTradeObject(symbol, 'long', entry.price, sellPrice, Math.min(entry.qty, qty), entry.entryISO, exitISO, executions)
          );
        }

        // If partial fill: entry had more qty than exit, push remainder back
        const remainder = entry.qty - qty;
        if (remainder > 0) {
          pending.push({
            price:      entry.price,
            qty:        remainder,
            entryISO:   entry.entryISO,
            side:       entry.side,
            executions: entry.executions
          });
        }
        continue;
      }

      console.warn(`CSV row ${rowNum}: row has neither buyPrice nor sellPrice, skipping`);
    }

    // Warn about any unclosed pending entries (open positions / data gap)
    for (const [symbol, pending] of Object.entries(pendingBySymbol)) {
      for (const p of pending) {
        console.warn(`CSV import: unclosed ${p.side || 'long'} entry for ${symbol} at ${p.entryISO} (qty ${p.qty}) — no matching exit found`);
      }
    }

    // ── Step 3: Deduplicate and save ─────────────────────────────────────────
    let imported = 0;
    let skipped  = 0;
    let errors   = 0;

    for (const t of completedTrades) {
      await new Promise(resolve => setTimeout(resolve, 0)); // yield to UI thread

      try {
        // Duplicate check: all key fields must match
        const isDuplicate = window.trades.some(existing =>
          existing.symbol     === t.symbol     &&
          existing.entryPrice === t.entryPrice &&
          existing.exitPrice  === t.exitPrice  &&
          existing.quantity   === t.quantity   &&
          existing.date       === t.date       &&
          existing.entryTime  === t.entryTime  &&
          existing.exitTime   === t.exitTime
        );

        if (isDuplicate) {
          console.log(`Skipping duplicate: ${t.symbol} ${t.date} entry=${t.entryPrice} exit=${t.exitPrice}`);
          skipped++;
          continue;
        }

        const tradeData = { ...t, createdAt: firebase.firestore.FieldValue.serverTimestamp() };

        const docRef = await db.collection('users').doc(currentUser).collection('trades').add(tradeData);
        window.trades.unshift({ id: docRef.id, ...tradeData });
        imported++;

      } catch (err) {
        console.error('Error saving trade:', err);
        errors++;
      }
    }

    // Update UI
    updateDashboard();
    displayTrades();

    alert(`Import Complete\n\nImported: ${imported} trades\nSkipped (duplicates): ${skipped}\nErrors: ${errors}`);

  } catch (err) {
    console.error('CSV import error:', err);
    alert('Failed to import CSV. Please check the console for details.');
  }
}

function setupSettingsButtons() {
  // Inject widget size controls
  injectWidgetSizeControls();

  // Inject Market Overview settings (admin only)
  injectMarketOverviewSettings();

  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const settings = {
          platformName:       document.getElementById('setting-platform-name').value,
          currency:           document.getElementById('setting-currency').value,
          brandColor:         document.getElementById('setting-brand-color').value,
          educationalEnabled: document.getElementById('setting-educational').checked,
          sampleData:         document.getElementById('setting-sample-data').checked,
          // Market overview watchlist (comma-separated TradingView symbols)
          marketOverviewSymbols: document.getElementById('setting-market-symbols')
            ? document.getElementById('setting-market-symbols').value
            : (window.userSettings.marketOverviewSymbols || ''),
          // Widget height control
          widgetHeight: document.getElementById('widget-height-slider')
            ? parseInt(document.getElementById('widget-height-slider').value)
            : (window.userSettings.widgetHeight || 700)
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

  const importCsvBtn = document.getElementById('import-csv-trades-btn');
  if (importCsvBtn) {
    importCsvBtn.addEventListener('click', () => {
      const input = document.getElementById('csv-file-input');
      if (input) {
        input.value = '';
        input.click();
      }
    });
  }

  const csvFileInput = document.getElementById('csv-file-input');
  if (csvFileInput) {
    csvFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        await importTradesFromCSV(text);
      } catch (err) {
        console.error('Error reading CSV file:', err);
        alert('Failed to read CSV file. Please check the file format.');
      }
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

  // ── FIX 1: Reset Trades Only ───────────────────────────────────────────────
  const resetTradesBtn = document.getElementById('reset-trades-btn');
  if (resetTradesBtn) {
    resetTradesBtn.addEventListener('click', async () => {
      if (!confirm('Delete ALL trades? This cannot be undone.')) return;
      try {
        const tradesRef = db.collection('users').doc(currentUser).collection('trades');
        const snapshot  = await tradesRef.get();
        const batch     = db.batch();
        snapshot.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        window.trades = [];
        if (typeof updateDashboard === 'function') updateDashboard();
        if (typeof displayTrades   === 'function') displayTrades();
        alert('All trades deleted.');
      } catch (err) {
        console.error('Reset trades error:', err);
        alert('Error deleting trades.');
      }
    });
  }
}

// ─── Account Overview ─────────────────────────────────────────────────────────

async function loadAccountData() {
  if (!currentUser) return;
  try {
    // Stored as an array on the user doc (no subcollection — avoids security rule issues)
    const userDoc = await db.collection('users').doc(currentUser).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const logs    = Array.isArray(userData.accountLogs) ? userData.accountLogs : [];
    const balance = userData.currentBalance != null ? userData.currentBalance : 0;

    let deposits    = 0;
    let withdrawals = 0;
    logs.forEach(entry => {
      if (entry.type === 'deposit')    deposits    += entry.amount;
      if (entry.type === 'withdrawal') withdrawals += entry.amount;
    });

    const realPnL = balance - deposits + withdrawals;

    const el = id => document.getElementById(id);
    if (el('total-deposits'))    el('total-deposits').textContent    = deposits.toFixed(2);
    if (el('total-withdrawals')) el('total-withdrawals').textContent = withdrawals.toFixed(2);
    if (el('current-balance'))   el('current-balance').textContent   = balance.toFixed(2);
    if (el('real-pnl'))          el('real-pnl').textContent          = realPnL.toFixed(2);

  } catch (err) {
    console.error('Account load error:', err);
  }
}

function setupAccountOverview() {
  let currentAction = null;

  // Match exact IDs in index.html
  const accountModal    = document.getElementById('account-modal');
  const modalTitle      = document.getElementById('account-modal-title');
  const modalAmount     = document.getElementById('modal-amount');
  const modalDate       = document.getElementById('modal-date');
  const modalTime       = document.getElementById('modal-time');
  const modalSaveBtn    = document.getElementById('modal-save-btn');
  const modalCloseBtn   = document.getElementById('modal-close-btn');

  const historyModal    = document.getElementById('history-modal');
  const historyList     = document.getElementById('history-list');
  const historyCloseBtn = document.getElementById('history-close-btn');

  const depositBtn  = document.getElementById('add-deposit-btn');
  const withdrawBtn = document.getElementById('add-withdraw-btn');
  const balanceBtn  = document.getElementById('set-balance-btn');
  const historyBtn  = document.getElementById('view-history-btn');

  function openAccountModal(type) {
    currentAction = type;
    if (modalAmount) modalAmount.value = '';
    if (modalDate)   modalDate.value   = '';
    if (modalTime)   modalTime.value   = '';
    if (modalTitle) {
      if (type === 'deposit')    modalTitle.textContent = 'Add Deposit';
      if (type === 'withdrawal') modalTitle.textContent = 'Add Withdrawal';
      if (type === 'balance')    modalTitle.textContent = 'Update Balance';
    }
    if (accountModal) accountModal.style.display = 'flex';
  }

  function closeAccountModal() {
    if (accountModal) accountModal.style.display = 'none';
  }

  if (depositBtn)    depositBtn.addEventListener('click',  () => openAccountModal('deposit'));
  if (withdrawBtn)   withdrawBtn.addEventListener('click', () => openAccountModal('withdrawal'));
  if (balanceBtn)    balanceBtn.addEventListener('click',  () => openAccountModal('balance'));
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeAccountModal);

  if (modalSaveBtn) {
    modalSaveBtn.addEventListener('click', async () => {
      const amount = parseFloat(modalAmount ? modalAmount.value : '');
      const date   = modalDate ? modalDate.value : '';
      const time   = modalTime ? modalTime.value : '';

      if (isNaN(amount) || amount <= 0) {
        alert('Please enter a valid amount.');
        return;
      }

      // Build a Firestore-safe timestamp.
      // date is YYYY-MM-DD, time is HH:MM (24-hour from <input type="time">).
      // Append seconds so Date parsing is unambiguous across all browsers.
      let firestoreTimestamp = firebase.firestore.FieldValue.serverTimestamp();
      let dateLabel = date || new Date().toISOString().split('T')[0];

      if (date && time) {
        const jsDate = new Date(`${date}T${time}:00`);
        if (!isNaN(jsDate.getTime())) {
          firestoreTimestamp = firebase.firestore.Timestamp.fromDate(jsDate);
          dateLabel = jsDate.toLocaleString();
        }
      }

      try {
        if (currentAction === 'balance') {
          await db.collection('users').doc(currentUser).set(
            { currentBalance: amount }, { merge: true }
          );
        } else {
          // Append to accountLogs array on the user doc.
          // Uses FieldValue.arrayUnion so concurrent writes are safe.
          const logEntry = {
            type:      currentAction,
            amount,
            dateLabel,
            // Store ISO string — avoids Timestamp serialization issues inside arrays
            isoDate:   date && time ? `${date}T${time}:00` : new Date().toISOString()
          };
          await db.collection('users').doc(currentUser).set(
            { accountLogs: firebase.firestore.FieldValue.arrayUnion(logEntry) },
            { merge: true }
          );
        }
        closeAccountModal();
        loadAccountData();
      } catch (err) {
        console.error('Account save error:', err);
        alert('Error saving data. Check console for details.');
      }
    });
  }

  if (historyBtn) {
    historyBtn.addEventListener('click', async () => {
      if (historyModal) historyModal.style.display = 'flex';
      if (historyList)  historyList.innerHTML = '<em style="color:var(--text-secondary)">Loading...</em>';

      try {
        const userDoc  = await db.collection('users').doc(currentUser).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const logs     = Array.isArray(userData.accountLogs) ? userData.accountLogs : [];

        if (!historyList) return;
        historyList.innerHTML = '';

        if (logs.length === 0) {
          historyList.innerHTML = '<em style="color:var(--text-secondary)">No history yet.</em>';
          return;
        }

        // Sort newest first
        const sorted = [...logs].sort((a, b) => {
          const ta = a.isoDate || a.dateLabel || '';
          const tb = b.isoDate || b.dateLabel || '';
          return tb.localeCompare(ta);
        });

        sorted.forEach(entry => {
          const ts = entry.isoDate
            ? new Date(entry.isoDate).toLocaleString()
            : (entry.dateLabel || '—');

          const div = document.createElement('div');
          div.style.cssText = 'padding:0.6rem 0;border-bottom:1px solid var(--border,#333);color:var(--text-primary,#fff);';
          div.innerHTML = (
            '<strong>' + entry.type.toUpperCase() + '</strong>' +
            ' &mdash; $' + parseFloat(entry.amount).toFixed(2) +
            '<br><span style="font-size:0.85em;color:var(--text-secondary,#aaa);">' + ts + '</span>'
          );
          historyList.appendChild(div);
        });
      } catch (err) {
        console.error('History load error:', err);
        if (historyList) historyList.innerHTML = '<em>Error loading history.</em>';
      }
    });
  }

  if (historyCloseBtn) {
    historyCloseBtn.addEventListener('click', () => {
      if (historyModal) historyModal.style.display = 'none';
    });
  }

  loadAccountData();
}

// Called from initializeApp() after auth resolves and DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Delay to let initializeApp set currentUser before we query Firestore
  setTimeout(() => setupAccountOverview(), 800);
});

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

// ========================================
// DARK MODE TOGGLE
// ========================================
function setupDarkMode() {
  const toggleBtn = document.getElementById('dark-mode-toggle');
  if (!toggleBtn) return;

  // Load saved preference
  const savedMode = localStorage.getItem('dark-mode');
  if (savedMode === 'enabled') {
    document.body.classList.add('dark-mode');
    toggleBtn.textContent = '☀️ Light Mode';
  }

  toggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    
    if (isDark) {
      localStorage.setItem('dark-mode', 'enabled');
      toggleBtn.textContent = '☀️ Light Mode';
    } else {
      localStorage.setItem('dark-mode', 'disabled');
      toggleBtn.textContent = '🌙 Dark Mode';
    }
  });
}

// ========================================
// MARKET INTELLIGENCE WIDGETS
// ========================================
function setupExpandModal() {
  const modal = document.getElementById('widget-expand-modal');
  const closeBtn = document.getElementById('close-expand-modal');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  }
}

function renderMarketIntelligence() {
  // Use setTimeout to ensure containers are in DOM
  setTimeout(() => {
    console.log('📊 Rendering Market Intelligence widgets...');

    // Economic Calendar
    const economicContainer = document.getElementById('tv-economic-calendar');
    if (economicContainer) {
      console.log('✅ Economic Calendar container found');
      economicContainer.innerHTML = '';
      const economicScript = document.createElement('script');
      economicScript.type = 'text/javascript';
      economicScript.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
      economicScript.async = true;
      economicScript.innerHTML = JSON.stringify({
        colorTheme: 'light',
        isTransparent: false,
        width: '100%',
        height: '400',
        locale: 'en',
        importanceFilter: '-1,0,1',
        countryFilter: 'us'
      });
      economicContainer.appendChild(economicScript);
    } else {
      console.error('❌ Economic Calendar container NOT found');
    }

    // Earnings Calendar - Custom API
    renderEarningsCalendar();

    // Market News
    const newsContainer = document.getElementById('tv-market-news');
    if (newsContainer) {
      console.log('✅ Market News container found');
      newsContainer.innerHTML = '';
      const newsScript = document.createElement('script');
      newsScript.type = 'text/javascript';
      newsScript.src = 'https://s3.tradingview.com/external-embedding/embed-widget-timeline.js';
      newsScript.async = true;
      newsScript.innerHTML = JSON.stringify({
        feedMode: 'all_symbols',
        colorTheme: 'light',
        isTransparent: false,
        displayMode: 'regular',
        width: '100%',
        height: '400',
        locale: 'en'
      });
      newsContainer.appendChild(newsScript);
    } else {
      console.error('❌ Market News container NOT found');
    }
  }, 300);
}

// Expand Widget Modal
async function expandWidget(type) {
  const modal = document.getElementById('widget-expand-modal');
  const title = document.getElementById('expand-modal-title');
  const body = document.getElementById('expand-modal-body');
  
  // Clear previous content
  body.innerHTML = '';
  
  // Set title
  const titles = {
    economic: '📅 Economic Calendar',
    earnings: '📊 Earnings Calendar',
    news: '📰 Market News'
  };
  title.textContent = titles[type];
  
  // Create expanded widget container
  const expandedContainer = document.createElement('div');
  expandedContainer.className = 'tv-widget-expanded';
  expandedContainer.id = `expanded-${type}`;
  body.appendChild(expandedContainer);
  
  // Inject full widget
  if (type === 'economic') {
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      colorTheme: 'light',
      isTransparent: false,
      width: '100%',
      height: '600',
      locale: 'en',
      importanceFilter: '-1,0,1',
      countryFilter: 'us'
    });
    expandedContainer.appendChild(script);
  } else if (type === 'earnings') {
    // Show full week earnings calendar
    expandedContainer.innerHTML = '<div style="padding: 2rem; text-align: center; color: #9ca3af;">Loading week earnings...</div>';

    const API_KEY = 'd6ku209r01qmopd26eu0d6ku209r01qmopd26eug';

    // Get Monday and Friday of current week
    const today = new Date();
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);

    const from = monday.toISOString().split('T')[0];
    const to = friday.toISOString().split('T')[0];

    try {
      const response = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${API_KEY}`);
      const data = await response.json();

      if (!data || !data.earningsCalendar || data.earningsCalendar.length === 0) {
        expandedContainer.innerHTML = '<div style="padding: 2rem; text-align: center; color: #9ca3af;">No earnings this week</div>';
        return;
      }

      // Filter: Only symbols that look like US tickers (1-5 letters, no dots/special chars)
      const usEarnings = data.earningsCalendar.filter(earning => {
        const symbol = earning.symbol || '';
        return /^[A-Z]{1,5}$/.test(symbol) && earning.hour && (earning.hour === 'bmo' || earning.hour === 'amc');
      });

      // Fetch company names for all symbols
      const symbolsToFetch = [...new Set(usEarnings.map(e => e.symbol))];
      const companyNames = {};

      await Promise.all(
        symbolsToFetch.map(async symbol => {
          try {
            const profileResponse = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${API_KEY}`);
            const profileData = await profileResponse.json();
            // Check if profileData has valid name and it's not empty
            if (profileData && profileData.name && profileData.name.trim() !== '') {
              companyNames[symbol] = profileData.name;
            } else {
              companyNames[symbol] = 'N/A';
            }
          } catch {
            companyNames[symbol] = 'N/A';
          }
        })
      );

      // Group by date
      const byDate = {};
      usEarnings.forEach(earning => {
        const date = earning.date;
        if (!byDate[date]) {
          byDate[date] = { preMarket: [], afterMarket: [] };
        }
        if (earning.hour === 'bmo') {
          byDate[date].preMarket.push(earning);
        } else if (earning.hour === 'amc') {
          byDate[date].afterMarket.push(earning);
        }
      });

      // Sort alphabetically within each group
      Object.keys(byDate).forEach(date => {
        byDate[date].preMarket.sort((a, b) => a.symbol.localeCompare(b.symbol));
        byDate[date].afterMarket.sort((a, b) => a.symbol.localeCompare(b.symbol));
      });

      let html = '<div style="padding: 1rem; max-height: 600px; overflow-y: auto;">';

      const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const currentMonday = new Date(monday);

      for (let i = 0; i < 5; i++) {
        const date = new Date(currentMonday);
        date.setDate(currentMonday.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        const dayData = byDate[dateStr];

        // Only show days with earnings
        if (!dayData || (dayData.preMarket.length === 0 && dayData.afterMarket.length === 0)) {
          continue;
        }

        html += `<div style="margin-bottom: 2rem;">`;
        html += `<h4 style="color: var(--text-primary); margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--border-color);">${weekdays[i]} - ${dateStr}</h4>`;

        // Side-by-side columns
        html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">';

        // Pre-Market Column
        html += '<div>';
        html += '<div style="font-weight: 600; color: #3b82f6; margin-bottom: 0.75rem; font-size: 0.95rem;">PRE-MARKET</div>';
        if (dayData.preMarket.length > 0) {
          html += '<div style="background: rgba(59, 130, 246, 0.03); border-radius: 6px; padding: 0.75rem;">';
          dayData.preMarket.forEach((earning, idx) => {
            const companyName = companyNames[earning.symbol] || 'N/A';
            const border = idx < dayData.preMarket.length - 1 ? 'border-bottom: 1px solid var(--border-color);' : '';
            html += `<div style="padding: 0.5rem 0; ${border}">`;
            html += `<div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem;">${earning.symbol} — ${companyName}</div>`;
            html += `<div style="color: var(--text-secondary); font-size: 0.875rem;">EPS Est: ${earning.epsEstimate || 'N/A'} | Last ER Move: N/A</div>`;
            html += '</div>';
          });
          html += '</div>';
        } else {
          html += '<div style="color: var(--text-secondary); font-style: italic; padding: 0.5rem;">No pre-market earnings</div>';
        }
        html += '</div>';

        // After-Market Column
        html += '<div>';
        html += '<div style="font-weight: 600; color: #10b981; margin-bottom: 0.75rem; font-size: 0.95rem;">AFTER-MARKET</div>';
        if (dayData.afterMarket.length > 0) {
          html += '<div style="background: rgba(16, 185, 129, 0.03); border-radius: 6px; padding: 0.75rem;">';
          dayData.afterMarket.forEach((earning, idx) => {
            const companyName = companyNames[earning.symbol] || 'N/A';
            const border = idx < dayData.afterMarket.length - 1 ? 'border-bottom: 1px solid var(--border-color);' : '';
            html += `<div style="padding: 0.5rem 0; ${border}">`;
            html += `<div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem;">${earning.symbol} — ${companyName}</div>`;
            html += `<div style="color: var(--text-secondary); font-size: 0.875rem;">EPS Est: ${earning.epsEstimate || 'N/A'} | Last ER Move: N/A</div>`;
            html += '</div>';
          });
          html += '</div>';
        } else {
          html += '<div style="color: var(--text-secondary); font-style: italic; padding: 0.5rem;">No after-market earnings</div>';
        }
        html += '</div>';

        html += '</div>'; // Close grid
        html += '</div>'; // Close day container
      }

      html += '</div>';
      expandedContainer.innerHTML = html;

    } catch (error) {
      console.error('Error fetching week earnings:', error);
      expandedContainer.innerHTML = '<div style="padding: 2rem; text-align: center; color: #ef4444;">Failed to load week earnings</div>';
    }
  } else if (type === 'news') {
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-timeline.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      feedMode: 'all_symbols',
      colorTheme: 'light',
      isTransparent: false,
      displayMode: 'regular',
      width: '100%',
      height: '600',
      locale: 'en'
    });
    expandedContainer.appendChild(script);
  }
  
  modal.classList.add('active');
}

function closeExpandModal() {
  document.getElementById('widget-expand-modal').classList.remove('active');
}

// ========================================
// EARNINGS CALENDAR - FINNHUB API
// ========================================
let weekEarningsData = null; // Store week data for expand modal

async function renderEarningsCalendar() {
  const earningsContainer = document.getElementById('tv-earnings-calendar');
  if (!earningsContainer) {
    console.error('❌ Earnings Calendar container NOT found');
    return;
  }

  console.log('✅ Earnings Calendar container found');
  earningsContainer.innerHTML = '<div style="padding: 1rem; color: #9ca3af; text-align: center;">Loading today\'s earnings...</div>';

  try {
    const today = new Date();
    const API_KEY = 'd6ku209r01qmopd26eu0d6ku209r01qmopd26eug';

    // Get current week (Monday to Friday)
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);

    const from = monday.toISOString().split('T')[0];
    const to = friday.toISOString().split('T')[0];

    const response = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${API_KEY}`);
    const weekData = await response.json();

    if (!weekData || !weekData.earningsCalendar || weekData.earningsCalendar.length === 0) {
      earningsContainer.innerHTML = '<div style="padding: 2rem; color: #9ca3af; text-align: center;">Loading earnings data...</div>';
      return;
    }

    // Filter: Only symbols that look like US tickers (1-5 letters, no dots/special chars)
    const allUsEarnings = weekData.earningsCalendar.filter(earning => {
      const symbol = earning.symbol || '';
      return /^[A-Z]{1,5}$/.test(symbol) && earning.hour && (earning.hour === 'bmo' || earning.hour === 'amc');
    });

    if (allUsEarnings.length === 0) {
      earningsContainer.innerHTML = '<div style="padding: 2rem; color: #9ca3af; text-align: center;">Loading earnings data...</div>';
      return;
    }

    // Try to find today's earnings first
    const todayStr = today.toISOString().split('T')[0];
    let usEarnings = allUsEarnings.filter(e => e.date === todayStr);
    let displayDate = todayStr;
    let displayLabel = "Today's Earnings";

    // If no earnings today, find the next available day in the week
    if (usEarnings.length === 0) {
      const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      for (let i = 1; i <= 7; i++) {
        const nextDay = new Date(today);
        nextDay.setDate(today.getDate() + i);
        const nextDayStr = nextDay.toISOString().split('T')[0];
        const nextDayEarnings = allUsEarnings.filter(e => e.date === nextDayStr);
        if (nextDayEarnings.length > 0) {
          usEarnings = nextDayEarnings;
          displayDate = nextDayStr;
          displayLabel = `Next Earnings\n${daysOfWeek[nextDay.getDay()]}`;
          break;
        }
      }
    }

    // If still no earnings found in the next week
    if (usEarnings.length === 0) {
      earningsContainer.innerHTML = '<div style="padding: 2rem; color: #9ca3af; text-align: center;">Loading earnings data...</div>';
      return;
    }

    // Fetch company names for all symbols
    const symbolsToFetch = [...new Set(usEarnings.map(e => e.symbol))];
    const companyNames = {};

    await Promise.all(
      symbolsToFetch.map(async symbol => {
        try {
          const profileResponse = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${API_KEY}`);
          const profileData = await profileResponse.json();
          // Check if profileData has valid name and it's not empty
          if (profileData && profileData.name && profileData.name.trim() !== '') {
            companyNames[symbol] = profileData.name;
          } else {
            companyNames[symbol] = 'N/A';
          }
        } catch {
          companyNames[symbol] = 'N/A';
        }
      })
    );

    // Group by time (alphabetical sort since we don't have market cap data)
    const preMarket = usEarnings.filter(e => e.hour === 'bmo').sort((a, b) => a.symbol.localeCompare(b.symbol));
    const afterMarket = usEarnings.filter(e => e.hour === 'amc').sort((a, b) => a.symbol.localeCompare(b.symbol));

    const maxDisplay = 5;

    let html = '<div style="padding: 0.5rem; max-height: 220px; overflow-y: auto;">';
    html += `<div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.75rem; padding: 0.5rem; white-space: pre-line;">${displayLabel}</div>`;

    if (preMarket.length > 0) {
      html += '<div style="padding: 0.5rem; background: rgba(59, 130, 246, 0.05); border-left: 3px solid #3b82f6; margin-bottom: 0.75rem;">';
      html += '<div style="font-size: 0.75rem; color: #3b82f6; font-weight: 600; margin-bottom: 0.5rem;">PRE-MARKET</div>';

      preMarket.slice(0, maxDisplay).forEach(earning => {
        const companyName = companyNames[earning.symbol] || 'N/A';
        html += `<div style="padding: 0.25rem 0; color: var(--text-primary); font-size: 0.875rem;">${earning.symbol} — ${companyName}</div>`;
      });

      if (preMarket.length > maxDisplay) {
        html += `<div style="padding: 0.25rem 0; color: var(--text-secondary); font-size: 0.875rem;">+${preMarket.length - maxDisplay} more</div>`;
      }

      html += '</div>';
    }

    if (afterMarket.length > 0) {
      html += '<div style="padding: 0.5rem; background: rgba(16, 185, 129, 0.05); border-left: 3px solid #10b981;">';
      html += '<div style="font-size: 0.75rem; color: #10b981; font-weight: 600; margin-bottom: 0.5rem;">AFTER-MARKET</div>';

      afterMarket.slice(0, maxDisplay).forEach(earning => {
        const companyName = companyNames[earning.symbol] || 'N/A';
        html += `<div style="padding: 0.25rem 0; color: var(--text-primary); font-size: 0.875rem;">${earning.symbol} — ${companyName}</div>`;
      });

      if (afterMarket.length > maxDisplay) {
        html += `<div style="padding: 0.25rem 0; color: var(--text-secondary); font-size: 0.875rem;">+${afterMarket.length - maxDisplay} more</div>`;
      }

      html += '</div>';
    }

    html += '</div>';
    earningsContainer.innerHTML = html;

  } catch (error) {
    console.error('Error fetching earnings data:', error);
    earningsContainer.innerHTML = '<div style="padding: 1rem; color: #ef4444;">Failed to load earnings</div>';
  }
}
