'use strict';
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const http   = createServer(app);
const io     = new Server(http, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── SHARED CONSTANTS (keep in sync with public/game.js) ──────────────────────
const BRIDGE_CELLS   = 10;
const GEMS_PER_PICK  = 2;
const PILE_REFILL_MS = 25000;   // ms between +1 refill per pile
const PICKUP_RANGE   = 6;       // world units
const ATTACK_RANGE   = 6;
const FLAG_RANGE     = 4.5;
const UPGRADE_COST   = { speed: 30, carry: 50, blockPower: 80, weapon: 120 };

// Island centers [x, y, z]  y=0 → top of island grass at y=0.5
const ISLAND_POS = [
  [0, 0, -27],   // 0 North
  [27, 0, 0],    // 1 East
  [0, 0, 27],    // 2 South
  [-27, 0, 0],   // 3 West
];
const SPAWN_POS = [
  [0, 0.5, -24],
  [24, 0.5, 0],
  [0, 0.5, 24],
  [-24, 0.5, 0],
];
// Bridge cell world position for islandIdx + cellIdx
function bridgeCellPos(islandIdx, cellIdx) {
  switch (islandIdx) {
    case 0: return [0,           0.25, -4 - cellIdx * 2];
    case 1: return [4 + cellIdx * 2, 0.25, 0];
    case 2: return [0,           0.25,  4 + cellIdx * 2];
    case 3: return [-4 - cellIdx * 2, 0.25, 0];
  }
}
// Block pile offsets from island center (xz only)
const PILE_LOCAL = [[-3, 0], [3, 0]];

// ── ROOM MANAGEMENT ──────────────────────────────────────────────────────────
const rooms = new Map(); // code → room

function genCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 6 }, () => alpha[Math.floor(Math.random() * alpha.length)]).join('');
  } while (rooms.has(c));
  return c;
}

function makePiles() {
  return ISLAND_POS.flatMap(([ix,, iz], idx) =>
    PILE_LOCAL.map(([ox, oz], pi) => ({
      id:         `p${idx}_${pi}`,
      islandIdx:  idx,
      pos:        [ix + ox, 0.5, iz + oz],
      count:      5,
      max:        5,
      lastRefill: Date.now(),
    }))
  );
}

function makeRoom(hostSocket, name, teams) {
  const code = genCode();
  const room = {
    code,
    phase:   'lobby',        // lobby | playing | ended
    teams:   teams || 'solo',
    hostId:  hostSocket.id,
    players: new Map(),
    bridges: [[], [], [], []],
    piles:   makePiles(),
    winner:  null,
    refillTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, socket, name) {
  const islandIdx = room.players.size;
  const sp = SPAWN_POS[islandIdx];
  const yaw = [Math.PI, -Math.PI / 2, 0, Math.PI / 2][islandIdx];
  room.players.set(socket.id, {
    id:        socket.id,
    name:      name || `Player${islandIdx + 1}`,
    islandIdx,
    team:      null,
    pos:       [...sp],
    yaw,
    blocksHeld: 0,
    maxBlocks:  3,
    gems:       0,
    upgrades:   { speed: 0, carry: 0, blockPower: false, weapon: false },
  });
}

function lobbyList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, islandIdx: p.islandIdx, team: p.team,
  }));
}

function serRoom(room) {
  return {
    code:    room.code,
    phase:   room.phase,
    teams:   room.teams,
    hostId:  room.hostId,
    players: Object.fromEntries(
      [...room.players.entries()].map(([id, p]) => [id, {
        id: p.id, name: p.name, islandIdx: p.islandIdx, team: p.team,
        pos: p.pos, yaw: p.yaw,
        blocksHeld: p.blocksHeld, maxBlocks: p.maxBlocks,
        gems: p.gems, upgrades: p.upgrades,
      }])
    ),
    bridges: room.bridges,
    piles: room.piles.map(({ id, islandIdx, pos, count, max }) => ({ id, islandIdx, pos, count, max })),
    winner: room.winner,
  };
}

function startRefill(room) {
  room.refillTimer = setInterval(() => {
    if (room.phase !== 'playing') { clearInterval(room.refillTimer); return; }
    const now = Date.now();
    let changed = false;
    for (const pile of room.piles) {
      if (pile.count < pile.max && now - pile.lastRefill >= PILE_REFILL_MS) {
        pile.count++;
        pile.lastRefill = now;
        changed = true;
        io.to(room.code).emit('pile-update', { id: pile.id, count: pile.count });
      }
    }
  }, 3000);
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoom = null;
  const me = () => myRoom?.players.get(socket.id);

  // ── LOBBY ──────────────────────────────────────────────────────────────────
  socket.on('create-room', ({ name, teams } = {}) => {
    myRoom = makeRoom(socket, name, teams);
    socket.join(myRoom.code);
    addPlayer(myRoom, socket, name);
    socket.emit('room-created', { code: myRoom.code });
    emitLobby(myRoom);
  });

  socket.on('join-room', ({ code, name } = {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room)                  return socket.emit('room-error', { msg: 'Room not found.' });
    if (room.phase !== 'lobby') return socket.emit('room-error', { msg: 'Game already started.' });
    if (room.players.size >= 4) return socket.emit('room-error', { msg: 'Room is full (max 4).' });
    myRoom = room;
    socket.join(room.code);
    addPlayer(room, socket, name);
    const p = me();
    socket.emit('room-joined', {
      yourIsland: p.islandIdx, hostId: room.hostId,
      players: lobbyList(room), teams: room.teams,
    });
    socket.to(room.code).emit('lobby-update', { players: lobbyList(room), hostId: room.hostId, teams: room.teams });
  });

  socket.on('set-team', ({ team } = {}) => {
    if (!myRoom || myRoom.teams !== '2v2') return;
    const p = me(); if (!p) return;
    const taken = [...myRoom.players.values()].filter(q => q.id !== socket.id && q.team === team).length;
    if (taken >= 2) return socket.emit('room-error', { msg: `Team ${team} is full.` });
    p.team = team;
    emitLobby(myRoom);
  });

  socket.on('start-game', () => {
    if (!myRoom || myRoom.hostId !== socket.id || myRoom.phase !== 'lobby') return;
    myRoom.phase = 'playing';
    if (myRoom.teams === '2v2') {
      for (const [, p] of myRoom.players) {
        if (!p.team) p.team = p.islandIdx < 2 ? 'A' : 'B';
      }
    }
    io.to(myRoom.code).emit('game-started', serRoom(myRoom));
    startRefill(myRoom);
  });

  // ── IN-GAME ────────────────────────────────────────────────────────────────
  socket.on('player-update', ({ pos, yaw } = {}) => {
    const p = me();
    if (!p || myRoom?.phase !== 'playing') return;
    // loose anti-cheat: max 4 units movement per update
    if (Array.isArray(pos) && pos.length === 3) {
      const [dx, dy, dz] = [pos[0]-p.pos[0], pos[1]-p.pos[1], pos[2]-p.pos[2]];
      if (dx*dx + dy*dy + dz*dz < 16) p.pos = pos;
    }
    if (typeof yaw === 'number') p.yaw = yaw;
    socket.to(myRoom.code).emit('player-moved', { id: socket.id, pos: p.pos, yaw: p.yaw });
  });

  socket.on('pickup', () => {
    const p = me();
    if (!p || myRoom?.phase !== 'playing') return;
    if (p.blocksHeld >= p.maxBlocks) return socket.emit('toast', { msg: 'Inventory full!' });
    const pile = myRoom.piles.find(pl =>
      pl.islandIdx === p.islandIdx && pl.count > 0 &&
      Math.hypot(pl.pos[0]-p.pos[0], pl.pos[2]-p.pos[2]) < PICKUP_RANGE
    );
    if (!pile) return socket.emit('toast', { msg: 'No block pile nearby.' });
    const take = Math.min(p.maxBlocks - p.blocksHeld, pile.count);
    pile.count -= take;
    pile.lastRefill = Date.now();
    p.blocksHeld += take;
    p.gems += GEMS_PER_PICK;
    socket.emit('inv-update', { blocksHeld: p.blocksHeld, maxBlocks: p.maxBlocks, gems: p.gems });
    io.to(myRoom.code).emit('pile-update', { id: pile.id, count: pile.count });
  });

  socket.on('place', () => {
    const p = me();
    if (!p || myRoom?.phase !== 'playing' || p.blocksHeld <= 0) return;
    const bridge = myRoom.bridges[p.islandIdx];
    if (bridge.length >= BRIDGE_CELLS) return socket.emit('toast', { msg: 'Bridge complete!' });
    const toPlace = p.upgrades.blockPower
      ? Math.min(2, BRIDGE_CELLS - bridge.length, p.blocksHeld)
      : 1;
    for (let i = 0; i < toPlace; i++) {
      bridge.push(p.id);
      p.blocksHeld--;
    }
    socket.emit('inv-update', { blocksHeld: p.blocksHeld, maxBlocks: p.maxBlocks, gems: p.gems });
    io.to(myRoom.code).emit('bridge-update', { islandIdx: p.islandIdx, bridge: [...bridge] });
  });

  socket.on('attack', () => {
    const p = me();
    if (!p || myRoom?.phase !== 'playing' || !p.upgrades.weapon) return;
    // Break last cell of nearest enemy bridge
    for (let bi = 0; bi < 4; bi++) {
      if (bi === p.islandIdx) continue;
      const bridge = myRoom.bridges[bi];
      if (!bridge.length) continue;
      const lastIdx = bridge.length - 1;
      const cp = bridgeCellPos(bi, lastIdx);
      if (Math.hypot(cp[0]-p.pos[0], cp[2]-p.pos[2]) < ATTACK_RANGE) {
        bridge.pop();
        io.to(myRoom.code).emit('bridge-update', { islandIdx: bi, bridge: [...bridge] });
        return;
      }
    }
    socket.emit('toast', { msg: 'No enemy bridge in range.' });
  });

  socket.on('grab-flag', () => {
    const p = me();
    if (!p || myRoom?.phase !== 'playing') return;
    if (myRoom.bridges[p.islandIdx].length < BRIDGE_CELLS)
      return socket.emit('toast', { msg: `Bridge needs ${BRIDGE_CELLS - myRoom.bridges[p.islandIdx].length} more blocks.` });
    if (Math.hypot(p.pos[0], p.pos[2]) > FLAG_RANGE)
      return socket.emit('toast', { msg: 'Reach the center flag!' });
    myRoom.phase = 'ended';
    myRoom.winner = { id: p.id, name: p.name, team: p.team };
    clearInterval(myRoom.refillTimer);
    io.to(myRoom.code).emit('game-won', { winnerId: p.id, winnerName: p.name, winnerTeam: p.team });
  });

  socket.on('buy-upgrade', ({ type } = {}) => {
    const p = me();
    if (!p || myRoom?.phase !== 'playing') return;
    const cost = UPGRADE_COST[type];
    if (!cost) return;
    if (p.gems < cost) return socket.emit('toast', { msg: `Need ${cost} 💎 (you have ${p.gems}).` });
    if (type === 'speed'     && p.upgrades.speed < 3)     { p.upgrades.speed++;  p.gems -= cost; }
    else if (type === 'carry' && p.upgrades.carry < 3)    { p.upgrades.carry++;  p.maxBlocks += 2; p.gems -= cost; }
    else if (type === 'blockPower' && !p.upgrades.blockPower) { p.upgrades.blockPower = true; p.gems -= cost; }
    else if (type === 'weapon'    && !p.upgrades.weapon)      { p.upgrades.weapon    = true; p.gems -= cost; }
    else return socket.emit('toast', { msg: 'Already maxed!' });
    socket.emit('inv-update', { blocksHeld: p.blocksHeld, maxBlocks: p.maxBlocks, gems: p.gems });
    socket.emit('upgrade-ok', { upgrades: p.upgrades });
  });

  socket.on('play-again', () => {
    if (!myRoom || myRoom.hostId !== socket.id) return;
    // Reset room state
    myRoom.phase   = 'lobby';
    myRoom.bridges = [[], [], [], []];
    myRoom.piles   = makePiles();
    myRoom.winner  = null;
    clearInterval(myRoom.refillTimer);
    for (const [, p] of myRoom.players) {
      const sp = SPAWN_POS[p.islandIdx];
      p.pos        = [...sp];
      p.blocksHeld = 0;
      p.gems       = 0;
      p.upgrades   = { speed: 0, carry: 0, blockPower: false, weapon: false };
      p.maxBlocks  = 3;
    }
    io.to(myRoom.code).emit('game-reset', serRoom(myRoom));
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!myRoom) return;
    myRoom.players.delete(socket.id);
    if (myRoom.players.size === 0) {
      clearInterval(myRoom.refillTimer);
      rooms.delete(myRoom.code);
      return;
    }
    if (myRoom.hostId === socket.id) {
      myRoom.hostId = myRoom.players.keys().next().value;
    }
    socket.to(myRoom.code).emit('player-left', { id: socket.id });
    emitLobby(myRoom);
  });
});

function emitLobby(room) {
  io.to(room.code).emit('lobby-update', {
    players: lobbyList(room), hostId: room.hostId, teams: room.teams,
  });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Bridge Battle 3D → http://localhost:${PORT}`));
