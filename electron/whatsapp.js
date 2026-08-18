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

function credsPath(userData) {
  return path.join(sessionDir(userData), 'creds.json')
}

function hasValidCreds(userData) {
  try {
    const raw = fs.readFileSync(credsPath(userData), 'utf8')
    if (!raw || raw.trim().length < 20) return false
    const parsed = JSON.parse(raw)
    return Boolean(parsed && (parsed.me || parsed.noiseKey || parsed.signedIdentityKey))
  } catch {
    return false
  }
}

function appendLog(userData, text) {
  try {
    fs.appendFileSync(path.join(userData, 'whatsapp-bridge.log'), text, 'utf8')
  } catch {
    /* ignore */
  }
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
  const hasBaileys = (root) => fs.existsSync(path.join(root, '@whiskeysockets', 'baileys'))
  const hasQrcode = (root) => fs.existsSync(path.join(root, 'qrcode'))
  if (!hasBaileys(destMods) || !hasQrcode(destMods)) {
    if (hasBaileys(srcMods)) {
      copyDir(srcMods, destMods)
    }
  }
  if (!hasBaileys(destMods) || !hasQrcode(destMods)) {
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
      WHATSAPP_DEBUG: '1',
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
    this.qrDataUrl = ''
    this.connected = false
    this.lastError = ''
  }

  status() {
    return {
      connected: this.connected,
      hasSession: hasValidCreds(this.userData),
      qr: this.qr,
      qrDataUrl: this.qrDataUrl,
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

  attachBridgeIo(proc) {
    proc.on('error', (error) => {
      this.lastError = error.message
      this.onEvent({ type: 'error', error: this.lastError })
    })
    proc.stdout.on('data', (chunk) => {
      const text = String(chunk)
      appendLog(this.userData, text)
      text.split(/\r?\n/).forEach((line) => {
        const row = line.trim()
        if (!row.startsWith('{')) return
        try {
          const event = JSON.parse(row)
          if (event.event === 'qr' && event.qr) {
            this.qr = event.qr
            this.qrDataUrl = event.qrDataUrl || ''
            this.onEvent({ type: 'qr', qr: event.qr, qrDataUrl: this.qrDataUrl })
          }
          if (event.event === 'connected' || event.status === 'connected') {
            this.connected = true
            this.qr = null
            this.onEvent({ type: 'connected' })
          }
          if (event.event === 'error' && event.error) {
            this.lastError = String(event.error)
            this.onEvent({ type: 'error', error: this.lastError })
          }
        } catch {
          /* ignore */
        }
      })
    })
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk)
      appendLog(this.userData, text)
      this.lastError = text.slice(-600)
    })
    proc.on('close', (code) => {
      this.bridgeProc = null
      this.connected = false
      if (!this.qr) {
        this.lastError = this.lastError || `WhatsApp bridge stopped (code ${code}). Keep Aakalan Agy open.`
        this.onEvent({ type: 'error', error: this.lastError })
      }
    })
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => {
      this.drain().catch((error) => {
        this.lastError = error.message
      })
    }, 1500)
    this.waitHealthy(20).then((ok) => {
      if (ok && hasValidCreds(this.userData)) {
        this.connected = true
        this.onEvent({ type: 'connected' })
      }
    })
  }

  async startPairing() {
    this.stopPairing()
    this.stopBridge()
    this.qr = null
    this.lastError = ''
    if (!hasValidCreds(this.userData)) {
      try {
        fs.rmSync(sessionDir(this.userData), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    try {
      this.bridgeProc = spawnBridge(this.userData, ['--pair-json'])
    } catch (error) {
      this.lastError = error.message
      this.onEvent({ type: 'error', error: this.lastError })
      return this.status()
    }
    this.attachBridgeIo(this.bridgeProc)
    this.startPolling()
    return this.status()
  }

  startBridge() {
    if (!hasValidCreds(this.userData)) {
      this.lastError = 'WhatsApp session is empty. Click Connect WhatsApp and scan the QR again.'
      this.onEvent({ type: 'error', error: this.lastError })
      return
    }
    this.stopBridge()
    try {
      this.bridgeProc = spawnBridge(this.userData, ['--pair-json'])
    } catch (error) {
      this.lastError = error.message
      this.onEvent({ type: 'error', error: this.lastError })
      return
    }
    this.attachBridgeIo(this.bridgeProc)
    this.startPolling()
  }

  async drain() {
    const msgs = await httpJson('GET', '/messages')
    if (!Array.isArray(msgs) || !msgs.length) return
    for (const msg of msgs) {
      const text = String(msg.body || msg.text || '').trim()
      if (!text) continue
      try {
        await this.onIncoming(msg)
      } catch (error) {
        this.lastError = error.message
        this.onEvent({ type: 'error', error: this.lastError })
      }
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
