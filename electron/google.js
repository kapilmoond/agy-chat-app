const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { shell } = require('electron')

const CALLBACK_PORT = 17893
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets'
]

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

function httpsForm(urlPath, body) {
  const data = new URLSearchParams(body).toString()
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'oauth2.googleapis.com',
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw)
            if (parsed.error) reject(new Error(parsed.error_description || parsed.error))
            else resolve(parsed)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('Google token request timed out')))
    req.write(data)
    req.end()
  })
}

function httpsJson(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = https.request(
      {
        host: parsed.host,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token }
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('Google API timed out')))
    req.end()
  })
}

function parseClient(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  const block = obj.installed || obj.web || obj
  if (!block || !block.client_id || !block.client_secret) {
    throw new Error('This JSON is not a Google OAuth client file. Use Desktop app client JSON from Google Cloud.')
  }
  return {
    client_id: block.client_id,
    client_secret: block.client_secret,
    project_id: block.project_id || obj.project_id || ''
  }
}

function looksLikeClientJson(text) {
  try {
    parseClient(text)
    return true
  } catch {
    return false
  }
}

function looksLikeCallbackUrl(text) {
  const value = String(text || '').trim()
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(value)) return false
  return value.includes('code=') || value.includes('error=')
}

class GoogleWorkspace {
  constructor(userData, workspaceDir) {
    this.userData = userData
    this.workspaceDir = workspaceDir
    this.dir = path.join(userData, 'google')
    this.server = null
    this.authUrl = ''
    this.waiters = []
  }

  files() {
    return {
      client: path.join(this.dir, 'client.json'),
      tokens: path.join(this.dir, 'tokens.json'),
      profile: path.join(this.dir, 'profile.json')
    }
  }

  status() {
    const profile = readJson(this.files().profile, {})
    const tokens = readJson(this.files().tokens, {})
    return {
      connected: Boolean(tokens.refresh_token || tokens.access_token),
      email: profile.email || '',
      authUrl: this.authUrl,
      waiting: Boolean(this.server)
    }
  }

  saveClient(raw) {
    const client = parseClient(raw)
    writeJson(this.files().client, client)
    return client
  }

  async startConnect(raw) {
    const client = this.saveClient(raw)
    this.stopListen()
    const redirect = `http://127.0.0.1:${CALLBACK_PORT}/`
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true'
    })
    this.authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, redirect)
        if (!url.searchParams.get('code') && !url.searchParams.get('error')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('Aakalan Agy Google connect is waiting.')
          return
        }
        await this.finishUrl(url.toString())
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body style="font-family:Segoe UI,sans-serif;padding:32px">Aakalan Agy connected Google Workspace. You can close this tab.</body></html>')
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end(error.message)
      }
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(CALLBACK_PORT, '127.0.0.1', resolve)
    })
    await shell.openExternal(this.authUrl)
    return {
      ok: true,
      authUrl: this.authUrl,
      message:
        'Opened Google sign-in. If the browser does not return automatically, copy the localhost URL from the address bar and paste it in Aakalan Agy.'
    }
  }

  async finishUrl(urlString) {
    const url = new URL(String(urlString).trim())
    const err = url.searchParams.get('error')
    if (err) throw new Error('Google sign-in was cancelled: ' + err)
    const code = url.searchParams.get('code')
    if (!code) throw new Error('No code= in that URL. Paste the full localhost address.')
    const client = readJson(this.files().client, null)
    if (!client) throw new Error('Load the Google JSON file first.')
    const tokens = await httpsForm('/token', {
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: `http://127.0.0.1:${CALLBACK_PORT}/`,
      grant_type: 'authorization_code'
    })
    writeJson(this.files().tokens, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry: Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000,
      token_type: tokens.token_type || 'Bearer',
      scope: tokens.scope || SCOPES.join(' ')
    })
    const profile = await httpsJson('https://www.googleapis.com/oauth2/v2/userinfo', tokens.access_token)
    writeJson(this.files().profile, { email: profile.email || '', name: profile.name || '' })
    this.writeWorkspaceHint()
    this.stopListen()
    return this.status()
  }

  writeWorkspaceHint() {
    if (!this.workspaceDir) return
    const hint = path.join(this.workspaceDir, 'GOOGLE_WORKSPACE.md')
    const profile = readJson(this.files().profile, {})
    const text = `# Google Workspace (Aakalan Agy)

Connected account: ${profile.email || 'unknown'}
Token file (do not print contents): ${this.files().tokens}

You may use this token with Google APIs for Gmail, Drive, Calendar, Docs, and Sheets when the user asks.
Never print the access token or refresh token.
`
    fs.writeFileSync(hint, text, 'utf8')
  }

  stopListen() {
    this.authUrl = ''
    if (this.server) {
      try {
        this.server.close()
      } catch {
        /* ignore */
      }
      this.server = null
    }
  }

  disconnect() {
    this.stopListen()
    for (const file of Object.values(this.files())) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
    return this.status()
  }
}

module.exports = {
  GoogleWorkspace,
  looksLikeClientJson,
  looksLikeCallbackUrl,
  parseClient
}
