const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agy', {
  status: () => ipcRenderer.invoke('status'),
  sessions: () => ipcRenderer.invoke('sessions'),
  newSession: (model) => ipcRenderer.invoke('new-session', model),
  openSession: (id) => ipcRenderer.invoke('open-session', id),
  chat: (payload) => ipcRenderer.invoke('chat', payload),
  setWorkspace: (folder) => ipcRenderer.invoke('set-workspace', folder),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  installAgy: () => ipcRenderer.invoke('install-agy'),
  signInGoogle: () => ipcRenderer.invoke('sign-in-google'),
  openAgyLogin: () => ipcRenderer.invoke('open-agy-login'),
  finishSetup: () => ipcRenderer.invoke('finish-setup'),
  memoryRead: () => ipcRenderer.invoke('memory-read'),
  memoryWrite: (payload) => ipcRenderer.invoke('memory-write', payload),
  memoryRemember: (line) => ipcRenderer.invoke('memory-remember', line),
  pickFiles: (kind) => ipcRenderer.invoke('pick-files', kind),
  whatsappStatus: () => ipcRenderer.invoke('whatsapp-status'),
  whatsappConnect: () => ipcRenderer.invoke('whatsapp-connect'),
  whatsappDisconnect: () => ipcRenderer.invoke('whatsapp-disconnect'),
  onWhatsApp: (fn) => {
    ipcRenderer.removeAllListeners('whatsapp-event')
    ipcRenderer.on('whatsapp-event', (_event, data) => fn(data))
  }
})
