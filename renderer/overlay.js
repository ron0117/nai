const shell = document.getElementById('shell')
const shellBg = document.getElementById('shellBg')
const ring = document.getElementById('ring')
const count = document.getElementById('count')
const label = document.getElementById('label')
const nameEl = document.getElementById('name')
const nextEl = document.getElementById('next')
const meEta = document.getElementById('meEta')
const bar = document.getElementById('bar')
const lockText = document.getElementById('lockText')
const opacityEl = document.getElementById('overlayOpacity')
const grip = document.getElementById('grip')

let audioCtx = null
let lastTurnKey = ''
let snapshot = null
let resizing = false
let lastPoint = null

function beep() {
  try {
    audioCtx = audioCtx || new AudioContext()
    const now = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.setValueAtTime(1320, now + 0.12)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.3)
  } catch {}
}

function formatEta(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return '—'
  const value = Math.max(0, Number(sec))
  if (value >= 60) {
    const min = Math.floor(value / 60)
    const rest = value - min * 60
    return `${min}分${rest.toFixed(1)}s`
  }
  return `${value.toFixed(1)}s`
}

function meEtaText(state) {
  if (state.spectator) return '观众席 · 不轮转'
  const eta = state.runtime?.untilMeSec
  if (!state.running) {
    if ((state.myIndex || 0) === 0) return '你是第一位，开轴即点'
    return `开轴后约 ${formatEta(eta)} 轮到你点技能`
  }
  if (state.isMyTurn) return `现在点技能 · 还剩 ${formatEta(state.runtime.remainingSec)}`
  if (eta === 0) return state.paused ? '暂停中，轮到你点技能' : '现在点技能'
  if (state.paused) return `暂停中，还有 ${formatEta(eta)} 轮到你`
  return `还有 ${formatEta(eta)} 轮到你点技能`
}

function isMyPrompt(state) {
  return (
    !state.spectator &&
    Number.isInteger(state.myIndex) &&
    state.myIndex >= 0 &&
    state.running &&
    state.runtime.showing &&
    state.runtime.currentIndex === state.myIndex
  )
}

function mySkillBarRatio(state) {
  if (state.spectator || !state.running) return 0
  if (isMyPrompt(state)) {
    return state.runtime.remaining / Math.max(state.runtime.duration, 1)
  }
  const untilMe = state.runtime.untilMe
  if (untilMe == null) return 0
  const maxWait = Math.max(state.runtime.interval * Math.max(1, state.config.teamSize), 1)
  return Math.max(0, Math.min(1, untilMe / maxWait))
}

function mySkillUrgency(state) {
  if (state.spectator || !state.running) return 0
  if (isMyPrompt(state) || state.isMyTurn) return 1
  const untilMe = state.runtime.untilMe
  const maxWait = Math.max(state.runtime.interval * Math.max(1, state.config.teamSize), 1)
  if (untilMe == null) return 0
  return 1 - Math.max(0, Math.min(1, untilMe / maxWait))
}

function mixRgb(from, to, t) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

function lerpBarColor(urgency) {
  const t = Math.max(0, Math.min(1, urgency))
  const cyan = [94, 224, 255]
  const orange = [255, 154, 48]
  const red = [255, 107, 136]
  const rgb = t <= 0.5 ? mixRgb(cyan, orange, t * 2) : mixRgb(orange, red, (t - 0.5) * 2)
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

function firstChar(name) {
  const text = String(name || '').trim()
  if (!text || text === '—') return '--'
  return [...text][0]
}

function polar(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
}

function drawRing(state) {
  const size = state.config.teamSize
  const current = state.runtime.currentIndex
  const ticks = []
  for (let i = 0; i < size; i += 1) {
    const a = (Math.PI * 2 * i) / size - Math.PI / 2
    const [x1, y1] = polar(50, 50, i === current ? 40 : 36, a)
    const [x2, y2] = polar(50, 50, 44, a)
    const mine = i === state.myIndex
    const color = i === current ? (state.isMyTurn ? '#ff6b88' : '#5ee0ff') : mine ? '#e0c56a' : '#9aa7b8'
    ticks.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${i === current ? 4 : 2}" stroke-linecap="round" />`,
    )
  }
  const progress = state.runtime.showing
    ? state.runtime.remaining / Math.max(state.runtime.duration, 1)
    : 0
  const dash = 2 * Math.PI * 31
  ticks.push(
    `<circle cx="50" cy="50" r="31" fill="none" stroke="#3a4452" stroke-width="6" />`,
    `<circle cx="50" cy="50" r="31" fill="none" stroke="${state.isMyTurn ? '#ff6b88' : '#5ee0ff'}" stroke-width="6" stroke-dasharray="${dash}" stroke-dashoffset="${dash * (1 - progress)}" transform="rotate(-90 50 50)" />`,
  )
  ring.innerHTML = ticks.join('')
}

function render(state) {
  snapshot = state
  const opacity = state.config.opacity
  shellBg.style.opacity = String(opacity)
  shell.style.background = 'transparent'
  shell.classList.toggle('mine', state.isMyTurn)
  lockText.textContent = state.overlayLocked ? '已锁定' : '可拖动'
  lockText.title = state.overlayLocked ? 'Ctrl+Shift+L 解锁' : '可拖动调整'
  if (document.activeElement !== opacityEl) opacityEl.value = String(opacity)

  if (state.spectator) {
    label.textContent = '观众席 · 仅观看'
    nameEl.textContent = state.running ? state.currentName : '—'
    nextEl.textContent = `轴内 ${state.config.teamSize} 人 · 不计入轮转`
    count.textContent = firstChar(state.running ? state.currentName : '')
  } else if (!state.running) {
    label.textContent = '等待开轴'
    nameEl.textContent = '—'
    nextEl.textContent = `间隔 ${(state.runtime.intervalSec || 0).toFixed(2)}s · ${state.config.teamSize}人`
    count.textContent = '--'
  } else {
    label.textContent = state.isMyTurn
      ? '轮到你了，去点技能'
      : state.runtime.showing
        ? '当前应释放'
        : '下一位准备'
    nameEl.textContent = state.runtime.showing ? state.currentName : state.nextName
    nextEl.textContent = state.runtime.showing
      ? `下一位 ${state.nextName} · ${state.runtime.remainingSec.toFixed(1)}s`
      : `${state.runtime.untilNextSec.toFixed(1)}s 后轮到 ${state.nextName}`
    count.textContent = firstChar(state.runtime.showing ? state.currentName : state.nextName)
  }

  const ratio = mySkillBarRatio(state)
  const urgency = mySkillUrgency(state)
  bar.style.width = `${ratio * 100}%`
  bar.style.background = lerpBarColor(urgency)
  bar.style.boxShadow = urgency > 0.55 ? `0 0 ${4 + urgency * 10}px ${lerpBarColor(urgency)}` : 'none'

  meEta.textContent = meEtaText(state)

  drawRing(state)

  const turnKey = `${state.startedAt}-${state.runtime.cycle}-${state.runtime.currentIndex}`
  if (state.isMyTurn && turnKey !== lastTurnKey) {
    lastTurnKey = turnKey
    beep()
  }
  if (!state.isMyTurn) lastTurnKey = ''
}

document.getElementById('scaleDown').addEventListener('click', () => {
  const scale = Math.max(0.7, Number((snapshot?.overlayScale || 1) - 0.1).toFixed(2))
  window.nai.dispatch('setOverlay', { scale })
})
document.getElementById('scaleUp').addEventListener('click', () => {
  const scale = Math.min(1.8, Number((snapshot?.overlayScale || 1) + 0.1).toFixed(2))
  window.nai.dispatch('setOverlay', { scale })
})
opacityEl.addEventListener('input', () => {
  window.nai.dispatch('setOverlay', { opacity: Number(opacityEl.value) })
})
document.getElementById('btnLock').addEventListener('click', () => {
  window.nai.dispatch('toggleLock', true)
})
document.getElementById('btnRoom').addEventListener('click', () => {
  window.nai.dispatch('showControl')
})

grip.addEventListener('mousedown', (event) => {
  resizing = true
  lastPoint = { x: event.screenX, y: event.screenY }
  event.preventDefault()
})
window.addEventListener('mousemove', (event) => {
  if (!resizing || !lastPoint) return
  window.nai.resizeBy(event.screenX - lastPoint.x, event.screenY - lastPoint.y)
  lastPoint = { x: event.screenX, y: event.screenY }
})
window.addEventListener('mouseup', () => {
  resizing = false
  lastPoint = null
})

document.addEventListener('mousedown', () => {
  audioCtx = audioCtx || new AudioContext()
  audioCtx.resume?.()
})

window.nai.onState(render)
window.nai.getState().then(render)
