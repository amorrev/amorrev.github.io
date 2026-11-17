const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let S = {};
let busy = false;
let allVers = [];
let fam = 'all';
let switching = false;
let currentView = 'play';
const VIEWS = ['play', 'builds', 'mods', 'settings'];
const keyEls = () => document.querySelectorAll('[data-key]');

const readEl = (el) => (el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value.trim());
const writeEl = (el, v) => { if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс' : String(n));
const isRelease = (v) => /^\d+\.\d+(\.\d+)?$/.test(v);
const loaderName = (l) => (l === 'fabric' ? 'Fabric' : 'Vanilla');

/* ----- Скользящие индикаторы ----- */
function place(ind, el, instant) {
  if (!el || !el.offsetWidth) return;
  if (instant) ind.style.transition = 'none';
  ind.style.width = `${el.offsetWidth}px`;
  ind.style.transform = `translateX(${el.offsetLeft}px)`;
  if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
}
const placeNav = (instant) => place($('navInd'), document.querySelector('.tab.active'), instant);
const placeSeg = (instant) => place($('segInd'), document.querySelector('.segbtn.active'), instant);

/* ----- Аватар ----- */
const skinCache = new Map();
async function drawAvatar() {
  const c = $('avatar'), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 32, 32);
  const useMs = S.accountType === 'microsoft' && S.msLoggedIn;
  if (!useMs && !/^[A-Za-z0-9_]{3,16}$/.test(S.nick || '')) return;
  const key = useMs ? `u:${S.msUuid}` : `n:${S.nick}`;
  let url = skinCache.get(key);
  if (!url) {
    url = await window.astral.skin(useMs ? { uuid: S.msUuid } : { name: S.nick });
    if (url) skinCache.set(key, url);
  }
  if (!url) return;
  const img = new Image();
  img.onload = () => { ctx.clearRect(0, 0, 32, 32); ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 32, 32); ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 32, 32); };
  img.src = url;
}

function fillSettings() {
  keyEls().forEach((el) => { if (el.id !== 'nick') writeEl(el, S[el.dataset.key]); });
  document.querySelectorAll('.rangeval').forEach((v) => { v.textContent = `${$(v.dataset.for).value} ГБ`; });
  $('gameDirView').value = S.gameDir || '';
  applyBuildUI();
  renderAccount();
}

function renderAccount() {
  const ms = S.msLoggedIn;
  const useMs = S.accountType === 'microsoft' && ms;
  $('accStatus').textContent = ms ? `Microsoft: ${S.msName}` : 'Вход через Microsoft не выполнен';
  $('msLogin').hidden = ms; $('msLogout').hidden = !ms;
  $('accountType').querySelector('[value=microsoft]').disabled = !ms;
  $('accountType').value = useMs ? 'microsoft' : 'offline';
  $('nick').disabled = useMs; $('nick').value = useMs ? S.msName : S.nick || '';
  drawAvatar();
}

/* ----- Выбор версии ----- */
async function loadVersions() {
  const r = await window.astral.versions(S.snapshots);
  allVers = r.ok ? r.versions : [S.mcVersion];
  if (!allVers.includes(S.mcVersion)) allVers.unshift(S.mcVersion);
  $('verLabel').textContent = S.mcVersion;
  if (!$('verPop').hidden) renderVers();
}
function renderFams() {
  const fams = [];
  allVers.forEach((v) => { const m = v.match(/^(1\.\d+)/); if (m && !fams.includes(m[1])) fams.push(m[1]); });
  const mk = (label, active, onClick) => { const b = document.createElement('button'); b.className = 'fam' + (active ? ' active' : ''); b.textContent = label; b.addEventListener('click', onClick); return b; };
  $('verFams').replaceChildren(
    mk('Все', fam === 'all', () => { fam = 'all'; renderVers(); }),
    ...fams.slice(0, 7).map((f) => mk(f, fam === f, () => { fam = f; renderVers(); })),
    mk('Снапшоты', !!S.snapshots, () => save('snapshots', !S.snapshots)),
  );
}
function renderVers() {
  renderFams();
  const qy = $('verSearch').value.trim().toLowerCase();
  const latest = allVers.find(isRelease);
  const items = allVers.filter((v) => (fam === 'all' || v === fam || v.startsWith(fam + '.')) && (!qy || v.toLowerCase().includes(qy)));
  if (!items.length) { const d = document.createElement('div'); d.className = 'vempty'; d.textContent = 'Версия не найдена'; $('verList').replaceChildren(d); return; }
  $('verList').replaceChildren(...items.map((v, i) => {
    const b = document.createElement('button'); b.className = 'vitem' + (v === S.mcVersion ? ' active' : '');
    b.style.setProperty('--i', Math.min(i, 24));
    b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(v === S.mcVersion)); b.dataset.v = v; b.textContent = v;
    if (v === latest) { const n = document.createElement('span'); n.className = 'new'; n.textContent = 'new'; b.append(n); }
    b.addEventListener('click', () => pickVersion(v));
    return b;
  }));
  const act = $('verList').querySelector('.active'); if (act) act.scrollIntoView({ block: 'nearest' });
}
function openPop(open) {
  $('verPop').hidden = !open;
  $('verBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('verSearch').value = ''; fam = 'all';
    $('verList').classList.add('fresh'); renderVers(); $('verSearch').focus();
    setTimeout(() => $('verList').classList.remove('fresh'), 700);
  }
}
async function pickVersion(v) { await save('mcVersion', v); $('verLabel').textContent = v; openPop(false); }
function loaderUI() { document.querySelectorAll('.segbtn').forEach((b) => b.classList.toggle('active', b.dataset.loader === S.loader)); placeSeg(); }

async function save(key, val) {
  S = await window.astral.setSettings({ [key]: val });
  if (key === 'snapshots') await loadVersions();
  if (key === 'accountType') renderAccount();
  if (key === 'nick') drawAvatar();
  if (key === 'mcVersion' || key === 'loader' || key === 'build') modCtx();
  if (key === 'loader') loaderUI();
  if (key === 'build') applyBuildUI(false);
}

/* ----- Сборки и переход между ними ----- */
const curIdx = () => Math.max(0, (S.builds || []).findIndex((b) => b.id === S.activeBuild));
function applyBuildUI(full = true) {
  $('buildCount').textContent = `${curIdx() + 1} / ${S.builds.length}`;
  $('prevBuild').disabled = $('nextBuild').disabled = S.builds.length < 2;
  if (full) { $('build').value = S.build || ''; $('verLabel').textContent = S.mcVersion; loaderUI(); }
  modCtx();
}
function artShift(dir) {
  const a = document.querySelector('.art');
  a.style.transform = `translateX(${-dir * 26}px)`;
  setTimeout(() => { a.style.transform = ''; }, 60);
}
async function ensureVersionKnown() { if (!allVers.includes(S.mcVersion)) allVers.unshift(S.mcVersion); }
async function slideIn(dir) {
  const sl = $('buildSlide');
  sl.classList.remove('out-l', 'out-r');
  sl.classList.add(dir > 0 ? 'in-r' : 'in-l');
  await sleep(460);
  sl.classList.remove('in-r', 'in-l');
}
async function switchBuild(step) {
  if (switching || S.builds.length < 2) return;
  switching = true;
  const n = S.builds.length;
  const target = S.builds[(curIdx() + step + n) % n];
  const sl = $('buildSlide');
  sl.classList.add(step > 0 ? 'out-l' : 'out-r');
  artShift(step);
  await sleep(170);
  S = await window.astral.buildsSelect(target.id);
  await ensureVersionKnown();
  applyBuildUI();
  await slideIn(step);
  switching = false;
}
async function goToBuild(id) {
  const old = curIdx();
  S = await window.astral.buildsSelect(id);
  const dir = curIdx() >= old ? 1 : -1;
  await ensureVersionKnown();
  applyBuildUI();
  showView('play');
  artShift(dir);
  slideIn(dir);
}

function renderBuilds() {
  const when = (t) => (t ? `Играли: ${new Date(t).toLocaleDateString('ru-RU')}` : 'Ещё не запускалась');
  $('bGrid').replaceChildren(...S.builds.map((b, i) => {
    const el = document.createElement('div'); el.className = 'glass bcard' + (b.id === S.activeBuild ? ' active' : '');
    el.style.setProperty('--i', Math.min(i, 12)); el.tabIndex = 0; el.setAttribute('role', 'button');
    if (b.id === S.activeBuild) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'АКТИВНА'; el.append(t); }
    const n = document.createElement('div'); n.className = 'bname'; n.textContent = b.name || 'Без названия';
    const m = document.createElement('div'); m.className = 'bmeta'; m.textContent = `${b.mcVersion} · ${loaderName(b.loader)}`;
    const w = document.createElement('div'); w.className = 'bmeta'; w.textContent = when(b.lastPlayed);
    el.append(n, m, w);
    if (S.builds.length > 1) {
      const acts = document.createElement('div'); acts.className = 'bactions';
      const del = document.createElement('button'); del.className = 'btn small'; del.textContent = 'Удалить';
      let armed = false, timer;
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!armed) { armed = true; del.textContent = 'Точно удалить?'; timer = setTimeout(() => { armed = false; del.textContent = 'Удалить'; }, 3000); return; }
        clearTimeout(timer); S = await window.astral.buildsDelete(b.id); applyBuildUI(); renderBuilds();
      });
      acts.append(del); el.append(acts);
    }
    el.addEventListener('click', () => goToBuild(b.id));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToBuild(b.id); } });
    return el;
  }));
}
async function doImport(kind) {
  $('bMsg').textContent = 'Выбери файл или папку…';
  const r = await (kind === 'file' ? window.astral.importFile() : window.astral.importFolder());
  if (r.canceled) { $('bMsg').textContent = ''; return; }
  if (!r.ok) { $('bMsg').textContent = r.error; return; }
  S = r.settings; await ensureVersionKnown(); applyBuildUI(); renderBuilds();
  $('bMsg').textContent = [`Импортировано: ${r.name}.`, ...r.report].join(' ');
}

/* ----- Запуск ----- */
function setBusy(v) { busy = v; $('play').disabled = v; $('play').textContent = v ? 'ЗАПУСК…' : 'ИГРАТЬ'; }
async function play() {
  if (busy) return;
  setBusy(true);
  $('statusText').textContent = '';
  const res = await window.astral.launch();
  if (!res.ok) { $('statusText').textContent = res.error; $('progress').hidden = true; setBusy(false); }
  else $('play').textContent = 'В ИГРЕ';
}

/* ----- Моды ----- */
let sub = 'search';
const modCtx = () => { $('modCtx').textContent = `${S.build || 'Сборка'} · Minecraft ${S.mcVersion} · ${loaderName(S.loader)}`; };
function card(info) {
  const el = document.createElement('div'); el.className = 'glass mod';
  let icon;
  if (info.icon && info.icon.startsWith('https://cdn.modrinth.com/')) { icon = document.createElement('img'); icon.src = info.icon; icon.alt = ''; }
  else { icon = document.createElement('span'); icon.className = 'ph'; }
  const box = document.createElement('div'); box.className = 'info';
  const n = document.createElement('div'); n.className = 'name'; n.textContent = info.title;
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = info.desc;
  box.append(n, d); el.append(icon, box);
  return { el };
}
function showList(nodes, msg = '') { $('modMsg').textContent = msg; $('modList').replaceChildren(...nodes); }
async function modsSearch() {
  showList([], 'Поиск…');
  const r = await window.astral.modsSearch($('modQuery').value.trim());
  if (!r.ok) return showList([], r.error);
  if (!r.hits.length) return showList([], 'Ничего не найдено для этой версии.');
  showList(r.hits.map((h) => {
    const { el } = card({ icon: h.icon, title: h.title, desc: `${h.author} · ${fmt(h.downloads)} загрузок · ${h.description}` });
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Установить';
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Установка…';
      const x = await window.astral.modsInstall(h.id);
      if (x.ok) { b.textContent = 'Установлено'; $('modMsg').textContent = `Скачано: ${x.files.join(', ')}`; }
      else { b.disabled = false; b.textContent = 'Установить'; $('modMsg').textContent = x.error; }
    });
    el.append(b); return el;
  }));
}
async function modsInstalled() {
  const list = await window.astral.modsList();
  if (!list.length) return showList([], 'Модов пока нет.');
  showList(list.map((m) => {
    const { el } = card({ icon: null, title: m.name, desc: `${(m.size / 1048576).toFixed(2)} МБ` });
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Удалить';
    b.addEventListener('click', async () => { await window.astral.modsRemove(m.name); modsInstalled(); });
    el.append(b); return el;
  }));
}
function setSub(name) {
  sub = name;
  document.querySelectorAll('.sub').forEach((b) => b.classList.toggle('active', b.dataset.sub === name));
  $('searchBar').hidden = name !== 'search';
  name === 'search' ? modsSearch() : modsInstalled();
}

/* ----- Экраны ----- */
function showView(name) {
  if (name === currentView) return;
  currentView = name;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
  VIEWS.forEach((v) => { const el = $(`view-${v}`); el.hidden = v !== name; el.classList.remove('enter'); });
  const el = $(`view-${name}`); void el.offsetWidth; el.classList.add('enter');
  placeNav();
  openPop(false);
  if (name === 'play') requestAnimationFrame(() => placeSeg(true));
  if (name === 'builds') renderBuilds();
  if (name === 'mods') { modCtx(); setSub(sub); }
}

async function init() {
  S = await window.astral.getSettings();
  fillSettings();
  await loadVersions();
  modCtx();
  document.fonts.ready.then(() => { placeNav(true); placeSeg(true); });
  placeNav(true); placeSeg(true);
  window.addEventListener('resize', () => { placeNav(true); placeSeg(true); });

  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('.btn,.tab,.segbtn,.bcard');
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', `${e.clientX - r.left}px`); t.style.setProperty('--my', `${e.clientY - r.top}px`);
  });

  keyEls().forEach((el) => {
    el.addEventListener('input', () => {
      const lab = document.querySelector(`.rangeval[data-for="${el.id}"]`);
      if (lab) lab.textContent = `${readEl(el)} ГБ`;
    });
    el.addEventListener('change', () => save(el.dataset.key, readEl(el)));
  });

  document.querySelectorAll('.segbtn').forEach((b) => b.addEventListener('click', () => save('loader', b.dataset.loader)));
  $('verBtn').addEventListener('click', () => openPop($('verPop').hidden));
  $('verSearch').addEventListener('input', renderVers);
  $('verSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const f = $('verList').querySelector('.vitem'); if (f) pickVersion(f.dataset.v); }
  });
  document.addEventListener('click', (e) => { if (!$('verPop').hidden && !$('verPop').contains(e.target) && !$('verBtn').contains(e.target)) openPop(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openPop(false); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  document.querySelectorAll('.sub').forEach((b) => b.addEventListener('click', () => setSub(b.dataset.sub)));
  $('modSearch').addEventListener('click', modsSearch);
  $('modQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') modsSearch(); });

  $('prevBuild').addEventListener('click', () => switchBuild(-1));
  $('nextBuild').addEventListener('click', () => switchBuild(1));
  $('allBuilds').addEventListener('click', () => showView('builds'));
  $('bCreate').addEventListener('click', async () => {
    S = await window.astral.buildsCreate(); await ensureVersionKnown(); applyBuildUI();
    showView('play'); slideIn(1); $('build').focus(); $('build').select();
  });
  $('bImportFile').addEventListener('click', () => doImport('file'));
  $('bImportFolder').addEventListener('click', () => doImport('folder'));
  window.astral.onImport(({ text }) => { $('bMsg').textContent = text; });

  $('folder').addEventListener('click', () => window.astral.openFolder());
  $('play').addEventListener('click', play);
  $('chooseDir').addEventListener('click', async () => { S = await window.astral.chooseDir(); $('gameDirView').value = S.gameDir || ''; });
  $('resetDir').addEventListener('click', async () => { S = await window.astral.setSettings({ gameDir: '' }); $('gameDirView').value = ''; });
  $('msLogin').addEventListener('click', async () => {
    $('accMsg').textContent = 'Открываю окно входа…'; $('msLogin').disabled = true;
    const r = await window.astral.login();
    $('msLogin').disabled = false;
    if (r.ok) { S = r.settings; $('accMsg').textContent = ''; renderAccount(); } else $('accMsg').textContent = r.error;
  });
  $('msLogout').addEventListener('click', async () => { S = await window.astral.logout(); renderAccount(); });

  window.astral.onStatus(({ text, percent }) => {
    $('statusText').textContent = text;
    $('progress').hidden = percent === null;
    if (percent !== null) $('bar').style.width = `${percent}%`;
  });
  window.astral.onClosed(() => setBusy(false));
  window.astral.onUpdate(({ state, version, percent }) => {
    const b = $('updBanner'); b.hidden = false;
    if (state === 'downloading') { $('updText').textContent = `Загрузка обновления${version ? ' ' + version : ''}… ${percent || 0}%`; $('updBtn').hidden = true; }
    else { $('updText').textContent = `Готово обновление ${version}`; $('updBtn').hidden = false; }
  });
  $('updBtn').addEventListener('click', () => window.astral.installUpdate());
}
init();
