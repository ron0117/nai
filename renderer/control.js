const $ = (id) => document.getElementById(id)

let snapshot = null
let seatFocus = null
let lastSeatKey = ''
let menuTarget = null
let dragFrom = null
let pendingOrderKey = null
let seatSyncTimer = null

function playerAtSeat(state, index) {
  return (state.players || state.clients || []).find(
    (client) => !client.spectator && client.slot === index,
  )
}

function axisPeople(state) {
  const source = (state.players || []).filter((person) => !person.spectator)
  if (source.length) {
    return [...source].sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999))
  }
  return (state.members || []).map((name, slot) => ({ id: name, name, slot }))
}

function orderKeyFromState(state) {
  return axisPeople(state).map((person) => person.id || person.name).join('|')
}

function expectedOrderKey(state, from, to) {
  const people = axisPeople(state)
  const src = Math.max(0, Math.min(from, people.length - 1))
  const dst = Math.max(0, Math.min(to, people.length - 1))
  const [item] = people.splice(src, 1)
  if (!item) return orderKeyFromState(state)
  people.splice(dst, 0, item)
  return people.map((person) => person.id || person.name).join('|')
}

function setSeatBusy(busy, text, cover) {
  const loading = $('seatLoading')
  const card = $('seatsCard')
  const label = loading?.querySelector('.seat-loading-text')
  const flag = $('seatBusyFlag')
  if (label && text) label.textContent = text
  flag?.classList.toggle('hidden', !busy)
  loading?.classList.toggle('hidden', !(busy && cover))
  card?.classList.toggle('is-loading', !!busy)
  card?.classList.toggle('is-syncing', !!(busy && cover))
}

function clearSeatSync() {
  pendingOrderKey = null
  clearTimeout(seatSyncTimer)
  setSeatBusy(false)
}

function beginSeatSync(from, to) {
  if (!snapshot || from == null || from === to) return
  const nextKey = expectedOrderKey(snapshot, from, to)
  if (nextKey === orderKeyFromState(snapshot)) return
  pendingOrderKey = nextKey
  setSeatBusy(true, '座位同步中…', true)
  clearTimeout(seatSyncTimer)
  seatSyncTimer = setTimeout(() => {
    pendingOrderKey = null
    setSeatBusy(false)
    lastSeatKey = ''
    if (snapshot) renderSeats(snapshot)
  }, 8000)
  send('moveMember', { from, to })
}

function hideSeatMenu() {
  $('seatMenu').classList.add('hidden')
  menuTarget = null
}

function isHosting(state = snapshot) {
  return state?.mode === 'host'
}

function showSeatMenu(target, x, y) {
  if (!isHosting()) return
  menuTarget = target
  const menu = $('seatMenu')
  const isSeat = target.kind === 'seat'
  const occupant = isSeat ? playerAtSeat(snapshot, target.index) : (snapshot.spectators || []).find((item) => item.id === target.id)
  menu.querySelector('[data-act="forward"]').classList.toggle('hidden', !isSeat)
  menu.querySelector('[data-act="back"]').classList.toggle('hidden', !isSeat)
  menu.querySelector('[data-act="spectate"]').classList.toggle('hidden', !isSeat || occupant?.ghost)
  menu.querySelector('[data-act="unspectate"]').classList.toggle('hidden', isSeat)
  const kickBtn = menu.querySelector('[data-act="kick"]')
  kickBtn.textContent = occupant?.ghost ? '移出轴内' : '踢出'
  kickBtn.disabled = !occupant || occupant.role === 'host'
  menu.classList.remove('hidden')
  menu.style.left = `${Math.min(x, window.innerWidth - 148)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - 160)}px`
}

function setVal(id, value) {
  const el = $(id)
  if (document.activeElement === el) return
  if (String(el.value) === String(value)) return
  el.value = value
}

function num(id) {
  return Number($(id).value)
}

function send(action, payload) {
  return window.nai.dispatch(action, payload)
}

function renderSeats(state) {
  const box = $('seats')
  const host = isHosting(state)
  const active = document.activeElement
  const keepIndex =
    active && active.dataset.seatIndex != null ? Number(active.dataset.seatIndex) : seatFocus

  box.innerHTML = ''
  for (let i = 0; i < state.config.teamSize; i += 1) {
    const seat = document.createElement('div')
    seat.className = 'seat'
    if (host) seat.classList.add('host-edit')
    const occupant = playerAtSeat(state, i)
    if (occupant?.ghost) seat.classList.add('ghost')
    if (i === state.myIndex) seat.classList.add('me')
    if (state.running && state.runtime.currentIndex === i && state.runtime.showing) {
      seat.classList.add('now')
    }
    seat.dataset.index = String(i)

    const input = document.createElement('input')
    input.value = state.members[i] || `${i + 1}号`
    input.dataset.seatIndex = String(i)
    input.disabled = !host
    input.addEventListener('focus', () => {
      seatFocus = i
    })
    input.addEventListener('blur', () => {
      send('renameMember', { index: i, name: input.value })
      seatFocus = null
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur()
    })
    input.addEventListener('mousedown', (event) => event.stopPropagation())

    seat.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const player = playerAtSeat(state, i)
      showSeatMenu({ kind: 'seat', index: i, id: player?.id }, event.clientX, event.clientY)
    })
    if (host) {
      const handle = document.createElement('span')
      handle.className = 'seat-handle'
      handle.title = '拖动排序'
      handle.textContent = '⋮⋮'
      handle.draggable = true
      handle.addEventListener('dragstart', (event) => {
        if (pendingOrderKey) {
          event.preventDefault()
          return
        }
        dragFrom = i
        seat.classList.add('dragging')
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(i))
        event.dataTransfer.setDragImage(seat, 24, 16)
        setSeatBusy(true, '调整座位中…', false)
      })
      handle.addEventListener('dragend', () => {
        dragFrom = null
        seat.classList.remove('dragging')
        box.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'))
        if (!pendingOrderKey) setSeatBusy(false)
      })
      seat.addEventListener('dragover', (event) => {
        if (dragFrom == null || dragFrom === i) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        seat.classList.add('drag-over')
      })
      seat.addEventListener('dragleave', () => seat.classList.remove('drag-over'))
      seat.addEventListener('drop', (event) => {
        event.preventDefault()
        seat.classList.remove('drag-over')
        const from = dragFrom
        dragFrom = null
        if (from == null || from === i) {
          if (!pendingOrderKey) setSeatBusy(false)
          return
        }
        beginSeatSync(from, i)
      })
      seat.appendChild(handle)
    }
    seat.appendChild(input)
    if (occupant?.ghost) {
      const tag = document.createElement('span')
      tag.className = 'seat-tag'
      tag.textContent = '未进房'
      seat.appendChild(tag)
    }
    box.appendChild(seat)
  }

  box.ondragover = host
    ? (event) => {
        event.preventDefault()
      }
    : null

  if (keepIndex != null) {
    const next = box.querySelector(`[data-seat-index="${keepIndex}"]`)
    if (next) {
      next.focus()
      if (typeof next.selectionStart === 'number') {
        const pos = next.value.length
        next.setSelectionRange(pos, pos)
      }
    }
  }
}

function renderSpectators(state) {
  const box = $('spectators')
  if (!box) return
  box.innerHTML = ''
  const list = state.spectators || []
  if (!list.length) {
    box.textContent = '暂无观众'
    return
  }
  for (const person of list) {
    const el = document.createElement('div')
    el.className = 'spectator'
    el.textContent = person.name || '观众'
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showSeatMenu({ kind: 'spectator', id: person.id }, event.clientX, event.clientY)
    })
    box.appendChild(el)
  }
}

function render(state) {
  snapshot = state
  const interval = state.runtime.intervalSec

  setVal('cd', state.config.cd)
  setVal('duration', state.config.duration)
  setVal('teamSize', state.config.teamSize)
  setVal('opacity', state.config.opacity)
  setVal('overlayScale', state.overlayScale || 1)
  setVal('myName', state.myName || '')
  if (document.activeElement !== $('hostKey')) setVal('hostKey', state.enteredHostKey || '')
  if (document.activeElement !== $('joinRoomCode')) {
    setVal('joinRoomCode', state.mode === 'host' ? state.roomCode || '' : state.joinRoomCode || '')
  }

  const hosting = isHosting(state)
  $('cd').disabled = !hosting
  $('duration').disabled = !hosting
  $('teamSize').disabled = true
  $('btnStart').disabled = !hosting
  $('btnPause').disabled = !hosting
  $('btnStop').disabled = !hosting
  $('btnAddSeat').disabled = !hosting
  $('newSeatName').disabled = !hosting
  $('btnHost').classList.toggle('hidden', !state.canHost || state.mode !== 'local')
  $('btnHost').disabled = state.mode !== 'local'
  $('hostKeyWrap').classList.toggle('hidden', state.mode === 'client')
  $('btnJoin').disabled = state.mode !== 'local'

  $('modePill').textContent =
    state.mode === 'host' ? '主持中' : state.mode === 'client' ? '已加入' : '单机'
  $('modePill').className = `pill ${state.connected ? 'ok' : ''}`

  $('runPill').textContent = !state.running ? '未开始' : state.paused ? '已暂停' : '进行中'
  $('runPill').className = `pill ${state.running && !state.paused ? 'hot' : 'ghost'}`

  $('liveKicker').textContent = state.spectator
    ? '观众席 · 仅观看'
    : state.isMyTurn
      ? '轮到你了，去点技能'
      : state.running
        ? state.runtime.showing
          ? '当前应释放'
          : '下一位准备'
        : '等待开轴'
  $('liveName').textContent = state.running ? state.currentName : '—'
  $('liveUntil').textContent = `间隔 ${interval.toFixed(2)}s`
  $('liveRemain').textContent = state.runtime.showing
    ? `剩余 ${state.runtime.remainingSec.toFixed(1)}s`
    : `下一位 ${state.runtime.untilNextSec.toFixed(1)}s`
  const meEta = state.runtime.untilMeSec
  $('liveMeEta').textContent = state.spectator
    ? '观众席不轮转'
    : state.isMyTurn
      ? `现在点技能 · 还剩 ${state.runtime.remainingSec.toFixed(1)}s`
      : !state.running
        ? (state.myIndex || 0) === 0
          ? '你是第一位'
          : `开轴后约 ${(meEta ?? 0).toFixed(1)}s 轮到你`
        : meEta === 0
          ? '现在点技能'
          : `还有 ${(meEta ?? 0).toFixed(1)}s 轮到你`

  $('intervalHint').textContent =
    `轴内 ${state.config.teamSize} 人，每人间隔 = ${state.config.cd} / ${state.config.teamSize} = ${interval.toFixed(2)}s`
  $('durationWarn').classList.toggle('hidden', state.config.duration < interval)

  $('roomCodeBoard').classList.toggle('hidden', !(state.mode === 'host' && state.roomCode))
  $('roomCodeView').textContent = state.roomCode || '------'
  $('hostUrl').textContent = state.mode === 'host'
    ? '主持中，把房间密码发给队员即可加入'
    : state.mode === 'client'
      ? '已加入房间'
      : '未连接'
  $('errorText').textContent = state.error || ''

  $('clients').innerHTML = (state.clients || [])
    .map((c) => `<span class="pill ghost">${c.name}${c.spectator ? ' · 观众' : c.slot != null ? ` · ${c.slot + 1}号` : ''}</span>`)
    .join('')

  $('alwaysOnTop').checked = state.alwaysOnTop
  $('overlayLocked').checked = state.overlayLocked

  if (pendingOrderKey && orderKeyFromState(state) === pendingOrderKey) {
    clearSeatSync()
    lastSeatKey = ''
  }
  const seatKey = [
    state.config.teamSize,
    state.members.join('|'),
    state.myIndex,
    state.mode,
    state.running && state.runtime.showing ? state.runtime.currentIndex : -1,
    JSON.stringify(state.spectators || []),
    state.spectator ? 1 : 0,
  ].join('::')
  if (dragFrom == null && !pendingOrderKey && seatFocus == null && seatKey !== lastSeatKey) {
    lastSeatKey = seatKey
    renderSeats(state)
  }
  renderSpectators(state)
}

function pushConfig() {
  send('updateConfig', {
    cd: num('cd'),
    duration: num('duration'),
  })
}

function pushOverlay() {
  send('setOverlay', {
    opacity: num('opacity'),
    scale: num('overlayScale'),
  })
}

;['cd', 'duration'].forEach((id) => {
  $(id).addEventListener('change', pushConfig)
})
;['opacity', 'overlayScale'].forEach((id) => {
  $(id).addEventListener('input', pushOverlay)
})

function addOfflineSeat() {
  if (!isHosting()) return
  const name = $('newSeatName').value.trim()
  send('addGhost', name)
  $('newSeatName').value = ''
}

$('btnAddSeat').addEventListener('click', addOfflineSeat)
$('newSeatName').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    addOfflineSeat()
  }
})

$('btnStart').addEventListener('click', () => send('start'))
$('btnPause').addEventListener('click', () => send('pause'))
$('btnStop').addEventListener('click', () => send('stop'))
$('btnHost').addEventListener('click', () => {
  send('setMyName', $('myName').value).then(() => send('host'))
})
$('btnJoin').addEventListener('click', () => {
  send('setMyName', $('myName').value).then(() =>
    send('join', { roomCode: $('joinRoomCode').value }),
  )
})
$('hostKey').addEventListener('input', () => send('setHostKey', $('hostKey').value))
$('joinRoomCode').addEventListener('input', () => send('setJoinRoomCode', $('joinRoomCode').value))
$('myName').addEventListener('change', () => send('setMyName', $('myName').value))
$('btnLeave').addEventListener('click', () => send('leave'))
$('alwaysOnTop').addEventListener('change', (e) => send('setAlwaysOnTop', e.target.checked))
$('overlayLocked').addEventListener('change', (e) => send('toggleLock', e.target.checked))
$('btnResetOverlay').addEventListener('click', () => send('resetOverlay'))

$('seatMenu').addEventListener('click', (event) => {
  event.stopPropagation()
  const act = event.target.dataset.act
  if (!act || !menuTarget) return
  const target = menuTarget
  hideSeatMenu()
  if (act === 'forward' && target.kind === 'seat' && target.index > 0) {
    beginSeatSync(target.index, target.index - 1)
  }
  if (act === 'back' && target.kind === 'seat' && snapshot && target.index < snapshot.config.teamSize - 1) {
    beginSeatSync(target.index, target.index + 1)
  }
  if (act === 'spectate' && target.id) send('setSpectator', { id: target.id, spectator: true })
  if (act === 'unspectate' && target.id) send('setSpectator', { id: target.id, spectator: false })
  if (act === 'kick') {
    if (target.id) send('kick', { id: target.id })
    else if (target.kind === 'seat') send('kick', target.index)
  }
})
document.addEventListener('click', hideSeatMenu)
window.addEventListener('blur', hideSeatMenu)

window.nai.onState(render)
window.nai.getState().then(render)
