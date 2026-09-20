function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function cleanName(name, fallback = '队员') {
  return String(name || '').trim().slice(0, 12) || fallback
}

function remapSlot(slot, from, to) {
  if (!Number.isInteger(slot) || from === to) return slot
  if (slot === from) return to
  if (from < to && slot > from && slot <= to) return slot - 1
  if (to < from && slot >= to && slot < from) return slot + 1
  return slot
}

function moveArrayItem(arr, from, to) {
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function ghostId() {
  return `ghost-${Math.random().toString(36).slice(2, 10)}`
}

class AxisRoom {
  constructor(id) {
    this.id = id
    this.hostId = null
    this.config = { cd: 120, duration: 4, teamSize: 1 }
    this.members = ['主持']
    this.running = false
    this.paused = false
    this.startedAt = null
    this.elapsedMs = 0
    this.sockets = new Map()
    this.ghosts = []
  }

  axisEntries() {
    const live = [...this.sockets.values()]
      .filter((socket) => !socket.meta.spectator)
      .map((socket) => ({
        id: socket.meta.id,
        name: socket.meta.name || '未命名',
        slot: Number.isInteger(socket.meta.slot) ? socket.meta.slot : 999,
        kind: 'live',
        socket,
        role: socket.meta.id === this.hostId ? 'host' : 'client',
      }))
    const ghosts = this.ghosts.map((ghost) => ({
      id: ghost.id,
      name: ghost.name || '未进房',
      slot: Number.isInteger(ghost.slot) ? ghost.slot : 999,
      kind: 'ghost',
      role: 'ghost',
    }))
    return [...live, ...ghosts].sort((a, b) => {
      if (a.slot !== b.slot) return a.slot - b.slot
      return String(a.id).localeCompare(String(b.id))
    })
  }

  rebuildAxis() {
    const entries = this.axisEntries()
    const size = Math.max(1, entries.length)
    this.config.teamSize = size
    if (!entries.length) {
      this.members = ['空位']
    } else {
      this.members = entries.map((entry, index) => {
        entry.slot = index
        if (entry.socket) entry.socket.meta.slot = index
        else {
          const ghost = this.ghosts.find((item) => item.id === entry.id)
          if (ghost) ghost.slot = index
        }
        return entry.name || `${index + 1}号`
      })
    }
    for (const socket of this.sockets.values()) {
      if (socket.meta.spectator) socket.meta.slot = null
    }
    this.notifyAssigned()
  }

  notifyAssigned() {
    for (const socket of this.sockets.values()) {
      this.send(socket, {
        type: 'assigned',
        slot: Number.isInteger(socket.meta.slot) ? socket.meta.slot : null,
        spectator: !!socket.meta.spectator,
      })
    }
  }

  addSocket(socket) {
    socket.meta.spectator = !!socket.meta.spectator
    this.sockets.set(socket.meta.id, socket)
  }

  removeSocket(socket) {
    this.sockets.delete(socket.meta.id)
    if (this.hostId === socket.meta.id) this.hostId = null
    this.rebuildAxis()
  }

  applyIdentity(socket, name) {
    socket.meta.name = cleanName(name)
    if (socket.meta.spectator) {
      socket.meta.slot = null
      this.rebuildAxis()
      return null
    }
    if (!Number.isInteger(socket.meta.slot)) {
      const ghost = this.ghosts.find((item) => item.name === socket.meta.name)
      if (ghost) {
        socket.meta.slot = ghost.slot
        this.ghosts = this.ghosts.filter((item) => item.id !== ghost.id)
      }
    } else if (this.members[socket.meta.slot] != null) {
      this.members[socket.meta.slot] = socket.meta.name
      this.rebuildAxis()
      return socket.meta.slot
    }
    this.rebuildAxis()
    return Number.isInteger(socket.meta.slot) ? socket.meta.slot : null
  }

  applyConfig(partial = {}) {
    if (partial.cd != null) this.config.cd = clamp(Number(partial.cd), 1, 3600)
    if (partial.duration != null) this.config.duration = clamp(Number(partial.duration), 0.2, 120)
  }

  applyMembers() {
    this.rebuildAxis()
  }

  addGhost(name) {
    if (this.axisEntries().length >= 40) return { ok: false, message: '轴内最多 40 人' }
    this.ghosts.push({
      id: ghostId(),
      name: cleanName(name, `${this.axisEntries().length + 1}号`),
      slot: 999,
    })
    this.rebuildAxis()
    return { ok: true }
  }

  removeGhost(id) {
    const before = this.ghosts.length
    this.ghosts = this.ghosts.filter((item) => item.id !== id)
    if (this.ghosts.length === before) return false
    this.rebuildAxis()
    return true
  }

  renameMember(index, name) {
    const entries = this.axisEntries()
    const entry = entries[index]
    const nextName = cleanName(name, `${index + 1}号`)
    if (entry?.socket) entry.socket.meta.name = nextName
    else if (entry) {
      const ghost = this.ghosts.find((item) => item.id === entry.id)
      if (ghost) ghost.name = nextName
    }
    if (this.members[index] != null) this.members[index] = nextName
  }

  moveMember(from, to) {
    const entries = this.axisEntries()
    const src = clamp(Number(from), 0, Math.max(0, entries.length - 1))
    const dst = clamp(Number(to), 0, Math.max(0, entries.length - 1))
    if (src === dst || !entries.length) return false
    const ordered = moveArrayItem(entries, src, dst)
    ordered.forEach((entry, index) => {
      if (entry.socket) entry.socket.meta.slot = index
      else {
        const ghost = this.ghosts.find((item) => item.id === entry.id)
        if (ghost) ghost.slot = index
      }
    })
    this.rebuildAxis()
    return true
  }

  setSpectator(id, spectator) {
    const socket = this.sockets.get(id)
    if (!socket) return { ok: false, message: '房间不存在' }
    const becomingSpectator = !!spectator
    if (becomingSpectator && !socket.meta.spectator && this.axisEntries().length <= 1) {
      return { ok: false, message: '轴内至少保留一人' }
    }
    socket.meta.spectator = becomingSpectator
    this.rebuildAxis()
    return { ok: true }
  }

  kickClient(id, byId) {
    if (this.removeGhost(id)) return true
    const socket = this.sockets.get(id)
    if (!socket || socket.meta.id === byId || socket.meta.id === this.hostId) return false
    this.send(socket, { type: 'kicked', message: '你已被主持踢出' })
    try {
      socket.close()
    } catch {}
    return true
  }

  kickSlot(slot, byId) {
    const target = this.axisEntries()[clamp(Number(slot), 0, Math.max(0, this.config.teamSize - 1))]
    if (!target) return false
    return this.kickClient(target.id, byId)
  }

  start() {
    const now = Date.now()
    if (this.paused && this.startedAt) {
      this.startedAt = now - this.elapsedMs
      this.paused = false
    } else {
      this.startedAt = now
      this.elapsedMs = 0
      this.paused = false
    }
    this.running = true
  }

  pause() {
    if (!this.running || this.paused) return
    this.elapsedMs = Date.now() - this.startedAt
    this.paused = true
  }

  stop() {
    this.running = false
    this.paused = false
    this.startedAt = null
    this.elapsedMs = 0
  }

  runtime(now = Date.now()) {
    const size = Math.max(1, this.config.teamSize)
    const interval = (this.config.cd / size) * 1000
    const duration = this.config.duration * 1000
    const elapsed = this.running
      ? this.paused
        ? this.elapsedMs
        : now - this.startedAt
      : 0

    if (!this.running || interval <= 0) {
      return {
        elapsed,
        interval,
        duration,
        currentIndex: 0,
        showing: false,
        remaining: 0,
        untilNext: interval,
        cycle: 0,
        intervalSec: interval / 1000,
        remainingSec: 0,
        untilNextSec: interval / 1000,
        elapsedSec: 0,
      }
    }

    const cycle = Math.floor(elapsed / interval)
    const currentIndex = cycle % size
    const intoSlot = elapsed % interval
    const showing = intoSlot < duration
    const remaining = showing ? duration - intoSlot : 0
    const untilNext = interval - intoSlot
    return {
      elapsed,
      interval,
      duration,
      currentIndex,
      showing,
      remaining,
      untilNext,
      cycle,
      intervalSec: interval / 1000,
      remainingSec: remaining / 1000,
      untilNextSec: untilNext / 1000,
      elapsedSec: elapsed / 1000,
    }
  }

  clients() {
    return [...this.sockets.values()].map((socket) => ({
      id: socket.meta.id,
      name: socket.meta.name || '未命名',
      slot: socket.meta.slot ?? null,
      spectator: !!socket.meta.spectator,
      role: socket.meta.id === this.hostId ? 'host' : 'client',
    }))
  }

  snapshot() {
    const runtime = this.runtime()
    const members = this.members.slice(0, this.config.teamSize)
    const clients = this.clients()
    const players = this.axisEntries().map((entry) => ({
      id: entry.id,
      name: entry.name || '未命名',
      slot: entry.slot ?? null,
      spectator: false,
      ghost: entry.kind === 'ghost',
      role: entry.role,
    }))
    return {
      config: { ...this.config },
      members,
      players,
      spectators: clients.filter((client) => client.spectator),
      running: this.running,
      paused: this.paused,
      startedAt: this.startedAt,
      elapsedMs: this.elapsedMs,
      runtime,
      currentName: members[runtime.currentIndex] || `${runtime.currentIndex + 1}号`,
      nextName:
        members[(runtime.currentIndex + 1) % Math.max(1, this.config.teamSize)] ||
        `${((runtime.currentIndex + 1) % Math.max(1, this.config.teamSize)) + 1}号`,
      clients,
      hostUrl: '',
      room: this.id,
      hostId: this.hostId,
      serverNow: Date.now(),
    }
  }

  send(socket, data) {
    if (socket.readyState === 1) socket.send(JSON.stringify(data))
  }

  broadcast() {
    const payload = { type: 'state', payload: this.snapshot() }
    const raw = JSON.stringify(payload)
    for (const socket of this.sockets.values()) {
      if (socket.readyState === 1) socket.send(raw)
    }
  }
}

module.exports = { AxisRoom, cleanName, clamp, remapSlot, moveArrayItem }
