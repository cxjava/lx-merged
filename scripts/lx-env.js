// 模拟落雪 (LX Music) 自定义源运行环境
const vm = require('vm')
const crypto = require('crypto')
const zlib = require('zlib')

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

function lxRequest(url, opts = {}, cb) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000)
  let body = opts.body
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString()
    opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) }
  } else if (body && typeof body === 'object' && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body)
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  }
  fetch(url, { method: (opts.method || 'GET').toUpperCase(), headers: opts.headers, body, signal: ctrl.signal, redirect: 'follow' })
    .then(async r => {
      const buf = Buffer.from(await r.arrayBuffer())
      let b = buf.toString('utf8')
      try { b = JSON.parse(b) } catch {}
      if (opts.binary) b = buf
      clearTimeout(timer)
      cb && cb(null, { statusCode: r.status, statusMessage: r.statusText, headers: Object.fromEntries(r.headers), body: b, raw: buf }, b)
    })
    .catch(e => { clearTimeout(timer); cb && cb(e, null, null) })
  return () => ctrl.abort()
}

const utils = {
  buffer: {
    from: (d, enc) => Buffer.from(d, enc),
    bufToString: (b, fmt) => Buffer.from(b).toString(fmt),
  },
  crypto: {
    md5: s => crypto.createHash('md5').update(s).digest('hex'),
    randomBytes: n => crypto.randomBytes(n),
    aesEncrypt: (buf, mode, key, iv) => {
      const c = crypto.createCipheriv(mode, key, iv || null)
      return Buffer.concat([c.update(buf), c.final()])
    },
    rsaEncrypt: (buf, key) => {
      buf = Buffer.concat([Buffer.alloc(128 - buf.length), buf])
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buf)
    },
  },
  zlib: {
    inflate: async b => zlib.inflateSync(b),
    deflate: async b => zlib.deflateSync(b),
  },
}

/** 在沙箱里加载一个音源脚本，返回 { handler, sources, logs } */
function loadSource(code, { waitInit = 5000 } = {}) {
  return new Promise((resolve) => {
    const logs = []
    const state = { handler: null, sources: null }
    const lx = {
      version: '2.0.0',
      env: 'desktop',
      currentScriptInfo: { name: 'test', description: '', version: '', author: '', homepage: '', rawScript: code },
      EVENT_NAMES,
      request: lxRequest,
      on: (ev, fn) => { if (ev === EVENT_NAMES.request) state.handler = fn },
      send: (ev, data) => {
        if (ev === EVENT_NAMES.inited) { state.sources = (data && data.sources) || {}; done() }
      },
      utils,
    }
    const log = (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })())).join(' '))
    const fakeConsole = { log, info: log, warn: log, error: log, debug: log, group: log, groupEnd: () => {}, time: () => {}, timeEnd: () => {}, table: log, trace: log }
    const ctx = {
      lx, console: fakeConsole, setTimeout, clearTimeout, setInterval, clearInterval,
      Promise, fetch, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
      AbortController, encodeURIComponent, decodeURIComponent, escape, unescape,
    }
    ctx.globalThis = ctx
    ctx.window = ctx
    ctx.self = ctx
    vm.createContext(ctx)
    let finished = false
    function done() {
      if (finished) return
      finished = true
      resolve({ handler: state.handler, sources: state.sources, logs })
    }
    try {
      vm.runInContext(code, ctx, { timeout: 10000 })
    } catch (e) {
      logs.push('LOAD_ERROR: ' + (e && e.stack || e))
    }
    setTimeout(done, waitInit)
  })
}

module.exports = { loadSource, lxRequest }
