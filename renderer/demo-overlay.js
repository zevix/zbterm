// The demo overlay: what a recorded walk-through needs on screen and the app
// itself does not draw. It is off until a debug-server command turns it on
// (`POST /renderer/command` with a `demo-*` command, see
// docs/debug_server_howto.md), draws above everything, and never takes a
// click or a key: every element is `pointer-events: none` and its listeners
// only watch.
//
//   - a caption card (title + text) at the bottom or top of the window
//   - key badges: the chord just pressed (Ctrl+Shift+F), shown by itself for
//     every chord, function key and modified click or wheel turn
//   - a pointer that follows the mouse events the page gets, with a ripple on
//     each press: input sent through the debug server (`POST /input/mouse`)
//     does not move the desktop's own pointer
//   - a title card over the whole window, and a ring around one element
;(function () {
  const STYLE = `
    #zbdemo-root { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
      font-family: 'Noto Sans', 'Segoe UI', system-ui, sans-serif; }
    #zbdemo-root * { pointer-events: none; box-sizing: border-box; }
    #zbdemo-stack { position: absolute; left: 0; right: 0; bottom: 70px; display: flex;
      flex-direction: column; align-items: center; gap: 10px; padding: 0 24px;
      transition: bottom 0.25s ease, top 0.25s ease; }
    #zbdemo-root[data-position='top'] #zbdemo-stack { bottom: auto; top: 76px;
      flex-direction: column-reverse; }
    .zbdemo-caption { max-width: min(760px, 92%); padding: 12px 18px 13px;
      border-radius: 12px; background: rgba(13, 17, 23, 0.94); color: #f2f6fa;
      border: 1px solid rgba(106, 176, 255, 0.55); border-left: 5px solid #2b8cff;
      box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55); opacity: 0; transform: translateY(10px);
      transition: opacity 0.22s ease, transform 0.22s ease; }
    .zbdemo-caption.zbdemo-on { opacity: 1; transform: none; }
    .zbdemo-caption-title { font-size: 12.5px; font-weight: 700; letter-spacing: 0.09em;
      text-transform: uppercase; color: #6ab0ff; margin-bottom: 3px; }
    .zbdemo-caption-title:empty { display: none; }
    .zbdemo-caption-text { font-size: 17px; line-height: 1.38; font-weight: 500; }
    .zbdemo-caption-text kbd, .zbdemo-card kbd { font: inherit; font-size: 0.86em;
      font-weight: 700; padding: 1px 7px 2px; border-radius: 6px; background: #2a3442;
      border: 1px solid #50627a; border-bottom-width: 2px; color: #fff; white-space: nowrap; }
    .zbdemo-keys { display: flex; gap: 8px; align-items: center; min-height: 0; opacity: 0;
      transform: scale(0.92); transition: opacity 0.15s ease, transform 0.15s ease; }
    .zbdemo-keys.zbdemo-on { opacity: 1; transform: none; }
    .zbdemo-key { font-size: 19px; font-weight: 700; padding: 6px 14px 8px; border-radius: 9px;
      color: #10151b; background: linear-gradient(#ffffff, #d5dde6);
      border: 1px solid #8996a6; border-bottom-width: 4px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5); white-space: nowrap; }
    .zbdemo-plus { font-size: 18px; font-weight: 700; color: #f2f6fa;
      text-shadow: 0 1px 4px #000; }
    #zbdemo-pointer { position: absolute; left: 0; top: 0; width: 26px; height: 26px;
      margin: -2px 0 0 -3px; opacity: 0; transition: opacity 0.2s ease;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.6)); will-change: transform; }
    #zbdemo-pointer.zbdemo-on { opacity: 1; }
    .zbdemo-ripple { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px;
      border-radius: 50%; border: 3px solid #ffcf3f; background: rgba(255, 207, 63, 0.35);
      animation: zbdemo-ripple 0.55s ease-out forwards; }
    @keyframes zbdemo-ripple { to { transform: scale(4.2); opacity: 0; } }
    #zbdemo-ring { position: absolute; border-radius: 10px; border: 3px solid #ffcf3f;
      box-shadow: 0 0 0 4px rgba(255, 207, 63, 0.25), 0 0 22px rgba(255, 207, 63, 0.55);
      opacity: 0; transition: opacity 0.2s ease; animation: zbdemo-pulse 1.1s ease-in-out infinite; }
    #zbdemo-ring.zbdemo-on { opacity: 1; }
    @keyframes zbdemo-pulse { 50% { box-shadow: 0 0 0 7px rgba(255, 207, 63, 0.12),
      0 0 30px rgba(255, 207, 63, 0.75); } }
    .zbdemo-card { position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; text-align: center; padding: 32px;
      background: radial-gradient(ellipse at center, rgba(16, 26, 38, 0.97),
        rgba(8, 11, 15, 0.985)); color: #f2f6fa; opacity: 0; transition: opacity 0.35s ease; }
    .zbdemo-card.zbdemo-on { opacity: 1; }
    .zbdemo-card img { width: min(220px, 34%); margin-bottom: 22px; }
    .zbdemo-card-title { font-size: clamp(26px, 4.6vw, 46px); font-weight: 800;
      letter-spacing: 0.01em; }
    .zbdemo-card-subtitle { margin-top: 10px; font-size: clamp(15px, 2.2vw, 22px);
      color: #a9c7e8; font-weight: 500; max-width: 820px; line-height: 1.4; }
    .zbdemo-card-lines { margin-top: 22px; font-size: clamp(13px, 1.7vw, 17px);
      line-height: 1.75; color: #dbe5ee; }
  `
  const POINTER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.4 16.2 ' +
    'L12 24.2 L15.4 22.7 L11.8 14.9 L19 14.6 Z" fill="#fff" stroke="#111" stroke-width="1.6" ' +
    'stroke-linejoin="round"/></svg>'

  const ui = { root: null, stack: null, caption: null, keys: null, pointer: null, ring: null }
  const timers = { caption: null, keys: null, card: null, ring: null }
  const st = { on: false, pointer: true, autoKeys: true, card: null, ringTarget: null }

  function build() {
    if (ui.root) return
    const style = document.createElement('style')
    style.id = 'zbdemo-style'
    style.textContent = STYLE
    document.head.appendChild(style)
    ui.root = el('div', { id: 'zbdemo-root' })
    ui.root.setAttribute('aria-hidden', 'true')
    ui.root.dataset.position = 'bottom'
    ui.ring = el('div', { id: 'zbdemo-ring' })
    ui.stack = el('div', { id: 'zbdemo-stack' })
    ui.keys = el('div', { className: 'zbdemo-keys' })
    ui.caption = el('div', { className: 'zbdemo-caption' })
    ui.caption.appendChild(el('div', { className: 'zbdemo-caption-title' }))
    ui.caption.appendChild(el('div', { className: 'zbdemo-caption-text' }))
    ui.stack.appendChild(ui.keys)
    ui.stack.appendChild(ui.caption)
    ui.pointer = el('div', { id: 'zbdemo-pointer' })
    ui.pointer.innerHTML = POINTER_SVG
    ui.root.appendChild(ui.ring)
    ui.root.appendChild(ui.stack)
    ui.root.appendChild(ui.pointer)
    document.body.appendChild(ui.root)
  }

  function el(tag, props) {
    return Object.assign(document.createElement(tag), props || {})
  }

  function setOn(on, request) {
    if (on) {
      build()
      if (request.pointer !== undefined) st.pointer = !!request.pointer
      if (request.autoKeys !== undefined) st.autoKeys = !!request.autoKeys
      if (!st.on) {
        st.on = true
        document.addEventListener('mousemove', onMouseMove, true)
        document.addEventListener('mousedown', onMouseDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('wheel', onWheel, { capture: true, passive: true })
        window.addEventListener('resize', placeRing)
      }
      ui.root.hidden = false
    } else if (st.on) {
      st.on = false
      document.removeEventListener('mousemove', onMouseMove, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('resize', placeRing)
      for (const name of Object.keys(timers)) clearTimeout(timers[name])
      if (ui.root) {
        ui.root.remove()
        const style = document.getElementById('zbdemo-style')
        if (style) style.remove()
        for (const name of Object.keys(ui)) ui[name] = null
      }
      st.card = null
      st.ringTarget = null
    }
    return snapshot()
  }

  // `text` may hold <kbd>..</kbd>, <b>..</b> and <br>; anything else is shown
  // as written.
  function rich(text) {
    const escaped = String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    return escaped.replace(/&lt;(\/?)(kbd|b)&gt;/g, '<$1$2>').replace(/&lt;br\s*\/?&gt;/g, '<br>')
  }

  function caption(request) {
    setOn(true, {})
    clearTimeout(timers.caption)
    const text = request.text === undefined ? '' : String(request.text)
    if (request.position === 'top' || request.position === 'bottom') {
      ui.root.dataset.position = request.position
    }
    if (!text && !request.title) {
      ui.caption.classList.remove('zbdemo-on')
      return snapshot()
    }
    ui.caption.firstChild.textContent = request.title || ''
    ui.caption.lastChild.innerHTML = rich(text)
    ui.caption.classList.add('zbdemo-on')
    const ms = Number(request.ms)
    if (Number.isFinite(ms) && ms > 0) {
      timers.caption = setTimeout(() => ui.caption.classList.remove('zbdemo-on'), ms)
    }
    return snapshot()
  }

  function showKeys(label, ms) {
    if (!ui.keys) return
    clearTimeout(timers.keys)
    ui.keys.textContent = ''
    const parts = String(label)
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
    parts.forEach((part, index) => {
      if (index) ui.keys.appendChild(el('span', { className: 'zbdemo-plus', textContent: '+' }))
      ui.keys.appendChild(el('span', { className: 'zbdemo-key', textContent: part }))
    })
    ui.keys.dataset.label = parts.join('+')
    ui.keys.classList.add('zbdemo-on')
    timers.keys = setTimeout(
      () => ui.keys && ui.keys.classList.remove('zbdemo-on'),
      Number.isFinite(ms) && ms > 0 ? ms : 1600
    )
  }

  function keys(request) {
    setOn(true, {})
    if (!request.keys) {
      clearTimeout(timers.keys)
      ui.keys.classList.remove('zbdemo-on')
    } else {
      showKeys(request.keys, Number(request.ms))
    }
    return snapshot()
  }

  function card(request) {
    setOn(true, {})
    clearTimeout(timers.card)
    const hide = () => {
      const node = st.card
      if (!node) return
      st.card = null
      node.classList.remove('zbdemo-on')
      setTimeout(() => node.remove(), 400)
    }
    if (request.hide || (!request.title && !request.subtitle)) {
      hide()
      return snapshot()
    }
    if (st.card) st.card.remove()
    const node = el('div', { className: 'zbdemo-card' })
    if (request.logo !== false) node.appendChild(el('img', { src: 'logo.svg', alt: '' }))
    node.appendChild(el('div', { className: 'zbdemo-card-title', textContent: request.title }))
    if (request.subtitle) {
      const subtitle = el('div', { className: 'zbdemo-card-subtitle' })
      subtitle.innerHTML = rich(request.subtitle)
      node.appendChild(subtitle)
    }
    if (Array.isArray(request.lines) && request.lines.length) {
      const lines = el('div', { className: 'zbdemo-card-lines' })
      lines.innerHTML = request.lines.map(rich).join('<br>')
      node.appendChild(lines)
    }
    ui.root.insertBefore(node, ui.pointer)
    st.card = node
    // Two frames, so the fade-in runs from the hidden state.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => node.classList.add('zbdemo-on'))
    )
    const ms = Number(request.ms)
    if (Number.isFinite(ms) && ms > 0) timers.card = setTimeout(hide, ms)
    return snapshot()
  }

  function findTarget(request) {
    if (!request.selector) return null
    const matches = Array.from(document.querySelectorAll(request.selector)).filter(
      (node) => !ui.root || !ui.root.contains(node)
    )
    if (request.text !== undefined) {
      const needle = String(request.text).trim().toLowerCase()
      const exact = matches.find(
        (node) => node.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === needle
      )
      return (
        exact || matches.find((node) => node.textContent.toLowerCase().includes(needle)) || null
      )
    }
    const index = Number.isFinite(Number(request.index)) ? Number(request.index) : 0
    return matches[index < 0 ? matches.length + index : index] || null
  }

  function rectOf(node) {
    const r = node.getBoundingClientRect()
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2
    }
  }

  // Where an element is, for aiming the mouse: its rect and centre in page
  // pixels. `text` picks among the selector's matches by their text.
  function rect(request) {
    const node = findTarget(request)
    if (!node) return { found: false, selector: request.selector || null }
    const styles = window.getComputedStyle(node)
    return {
      found: true,
      count: document.querySelectorAll(request.selector).length,
      visible: !!node.getClientRects().length && styles.visibility !== 'hidden',
      disabled: !!node.disabled,
      text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
      value: typeof node.value === 'string' ? node.value : null,
      rect: rectOf(node),
      window: { width: window.innerWidth, height: window.innerHeight }
    }
  }

  function placeRing() {
    if (!ui.ring || !st.ringTarget) return
    const node = st.ringTarget.node
    if (!node.isConnected) {
      ui.ring.classList.remove('zbdemo-on')
      return
    }
    const pad = st.ringTarget.pad
    const r = node.getBoundingClientRect()
    ui.ring.style.left = `${r.left - pad}px`
    ui.ring.style.top = `${r.top - pad}px`
    ui.ring.style.width = `${r.width + pad * 2}px`
    ui.ring.style.height = `${r.height + pad * 2}px`
  }

  function spotlight(request) {
    setOn(true, {})
    clearTimeout(timers.ring)
    const node = findTarget(request)
    if (!node) {
      st.ringTarget = null
      ui.ring.classList.remove('zbdemo-on')
      return { found: false, ...snapshot() }
    }
    const pad = Number.isFinite(Number(request.pad)) ? Number(request.pad) : 5
    st.ringTarget = { node, pad }
    placeRing()
    ui.ring.classList.add('zbdemo-on')
    const ms = Number(request.ms)
    timers.ring = setTimeout(
      () => {
        st.ringTarget = null
        if (ui.ring) ui.ring.classList.remove('zbdemo-on')
      },
      Number.isFinite(ms) && ms > 0 ? ms : 2200
    )
    return { found: true, ...snapshot() }
  }

  function onMouseMove(event) {
    if (!st.pointer || !ui.pointer) return
    ui.pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`
    ui.pointer.classList.add('zbdemo-on')
  }

  function modifierParts(event) {
    const parts = []
    if (event.ctrlKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    if (event.metaKey) parts.push('Meta')
    return parts
  }

  function onMouseDown(event) {
    if (!ui.root) return
    onMouseMove(event)
    const ripple = el('div', { className: 'zbdemo-ripple' })
    ripple.style.left = `${event.clientX}px`
    ripple.style.top = `${event.clientY}px`
    ui.root.insertBefore(ripple, ui.pointer)
    setTimeout(() => ripple.remove(), 650)
    if (!st.autoKeys) return
    const parts = modifierParts(event)
    if (event.button === 2) showKeys([...parts, 'Right click'].join('+'))
    else if (parts.length) showKeys([...parts, 'Click'].join('+'))
  }

  let lastWheelAt = 0
  function onWheel(event) {
    if (!st.autoKeys) return
    const now = Date.now()
    if (now - lastWheelAt < 250) return
    lastWheelAt = now
    showKeys([...modifierParts(event), 'Wheel'].join('+'), 1100)
  }

  const KEY_LABELS = {
    ' ': 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Escape: 'Esc'
  }

  // A chord (Ctrl, Alt or Meta held) or a function key is shown by itself;
  // plain typing is not, and Enter, Esc and the arrows are the script's call
  // (`demo-keys`), since they are also what a shell is typed with.
  function onKeyDown(event) {
    if (!st.autoKeys || event.repeat) return
    const key = event.key
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return
    const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
    if (!functionKey && !event.ctrlKey && !event.altKey && !event.metaKey) return
    const digit = /^Digit([0-9])$/.exec(event.code || '')
    const letter = /^Key([A-Z])$/.exec(event.code || '')
    const label =
      KEY_LABELS[key] ||
      (digit ? digit[1] : letter ? letter[1] : key.length === 1 ? key.toUpperCase() : key)
    showKeys([...modifierParts(event), label].join('+'))
  }

  function snapshot() {
    return {
      on: st.on,
      pointer: st.pointer,
      autoKeys: st.autoKeys,
      position: ui.root ? ui.root.dataset.position : null,
      caption:
        ui.caption && ui.caption.classList.contains('zbdemo-on')
          ? { title: ui.caption.firstChild.textContent, text: ui.caption.lastChild.textContent }
          : null,
      keys: ui.keys && ui.keys.classList.contains('zbdemo-on') ? ui.keys.dataset.label || '' : null,
      card: st.card ? st.card.querySelector('.zbdemo-card-title').textContent : null,
      ring: !!(ui.ring && ui.ring.classList.contains('zbdemo-on'))
    }
  }

  window.__zbtermDemoOverlay = (request = {}) => {
    const command = request.command || request.action
    if (command === 'demo-overlay') return setOn(request.on !== false, request)
    if (command === 'demo-caption') return caption(request)
    if (command === 'demo-keys') return keys(request)
    if (command === 'demo-card') return card(request)
    if (command === 'demo-spotlight') return spotlight(request)
    if (command === 'demo-rect') return rect(request)
    if (command === 'demo-state') return snapshot()
    throw new Error(`Unknown debug renderer command: ${command}`)
  }
})()
