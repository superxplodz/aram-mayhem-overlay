const { contextBridge, ipcRenderer } = require('electron');

const on = ch => cb => ipcRenderer.on(ch, (_e, p) => cb(p));
contextBridge.exposeInMainWorld('overlay', {
  onState: on('state'),
  onData: on('data'),
  onLoading: on('loading'),
  onOffer: on('offer'),
  onBadges: on('badges'),
  onTaken: on('taken'),
  onSituation: on('situation'),
  toggleTaken: id => ipcRenderer.send('taken-toggle', id),
  champions: () => ipcRenderer.invoke('champions'),
  pick: q => ipcRenderer.send('pick', q),
  tab: t => ipcRenderer.send('tab', t),
  pauseKeys: () => ipcRenderer.send('keys-pause'),
  setKey: (which, accel) => ipcRenderer.send('set-key', which, accel),
  onKeyError: on('key-error'),
  toggleReadCards: () => ipcRenderer.send('read-cards-toggle'),
  readCards: () => ipcRenderer.send('read-cards'),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit')
});
