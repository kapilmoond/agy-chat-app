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
  whatsappSendFile: () => ipcRenderer.invoke('whatsapp-send-file'),
  googleStatus: () => ipcRenderer.invoke('google-status'),
  googlePickJson: () => ipcRenderer.invoke('google-pick-json'),
  googleFromText: (text) => ipcRenderer.invoke('google-from-text', text),
  googleDisconnect: () => ipcRenderer.invoke('google-disconnect'),
  onWhatsApp: (fn) => {
    ipcRenderer.removeAllListeners('whatsapp-event')
    ipcRenderer.on('whatsapp-event', (_event, data) => fn(data))
  },
  stopChat: () => ipcRenderer.invoke('stop-chat'),
  deleteSession: (id) => ipcRenderer.invoke('delete-session', id),
  onChatUpdated: (fn) => {
    ipcRenderer.removeAllListeners('chat-updated')
    ipcRenderer.on('chat-updated', (_event, data) => fn(data))
  }
})
