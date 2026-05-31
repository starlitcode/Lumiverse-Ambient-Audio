const DB_NAME = 'ambient_audio'
const DB_VERSION = 2
const STORE_AUDIO = 'audio_files'
const STORE_ART = 'art_files'
const STORE_STATE = 'app_state'
const SETTINGS_KEY = 'settings'

const TICK_MS = 80
const DETECT_EVERY = 5
const DETECTION_STABLE_MS = 400
const MIN_SPEECH_SECONDS = 1.2
const BACKUP_FORMAT = 'ambient-audio-backup'

const COMMON_EXPRESSIONS = [
  'neutral', 'happy', 'sad', 'angry', 'surprised', 'embarrassed', 'thinking',
  'smirk', 'scared', 'confused', 'excited', 'blushing', 'crying', 'laughing',
  'serious', 'flirty', 'annoyed', 'worried',
]

export function setup(ctx) {

  // ============================================================
  // State
  // ============================================================

  const DEFAULT_SETTINGS = {
    tracks: [],
    masterVolume: 0.8,
    masterMuted: false,
    ttsAutoLower: true,
    ttsLowerTo: 0.25,
    autoplayOnStartup: true,
    showAlbumArt: true,
    playerAccent: '',     // empty = use the theme accent
    playerBg: '',         // empty = use the theme surface color
    playerGlass: true,    // true = frosted glass, false = solid
    playerBlur: 6,        // px backdrop blur (glass only)
    playerShadow: '',     // empty = default dark shadow
    playerShadowSize: 28, // px shadow blur (0 = no shadow)
    playerBorder: true,
    playerRadius: 12,     // px corner roundness
    playerWidth: 240,     // px box width
    playerSpacing: 8,     // px padding and gaps between elements
    nicknames: {},
  }

  let settings = { ...DEFAULT_SETTINGS }

  const audio = new Map()
  const objectUrls = new Map()
  const floatingBoxes = new Map()

  let audioCtx = null
  let ctxResumeBound = false

  let activeBackground = ''
  let activeExpression = ''
  let ttsActive = false

  let pendingBg = null
  let pendingBgSince = 0

  let db = null
  let panelEl = null
  let reconcileTimer = null
  let tickCount = 0
  let detectedBackgrounds = []
  const detectedExpressions = new Set(COMMON_EXPRESSIONS)
  const eventUnsubs = []
  let lastStatusKey = ''
  let suppressAutoplay = false

  // ============================================================
  // Helpers
  // ============================================================

  const clamp = (v) => Math.min(1, Math.max(0, v))

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  function displayName(rawId) {
    return settings.nicknames[rawId] || rawId
  }

  function migrateTrack(t) {
    let triggerType = t.triggerType || (t.locked ? 'background' : 'global')
    if (triggerType === 'mood') triggerType = 'global'
    if (!['global', 'background', 'expression'].includes(triggerType)) triggerType = 'global'

    let linkKeyword = t.linkKeyword ?? ''
    if (!linkKeyword) {
      if (triggerType === 'background') linkKeyword = t.lockedToImage ?? ''
      else if (triggerType === 'expression') linkKeyword = t.expressionTags ?? ''
    }

    return {
      id: t.id,
      name: t.name || 'Untitled track',
      muted: t.muted ?? false,
      volume: typeof t.volume === 'number' ? t.volume : 0.7,
      loop: t.loop !== false,
      triggerType,
      linkTarget: t.linkTarget ?? '',
      linkKeyword,
      hasArt: t.hasArt ?? false,
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })
  }

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl)
    return res.blob()
  }

  // ============================================================
  // Storage (IndexedDB)
  // ============================================================

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const d = e.target.result
        if (!d.objectStoreNames.contains(STORE_AUDIO)) d.createObjectStore(STORE_AUDIO, { keyPath: 'id' })
        if (!d.objectStoreNames.contains(STORE_ART)) d.createObjectStore(STORE_ART, { keyPath: 'id' })
        if (!d.objectStoreNames.contains(STORE_STATE)) d.createObjectStore(STORE_STATE, { keyPath: 'key' })
      }
      req.onsuccess = (e) => resolve(e.target.result)
      req.onerror = () => reject(req.error)
    })
  }

  function loadSettingsFromDB() {
    return new Promise((resolve) => {
      if (!db) return resolve(null)
      const tx = db.transaction(STORE_STATE, 'readonly')
      const req = tx.objectStore(STORE_STATE).get(SETTINGS_KEY)
      req.onsuccess = () => resolve(req.result ? req.result.value : null)
      req.onerror = () => resolve(null)
    })
  }

  function saveSettings() {
    if (!db) return
    try {
      const tx = db.transaction(STORE_STATE, 'readwrite')
      tx.objectStore(STORE_STATE).put({ key: SETTINGS_KEY, value: settings })
    } catch (e) {
      console.warn('[AmbientAudio] could not save settings:', e)
    }
  }

  function saveAudioBlob(id, blob) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO, 'readwrite')
      tx.objectStore(STORE_AUDIO).put({ id, blob })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  function getAudioBlob(id) {
    return new Promise((resolve) => {
      if (!db) return resolve(null)
      const tx = db.transaction(STORE_AUDIO, 'readonly')
      const req = tx.objectStore(STORE_AUDIO).get(id)
      req.onsuccess = () => resolve(req.result ? req.result.blob : null)
      req.onerror = () => resolve(null)
    })
  }

  function deleteAudioBlob(id) {
    return new Promise((resolve) => {
      if (!db) return resolve()
      const tx = db.transaction(STORE_AUDIO, 'readwrite')
      tx.objectStore(STORE_AUDIO).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  }

  function saveArtBlob(id, blob) {
    return new Promise((resolve) => {
      if (!db) return resolve()
      const tx = db.transaction(STORE_ART, 'readwrite')
      tx.objectStore(STORE_ART).put({ id, blob })
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  }

  function getArtBlob(id) {
    return new Promise((resolve) => {
      if (!db) return resolve(null)
      const tx = db.transaction(STORE_ART, 'readonly')
      const req = tx.objectStore(STORE_ART).get(id)
      req.onsuccess = () => resolve(req.result ? req.result.blob : null)
      req.onerror = () => resolve(null)
    })
  }

  function deleteArtBlob(id) {
    return new Promise((resolve) => {
      if (!db) return resolve()
      const tx = db.transaction(STORE_ART, 'readwrite')
      tx.objectStore(STORE_ART).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  }

  // ============================================================
  // Embedded album art
  // ============================================================

  function parseEmbeddedArt(bytes) {
    try {
      if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null
      const major = bytes[3]
      const flags = bytes[5]
      const synch = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d
      const tagSize = synch(bytes[6], bytes[7], bytes[8], bytes[9])
      let pos = 10
      if (flags & 0x40) {
        const extSize = major === 4
          ? synch(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
          : (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
        pos += 4 + extSize
      }
      const end = Math.min(10 + tagSize, bytes.length)
      while (pos + 10 <= end) {
        const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
        const frameSize = major === 4
          ? synch(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
          : (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]
        const frameStart = pos + 10
        if (id === 'APIC') return parseApicFrame(bytes, frameStart, frameSize)
        if (frameSize <= 0) break
        pos = frameStart + frameSize
      }
      return null
    } catch {
      return null
    }
  }

  function parseApicFrame(bytes, start, size) {
    try {
      let p = start
      const enc = bytes[p]; p++
      let mime = ''
      while (p < start + size && bytes[p] !== 0) { mime += String.fromCharCode(bytes[p]); p++ }
      p++
      p++
      if (enc === 1 || enc === 2) {
        while (p + 1 < start + size && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2
        p += 2
      } else {
        while (p < start + size && bytes[p] !== 0) p++
        p++
      }
      const data = bytes.slice(p, start + size)
      if (!data.length) return null
      return { mime: mime || 'image/jpeg', data }
    } catch {
      return null
    }
  }

  // ============================================================
  // Audio runtime
  // ============================================================

  // iOS ignores HTMLAudioElement.volume entirely, so all volume and fading
  // goes through a Web Audio GainNode per track. The element still drives
  // play/pause/seek/loop. Gain ramps also keep volume changes click-free.
  // The context must be created on a real user gesture (iOS requirement), so
  // it is not created until the first interaction.
  function getCtx() {
    if (audioCtx) return audioCtx
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      audioCtx = new Ctx()
    } catch {
      audioCtx = null
    }
    return audioCtx
  }

  // Create (on first gesture) and resume the context. Wired to window events.
  function bindCtxResume() {
    if (ctxResumeBound) return
    ctxResumeBound = true
    const kick = () => { const c = getCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {}) }
    const opts = { capture: true, passive: true }
    for (const ev of ['pointerdown', 'touchstart', 'touchend', 'keydown', 'click']) {
      window.addEventListener(ev, kick, opts)
    }
  }

  // Connect a track's element into ctx -> source -> gain -> destination, once
  // the context exists. Does not create the context itself.
  function ensureGraph(entry) {
    const ctx = audioCtx
    if (!ctx) return false
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    if (entry.gain) return true
    if (entry.graphFailed) return false
    try {
      if (!entry.srcNode) entry.srcNode = ctx.createMediaElementSource(entry.el)
      entry.gain = ctx.createGain()
      entry.gain.gain.value = entry.pendingGain ?? 0
      entry.srcNode.connect(entry.gain)
      entry.gain.connect(ctx.destination)
      return true
    } catch {
      entry.graphFailed = true
      entry.gain = null
      return false
    }
  }

  function getGain(entry) {
    if (entry.gain) return entry.gain.gain.value
    return entry.pendingGain ?? entry.el.volume
  }

  // Set a track's gain. A very short ramp avoids the click a hard gain jump
  // would cause; it is not a crossfade.
  function setGain(entry, value) {
    const v = clamp(value)
    entry.pendingGain = v
    if (ensureGraph(entry) && entry.gain && audioCtx) {
      const p = entry.gain.gain
      const now = audioCtx.currentTime
      try {
        p.cancelScheduledValues(now)
        p.setValueAtTime(p.value, now)
        p.linearRampToValueAtTime(v, now + 0.015)
      } catch {
        p.value = v
      }
    } else {
      // No Web Audio yet: remember the level and use element volume as a
      // fallback (a no-op on iOS, but there is no audio before a gesture anyway).
      entry.el.volume = v
    }
  }

  async function getOrCreateAudio(track) {
    if (audio.has(track.id)) return audio.get(track.id)
    const blob = await getAudioBlob(track.id)
    if (!blob) return null
    const old = objectUrls.get(track.id)
    if (old) URL.revokeObjectURL(old)
    const url = URL.createObjectURL(blob)
    objectUrls.set(track.id, url)
    const el = new Audio(url)
    el.loop = track.loop
    el.volume = 1
    const entry = { el, fired: false, gain: null, srcNode: null, pendingGain: 0 }
    el.addEventListener('ended', () => refreshPlayStates())
    audio.set(track.id, entry)
    ensureGraph(entry)
    return entry
  }

  function destroyAudio(id) {
    const entry = audio.get(id)
    if (entry) {
      entry.el.pause()
      try { entry.srcNode?.disconnect() } catch { /* ignore */ }
      try { entry.gain?.disconnect() } catch { /* ignore */ }
      entry.el.src = ''
      audio.delete(id)
    }
    const url = objectUrls.get(id)
    if (url) { URL.revokeObjectURL(url); objectUrls.delete(id) }
  }

  function computeVolume(track) {
    if (track.muted || settings.masterMuted) return 0
    const tts = (ttsActive && settings.ttsAutoLower) ? clamp(settings.ttsLowerTo) : 1
    return clamp(track.volume * settings.masterVolume * tts)
  }

  function matchesSource(current, track) {
    if (!current) return false
    if (track.linkTarget && current === track.linkTarget) return true
    if (track.linkKeyword) {
      const cur = current.toLowerCase()
      const nick = (settings.nicknames[current] || '').toLowerCase()
      const keywords = track.linkKeyword.split(',').map((k) => k.toLowerCase().trim()).filter(Boolean)
      for (const kw of keywords) {
        if (cur.includes(kw)) return true
        if (nick && nick.includes(kw)) return true
      }
    }
    return false
  }

  function shouldPlay(track) {
    if (suppressAutoplay) return false
    if (track.muted || settings.masterMuted) return false
    switch (track.triggerType) {
      case 'global':
        return true
      case 'background':
        if (!track.linkTarget && !track.linkKeyword.trim()) return true
        return matchesSource(activeBackground, track)
      case 'expression':
        if (!track.linkTarget && !track.linkKeyword.trim()) return false
        return matchesSource(activeExpression, track)
      default:
        return true
    }
  }

  // ============================================================
  // Reconcile loop
  // ============================================================

  function reconcileTrack(track) {
    const entry = audio.get(track.id)
    if (!entry) return
    if (floatingBoxes.has(track.id)) return
    ensureGraph(entry)
    const el = entry.el
    const play = shouldPlay(track)

    if (!track.loop) {
      if (play && !entry.fired) {
        entry.fired = true
        try { el.currentTime = 0 } catch { /* ignore */ }
        setGain(entry, computeVolume(track))
        el.play().catch(() => {})
      } else if (!play) {
        entry.fired = false
        if (!el.paused) { el.pause(); try { el.currentTime = 0 } catch { /* ignore */ } }
      }
      return
    }

    const target = play ? computeVolume(track) : 0

    if (el.loop !== track.loop) el.loop = track.loop

    if (entry.gainTarget === undefined) entry.gainTarget = getGain(entry)
    if (target !== entry.gainTarget) {
      setGain(entry, target)
      entry.gainTarget = target
    }

    if (target > 0) {
      if (el.paused) el.play().catch(() => {})
    } else if (!el.paused) {
      el.pause()
    }
  }

  function tick() {
    tickCount++
    if (tickCount % DETECT_EVERY === 0) {
      ttsActive = isSpeechPlaying()
      pollBackground()
      detectedBackgrounds = collectAllBgs()
    }
    for (const track of settings.tracks) reconcileTrack(track)
    updateFloatingBoxes()
    updateStatus()
  }

  function startLoop() {
    if (reconcileTimer) return
    reconcileTimer = setInterval(tick, TICK_MS)
  }

  // ============================================================
  // Scene detection
  // ============================================================

  function extractFilename(rawUrl) {
    try {
      return decodeURIComponent(rawUrl).split('/').pop()?.split('?')[0] || ''
    } catch {
      return rawUrl.split('/').pop()?.split('?')[0] || ''
    }
  }

  function extractFromCss(cssVal) {
    const m = cssVal.match(/url\(["']?([^"')]+)["']?\)/)
    return m ? extractFilename(m[1]) : ''
  }

  function videoFilename(videoEl) {
    const src = videoEl.src || videoEl.currentSrc
    if (src && src !== window.location.href) return extractFilename(src)
    const s = videoEl.querySelector('source')
    return s?.src ? extractFilename(s.src) : ''
  }

  function detectActiveBg() {
    const videos = document.querySelectorAll('video')
    for (const v of videos) {
      if (!v.paused) { const fn = videoFilename(v); if (fn) return fn }
    }
    for (const v of videos) {
      const fn = videoFilename(v); if (fn) return fn
    }
    for (const el of document.querySelectorAll('[style]')) {
      const bg = el.style?.backgroundImage
      if (bg && bg !== 'none') { const fn = extractFromCss(bg); if (fn) return fn }
    }
    for (const sel of ['body', 'main', '#root', '#app', '[class*="chat"]', '[class*="scene"]']) {
      const el = document.querySelector(sel)
      if (!el) continue
      const bg = window.getComputedStyle(el).backgroundImage
      if (bg && bg !== 'none') { const fn = extractFromCss(bg); if (fn) return fn }
    }
    return ''
  }

  function collectAllBgs() {
    const found = new Map()
    document.querySelectorAll('video').forEach((v) => {
      const fn = videoFilename(v)
      if (fn) found.set(fn, { filename: fn, type: 'video' })
    })
    document.querySelectorAll('[style]').forEach((el) => {
      const bg = el.style?.backgroundImage
      if (bg && bg !== 'none') {
        const fn = extractFromCss(bg)
        if (fn && !found.has(fn)) found.set(fn, { filename: fn, type: 'image' })
      }
    })
    for (const sel of ['body', 'main', '#root', '#app', '[class*="background"]', '[class*="scene"]']) {
      const el = document.querySelector(sel)
      if (!el) continue
      const bg = window.getComputedStyle(el).backgroundImage
      if (bg && bg !== 'none') {
        const fn = extractFromCss(bg)
        if (fn && !found.has(fn)) found.set(fn, { filename: fn, type: 'image' })
      }
    }
    return Array.from(found.values())
  }

  function pollBackground() {
    const fn = detectActiveBg()
    if (!fn) { pendingBg = null; return }
    if (fn === activeBackground) { pendingBg = null; return }
    const now = Date.now()
    if (fn === pendingBg) {
      if (now - pendingBgSince >= DETECTION_STABLE_MS) {
        activeBackground = fn
        pendingBg = null
        suppressAutoplay = false
      }
    } else {
      pendingBg = fn
      pendingBgSince = now
    }
  }

  function handleExpressionChange(label) {
    const clean = (label || '').toLowerCase().trim()
    if (!clean) return
    detectedExpressions.add(clean)
    activeExpression = clean
    suppressAutoplay = false
  }

  // ============================================================
  // TTS detection
  // ============================================================

  function isOwnAudio(el) {
    for (const a of audio.values()) if (a.el === el) return true
    return false
  }

  function isSpeechPlaying() {
    if (('speechSynthesis' in window) && window.speechSynthesis.speaking) return true
    for (const el of document.querySelectorAll('audio')) {
      if (isOwnAudio(el) || el.paused || el.ended) continue
      const dur = el.duration
      if (!Number.isNaN(dur) && dur > 0 && dur < MIN_SPEECH_SECONDS) continue
      return true
    }
    return false
  }

  // ============================================================
  // Styles
  // ============================================================

  const tab = ctx.ui.registerDrawerTab({
    id: 'ambient_audio_tab',
    title: 'Ambient Audio',
    shortName: 'Audio',
    description: 'Background music and ambient sounds for your chats',
    keywords: ['music', 'audio', 'ambient', 'sound', 'bgm'],
    iconSvg: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="5" width="5" height="10" rx="1" fill="currentColor" opacity="0.9"/>
      <rect x="9" y="3" width="5" height="14" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="16" y="7" width="2" height="6" rx="1" fill="currentColor" opacity="0.5"/>
    </svg>`,
  })

  const removeStyles = ctx.dom.addStyle(`
    .aa-panel{display:flex;flex-direction:column;height:100%;overflow:hidden;font-family:inherit}
    .aa-hdr{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--lumiverse-border);flex-shrink:0}
    .aa-hdr-label{font-size:11px;color:var(--lumiverse-text-muted);white-space:nowrap;flex-shrink:0}
    .aa-slider-wrap{display:flex;align-items:center;gap:5px;flex:1;min-width:0}
    .aa-slider{-webkit-appearance:none;appearance:none;flex:1;height:3px;border-radius:2px;background:var(--lumiverse-border);outline:none;cursor:pointer;min-width:0}
    .aa-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:var(--lumiverse-accent);cursor:pointer;transition:transform 100ms}
    .aa-slider::-webkit-slider-thumb:hover{transform:scale(1.25)}
    .aa-pct{font-size:11px;color:var(--lumiverse-text-dim);width:26px;text-align:right;flex-shrink:0}
    .aa-ibtn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:var(--lumiverse-radius);border:1px solid var(--lumiverse-border);background:var(--lumiverse-fill-subtle);color:var(--lumiverse-text);cursor:pointer;font-size:12px;flex-shrink:0;transition:background var(--lumiverse-transition-fast),border-color var(--lumiverse-transition-fast);padding:0;line-height:1}
    .aa-ibtn:hover{background:var(--lumiverse-border);border-color:var(--lumiverse-border-hover)}
    .aa-ibtn.aa-on{border-color:var(--lumiverse-accent);color:var(--lumiverse-accent)}
    .aa-ibtn.aa-danger{color:#f87171}
    .aa-ibtn.aa-danger:hover{background:rgba(248,113,113,0.12);border-color:#f87171}

    .aa-status{display:flex;flex-direction:column;gap:3px;padding:6px 12px;border-bottom:1px solid var(--lumiverse-border);flex-shrink:0}
    .aa-status-line{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--lumiverse-text-dim);min-height:15px}
    .aa-status-key{color:var(--lumiverse-text-muted);flex-shrink:0}
    .aa-status-val{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--lumiverse-text)}
    .aa-status-tag{font-size:10px;background:var(--lumiverse-fill-subtle);border:1px solid var(--lumiverse-border);border-radius:3px;padding:1px 4px;flex-shrink:0}
    .aa-status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--lumiverse-border)}
    .aa-status-dot.aa-live{background:var(--lumiverse-accent)}

    .aa-tracks{flex:1;overflow-y:auto;padding:8px 10px 4px;display:flex;flex-direction:column;gap:7px}
    .aa-tracks::-webkit-scrollbar{width:3px}
    .aa-tracks::-webkit-scrollbar-thumb{background:var(--lumiverse-border);border-radius:2px}
    .aa-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 16px;text-align:center;color:var(--lumiverse-text-dim);gap:8px}
    .aa-empty-icon{font-size:28px;opacity:0.35}
    .aa-empty-hint{font-size:12px;line-height:1.5;max-width:190px}

    .aa-card{background:var(--lumiverse-fill-subtle);border:1px solid var(--lumiverse-border);border-radius:var(--lumiverse-radius);padding:8px 10px;display:flex;flex-direction:column;gap:6px;transition:border-color var(--lumiverse-transition-fast)}
    .aa-card.aa-playing{border-color:var(--lumiverse-accent)}
    .aa-row{display:flex;align-items:center;gap:6px}
    .aa-name{flex:1;min-width:0;font-size:12.5px;color:var(--lumiverse-text);background:transparent;border:1px solid transparent;border-radius:4px;padding:2px 5px;outline:none;font-family:inherit}
    .aa-name:hover{border-color:var(--lumiverse-border)}
    .aa-name:focus{border-color:var(--lumiverse-accent);background:var(--lumiverse-fill)}
    .aa-volpct{font-size:11px;color:var(--lumiverse-text-dim);width:26px;text-align:right;flex-shrink:0}

    .aa-triggers{display:grid;grid-template-columns:repeat(3, 1fr);gap:4px}
    .aa-trig{padding:4px 2px;font-size:10.5px;text-align:center;border-radius:3px;border:1px solid var(--lumiverse-border);background:var(--lumiverse-fill);color:var(--lumiverse-text-muted);cursor:pointer;transition:all var(--lumiverse-transition-fast);white-space:nowrap}
    .aa-trig:hover{border-color:var(--lumiverse-border-hover);color:var(--lumiverse-text)}
    .aa-trig.aa-sel{border-color:var(--lumiverse-accent);background:color-mix(in srgb, var(--lumiverse-accent) 10%, transparent);color:var(--lumiverse-accent)}

    .aa-detail{display:flex;flex-direction:column;gap:4px}
    .aa-field{padding:4px 8px;background:var(--lumiverse-fill);border:1px solid var(--lumiverse-border);border-radius:calc(var(--lumiverse-radius) * 0.6);color:var(--lumiverse-text);font-size:11px;outline:none;transition:border-color var(--lumiverse-transition-fast);width:100%;box-sizing:border-box;font-family:inherit}
    .aa-field:focus{border-color:var(--lumiverse-accent)}
    .aa-field::placeholder{color:var(--lumiverse-text-dim)}
    select.aa-field{cursor:pointer}
    .aa-hint{font-size:10px;color:var(--lumiverse-text-dim);line-height:1.45}
    .aa-or{display:flex;align-items:center;gap:6px;font-size:9.5px;text-transform:uppercase;letter-spacing:0.06em;color:var(--lumiverse-text-dim);margin:1px 0}
    .aa-or::before,.aa-or::after{content:"";flex:1;height:1px;background:var(--lumiverse-border)}

    .aa-addbtn{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px 12px;margin:3px 10px 10px;border:1px dashed var(--lumiverse-border);border-radius:var(--lumiverse-radius);background:transparent;color:var(--lumiverse-text-muted);cursor:pointer;font-size:12px;flex-shrink:0;transition:border-color var(--lumiverse-transition-fast),color var(--lumiverse-transition-fast)}
    .aa-addbtn:hover{border-color:var(--lumiverse-accent);color:var(--lumiverse-accent)}

    .aa-modal-section{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
    .aa-modal-title{font-size:12px;font-weight:600;color:var(--lumiverse-text);letter-spacing:0.02em}
    .aa-modal-note{font-size:11px;color:var(--lumiverse-text-dim);line-height:1.5}
    .aa-setting-row{display:flex;align-items:center;gap:10px;padding:5px 0}
    .aa-setting-label{flex:1;font-size:12.5px;color:var(--lumiverse-text)}
    .aa-setting-sub{font-size:11px;color:var(--lumiverse-text-dim);margin-top:2px}
    .aa-toggle-wrap{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .aa-toggle-state{font-size:11px;font-weight:600;letter-spacing:0.03em;width:22px;text-align:right;color:var(--lumiverse-text-dim)}
    .aa-toggle-state.aa-on{color:var(--lumiverse-accent)}
    .aa-toggle{position:relative;width:42px;height:24px;flex-shrink:0;cursor:pointer}
    .aa-toggle input{opacity:0;width:0;height:0;position:absolute;margin:0}
    .aa-toggle-track{position:absolute;inset:0;box-sizing:border-box;border-radius:24px;background:var(--lumiverse-border);border:1px solid var(--lumiverse-border-hover);cursor:pointer;transition:background 180ms,border-color 180ms,box-shadow 180ms;box-shadow:inset 0 1px 2px rgba(0,0,0,0.22)}
    .aa-toggle-thumb{position:absolute;top:4px;left:4px;width:16px;height:16px;border-radius:50%;background:var(--lumiverse-text-dim);transition:transform 180ms,background 180ms;box-shadow:0 1px 2px rgba(0,0,0,0.3);pointer-events:none}
    .aa-toggle input:checked + .aa-toggle-track{background:var(--lumiverse-accent);border-color:var(--lumiverse-accent);box-shadow:0 0 8px color-mix(in srgb, var(--lumiverse-accent) 50%, transparent)}
    .aa-toggle input:checked ~ .aa-toggle-thumb{transform:translateX(18px);background:#ffffff}

    .aa-src-item{display:flex;align-items:center;gap:8px;padding:6px 9px;background:var(--lumiverse-fill-subtle);border:1px solid var(--lumiverse-border);border-radius:var(--lumiverse-radius)}
    .aa-src-icon{font-size:14px;flex-shrink:0}
    .aa-src-raw{flex:1;min-width:0;font-size:11px;color:var(--lumiverse-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .aa-src-nick{width:110px;flex-shrink:0;padding:3px 7px;background:var(--lumiverse-fill);border:1px solid var(--lumiverse-border);border-radius:4px;color:var(--lumiverse-text);font-size:11px;outline:none;font-family:inherit}
    .aa-src-nick:focus{border-color:var(--lumiverse-accent)}
    .aa-src-list{display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto}
    .aa-src-list::-webkit-scrollbar{width:3px}
    .aa-src-list::-webkit-scrollbar-thumb{background:var(--lumiverse-border);border-radius:2px}
    .aa-src-empty{padding:14px;text-align:center;color:var(--lumiverse-text-dim);font-size:11.5px;line-height:1.6}

    .aa-btn{display:block;width:100%;padding:7px 12px;border:1px solid var(--lumiverse-border);border-radius:var(--lumiverse-radius);background:transparent;color:var(--lumiverse-text);cursor:pointer;font-size:11.5px;transition:border-color var(--lumiverse-transition-fast),color var(--lumiverse-transition-fast)}
    .aa-btn:hover{border-color:var(--lumiverse-accent);color:var(--lumiverse-accent)}
    .aa-btn.aa-danger{color:var(--lumiverse-text-muted)}
    .aa-btn.aa-danger:hover{border-color:#f87171;color:#f87171}
    .aa-btn-row{display:flex;gap:6px}
    .aa-btn-row .aa-btn{flex:1}
    .aa-color{width:40px;height:26px;padding:0;border:1px solid var(--lumiverse-border);border-radius:6px;background:transparent;cursor:pointer;flex-shrink:0}
    .aa-mini-btn{padding:3px 9px;font-size:10.5px;border:1px solid var(--lumiverse-border);border-radius:5px;background:transparent;color:var(--lumiverse-text-muted);cursor:pointer;flex-shrink:0}
    .aa-mini-btn:hover{border-color:var(--lumiverse-accent);color:var(--lumiverse-accent)}

    /* Floating pop-out players. Box look (bg, blur, border, radius) is set inline. */
    .aa-float{position:fixed;z-index:2147483000;width:240px;max-width:92vw;background:var(--lumiverse-fill,#1a1a1f);box-shadow:0 8px 28px rgba(0,0,0,0.45);display:flex;flex-direction:column;overflow:hidden;font-family:inherit;--aa-accent:var(--lumiverse-accent);--aa-gap:8px}
    .aa-float.aa-dragging{opacity:0.92}
    .aa-float-head{display:flex;align-items:center;gap:var(--aa-gap);padding:var(--aa-gap);cursor:grab;touch-action:none;border-bottom:1px solid var(--lumiverse-border)}
    .aa-float-head:active{cursor:grabbing}
    .aa-float-art{width:34px;height:34px;border-radius:5px;flex-shrink:0;background-size:cover;background-position:center;background-color:var(--lumiverse-fill-subtle);display:flex;align-items:center;justify-content:center;font-size:16px}
    .aa-float-art.aa-noart{color:var(--lumiverse-text-dim)}
    .aa-float-name{flex:1;min-width:0;font-size:12px;color:var(--lumiverse-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .aa-float-x{flex-shrink:0;width:22px;height:22px;border:none;background:transparent;color:var(--lumiverse-text-dim);cursor:pointer;border-radius:4px;font-size:12px;line-height:1}
    .aa-float-x:hover{background:var(--lumiverse-fill-subtle);color:var(--lumiverse-text)}
    .aa-float-seekrow{display:flex;align-items:center;gap:calc(var(--aa-gap) * 0.75);padding:calc(var(--aa-gap) * 0.75) var(--aa-gap) calc(var(--aa-gap) * 0.25)}
    .aa-float-cur,.aa-float-dur{font-size:9.5px;color:var(--lumiverse-text-dim);width:26px;flex-shrink:0;text-align:center}
    .aa-float-seek{flex:1;-webkit-appearance:none;appearance:none;height:3px;border-radius:2px;background:var(--lumiverse-border);outline:none;cursor:pointer;min-width:0}
    .aa-float-seek::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:var(--aa-accent);cursor:pointer}
    .aa-float-ctrls{display:flex;align-items:center;gap:var(--aa-gap);padding:calc(var(--aa-gap) * 0.5) var(--aa-gap) calc(var(--aa-gap) * 1.1)}
    .aa-float-play{width:30px;height:30px;flex-shrink:0;border-radius:50%;border:1px solid var(--aa-accent);background:var(--aa-accent);color:#fff;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center}
    .aa-float-play:hover{filter:brightness(1.1)}
    .aa-float-volicon{font-size:11px;flex-shrink:0;color:var(--lumiverse-text-dim)}
    .aa-float-vol{flex:1;-webkit-appearance:none;appearance:none;height:3px;border-radius:2px;background:var(--lumiverse-border);outline:none;cursor:pointer;min-width:0}
    .aa-float-vol::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:var(--aa-accent);cursor:pointer}

    /* Touch devices: bigger tap targets */
    @media (pointer: coarse){
      .aa-ibtn{width:32px;height:32px;font-size:14px}
      .aa-trig{padding:7px 2px}
      .aa-slider{height:5px}
      .aa-slider::-webkit-slider-thumb{width:16px;height:16px}
      .aa-float{width:270px}
      .aa-float-play{width:36px;height:36px}
      .aa-float-x{width:28px;height:28px}
      .aa-float-seek,.aa-float-vol{height:5px}
      .aa-float-seek::-webkit-slider-thumb,.aa-float-vol::-webkit-slider-thumb{width:15px;height:15px}
    }
  `)

  // ============================================================
  // Panel
  // ============================================================

  function buildPanel() {
    const panel = document.createElement('div')
    panel.className = 'aa-panel'

    const hdr = document.createElement('div')
    hdr.className = 'aa-hdr'
    hdr.innerHTML = `
      <span class="aa-hdr-label">Master</span>
      <div class="aa-slider-wrap">
        <input type="range" class="aa-slider aa-mvol" min="0" max="1" step="0.01" value="${settings.masterVolume}">
        <span class="aa-pct aa-mvol-pct">${Math.round(settings.masterVolume * 100)}%</span>
      </div>
      <button class="aa-ibtn aa-mute ${settings.masterMuted ? 'aa-on' : ''}" title="${settings.masterMuted ? 'Unmute everything' : 'Mute everything'}">${settings.masterMuted ? '🔇' : '🔊'}</button>
      <button class="aa-ibtn aa-src-btn" title="Backgrounds and expressions">🖼</button>
      <button class="aa-ibtn aa-settings-btn" title="Settings">⚙</button>
    `
    panel.appendChild(hdr)

    const status = document.createElement('div')
    status.className = 'aa-status'
    panel.appendChild(status)

    const trackList = document.createElement('div')
    trackList.className = 'aa-tracks'
    panel.appendChild(trackList)

    const addBtn = document.createElement('button')
    addBtn.className = 'aa-addbtn'
    addBtn.innerHTML = '+ Add Audio'
    panel.appendChild(addBtn)

    const mvol = hdr.querySelector('.aa-mvol')
    const mvolPct = hdr.querySelector('.aa-mvol-pct')
    const muteBtn = hdr.querySelector('.aa-mute')
    mvol.addEventListener('input', () => {
      settings.masterVolume = parseFloat(mvol.value)
      mvolPct.textContent = `${Math.round(settings.masterVolume * 100)}%`
      saveSettings()
    })
    muteBtn.addEventListener('click', () => {
      settings.masterMuted = !settings.masterMuted
      muteBtn.textContent = settings.masterMuted ? '🔇' : '🔊'
      muteBtn.title = settings.masterMuted ? 'Unmute everything' : 'Mute everything'
      muteBtn.classList.toggle('aa-on', settings.masterMuted)
      saveSettings()
    })
    hdr.querySelector('.aa-src-btn').addEventListener('click', showSourcesModal)
    hdr.querySelector('.aa-settings-btn').addEventListener('click', showSettingsModal)
    addBtn.addEventListener('click', handleAddTrack)

    panelEl = panel
    renderTrackList(trackList)
    lastStatusKey = ''
    updateStatus()
    tab.root.innerHTML = ''
    tab.root.appendChild(panel)
  }

  function renderTrackList(container) {
    container.innerHTML = ''
    if (!settings.tracks.length) {
      container.innerHTML = `
        <div class="aa-empty">
          <div class="aa-empty-icon">🎵</div>
          <div class="aa-empty-hint">No audio tracks yet. Hit "Add Audio" below to upload your first one.</div>
        </div>`
      return
    }
    for (const track of settings.tracks) container.appendChild(buildCard(track))
  }

  function buildCard(track) {
    const entry = audio.get(track.id)
    const isPlaying = !!entry && !entry.el.paused && getGain(entry) > 0.01
    const card = document.createElement('div')
    card.className = `aa-card${isPlaying ? ' aa-playing' : ''}`
    card.dataset.trackId = track.id

    const row1 = document.createElement('div')
    row1.className = 'aa-row'
    row1.innerHTML = `
      <button class="aa-ibtn aa-tmute ${track.muted ? 'aa-on' : ''}" title="${track.muted ? 'Unmute this track' : 'Mute this track'}">${track.muted ? '🔇' : '🔈'}</button>
      <button class="aa-ibtn aa-loop ${track.loop ? 'aa-on' : ''}" title="${track.loop ? 'Looping. Click to play once instead.' : 'Plays once. Click to loop instead.'}">🔁</button>
      <input class="aa-name" value="${escapeHtml(track.name)}" title="Click to rename" placeholder="Track name">
      <button class="aa-ibtn aa-pop ${floatingBoxes.has(track.id) ? 'aa-on' : ''}" title="Pop out a floating player">⧉</button>
      <button class="aa-ibtn aa-danger aa-del" title="Remove track">🗑</button>
    `

    const row2 = document.createElement('div')
    row2.className = 'aa-row'
    row2.innerHTML = `
      <span class="aa-hdr-label" style="width:18px">Vol</span>
      <input type="range" class="aa-slider aa-vol" min="0" max="1" step="0.01" value="${track.volume}">
      <span class="aa-volpct">${Math.round(track.volume * 100)}%</span>
    `

    const row3 = document.createElement('div')
    row3.className = 'aa-triggers'
    const modeLabels = { global: 'Global', background: 'Background', expression: 'Expression' }
    const modeTitles = {
      global: 'Plays all the time',
      background: 'Plays when a chosen background is showing',
      expression: 'Plays when a chosen character expression is active',
    }
    for (const mode of ['global', 'background', 'expression']) {
      const btn = document.createElement('button')
      btn.className = `aa-trig${track.triggerType === mode ? ' aa-sel' : ''}`
      btn.dataset.mode = mode
      btn.textContent = modeLabels[mode]
      btn.title = modeTitles[mode]
      row3.appendChild(btn)
    }

    const row4 = document.createElement('div')
    row4.className = 'aa-detail'
    renderLinkDetail(row4, track)

    card.appendChild(row1)
    card.appendChild(row2)
    card.appendChild(row3)
    if (track.triggerType !== 'global') card.appendChild(row4)

    row1.querySelector('.aa-tmute').addEventListener('click', () => {
      track.muted = !track.muted
      const b = row1.querySelector('.aa-tmute')
      b.textContent = track.muted ? '🔇' : '🔈'
      b.title = track.muted ? 'Unmute this track' : 'Mute this track'
      b.classList.toggle('aa-on', track.muted)
      saveSettings()
    })

    row1.querySelector('.aa-loop').addEventListener('click', () => {
      track.loop = !track.loop
      const b = row1.querySelector('.aa-loop')
      b.classList.toggle('aa-on', track.loop)
      b.title = track.loop ? 'Looping. Click to play once instead.' : 'Plays once. Click to loop instead.'
      const e = audio.get(track.id)
      if (e) { e.el.loop = track.loop; e.fired = false }
      saveSettings()
    })

    const nameInput = row1.querySelector('.aa-name')
    nameInput.addEventListener('change', () => {
      track.name = nameInput.value.trim() || 'Untitled track'
      nameInput.value = track.name
      saveSettings()
      const box = floatingBoxes.get(track.id)
      if (box) { const t = box.el.querySelector('.aa-float-name'); if (t) t.textContent = track.name }
    })

    row1.querySelector('.aa-pop').addEventListener('click', () => {
      const b = row1.querySelector('.aa-pop')
      if (floatingBoxes.has(track.id)) {
        closeFloatingBox(track.id)
        b.classList.remove('aa-on')
      } else {
        openFloatingBox(track)
        b.classList.add('aa-on')
      }
    })

    row1.querySelector('.aa-del').addEventListener('click', async () => {
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Remove track',
        message: `Remove "${track.name}"? The audio file will be deleted from storage.`,
        variant: 'danger',
        confirmLabel: 'Remove',
        cancelLabel: 'Keep it',
      })
      if (!confirmed) return
      closeFloatingBox(track.id)
      destroyAudio(track.id)
      await deleteAudioBlob(track.id)
      await deleteArtBlob(track.id)
      settings.tracks = settings.tracks.filter((t) => t.id !== track.id)
      saveSettings()
      refreshTrackList()
    })

    const volSlider = row2.querySelector('.aa-vol')
    const volPct = row2.querySelector('.aa-volpct')
    volSlider.addEventListener('input', () => {
      track.volume = parseFloat(volSlider.value)
      volPct.textContent = `${Math.round(track.volume * 100)}%`
      saveSettings()
    })

    row3.querySelectorAll('.aa-trig').forEach((btn) => {
      btn.addEventListener('click', () => {
        track.triggerType = btn.dataset.mode
        const e = audio.get(track.id)
        if (e) e.fired = false
        row3.querySelectorAll('.aa-trig').forEach((b) => b.classList.toggle('aa-sel', b.dataset.mode === track.triggerType))
        if (track.triggerType === 'global') {
          row4.remove()
        } else {
          if (!card.contains(row4)) card.appendChild(row4)
          renderLinkDetail(row4, track)
        }
        saveSettings()
      })
    })

    return card
  }

  function renderLinkDetail(container, track) {
    container.innerHTML = ''
    if (track.triggerType === 'global') return
    const isBg = track.triggerType === 'background'

    const select = document.createElement('select')
    select.className = 'aa-field'
    const sources = isBg ? detectedBackgrounds.map((b) => b.filename) : Array.from(detectedExpressions)
    const opts = Array.from(new Set(sources)).sort()
    if (track.linkTarget && !opts.includes(track.linkTarget)) opts.unshift(track.linkTarget)

    const firstOpt = document.createElement('option')
    firstOpt.value = ''
    firstOpt.textContent = isBg ? 'Any background' : 'Pick an expression...'
    select.appendChild(firstOpt)
    for (const id of opts) {
      const o = document.createElement('option')
      o.value = id
      const nick = settings.nicknames[id]
      o.textContent = nick ? `${nick}  (${id})` : id
      select.appendChild(o)
    }
    select.value = track.linkTarget || ''
    select.addEventListener('change', () => { track.linkTarget = select.value; saveSettings() })

    const keyword = document.createElement('input')
    keyword.className = 'aa-field'
    keyword.placeholder = isBg ? 'Keywords (optional), e.g. tavern, inn' : 'Keywords (optional), e.g. angry, mad'
    keyword.value = track.linkKeyword
    keyword.addEventListener('input', () => { track.linkKeyword = keyword.value; saveSettings() })

    const orRow = document.createElement('div')
    orRow.className = 'aa-or'
    orRow.textContent = 'or'

    const hint = document.createElement('div')
    hint.className = 'aa-hint'
    hint.textContent = isBg
      ? 'You only need one of these. Pick a background, or type one or more keywords (comma separated). Either alone works.'
      : 'You only need one of these. Pick an expression, or type keywords (comma separated). Typing also works for custom expressions not in the list.'

    container.appendChild(select)
    container.appendChild(orRow)
    container.appendChild(keyword)
    container.appendChild(hint)
  }

  // ============================================================
  // Floating pop-out players
  // ============================================================

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec < 10 ? '0' : ''}${sec}`
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex).replace('#', '')
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const r = parseInt(full.slice(0, 2), 16)
    const g = parseInt(full.slice(2, 4), 16)
    const b = parseInt(full.slice(4, 6), 16)
    if ([r, g, b].some(Number.isNaN)) return `rgba(0,0,0,${alpha})`
    return `rgba(${r},${g},${b},${alpha})`
  }

  // Resolve a theme CSS variable to a #rrggbb hex (for color inputs, which
  // can't take a CSS variable). Falls back if the theme value can't be read.
  function themeColorHex(varName, fallback) {
    try {
      const host = panelEl || document.body
      const probe = document.createElement('span')
      probe.style.color = `var(${varName})`
      probe.style.display = 'none'
      host.appendChild(probe)
      const rgb = getComputedStyle(probe).color
      host.removeChild(probe)
      const m = rgb.match(/\d+(?:\.\d+)?/g)
      if (!m || m.length < 3) return fallback
      const hex = '#' + m.slice(0, 3).map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('')
      return /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback
    } catch {
      return fallback
    }
  }

  // Apply the shared player look (accent, surface color, glass/solid, shadow, border, roundness).
  function applyPlayerStyle(box) {
    const accent = settings.playerAccent || 'var(--lumiverse-accent)'
    const bg = settings.playerBg || 'var(--lumiverse-fill, #1a1a1f)'
    const blur = Math.max(0, settings.playerBlur ?? 6)
    const radius = Math.max(0, settings.playerRadius ?? 12)
    const glass = settings.playerGlass !== false
    box.style.setProperty('--aa-accent', accent)
    if (glass) {
      box.style.background = `color-mix(in srgb, ${bg} 68%, transparent)`
      box.style.backdropFilter = blur > 0 ? `blur(${blur}px)` : 'none'
      box.style.webkitBackdropFilter = blur > 0 ? `blur(${blur}px)` : 'none'
    } else {
      box.style.background = bg
      box.style.backdropFilter = 'none'
      box.style.webkitBackdropFilter = 'none'
    }
    box.style.border = settings.playerBorder ? '1px solid var(--lumiverse-border)' : '1px solid transparent'
    box.style.borderRadius = `${radius}px`
    box.style.width = `${Math.max(180, settings.playerWidth ?? 240)}px`
    box.style.setProperty('--aa-gap', `${Math.max(2, settings.playerSpacing ?? 8)}px`)
    const shadowColor = settings.playerShadow ? hexToRgba(settings.playerShadow, 0.55) : 'rgba(0,0,0,0.45)'
    const shadowSize = Math.max(0, settings.playerShadowSize ?? 28)
    if (shadowSize <= 0) {
      box.style.boxShadow = 'none'
    } else {
      box.style.boxShadow = `0 ${Math.round(shadowSize * 0.28)}px ${shadowSize}px ${shadowColor}`
    }
  }

  function refreshOpenPlayerStyles() {
    for (const [, state] of floatingBoxes) applyPlayerStyle(state.el)
  }

  async function openFloatingBox(track) {
    if (floatingBoxes.has(track.id)) return
    const entry = await getOrCreateAudio(track)
    if (!entry) {
      ctx.toast?.warning?.('That track has no audio file.')
      return
    }
    const el = entry.el
    el.loop = track.loop
    const startVol = getGain(entry) > 0.01 ? getGain(entry) : track.volume
    setGain(entry, startVol)

    const box = document.createElement('div')
    box.className = 'aa-float'
    const n = floatingBoxes.size
    const startRight = 16 + (n * 18)
    const startBottom = 16 + (n * 18)
    box.style.right = `${startRight}px`
    box.style.bottom = `${startBottom}px`

    const showArt = settings.showAlbumArt && track.hasArt
    box.innerHTML = `
      <div class="aa-float-head">
        <div class="aa-float-art ${showArt ? '' : 'aa-noart'}">${showArt ? '' : '🎵'}</div>
        <div class="aa-float-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</div>
        <button class="aa-float-x" title="Close player">✕</button>
      </div>
      <div class="aa-float-seekrow">
        <span class="aa-float-cur">0:00</span>
        <input type="range" class="aa-float-seek" min="0" max="1000" value="0">
        <span class="aa-float-dur">0:00</span>
      </div>
      <div class="aa-float-ctrls">
        <button class="aa-float-play" title="Play / pause">${el.paused ? '▶' : '⏸'}</button>
        <span class="aa-float-volicon">🔈</span>
        <input type="range" class="aa-float-vol" min="0" max="1" step="0.01" value="${startVol}">
      </div>
    `
    applyPlayerStyle(box)
    document.body.appendChild(box)

    const playBtn = box.querySelector('.aa-float-play')
    const seek = box.querySelector('.aa-float-seek')
    const curEl = box.querySelector('.aa-float-cur')
    const durEl = box.querySelector('.aa-float-dur')
    const volSlider = box.querySelector('.aa-float-vol')
    const artEl = box.querySelector('.aa-float-art')

    const state = { el: box, artUrl: null, playBtn, seek, curEl, durEl, scrubbing: false }
    floatingBoxes.set(track.id, state)

    if (showArt) {
      getArtBlob(track.id).then((blob) => {
        if (!blob || !floatingBoxes.has(track.id)) return
        const url = URL.createObjectURL(blob)
        state.artUrl = url
        artEl.style.backgroundImage = `url("${url}")`
      })
    }

    playBtn.addEventListener('click', () => {
      if (el.paused) el.play().catch(() => {})
      else el.pause()
      playBtn.textContent = el.paused ? '▶' : '⏸'
    })

    volSlider.addEventListener('input', () => {
      const v = clamp(parseFloat(volSlider.value))
      setGain(entry, v)
      track.volume = v
      saveSettings()
      const card = panelEl?.querySelector(`[data-track-id="${track.id}"]`)
      const cardVol = card?.querySelector('.aa-vol')
      if (cardVol) cardVol.value = v
      const cardPct = card?.querySelector('.aa-volpct')
      if (cardPct) cardPct.textContent = `${Math.round(v * 100)}%`
    })

    seek.addEventListener('pointerdown', () => { state.scrubbing = true })
    const commitSeek = () => {
      if (el.duration && isFinite(el.duration)) {
        el.currentTime = (parseFloat(seek.value) / 1000) * el.duration
      }
      state.scrubbing = false
    }
    seek.addEventListener('pointerup', commitSeek)
    seek.addEventListener('change', commitSeek)

    box.querySelector('.aa-float-x').addEventListener('click', () => {
      closeFloatingBox(track.id)
      const popBtn = panelEl?.querySelector(`[data-track-id="${track.id}"] .aa-pop`)
      if (popBtn) popBtn.classList.remove('aa-on')
    })

    makeDraggable(box, box.querySelector('.aa-float-head'))
  }

  function closeFloatingBox(id) {
    const state = floatingBoxes.get(id)
    if (!state) return
    if (state.artUrl) URL.revokeObjectURL(state.artUrl)
    state.el.remove()
    floatingBoxes.delete(id)
    // Hand control back to the reconcile loop: force it to re-evaluate volume.
    const entry = audio.get(id)
    if (entry) entry.gainTarget = undefined
  }

  function closeAllFloatingBoxes() {
    for (const id of Array.from(floatingBoxes.keys())) closeFloatingBox(id)
  }

  function refreshOpenBoxArt() {
    for (const [id, state] of floatingBoxes) {
      const track = settings.tracks.find((t) => t.id === id)
      if (!track) continue
      const artEl = state.el.querySelector('.aa-float-art')
      if (!artEl) continue
      const showArt = settings.showAlbumArt && track.hasArt
      if (showArt) {
        artEl.classList.remove('aa-noart')
        artEl.textContent = ''
        if (!state.artUrl) {
          getArtBlob(id).then((blob) => {
            if (!blob || !floatingBoxes.has(id)) return
            const url = URL.createObjectURL(blob)
            state.artUrl = url
            artEl.style.backgroundImage = `url("${url}")`
          })
        }
      } else {
        artEl.classList.add('aa-noart')
        artEl.style.backgroundImage = ''
        artEl.textContent = '🎵'
        if (state.artUrl) { URL.revokeObjectURL(state.artUrl); state.artUrl = null }
      }
    }
  }

  function updateFloatingBoxes() {
    if (!floatingBoxes.size) return
    for (const [id, state] of floatingBoxes) {
      const entry = audio.get(id)
      if (!entry) continue
      const el = entry.el
      state.playBtn.textContent = el.paused ? '▶' : '⏸'
      if (!state.scrubbing) {
        const dur = el.duration
        state.durEl.textContent = fmtTime(dur)
        state.curEl.textContent = fmtTime(el.currentTime)
        state.seek.value = (dur && isFinite(dur)) ? String(Math.round((el.currentTime / dur) * 1000)) : '0'
      }
    }
  }

  function makeDraggable(box, handle) {
    let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input')) return
      dragging = true
      const rect = box.getBoundingClientRect()
      box.style.left = `${rect.left}px`
      box.style.top = `${rect.top}px`
      box.style.right = 'auto'
      box.style.bottom = 'auto'
      originLeft = rect.left
      originTop = rect.top
      startX = e.clientX
      startY = e.clientY
      handle.setPointerCapture(e.pointerId)
      box.classList.add('aa-dragging')
    })
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const w = box.offsetWidth
      const h = box.offsetHeight
      let nl = originLeft + (e.clientX - startX)
      let nt = originTop + (e.clientY - startY)
      nl = Math.min(Math.max(0, nl), window.innerWidth - w)
      nt = Math.min(Math.max(0, nt), window.innerHeight - h)
      box.style.left = `${nl}px`
      box.style.top = `${nt}px`
    })
    const end = (e) => {
      if (!dragging) return
      dragging = false
      try { handle.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
      box.classList.remove('aa-dragging')
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  // ============================================================
  // Panel updates
  // ============================================================

  function refreshTrackList() {
    if (!panelEl) return
    const list = panelEl.querySelector('.aa-tracks')
    if (list) renderTrackList(list)
  }

  function refreshPlayStates() {
    if (!panelEl) return
    for (const track of settings.tracks) {
      const card = panelEl.querySelector(`[data-track-id="${track.id}"]`)
      if (!card) continue
      const entry = audio.get(track.id)
      const isPlaying = !!entry && !entry.el.paused && getGain(entry) > 0.01
      card.classList.toggle('aa-playing', isPlaying)
    }
  }

  function updateStatus() {
    if (!panelEl) return
    const bar = panelEl.querySelector('.aa-status')
    if (!bar) return

    let playing = 0
    for (const [, a] of audio) if (a.el && !a.el.paused && getGain(a) > 0.01) playing++

    const bgName = activeBackground ? displayName(activeBackground) : ''
    const exprName = activeExpression ? displayName(activeExpression) : ''
    const key = `${bgName}|${exprName}|${ttsActive}|${playing}`
    if (key === lastStatusKey) { refreshPlayStates(); return }
    lastStatusKey = key

    const bgType = detectedBackgrounds.find((b) => b.filename === activeBackground)?.type
    let html = ''
    html += `<div class="aa-status-line">
      <span class="aa-status-dot ${playing ? 'aa-live' : ''}"></span>
      <span class="aa-status-key">Background</span>
      <span class="aa-status-val" title="${escapeHtml(activeBackground)}">${bgName ? escapeHtml(bgName) : 'none detected'}</span>
      ${bgType ? `<span class="aa-status-tag">${bgType === 'video' ? 'video' : 'image'}</span>` : ''}
    </div>`
    html += `<div class="aa-status-line">
      <span class="aa-status-dot"></span>
      <span class="aa-status-key">Expression</span>
      <span class="aa-status-val" title="${escapeHtml(activeExpression)}">${exprName ? escapeHtml(exprName) : 'none'}</span>
    </div>`
    html += `<div class="aa-status-line">
      <span class="aa-status-dot ${playing ? 'aa-live' : ''}"></span>
      <span class="aa-status-key">Playing</span>
      <span class="aa-status-val">${playing} track${playing === 1 ? '' : 's'}${ttsActive ? '  ·  speech detected' : ''}</span>
    </div>`
    bar.innerHTML = html
    refreshPlayStates()
  }

  // ============================================================
  // Sources modal
  // ============================================================

  function showSourcesModal() {
    detectedBackgrounds = collectAllBgs()
    const modal = ctx.ui.showModal({ title: 'Backgrounds & expressions', width: Math.min(400, window.innerWidth - 24), maxHeight: Math.min(520, window.innerHeight - 80) })
    const root = modal.root
    root.style.paddingTop = '6px'
    modal.onDismiss(() => refreshTrackList())

    const intro = document.createElement('div')
    intro.className = 'aa-modal-note'
    intro.style.marginBottom = '14px'
    intro.textContent = 'Give backgrounds and expressions friendly names. The names show up in the dropdowns when you link audio to them.'
    root.appendChild(intro)

    const bgSection = document.createElement('div')
    bgSection.className = 'aa-modal-section'
    const bgTitle = document.createElement('div')
    bgTitle.className = 'aa-modal-title'
    bgTitle.textContent = 'Backgrounds'
    bgSection.appendChild(bgTitle)
    if (!detectedBackgrounds.length) {
      const empty = document.createElement('div')
      empty.className = 'aa-src-empty'
      empty.textContent = 'No backgrounds detected yet. Open a chat that has one set, then reopen this window.'
      bgSection.appendChild(empty)
    } else {
      const list = document.createElement('div')
      list.className = 'aa-src-list'
      for (const bg of detectedBackgrounds) list.appendChild(buildSourceRow(bg.filename, bg.type === 'video' ? '🎬' : '🖼'))
      bgSection.appendChild(list)
    }
    root.appendChild(bgSection)

    const exprSection = document.createElement('div')
    exprSection.className = 'aa-modal-section'
    const exprTitle = document.createElement('div')
    exprTitle.className = 'aa-modal-title'
    exprTitle.textContent = 'Expressions'
    exprSection.appendChild(exprTitle)
    const exprNote = document.createElement('div')
    exprNote.className = 'aa-modal-note'
    exprNote.textContent = 'Common expressions are listed to start. Any expression your character actually uses gets added as it happens.'
    exprSection.appendChild(exprNote)
    const exprList = document.createElement('div')
    exprList.className = 'aa-src-list'
    for (const label of Array.from(detectedExpressions).sort()) exprList.appendChild(buildSourceRow(label, '😶'))
    exprSection.appendChild(exprList)
    root.appendChild(exprSection)
  }

  function buildSourceRow(rawId, icon) {
    const row = document.createElement('div')
    row.className = 'aa-src-item'
    const ic = document.createElement('span')
    ic.className = 'aa-src-icon'
    ic.textContent = icon
    const raw = document.createElement('span')
    raw.className = 'aa-src-raw'
    raw.textContent = rawId
    raw.title = rawId
    const nick = document.createElement('input')
    nick.className = 'aa-src-nick'
    nick.placeholder = 'Nickname'
    nick.value = settings.nicknames[rawId] || ''
    nick.addEventListener('change', () => {
      const v = nick.value.trim()
      if (v) settings.nicknames[rawId] = v
      else delete settings.nicknames[rawId]
      saveSettings()
      lastStatusKey = ''
    })
    row.appendChild(ic)
    row.appendChild(raw)
    row.appendChild(nick)
    return row
  }

  // ============================================================
  // Settings modal
  // ============================================================

  function showSettingsModal() {
    const modal = ctx.ui.showModal({ title: 'Audio Settings', width: Math.min(360, window.innerWidth - 24), maxHeight: Math.min(520, window.innerHeight - 80) })
    const root = modal.root
    root.style.paddingTop = '6px'

    const toggle = (label, sub, checked, onChange) => {
      const row = document.createElement('div')
      row.className = 'aa-setting-row'
      const text = document.createElement('div')
      text.style.flex = '1'
      const l = document.createElement('div')
      l.className = 'aa-setting-label'
      l.textContent = label
      text.appendChild(l)
      if (sub) {
        const s = document.createElement('div')
        s.className = 'aa-setting-sub'
        s.textContent = sub
        text.appendChild(s)
      }
      const tog = document.createElement('label')
      tog.className = 'aa-toggle'
      const inp = document.createElement('input')
      inp.type = 'checkbox'
      inp.checked = checked
      const tr = document.createElement('div')
      tr.className = 'aa-toggle-track'
      const th = document.createElement('div')
      th.className = 'aa-toggle-thumb'
      tog.appendChild(inp); tog.appendChild(tr); tog.appendChild(th)
      const stateLabel = document.createElement('span')
      const setState = () => {
        stateLabel.textContent = inp.checked ? 'On' : 'Off'
        stateLabel.className = `aa-toggle-state${inp.checked ? ' aa-on' : ''}`
      }
      setState()
      inp.addEventListener('change', () => { setState(); onChange(inp.checked) })
      const wrap = document.createElement('div')
      wrap.className = 'aa-toggle-wrap'
      wrap.appendChild(stateLabel)
      wrap.appendChild(tog)
      row.appendChild(text); row.appendChild(wrap)
      return row
    }

    const sliderRow = (label, min, max, stepv, val, unit, onChange) => {
      const row = document.createElement('div')
      row.className = 'aa-setting-row'
      const l = document.createElement('span')
      l.className = 'aa-setting-label'
      l.style.cssText = 'min-width:96px;flex:0 0 auto'
      l.textContent = label
      const sl = document.createElement('input')
      sl.type = 'range'; sl.min = min; sl.max = max; sl.step = stepv; sl.value = val
      sl.className = 'aa-slider'; sl.style.flex = '1'
      const disp = document.createElement('span')
      disp.className = 'aa-pct'; disp.style.width = '42px'
      const fmt = (v) => `${Math.round(v * (unit === '%' ? 100 : 1))}${unit}`
      disp.textContent = fmt(val)
      sl.addEventListener('input', () => { const v = parseFloat(sl.value); disp.textContent = fmt(v); onChange(v) })
      row.appendChild(l); row.appendChild(sl); row.appendChild(disp)
      return row
    }

    const playback = document.createElement('div')
    playback.className = 'aa-modal-section'
    const pTitle = document.createElement('div')
    pTitle.className = 'aa-modal-title'
    pTitle.textContent = 'Playback'
    playback.appendChild(pTitle)
    playback.appendChild(toggle('Auto-play on startup', 'Start matching audio as soon as the app loads. With this off, audio waits until the scene changes or you press play.', settings.autoplayOnStartup, (v) => { settings.autoplayOnStartup = v; saveSettings() }))
    playback.appendChild(toggle('Show album art in pop-out players', 'Show artwork embedded in the audio file on the floating players. Tracks with no embedded art show a music note.', settings.showAlbumArt, (v) => {
      settings.showAlbumArt = v
      saveSettings()
      refreshOpenBoxArt()
    }))
    root.appendChild(playback)

    const tts = document.createElement('div')
    tts.className = 'aa-modal-section'
    const tTitle = document.createElement('div')
    tTitle.className = 'aa-modal-title'
    tTitle.textContent = 'TTS auto-lower'
    tts.appendChild(tTitle)
    tts.appendChild(toggle('Lower music while speech plays', 'Drops the volume so speech is easy to hear, then brings it back.', settings.ttsAutoLower, (v) => { settings.ttsAutoLower = v; saveSettings() }))
    tts.appendChild(sliderRow('Lower to', 0, 1, 0.05, settings.ttsLowerTo, '%', (v) => { settings.ttsLowerTo = v; saveSettings() }))
    root.appendChild(tts)

    // Pop-out player look
    const look = document.createElement('div')
    look.className = 'aa-modal-section'
    const lTitle = document.createElement('div')
    lTitle.className = 'aa-modal-title'
    lTitle.textContent = 'Pop-out player look'
    look.appendChild(lTitle)
    const lNote = document.createElement('div')
    lNote.className = 'aa-modal-note'
    lNote.textContent = 'Styling applies to all pop-out players.'
    look.appendChild(lNote)

    // Reusable color row with a reset button (clears to theme/default).
    const colorRow = (label, value, fallback, resetLabel, resetTitle, onPick, onReset) => {
      const row = document.createElement('div')
      row.className = 'aa-setting-row'
      const l = document.createElement('span')
      l.className = 'aa-setting-label'
      l.textContent = label
      const input = document.createElement('input')
      input.type = 'color'
      input.className = 'aa-color'
      input.value = value || fallback
      input.addEventListener('input', () => { onPick(input.value); saveSettings(); refreshOpenPlayerStyles() })
      const reset = document.createElement('button')
      reset.className = 'aa-mini-btn'
      reset.textContent = resetLabel
      reset.title = resetTitle
      reset.addEventListener('click', () => { onReset(); input.value = fallback; saveSettings(); refreshOpenPlayerStyles() })
      row.appendChild(l); row.appendChild(reset); row.appendChild(input)
      return row
    }

    look.appendChild(colorRow('Box color', settings.playerBg, themeColorHex('--lumiverse-fill', '#1a1a1f'), 'Theme', 'Use the theme surface color', (c) => { settings.playerBg = c }, () => { settings.playerBg = '' }))
    look.appendChild(colorRow('Accent color', settings.playerAccent, themeColorHex('--lumiverse-accent', '#a78bfa'), 'Theme', 'Use the theme accent color', (c) => { settings.playerAccent = c }, () => { settings.playerAccent = '' }))
    look.appendChild(colorRow('Shadow color', settings.playerShadow, '#000000', 'Default', 'Use the default dark shadow', (c) => { settings.playerShadow = c }, () => { settings.playerShadow = '' }))
    look.appendChild(sliderRow('Shadow size', 0, 60, 2, settings.playerShadowSize, 'px', (v) => { settings.playerShadowSize = v; saveSettings(); refreshOpenPlayerStyles() }))
    look.appendChild(toggle('Glass effect', 'Frosted, see-through background. Turn off for a solid box.', settings.playerGlass, (v) => { settings.playerGlass = v; saveSettings(); refreshOpenPlayerStyles() }))
    look.appendChild(sliderRow('Blur', 0, 20, 1, settings.playerBlur, 'px', (v) => { settings.playerBlur = v; saveSettings(); refreshOpenPlayerStyles() }))
    look.appendChild(sliderRow('Width', 180, 400, 10, settings.playerWidth, 'px', (v) => { settings.playerWidth = v; saveSettings(); refreshOpenPlayerStyles() }))
    look.appendChild(sliderRow('Spacing', 2, 20, 1, settings.playerSpacing, 'px', (v) => { settings.playerSpacing = v; saveSettings(); refreshOpenPlayerStyles() }))
    look.appendChild(sliderRow('Roundness', 0, 24, 1, settings.playerRadius, 'px', (v) => { settings.playerRadius = v; saveSettings(); refreshOpenPlayerStyles() }))
    look.appendChild(toggle('Border', 'Show a thin border around each player.', settings.playerBorder, (v) => { settings.playerBorder = v; saveSettings(); refreshOpenPlayerStyles() }))
    root.appendChild(look)

    const backup = document.createElement('div')
    backup.className = 'aa-modal-section'
    const bTitle = document.createElement('div')
    bTitle.className = 'aa-modal-title'
    bTitle.textContent = 'Backup'
    backup.appendChild(bTitle)
    const bNote = document.createElement('div')
    bNote.className = 'aa-modal-note'
    bNote.textContent = 'Save your whole setup (tracks, audio, links, and settings) to a file, or restore it. Useful since everything lives in this browser.'
    backup.appendChild(bNote)
    const btnRow = document.createElement('div')
    btnRow.className = 'aa-btn-row'
    const exportBtn = document.createElement('button')
    exportBtn.className = 'aa-btn'
    exportBtn.textContent = 'Export'
    exportBtn.addEventListener('click', () => exportConfig(exportBtn))
    const importBtn = document.createElement('button')
    importBtn.className = 'aa-btn'
    importBtn.textContent = 'Import'
    importBtn.addEventListener('click', () => importConfig(modal))
    btnRow.appendChild(exportBtn)
    btnRow.appendChild(importBtn)
    backup.appendChild(btnRow)
    root.appendChild(backup)

    const resetBtn = document.createElement('button')
    resetBtn.className = 'aa-btn aa-danger'
    resetBtn.textContent = 'Reset settings to default'
    resetBtn.title = 'Restores every setting here. Tracks and nicknames are kept.'
    resetBtn.addEventListener('click', async () => {
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Reset settings',
        message: 'Restore all settings here to their defaults? Your tracks and nicknames are kept.',
        confirmLabel: 'Reset', cancelLabel: 'Cancel',
      })
      if (!confirmed) return
      const keepTracks = settings.tracks
      const keepNicknames = settings.nicknames
      settings = { ...DEFAULT_SETTINGS, tracks: keepTracks, nicknames: keepNicknames }
      saveSettings()
      refreshOpenPlayerStyles()
      refreshOpenBoxArt()
      modal.dismiss()
      buildPanel()
    })
    root.appendChild(resetBtn)
  }

  // ============================================================
  // Export / Import backup
  // ============================================================

  async function exportConfig(btn) {
    const label = btn.textContent
    btn.textContent = 'Exporting...'
    btn.disabled = true
    try {
      const audioData = {}
      for (const track of settings.tracks) {
        const blob = await getAudioBlob(track.id)
        if (blob) audioData[track.id] = await blobToDataUrl(blob)
      }
      const payload = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), settings, audioData }
      const json = JSON.stringify(payload)
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `ambient-audio-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      ctx.toast?.success?.('Backup exported.')
    } catch (e) {
      console.warn('[AmbientAudio] export failed:', e)
      ctx.toast?.warning?.('Export failed.')
    } finally {
      btn.textContent = label
      btn.disabled = false
    }
  }

  async function importConfig(modal) {
    let files
    try {
      files = await ctx.uploads.pickFile({ accept: ['.json', 'application/json'], multiple: false })
    } catch {
      return
    }
    if (!files.length) return

    let payload
    try {
      const text = new TextDecoder().decode(files[0].bytes)
      payload = JSON.parse(text)
    } catch {
      ctx.toast?.warning?.('That file could not be read.')
      return
    }
    if (!payload || payload.format !== BACKUP_FORMAT || !payload.settings) {
      ctx.toast?.warning?.('That is not an Ambient Audio backup.')
      return
    }

    const { confirmed } = await ctx.ui.showConfirm({
      title: 'Import backup',
      message: 'This replaces your current tracks and settings with the backup. Continue?',
      variant: 'danger', confirmLabel: 'Import', cancelLabel: 'Cancel',
    })
    if (!confirmed) return

    try {
      closeAllFloatingBoxes()
      for (const id of Array.from(audio.keys())) destroyAudio(id)

      const audioData = payload.audioData || {}
      for (const [id, dataUrl] of Object.entries(audioData)) {
        try {
          const blob = await dataUrlToBlob(dataUrl)
          await saveAudioBlob(id, blob)
        } catch { /* ignore */ }
      }

      const incoming = payload.settings
      incoming.tracks = (incoming.tracks || []).map(migrateTrack)
      settings = { ...DEFAULT_SETTINGS, ...incoming }
      settings.nicknames = settings.nicknames || {}
      saveSettings()

      await Promise.all(settings.tracks.map((t) => getOrCreateAudio(t)))
      modal?.dismiss?.()
      buildPanel()
      ctx.toast?.success?.('Backup imported.')
    } catch (e) {
      console.warn('[AmbientAudio] import failed:', e)
      ctx.toast?.warning?.('Import failed.')
    }
  }

  // ============================================================
  // Add track
  // ============================================================

  async function handleAddTrack() {
    let files
    try {
      files = await ctx.uploads.pickFile({
        accept: ['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus', '.weba', 'audio/*'],
        multiple: true,
      })
    } catch {
      return
    }
    if (!files.length) return
    for (const file of files) {
      const id = crypto.randomUUID()
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes)
      const blob = new Blob([bytes], { type: file.mimeType || 'audio/mpeg' })
      await saveAudioBlob(id, blob)
      let hasArt = false
      try {
        const art = parseEmbeddedArt(bytes)
        if (art) {
          await saveArtBlob(id, new Blob([art.data], { type: art.mime }))
          hasArt = true
        }
      } catch { /* ignore */ }
      const track = migrateTrack({ id, name: file.name, hasArt })
      settings.tracks.push(track)
      await getOrCreateAudio(track)
    }
    saveSettings()
    refreshTrackList()
  }

  // ============================================================
  // Init
  // ============================================================

  // Tracks added before album-art support have no stored art. Their audio
  // blobs are still here, so read art out of them once, in the background.
  async function backfillArt() {
    let changed = false
    for (const track of settings.tracks) {
      if (track.hasArt) continue
      try {
        const blob = await getAudioBlob(track.id)
        if (!blob) continue
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const art = parseEmbeddedArt(bytes)
        if (art) {
          await saveArtBlob(track.id, new Blob([art.data], { type: art.mime }))
          track.hasArt = true
          changed = true
        }
      } catch { /* ignore */ }
    }
    if (changed) saveSettings()
  }

  async function init() {
    bindCtxResume()
    try {
      db = await openDB()
    } catch (e) {
      console.warn('[AmbientAudio] IndexedDB unavailable:', e)
    }

    const saved = await loadSettingsFromDB()
    if (saved) {
      saved.tracks = (saved.tracks || []).map(migrateTrack)
      settings = { ...DEFAULT_SETTINGS, ...saved }
      settings.nicknames = settings.nicknames || {}
    }

    buildPanel()
    await Promise.all(settings.tracks.map((t) => getOrCreateAudio(t)))

    backfillArt()

    detectedBackgrounds = collectAllBgs()
    activeBackground = detectActiveBg() || ''

    suppressAutoplay = !settings.autoplayOnStartup

    startLoop()

    eventUnsubs.push(ctx.events.on('EXPRESSION_CHANGED', (p) => handleExpressionChange(p?.label)))

    tab.onActivate(() => {
      detectedBackgrounds = collectAllBgs()
      refreshTrackList()
    })
  }

  init()

  // ============================================================
  // Cleanup
  // ============================================================

  return () => {
    eventUnsubs.forEach((u) => { try { u() } catch { /* ignore */ } })
    if (reconcileTimer) clearInterval(reconcileTimer)
    closeAllFloatingBoxes()
    removeStyles()
    for (const [, a] of audio) { a.el.pause(); a.el.src = '' }
    for (const [, url] of objectUrls) URL.revokeObjectURL(url)
    if (db) db.close()
    tab.destroy()
  }
}