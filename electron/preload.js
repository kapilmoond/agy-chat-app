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
  finishSetup: () => ipcRenderer.invoke('finish-setup')
})
