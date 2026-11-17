const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const AdmZip = require('adm-zip');

const DISCORD_CLIENT_ID = '1571978618832297996';
const UA = 'astral-launcher/0.1.0';

const DEFAULTS = {
  nick: '', build: '', mcVersion: '1.21.11', loader: 'fabric', snapshots: false,
  ramMax: 4, ramMin: 1, javaPath: 'java', jvmArgs: '', width: 854, height: 480, fullscreen: false,
  afterLaunch: 'keep', gameDir: '', manifestUrl: '', discord: true,
  accountType: 'offline', msRefresh: '', msName: '', msUuid: '',
  builds: [], activeBuild: '', curseKey: '',
};
const USER_KEYS = Object.keys(DEFAULTS).filter((k) => !k.startsWith('ms') && k !== 'builds' && k !== 'activeBuild' && k !== 'discord');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultRoot = () => path.join(app.getPath('appData'), '.astral');
const activeBuild = (s) => s.builds.find((b) => b.id === s.activeBuild) || s.builds[0];
function syncFromBuild(s) { const b = activeBuild(s); s.build = b.name; s.mcVersion = b.mcVersion; s.loader = b.loader; }
const buildDir = (s, b) => (b.legacy ? gameRoot(s) : path.join(gameRoot(s), 'instances', b.id));
function loadSettings() {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  if (o.ramGb && !o.ramMax) o.ramMax = o.ramGb;
  const s = { ...DEFAULTS, ...o };
  s.discord = true;
  if (!Array.isArray(s.builds) || !s.builds.length) {
    s.builds = [{ id: 'main', name: s.build || 'Моя сборка', mcVersion: s.mcVersion, loader: s.loader, legacy: true, lastPlayed: 0 }];
  }
  if (!s.builds.some((b) => b.id === s.activeBuild)) s.activeBuild = s.builds[0].id;
  syncFromBuild(s);
  return s;
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const gameRoot = (s = loadSettings()) => s.gameDir || defaultRoot();
function publicSettings(s = loadSettings()) {
  const { msRefresh, ...rest } = s;
  return { ...rest, msLoggedIn: !!msRefresh };
}
const enc = (str) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(str).toString('base64') : 'raw:' + str);
const dec = (v) => (!v ? null : v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v.slice(4));

let win = null;
let running = false;
const sessionStart = new Date();
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const status = (text, percent = null) => send('status', { text, percent });

/* ---------- Discord ---------- */
let rpc = null;
async function initRpc() {
  if (!DISCORD_CLIENT_ID || rpc) return;
  try {
    const { Client: RpcClient } = require('@xhayper/discord-rpc');
    const c = new RpcClient({ clientId: DISCORD_CLIENT_ID });
    c.on('disconnected', () => { rpc = null; });
    await c.login();
    rpc = c;
    setPresence('menu');
  } catch (e) { console.log('Discord RPC недоступен:', e.message); rpc = null; }
}
function setPresence(kind, s = loadSettings(), started = sessionStart) {
  if (!rpc || !rpc.user) return;
  const playing = kind === 'playing';
  rpc.user.setActivity({
    details: playing ? `Играет: ${s.build || 'Minecraft'}` : 'В лаунчере',
    state: playing ? `Minecraft ${s.mcVersion}` : 'Выбирает сборку',
    startTimestamp: started,
    largeImageKey: 'astral',
    largeImageText: 'Astral',
  }).catch(() => {});
}

/* ---------- Утилиты ---------- */
const sha1buf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const sha1file = (f) => sha1buf(fs.readFileSync(f));
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} при запросе ${url}`);
  return r.json();
}
function requiredJava(mc) {
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const minor = +m[1], patch = +(m[2] || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}
function javaMajor(javaPath) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(javaPath, ['-version']);
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = out.match(/version "(\d+)(?:\.(\d+))?/);
      if (!m) return resolve(null);
      resolve(m[1] === '1' ? parseInt(m[2], 10) : parseInt(m[1], 10));
    });
  });
}
async function ensureFabric(root, mc) {
  const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mc}`);
  const entry = list.find((e) => e.loader.stable) || list[0];
  if (!entry) throw new Error(`Fabric пока не поддерживает ${mc}`);
  const id = `fabric-loader-${entry.loader.version}-${mc}`;
  const file = path.join(root, 'versions', id, `${id}.json`);
  if (!fs.existsSync(file)) {
    const r = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${entry.loader.version}/profile/json`);
    if (!r.ok) throw new Error('Не удалось скачать профиль Fabric');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await r.text());
  }
  return id;
}
async function syncMods(modsPath, url) {
  const m = await getJson(url);
  const dir = modsPath;
  fs.mkdirSync(dir, { recursive: true });
  const mods = m.mods || [];
  for (let i = 0; i < mods.length; i++) {
    const mod = mods[i];
    const name = path.basename(mod.file || new URL(mod.url).pathname);
    const f = path.join(dir, name);
    status(`Проверка модов ${i + 1} / ${mods.length}`, Math.round((i / mods.length) * 100));
    if (fs.existsSync(f) && (!mod.sha1 || sha1file(f) === mod.sha1)) continue;
    const r = await fetch(mod.url);
    if (!r.ok) throw new Error(`Не удалось скачать ${name}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
}

/* ---------- Microsoft ---------- */
async function msAuthorization(s) {
  const rt = dec(s.msRefresh);
  if (!rt) throw new Error('Войди в Microsoft-аккаунт в настройках.');
  const xbox = await new Auth('select_account').refresh(rt);
  const token = await xbox.getMinecraft();
  saveSettings({ ...loadSettings(), msRefresh: enc(xbox.save()), msName: token.profile.name, msUuid: token.profile.id });
  return token.mclc();
}
const errText = (e) => (e === 'error.gui.closed' ? 'Окно входа закрыто' : String((e && e.message) || e));

/* ---------- Java (скачивается сама) ---------- */
function findJavaExe(dir) {
  try { for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, 'bin', 'java.exe'); if (fs.existsSync(p)) return p; } } catch {}
  return null;
}
async function ensureJava(s, need) {
  const ok = (m) => m !== null && (need === 8 ? m === 8 : m >= need);
  if (s.javaPath && s.javaPath !== 'java') {
    const m = await javaMajor(s.javaPath);
    if (m === null) throw new Error('Java, указанная в настройках, не запускается.');
    if (!ok(m)) throw new Error(`Указана Java ${m}, а для ${s.mcVersion} нужна Java ${need}${need === 8 ? '' : '+'}.`);
    return s.javaPath;
  }
  if (ok(await javaMajor('java'))) return 'java';
  const want = need === 16 ? 17 : need;
  const dest = path.join(gameRoot(s), 'runtime', `java-${want}`);
  let exe = findJavaExe(dest);
  if (exe && ok(await javaMajor(exe))) return exe;
  status(`Загрузка Java ${want} (один раз)`, 0);
  const r = await fetch(`https://api.adoptium.net/v3/binary/latest/${want}/ga/windows/x64/jre/hotspot/normal/eclipse`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Не удалось скачать Java ${want} (${r.status}). Установи её вручную.`);
  const total = Number(r.headers.get('content-length')) || 0;
  const chunks = []; let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) status(`Загрузка Java ${want}`, Math.round((got / total) * 100));
  }
  status('Распаковка Java');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  new AdmZip(Buffer.concat(chunks)).extractAllTo(dest, true);
  exe = findJavaExe(dest);
  if (!exe) throw new Error('Не удалось распаковать Java.');
  return exe;
}

/* ---------- Запуск ---------- */
async function launchGame(s) {
  if (running) return { ok: false, error: 'Игра уже запущена' };
  running = true;
  try {
    const root = gameRoot(s);
    fs.mkdirSync(root, { recursive: true });
    const curBuild = activeBuild(s);
    const dir = buildDir(s, curBuild);
    fs.mkdirSync(dir, { recursive: true });

    let authorization;
    if (s.accountType === 'microsoft') { status('Вход в Microsoft'); authorization = await msAuthorization(s); }
    else {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(s.nick || '')) throw new Error('Ник: 3–16 символов, латиница, цифры, _');
      authorization = Authenticator.getAuth(s.nick);
    }

    status('Проверка Java');
    const need = requiredJava(s.mcVersion);
    const javaExe = await ensureJava(s, need);

    const version = { number: s.mcVersion, type: /^\d+\.\d+(\.\d+)?$/.test(s.mcVersion) ? 'release' : 'snapshot' };
    if (s.loader === 'fabric') { status('Подготовка Fabric'); version.custom = await ensureFabric(root, s.mcVersion); }
    if (s.manifestUrl) await syncMods(path.join(dir, 'mods'), s.manifestUrl);

    const launcher = new Client();
    launcher.on('progress', (e) => e && e.total && status(`Загрузка файлов (${e.type})`, Math.round((e.task / e.total) * 100)));
    launcher.on('debug', (m) => console.log('[mclc]', m));
    launcher.on('data', (m) => console.log('[game]', String(m).trimEnd()));
    launcher.on('close', () => {
      running = false;
      setPresence('menu');
      send('closed');
      status('Игра закрыта');
      if (win && win.isMinimized()) win.restore();
    });

    status('Запуск игры');
    const proc = await launcher.launch({
      authorization, root, javaPath: javaExe, version, overrides: { gameDirectory: dir },
      memory: { max: `${s.ramMax}G`, min: `${Math.min(s.ramMin, s.ramMax)}G` },
      window: { width: Number(s.width) || 854, height: Number(s.height) || 480, fullscreen: !!s.fullscreen },
      customArgs: (s.jvmArgs || '').split(/\s+/).filter(Boolean),
    });
    if (!proc) throw new Error('Не удалось запустить процесс игры (см. консоль)');
    setPresence('playing', s, new Date());
    const cur = loadSettings(); const cb = cur.builds.find((x) => x.id === curBuild.id);
    if (cb) { cb.lastPlayed = Date.now(); saveSettings(cur); }
    status('Игра запущена', 100);
    if (s.afterLaunch === 'minimize' && win) win.minimize();
    return { ok: true };
  } catch (e) {
    running = false;
    return { ok: false, error: errText(e) };
  }
}

/* ---------- Версии Minecraft ---------- */
let manifestCache = null;
async function listVersions(snapshots) {
  if (!manifestCache) manifestCache = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  return manifestCache.versions.filter((v) => v.type === 'release' || (snapshots && v.type === 'snapshot')).map((v) => v.id);
}

/* ---------- Modrinth ---------- */
const MR = 'https://api.modrinth.com/v2';
const q = encodeURIComponent;
function modsDir() { const s = loadSettings(); const d = path.join(buildDir(s, activeBuild(s)), 'mods'); fs.mkdirSync(d, { recursive: true }); return d; }
async function installProject(pid, mc, loader, dir, seen, out, isDep) {
  if (seen.has(pid)) return;
  seen.add(pid);
  const vs = await getJson(`${MR}/project/${pid}/version?game_versions=${q(JSON.stringify([mc]))}&loaders=${q(JSON.stringify([loader]))}`);
  if (!vs.length) { if (isDep) return; throw new Error(`Нет версии мода под ${mc} (${loader})`); }
  const v = vs[0];
  const file = v.files.find((f) => f.primary) || v.files[0];
  const dest = path.join(dir, path.basename(file.filename));
  if (!fs.existsSync(dest)) {
    const r = await fetch(file.url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`Не удалось скачать ${file.filename}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (file.hashes && file.hashes.sha1 && sha1buf(buf) !== file.hashes.sha1) throw new Error(`Хеш не совпал: ${file.filename}`);
    fs.writeFileSync(dest, buf);
  }
  out.push(path.basename(file.filename));
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id) await installProject(d.project_id, mc, loader, dir, seen, out, true);
  }
}

/* ---------- Скин (голова для аватара) ---------- */
const skinCache = new Map();
async function skinDataUrl({ uuid, name }) {
  try {
    if (!uuid && name) uuid = (await getJson(`https://api.mojang.com/users/profiles/minecraft/${q(name)}`)).id;
    if (!uuid) return null;
    if (skinCache.has(uuid)) return skinCache.get(uuid);
    const prof = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
    const prop = (prof.properties || []).find((p) => p.name === 'textures');
    const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString());
    const url = tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
    if (!url || new URL(url).hostname !== 'textures.minecraft.net') return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = 'data:image/png;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
    skinCache.set(uuid, data);
    return data;
  } catch { return null; }
}

/* ---------- Сборки и импорт ---------- */
const importMsg = (text, percent = null) => send('import', { text, percent });
const safeJoin = (base, rel) => {
  const d = path.resolve(base, rel);
  if (d !== path.resolve(base) && !d.startsWith(path.resolve(base) + path.sep)) throw new Error('Небезопасный путь в архиве: ' + rel);
  return d;
};
function newBuild(s, name, mc, loader) {
  const b = { id: crypto.randomBytes(4).toString('hex'), name: String(name || 'Новая сборка').slice(0, 40), mcVersion: mc || s.mcVersion, loader: loader || 'fabric', legacy: false, lastPlayed: 0 };
  s.builds.push(b); s.activeBuild = b.id; syncFromBuild(s);
  return b;
}
function extractPrefix(zip, prefix, dir, skip = []) {
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    if (!rel || skip.some((x) => rel === x || rel.startsWith(x + '/'))) continue;
    const dest = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
}
async function downloadAll(tasks, label) {
  let done = 0;
  const failed = [];
  const queue = [...tasks];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        if (!(fs.existsSync(t.dest) && (!t.sha1 || sha1file(t.dest) === t.sha1))) {
          const r = await fetch(t.url, { headers: { 'User-Agent': UA } });
          if (!r.ok) throw new Error(String(r.status));
          const buf = Buffer.from(await r.arrayBuffer());
          if (t.sha1 && sha1buf(buf) !== t.sha1) throw new Error('hash');
          fs.mkdirSync(path.dirname(t.dest), { recursive: true });
          fs.writeFileSync(t.dest, buf);
        }
      } catch { failed.push(path.basename(t.dest)); }
      done++;
      importMsg(`${label} ${done} / ${tasks.length}`, Math.round((done / tasks.length) * 100));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return failed;
}
async function importPackFile(file) {
  const s = loadSettings();
  const zip = new AdmZip(file);
  const names = zip.getEntries().map((e) => e.entryName);
  const report = [];
  let b = null, dir = null;
  try {
    if (names.includes('modrinth.index.json')) {
      importMsg('Чтение сборки Modrinth');
      const idx = JSON.parse(zip.readAsText('modrinth.index.json'));
      const d = idx.dependencies || {};
      if (!d['fabric-loader'] && (d.forge || d.neoforge || d['quilt-loader'])) report.push('Загрузчик сборки (Forge/NeoForge/Quilt) пока не поддерживается, выбран Vanilla.');
      b = newBuild(s, idx.name, d.minecraft, d['fabric-loader'] ? 'fabric' : 'vanilla');
      dir = buildDir(s, b); fs.mkdirSync(dir, { recursive: true });
      const tasks = (idx.files || [])
        .filter((f) => !(f.env && f.env.client === 'unsupported') && f.downloads && f.downloads[0])
        .map((f) => ({ url: f.downloads[0], dest: safeJoin(dir, f.path), sha1: f.hashes && f.hashes.sha1 }));
      const failed = await downloadAll(tasks, 'Скачивание файлов');
      if (failed.length) report.push(`Не скачались: ${failed.join(', ')}`);
      extractPrefix(zip, 'overrides/', dir);
      extractPrefix(zip, 'client-overrides/', dir);
    } else if (names.includes('manifest.json')) {
      importMsg('Чтение сборки CurseForge');
      const m = JSON.parse(zip.readAsText('manifest.json'));
      const mls = (m.minecraft && m.minecraft.modLoaders) || [];
      const ml = mls.find((l) => l.primary) || mls[0];
      const fabric = !!(ml && ml.id.startsWith('fabric'));
      if (ml && !fabric) report.push(`Загрузчик ${ml.id} пока не поддерживается, выбран Vanilla.`);
      b = newBuild(s, m.name, m.minecraft.version, fabric ? 'fabric' : 'vanilla');
      dir = buildDir(s, b); fs.mkdirSync(dir, { recursive: true });
      extractPrefix(zip, (m.overrides || 'overrides') + '/', dir);
      const ids = (m.files || []).map((f) => f.fileID);
      if (ids.length && !s.curseKey) report.push(`Моды CurseForge (${ids.length}) не скачаны: добавь CurseForge API-ключ в настройках и импортируй сборку снова.`);
      else if (ids.length) {
        const r = await fetch('https://api.curseforge.com/v1/mods/files', {
          method: 'POST',
          headers: { 'x-api-key': s.curseKey, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ fileIds: ids }),
        });
        if (!r.ok) throw new Error(`CurseForge API: ${r.status} (проверь ключ)`);
        const data = (await r.json()).data || [];
        const tasks = data.filter((f) => f.downloadUrl).map((f) => ({
          url: f.downloadUrl,
          dest: safeJoin(dir, path.join(/\.jar$/i.test(f.fileName) ? 'mods' : 'resourcepacks', path.basename(f.fileName))),
          sha1: ((f.hashes || []).find((h) => h.algo === 1) || {}).value,
        }));
        const noUrl = data.filter((f) => !f.downloadUrl).map((f) => f.fileName);
        const failed = await downloadAll(tasks, 'Скачивание модов');
        if (failed.length) report.push(`Не скачались: ${failed.join(', ')}`);
        if (noUrl.length) report.push(`Авторы запретили скачивание через API, скачай вручную: ${noUrl.join(', ')}`);
      }
    } else if (names.some((n) => /(^|\/)mmc-pack\.json$/.test(n))) {
      importMsg('Чтение сборки MultiMC / Prism');
      const pack = names.find((n) => /(^|\/)mmc-pack\.json$/.test(n));
      const root = pack.slice(0, pack.length - 'mmc-pack.json'.length);
      const mp = JSON.parse(zip.readAsText(pack));
      const comp = (uid) => (mp.components || []).find((c) => c.uid === uid);
      const mc = comp('net.minecraft') && comp('net.minecraft').version;
      const fabric = !!comp('net.fabricmc.fabric-loader');
      if (!fabric && (comp('net.minecraftforge') || comp('net.neoforged') || comp('org.quiltmc.quilt-loader'))) report.push('Загрузчик сборки (Forge/NeoForge/Quilt) пока не поддерживается, выбран Vanilla.');
      const cfg = zip.getEntry(root + 'instance.cfg') ? zip.readAsText(root + 'instance.cfg') : '';
      const nm = (cfg.match(/^name=(.*)$/m) || [])[1];
      b = newBuild(s, nm || path.basename(file, path.extname(file)), mc, fabric ? 'fabric' : 'vanilla');
      dir = buildDir(s, b); fs.mkdirSync(dir, { recursive: true });
      const prefix = names.some((n) => n.startsWith(root + '.minecraft/')) ? root + '.minecraft/' : root + 'minecraft/';
      extractPrefix(zip, prefix, dir, ['logs', 'crash-reports', 'versions', 'libraries', 'assets']);
    } else {
      throw new Error('Неизвестный формат архива. Поддерживаются .mrpack, CurseForge .zip и MultiMC/Prism .zip');
    }
    saveSettings(s);
    return { name: b.name, report };
  } catch (e) {
    if (dir && b && !b.legacy) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
function importFolder(src) {
  const s = loadSettings();
  const base = ['.minecraft', 'minecraft'].map((n) => path.join(src, n)).find((p) => fs.existsSync(p)) || src;
  let mc = s.mcVersion, loader = 'fabric';
  const report = [];
  try {
    for (const v of fs.readdirSync(path.join(base, 'versions'))) {
      const m = v.match(/^fabric-loader-[\d.]+-(\d+\.\d+(?:\.\d+)?)$/);
      if (m) { mc = m[1]; loader = 'fabric'; break; }
      if (/^\d+\.\d+(\.\d+)?$/.test(v)) { mc = v; loader = 'vanilla'; }
    }
  } catch { report.push('Версию игры определить не удалось, проверь её на главном экране.'); }
  const b = newBuild(s, path.basename(src), mc, loader);
  const dir = buildDir(s, b);
  fs.mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const n of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt', 'servers.dat']) {
    const from = path.join(base, n);
    if (fs.existsSync(from)) { fs.cpSync(from, path.join(dir, n), { recursive: true }); copied++; }
  }
  if (!copied) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('В папке нет модов, конфигов или настроек для импорта.'); }
  saveSettings(s);
  return { name: b.name, report };
}

/* ---------- Автообновление ---------- */
let updater = null;
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    autoUpdater.on('update-available', (i) => send('update', { state: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => send('update', { state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => send('update', { state: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => console.log('Обновление:', e && e.message));
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) { console.log('Автообновление недоступно:', e.message); }
}

/* ---------- Окно и IPC ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 980, minHeight: 640,
    backgroundColor: '#050505', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  win.webContents.once('did-finish-load', () => setTimeout(initUpdater, 2500));
  initRpc();
  setInterval(() => { if (!rpc) initRpc(); }, 30000);
  ipcMain.handle('update:install', () => { if (updater) updater.quitAndInstall(); });

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('skin:get', (_e, who) => skinDataUrl(who || {}));
  ipcMain.handle('builds:create', () => { const s = loadSettings(); newBuild(s, `Сборка ${s.builds.length + 1}`); saveSettings(s); return publicSettings(s); });
  ipcMain.handle('builds:select', (_e, id) => {
    const s = loadSettings();
    if (!running && s.builds.some((b) => b.id === id)) s.activeBuild = id;
    syncFromBuild(s); saveSettings(s);
    return publicSettings(s);
  });
  ipcMain.handle('builds:delete', (_e, id) => {
    const s = loadSettings();
    const b = s.builds.find((x) => x.id === id);
    if (running || s.builds.length < 2 || !b) return publicSettings(s);
    s.builds = s.builds.filter((x) => x.id !== id);
    if (!b.legacy && /^[0-9a-f]{8}$/.test(b.id)) { try { fs.rmSync(buildDir(s, b), { recursive: true, force: true }); } catch {} }
    if (s.activeBuild === id) s.activeBuild = s.builds[0].id;
    syncFromBuild(s); saveSettings(s);
    return publicSettings(s);
  });
  ipcMain.handle('builds:importFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Сборки', extensions: ['mrpack', 'zip'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try { const x = await importPackFile(r.filePaths[0]); return { ok: true, ...x, settings: publicSettings() }; }
    catch (e) { return { ok: false, error: errText(e) }; }
  });
  ipcMain.handle('builds:importFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try { const x = importFolder(r.filePaths[0]); return { ok: true, ...x, settings: publicSettings() }; }
    catch (e) { return { ok: false, error: errText(e) }; }
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = loadSettings();
    for (const k of Object.keys(patch || {})) {
      if (!USER_KEYS.includes(k)) continue;
      if (k === 'accountType' && patch[k] === 'microsoft' && !s.msRefresh) continue;
      s[k] = patch[k];
    }
    const ab = activeBuild(s);
    if ('build' in (patch || {})) ab.name = String(patch.build || '').slice(0, 40);
    if ('mcVersion' in (patch || {})) ab.mcVersion = patch.mcVersion;
    if ('loader' in (patch || {})) ab.loader = patch.loader;
    saveSettings(s);
    return publicSettings(s);
  });
  ipcMain.handle('game:launch', () => launchGame(loadSettings()));
  ipcMain.handle('game:folder', () => { const s = loadSettings(); const d = buildDir(s, activeBuild(s)); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
  ipcMain.handle('game:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return publicSettings();
    const s = loadSettings(); s.gameDir = r.filePaths[0]; saveSettings(s);
    return publicSettings(s);
  });

  ipcMain.handle('auth:login', async () => {
    try {
      const xbox = await new Auth('select_account').launch('electron');
      const token = await xbox.getMinecraft();
      const s = { ...loadSettings(), msRefresh: enc(xbox.save()), msName: token.profile.name, msUuid: token.profile.id, accountType: 'microsoft' };
      saveSettings(s);
      return { ok: true, settings: publicSettings(s) };
    } catch (e) { return { ok: false, error: errText(e) }; }
  });
  ipcMain.handle('auth:logout', () => {
    const s = { ...loadSettings(), msRefresh: '', msName: '', msUuid: '', accountType: 'offline' };
    saveSettings(s);
    return publicSettings(s);
  });

  ipcMain.handle('versions:list', async (_e, snapshots) => {
    try { return { ok: true, versions: await listVersions(!!snapshots) }; }
    catch (e) { return { ok: false, error: errText(e) }; }
  });

  ipcMain.handle('mods:search', async (_e, query) => {
    try {
      const s = loadSettings();
      if (s.loader !== 'fabric') return { ok: false, error: 'Моды из Modrinth ставятся для Fabric. Выбери загрузчик Fabric на главном экране.' };
      const facets = [['project_type:mod'], [`versions:${s.mcVersion}`], ['categories:fabric']];
      const data = await getJson(`${MR}/search?query=${q(query || '')}&facets=${q(JSON.stringify(facets))}&limit=20&index=${query ? 'relevance' : 'downloads'}`);
      return { ok: true, hits: data.hits.map((h) => ({ id: h.project_id, title: h.title, author: h.author, description: h.description, icon: h.icon_url, downloads: h.downloads })) };
    } catch (e) { return { ok: false, error: errText(e) }; }
  });
  ipcMain.handle('mods:install', async (_e, projectId) => {
    try {
      const s = loadSettings();
      const out = [];
      await installProject(String(projectId), s.mcVersion, 'fabric', modsDir(), new Set(), out, false);
      return { ok: true, files: out };
    } catch (e) { return { ok: false, error: errText(e) }; }
  });
  ipcMain.handle('mods:list', () => {
    const dir = modsDir();
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jar')).map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
  });
  ipcMain.handle('mods:remove', (_e, name) => {
    const f = path.join(modsDir(), path.basename(String(name)));
    if (f.endsWith('.jar') && fs.existsSync(f)) fs.unlinkSync(f);
    return true;
  });
});
app.on('window-all-closed', () => app.quit());
