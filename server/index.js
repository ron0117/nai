/**
 * 无忧辅助工具 WSS 服务
 *
 * 启动：npm run server
 * 环境变量：
 *   WSS_PORT   默认 9527
 *   WSS_HOST   默认 0.0.0.0
 *   WSS_CERT   证书路径，缺省则自动生成自签证书
 *   WSS_KEY    私钥路径
 *
 *   HOST_KEY   主持密钥，默认 zanmei13
 *
 * 客户端协议：
 *   主持 { type: "host", hostKey, name, slot, config, members }
 *   加入 { type: "hello", roomCode, name, slot }
 *   换座 { type: "claimSlot", name, slot }
 *   调序 { type: "moveMember", from, to }
 *   踢人 { type: "kick", id | slot }
 *   观众 { type: "setSpectator", id, spectator }
 *   参数 { type: "updateConfig", cd, duration }  teamSize 由轴内实到人数决定
 *   改名 { type: "renameMember", index, name }
 *   开轴 { type: "start" } / { type: "pause" } / { type: "stop" }
 *
 * 服务端下发：
 *   { type: "state", payload }
 *   { type: "assigned", slot }
 *   { type: "role", role: "host" | "client" }
 *   { type: "error", message }
 *
 *   { type: "roomCode", code }
 *   { type: "error", message }  密钥或房间密码错误时为「房间不存在」
 *
 * 房间凭六位房间密码加入，不再使用 URL 路径分房。
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
const { WebSocketServer } = require('ws')
const selfsigned = require('selfsigned')
const { AxisRoom } = require('./room')
const { HOST_KEY } = require('./auth')

const HOST = process.env.WSS_HOST || '0.0.0.0'
const PORT = Number(process.env.WSS_PORT || 9527)
const CERT_DIR = path.join(__dirname, '../certs')
const CERT_PATH = process.env.WSS_CERT || path.join(CERT_DIR, 'cert.pem')
const KEY_PATH = process.env.WSS_KEY || path.join(CERT_DIR, 'key.pem')

function ensureCerts() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
    }
  }
  fs.mkdirSync(path.dirname(CERT_PATH), { recursive: true })
  const pems = selfsigned.generate([{ name: 'commonName', value: 'nai-axis' }], {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
  })
  fs.writeFileSync(CERT_PATH, pems.cert)
  fs.writeFileSync(KEY_PATH, pems.private)
  return { cert: pems.cert, key: pems.private }
}

function parseMessage(raw) {
  try {
    const msg = JSON.parse(raw.toString())
    return msg && typeof msg === 'object' ? msg : null
  } catch {
    return null
  }
}

function normalizeRoomCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6)
}

const rooms = new Map()

function createRoomCode() {
  let code = ''
  do {
    code = String(Math.floor(100000 + Math.random() * 900000))
  } while (rooms.has(code))
  return code
}

function isHost(room, socket) {
  return room.hostId === socket.meta.id
}

function rejectSocket(socket, message) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'error', message }))
  }
  try {
    socket.close()
  } catch {}
}

function bindSocket(room, socket) {
  socket.room = room
  socket.meta.roomId = room.id
  room.addSocket(socket)
}

function beginHost(socket, msg) {
  if (String(msg.hostKey || '') !== HOST_KEY) {
    rejectSocket(socket, '房间不存在')
    return
  }
  const code = createRoomCode()
  const room = new AxisRoom(code)
  rooms.set(code, room)
  bindSocket(room, socket)
  room.hostId = socket.meta.id
  if (msg.config) room.applyConfig({ cd: msg.config.cd, duration: msg.config.duration })
  socket.meta.spectator = false
  const slot = room.applyIdentity(socket, msg.name || '主持')
  room.send(socket, { type: 'roomCode', code })
  room.send(socket, { type: 'role', role: 'host' })
  room.send(socket, { type: 'assigned', slot })
  room.broadcast()
}

function beginJoin(socket, msg) {
  const code = normalizeRoomCode(msg.roomCode || msg.code)
  const room = rooms.get(code)
  if (!room) {
    rejectSocket(socket, '房间不存在')
    return
  }
  bindSocket(room, socket)
  handleMessage(room, socket, msg)
}

function handleMessage(room, socket, msg) {
  switch (msg.type) {
    case 'host':
      return
    case 'hello': {
      const slot = room.applyIdentity(socket, msg.name)
      room.send(socket, { type: 'role', role: isHost(room, socket) ? 'host' : 'client' })
      if (slot != null) room.send(socket, { type: 'assigned', slot, spectator: !!socket.meta.spectator })
      room.broadcast()
      break
    }
    case 'claimSlot': {
      if (socket.meta.spectator) return
      const slot = room.applyIdentity(socket, msg.name || socket.meta.name)
      room.send(socket, { type: 'assigned', slot, spectator: false })
      room.broadcast()
      break
    }
    case 'updateConfig':
      if (!isHost(room, socket)) return
      room.applyConfig(msg)
      room.broadcast()
      break
    case 'setMembers':
      break
    case 'renameMember':
      if (!isHost(room, socket)) return
      room.renameMember(msg.index, msg.name)
      room.broadcast()
      break
    case 'moveMember':
      if (!isHost(room, socket)) return
      room.moveMember(msg.from, msg.to)
      room.broadcast()
      break
    case 'kick':
      if (!isHost(room, socket)) return
      if (msg.id) room.kickClient(msg.id, socket.meta.id)
      else room.kickSlot(msg.slot, socket.meta.id)
      room.broadcast()
      break
    case 'addGhost': {
      if (!isHost(room, socket)) return
      const result = room.addGhost(msg.name)
      if (!result.ok) {
        room.send(socket, { type: 'error', message: result.message })
        return
      }
      room.broadcast()
      break
    }
    case 'setSpectator': {
      if (!isHost(room, socket)) return
      const result = room.setSpectator(msg.id, msg.spectator)
      if (!result.ok) {
        room.send(socket, { type: 'error', message: result.message })
        return
      }
      room.broadcast()
      break
    }
    case 'start':
      if (!isHost(room, socket)) return
      room.start()
      room.broadcast()
      break
    case 'pause':
      if (!isHost(room, socket)) return
      room.pause()
      room.broadcast()
      break
    case 'stop':
      if (!isHost(room, socket)) return
      room.stop()
      room.broadcast()
      break
    default:
      break
  }
}

const tls = ensureCerts()
const httpServer = https.createServer(tls, (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('无忧辅助工具 WSS 服务')
})

const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (socket) => {
  socket.meta = {
    id: Math.random().toString(36).slice(2, 10),
    name: '队员',
    slot: null,
    roomId: null,
    spectator: false,
  }
  socket.room = null

  socket.on('message', (raw) => {
    const msg = parseMessage(raw)
    if (!msg) return
    if (!socket.room) {
      if (msg.type === 'host') beginHost(socket, msg)
      else if (msg.type === 'hello') beginJoin(socket, msg)
      else rejectSocket(socket, '房间不存在')
      return
    }
    handleMessage(socket.room, socket, msg)
  })

  socket.on('close', () => {
    const room = socket.room
    if (!room) return
    const hostLeft = room.hostId === socket.meta.id
    room.removeSocket(socket)
    if (hostLeft) {
      room.stop()
      const peers = [...room.sockets.values()]
      rooms.delete(room.id)
      for (const peer of peers) {
        peer.room = null
        room.send(peer, { type: 'kicked', message: '主持已离开，房间已关闭' })
        try {
          peer.close()
        } catch {}
      }
      return
    }
    room.broadcast()
    if (room.sockets.size === 0) rooms.delete(room.id)
  })
})

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.running && !room.paused) room.broadcast()
  }
}, 1000)

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请先关掉本机主持或改 WSS_PORT`)
  } else {
    console.error(err)
  }
  process.exit(1)
})

httpServer.listen(PORT, HOST, () => {
  console.log(`WSS 已监听端口 ${PORT}`)
  console.log('队员加入时需填写六位房间密码')
  console.log(`证书：${CERT_PATH}`)
})
