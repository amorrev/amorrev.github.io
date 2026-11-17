const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('astral', {
  getSettings: inv('settings:get'), setSettings: inv('settings:set'),
  launch: inv('game:launch'), openFolder: inv('game:folder'), chooseDir: inv('game:chooseDir'),
  login: inv('auth:login'), logout: inv('auth:logout'),
  versions: inv('versions:list'), skin: inv('skin:get'),
  buildsCreate: inv('builds:create'), buildsSelect: inv('builds:select'), buildsDelete: inv('builds:delete'),
  importFile: inv('builds:importFile'), importFolder: inv('builds:importFolder'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, d) => cb(d)),
  installUpdate: inv('update:install'),
  onImport: (cb) => ipcRenderer.on('import', (_e, d) => cb(d)),
  modsSearch: inv('mods:search'), modsInstall: inv('mods:install'), modsList: inv('mods:list'), modsRemove: inv('mods:remove'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onClosed: (cb) => ipcRenderer.on('closed', () => cb()),
});
