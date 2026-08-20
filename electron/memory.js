const fs = require('fs')
const path = require('path')

const STARTER = `# Aakalan Agy — Core Memory

This is the durable memory file (Hermes / Aakalan style).
The app injects this into every chat turn. Keep it short and true.

## User
- Kapil Dev, SDO MICADA Sub Division Narwana (office work).
- Consultancy: Aaklan Infra Consultancy (aakalaninfra.com). Never mix SDO identity on firm documents.

## Standing rules
- Never invent dates, dispatch numbers, amounts, or portal status.
- Never send email or WhatsApp unless Kapil asks to send.
- Never print passwords, OTP, or API keys.
- Office CE = The Chief Engineer, MICADA, Haryana, Panchkula.
- Ask only if a missing fact would change correctness.

## How this app works
- Brain: Google Antigravity CLI (agy). This app uses the CLI session; it does not have a separate Google login.
- WhatsApp: optional linked-device QR, replies from this same memory.
- Audio/files: saved under the workspace inbox, then sent to agy.
`

function memoryDir(userData) {
  return path.join(userData, 'memory')
}

function ensureMemory(userData) {
  const dir = memoryDir(userData)
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
  const core = path.join(dir, 'MEMORY.md')
  const daily = path.join(dir, 'daily_learning.md')
  if (!fs.existsSync(core)) fs.writeFileSync(core, STARTER, 'utf8')
  if (!fs.existsSync(daily)) {
    fs.writeFileSync(daily, '# Daily learning\n\nAdd short reusable notes after work.\n', 'utf8')
  }
  return dir
}

function readMemory(userData) {
  const dir = ensureMemory(userData)
  return {
    core: fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'),
    daily: fs.readFileSync(path.join(dir, 'daily_learning.md'), 'utf8')
  }
}

function writeMemory(userData, { core, daily }) {
  const dir = ensureMemory(userData)
  if (typeof core === 'string') fs.writeFileSync(path.join(dir, 'MEMORY.md'), core, 'utf8')
  if (typeof daily === 'string') fs.writeFileSync(path.join(dir, 'daily_learning.md'), daily, 'utf8')
  return readMemory(userData)
}

function brief(userData, limit = 3500) {
  const mem = readMemory(userData)
  let text = mem.core.trim()
  const daily = mem.daily.trim()
  if (daily) text += '\n\n---\n' + daily
  if (text.length > limit) text = text.slice(0, limit) + '\n…'
  return text
}

function remember(userData, line) {
  const dir = ensureMemory(userData)
  const daily = path.join(dir, 'daily_learning.md')
  const stamp = new Date().toISOString().slice(0, 10)
  fs.appendFileSync(daily, `\n- ${stamp}: ${String(line).trim()}\n`, 'utf8')
  return readMemory(userData)
}

function isUnsafeWorkspace(workspace) {
  const home = require('os').homedir()
  const resolved = path.resolve(workspace || '')
  return resolved.toLowerCase() === path.resolve(home).toLowerCase()
}

function defaultWorkspace() {
  return path.join(require('os').homedir(), 'Documents', 'AakalanAgy')
}

function syncWorkspaceMemory(userData, workspace) {
  ensureMemory(userData)
  if (!workspace || isUnsafeWorkspace(workspace)) return
  fs.mkdirSync(workspace, { recursive: true })
  const gemini = path.join(workspace, 'GEMINI.md')
  const pointer = `# Aakalan Agy workspace

You are the Aakalan Agy assistant running through agy.
Follow the core memory the app prepends to each turn.
Do not greet as a generic chatbot. Answer the user's request.
Never invent official numbers. Never send messages unless asked.
`
  if (!fs.existsSync(gemini) || fs.readFileSync(gemini, 'utf8').includes('Aakalan Agy workspace')) {
    fs.writeFileSync(gemini, pointer, 'utf8')
  }
}

module.exports = {
  ensureMemory,
  readMemory,
  writeMemory,
  brief,
  remember,
  syncWorkspaceMemory,
  isUnsafeWorkspace,
  defaultWorkspace
}
