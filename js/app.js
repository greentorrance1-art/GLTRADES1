// ─── Global State ─────────────────────────────────────────
let currentPage = 'dashboard';
let currentUser = null;
let userRole = null;
let editingTradeId = null;

window.trades = [];
window.playbooks = [];
window.journalEntries = [];

let journalImageFiles = [];
window.userSettings = {};

let currentMarketSymbol = 'NASDAQ:AAPL';

let equityChartInstance = null;
let winlossChartInstance = null;


// ─── App Entry ─────────────────────────────────────────
window.initializeApp = async function () {

currentUser = authManager.getUserId();

userRole = await ensureUserRoleLoaded();
await loadUserSettings();

await loadAllData();

setupNavigation();
setupTradeModal();
setupPlaybookModal();
setupJournalModal();
setupSettingsButtons();
setupRoleBasedUI();

setupMarketOverviewUI();

updateDashboard();

showPage('dashboard');

};


// ─── Market Overview Fix ─────────────────────────────────────────

function setupMarketOverviewUI(){

const symbols = getMarketOverviewSymbols();

injectTradingViewWidget(
'ticker-tape-container',
'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js',
{
symbols: symbols.map(s=>({proName:s,title:s})),
showSymbolLogo:true,
colorTheme:'dark',
isTransparent:true,
displayMode:'adaptive',
locale:'en'
}
);

renderMarketOverviewWidgets();

}


function renderMarketOverviewWidgets(){

injectTradingViewWidget(
'tv-advanced-chart',
'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
{
autosize:true,
symbol:currentMarketSymbol,
interval:'D',
theme:'dark',
timezone:'America/New_York',
style:'1',
locale:'en',
allow_symbol_change:true,
watchlist:getMarketOverviewSymbols(),
details:true
}
);


injectTradingViewWidget(
'tv-heatmap',
'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js',
{
autosize:true,
exchange:'US',
dataSource:'SPX500',
grouping:'sector',
blockSize:'market_cap_basic',
blockColor:'change',
locale:'en',
colorTheme:'dark'
}
);

}


function injectTradingViewWidget(id,src,config){

const el=document.getElementById(id);
if(!el)return;

el.innerHTML='';

const script=document.createElement('script');
script.src=src;
script.type='text/javascript';
script.async=true;
script.innerHTML=JSON.stringify(config);

el.appendChild(script);

}


function getMarketOverviewSymbols(){

const raw=window.userSettings.marketOverviewSymbols;

if(raw){

return raw.split(',').map(s=>s.trim());

}

return[
'AMEX:SPY',
'NASDAQ:QQQ',
'NASDAQ:AAPL',
'NASDAQ:NVDA',
'NASDAQ:MSFT',
'NASDAQ:AMZN',
'NASDAQ:TSLA',
'CME_MINI:NQ1!'
];

}


// ─── Journal Upload Fix ─────────────────────────────────────────

async function uploadJournalImages(files){

if(!files.length)return[];

const storage=firebase.storage();

const uploads=files.map(file=>{

const ref=storage
.ref()
.child(`users/${currentUser}/journal/${Date.now()}_${file.name}`);

return ref.put(file).then(snap=>snap.ref.getDownloadURL());

});

return Promise.all(uploads);

}


async function saveJournalEntry(){

const submitBtn=document.querySelector('#journal-form button[type="submit"]');

submitBtn.disabled=true;
submitBtn.textContent='Saving...';

try{

const images=await uploadJournalImages(journalImageFiles);

const data={
date:document.getElementById('journal-date').value,
title:document.getElementById('journal-title').value.trim(),
entry:document.getElementById('journal-entry').value.trim(),
mood:document.getElementById('journal-mood').value,
images,
createdAt:firebase.firestore.FieldValue.serverTimestamp()
};

const docRef=await db
.collection('users')
.doc(currentUser)
.collection('journal')
.add(data);

window.journalEntries.unshift({id:docRef.id,...data});

document.getElementById('journal-modal').classList.remove('active');

journalImageFiles=[];

displayJournal();

}catch(err){

console.error(err);
alert('Error saving journal entry');

}finally{

submitBtn.disabled=false;
submitBtn.textContent='Save Entry';

}

}


// ─── Equity Curve Fix ─────────────────────────────────────────

function renderEquityChart(trades){

const ctx=document.getElementById('equity-chart');

if(!ctx)return;

if(equityChartInstance)equityChartInstance.destroy();

let running=0;

const labels=[];
const data=[];

[...trades].reverse().forEach(t=>{

running+=t.pl||0;

labels.push(t.date);
data.push(running);

});

equityChartInstance=new Chart(ctx,{
type:'line',
data:{
labels,
datasets:[{
label:'Equity',
data,
borderColor:'#10b981',
backgroundColor:'rgba(16,185,129,0.1)',
fill:true,
tension:.3
}]
},
options:{
responsive:true,
maintainAspectRatio:false
}
});

}


// ─── GL University Admin Fix ─────────────────────────────────────────

function setupRoleBasedUI(){

if(!authManager.isAdmin())return;

const panel=document.getElementById('admin-university-panel');

if(panel)panel.style.display='block';

}


async function saveGLData(data){

await db
.collection('global')
.doc('gl_university')
.set(data,{merge:true});

}


// ─── Helpers ─────────────────────────────────────────

function formatCurrency(val){

if(!val)return'$0.00';

return(val<0?'-':'')+'$'+Math.abs(val).toLocaleString(undefined,{
minimumFractionDigits:2,
maximumFractionDigits:2
});

}