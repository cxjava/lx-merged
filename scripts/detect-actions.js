// 加载单个音源（桩 lx），打印它 inited 声明的 sources（含 actions）。用法: node detect-actions.js <file>
const fs = require('fs'), vm = require('vm'), crypto = require('crypto')
const code = fs.readFileSync(process.argv[2], 'utf8')
let declared = null
const done = () => { process.stdout.write(JSON.stringify(declared || {})); process.exit(0) }
global.lx = {
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  version: '2.0.0', env: 'desktop',
  currentScriptInfo: { name: 't', description: '', version: '1', author: '', homepage: '', rawScript: code },
  utils: { crypto: { md5: s => crypto.createHash('md5').update(String(s)).digest('hex'), randomBytes: n => crypto.randomBytes(n), aesEncrypt() { return Buffer.alloc(0) }, rsaEncrypt() { return Buffer.alloc(0) } }, buffer: { from: (a, e) => Buffer.from(a, e), bufToString: (b, e) => Buffer.from(b).toString(e) } },
  request() { return () => {} },
  on() { return Promise.resolve() },
  send(ev, d) { if (ev === 'inited') { declared = (d && d.sources) || {}; setTimeout(done, 50) } return Promise.resolve() },
}
console.log = console.error = console.warn = () => {}
process.on('uncaughtException', () => {}); process.on('unhandledRejection', () => {})
try { vm.runInThisContext(code) } catch (e) {}
setTimeout(done, 2500)
