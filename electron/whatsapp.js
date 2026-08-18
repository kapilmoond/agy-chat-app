const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = 39112

function packedRoot() {
  const packed = path.join(process.resourcesPath || '', 'whatsapp-bridge')
  const dev = path.join(__dirname, '..', 'whatsapp-bridge')
  if (fs.existsSync(path.join(packed, 'bridge.js'))) return packed
  return dev
}

function sessionDir(userData) {
  return path.join(userData, 'whatsapp-session')
}

function findNode() {
  const tries = []
  try {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (found.status === 0) {
      found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => tries.push(line))
    }
  } catch {
    /* ignore */
  }
  tries.push(
    process.env.NODE_EXE,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'aakalan', 'node', 'node.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'node.exe')
  )
  for (const item of tries.filter(Boolean)) {
    if (fs.existsSync(item) && !item.toLowerCase().includes('electron')) return item
  }
  return ''
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function ensureBridge(userData) {
  const src = packedRoot()
  const dest = path.join(userData, 'whatsapp-bridge')
  fs.mkdirSync(dest, { recursive: true })
  for (const name of ['bridge.js', 'bridge_helpers.js', 'allowlist.js', 'outbound_ids.js', 'owner_message_gate.js', 'package.json']) {
    const from = path.join(src, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name))
  }
  const destMods = path.join(dest, 'node_modules')
  const srcMods = path.join(src, 'node_modules')
  if (!fs.existsSync(path.join(destMods, '@whiskeysockets', 'baileys'))) {
    if (fs.existsSync(path.join(srcMods, '@whiskeysockets', 'baileys'))) {
      copyDir(srcMods, destMods)
    }
  }
  if (!fs.existsSync(path.join(destMods, '@whiskeysockets', 'baileys'))) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const install = spawnSync(npm, ['install', '--omit=dev'], {
      cwd: dest,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000
    })
    if (install.status !== 0) {
      throw new Error(
        (install.stderr || install.stdout || 'npm install failed').slice(-500)
      )
    }
  }
  if (!fs.existsSync(path.join(destMods, '@whiskeysockets', 'baileys'))) {
    throw new Error('WhatsApp libraries are missing. Reinstall Aakalan Agy or install Node.js, then try Connect again.')
  }
  return dest
}

function spawnBridge(userData, extraArgs) {
  const root = ensureBridge(userData)
  const node = findNode()
  if (!node) {
    throw new Error('Node.js was not found. Install it from https://nodejs.org then click Connect WhatsApp again.')
  }
  const session = sessionDir(userData)
  fs.mkdirSync(session, { recursive: true })
  const args = [path.join(root, 'bridge.js'), '--session', session, '--port', String(PORT), '--mode', 'self-chat', ...extraArgs]
  return spawn(node, args, {
    cwd: root,
    env: {
      ...process.env,
      WHATSAPP_MODE: 'self-chat',
      WHATSAPP_DM_POLICY: 'allowlist',
      WHATSAPP_REPLY_PREFIX: '*Aakalan Agy*\n────────────\n'
    },
    windowsHide: true
  })
}

function killTree(proc) {
  if (!proc || !proc.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {}
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : null)
          } catch {
            resolve(raw)
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(20000, () => {
      req.destroy(new Error('WhatsApp bridge timeout'))
    })
    if (data) req.write(data)
    req.end()
  })
}

class WhatsAppService {
  constructor({ app, userData, onEvent, onIncoming }) {
    this.app = app
    this.userData = userData
    this.onEvent = onEvent
    this.onIncoming = onIncoming
    this.pairProc = null
    this.bridgeProc = null
    this.pollTimer = null
    this.qr = null
    this.connected = false
    this.lastError = ''
  }

  status() {
    const creds = path.join(sessionDir(this.userData), 'creds.json')
    return {
      connected: this.connected,
      hasSession: fs.existsSync(creds),
      qr: this.qr,
      error: this.lastError
    }
  }

  async waitHealthy(tries = 16) {
    for (let i = 0; i < tries; i += 1) {
      try {
        await httpJson('GET', '/health')
        return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    return false
  }

  async startPairing() {
    this.stopPairing()
    this.qr = null
    this.lastError = ''
    try {
      this.pairProc = spawnBridge(this.userData, ['--pair-only', '--pair-json'])
    } catch (error) {
      this.lastError = error.message
      this.onEvent({ type: 'error', error: this.lastError })
      return this.status()
    }
    this.pairProc.on('error', (error) => {
      this.lastError = error.message
      this.onEvent({ type: 'error', error: this.lastError })
    })
    this.pairProc.stdout.on('data', (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .forEach((line) => {
          const text = line.trim()
          if (!text.startsWith('{')) return
          try {
            const event = JSON.parse(text)
            if (event.event === 'qr' && event.qr) {
              this.qr = event.qr
              this.onEvent({ type: 'qr', qr: event.qr })
            }
            if (event.event === 'connected' || event.status === 'connected') {
              this.connected = true
              this.qr = null
              this.onEvent({ type: 'paired' })
            }
          } catch {
            /* ignore */
          }
        })
    })
    this.pairProc.stderr.on('data', (chunk) => {
      this.lastError = String(chunk).slice(-600)
    })
    this.pairProc.on('close', (code) => {
      this.pairProc = null
      if (fs.existsSync(path.join(sessionDir(this.userData), 'creds.json'))) {
        this.startBridge()
        return
      }
      if (!this.qr) {
        this.lastError = this.lastError || `WhatsApp setup stopped (code ${code}).`
        this.onEvent({ type: 'error', error: this.lastError })
      }
    })
    return this.status()
  }

  startBridge() {
    this.stopBridge()
    try {
      this.bridgeProc = spawnBridge(this.userData, [])
    } catch (error) {
      this.lastError = error.message
      this.onEvent({ type: 'error', error: this.lastError })
      return
    }
    this.bridgeProc.stderr.on('data', (chunk) => {
      this.lastError = String(chunk).slice(-600)
    })
    this.qr = null
    this.waitHealthy().then((ok) => {
      this.connected = ok
      if (ok) this.onEvent({ type: 'connected' })
      else {
        this.lastError = this.lastError || 'WhatsApp bridge started but did not become ready.'
        this.onEvent({ type: 'error', error: this.lastError })
      }
    })
    this.pollTimer = setInterval(() => {
      this.drain().catch((error) => {
        this.lastError = error.message
      })
    }, 2500)
  }

  async drain() {
    const msgs = await httpJson('GET', '/messages')
    if (!Array.isArray(msgs) || !msgs.length) return
    for (const msg of msgs) {
      const text = String(msg.body || msg.text || '').trim()
      if (!text) continue
      await this.onIncoming(msg)
    }
  }

  async send(chatId, message) {
    return httpJson('POST', '/send', { chatId, message })
  }

  stopPairing() {
    if (this.pairProc) {
      killTree(this.pairProc)
      this.pairProc = null
    }
  }

  stopBridge() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.bridgeProc) {
      killTree(this.bridgeProc)
      this.bridgeProc = null
    }
    this.connected = false
  }

  disconnect() {
    this.stopPairing()
    this.stopBridge()
    const dir = sessionDir(this.userData)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    this.qr = null
    this.lastError = ''
    this.onEvent({ type: 'disconnected' })
    return this.status()
  }
}

module.exports = { WhatsAppService, PORT }
