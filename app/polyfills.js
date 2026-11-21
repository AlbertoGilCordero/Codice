/* Compatibilidad con WebView algo más antiguos (pdf.js usa APIs muy recientes) */
(g => {
  for (const C of [g.Map, g.WeakMap]) {
    C.prototype.getOrInsert ??= function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k) }
    C.prototype.getOrInsertComputed ??= function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k) }
  }
  Promise.withResolvers ??= function () { let resolve, reject; const promise = new this((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
  Promise.try ??= function (f, ...a) { return new this(r => r(f(...a))) }
  if (g.URL) g.URL.parse ??= (u, b) => { try { return new URL(u, b) } catch { return null } }
  Array.prototype.at ??= function (i) { i = Math.trunc(i) || 0; return this[i < 0 ? this.length + i : i] }
  Array.prototype.findLast ??= function (f, t) { for (let i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return this[i] }
  Set.prototype.intersection ??= function (o) { const r = new Set(); for (const v of this) if (o.has(v)) r.add(v); return r }
  const U = Uint8Array
  U.prototype.toHex ??= function () { let s = ''; for (const b of this) s += b.toString(16).padStart(2, '0'); return s }
  U.prototype.toBase64 ??= function () { let s = ''; for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000)); return btoa(s) }
  U.fromBase64 ??= s => U.from(atob(s), c => c.charCodeAt(0))
  if (g.AbortSignal) g.AbortSignal.any ??= sigs => { const c = new AbortController(); for (const s of sigs) { if (s.aborted) { c.abort(s.reason); break } s.addEventListener('abort', () => c.abort(s.reason), { once: true }) } return c.signal }
})(globalThis)
