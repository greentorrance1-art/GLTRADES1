// Global state
let currentPage = 'dashboard';
let currentUser = null;
let userRole = null;

// Initialize app after authentication
window.initializeApp = async function () {
  currentUser = authManager.getUserId();
  userRole = authManager.userRole;

  await loadAllData();
  setupEventListeners();
  setupRoleBasedUI();
  updateDashboard();
  showPage('dashboard');
};

// Load all user data
async function loadAllData() {
  if (!currentUser) return;

  try {
    const tradesSnapshot = await db
      .collection('users')
      .doc(currentUser)
      .collection('trades')
      .get();
    window.trades = tradesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const playbooksSnapshot = await db
      .collection('users')
      .doc(currentUser)
      .collection('playbooks')
      .get();
    window.playbooks = playbooksSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const journalSnapshot = await db
      .collection('users')
      .doc(currentUser)
      .collection('journal')
      .get();
    window.journalEntries = journalSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    await loadGLUniversityContent();
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

// GL University
async function loadGLUniversityContent() {
  try {
    const doc = await db.collection('global').doc('gl_university').get();
    if (doc.exists) {
      const data = doc.data();
      window.readingList = data.readingList || [];
      window.externalLinks = data.externalLinks || [];
    } else {
      window.readingList = [];
      window.externalLinks = [];
    }
    displayGLUniversity();
  } catch (error) {
    console.error(error);
  }
}

function setupRoleBasedUI() {
  if (authManager.isAdmin()) addAdminSettings();
}

function addAdminSettings() {
  const page = document.getElementById('gl-university-page');
  if (document.getElementById('admin-university-settings')) return;

  const div = document.createElement('div');
  div.id = 'admin-university-settings';
  div.className = 'university-section';
  div.innerHTML = `
    <h3>Admin: Manage GL University Content</h3>
    <button class="btn btn-primary" onclick="openGLUniversityManager()">Manage Content</button>
  `;
  page.prepend(div);
}

function openGLUniversityManager() {
  if (!authManager.isAdmin()) return;

  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'university-manager-modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:800px;">
      <div class="modal-header">
        <h3>Manage GL University Content</h3>
        <button class="close-modal" onclick="closeUniversityManager()">×</button>
      </div>

      <h4>Reading List</h4>
      <div id="admin-reading-list"></div>
      <button class="btn btn-secondary" onclick="addUniversityItem('reading')">+ Add Reading</button>

      <h4 style="margin-top:2rem;">External Links</h4>
      <div id="admin-links-list"></div>
      <button class="btn btn-secondary" onclick="addUniversityItem('link')">+ Add Link</button>

      <div style="margin-top:2rem;">
        <button class="btn btn-primary" onclick="saveUniversityContent()">Save</button>
        <button class="btn btn-secondary" onclick="closeUniversityManager()">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderAdminLists();
}

function renderAdminLists() {
  document.getElementById('admin-reading-list').innerHTML =
    window.readingList.map((i, idx) => `
      <div class="admin-list-item">
        <div>
          <h4>${i.title}</h4>
          <p>${i.author}</p>
        </div>
        <button class="action-btn delete" onclick="removeUniversityItem('reading',${idx})">Delete</button>
      </div>
    `).join('') || '<p>No reading items.</p>';

  document.getElementById('admin-links-list').innerHTML =
    window.externalLinks.map((i, idx) => `
      <div class="admin-list-item">
        <div>
          <h4>${i.title}</h4>
          <p><a href="${i.url}" target="_blank">${i.url}</a></p>
        </div>
        <button class="action-btn delete" onclick="removeUniversityItem('link',${idx})">Delete</button>
      </div>
    `).join('') || '<p>No links.</p>';
}

function addUniversityItem(type) {
  if (type === 'reading') {
    const title = prompt('Title');
    const author = prompt('Author');
    if (title && author) window.readingList.push({ title, author });
  } else {
    const title = prompt('Title');
    const url = prompt('URL');
    if (title && url) window.externalLinks.push({ title, url });
  }
  renderAdminLists();
}

function removeUniversityItem(type, index) {
  type === 'reading'
    ? window.readingList.splice(index, 1)
    : window.externalLinks.splice(index, 1);
  renderAdminLists();
}

async function saveUniversityContent() {
  await db.collection('global').doc('gl_university').set({
    readingList: window.readingList,
    externalLinks: window.externalLinks,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  closeUniversityManager();
  displayGLUniversity();
}

function closeUniversityManager() {
  document.getElementById('university-manager-modal')?.remove();
}

function displayGLUniversity() {
  document.getElementById('reading-list').innerHTML =
    window.readingList.map(i => `
      <li><h4>${i.title}</h4><p>${i.author}</p></li>
    `).join('');

  document.getElementById('external-links').innerHTML =
    window.externalLinks.map(i => `
      <li><h4>${i.title}</h4><a href="${i.url}" target="_blank">${i.url}</a></li>
    `).join('');
}

// Navigation
function setupEventListeners() {
  document.querySelectorAll('.nav-item:not(.logout-item)').forEach(item => {
    item.addEventListener('click', () => showPage(item.dataset.page));
  });
}

function showPage(page) {
  currentPage = page;

  document.querySelectorAll('.nav-item').forEach(i =>
    i.classList.toggle('active', i.dataset.page === page)
  );

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`${page}-page`)?.classList.add('active');

  if (page === 'dashboard') updateDashboard();
  if (page === 'trades') displayTrades();
  if (page === 'playbooks') displayPlaybooks();
  if (page === 'journal') displayJournal();
}

// Dashboard
function updateDashboard() {
  if (!window.trades) return;

  const wins = window.trades.filter(t => t.outcome === 'win').length;
  const losses = window.trades.filter(t => t.outcome === 'loss').length;

  document.getElementById('total-trades').textContent = window.trades.length;
  document.getElementById('win-rate').textContent =
    window.trades.length ? ((wins / window.trades.length) * 100).toFixed(1) + '%' : '0%';
}

// Initialize arrays
window.trades = [];
window.playbooks = [];
window.journalEntries = [];
window.readingList = [];
window.externalLinks = [];
