const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const memory = require('./memory')
const { WhatsAppService } = require('./whatsapp')
const { GoogleWorkspace, looksLikeClientJson, looksLikeCallbackUrl } = require('./google')

const HOME = os.homedir()
const AGY_DEFAULT = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'agy', 'bin', 'agy.EXE')
const ACCOUNTS_FILE = path.join(HOME, '.gemini', 'google_accounts.json')
const OAUTH_FILE = path.join(HOME, '.gemini', 'oauth_creds.json')

function stateDir() {
  return path.join(app.getPath('userData'), 'state')
}

function configPath() {
  return path.join(stateDir(), 'config.json')
}

function sessionsPath() {
  return path.join(stateDir(), 'sessions.json')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function loadConfig() {
  const loaded = readJson(configPath(), {})
  const fallback = memory.defaultWorkspace()
  const workspace = loaded.workspace && !memory.isUnsafeWorkspace(loaded.workspace)
    ? loaded.workspace
    : fallback
  return Object.assign(
    {
      setupDone: false,
      workspace: fallback,
      model: ''
    },
    loaded,
    { workspace }
  )
}

function saveConfig(cfg) {
  writeJson(configPath(), cfg)
}

function loadSessions() {
  const data = readJson(sessionsPath(), { sessions: [] })
  if (!Array.isArray(data.sessions)) data.sessions = []
  return data
}

function saveSessions(data) {
  writeJson(sessionsPath(), data)
}

function findAgy() {
  const candidates = [
    process.env.AGY_BIN,
    AGY_DEFAULT,
    path.join(HOME, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    'agy'
  ].filter(Boolean)
  for (const item of candidates) {
    if (item === 'agy') {
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], { encoding: 'utf8' })
      if (which.status === 0 && which.stdout.trim()) return which.stdout.split(/\r?\n/)[0].trim()
      continue
    }
    if (fs.existsSync(item)) return item
  }
  return ''
}

function signedInEmail() {
  const accounts = readJson(ACCOUNTS_FILE, null)
  if (accounts && typeof accounts.active === 'string' && accounts.active.includes('@')) {
    return accounts.active
  }
  if (fs.existsSync(OAUTH_FILE)) return 'Google account connected'
  return ''
}

function extractReply(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', conversationId: null }
  const tryParse = (block) => {
    try {
      const parsed = JSON.parse(block)
      const text = parsed.response || parsed.result || parsed.text || ''
      const conversationId = parsed.conversation_id || parsed.conversationId || null
      if (text) return { text: String(text).trim(), conversationId }
    } catch {
      return null
    }
    return null
  }
  const whole = tryParse(raw)
  if (whole) return whole
  for (const line of raw.split(/\r?\n/)) {
    const hit = tryParse(line.trim())
    if (hit) return hit
  }
  return { text: raw, conversationId: null }
}

function runAgy(args, opts = {}) {
  const exe = findAgy()
  if (!exe) {
    const err = new Error('agy is not installed')
    err.code = 'NO_AGY'
    throw err
  }
  const workspace = opts.cwd || loadConfig().workspace || HOME
  fs.mkdirSync(workspace, { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: workspace,
      windowsHide: opts.hide !== false,
      env: process.env
    })
    currentAgy = child
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill()
      }
      reject(new Error('agy timed out'))
    }, opts.timeoutMs || 5 * 60 * 1000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (currentAgy === child) currentAgy = null
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (currentAgy === child) currentAgy = null
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `agy exited ${code}`))
        return
      }
      resolve({ stdout, stderr, code })
    })
  })
}

function listModels() {
  try {
    const result = spawnSync(findAgy() || 'agy', ['models'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true
    })
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.toLowerCase().startsWith('fetching'))
    return lines.map((line) => {
      const [id, ...rest] = line.split(/\s+/)
      return { id, label: rest.join(' ') || id }
    })
  } catch {
    return []
  }
}

function getStatus() {
  const cfg = loadConfig()
  const email = signedInEmail()
  const agyPath = findAgy()
  return {
    agyPath,
    agyOk: Boolean(agyPath),
    signedIn: Boolean(email),
    email,
    workspace: cfg.workspace,
    setupDone: Boolean(cfg.setupDone && agyPath && email),
    models: agyPath ? listModels() : [],
    whatsapp: whatsapp ? whatsapp.status() : { connected: false, hasSession: false, qr: null },
    workspaceGoogle: googleWs ? googleWs.status() : { connected: false, email: '' },
    memory: memory.readMemory(app.getPath('userData'))
  }
}

function inboxDir() {
  const folder = path.join(loadConfig().workspace || HOME, 'agy-inbox')
  fs.mkdirSync(folder, { recursive: true })
  return folder
}

function voiceInboxDir() {
  const folder = path.join(inboxDir(), 'whatsapp-voice')
  fs.mkdirSync(folder, { recursive: true })
  return folder
}

function stampName() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

function isAudioPath(file) {
  return /\.(ogg|opus|mp3|wav|m4a|aac|flac|webm|mp4)$/i.test(String(file || ''))
}

function convertVoiceForAgy(src) {
  const dest = src.replace(/\.[^.]+$/, '') + '.wav'
  if (dest === src) return src
  const ffmpeg = spawnSync('ffmpeg', ['-y', '-i', src, '-ac', '1', '-ar', '16000', dest], {
    windowsHide: true,
    timeout: 45000
  })
  if (ffmpeg.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 100) return dest
  return src
}

function saveWhatsAppVoice(urls) {
  const destDir = voiceInboxDir()
  const saved = []
  for (const src of urls || []) {
    if (!src || !fs.existsSync(src)) continue
    const ext = path.extname(src) || '.ogg'
    const dest = path.join(destDir, `whatsapp-voice-${stampName()}${ext}`)
    fs.copyFileSync(src, dest)
    saved.push(convertVoiceForAgy(dest))
  }
  return saved
}

function copyIncomingFiles(urls) {
  const destDir = inboxDir()
  const out = []
  for (const src of urls || []) {
    if (!src || !fs.existsSync(src)) continue
    const dest = path.join(destDir, `${Date.now()}-${path.basename(src)}`)
    try {
      fs.copyFileSync(src, dest)
      out.push(dest)
    } catch {
      out.push(src)
    }
  }
  return out
}

function extractOutgoingFiles(text, extra = []) {
  const found = extra.filter((item) => item && fs.existsSync(item))
  const workspace = loadConfig().workspace || HOME
  const matches = String(text || '').match(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>|*?]+/g) || []
  for (const raw of matches) {
    const clean = raw.replace(/[.,);]+$/, '')
    if (fs.existsSync(clean) && fs.statSync(clean).isFile()) found.push(clean)
  }
  const rel = String(text || '').match(/(?:SEND_FILE|FILE):\s*(.+)/gi) || []
  for (const line of rel) {
    const name = line.replace(/^(SEND_FILE|FILE):\s*/i, '').trim().replace(/^["']|["']$/g, '')
    const abs = path.isAbsolute(name) ? name : path.join(workspace, name)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) found.push(abs)
  }
  return [...new Set(found)]
}

function buildPrompt(userText, attachments) {
  const parts = []
  const brief = memory.brief(app.getPath('userData'))
  if (brief) {
    parts.push('Core memory (follow this):\n' + brief)
  }
  if (googleWs && googleWs.status().connected) {
    const gs = googleWs.status()
    parts.push(
      'Google Workspace is connected as ' +
        gs.email +
        '. Token file (do not print): ' +
        googleWs.files().tokens +
        '. Use Gmail, Drive, Calendar, Docs, Sheets when asked.'
    )
  }
  if (attachments && attachments.length) {
    const audio = attachments.filter((item) => isAudioPath(item))
    const other = attachments.filter((item) => !audioExt.test(item))
    if (audio.length) {
      parts.push(
        'Audio files are on disk. Transcribe them first, then answer.\n' +
          audio.map((item) => `- ${item}`).join('\n')
      )
    }
    if (other.length) {
      parts.push('Attached files on disk (read them if needed):\n' + other.map((item) => `- ${item}`).join('\n'))
    }
  }
  parts.push('User:\n' + userText)
  return parts.join('\n\n')
}

let mainWindow = null
let chatBusy = false
let currentAgy = null
let whatsapp = null
let googleWs = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Aakalan Agy',
    backgroundColor: '#0f1720',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, '..', 'web', 'index.html'))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  if (!gotLock) return
  fs.mkdirSync(stateDir(), { recursive: true })
  const cfg = loadConfig()
  fs.mkdirSync(cfg.workspace, { recursive: true })
  if (!readJson(configPath(), {}).workspace || memory.isUnsafeWorkspace(readJson(configPath(), {}).workspace)) {
    saveConfig(cfg)
  }
  memory.ensureMemory(app.getPath('userData'))
  memory.syncWorkspaceMemory(app.getPath('userData'), cfg.workspace)
  googleWs = new GoogleWorkspace(app.getPath('userData'), cfg.workspace)
  whatsapp = new WhatsAppService({
    app,
    userData: app.getPath('userData'),
    onEvent: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whatsapp-event', event)
      }
    },
    onIncoming: async (msg) => {
      const isVoice =
        /ptt|audio/i.test(String(msg.mediaType || '')) ||
        /^audio\//i.test(String(msg.mime || '')) ||
        (msg.mediaUrls || []).some((item) => isAudioPath(item))
      const files = isVoice ? saveWhatsAppVoice(msg.mediaUrls || []) : copyIncomingFiles(msg.mediaUrls || [])
      const text = String(msg.body || '').trim()
      if (!text && !files.length) return
      const store = loadSessions()
      let session = store.sessions.find((item) => item.id === 'whatsapp')
      if (!session) {
        session = {
          id: 'whatsapp',
          title: 'WhatsApp',
          conversation_id: null,
          model: '',
          created: Date.now(),
          messages: []
        }
        store.sessions.unshift(session)
      }
      const from = msg.senderName || msg.senderId || 'WhatsApp'
      const shown = isVoice
        ? 'WhatsApp voice note saved: ' + (files[0] || 'file missing')
        : text || '[file]'
      session.messages.push({ role: 'user', content: from + ': ' + shown, ts: Date.now() })
      saveSessions(store)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat-updated', session)
      }
      try {
        const voicePath = files[0] || ''
        const prompt = isVoice
          ? buildPrompt(
              [
                'A voice message arrived from WhatsApp.',
                'The app saved it on this computer.',
                'Read the audio file at this exact path and convert the speech to text:',
                voicePath,
                'This voice message is from WhatsApp.',
                '1. Transcribe the audio to text.',
                '2. Then answer what the speaker asked.',
                '3. Keep the WhatsApp reply short.',
                text && !/^\[/.test(text) ? 'Caption: ' + text : ''
              ]
                .filter(Boolean)
                .join('\n'),
              files
            )
          : buildPrompt(
              files.length
                ? 'WhatsApp sent a file. Read it if needed and reply.\n' + (text || '')
                : 'Reply on WhatsApp. Keep it short and useful.\n\n' + text,
              files
            )
        const args = [
          '--output-format',
          'json',
          '--print-timeout',
          '5m',
          '--add-dir',
          inboxDir(),
          '--dangerously-skip-permissions'
        ]
        if (isVoice) args.push('--add-dir', voiceInboxDir())
        if (session.conversation_id) args.push('--conversation', session.conversation_id)
        args.push('--print', prompt)
        const result = await runAgy(args, { cwd: loadConfig().workspace })
        const parsed = extractReply(result.stdout)
        if (parsed.conversationId) session.conversation_id = parsed.conversationId
        const reply = parsed.text || result.stdout || 'agy returned an empty reply.'
        if (isVoice && files[0]) {
          try {
            fs.writeFileSync(files[0].replace(/\.[^.]+$/, '') + '.txt', reply, 'utf8')
          } catch {
            /* ignore */
          }
        }
        session.messages.push({ role: 'assistant', content: reply, ts: Date.now() })
        await whatsapp.send(msg.chatId, reply)
        for (const file of extractOutgoingFiles(reply, isVoice ? [] : files)) {
          await whatsapp.sendMedia(msg.chatId, file).catch(() => {})
        }
      } catch (error) {
        const fail = 'Agy error: ' + (error.message || String(error))
        session.messages.push({ role: 'assistant', content: fail, ts: Date.now() })
        try {
          await whatsapp.send(msg.chatId, fail)
        } catch {
          /* ignore */
        }
      }
      saveSessions(store)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat-updated', session)
      }
    }
  })
  if (whatsapp.status().hasSession) {
    try {
      whatsapp.startBridge()
    } catch {
      /* connect later from UI */
    }
  }
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('status', () => getStatus())

ipcMain.handle('sessions', () => loadSessions())

ipcMain.handle('new-session', (_event, model) => {
  const store = loadSessions()
  const session = {
    id: Date.now().toString(36),
    title: 'New chat',
    conversation_id: null,
    model: model || loadConfig().model || '',
    created: Date.now(),
    messages: []
  }
  store.sessions.unshift(session)
  saveSessions(store)
  return session
})

ipcMain.handle('open-session', (_event, id) => {
  return loadSessions().sessions.find((item) => item.id === id) || null
})

ipcMain.handle('set-workspace', (_event, folder) => {
  if (!folder || !fs.existsSync(folder)) {
    throw new Error('Folder not found')
  }
  const cfg = loadConfig()
  cfg.workspace = folder
  saveConfig(cfg)
  return cfg.workspace
})

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  const cfg = loadConfig()
  cfg.workspace = result.filePaths[0]
  saveConfig(cfg)
  return cfg.workspace
})

ipcMain.handle('install-agy', async () => {
  if (findAgy()) return { ok: true, already: true, path: findAgy() }
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'],
    { windowsHide: false }
  )
  await new Promise((resolve, reject) => {
    ps.on('error', reject)
    ps.on('close', (code) => {
      if (code === 0 || findAgy()) resolve()
      else reject(new Error(`agy installer exited ${code}`))
    })
  })
  const installed = findAgy()
  if (!installed) throw new Error('Install finished but agy.exe was not found.')
  return { ok: true, path: installed }
})

ipcMain.handle('sign-in-google', async () => {
  const exe = findAgy()
  if (!exe) throw new Error('Install agy first.')
  if (signedInEmail()) return { ok: true, email: signedInEmail(), already: true }
  // First local launch opens the Google browser if no keyring session exists.
  const child = spawn(exe, ['--output-format', 'json', '--print-timeout', '8m', '--print', 'Reply with only: SIGNED IN'], {
    cwd: HOME,
    windowsHide: false
  })
  const started = Date.now()
  while (Date.now() - started < 8 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (signedInEmail()) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      return { ok: true, email: signedInEmail() }
    }
    if (child.exitCode !== null) break
  }
  if (signedInEmail()) return { ok: true, email: signedInEmail() }
  throw new Error('Google sign-in did not finish. Use Open login window and complete it there.')
})

ipcMain.handle('open-agy-login', async () => {
  const exe = findAgy()
  if (!exe) throw new Error('Install agy first.')
  spawn('cmd.exe', ['/k', `"${exe}"`], { cwd: HOME, windowsHide: false, detached: true, shell: true })
  return { ok: true }
})

ipcMain.handle('finish-setup', () => {
  const status = getStatus()
  if (!status.agyOk) throw new Error('agy is not installed')
  if (!status.signedIn) throw new Error('Sign in with Google first')
  const cfg = loadConfig()
  cfg.setupDone = true
  saveConfig(cfg)
  return getStatus()
})

ipcMain.handle('chat', async (_event, payload) => {
  if (chatBusy) throw new Error('agy is still answering.')
  const attachments = payload?.attachments || []
  const message = String(payload?.message || '').trim() || (attachments.length ? 'Please use the attached file(s).' : '')
  if (!message) throw new Error('Empty message')
  if (looksLikeClientJson(message) || looksLikeCallbackUrl(message)) {
    const store = loadSessions()
    let session = store.sessions.find((item) => item.id === payload.session_id)
    if (!session) {
      session = {
        id: Date.now().toString(36),
        title: 'Google Workspace',
        conversation_id: null,
        model: '',
        created: Date.now(),
        messages: []
      }
      store.sessions.unshift(session)
    }
    session.messages.push({
      role: 'user',
      content: looksLikeClientJson(message) ? '[Google client JSON received]' : '[localhost Google callback URL]',
      ts: Date.now()
    })
    let reply = ''
    if (looksLikeClientJson(message)) {
      const result = await googleWs.startConnect(message)
      reply = result.message + (result.authUrl ? '\n\n' + result.authUrl : '')
    } else {
      const status = await googleWs.finishUrl(message)
      reply = status.connected
        ? 'Google Workspace connected as ' + (status.email || 'your Google account') + '. Gmail, Drive, Calendar, Docs and Sheets are ready.'
        : 'Google callback was received but the account is not connected yet.'
    }
    session.messages.push({ role: 'assistant', content: reply, ts: Date.now() })
    saveSessions(store)
    return { ok: true, session, reply }
  }
  if (!getStatus().signedIn) throw new Error('Sign in with Google first')
  chatBusy = true
  try {
    const store = loadSessions()
    let session = store.sessions.find((item) => item.id === payload.session_id)
    if (!session) {
      session = {
        id: Date.now().toString(36),
        title: message.slice(0, 48),
        conversation_id: null,
        model: payload.model || '',
        created: Date.now(),
        messages: []
      }
      store.sessions.unshift(session)
    }
    session.messages.push({ role: 'user', content: message, ts: Date.now() })
    if (!session.title || session.title === 'New chat') session.title = message.slice(0, 48)
    memory.syncWorkspaceMemory(app.getPath('userData'), loadConfig().workspace)
    const args = ['--output-format', 'json', '--print-timeout', '5m']
    if (session.conversation_id) args.push('--conversation', session.conversation_id)
    if (payload.model) args.push('--model', payload.model)
    args.push('--print', buildPrompt(message, payload.attachments || []))
    const result = await runAgy(args, { cwd: loadConfig().workspace })
    const parsed = extractReply(result.stdout)
    if (parsed.conversationId) session.conversation_id = parsed.conversationId
    session.messages.push({ role: 'assistant', content: parsed.text || result.stdout, ts: Date.now() })
    saveSessions(store)
    return { ok: true, session, reply: parsed.text }
  } finally {
    chatBusy = false
  }
})

ipcMain.handle('memory-read', () => memory.readMemory(app.getPath('userData')))

ipcMain.handle('memory-write', (_event, payload) => {
  return memory.writeMemory(app.getPath('userData'), payload || {})
})

ipcMain.handle('memory-remember', (_event, line) => {
  return memory.remember(app.getPath('userData'), line)
})

ipcMain.handle('pick-files', async (_event, kind) => {
  const audio = kind === 'audio'
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: audio
      ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac', 'webm'] }]
      : [{ name: 'All files', extensions: ['*'] }]
  })
  if (result.canceled) return []
  const inbox = path.join(loadConfig().workspace || HOME, 'agy-inbox')
  fs.mkdirSync(inbox, { recursive: true })
  return result.filePaths.map((src) => {
    const dest = path.join(inbox, `${Date.now()}-${path.basename(src)}`)
    fs.copyFileSync(src, dest)
    return dest
  })
})

ipcMain.handle('whatsapp-status', () => (whatsapp ? whatsapp.status() : { connected: false }))

ipcMain.handle('whatsapp-connect', async () => {
  if (!whatsapp) throw new Error('WhatsApp service is not ready')
  return whatsapp.startPairing()
})

ipcMain.handle('whatsapp-disconnect', async () => {
  if (!whatsapp) throw new Error('WhatsApp service is not ready')
  return whatsapp.disconnect()
})

ipcMain.handle('whatsapp-send-file', async () => {
  if (!whatsapp || !whatsapp.status().connected) throw new Error('Connect WhatsApp first.')
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'All files', extensions: ['*'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { ok: false }
  const file = result.filePaths[0]
  await whatsapp.sendMedia(whatsapp.lastChatId || '', file, path.basename(file))
  return { ok: true, file }
})

ipcMain.handle('google-status', () => (googleWs ? googleWs.status() : { connected: false }))

ipcMain.handle('google-pick-json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { ok: false }
  const raw = fs.readFileSync(result.filePaths[0], 'utf8')
  return googleWs.startConnect(raw)
})

ipcMain.handle('google-from-text', async (_event, text) => {
  if (looksLikeCallbackUrl(text)) return googleWs.finishUrl(text)
  if (looksLikeClientJson(text)) return googleWs.startConnect(text)
  throw new Error('Paste the Google client JSON, or the localhost URL after sign-in.')
})

ipcMain.handle('google-disconnect', () => googleWs.disconnect())

ipcMain.handle('stop-chat', () => {
  if (currentAgy && currentAgy.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(currentAgy.pid), '/T', '/F'], { windowsHide: true })
    } else {
      currentAgy.kill()
    }
  }
  chatBusy = false
  return { ok: true }
})

ipcMain.handle('delete-session', (_event, id) => {
  const store = loadSessions()
  store.sessions = store.sessions.filter((item) => item.id !== id)
  saveSessions(store)
  return store
})
