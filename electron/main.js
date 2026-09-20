const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  shell,
  Tray,
  Menu,
  nativeImage,
} = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { WebSocketServer, WebSocket } = require('ws')
const { remapSlot, moveArrayItem } = require('../server/room')
const { HOST_KEY } = require('../server/auth')

const DEFAULT_MEMBERS = (size) =>
  Array.from({ length: size }, (_, i) => `${i + 1}号`)

const DEFAULT_SETTINGS = {
  cd: 120,
  duration: 4,
  teamSize: 24,
  opacity: 0.78,
  myIndex: 0,
  members: DEFAULT_MEMBERS(24),
  port: 9527,
  lastJoinUrl: 'wss://8.130.118.63:9527',
  alwaysOnTop: true,
  myName: '',
  overlayScale: 1,
  overlayBounds: null,
  enteredHostKey: '',
  joinRoomCode: '',
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings() {
  const data = {
    cd: state.config.cd,
    duration: state.config.duration,
    teamSize: state.config.teamSize,
    opacity: state.config.opacity,
    myIndex: state.myIndex,
    members: state.members,
    port: state.port,
    lastJoinUrl: state.lastJoinUrl,
    alwaysOnTop: state.alwaysOnTop,
    myName: state.myName,
    overlayScale: state.overlayScale,
    overlayBounds: state.overlayBounds,
    enteredHostKey: state.enteredHostKey,
    joinRoomCode: state.joinRoomCode,
  }
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('保存设置失败', err)
  }
}

function lanAddresses() {
  const nets = os.networkInterfaces()
  const result = []
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address)
    }
  }
  return result
}

function normalizeMembers(members, teamSize) {
  const next = Array.isArray(members) ? [...members] : []
  while (next.length < teamSize) next.push(`${next.length + 1}号`)
  return next.slice(0, Math.max(teamSize, next.length))
}

function createState(settings) {
  const teamSize = clamp(Number(settings.teamSize) || 24, 1, 40)
  return {
    config: {
      cd: clamp(Number(settings.cd) || 120, 1, 3600),
      duration: clamp(Number(settings.duration) || 4, 0.2, 120),
      teamSize,
      opacity: clamp(Number(settings.opacity) ?? 0.78, 0.2, 1),
    },
    members: normalizeMembers(settings.members, teamSize),
    myIndex: clamp(Number(settings.myIndex) || 0, 0, teamSize - 1),
    port: clamp(Number(settings.port) || 9527, 1024, 65535),
    lastJoinUrl: settings.lastJoinUrl || 'wss://8.130.118.63:9527',
    alwaysOnTop: settings.alwaysOnTop !== false,
    myName: String(settings.myName || '').trim().slice(0, 12),
    overlayScale: clamp(Number(settings.overlayScale) || 1, 0.7, 1.8),
    overlayBounds: settings.overlayBounds || null,
    enteredHostKey: String(settings.enteredHostKey || ''),
    joinRoomCode: String(settings.joinRoomCode || '').replace(/\D/g, '').slice(0, 6),
    roomCode: '',
    mode: 'local',
    running: false,
    paused: false,
    startedAt: null,
    elapsedMs: 0,
    overlayLocked: false,
    overlayVisible: true,
    hostUrl: '',
    lanIPs: lanAddresses(),
    connected: false,
    clients: [],
    error: '',
    remoteRuntime: null,
    clockOffset: 0,
    spectator: false,
    spectators: [],
    players: [],
    ghosts: [],
  }
}

let state
let controlWin = null
let overlayWin = null
let tray = null
let isQuitting = false
let wss = null
let wsClient = null
let ticker = null
let persistTimer = null

function intervalMs() {
  return (state.config.cd / state.config.teamSize) * 1000
}

function untilMyTurnMs(runtime) {
  if (state.spectator || !Number.isInteger(state.myIndex) || state.myIndex < 0) return null
  const size = Math.max(1, state.config.teamSize)
  const myIndex = clamp(state.myIndex, 0, size - 1)
  const interval = runtime.interval
  if (!state.running || interval <= 0) return myIndex * interval
  const slotsAhead = (myIndex - runtime.currentIndex + size) % size
  if (slotsAhead === 0) {
    if (runtime.showing) return 0
    return runtime.untilNext + (size - 1) * interval
  }
  return runtime.untilNext + (slotsAhead - 1) * interval
}

function computeRuntime(now = Date.now()) {
  const interval = intervalMs()
  const duration = state.config.duration * 1000
  const elapsed = state.running
    ? state.paused
      ? state.elapsedMs
      : Math.max(0, now - (state.clockOffset || 0) - (state.startedAt || now))
    : 0

  if (!state.running || interval <= 0) {
    return {
      elapsed,
      interval,
      duration,
      currentIndex: 0,
      showing: false,
      remaining: 0,
      untilNext: interval,
      cycle: 0,
    }
  }

  const cycle = Math.floor(elapsed / interval)
  const currentIndex = cycle % state.config.teamSize
  const intoSlot = elapsed % interval
  const showing = intoSlot < duration
  return {
    elapsed,
    interval,
    duration,
    currentIndex,
    showing,
    remaining: showing ? duration - intoSlot : 0,
    untilNext: interval - intoSlot,
    cycle,
  }
}

function randomRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function snapshot() {
  const runtime = computeRuntime()
  const displayedMembers = state.members.slice(0, state.config.teamSize)
  const untilMe = untilMyTurnMs(runtime)
  const data = {
    ...state,
    members: displayedMembers,
    canHost: state.enteredHostKey === HOST_KEY,
    runtime: {
      ...runtime,
      intervalSec: runtime.interval / 1000,
      remainingSec: runtime.remaining / 1000,
      untilNextSec: runtime.untilNext / 1000,
      elapsedSec: runtime.elapsed / 1000,
      untilMe,
      untilMeSec: untilMe == null ? null : untilMe / 1000,
    },
    isMyTurn:
      !state.spectator &&
      state.running &&
      !state.paused &&
      runtime.showing &&
      runtime.currentIndex === state.myIndex,
    currentName: displayedMembers[runtime.currentIndex] || `${runtime.currentIndex + 1}号`,
    nextName:
      displayedMembers[(runtime.currentIndex + 1) % state.config.teamSize] ||
      `${((runtime.currentIndex + 1) % state.config.teamSize) + 1}号`,
  }
  return data
}

function broadcast() {
  const data = snapshot()
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('state', data)
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('state', data)
  }

  if (state.mode === 'host' && wss) {
    const payload = JSON.stringify({ type: 'state', payload: publicState(data) })
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }
}

function publicState(data) {
  return {
    config: data.config,
    members: data.members,
    players: data.players || [],
    spectators: data.spectators || [],
    running: data.running,
    paused: data.paused,
    startedAt: data.startedAt,
    elapsedMs: data.elapsedMs,
    runtime: data.runtime,
    currentName: data.currentName,
    nextName: data.nextName,
    clients: data.clients,
    hostUrl: data.hostUrl,
    room: data.roomCode,
    serverNow: Date.now(),
  }
}

function schedulePersist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(saveSettings, 250)
}

function applyConfig(partial) {
  const next = { ...state.config }
  if (partial.cd != null) next.cd = clamp(Number(partial.cd), 1, 3600)
  if (partial.duration != null) next.duration = clamp(Number(partial.duration), 0.2, 120)
  if (partial.opacity != null) next.opacity = clamp(Number(partial.opacity), 0.2, 1)
  if (partial.teamSize != null) next.teamSize = clamp(Number(partial.teamSize), 1, 40)

  const changed =
    next.cd !== state.config.cd ||
    next.duration !== state.config.duration ||
    next.opacity !== state.config.opacity ||
    next.teamSize !== state.config.teamSize

  state.config = next
  if (partial.teamSize != null) {
    state.members = normalizeMembers(state.members, next.teamSize)
    state.myIndex = clamp(state.myIndex, 0, next.teamSize - 1)
  }
  if (changed) schedulePersist()
}

function startAxis() {
  const now = Date.now()
  if (state.paused && state.startedAt) {
    state.startedAt = now - state.elapsedMs
    state.paused = false
  } else {
    state.startedAt = now
    state.elapsedMs = 0
    state.paused = false
  }
  state.running = true
}

function pauseAxis() {
  if (!state.running || state.paused) return
  state.elapsedMs = Date.now() - state.startedAt
  state.paused = true
}

function stopAxis() {
  state.running = false
  state.paused = false
  state.startedAt = null
  state.elapsedMs = 0
}

function localPeople() {
  const people = []
  if (state.mode === 'host' && wss) {
    people.push({
      id: 'local-host',
      name: state.myName || '主持',
      slot: Number.isInteger(state.myIndex) ? state.myIndex : 0,
      spectator: !!state.spectator,
      role: 'host',
    })
  }
  if (wss) {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      people.push({
        id: client.meta?.id || '',
        name: client.meta?.name || '未命名',
        slot: Number.isInteger(client.meta?.slot) ? client.meta.slot : 999,
        spectator: !!client.meta?.spectator,
        role: 'client',
        socket: client,
      })
    }
  }
  for (const ghost of state.ghosts || []) {
    people.push({
      id: ghost.id,
      name: ghost.name || '未进房',
      slot: Number.isInteger(ghost.slot) ? ghost.slot : 999,
      spectator: false,
      role: 'ghost',
      ghost: true,
    })
  }
  return people
}

function publicClient(person) {
  return {
    id: person.id,
    name: person.name || '未命名',
    slot: person.slot ?? null,
    spectator: !!person.spectator,
    role: person.role || 'client',
    ghost: !!person.ghost || person.role === 'ghost',
  }
}

function rebuildLocalAxis() {
  if (state.mode !== 'host' || !wss) return
  const people = localPeople()
  const players = people
    .filter((person) => !person.spectator)
    .sort((a, b) => {
      const as = Number.isInteger(a.slot) ? a.slot : 999
      const bs = Number.isInteger(b.slot) ? b.slot : 999
      if (as !== bs) return as - bs
      return String(a.id).localeCompare(String(b.id))
    })
  const spectators = people.filter((person) => person.spectator)
  const size = Math.max(1, players.length)
  state.config.teamSize = size
  if (!players.length) {
    state.members = ['空位']
  } else {
    state.members = players.map((person, index) => {
      person.slot = index
      if (person.id === 'local-host') state.myIndex = index
      if (person.socket) person.socket.meta.slot = index
      if (person.ghost) {
        const ghost = (state.ghosts || []).find((item) => item.id === person.id)
        if (ghost) ghost.slot = index
      }
      return person.name || `${index + 1}号`
    })
  }
  for (const person of spectators) {
    person.slot = null
    if (person.id === 'local-host') state.myIndex = -1
    if (person.socket) person.socket.meta.slot = null
  }
  state.players = players.map(publicClient)
  state.spectators = spectators.map(publicClient)
  state.clients = [...state.players, ...state.spectators]
  for (const person of people) {
    if (person.socket?.readyState === WebSocket.OPEN) {
      person.socket.send(
        JSON.stringify({
          type: 'assigned',
          slot: person.socket.meta.slot,
          spectator: !!person.spectator,
        }),
      )
    }
  }
}

function updateClients() {
  if (state.mode === 'host' && wss) {
    rebuildLocalAxis()
    return
  }
  if (!wss && !wsClient) {
    state.clients = []
    state.players = []
    state.spectators = []
  }
}

function closeServer() {
  if (wss) {
    for (const client of wss.clients) {
      try {
        client.close()
      } catch {}
    }
    wss.close()
    wss = null
  }
  state.hostUrl = ''
}

function closeClient() {
  if (wsClient) {
    try {
      wsClient.removeAllListeners()
      wsClient.close()
    } catch {}
    wsClient = null
  }
}

function cleanName(name, fallback = '队员') {
  return String(name || '').trim().slice(0, 12) || fallback
}

function applyClientIdentity(socket, name) {
  const nextName = cleanName(name)
  socket.meta = {
    id: socket.meta?.id,
    name: nextName,
    slot: Number.isInteger(socket.meta?.slot) ? socket.meta.slot : null,
    spectator: !!socket.meta?.spectator,
  }
  if (!socket.meta.spectator && !Number.isInteger(socket.meta.slot)) {
    const ghost = (state.ghosts || []).find((item) => item.name === nextName)
    if (ghost) {
      socket.meta.slot = ghost.slot
      state.ghosts = state.ghosts.filter((item) => item.id !== ghost.id)
    }
  }
  rebuildLocalAxis()
  schedulePersist()
}

function handleHostClientMessage(socket, message) {
  let msg
  try {
    msg = JSON.parse(message.toString())
  } catch {
    return
  }
  if (msg.type === 'hello') {
    if (String(msg.roomCode || '') !== String(state.roomCode || '')) {
      socket.send(JSON.stringify({ type: 'error', message: '房间不存在' }))
      socket.close()
      return
    }
    applyClientIdentity(socket, msg.name)
    broadcast()
  }
  if (msg.type === 'claimSlot') {
    if (socket.meta?.spectator) return
    applyClientIdentity(socket, msg.name || socket.meta?.name)
    broadcast()
  }
}

function applyRemoteState(payload) {
  if (!payload) return
  if (payload.config) {
    const { cd, duration, teamSize } = payload.config
    if (
      cd !== state.config.cd ||
      duration !== state.config.duration ||
      teamSize !== state.config.teamSize
    ) {
      applyConfig({ cd, duration, teamSize })
    }
  }
  if (Array.isArray(payload.members)) {
    state.members = normalizeMembers(payload.members, state.config.teamSize)
  }
  state.running = !!payload.running
  state.paused = !!payload.paused
  state.startedAt = payload.startedAt ?? null
  state.elapsedMs = payload.elapsedMs || 0
  state.clockOffset = Number.isFinite(payload.serverNow)
    ? Date.now() - payload.serverNow
    : 0
  state.clients = payload.clients || []
  state.players = payload.players || []
  state.spectators = payload.spectators || []
  state.hostUrl = payload.hostUrl || state.hostUrl
  if (payload.room) state.roomCode = String(payload.room)
  state.remoteRuntime = null
  if (!state.spectator && Number.isInteger(state.myIndex) && state.myIndex >= 0) {
    state.myIndex = clamp(state.myIndex, 0, Math.max(0, state.config.teamSize - 1))
  }
}

function describeWsError(err) {
  const code = err?.code || ''
  const message = String(err?.message || '')
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return '连不上服务器 9527 端口。请确认 nai-wss 已启动，且阿里云安全组已放行 TCP 9527'
  }
  if (code === 'ECONNREFUSED') {
    return '服务器拒绝连接。请在服务器执行 systemctl status nai-wss 确认服务在跑'
  }
  if (code === 'ENOTFOUND') {
    return '找不到服务器地址，请检查加入地址是否写对'
  }
  if (/certificate|SSL|TLS|self[- ]signed/i.test(message)) {
    return `证书校验失败：${message}`
  }
  return message || '未知网络错误'
}

function sendToServer(message) {
  if (wsClient?.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify(message))
    return true
  }
  return false
}

function handleServerMessage(msg) {
  if (msg.type === 'kicked') {
    leaveNetwork(msg.message || '你已被主持踢出')
    broadcast()
    return
  }
  if (msg.type === 'roomCode') {
    state.roomCode = String(msg.code || '')
    broadcast()
    return
  }
  if (msg.type === 'error') {
    state.error = String(msg.message || '服务器错误')
    broadcast()
    return
  }
  if (msg.type === 'role') {
    state.mode = msg.role === 'host' ? 'host' : 'client'
    broadcast()
    return
  }
  if (msg.type === 'assigned') {
    state.spectator = !!msg.spectator
    state.myIndex =
      msg.slot == null || msg.slot === ''
        ? -1
        : clamp(Number(msg.slot), 0, Math.max(0, state.config.teamSize - 1))
    schedulePersist()
    broadcast()
    return
  }
  if (msg.type === 'state') {
    applyRemoteState(msg.payload)
    broadcast()
  }
}

function connectRemote(url, role) {
  closeServer()
  closeClient()
  state.error = ''
  const target = String(url || '').trim()
  if (!target) {
    state.error = '请输入 WebSocket 地址'
    broadcast()
    return
  }
  state.lastJoinUrl = target
  schedulePersist()
  wsClient = new WebSocket(target, {
    rejectUnauthorized: false,
    handshakeTimeout: 8000,
  })
  wsClient.on('open', () => {
    state.connected = true
    state.hostUrl = target
    if (role === 'host') {
      state.mode = 'host'
      state.spectator = false
      applyConfig({ teamSize: 1 })
      state.members = [state.myName || '主持']
      state.myIndex = 0
      wsClient.send(
        JSON.stringify({
          type: 'host',
          hostKey: state.enteredHostKey,
          name: state.myName || '主持',
          slot: state.myIndex,
          config: {
            cd: state.config.cd,
            duration: state.config.duration,
            teamSize: state.config.teamSize,
          },
          members: state.members,
        }),
      )
    } else {
      state.mode = 'client'
      wsClient.send(
        JSON.stringify({
          type: 'hello',
          roomCode: state.joinRoomCode,
          name: state.myName || '队员',
          slot: state.myIndex,
        }),
      )
    }
    broadcast()
  })
  wsClient.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    handleServerMessage(msg)
  })
  wsClient.on('close', () => {
    if (state.mode === 'local' && !state.connected) return
    leaveNetwork(state.error || '连接已断开')
    broadcast()
  })
  wsClient.on('error', (err) => {
    state.error = `${role === 'host' ? '主持' : '加入'}失败：${describeWsError(err)}`
    leaveNetwork(state.error)
    broadcast()
  })
}

function joinHost(payload) {
  if (payload && typeof payload === 'object') {
    state.joinRoomCode = String(payload.roomCode || '').replace(/\D/g, '').slice(0, 6)
    schedulePersist()
    connectRemote(payload.url, 'client')
    return
  }
  connectRemote(payload, 'client')
}

function startHost(url) {
  if (state.enteredHostKey !== HOST_KEY) {
    state.error = '房间不存在'
    broadcast()
    return
  }
  const target = String(url || state.lastJoinUrl || '').trim()
  if (/^wss?:\/\//i.test(target)) {
    connectRemote(target, 'host')
    return
  }
  closeClient()
  closeServer()
  state.error = ''
  state.roomCode = randomRoomCode()
  wss = new WebSocketServer({ host: '0.0.0.0', port: state.port })
  wss.on('connection', (socket) => {
    socket.meta = {
      id: Math.random().toString(36).slice(2, 8),
      name: '队员',
      slot: null,
      spectator: false,
    }
    socket.on('message', (message) => handleHostClientMessage(socket, message))
    socket.on('close', () => {
      rebuildLocalAxis()
      broadcast()
    })
  })
  wss.on('listening', () => {
    state.mode = 'host'
    state.connected = true
    state.spectator = false
    state.lanIPs = lanAddresses()
    state.hostUrl = `ws://${state.lanIPs[0] || '127.0.0.1'}:${state.port}`
    rebuildLocalAxis()
    broadcast()
  })
  wss.on('error', (err) => {
    state.error = `主持失败：${err.message}`
    state.mode = 'local'
    state.connected = false
    closeServer()
    broadcast()
  })
}

function leaveNetwork(message) {
  closeClient()
  closeServer()
  stopAxis()
  state.mode = 'local'
  state.connected = false
  state.clients = []
  state.players = []
  state.spectators = []
  state.ghosts = []
  state.spectator = false
  if (!Number.isInteger(state.myIndex) || state.myIndex < 0) state.myIndex = 0
  state.hostUrl = ''
  state.error = message || ''
  state.remoteRuntime = null
  state.clockOffset = 0
  state.roomCode = ''
}

function isHostLike() {
  return state.mode === 'host'
}

function moveLocalMember(from, to) {
  if (wsClient?.readyState === WebSocket.OPEN) return
  if (state.mode === 'host' && wss) {
    const players = (state.players || []).slice()
    const src = clamp(Number(from), 0, Math.max(0, players.length - 1))
    const dst = clamp(Number(to), 0, Math.max(0, players.length - 1))
    if (src === dst || !players.length) return
    const ordered = moveArrayItem(players, src, dst)
    ordered.forEach((person, index) => {
      if (person.id === 'local-host') state.myIndex = index
      if (wss) {
        for (const client of wss.clients) {
          if (client.meta?.id === person.id) client.meta.slot = index
        }
      }
    })
    rebuildLocalAxis()
    return
  }
  const max = state.config.teamSize
  const src = clamp(Number(from), 0, max - 1)
  const dst = clamp(Number(to), 0, max - 1)
  if (src === dst) return
  state.members = normalizeMembers(moveArrayItem(state.members, src, dst), max)
  state.myIndex = remapSlot(state.myIndex, src, dst)
  schedulePersist()
}

function localAxisCount() {
  return localPeople().filter((person) => !person.spectator).length
}

function setLocalSpectator(id, spectator) {
  if (wsClient?.readyState === WebSocket.OPEN) return
  const becoming = !!spectator
  if (becoming && localAxisCount() <= 1) {
    const current = localPeople().find((person) => person.id === id)
    if (current && !current.spectator) {
      state.error = '轴内至少保留一人'
      return false
    }
  }
  if (id === 'local-host') {
    state.spectator = becoming
  } else if (wss) {
    for (const client of wss.clients) {
      if (client.meta?.id === id) client.meta.spectator = becoming
    }
  }
  state.error = ''
  rebuildLocalAxis()
  return true
}

function kickLocalId(id) {
  if (wsClient?.readyState === WebSocket.OPEN) return
  if (!id || id === 'local-host') return
  if ((state.ghosts || []).some((item) => item.id === id)) {
    state.ghosts = state.ghosts.filter((item) => item.id !== id)
    rebuildLocalAxis()
    return
  }
  if (wss) {
    for (const client of [...wss.clients]) {
      if (client.meta?.id === id) {
        try {
          client.send(JSON.stringify({ type: 'kicked', message: '你已被主持踢出' }))
          client.close()
        } catch {}
      }
    }
  }
  rebuildLocalAxis()
}

function addLocalGhost(name) {
  if (wsClient?.readyState === WebSocket.OPEN) return
  if ((state.players || []).length >= 40) {
    state.error = '轴内最多 40 人'
    return
  }
  if (!state.ghosts) state.ghosts = []
  state.ghosts.push({
    id: `ghost-${Math.random().toString(36).slice(2, 10)}`,
    name: cleanName(name, `${(state.players || []).length + 1}号`),
    slot: 999,
  })
  state.error = ''
  rebuildLocalAxis()
}

function kickLocalSlot(slot) {
  const player = (state.players || []).find((person) => person.slot === Number(slot))
  if (player) kickLocalId(player.id)
}

async function dispatch({ action, payload }) {
  switch (action) {
    case 'updateConfig': {
      if (!isHostLike()) break
      const next = { ...(payload || {}) }
      if (state.mode === 'host' || state.connected) delete next.teamSize
      applyConfig(next)
      sendToServer({ type: 'updateConfig', ...next })
      break
    }
    case 'setMembers':
      if (!isHostLike()) break
      state.members = normalizeMembers(payload, state.config.teamSize)
      schedulePersist()
      sendToServer({ type: 'setMembers', members: state.members })
      break
    case 'renameMember': {
      if (!isHostLike()) break
      const { index, name } = payload || {}
      if (!Number.isInteger(index)) break
      const nextName = String(name || '').trim().slice(0, 12) || `${index + 1}号`
      if (state.mode === 'host' && wss) {
        const player = (state.players || [])[index]
        if (player) {
          if (player.id === 'local-host') state.myName = nextName
          else if (player.ghost) {
            const ghost = (state.ghosts || []).find((item) => item.id === player.id)
            if (ghost) ghost.name = nextName
          } else {
            for (const client of wss.clients) {
              if (client.meta?.id === player.id) client.meta.name = nextName
            }
          }
          rebuildLocalAxis()
        }
      } else if (state.members[index] != null) {
        state.members[index] = nextName
        schedulePersist()
      }
      sendToServer({ type: 'renameMember', index, name: nextName })
      break
    }
    case 'moveMember': {
      if (!isHostLike()) break
      moveLocalMember(payload?.from, payload?.to)
      sendToServer({ type: 'moveMember', from: payload?.from, to: payload?.to })
      break
    }
    case 'kick': {
      if (!isHostLike()) break
      if (payload && typeof payload === 'object' && payload.id) {
        kickLocalId(payload.id)
        sendToServer({ type: 'kick', id: payload.id })
      } else {
        kickLocalSlot(payload)
        sendToServer({ type: 'kick', slot: payload })
      }
      break
    }
    case 'setSpectator': {
      if (!isHostLike()) break
      setLocalSpectator(payload?.id, payload?.spectator)
      sendToServer({ type: 'setSpectator', id: payload?.id, spectator: !!payload?.spectator })
      break
    }
    case 'addGhost': {
      if (!isHostLike()) break
      addLocalGhost(payload)
      sendToServer({ type: 'addGhost', name: payload })
      break
    }
    case 'setMyName': {
      state.myName = String(payload || '').trim().slice(0, 12)
      schedulePersist()
      if (wsClient?.readyState === WebSocket.OPEN) {
        sendToServer({
          type: 'hello',
          roomCode: state.roomCode || state.joinRoomCode,
          name: state.myName || (state.mode === 'host' ? '主持' : '队员'),
        })
      } else if (state.mode === 'host' && wss) {
        rebuildLocalAxis()
      } else if (state.myName && state.myIndex >= 0) {
        state.members[state.myIndex] = state.myName
      }
      break
    }
    case 'setMyIndex': {
      if (state.spectator || state.mode === 'host' || state.mode === 'client') break
      state.myIndex = clamp(Number(payload), 0, state.config.teamSize - 1)
      schedulePersist()
      break
    }
    case 'start':
      if (!isHostLike()) break
      startAxis()
      sendToServer({ type: 'start' })
      break
    case 'pause':
      if (!isHostLike()) break
      pauseAxis()
      sendToServer({ type: 'pause' })
      break
    case 'stop':
      if (!isHostLike()) break
      stopAxis()
      sendToServer({ type: 'stop' })
      break
    case 'setHostKey':
      state.enteredHostKey = String(payload || '')
      schedulePersist()
      break
    case 'setJoinRoomCode':
      state.joinRoomCode = String(payload || '').replace(/\D/g, '').slice(0, 6)
      schedulePersist()
      break
    case 'host':
      startHost(payload)
      break
    case 'join':
      joinHost(payload)
      break
    case 'leave':
      leaveNetwork()
      break
    case 'setOverlay': {
      const { opacity, scale } = payload || {}
      if (opacity != null) applyConfig({ opacity })
      if (scale != null) {
        state.overlayScale = clamp(Number(scale), 0.7, 1.8)
        applyOverlayZoom()
        schedulePersist()
      }
      break
    }
    case 'resetOverlay': {
      state.overlayScale = 1
      state.overlayBounds = null
      placeOverlayWindow()
      applyOverlayZoom()
      schedulePersist()
      break
    }
    case 'setAlwaysOnTop':
      state.alwaysOnTop = !!payload
      overlayWin?.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver')
      schedulePersist()
      break
    case 'toggleLock':
      state.overlayLocked = payload == null ? !state.overlayLocked : !!payload
      overlayWin?.setIgnoreMouseEvents(state.overlayLocked, { forward: true })
      break
    case 'toggleOverlay':
      state.overlayVisible = payload == null ? !state.overlayVisible : !!payload
      if (overlayWin) {
        if (state.overlayVisible) overlayWin.show()
        else overlayWin.hide()
      }
      break
    case 'showControl':
      showControlWindow()
      break
    case 'setPort':
      if (state.mode === 'host') break
      state.port = clamp(Number(payload) || 9527, 1024, 65535)
      schedulePersist()
      break
    default:
      break
  }
  broadcast()
  return snapshot()
}

function showControlWindow() {
  if (!controlWin || controlWin.isDestroyed()) createControlWindow()
  if (controlWin.isMinimized()) controlWin.restore()
  controlWin.show()
  controlWin.focus()
}

function createTray() {
  if (tray) return
  const iconPath = path.join(__dirname, 'tray.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromPath(process.execPath) : icon)
  tray.setToolTip('Nai轴提示器')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开房间面板', click: () => showControlWindow() },
      { label: '显示/隐藏悬浮层', click: () => dispatch({ action: 'toggleOverlay' }) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => showControlWindow())
  tray.on('double-click', () => showControlWindow())
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 820,
    minHeight: 640,
    backgroundColor: '#10141c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  controlWin.loadFile(path.join(__dirname, '../renderer/control.html'))
  controlWin.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    controlWin.hide()
  })
  controlWin.on('closed', () => {
    controlWin = null
  })
}

function overlayBoundsOnScreen(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.width)) return false
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + Math.min(bounds.width, 80) > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + Math.min(bounds.height, 40) > area.y
    )
  })
}

function defaultOverlayBounds() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  return { x: Math.round(width / 2 - 230), y: 48, width: 480, height: 248 }
}

function placeOverlayWindow() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const bounds = overlayBoundsOnScreen(state.overlayBounds)
    ? state.overlayBounds
    : defaultOverlayBounds()
  overlayWin.setBounds(bounds)
}

function persistOverlayBounds() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  state.overlayBounds = overlayWin.getBounds()
  schedulePersist()
}

function applyOverlayZoom() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const next = clamp(state.overlayScale || 1, 0.7, 1.8)
  const prev = overlayWin.webContents.getZoomFactor() || 1
  if (Math.abs(next - prev) > 0.001) {
    const bounds = overlayWin.getBounds()
    overlayWin.setBounds({
      ...bounds,
      width: clamp(Math.round(bounds.width * (next / prev)), 280, 1200),
      height: clamp(Math.round(bounds.height * (next / prev)), 140, 800),
    })
  }
  overlayWin.webContents.setZoomFactor(next)
}

function createOverlayWindow() {
  const bounds = overlayBoundsOnScreen(state.overlayBounds)
    ? state.overlayBounds
    : defaultOverlayBounds()
  overlayWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: state.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  overlayWin.setMinimumSize(280, 140)
  overlayWin.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.loadFile(path.join(__dirname, '../renderer/overlay.html'))
  overlayWin.once('ready-to-show', () => overlayWin.show())
  overlayWin.webContents.on('did-finish-load', () => applyOverlayZoom())
  overlayWin.on('moved', persistOverlayBounds)
  overlayWin.on('resized', persistOverlayBounds)
  overlayWin.on('closed', () => {
    overlayWin = null
  })
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    dispatch({ action: 'toggleLock' })
  })
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    dispatch({ action: 'toggleOverlay' })
  })
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (!isHostLike()) return
    if (state.running && !state.paused) dispatch({ action: 'pause' })
    else dispatch({ action: 'start' })
  })
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    showControlWindow()
  })
}

app.commandLine.appendSwitch('enable-transparent-visuals')
app.commandLine.appendSwitch('ignore-certificate-errors')
app.setAppUserModelId('com.nai.axis')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showControlWindow()
  })

  app.whenReady().then(() => {
    state = createState(loadSettings())
    createControlWindow()
    createOverlayWindow()
    createTray()
    registerShortcuts()
    ticker = setInterval(() => {
      if (state.running && !state.paused) broadcast()
    }, 50)
    app.on('activate', () => {
      if (!controlWin) createControlWindow()
      if (!overlayWin) createOverlayWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  saveSettings()
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  clearInterval(ticker)
  closeClient()
  closeServer()
  if (tray) {
    tray.destroy()
    tray = null
  }
  saveSettings()
})

ipcMain.handle('state:get', () => snapshot())
ipcMain.handle('state:dispatch', (_event, data) => dispatch(data || {}))
ipcMain.handle('overlay:ignore-mouse', (_event, ignore) => {
  overlayWin?.setIgnoreMouseEvents(!!ignore, { forward: true })
  return true
})
ipcMain.handle('overlay:resize-by', (_event, delta) => {
  if (!overlayWin || overlayWin.isDestroyed()) return false
  const bounds = overlayWin.getBounds()
  overlayWin.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: clamp(bounds.width + Number(delta?.dw || 0), 280, 1200),
    height: clamp(bounds.height + Number(delta?.dh || 0), 140, 800),
  })
  persistOverlayBounds()
  return true
})
ipcMain.handle('overlay:focus', () => {
  overlayWin?.show()
  overlayWin?.focus()
  return true
})

ipcMain.on('open-external', (_event, url) => {
  shell.openExternal(url)
})
