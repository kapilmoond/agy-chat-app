const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = 39112

function bridgeRoot(app) {
  const packed = path.join(process.resourcesPath || '', 'whatsapp-bridge')
  const dev = path.join(__dirname, '..', 'whatsapp-bridge')
  if (fs.existsSync(path.join(packed, 'bridge.js'))) return packed
  return dev
}

function sessionDir(userData) {
  return path.join(userData, 'whatsapp-session')
}

function findNode() {
  const candidates = [
    process.env.npm_node_execpath,
    process.env.NODE_EXE,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe')
  ].filter(Boolean)
  for (const item of candidates) {
    if (item && fs.existsSync(item)) return item
  }
  return ''
}

function spawnBridge(app, userData, extraArgs, envExtra = {}) {
  const root = bridgeRoot(app)
  const script = path.join(root, 'bridge.js')
  const session = sessionDir(userData)
  fs.mkdirSync(session, { recursive: true })
  const args = [script, '--session', session, '--port', String(PORT), '--mode', 'self-chat', ...extraArgs]
  const node = findNode()
  const cmd = node || process.execPath
  const env = {
    ...process.env,
    WHATSAPP_MODE: 'self-chat',
    WHATSAPP_DM_POLICY: 'allowlist',
    WHATSAPP_REPLY_PREFIX: '*Aakalan Agy*\n────────────\n'
  }
  if (!node) env.ELECTRON_RUN_AS_NODE = '1'
  Object.assign(env, envExtra)
  return spawn(cmd, args, {
    cwd: root,
    env,
    windowsHide: true
  })
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

  async startPairing() {
    this.stopPairing()
    this.qr = null
    this.lastError = ''
    this.pairProc = spawnBridge(this.app, this.userData, ['--pair-only', '--pair-json'])
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
      this.lastError = String(chunk).slice(-400)
    })
    this.pairProc.on('close', () => {
      this.pairProc = null
      if (fs.existsSync(path.join(sessionDir(this.userData), 'creds.json'))) {
        this.startBridge()
      }
    })
    return this.status()
  }

  startBridge() {
    this.stopBridge()
    this.bridgeProc = spawnBridge(this.app, this.userData, [])
    this.connected = true
    this.qr = null
    this.onEvent({ type: 'connected' })
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
      try {
        this.pairProc.kill()
      } catch {
        /* ignore */
      }
      this.pairProc = null
    }
  }

  stopBridge() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.bridgeProc) {
      try {
        this.bridgeProc.kill()
      } catch {
        /* ignore */
      }
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
