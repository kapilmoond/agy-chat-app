const fs = require('fs')
const path = require('path')

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

exports.default = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, 'whatsapp-bridge', 'node_modules')
  const dest = path.join(context.appOutDir, 'resources', 'whatsapp-bridge', 'node_modules')
  if (!fs.existsSync(path.join(src, '@whiskeysockets', 'baileys'))) {
    throw new Error('whatsapp-bridge/node_modules is missing baileys. Run npm install inside whatsapp-bridge.')
  }
  copyDir(src, dest)
}
