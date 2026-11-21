import './foliate/view.js'
import { makeBook } from './foliate/view.js'

/* ───────────── utilidades ───────────── */
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
  .split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtDur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min` }
const fmtDate = t => new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
const nd = (n, one, many) => `${n} ${n === 1 ? one : many}`
const stars = n => '★'.repeat(n || 0) + '☆'.repeat(5 - (n || 0))

let toastT
function toast(msg, action) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false
  t.onclick = () => { t.hidden = true; action?.() }
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, action ? 7000 : 3200)
}

/* ───────────── base de datos local ───────────── */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('codice', 2)
  r.onupgradeneeded = () => {
    const d = r.result, mk = (n, o) => d.objectStoreNames.contains(n) || d.createObjectStore(n, o)
    mk('books', { keyPath: 'id' }); mk('files'); mk('kv'); mk('words', { keyPath: 'key' }); mk('chats')
    mk('ocr', { keyPath: 'key' })
  }
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
})
const tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const rq = fn(t.objectStore(store))
  t.oncomplete = () => res(rq?.result); t.onerror = () => rej(t.error)
})
const dbGet = (s, k) => tx(s, 'readonly', o => o.get(k))
const dbAll = s => tx(s, 'readonly', o => o.getAll())
const dbPut = (s, v, k) => tx(s, 'readwrite', o => k === undefined ? o.put(v) : o.put(v, k))
const dbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k))
const ocrRange = prefix => IDBKeyRange.bound(prefix, prefix + '\uffff')

const DEFAULT_PREFS = {
  fontSize: 100, theme: 'pergamino', flow: 'paginated', lang: 'español',
  ai: { provider: 'free', key: '', model: '', base: '' }, current: null,
}
const prefs = Object.assign({}, DEFAULT_PREFS, await dbGet('kv', 'prefs'))
prefs.ai = Object.assign({}, DEFAULT_PREFS.ai, prefs.ai)
const savePrefs = () => dbPut('kv', prefs, 'prefs')
globalThis.__codiceCrop = prefs.crop !== false
const days = (await dbGet('kv', 'days')) || {}

let books = await dbAll('books')
const bookById = id => books.find(b => b.id === id)
const saveBook = b => dbPut('books', b)

/* ───────────── red (puente nativo o fetch) ───────────── */
const pendingHttp = new Map(); let httpSeq = 0
window.__nativeHttp = (id, status, text) => { pendingHttp.get(id)?.({ status, text }); pendingHttp.delete(id) }
function http({ url, method = 'GET', headers = {}, body = null, timeout = 60000 }) {
  if (window.Native?.http) return new Promise(res => {
    const id = ++httpSeq; pendingHttp.set(id, res)
    window.Native.http(id, JSON.stringify({ url, method, headers, body, timeout }))
  })
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout)
  return fetch(url, { method, headers, body, signal: ac.signal })
    .then(async r => ({ status: r.status, text: await r.text() }))
    .catch(e => ({ status: 0, text: String(e) })).finally(() => clearTimeout(t))
}

/* ───────────── IA gratuita ───────────── */
const PROVIDERS = {
  free: { label: 'Gratis, sin clave' },
  gemini: { label: 'Google Gemini (clave gratis)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', pick: /flash/i, avoid: /lite|image|tts|live|audio|embed|exp/i, link: 'https://aistudio.google.com/apikey' },
  groq: { label: 'Groq (clave gratis)', base: 'https://api.groq.com/openai/v1', pick: /70b|120b|versatile/i, avoid: /whisper|guard|tts|vision|safeguard/i, link: 'https://console.groq.com/keys' },
  custom: { label: 'Otro (compatible con OpenAI)' },
}
const parseChat = r => {
  if (r.status === 0) throw new Error(/abort|timeout/i.test(r.text) ? 'El servicio ha tardado demasiado en responder.' : 'offline')
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 140)}`)
  try { const j = JSON.parse(r.text); const c = j.choices?.[0]?.message?.content; if (c) return c.trim(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160)) } catch (e) { if (e.message.startsWith('{')) throw e }
  if (r.text.trim() && !r.text.trim().startsWith('{') && !r.text.trim().startsWith('<')) return r.text.trim()
  throw new Error('Respuesta vacía')
}
const postChat = (url, key, model, messages) => http({
  url, method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: `Bearer ${key}` } : {}),
  body: JSON.stringify({ model, messages, temperature: 0.7 }),
}).then(parseChat)

const modelCache = {}
async function autoModel(base, key, p) {
  if (modelCache[base]) return modelCache[base]
  const r = await http({ url: base + '/models', headers: { Authorization: `Bearer ${key}` } })
  if (r.status !== 200) throw new Error(`No pude listar modelos (HTTP ${r.status}). Revisa la clave.`)
  let ids = (JSON.parse(r.text).data || []).map(m => String(m.id).replace(/^models\//, ''))
  if (p.avoid) ids = ids.filter(i => !p.avoid.test(i))
  const good = p.pick ? ids.filter(i => p.pick.test(i)) : ids
  const m = (good.length ? good : ids).sort().reverse()[0]
  if (!m) throw new Error('El proveedor no ofrece modelos de texto')
  return modelCache[base] = m
}

async function ask(messages) {
  if (!navigator.onLine) throw new Error('offline')
  const a = prefs.ai, p = PROVIDERS[a.provider] || PROVIDERS.free
  if (a.provider !== 'free') {
    const base = (a.provider === 'custom' ? a.base : p.base).replace(/\/+$/, '')
    if (!base || (!a.key && a.provider !== 'custom')) throw new Error('Falta la clave en Perfil › Ajustes del Consejo')
    const model = a.model || await autoModel(base, a.key, p)
    return postChat(base + '/chat/completions', a.key, model, messages)
  }
  const errs = []
  for (const [url, key, model] of [
    ['https://text.pollinations.ai/openai', '', 'openai'],
    ['https://api.llm7.io/v1/chat/completions', 'unused', 'gpt-4.1-nano-2025-04-14'],
  ]) { try { return await postChat(url, key, model, messages) } catch (e) { if (e.message === 'offline' && !errs.length) throw e; errs.push(e.message) } }
  try {
    const flat = messages.map(m => (m.role === 'system' ? '' : m.role === 'user' ? 'Usuario: ' : 'Tú: ') + m.content).join('\n\n').slice(-3500)
    return parseChat(await http({ url: 'https://text.pollinations.ai/' + encodeURIComponent(flat) }))
  } catch (e) { errs.push(e.message) }
  throw new Error('Los servicios gratuitos sin clave no responden ahora. Prueba más tarde o pon una clave gratuita en Perfil › Ajustes. (' + errs[0] + ')')
}
window.__ask = ask

/* ───────────── libros: abrir, texto, capítulos ───────────── */
async function makeTextBook(file) {
  let raw = await file.text()
  const isHTML = /\.x?html?$/i.test(file.name)
  if (isHTML) { const d = new DOMParser().parseFromString(raw, 'text/html'); raw = d.body?.innerText || d.body?.textContent || raw }
  const lines = raw.replace(/\r/g, '').split('\n')
  const head = /^\s*(#{1,3}\s+.+|(chapter|cap[ií]tulo|chapitre|kapitel|capitolo|part|parte|partie|libro|book)\s+([0-9]+|[ivxlcdm]+|\w+)\b.{0,60})\s*$/i
  const secs = []; let cur = { title: 'Inicio', lines: [] }, len = 0
  for (const l of lines) {
    if (head.test(l) && len <= 400 && !secs.length) cur.title = l.replace(/^#+\s*/, '').trim()
    if ((head.test(l) && len > 400) || len > 24000 && !l.trim()) {
      secs.push(cur); cur = { title: head.test(l) ? l.replace(/^#+\s*/, '').trim() : `Sección ${secs.length + 1}`, lines: [] }; len = 0
    }
    cur.lines.push(l); len += l.length + 1
  }
  secs.push(cur)
  const htmlOf = s => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${s.lines.join('\n').split(/\n\s*\n/).filter(p => p.trim()).map(p => {
    const t = p.trim(); return /^#{1,3}\s/.test(t) ? `<h2>${esc(t.replace(/^#+\s*/, ''))}</h2>` : `<p>${esc(t).replace(/\n/g, ' ')}</p>`
  }).join('\n')}</body></html>`
  const sections = secs.map((s, i) => {
    const html = htmlOf(s)
    return { id: i, linear: 'yes', size: html.length, load: () => URL.createObjectURL(new Blob([html], { type: 'text/html' })), createDocument: () => new DOMParser().parseFromString(html, 'text/html') }
  })
  return {
    sections, dir: 'ltr', rendition: {}, metadata: { title: file.name.replace(/\.[^.]+$/, ''), language: '' },
    toc: secs.map((s, i) => ({ label: s.title, href: String(i) })),
    resolveHref: href => ({ index: +href }), splitTOCHref: href => [+href, null], getTOCFragment: doc => doc.documentElement,
    isExternal: uri => /^\w+:/i.test(uri),
  }
}
const isTextFile = f => /\.(txt|md|markdown|x?html?)$/i.test(f.name) || /^text\//.test(f.type)
const toBook = async file => {
  if (isTextFile(file)) {
    const h = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    if (!(h[0] === 0x50 && h[1] === 0x4b) && !(h[0] === 0x25 && h[1] === 0x50)) return makeTextBook(file)
  }
  return makeBook(file)
}
const str = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : v?.name ? str(v.name) : v && typeof v === 'object' ? str(Object.values(v)[0]) : ''

async function sectionText(book, i, bookId) {
  try {
    if (book.getSectionText) {
      const t = await book.getSectionText(i)
      if (t.trim().length >= 20 || !bookId) return t
      const hit = await tx('ocr', 'readonly', o => o.getAll(ocrRange(`${bookId}:${i}:`), 1))
      return hit?.[0]?.text || t
    }
    const d = await book.sections[i]?.createDocument?.()
    return (d?.body ?? d?.documentElement)?.textContent?.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ') ?? ''
  } catch { return '' }
}
async function buildChapters(book) {
  const out = []
  const walk = async (items, depth) => {
    for (const it of items || []) {
      let idx = null
      try { idx = (await book.resolveHref?.(it.href))?.index } catch { }
      if (idx != null && idx >= 0) out.push({ label: (it.label || '').trim() || `Capítulo ${out.length + 1}`, index: idx, href: it.href, depth })
      if (depth < 1) await walk(it.subitems, depth + 1)
    }
  }
  await walk(book.toc, 0)
  let ch = out.sort((a, b) => a.index - b.index).filter((c, i, a) => !i || c.index !== a[i - 1].index)
  const n = book.sections.length
  if (ch.length < 2) {
    const fixed = book.rendition?.layout === 'pre-paginated', step = fixed ? 10 : 1
    ch = []
    for (let i = 0; i < n; i += step) ch.push({ label: fixed ? `Páginas ${i + 1}–${Math.min(n, i + step)}` : `Sección ${i + 1}`, index: i, href: i, depth: 0 })
  }
  ch.forEach((c, i) => c.end = (ch[i + 1]?.index ?? n) - 1)
  return ch
}
async function chapterText(book, ch, max, bookId) {
  let t = ''
  for (let i = ch.index; i <= Math.max(ch.index, ch.end) && i < ch.index + 60 && t.length < max * 1.6; i++) t += (await sectionText(book, i, bookId)) + '\n'
  t = t.trim()
  if (t.length > max) t = t.slice(0, Math.floor(max * .62)) + '\n[…]\n' + t.slice(-Math.floor(max * .36))
  return t
}
const chapterAt = (chs, sec) => { let k = 0; chs.forEach((c, i) => { if (c.index <= sec) k = i }); return k }

/* ───────────── navegación entre pantallas ───────────── */
let screen = 'read'
const sheetEl = $('#sheet'), scrim = $('#scrim')
function openSheet(html, onClose) {
  sheetEl.innerHTML = html; sheetEl.hidden = scrim.hidden = false; sheetEl.scrollTop = 0; sheetEl._close = onClose
  return sheetEl
}
function closeSheet() { if (sheetEl.hidden) return false; sheetEl.hidden = scrim.hidden = true; const f = sheetEl._close; sheetEl._close = null; f?.(); return true }
scrim.onclick = closeSheet

function go(name) {
  closeSheet(); tick()
  screen = name
  for (const s of $$('.screen')) s.hidden = s.id !== 's-' + name
  for (const b of $$('#nav button')) b.classList.toggle('on', b.dataset.go === name)
  document.body.classList.toggle('immersive', name === 'read' && !!R.view && R.immersive)
  window.Native?.keepAwake?.(name === 'read' && !!R.view)
  if (name === 'lib') renderLib()
  if (name === 'council') renderCouncil()
  if (name === 'me') renderMe()
  if (name === 'read') { R.lastTick = Date.now(); if (!R.id && !R.opening && prefs.current && bookById(prefs.current)) openBook(prefs.current) }
}
document.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go) })
window.__back = () => {
  if (closeSheet()) return true
  if (screen === 'read' && R.view && R.immersive === false) { setImmersive(true); return true }
  if (screen !== 'read' && R.view) { go('read'); return true }
  if (screen !== 'lib' && !R.view) { go('lib'); return true }
  return false
}

/* ───────────── LECTOR ───────────── */
const R = { docs: new Map(), view: null, id: null, book: null, chapters: [], chapIdx: 0, immersive: true, doubt: false, lastTick: 0, zoom: 1, fixed: false }
const host = $('#r-host')

function setImmersive(v) { R.immersive = v; document.body.classList.toggle('immersive', v && screen === 'read' && !!R.view) }

function tick() {
  const now = Date.now()
  if (R.view && screen === 'read' && R.lastTick && !document.hidden) {
    const dt = Math.min((now - R.lastTick) / 1000, 150)
    const b = bookById(R.id)
    if (b && dt > 0) { b.seconds = (b.seconds || 0) + dt; days[today()] = (days[today()] || 0) + dt; R.dirty = true }
  }
  R.lastTick = now
}
setInterval(() => { if (R.dirty) { R.dirty = false; const b = bookById(R.id); b && saveBook(b); dbPut('kv', days, 'days') } }, 8000)
document.addEventListener('visibilitychange', () => { if (document.hidden) { tick(); const b = bookById(R.id); b && saveBook(b); dbPut('kv', days, 'days') } else R.lastTick = Date.now() })

function readerCSS() {
  const o = location.origin + location.pathname.replace(/[^/]*$/, '')
  const ink = getComputedStyle(document.body).getPropertyValue('--read-ink').trim()
  return `
  @font-face{font-family:"EB Garamond";src:url(${o}fonts/eb-400-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122}
  @font-face{font-family:"EB Garamond";src:url(${o}fonts/eb-ext-400-normal.woff2) format("woff2");unicode-range:U+0100-02BA,U+1E00-1EFF}
  @font-face{font-family:"EB Garamond";font-style:italic;src:url(${o}fonts/eb-400-italic.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC}
  @font-face{font-family:"EB Garamond";font-style:italic;src:url(${o}fonts/eb-ext-400-italic.woff2) format("woff2");unicode-range:U+0100-02BA,U+1E00-1EFF}
  @font-face{font-family:"EB Garamond";font-weight:700;src:url(${o}fonts/eb-600-normal.woff2) format("woff2")}
  html{color:${ink}!important;background:none!important;font-size:${prefs.fontSize}%!important;-webkit-text-size-adjust:none}
  body{background:none!important;color:${ink}!important;font-family:"EB Garamond",Georgia,serif;line-height:1.55}
  p,li,blockquote,dd,div,span,td,h1,h2,h3,h4,h5,h6{color:inherit!important;background-color:transparent!important}
  p,li,blockquote,dd{line-height:1.55;hyphens:auto;-webkit-hyphens:auto}
  a:any-link{color:#8A4F1C!important}
  img,svg{max-width:100%}
  ::selection{background:rgba(168,103,42,.38)}`
}
function applyAppearance() {
  document.body.classList.toggle('night', prefs.theme === 'noche')
  document.body.classList.toggle('ivory', prefs.theme === 'marfil')
  window.Native?.theme?.(prefs.theme === 'noche')
  if (!R.view) return
  const r = R.view.renderer
  if (R.fixed) {
    host.firstElementChild.style.width = R.zoom * 100 + '%'
    host.firstElementChild.style.height = R.zoom * 100 + '%'
    // apaisado: la página ocupa todo el ancho y se desplaza en vertical
    const z = innerWidth > innerHeight ? 'fit-width' : 'fit-page'
    if (r.getAttribute('zoom') !== z) r.setAttribute('zoom', z)
    r.style.alignItems = z === 'fit-width' ? 'flex-start' : 'center'
  } else {
    r.setStyles?.(readerCSS())
    r.setAttribute('flow', prefs.flow === 'scrolled' ? 'scrolled' : 'paginated')
    r.setAttribute('margin', '18'); r.setAttribute('gap', '9%'); r.setAttribute('max-inline-size', '680')
  }
}

/* progreso de apertura */
const L = { p: 0, cap: 0, t: null }
function loadShow(p, cap, msg) {
  L.p = Math.max(L.p, p); L.cap = cap
  if (msg) $('#r-lmsg').textContent = msg
  const draw = () => { $('#r-lpct').textContent = Math.round(L.p) + ' %'; $('#r-ring').style.strokeDashoffset = 326.73 * (1 - L.p / 100) }
  draw()
  clearInterval(L.t)
  L.t = setInterval(() => { if (L.p < L.cap - 1) { L.p += Math.max(.25, (L.cap - L.p) * .06); draw() } }, 160)
}
function loadReset() { clearInterval(L.t); L.p = 0; L.cap = 0; $('#r-lpct').textContent = '0 %'; $('#r-ring').style.strokeDashoffset = 326.73 }
/* trae el archivo a memoria por trozos: da progreso real y acelera mucho la lectura posterior */
async function loadFile(blob, name, type, onProgress) {
  if (blob.size > 220e6) return new File([blob], name, { type })
  const parts = [], step = 4 << 20
  for (let off = 0; off < blob.size; off += step) {
    parts.push(await blob.slice(off, off + step).arrayBuffer())
    onProgress(Math.min(1, (off + step) / blob.size))
  }
  return new File(parts, name, { type })
}

async function closeReader() {
  tick()
  if (!R.view) return
  const b = bookById(R.id); if (b) await saveBook(b)
  try { R.view.close() } catch { } R.view.remove()
  try { R.book?.destroy?.() } catch { }
  Object.assign(R, { view: null, id: null, book: null, chapters: [], zoom: 1 }); R.docs.clear(); $('#r-ocr').hidden = true
}

async function openBook(id) {
  const meta = bookById(id); if (!meta) return
  if (R.id === id || R.opening === id) { if (screen !== 'read') go('read'); return }
  R.opening = id
  await closeReader()
  R.id = id; prefs.current = id; savePrefs()
  loadReset(); loadShow(1, 4, 'Abriendo el códice…')
  $('#read-empty').hidden = true; $('#reader').hidden = false; $('#r-loading').hidden = false
  $('#r-book').textContent = meta.title; $('#r-chap').textContent = ''; $('#r-pct').textContent = ''
  setImmersive(true)
  if (screen !== 'read') go('read')
  try {
    const blob = await dbGet('files', id)
    const file = await loadFile(blob, meta.fileName, meta.type || blob.type, f => loadShow(4 + f * 51, 4 + f * 51, 'Leyendo el archivo…'))
    loadShow(55, 74, 'Interpretando el libro…')
    const book = await toBook(file)
    if (R.id !== id) return
    loadShow(75, 86, 'Preparando las páginas…')
    const view = document.createElement('foliate-view')
    host.replaceChildren(view)
    await view.open(book)
    Object.assign(R, { view, book, fixed: !!view.isFixedLayout, chapIdx: -1, ready: false })
    host.classList.toggle('pdf', R.fixed)
    view.addEventListener('load', e => onDocLoad(e.detail.doc, e.detail.index))
    view.addEventListener('relocate', e => onRelocate(e.detail))
    applyAppearance()
    loadShow(87, 99, 'Abriendo por donde lo dejaste…')
    try {
      const first = meta.cfi ? view.init({ lastLocation: meta.cfi }) : R.fixed ? view.goTo(0) : view.init({ showTextStart: false })
      await Promise.race([first, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))])
    } catch (err) {
      if (err.message === 'timeout') throw new Error('la primera página no llegó a pintarse (25 s)')
      console.warn(err); try { await view.goToFraction(meta.progress || 0) } catch { await view.renderer.next() } }
    loadShow(100, 100)
    buildChapters(book).then(ch => {
      if (R.view !== view) return
      R.chapters = ch; R.chapIdx = chapterAt(ch, R.sec || 0)
      const b = bookById(id); if (b) { b.chapIdx = R.chapIdx; if (!$('#r-chap').textContent) $('#r-chap').textContent = ch[R.chapIdx]?.label || '' }
    }).catch(console.warn)
    R.ready = true
    if (!meta.started) { meta.started = Date.now(); saveBook(meta) }
    meta.opened = Date.now()
    R.lastTick = Date.now()
    window.Native?.keepAwake?.(true)
    setImmersive(false); setTimeout(() => R.view === view && setImmersive(true), 2600)
  } catch (e) {
    console.error(e); toast('No he podido abrir este archivo: ' + (e.message || e))
    R.id = null; $('#reader').hidden = true; $('#read-empty').hidden = false; setImmersive(false)
  } finally { $('#r-loading').hidden = true; clearInterval(L.t); R.opening = null }
}

function onRelocate(d) {
  tick()
  const b = bookById(R.id); if (!b) return
  const frac = Math.max(0, Math.min(1, d.fraction ?? 0))
  b.progress = frac; b.cfi = d.cfi || b.cfi
  const sec = d.section?.current ?? 0
  if (R.fixed && sec !== R.sec) R.view.renderer.scrollTop = 0
  R.sec = sec
  const k = chapterAt(R.chapters, sec)
  const label = d.tocItem?.label?.trim() || R.chapters[k]?.label || ''
  b.chapter = label; b.chapIdx = k
  $('#r-chap').textContent = label
  $('#r-pct').textContent = (R.fixed ? `${sec + 1} / ${d.section?.total ?? ''} · ` : '') + Math.round(frac * 100) + ' %'
  if (R.ready && R.chapIdx >= 0 && k === R.chapIdx + 1) {
    b.lastFinished = R.chapIdx
    const done = R.chapters[R.chapIdx]
    toast(`Capítulo terminado: «${done.label.slice(0, 40)}». Toca para debatirlo en el Consejo.`, () => { C.bookId = b.id; C.chap = b.lastFinished; go('council') })
  }
  R.chapIdx = k
  if (R.ready && frac >= 0.995 && sec >= (d.section?.total ?? 1) - 1 && !b.finished) { b.finished = Date.now(); saveBook(b); setTimeout(() => rateSheet(b, true), 600) }
  R.dirty = true
}

addEventListener('resize', () => { if (R.view && R.fixed) applyAppearance() })
// en páginas más altas que la pantalla, el toque lateral baja/sube antes de pasar de página
function pageStep(dir) {
  const sc = R.fixed && R.zoom === 1 ? R.view.renderer : null
  if (sc && sc.scrollHeight > sc.clientHeight + 12) {
    const top = sc.scrollTop, max = sc.scrollHeight - sc.clientHeight
    if (dir > 0 && top < max - 6) return sc.scrollTo({ top: Math.min(max, top + sc.clientHeight * .88), behavior: 'smooth' })
    if (dir < 0 && top > 6) return sc.scrollTo({ top: Math.max(0, top - sc.clientHeight * .88), behavior: 'smooth' })
  }
  dir > 0 ? R.view.goRight() : R.view.goLeft()
}

/* toques dentro del libro */
function frameXY(doc, e) {
  const fr = doc.defaultView.frameElement; if (!fr) return { x: e.clientX, y: e.clientY }
  const r = fr.getBoundingClientRect(), sx = r.width / (fr.offsetWidth || r.width)
  return { x: r.left + e.clientX * sx, y: r.top + e.clientY * sx }
}
function onDocLoad(doc, index) {
  doc.addEventListener('click', e => {
    if (e.target.closest?.('a[href]')) return
    const sel = doc.getSelection()
    if (R.doubt) { e.preventDefault(); lookupAt(doc, e.clientX, e.clientY, e.target); return }
    if (sel && !sel.isCollapsed) return
    const { x } = frameXY(doc, e), w = innerWidth
    if (!R.immersive) return setImmersive(true)
    if (x < w * .28) pageStep(-1)
    else if (x > w * .72) pageStep(1)
    else setImmersive(false)
  })
  if (R.fixed) {
    R.docs.set(doc, index)
    const check = () => maybeOCR(doc, index)
    doc.addEventListener('codice-rendered', check)
    if (doc.__codice) check()
    let t0 = null
    doc.addEventListener('touchstart', e => { t0 = e.touches.length === 1 ? { x: e.touches[0].screenX, y: e.touches[0].screenY, t: Date.now() } : null }, { passive: true })
    doc.addEventListener('touchend', e => {
      if (!t0 || R.zoom > 1) return
      const c = e.changedTouches[0], dx = c.screenX - t0.x, dy = c.screenY - t0.y
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - t0.t < 700) dx < 0 ? R.view.goRight() : R.view.goLeft()
      t0 = null
    }, { passive: true })
  }
}
host.addEventListener('click', e => { if (e.target === host || e.target.tagName === 'FOLIATE-VIEW') setImmersive(!R.immersive) })

$('#r-doubt').onclick = () => {
  R.doubt = !R.doubt
  $('#r-doubt').setAttribute('aria-pressed', R.doubt)
  toast(R.doubt ? 'Duda palabra activada: toca cualquier palabra.' : 'Duda palabra desactivada.')
}

/* ir a una página */
$('#r-goto').onclick = () => {
  if (!R.view || !R.ready) return
  const b = bookById(R.id), total = R.fixed ? R.book.sections.length : 100
  const cur = R.fixed ? (R.sec || 0) + 1 : Math.round((b?.progress || 0) * 100)
  const s = openSheet(`<p class="sh-title">${R.fixed ? 'Ir a la página' : 'Ir a un punto del libro'}</p>
    <form id="goto-f" novalidate><div class="goto-row"><input id="goto-n" type="number" inputmode="numeric" min="${R.fixed ? 1 : 0}" max="${total}" value="${cur}">
      <span>${R.fixed ? 'de ' + total : '%'}</span><span style="flex:1"></span><button class="btn-line on">Ir</button></div>
    <input id="goto-r" type="range" min="${R.fixed ? 1 : 0}" max="${total}" value="${cur}"></form>
    <p class="hint">Ahora estás en ${R.fixed ? 'la página ' + cur : 'el ' + cur + ' %'}${b?.chapter ? ' · ' + esc(b.chapter.slice(0, 40)) : ''}.</p>`)
  const n = $('#goto-n', s), r = $('#goto-r', s)
  r.oninput = () => n.value = r.value
  n.oninput = () => r.value = n.value
  $('#goto-f', s).onsubmit = e => {
    e.preventDefault()
    const v = Math.max(+n.min, Math.min(total, Math.round(+n.value || cur)))
    closeSheet(); R.chapIdx = -1
    const go = R.fixed ? R.view.goTo(v - 1) : R.view.goToFraction(Math.min(.9999, v / 100))
    Promise.resolve(go).catch(() => toast('No he podido ir a ese punto.'))
  }
  setTimeout(() => { n.focus(); n.select() }, 250)
}

/* índice */
$('#r-toc').onclick = () => {
  const s = openSheet(`<p class="sh-title">Índice</p>` + R.chapters.map((c, i) =>
    `<button class="toc-i d${c.depth} ${i === R.chapIdx ? 'on' : ''}" data-i="${i}">${esc(c.label)}</button>`).join(''))
  s.querySelector('.on')?.scrollIntoView({ block: 'center' })
  s.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; const c = R.chapters[+b.dataset.i]; closeSheet(); R.chapIdx = -1; R.view.goTo(c.href).catch(() => R.view.goTo(c.index)) }
}
/* apariencia */
$('#r-aa').onclick = () => {
  const seg = (k, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button class="btn-line ${String(cur) === String(v) ? 'on' : ''}" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`
  const draw = () => {
    const s = openSheet(`<p class="sh-title">Apariencia</p>
      <div class="field"><label>Papel</label>${seg('theme', [['pergamino', 'Pergamino'], ['marfil', 'Marfil'], ['noche', 'Noche']], prefs.theme)}</div>` +
      (R.fixed ? `<div class="field"><label>Zoom de página</label>${seg('zoom', [[1, 'Ajustar'], [1.5, '150 %'], [2, '200 %'], [3, '300 %']], R.zoom)}</div>
        <p class="hint">Con zoom, desplaza la página con el dedo y pasa de página tocando los bordes.</p>
        <div class="field"><label>Márgenes de la página</label>${seg('crop', [['on', 'Recortar'], ['off', 'Página completa']], prefs.crop === false ? 'off' : 'on')}</div>
        <div class="field"><label>Páginas escaneadas · reconocer texto (OCR)</label>${seg('ocr', [['on', 'Automático'], ['off', 'Apagado']], bookById(R.id)?.ocr === false ? 'off' : 'on')}</div>
        <div class="field"><label>Idioma del texto escaneado</label>${seg('ocrLang', Object.keys(OCR_LANGS).map(k => [k, k === 'auto' ? 'EN·FR·ES' : k.toUpperCase()]), ocrLangFor(bookById(R.id) || {}))}</div>
        <p class="hint">Solo actúa en páginas que son una imagen. Tarda unos segundos por página y funciona sin conexión; elegir un único idioma lo hace más rápido y preciso.</p>` :
        `<div class="field"><label>Tamaño de letra · ${prefs.fontSize} %</label>${seg('font', [[-10, 'A −'], [10, 'A +']], '')}</div>
         <div class="field"><label>Paso de página</label>${seg('flow', [['paginated', 'Páginas'], ['scrolled', 'Desplazamiento']], prefs.flow)}</div>`))
    s.onclick = e => {
      const b = e.target.closest('[data-k]'); if (!b) return
      const { k, v } = b.dataset
      if (k === 'font') prefs.fontSize = Math.max(70, Math.min(220, prefs.fontSize + +v))
      else if (k === 'zoom') R.zoom = +v
      else if (k === 'crop') {
        prefs.crop = v === 'on'; globalThis.__codiceCrop = prefs.crop; savePrefs()
        const id = R.id; closeSheet()
        return closeReader().then(() => openBook(id))
      }
      else if (k === 'ocr' || k === 'ocrLang') {
        const b = bookById(R.id); if (k === 'ocr') b.ocr = v === 'on'; else b.ocrLang = v
        saveBook(b)
        for (const [d, i] of R.docs) { d.querySelector?.('.ocrLayer')?.remove(); if (d.defaultView) maybeOCR(d, i); else R.docs.delete(d) }
      }
      else prefs[k] = v
      savePrefs(); applyAppearance(); draw()
    }
  }
  draw()
}

/* ───────────── OCR de páginas escaneadas (tesseract.js) ───────────── */
const OCR_LANGS = { auto: 'eng+fra+spa', en: 'eng', fr: 'fra', es: 'spa', it: 'ita', de: 'deu', pt: 'por' }
const OCR = { worker: null, langs: '', chain: Promise.resolve(), busy: 0, warned: false }
const ocrLangFor = b => b.ocrLang || (OCR_LANGS[(b.language || '').slice(0, 2).toLowerCase()] ? b.language.slice(0, 2).toLowerCase() : 'auto')
async function ocrWorker(langs) {
  if (OCR.worker && OCR.langs === langs) return OCR.worker
  const base = new URL('ocr/', location.href).href
  if (OCR.worker) await OCR.worker.reinitialize(langs.split('+'))
  else {
    const m = await import('./ocr/tesseract.esm.min.js'), T = m.default?.createWorker ? m.default : m
    OCR.worker = await T.createWorker(langs.split('+'), 1, { workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang', cacheMethod: 'none', workerBlobURL: false })
  }
  OCR.langs = langs
  return OCR.worker
}
const ocrBusy = d => { OCR.busy = Math.max(0, OCR.busy + d); $('#r-ocr').hidden = !OCR.busy || !R.view }
async function maybeOCR(doc, index) {
  const b = bookById(R.id)
  if (!b || !R.fixed || b.ocr === false || (doc.__codice?.textLength ?? 99) >= 20) return
  const lang = ocrLangFor(b), key = `${b.id}:${index}:${lang}:${globalThis.__codiceCrop ? 'c' : 'f'}`
  try {
    let res = await dbGet('ocr', key)
    if (!res) {
      if (doc.__ocrRunning === key) return
      doc.__ocrRunning = key; ocrBusy(1)
      try {
        res = await (OCR.chain = OCR.chain.catch(() => { }).then(async () => {
          const src = doc.querySelector('#canvas canvas')
          if (!src || !doc.defaultView || R.id !== b.id) return null
          const sc = Math.max(Math.min(1, 2200 / src.width), Math.min(2, 1500 / src.width))
          const c = Object.assign(document.createElement('canvas'), { width: Math.round(src.width * sc), height: Math.round(src.height * sc) })
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height)
          const w = await ocrWorker(OCR_LANGS[lang])
          const { data } = await w.recognize(c, {}, { blocks: true })
          const lines = []
          for (const bl of data.blocks || []) for (const p of bl.paragraphs || []) {
            for (const l of p.lines || []) {
              const ws = (l.words || []).filter(x => x.text.trim() && x.confidence > 25).map(x => [x.text, x.bbox.x0 / c.width, x.bbox.y0 / c.height, x.bbox.x1 / c.width, x.bbox.y1 / c.height])
              if (ws.length) lines.push(ws)
            }
            lines.push(null)
          }
          return { key, bookId: b.id, index, lines, text: lines.map(l => l ? l.map(x => x[0]).join(' ') : '').join('\n').replace(/\n{3,}/g, '\n\n').trim() }
        }))
      } finally { ocrBusy(-1); doc.__ocrRunning = null }
      if (!res) return
      await dbPut('ocr', res)
    }
    if (doc.defaultView) drawOcrLayer(doc, res)
  } catch (e) {
    console.error(e)
    if (!OCR.warned) { OCR.warned = true; toast('No he podido reconocer el texto de esta página: ' + (e?.message || e)) }
  }
}
function drawOcrLayer(doc, res) {
  const cv = doc.querySelector('#canvas canvas'); if (!cv) return
  const W = cv.width, H = cv.height
  doc.querySelector('.ocrLayer')?.remove()
  if (!doc.querySelector('#ocr-css')) {
    const st = doc.createElement('style'); st.id = 'ocr-css'
    st.textContent = '.ocrLayer{position:absolute;left:0;top:0;z-index:4;overflow:hidden}.ocrLayer span{position:absolute;color:transparent;white-space:pre;overflow:hidden;line-height:1;font-family:serif;cursor:pointer}.ocrLayer span::selection{background:rgba(168,103,42,.45);color:transparent}'
    doc.head.append(st)
  }
  const layer = doc.createElement('div'); layer.className = 'ocrLayer'
  layer.style.width = W + 'px'; layer.style.height = H + 'px'
  for (const l of res.lines) {
    if (!l) { layer.append(doc.createTextNode('\n')); continue }
    const div = doc.createElement('div')
    for (const [t, x0, y0, x1, y1] of l) {
      const s = doc.createElement('span'); s.textContent = t
      s.style.cssText = `left:${x0 * W}px;top:${y0 * H}px;width:${(x1 - x0) * W}px;height:${(y1 - y0) * H}px;font-size:${(y1 - y0) * H * .92}px`
      div.append(s, doc.createTextNode(' '))
    }
    layer.append(div)
  }
  doc.body.append(layer)
}

/* ───────────── DUDA PALABRA ───────────── */
const WORD = /[\p{L}\p{M}\p{N}'’\-]/u
function lookupAt(doc, x, y, target) {
  const ow = target?.closest?.('.ocrLayer span')
  if (!ow && target?.closest?.('.ocrLayer')) return
  const r = ow ? (() => { const g = doc.createRange(); g.setStart(ow.firstChild, 0); return g })() : doc.caretRangeFromPoint?.(x, y) ?? (() => { const p = doc.caretPositionFromPoint?.(x, y); if (!p) return null; const g = doc.createRange(); g.setStart(p.offsetNode, p.offset); return g })()
  const node = r?.startContainer
  if (!node || node.nodeType !== 3) return
  const text = node.data; let a = r.startOffset, z = r.startOffset
  if (!WORD.test(text[a] || '') && WORD.test(text[a - 1] || '')) a--, z--
  if (!WORD.test(text[a] || '')) return
  while (a > 0 && WORD.test(text[a - 1])) a--
  while (z < text.length && WORD.test(text[z])) z++
  const word = text.slice(a, z).replace(/^['’\-]+|['’\-]+$/g, '')
  if (!word) return
  const wr = doc.createRange(); wr.setStart(node, a); wr.setEnd(node, z)
  const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(wr)
  // contexto: frase alrededor
  let block = node.parentElement
  while (block && block !== doc.body && !/^(P|LI|DIV|BLOCKQUOTE|TD|H[1-6]|DD|SECTION|ARTICLE)$/i.test(block.tagName)) block = block.parentElement
  block = block?.closest?.('.textLayer, .ocrLayer') || block || doc.body
  let full = '', off = 0
  if (block.classList?.contains('textLayer')) {
    // en PDF cada línea es un fragmento suelto: se unen con espacio (o sin él tras guion de corte)
    const tw = doc.createTreeWalker(block, 5)
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) { if (n === node) off = full.length + a; full += n.data }
      else if (n.tagName?.toLowerCase() === 'br' && full && !/\s$/.test(full)) full += /[\p{L}]-$/u.test(full) ? '' : ' '
    }
  } else {
    const pre = doc.createRange(); pre.selectNodeContents(block); pre.setEnd(node, a)
    full = block.textContent; off = pre.toString().length
  }
  let s = off, e = off + word.length
  while (s > 0 && !/[.!?…\n]/.test(full[s - 1]) && off - s < 260) s--
  while (e < full.length && !/[.!?…\n]/.test(full[e]) && e - off < 260) e++
  const ctx = full.slice(s, Math.min(full.length, e + 1)).replace(/\s+/g, ' ').trim()
  wordSheet(word, ctx, () => sel.removeAllRanges())
}

const wkey = (w, mode) => `${mode === 'mean' ? 'mean:orig' : mode + ':v2:' + prefs.lang}:${w.toLowerCase()}`
async function wordSheet(word, ctx, onClose) {
  const b = bookById(R.id)
  const ctxHtml = esc(ctx).replace(new RegExp(`(^|[^\\p{L}])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}])`, 'u'), '$1<mark>$2</mark>')
  const s = openSheet(`<p class="sh-title">Duda palabra</p>
    <div class="w-word">${esc(word)}</div>
    <div class="w-ctx">${ctxHtml}</div>
    <div class="w-res" id="w-res"></div>
    <div class="w-actions">
      <button class="btn-line on" data-m="mean">Significado</button>
      <button class="btn-line" data-m="tr">Traducir</button>
      <button class="btn-line" data-m="tr-s">Traducir la frase</button>
    </div>`, onClose)
  const res = $('#w-res', s)
  const run = async mode => {
    $$('[data-m]', s).forEach(x => x.classList.toggle('on', x.dataset.m === mode))
    const key = wkey(mode === 'tr-s' ? ctx : word, mode)
    const cached = await dbGet('words', key)
    if (cached?.text) { res.innerHTML = md(cached.text); return }
    res.innerHTML = '<span class="think">Consultando</span>'
    const L = prefs.lang
    const hint = b?.language ? ` (el libro está en «${b.language}»)` : ''
    const sys = mode === 'mean'
      ? `Eres un lexicógrafo monolingüe, como un diccionario de la lengua original del texto. Respondes SIEMPRE en el mismo idioma en que está escrita la frase citada${hint}: si la frase está en francés, defines en francés; si está en inglés, en inglés. Nunca traduces ni cambias de idioma. Sin preámbulos ni despedidas.`
      : `Eres un traductor literario preciso. Respondes siempre en ${L}, sin preámbulos ni despedidas, en texto breve.`
    const usr = mode === 'mean'
      ? `Phrase / sentence: «${ctx}»\n\nMot / word: «${word}»\n\nDefine this word as it is used in this sentence, writing in the language of the sentence itself. First line: part of speech and lemma in parentheses. Then 1–3 clear sentences giving its sense here (say if it is an idiom, archaic or figurative), with one synonym if useful. Max 60 words. Do not translate into any other language.`
      : mode === 'tr'
        ? `Frase original: «${ctx}»\n\nTraduce al ${L} la palabra «${word}» tal como se usa en esa frase. Primera línea: la mejor traducción en negrita (y una o dos alternativas con su matiz, si las hay). Después, 1–2 frases en ${L} explicando su sentido en este contexto. Indica entre paréntesis de qué idioma es. Máximo 55 palabras.`
        : `Traduce al ${L} esta frase con fidelidad y naturalidad, sin comentarios:\n«${ctx}»`
    try {
      const text = await ask([{ role: 'system', content: sys }, { role: 'user', content: usr }])
      res.innerHTML = md(text)
      await dbPut('words', { key, word, ctx, mode, text, lang: L, bookId: b?.id, book: b?.title, ts: Date.now() })
    } catch (e) {
      if (e.message === 'offline' && mode !== 'mean') res.innerHTML = '<i>Sin conexión: la traducción necesita red.</i>'
      else if (e.message === 'offline') {
        await dbPut('words', { key, word, ctx, mode, text: '', pending: true, lang: L, bookId: b?.id, book: b?.title, ts: Date.now() })
        res.innerHTML = '<i>Sin conexión. He guardado la palabra y la resolveré en cuanto vuelva la red; la tendrás en Perfil › Vocabulario.</i>'
      } else res.innerHTML = `<i>${esc(e.message)}</i>`
    }
  }
  s.onclick = e => { const m = e.target.closest('[data-m]'); if (m) run(m.dataset.m) }
  run('mean')
}
async function resolvePending() {
  if (!navigator.onLine) return
  for (const w of (await dbAll('words')).filter(w => w.pending && w.mode === 'mean').slice(0, 8)) {
    try {
      const text = await ask([{ role: 'system', content: 'Eres un lexicógrafo monolingüe. Respondes SIEMPRE en el mismo idioma de la frase citada, breve, sin preámbulos y sin traducir.' },
      { role: 'user', content: `Sentence: «${w.ctx}»\n\nWord: «${w.word}»\n\nDefine this word as used in this sentence, in the language of the sentence: part of speech, then its sense here. Max 60 words.` }])
      await dbPut('words', { ...w, text, pending: false })
    } catch { break }
  }
}
addEventListener('online', resolvePending); setTimeout(resolvePending, 5000)

/* ───────────── BIBLIOTECA ───────────── */
const coverHtml = b => b.cover ? `<img src="${b.cover}" alt="">` : `<div class="ph">${esc(b.title)}</div>`
function renderLib() {
  const q = $('#lib-q').value.trim().toLowerCase()
  const list = books.filter(b => !q || (b.title + ' ' + b.author).toLowerCase().includes(q))
    .sort((a, b) => (b.opened || b.added) - (a.opened || a.added))
  $('#lib-empty').hidden = books.length > 0
  $('#lib-grid').innerHTML = list.map(b => `<button class="bk" data-id="${b.id}">
      <div class="cv">${coverHtml(b)}${b.finished ? '<div class="seal">✓</div>' : ''}<div class="bar"><i style="width:${Math.round((b.progress || 0) * 100)}%"></i></div></div>
      <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || b.format)}</div></button>`).join('')
}
$('#lib-q').oninput = renderLib
$('#lib-add').onclick = () => $('#file').click()
$('#file').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; await addFiles(fs) }

let pressT, pressed
$('#lib-grid').addEventListener('pointerdown', e => { const b = e.target.closest('.bk'); pressed = false; if (b) pressT = setTimeout(() => { pressed = true; bookMenu(bookById(b.dataset.id)) }, 520) })
for (const ev of ['pointerup', 'pointercancel', 'pointermove']) $('#lib-grid').addEventListener(ev, e => { if (ev !== 'pointermove' || Math.abs(e.movementY) > 3) clearTimeout(pressT) })
$('#lib-grid').addEventListener('contextmenu', e => e.preventDefault())
$('#lib-grid').addEventListener('click', e => { const b = e.target.closest('.bk'); if (b && !pressed) openBook(b.dataset.id) })

async function thumb(blob) {
  try {
    const bmp = await createImageBitmap(blob), w = 300, h = Math.round(bmp.height * w / bmp.width)
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
    c.getContext('2d').drawImage(bmp, 0, 0, w, h)
    return c.toDataURL('image/jpeg', .72)
  } catch { return '' }
}
const clean = t => /^(untitled|unknown|anonymous|desconocido|sin t[ií]tulo|microsoft word.*)$/i.test((t || '').trim()) ? '' : (t || '').trim()
const FORMATS = [[/\.epub$/i, 'EPUB'], [/\.pdf$/i, 'PDF'], [/\.(mobi|prc)$/i, 'MOBI'], [/\.(azw3?|kf8)$/i, 'AZW3'], [/\.(fb2|fbz|fb2\.zip)$/i, 'FB2'], [/\.cbz$/i, 'CBZ'], [/\.(txt|md)$/i, 'TXT'], [/\.x?html?$/i, 'HTML']]
async function addFiles(files) {
  let n = 0, last
  for (const f of files) {
    if (books.some(b => b.fileName === f.name && b.size === f.size)) { toast(`«${f.name}» ya está en tu biblioteca.`); continue }
    toast(`Añadiendo «${f.name}»…`)
    try {
      const book = await toBook(f)
      const m = book.metadata || {}
      let cover = ''
      try { const c = await book.getCover?.(); if (c) cover = await thumb(c) } catch { }
      const meta = {
        id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), fileName: f.name, size: f.size, type: f.type,
        title: clean(str(m.title)) || f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '), author: clean(str(m.author)), language: str(m.language),
        format: FORMATS.find(([r]) => r.test(f.name))?.[1] || (book.rendition?.layout === 'pre-paginated' ? 'PDF' : 'Libro'),
        cover, added: Date.now(), progress: 0, seconds: 0,
      }
      try { book.destroy?.() } catch { }
      await dbPut('files', f, meta.id); await saveBook(meta); books.push(meta); n++; last = meta
    } catch (err) { console.error(err); toast(`No puedo leer «${f.name}» (formato no compatible o archivo dañado).`) }
  }
  if (n) { toast(n === 1 ? `«${last.title}» añadido.` : `${n} libros añadidos.`); renderLib() }
  return last
}
function bookMenu(b) {
  if (!b) return
  const s = openSheet(`<p class="sh-title">${esc(b.title)}</p><div class="menu">
    <button data-a="open">Abrir</button>
    <button data-a="rate">Nota y apuntes</button>
    <button data-a="fin">${b.finished ? 'Marcar como no terminado' : 'Marcar como terminado'}</button>
    <button data-a="council">Debatir en el Consejo</button>
    <button data-a="del" class="danger">Quitar de la biblioteca</button></div>`)
  s.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return
    closeSheet()
    if (a === 'open') openBook(b.id)
    if (a === 'rate') rateSheet(b)
    if (a === 'council') { C.bookId = b.id; C.chap = null; go('council') }
    if (a === 'fin') { b.finished = b.finished ? null : Date.now(); if (b.finished && !b.started) b.started = b.added; await saveBook(b); renderLib(); if (b.finished) rateSheet(b) }
    if (a === 'del') confirmDelete(b)
  }
}
function confirmDelete(b) {
  const s = openSheet(`<p class="sh-title">Quitar libro</p><p class="lead">¿Quitar «${esc(b.title)}» de la app? El archivo original de tu teléfono no se toca; se borran su progreso y sus estadísticas.</p>
    <div class="w-actions"><button class="btn-line" data-a="no">Cancelar</button><button class="btn-line on" data-a="yes">Quitar</button></div>`)
  s.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return
    closeSheet(); if (a !== 'yes') return
    if (R.id === b.id) { await closeReader(); $('#reader').hidden = true; $('#read-empty').hidden = false; setImmersive(false) }
    if (prefs.current === b.id) { prefs.current = null; savePrefs() }
    await dbDel('books', b.id); await dbDel('files', b.id); await dbDel('chats', b.id); await dbDel('ocr', ocrRange(b.id + ':'))
    books = books.filter(x => x.id !== b.id); renderLib()
  }
}
function rateSheet(b, justFinished) {
  const draw = () => {
    const s = openSheet(`<p class="sh-title">${justFinished ? 'Libro terminado' : 'Nota y apuntes'}</p>
      <div class="w-word">${esc(b.title)}</div>
      ${justFinished ? `<p class="lead">Tiempo de lectura: ${fmtDur(b.seconds || 0)}. ¿Qué nota le pones?</p>` : ''}
      <div class="stars big">${[1, 2, 3, 4, 5].map(i => `<button data-r="${i}">${i <= (b.rating || 0) ? '★' : '☆'}</button>`).join('')}</div>
      <div class="field"><label>Apuntes</label><textarea id="rt-note" rows="3" placeholder="Qué te llevas de este libro…">${esc(b.note || '')}</textarea></div>
      <div class="w-actions"><button class="btn-line on" data-a="ok">Guardar</button></div>`, () => { if (screen === 'me') renderMe(); if (screen === 'lib') renderLib() })
    s.onclick = async e => {
      const r = e.target.closest('[data-r]'); const note = $('#rt-note', s).value
      if (r) { b.rating = b.rating === +r.dataset.r ? 0 : +r.dataset.r; b.note = note; await saveBook(b); draw() }
      if (e.target.closest('[data-a]')) { b.note = note; await saveBook(b); closeSheet() }
    }
  }
  draw()
}

/* ───────────── COUNCIL ───────────── */
const C = { bookId: null, chap: null, handle: null, busy: false, msgs: [] }
const CHIPS = ['Resume las ideas clave', 'Hazme de abogado del diablo', '¿Qué implicaciones tiene?', 'Ponme a prueba con tres preguntas', '¿Cómo se aplica a mi vida?']
async function councilHandle(id) {
  if (R.id === id && R.book) return { book: R.book, chapters: R.chapters }
  if (C.handle?.id === id) return C.handle
  try { C.handle?.book?.destroy?.() } catch { }
  const meta = bookById(id), blob = await dbGet('files', id)
  const book = await toBook(new File([blob], meta.fileName, { type: meta.type || blob.type }))
  return C.handle = { id, book, chapters: await buildChapters(book) }
}
async function renderCouncil() {
  const log = $('#c-log')
  if (!books.length) {
    $('#c-book').innerHTML = ''; $('#c-chap').innerHTML = ''; $('#c-chips').innerHTML = ''
    log.innerHTML = '<div class="msg sys">Añade un libro a tu biblioteca para convocar al Consejo.</div>'; return
  }
  if (!C.bookId || !bookById(C.bookId)) C.bookId = prefs.current && bookById(prefs.current) ? prefs.current : books[0].id
  $('#c-book').innerHTML = books.map(b => `<option value="${b.id}" ${b.id === C.bookId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')
  $('#c-chips').innerHTML = CHIPS.map(c => `<button type="button">${c}</button>`).join('')
  $('#c-chap').innerHTML = '<option>Cargando capítulos…</option>'
  C.msgs = (await dbGet('chats', C.bookId)) || []
  drawLog()
  const id = C.bookId
  try {
    const h = await councilHandle(id); if (C.bookId !== id) return
    const b = bookById(id)
    if (C.chap == null || C.chap >= h.chapters.length) C.chap = b.lastFinished ?? b.chapIdx ?? 0
    $('#c-chap').innerHTML = h.chapters.map((c, i) => `<option value="${i}" ${i === C.chap ? 'selected' : ''}>${c.depth ? '· ' : ''}${esc(c.label.slice(0, 60))}</option>`).join('')
  } catch (e) { $('#c-chap').innerHTML = '<option>Sin capítulos</option>' }
}
function drawLog(thinking) {
  const log = $('#c-log')
  log.innerHTML = (C.msgs.length ? '' : `<div class="msg sys">El Consejo ha leído el capítulo contigo.<br>Defiende una idea, pide el contraargumento o deja que te examine.</div>`) +
    C.msgs.map(m => m.role === 'sys' ? `<div class="msg sys">${esc(m.content)}</div>` : m.role === 'err' ? `<div class="msg err">${esc(m.content)}</div>`
      : `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : md(m.content)}</div>`).join('') +
    (thinking ? '<div class="msg bot think">El Consejo delibera</div>' : '')
  log.scrollTop = log.scrollHeight
}
$('#c-book').onchange = e => { C.bookId = e.target.value; C.chap = null; renderCouncil() }
$('#c-chap').onchange = e => { C.chap = +e.target.value }
$('#c-chips').onclick = e => { const b = e.target.closest('button'); if (b) sendCouncil(b.textContent) }
$('#c-in').oninput = e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px' }
$('#c-form').onsubmit = e => { e.preventDefault(); const v = $('#c-in').value.trim(); if (v) { $('#c-in').value = ''; $('#c-in').style.height = 'auto'; sendCouncil(v) } }

async function sendCouncil(text) {
  if (C.busy || !C.bookId) return
  C.busy = true
  const id = C.bookId, b = bookById(id)
  C.msgs = C.msgs.filter(m => m.role !== 'err')
  try {
    const h = await councilHandle(id), ch = h.chapters[C.chap ?? 0]
    const lastMark = [...C.msgs].reverse().find(m => m.role === 'sys')
    if (ch && lastMark?.content !== ch.label) C.msgs.push({ role: 'sys', content: ch.label })
    C.msgs.push({ role: 'user', content: text, ts: Date.now() }); drawLog(true)
    const max = prefs.ai.provider === 'free' ? 9000 : 26000
    const body = ch ? await chapterText(h.book, ch, max, id) : ''
    const sys = `Eres «el Consejo»: un interlocutor culto, riguroso y directo con quien ${'el lector'} debate lo que acaba de leer. Libro: «${b.title}»${b.author ? ' de ' + b.author : ''}. Capítulo: «${ch?.label ?? ''}».
Reglas: responde en ${prefs.lang}; básate en el texto del capítulo y cítalo brevemente cuando ayude; no adules ni des la razón por cortesía: si la tesis del lector es floja, dilo y explica por qué; aporta contraargumentos, implicaciones prácticas y conexiones con otras obras o ideas; sé conciso (120–200 palabras salvo que pidan más); termina con una sola pregunta que haga avanzar el debate. Si el lector pide que le examines, haz las preguntas de una en una.
${body ? `\n=== TEXTO DEL CAPÍTULO ===\n${body}\n=== FIN ===` : '\n(No hay texto extraíble de este capítulo —si es un PDF escaneado, solo dispongo de las páginas que el lector ya ha abierto con el OCR—; apóyate en lo que el lector cuente y en tu conocimiento de la obra, avisando de ello.)'}`
    const hist = C.msgs.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10).map(m => ({ role: m.role, content: m.content }))
    const out = await ask([{ role: 'system', content: sys }, ...hist])
    C.msgs.push({ role: 'assistant', content: out, ts: Date.now() })
  } catch (e) {
    C.msgs.push({ role: 'err', content: e.message === 'offline' ? 'El Consejo necesita conexión. Tu mensaje queda guardado; reenvíalo cuando tengas red.' : e.message })
  }
  await dbPut('chats', C.msgs.filter(m => m.role !== 'err').slice(-80), id)
  C.busy = false
  if (C.bookId === id && screen === 'council') drawLog()
}

/* ───────────── PERFIL ───────────── */
const RANKS = [[0, 'Aprendiz'], [1, 'Discípulo'], [5, 'Oficial del taller'], [12, 'Maestro'], [30, 'Erudito'], [60, 'Polímata']]
function streak() {
  let n = 0; const d = new Date()
  if (!(days[today(d)] >= 60)) d.setDate(d.getDate() - 1)
  while (days[today(d)] >= 60) { n++; d.setDate(d.getDate() - 1) }
  return n
}
async function renderMe() {
  const fin = books.filter(b => b.finished).sort((a, b) => b.finished - a.finished)
  const cur = books.filter(b => !b.finished && (b.progress > 0 || b.seconds > 30)).sort((a, b) => (b.opened || 0) - (a.opened || 0))
  const total = books.reduce((s, b) => s + (b.seconds || 0), 0)
  const timed = fin.filter(b => b.seconds > 60)
  const avgS = timed.length ? timed.reduce((s, b) => s + b.seconds, 0) / timed.length : 0
  const avgD = fin.length ? fin.reduce((s, b) => s + Math.max(1, Math.ceil((b.finished - (b.started || b.added)) / 864e5)), 0) / fin.length : 0
  const rated = books.filter(b => b.rating)
  const avgR = rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length) : 0
  const words = (await dbAll('words')).filter(w => w.mode === 'mean').sort((a, b) => b.ts - a.ts)
  const rank = [...RANKS].reverse().find(([n]) => fin.length >= n)[1]
  const next = RANKS.find(([n]) => n > fin.length)
  const a = prefs.ai, p = PROVIDERS[a.provider]
  const h = total / 3600
  $('#me-body').innerHTML = `
    <div class="me-head"><svg class="sketch"><use href="#sk-geo"/></svg>
      <p class="eyebrow">Perfil</p><h1>Mi cuaderno</h1>
      <div class="rank">${rank}</div>
      ${next ? `<p class="hint" style="margin:8px 0 0">${next[0] - fin.length} ${next[0] - fin.length === 1 ? 'libro' : 'libros'} para «${next[1]}»</p>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><b>${fin.length}</b><span>Libros leídos</span></div>
      <div class="stat"><b>${h >= 10 ? Math.round(h) : h.toFixed(1).replace('.', ',')}<small> h</small></b><span>Tiempo de lectura</span></div>
      <div class="stat"><b>${avgS ? (avgS / 3600).toFixed(1).replace('.', ',') : '—'}<small>${avgS ? ' h' : ''}</small></b><span>Promedio por libro</span></div>
      <div class="stat"><b>${avgD ? Math.round(avgD) : '—'}<small>${avgD ? (Math.round(avgD) === 1 ? ' día' : ' días') : ''}</small></b><span>Días por libro</span></div>
      <div class="stat"><b>${streak()}</b><span>Racha de días</span></div>
      <div class="stat"><b>${avgR ? avgR.toFixed(1).replace('.', ',') : '—'}<small>${avgR ? ' ★' : ''}</small></b><span>Nota media</span></div>
    </div>
    ${cur.length ? `<h2>En curso</h2>` + cur.map(b => `<button class="row" data-open="${b.id}"><div class="cv">${b.cover ? `<img src="${b.cover}">` : ''}</div><div class="bd">
        <div class="t">${esc(b.title)}</div><div class="m">${Math.round((b.progress || 0) * 100)} % · ${fmtDur(b.seconds || 0)}${b.chapter ? ' · ' + esc(b.chapter.slice(0, 34)) : ''}</div></div></button>`).join('') : ''}
    <h2>Leídos</h2>
    ${fin.length ? fin.map(b => `<button class="row" data-rate="${b.id}"><div class="cv">${b.cover ? `<img src="${b.cover}">` : ''}</div><div class="bd">
        <div class="t">${esc(b.title)}</div>
        <div class="m">${esc(b.author || '')}${b.author ? ' · ' : ''}${fmtDur(b.seconds || 0)} · ${nd(Math.max(1, Math.ceil((b.finished - (b.started || b.added)) / 864e5)), 'día', 'días')} · ${fmtDate(b.finished)}</div>
        <div class="stars">${stars(b.rating)}</div>${b.note ? `<div class="n">${esc(b.note)}</div>` : ''}</div></button>`).join('')
      : '<p class="hint">Cuando termines un libro aparecerá aquí con su duración y tu nota.</p>'}
    <h2>Vocabulario · ${words.length}</h2>
    ${words.length ? words.slice(0, 60).map(w => `<div class="word"><b>${esc(w.word)}</b> <small>${esc((w.book || '').slice(0, 30))}</small><p>${w.pending ? '<i>Pendiente de conexión</i>' : esc(w.text.replace(/\*\*/g, '')).replace(/\n+/g, ' · ')}</p></div>`).join('')
      : '<p class="hint">Las palabras que consultes con «Duda palabra» se guardan aquí y quedan disponibles sin conexión.</p>'}
    <h2>Ajustes del Consejo</h2>
    <div class="field"><label>Motor de IA</label><select id="ai-p">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === a.provider ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
    ${a.provider === 'free' ? `<p class="hint">Usa servicios públicos gratuitos sin registro. Sirven para empezar, pero van lentos o se saturan a ratos. Para respuestas mejores y más estables, elige Gemini o Groq y pega una clave gratuita (no piden tarjeta).</p>` : `
      ${a.provider === 'custom' ? `<div class="field"><label>URL base</label><input id="ai-b" type="text" value="${esc(a.base)}" placeholder="https://…/v1"></div>` : ''}
      <div class="field"><label>Clave</label><input id="ai-k" type="password" value="${esc(a.key)}" placeholder="Pega aquí tu clave"></div>
      <div class="field"><label>Modelo (vacío = automático)</label><input id="ai-m" type="text" value="${esc(a.model)}"></div>
      ${p.link ? `<p class="hint">Clave gratuita en <a href="${p.link}" target="_blank">${p.link.replace('https://', '')}</a>. Se guarda solo en este teléfono.</p>` : ''}`}
    <div class="field"><label>Idioma de las explicaciones</label><input id="ai-l" type="text" value="${esc(prefs.lang)}"></div>
    <div class="w-actions"><button class="btn-line on" id="ai-test">Probar conexión</button><span class="hint" id="ai-out" style="align-self:center;flex:1"></span></div>
    <p class="hint center" style="margin-top:34px;opacity:.7">Códice · 1.7</p>`
}
$('#me-body').addEventListener('click', async e => {
  const o = e.target.closest('[data-open]'); if (o) return openBook(o.dataset.open)
  const r = e.target.closest('[data-rate]'); if (r) return rateSheet(bookById(r.dataset.rate))
  const l = e.target.closest('a[href]'); if (l && window.Native?.openUrl) { e.preventDefault(); window.Native.openUrl(l.href) }
  if (e.target.id === 'ai-test') {
    const out = $('#ai-out'); out.textContent = 'Probando…'
    try { const t = await ask([{ role: 'user', content: 'Responde solo con la palabra: listo' }]); out.textContent = 'Funciona: ' + t.slice(0, 40) }
    catch (err) { out.textContent = err.message === 'offline' ? 'Sin conexión.' : err.message }
  }
})
$('#me-body').addEventListener('change', e => {
  const a = prefs.ai, id = e.target.id
  if (id === 'ai-p') { a.provider = e.target.value; a.model = ''; savePrefs(); renderMe() }
  if (id === 'ai-k') a.key = e.target.value.trim()
  if (id === 'ai-m') a.model = e.target.value.trim()
  if (id === 'ai-b') a.base = e.target.value.trim()
  if (id === 'ai-l') prefs.lang = e.target.value.trim() || 'español'
  for (const k in modelCache) delete modelCache[k]
  savePrefs()
})

/* ───────────── abrir desde otra app ("Abrir con") ───────────── */
window.__incoming = async () => {
  const name = window.Native?.pendingOpen?.(); if (!name) return
  try {
    const blob = await (await fetch('__incoming?' + Date.now())).blob()
    const existing = books.find(b => b.fileName === name && b.size === blob.size)
    const meta = existing || await addFiles([new File([blob], name, { type: blob.type })])
    if (meta) openBook(meta.id)
  } catch (e) { toast('No he podido importar el archivo.') }
}

/* ───────────── arranque ───────────── */
applyAppearance()
if (prefs.current && bookById(prefs.current)) go('read')
else go(books.length ? 'lib' : 'read')
window.__incoming()
window.__ready = true; window.__R = R
