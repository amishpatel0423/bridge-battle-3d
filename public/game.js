'use strict';
/* ── SHARED CONSTANTS (keep in sync with server.js) ─────────────────────────*/
const BRIDGE_CELLS = 10;
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
function bridgeCellPos(islandIdx, cellIdx) {
  switch (islandIdx) {
    case 0: return [0,              0.25, -4 - cellIdx * 2];
    case 1: return [4 + cellIdx * 2, 0.25, 0];
    case 2: return [0,              0.25,  4 + cellIdx * 2];
    case 3: return [-4 - cellIdx * 2, 0.25, 0];
  }
}
const ISLAND_COLOR  = [0x4488ff, 0xffaa22, 0xff4444, 0x44cc88];
const ISLAND_COLOR_DARK = [0x2255cc, 0xcc8800, 0xcc2211, 0x228866];
const ISLAND_COLOR_LIGHT = [0x88aaff, 0xffcc66, 0xff8877, 0x88eeaa];
const ISLAND_NAMES  = ['North', 'East', 'South', 'West'];
const UPGRADE_COST  = { speed: 30, carry: 50, blockPower: 80, weapon: 120 };
const PICKUP_RANGE  = 6;
const FLAG_RANGE    = 4.5;
const MOVE_BASE     = 6;
const FALL_ACCEL    = -22;
const GROUND_Y      = 0.5;   // y where players stand (island top / bridge top)

/* ── STATE ───────────────────────────────────────────────────────────────────*/
let socket, scene, camera, renderer;
let myId = null, myIsland = 0;
let localPos = [0, GROUND_Y, -24];
let localYaw = Math.PI;
let velY = 0, onGround = true;
let myBlocks = 0, myMaxBlocks = 3, myGems = 0;
let myUpgrades = { speed: 0, carry: 0, blockPower: false, weapon: false };
let myBridgeLen = 0;
let moveInput = { dx: 0, dz: 0 };
const heldKeys = new Set();

// Scene objects
const remotePlayers   = {};   // id → { mesh, targetPos, targetYaw }
let   localMesh       = null;
const bridgeMeshes    = [[], [], [], []]; // per island, array of THREE.Mesh
const pileGroups      = {};   // pile.id → THREE.Group
const upgradeOrbs     = [];   // { mesh, islandIdx }
let   centerFlagMesh  = null;
let   flagLight       = null;
let   myRoomCode      = '';

/* ── SOCKET ──────────────────────────────────────────────────────────────────*/
function initSocket() {
  socket = io();

  socket.on('room-created', ({ code }) => {
    myRoomCode = code;
    document.getElementById('lobby-code').textContent = code;
    showScreen('lobby');
  });

  socket.on('room-joined', ({ yourIsland, hostId, players, teams }) => {
    myIsland = yourIsland;
    showScreen('lobby');
    refreshLobby({ players, hostId, teams });
  });

  socket.on('room-error', ({ msg }) => showToast(msg));

  socket.on('lobby-update', ({ players, hostId, teams }) => {
    refreshLobby({ players, hostId, teams });
  });

  socket.on('game-started', state => {
    myRoomCode = state.code;
    launchGame(state);
  });

  socket.on('game-reset', state => {
    location.reload(); // simplest reset path
  });

  socket.on('player-moved', ({ id, pos, yaw }) => {
    if (!remotePlayers[id]) return;
    remotePlayers[id].targetPos = pos;
    remotePlayers[id].targetYaw = yaw;
  });

  socket.on('bridge-update', ({ islandIdx, bridge }) => {
    rebuildBridge(islandIdx, bridge);
  });

  socket.on('pile-update', ({ id, count }) => {
    const g = pileGroups[id];
    if (g) {
      g.userData.count = count;
      g.scale.y = Math.max(0.15, count / 5);
      g.userData.ring.material.opacity = count > 0 ? 0.7 : 0.1;
    }
  });

  socket.on('inv-update', ({ blocksHeld, maxBlocks, gems }) => {
    myBlocks    = blocksHeld;
    myMaxBlocks = maxBlocks;
    myGems      = gems;
    refreshHUD();
  });

  socket.on('upgrade-ok', ({ upgrades }) => {
    myUpgrades = upgrades;
    sfxUpgrade();
    refreshHUD();
    refreshUpgradeMenu();
  });

  socket.on('player-left', ({ id }) => {
    if (remotePlayers[id]) {
      scene.remove(remotePlayers[id].mesh);
      delete remotePlayers[id];
    }
  });

  socket.on('toast', ({ msg }) => showToast(msg));

  socket.on('game-won', ({ winnerId, winnerName, winnerTeam }) => {
    sfxWin();
    document.getElementById('win-text').textContent =
      winnerTeam
        ? `Team ${winnerTeam} wins!\n${winnerName} grabbed the flag! 🚩`
        : `${winnerName} grabbed the flag! 🚩`;
    document.getElementById('win-sub').textContent =
      winnerId === myId ? '🎉 That was YOU!' : 'Better luck next time!';
    showScreen('win');
  });
}

/* ── SCREENS ─────────────────────────────────────────────────────────────────*/
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add('active');
  document.getElementById('hud').classList.toggle('show', name === 'game');
  const isMob = isMobile();
  document.getElementById('mobile-controls').classList.toggle('show', name === 'game' && isMob);
  document.getElementById('key-hints').style.display = name === 'game' && !isMob ? 'block' : 'none';
}

function refreshLobby({ players, hostId, teams }) {
  const isHost = socket.id === hostId;
  document.getElementById('btn-start').style.display = isHost ? '' : 'none';
  document.getElementById('lobby-waiting').style.display = isHost ? 'none' : '';
  const teamDiv = document.getElementById('lobby-team-btns');
  teamDiv.style.display = teams === '2v2' ? 'flex' : 'none';

  const list = document.getElementById('lobby-players');
  list.innerHTML = players.map(p => `
    <div class="lobby-player">
      <span class="island-badge i${p.islandIdx}">${ISLAND_NAMES[p.islandIdx]}</span>
      <span style="flex:1">${escHtml(p.name)}${p.id === hostId ? ' 👑' : ''}</span>
      ${p.team ? `<span class="team-badge t${p.team}">${p.team}</span>` : ''}
    </div>
  `).join('');
}

/* ── THREE.JS WORLD ──────────────────────────────────────────────────────────*/
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0xaaddee, 40, 140);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('game-canvas'),
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xfffbe8, 0.9);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -70;
  sun.shadow.camera.right = sun.shadow.camera.top = 70;
  sun.shadow.camera.far = 200;
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function buildWorld(initialState) {
  // Void floor
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x050010 });
  const voidMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), voidMat);
  voidMesh.rotation.x = -Math.PI / 2;
  voidMesh.position.y = -22;
  scene.add(voidMesh);

  // Clouds
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group();
    [0, -3, 3].forEach(ox => {
      const c = new THREE.Mesh(new THREE.SphereGeometry(2.5 + Math.random(), 8, 6), cloudMat);
      c.position.set(ox * 2, Math.random(), 0);
      g.add(c);
    });
    g.position.set((Math.random() - 0.5) * 120, 18 + Math.random() * 12, (Math.random() - 0.5) * 120);
    g.userData.cloudSpd = 0.015 + Math.random() * 0.025;
    scene.add(g);
  }

  // 4 Islands
  for (let i = 0; i < 4; i++) buildIsland(i);

  // Center platform + flag
  buildCenter();

  // Initial bridges
  for (let i = 0; i < 4; i++) {
    if (initialState.bridges[i]?.length) rebuildBridge(i, initialState.bridges[i]);
  }

  // Initial pile counts
  for (const pile of initialState.piles) {
    const g = pileGroups[pile.id];
    if (g) {
      g.userData.count = pile.count;
      g.scale.y = Math.max(0.15, pile.count / pile.max);
    }
  }
}

function buildIsland(idx) {
  const [ix,, iz] = ISLAND_POS[idx];
  const col  = ISLAND_COLOR[idx];
  const dark = ISLAND_COLOR_DARK[idx];

  // Stone body
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(10, 4, 10),
    new THREE.MeshLambertMaterial({ color: 0x7a6045 })
  );
  stone.position.set(ix, -2, iz);
  stone.castShadow = true; stone.receiveShadow = true;
  scene.add(stone);

  // Grass top (y=0, height=1 → top at y=0.5)
  const grass = new THREE.Mesh(
    new THREE.BoxGeometry(10, 1, 10),
    new THREE.MeshLambertMaterial({ color: 0x4caf50 })
  );
  grass.position.set(ix, 0, iz);
  grass.receiveShadow = true;
  scene.add(grass);

  // Team-color trim
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(10.2, 0.2, 10.2),
    new THREE.MeshLambertMaterial({ color: col })
  );
  trim.position.set(ix, 0.6, iz);
  scene.add(trim);

  // Flag pole + pennant
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 3.5, 8),
    new THREE.MeshLambertMaterial({ color: 0x8B4513 })
  );
  pole.position.set(ix, 2.25, iz - 4);
  scene.add(pole);
  const pennant = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.2, 4),
    new THREE.MeshLambertMaterial({ color: col })
  );
  pennant.rotation.z = Math.PI / 2;
  pennant.position.set(ix + 0.6, 3.8, iz - 4);
  scene.add(pennant);

  // Block piles (2 per island)
  const pileOffsets = [[-3, 0], [3, 0]];
  pileOffsets.forEach(([ox, oz], pi) => {
    const pileId = `p${idx}_${pi}`;
    const g = new THREE.Group();

    for (let j = 0; j < 4; j++) {
      const bk = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.45, 1.1),
        new THREE.MeshLambertMaterial({ color: 0xd4a76a })
      );
      bk.position.set((Math.random() - 0.5) * 0.3, j * 0.46, (Math.random() - 0.5) * 0.3);
      bk.castShadow = true;
      g.add(bk);
    }

    // Glow ring on ground
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.0, 24),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.48;
    g.add(ring);
    g.userData.ring = ring;

    g.position.set(ix + ox, GROUND_Y, iz + oz);
    g.userData.pileId = pileId;
    g.userData.islandIdx = idx;
    g.userData.count = 5;
    scene.add(g);
    pileGroups[pileId] = g;
  });

  // Upgrade station orb
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0xFFD700, emissive: 0xFFD700, emissiveIntensity: 0.6,
      metalness: 0.2, roughness: 0.3,
    })
  );
  const orbX = ix + (idx % 2 === 0 ? 3.5 : -3.5);
  orb.position.set(orbX, GROUND_Y + 1.0, iz + 3.5);
  orb.userData.islandIdx = idx;
  scene.add(orb);
  upgradeOrbs.push(orb);

  // Orb glow ring
  const orbRing = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0xFFD700, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  orbRing.rotation.x = -Math.PI / 2;
  orbRing.position.set(orbX, GROUND_Y + 0.02, iz + 3.5);
  scene.add(orbRing);
}

function buildCenter() {
  // Platform (top at y=0.5)
  const plat = new THREE.Mesh(
    new THREE.BoxGeometry(7, 1, 7),
    new THREE.MeshLambertMaterial({ color: 0xf0e8d0 })
  );
  plat.position.set(0, 0, 0);
  plat.receiveShadow = true;
  scene.add(plat);

  // Mosaic edging
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(7.4, 0.3, 7.4),
    new THREE.MeshLambertMaterial({ color: 0xFFD700 })
  );
  edge.position.set(0, 0.65, 0);
  scene.add(edge);

  // Flag pole
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 5, 10),
    new THREE.MeshLambertMaterial({ color: 0xcccccc })
  );
  pole.position.set(0, 3, 0);
  scene.add(pole);

  // Flag cloth
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 1.2),
    new THREE.MeshLambertMaterial({ color: 0xFFD700, side: THREE.DoubleSide })
  );
  flag.position.set(1, 5.1, 0);
  scene.add(flag);
  centerFlagMesh = flag;

  // Point light on flag
  flagLight = new THREE.PointLight(0xFFD700, 1.2, 20);
  flagLight.position.set(0, 6, 0);
  scene.add(flagLight);
}

/* ── PLAYER MESHES ───────────────────────────────────────────────────────────*/
function makePlayerMesh(islandIdx, isLocal) {
  const col  = ISLAND_COLOR[islandIdx];
  const dark = ISLAND_COLOR_DARK[islandIdx];
  const lite = ISLAND_COLOR_LIGHT[islandIdx];
  const g = new THREE.Group();

  // Legs
  [-0.22, 0.22].forEach(lx => {
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.7, 0.3),
      new THREE.MeshLambertMaterial({ color: dark })
    );
    leg.position.set(lx, 0.35, 0);
    leg.castShadow = true;
    g.add(leg);
  });

  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.76, 0.9, 0.46),
    new THREE.MeshLambertMaterial({ color: col })
  );
  body.position.set(0, 1.15, 0);
  body.castShadow = true;
  g.add(body);

  // Arms
  [-0.5, 0.5].forEach(ax => {
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.7, 0.28),
      new THREE.MeshLambertMaterial({ color: col })
    );
    arm.position.set(ax, 1.05, 0);
    arm.castShadow = true;
    g.add(arm);
  });

  // Head
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.72, 0.72),
    new THREE.MeshLambertMaterial({ color: lite })
  );
  head.position.set(0, 1.9, 0);
  head.castShadow = true;
  g.add(head);

  // Eyes
  [-0.14, 0.14].forEach(ex => {
    const eye = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.11, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x111111 })
    );
    eye.position.set(ex, 1.95, 0.34);
    g.add(eye);
  });

  // Local player indicator (glowing halo)
  if (isLocal) {
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 24),
      new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.02;
    g.add(halo);
  }

  // Name label (canvas sprite)
  const nc = document.createElement('canvas');
  nc.width = 256; nc.height = 56;
  const nctx = nc.getContext('2d');
  nctx.fillStyle = 'rgba(0,0,0,0.6)';
  nctx.roundRect(0, 0, 256, 56, 8); nctx.fill();
  nctx.fillStyle = '#ffffff';
  nctx.font = 'bold 26px system-ui';
  nctx.textAlign = 'center';
  nctx.fillText(ISLAND_NAMES[islandIdx], 128, 36);
  const nt = new THREE.CanvasTexture(nc);
  const ns = new THREE.Sprite(new THREE.SpriteMaterial({ map: nt, transparent: true, depthTest: false }));
  ns.scale.set(2.4, 0.55, 1);
  ns.position.y = 2.8;
  g.add(ns);

  return g;
}

/* ── BRIDGE MESHES ───────────────────────────────────────────────────────────*/
const BRIDGE_MAT = [
  new THREE.MeshLambertMaterial({ color: ISLAND_COLOR[0] }),
  new THREE.MeshLambertMaterial({ color: ISLAND_COLOR[1] }),
  new THREE.MeshLambertMaterial({ color: ISLAND_COLOR[2] }),
  new THREE.MeshLambertMaterial({ color: ISLAND_COLOR[3] }),
];
const BRIDGE_GEO = new THREE.BoxGeometry(2.35, 0.5, 2.35);

function rebuildBridge(islandIdx, bridge) {
  // Remove old meshes
  bridgeMeshes[islandIdx].forEach(m => scene.remove(m));
  bridgeMeshes[islandIdx] = [];

  for (let i = 0; i < bridge.length; i++) {
    const [bx, by, bz] = bridgeCellPos(islandIdx, i);
    const m = new THREE.Mesh(BRIDGE_GEO, BRIDGE_MAT[islandIdx]);
    m.position.set(bx, by, bz);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    bridgeMeshes[islandIdx].push(m);
  }

  if (islandIdx === myIsland) {
    myBridgeLen = bridge.length;
    refreshHUD();
  }
}

/* ── LOCAL PLAYER PHYSICS ────────────────────────────────────────────────────*/
function getGroundY(px, pz) {
  // Islands
  for (let i = 0; i < 4; i++) {
    const [ix,, iz] = ISLAND_POS[i];
    if (Math.abs(px - ix) < 5.2 && Math.abs(pz - iz) < 5.2) return GROUND_Y;
  }
  // Bridge cells (all 4 bridges)
  for (let bi = 0; bi < 4; bi++) {
    for (let ci = 0; ci < bridgeMeshes[bi].length; ci++) {
      const bp = bridgeMeshes[bi][ci].position;
      if (Math.abs(px - bp.x) < 1.4 && Math.abs(pz - bp.z) < 1.4) return GROUND_Y;
    }
  }
  // Center platform
  if (Math.abs(px) < 3.8 && Math.abs(pz) < 3.8) return GROUND_Y;
  return null;
}

function tickLocalPlayer(dt) {
  const spd = MOVE_BASE * (1 + (myUpgrades.speed || 0) * 0.25);
  let ddx = moveInput.dx, ddz = moveInput.dz;

  // Keyboard input
  if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft'))  ddx -= 1;
  if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) ddx += 1;
  if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp'))    ddz -= 1;
  if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown'))  ddz += 1;
  const len = Math.hypot(ddx, ddz);
  if (len > 0) { ddx /= len; ddz /= len; }

  // Transform by camera heading so WASD is always relative to camera
  if (len > 0) {
    const camAngle = Math.atan2(
      camera.position.x - localPos[0],
      camera.position.z - localPos[2]
    ) + Math.PI;
    const cos = Math.cos(camAngle), sin = Math.sin(camAngle);
    const wx = ddx * cos - ddz * sin;
    const wz = ddx * sin + ddz * cos;
    localPos[0] += wx * spd * dt;
    localPos[2] += wz * spd * dt;
    localYaw = Math.atan2(-wx, -wz);
  }

  // Gravity
  const gy = getGroundY(localPos[0], localPos[2]);
  if (gy !== null && localPos[1] <= gy + 0.05 && velY <= 0) {
    localPos[1] = gy;
    velY = 0;
    onGround = true;
  } else {
    velY += FALL_ACCEL * dt;
    localPos[1] += velY * dt;
    onGround = false;
  }

  // Fell into void
  if (localPos[1] < -8) {
    sfxFall();
    localPos = [...SPAWN_POS[myIsland]];
    velY = 0; onGround = true;
    myBlocks = 0;
    refreshHUD();
    socket.emit('inv-update-req'); // server will reply with current inv
  }

  // Update local mesh
  if (localMesh) {
    localMesh.position.set(...localPos);
    localMesh.rotation.y = localYaw;
  }

  // Proximity-based button states
  updateActionBtns();
}

function updateActionBtns() {
  const isMob = isMobile();

  // Pick up: near any pile on own island with capacity
  let nearPile = false;
  for (const g of Object.values(pileGroups)) {
    if (g.userData.islandIdx === myIsland && g.userData.count > 0 && myBlocks < myMaxBlocks) {
      const d = Math.hypot(g.position.x - localPos[0], g.position.z - localPos[2]);
      if (d < PICKUP_RANGE) { nearPile = true; break; }
    }
  }

  // Can place block
  const canPlace = myBlocks > 0 && myBridgeLen < BRIDGE_CELLS;

  // Near upgrade orb on own island
  let nearOrb = false;
  for (const orb of upgradeOrbs) {
    if (orb.userData.islandIdx === myIsland) {
      const d = Math.hypot(orb.position.x - localPos[0], orb.position.z - localPos[2]);
      if (d < 5) { nearOrb = true; break; }
    }
  }

  // Near flag (bridge complete)
  const nearFlag = myBridgeLen >= BRIDGE_CELLS && Math.hypot(localPos[0], localPos[2]) < FLAG_RANGE + 1;

  if (isMob) {
    document.getElementById('btn-pickup').classList.toggle('can-do', nearPile);
    document.getElementById('btn-place').classList.toggle('can-do', canPlace);
    document.getElementById('btn-attack').style.display = myUpgrades.weapon ? 'flex' : 'none';
    document.getElementById('btn-flag').style.display = nearFlag ? 'flex' : 'none';
    document.getElementById('btn-upgrade-open').style.display = nearOrb ? 'flex' : 'none';
  }

  // Auto-show upgrade menu hint for desktop
  if (!isMob) {
    document.getElementById('key-hints').style.opacity = nearOrb ? '0.9' : '0.4';
  }

  // Auto-close upgrade menu if moved away
  if (!nearOrb && document.getElementById('upgrade-menu').classList.contains('show')) {
    closeUpgrade();
  }
}

/* ── FOLLOW CAMERA ───────────────────────────────────────────────────────────*/
const _camOff = new THREE.Vector3(0, 7, 11);
const _camTarget = new THREE.Vector3();
function tickCamera() {
  if (!localMesh) return;
  const ppos = localMesh.position;
  const offset = _camOff.clone().applyEuler(new THREE.Euler(0, localYaw, 0));
  _camTarget.copy(ppos).add(offset);
  camera.position.lerp(_camTarget, 0.1);
  camera.lookAt(ppos.x, ppos.y + 1.5, ppos.z);
}

/* ── NETWORK SEND ─────────────────────────────────────────────────────────────*/
let lastNetSend = 0;
function tickNetwork(now) {
  if (now - lastNetSend < 50) return;
  lastNetSend = now;
  socket.emit('player-update', { pos: localPos, yaw: localYaw });
}

/* ── REMOTE PLAYER INTERPOLATION ────────────────────────────────────────────*/
function tickRemotes() {
  for (const [, rp] of Object.entries(remotePlayers)) {
    if (!rp.targetPos) continue;
    const tp = new THREE.Vector3(...rp.targetPos);
    rp.mesh.position.lerp(tp, 0.18);
    let dy = (rp.targetYaw - rp.mesh.rotation.y) % (Math.PI * 2);
    if (dy > Math.PI)  dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    rp.mesh.rotation.y += dy * 0.18;
  }
}

/* ── HUD ─────────────────────────────────────────────────────────────────────*/
function refreshHUD() {
  document.getElementById('hud-gems').textContent   = myGems;
  document.getElementById('hud-blocks').textContent = `${myBlocks}/${myMaxBlocks}`;
  document.getElementById('hud-bridge-num').textContent = `${myBridgeLen}/${BRIDGE_CELLS}`;
  document.getElementById('hud-bridge-fill').style.width = `${(myBridgeLen / BRIDGE_CELLS) * 100}%`;
  document.getElementById('hud-spd').textContent = `Lv${myUpgrades.speed}`;
  document.getElementById('hud-cap').textContent = `${myMaxBlocks}`;
  const icons = [];
  if (myUpgrades.blockPower) icons.push('💥');
  if (myUpgrades.weapon)     icons.push('⚔️');
  document.getElementById('hud-upg-icons').textContent = icons.join('');
  drawMinimap();
}

function drawMinimap() {
  const cv = document.getElementById('minimap-canvas');
  if (!cv) return;
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W/2, cy = H/2, S = W/70;
  c.clearRect(0, 0, W, H);

  // Center flag
  c.fillStyle = '#ffd700';
  c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI*2); c.fill();

  // Islands + bridges
  const dir = [[0,-1],[1,0],[0,1],[-1,0]];
  const hexCol = ['#4488ff','#ffaa22','#ff4444','#44cc88'];
  for (let i = 0; i < 4; i++) {
    const [dx, dz] = dir[i];
    const ix = cx + dx*27*S, iy = cy + dz*27*S;
    c.fillStyle = hexCol[i];
    c.fillRect(ix - 5*S, iy - 5*S, 10*S, 10*S);

    // Bridge progress
    const blen = bridgeMeshes[i]?.length || 0;
    for (let ci = 0; ci < blen; ci++) {
      const t = (ci + 0.5) / BRIDGE_CELLS;
      const bx = cx + dx * (4 + t * 22) * S;
      const by = cy + dz * (4 + t * 22) * S;
      c.fillStyle = hexCol[i];
      c.beginPath(); c.arc(bx, by, 2*S, 0, Math.PI*2); c.fill();
    }
  }

  // Players
  const drawDot = (px, pz, color) => {
    const mx = cx + px*S, my = cy + pz*S;
    c.fillStyle = color;
    c.beginPath(); c.arc(mx, my, 3, 0, Math.PI*2); c.fill();
    c.strokeStyle = '#000'; c.lineWidth = 0.5; c.stroke();
  };
  if (localMesh) drawDot(localPos[0], localPos[2], '#ffffff');
  for (const [, rp] of Object.entries(remotePlayers)) {
    drawDot(rp.mesh.position.x, rp.mesh.position.z, '#ffff66');
  }
}

/* ── UPGRADE MENU ────────────────────────────────────────────────────────────*/
function openUpgrade() {
  refreshUpgradeMenu();
  document.getElementById('upgrade-menu').classList.add('show');
}
function closeUpgrade() {
  document.getElementById('upgrade-menu').classList.remove('show');
}
function refreshUpgradeMenu() {
  document.getElementById('gem-display').textContent = `💎 ${myGems} gems`;
  const cfg = [
    { id:'upg-speed',      type:'speed',      maxed: myUpgrades.speed >= 3 },
    { id:'upg-carry',      type:'carry',      maxed: myUpgrades.carry >= 3 },
    { id:'upg-blockPower', type:'blockPower', maxed: !!myUpgrades.blockPower },
    { id:'upg-weapon',     type:'weapon',     maxed: !!myUpgrades.weapon },
  ];
  for (const { id, type, maxed } of cfg) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = maxed || myGems < UPGRADE_COST[type];
    if (maxed) btn.querySelector('.upg-cost').textContent = '✓ Owned';
  }
}

/* ── ACTIONS ─────────────────────────────────────────────────────────────────*/
window.doPickup   = () => socket.emit('pickup');
window.doPlace    = () => socket.emit('place');
window.doAttack   = () => socket.emit('attack');
window.doGrabFlag = () => socket.emit('grab-flag');
window.buyUpgrade = (type) => socket.emit('buy-upgrade', { type });
window.openUpgrade = openUpgrade;
window.closeUpgrade = closeUpgrade;
window.setTeam    = (t) => socket.emit('set-team', { team: t });

/* ── INPUT ───────────────────────────────────────────────────────────────────*/
function setupInput() {
  document.addEventListener('keydown', e => {
    heldKeys.add(e.code);
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyF' || e.code === 'Space') doPickup();
    if (e.code === 'KeyQ') doPlace();
    if (e.code === 'KeyE') doAttack();
    if (e.code === 'KeyG') doGrabFlag();
    if (e.code === 'KeyU') {
      const um = document.getElementById('upgrade-menu');
      um.classList.contains('show') ? closeUpgrade() : openUpgrade();
    }
  });
  document.addEventListener('keyup', e => heldKeys.delete(e.code));
}

function setupJoystick() {
  if (typeof nipplejs === 'undefined' || !isMobile()) return;
  const zone = document.getElementById('joystick-zone');
  const j = nipplejs.create({ zone, mode: 'dynamic', color: 'rgba(255,255,255,0.3)' });
  j.on('move', (_, data) => {
    const angle = data.angle.radian;
    const force = Math.min(data.force, 1);
    moveInput = { dx: Math.cos(angle) * force, dz: -Math.sin(angle) * force };
  });
  j.on('end', () => { moveInput = { dx: 0, dz: 0 }; });
}

/* ── MAIN GAME LOOP ──────────────────────────────────────────────────────────*/
let lastT = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;

  // Animate scene objects
  for (const child of scene.children) {
    if (child.userData.cloudSpd) {
      child.position.x += child.userData.cloudSpd;
      if (child.position.x > 70) child.position.x = -70;
    }
  }
  if (centerFlagMesh) centerFlagMesh.rotation.y = Math.sin(now * 0.0012) * 0.4;
  if (flagLight) flagLight.intensity = 1.0 + Math.sin(now * 0.003) * 0.4;
  upgradeOrbs.forEach((orb, i) => {
    orb.position.y = GROUND_Y + 1.0 + Math.sin(now * 0.002 + i * 1.2) * 0.2;
    orb.rotation.y += 0.022;
  });
  for (const g of Object.values(pileGroups)) {
    if (g.userData.ring) {
      g.userData.ring.material.opacity = g.userData.count > 0
        ? 0.4 + Math.sin(now * 0.003) * 0.3
        : 0.05;
    }
  }

  tickLocalPlayer(dt);
  tickRemotes();
  tickCamera();
  tickNetwork(now);
  drawMinimap();

  renderer.render(scene, camera);
}

/* ── LAUNCH GAME ─────────────────────────────────────────────────────────────*/
function launchGame(state) {
  myId        = socket.id;
  const myP   = state.players[myId];
  myIsland    = myP?.islandIdx ?? 0;
  localPos    = myP ? [...myP.pos] : [...SPAWN_POS[myIsland]];
  localYaw    = myP?.yaw ?? Math.PI;
  myBlocks    = myP?.blocksHeld ?? 0;
  myMaxBlocks = myP?.maxBlocks ?? 3;
  myGems      = myP?.gems ?? 0;
  myUpgrades  = myP?.upgrades ?? { speed: 0, carry: 0, blockPower: false, weapon: false };

  showScreen('game');
  document.getElementById('room-code-hud').textContent = state.code;

  initScene();
  buildWorld(state);

  // Create local player mesh
  localMesh = makePlayerMesh(myIsland, true);
  localMesh.position.set(...localPos);
  scene.add(localMesh);

  // Create remote player meshes
  for (const [id, p] of Object.entries(state.players)) {
    if (id === myId) continue;
    const mesh = makePlayerMesh(p.islandIdx, false);
    mesh.position.set(...p.pos);
    mesh.rotation.y = p.yaw;
    scene.add(mesh);
    remotePlayers[id] = { mesh, targetPos: p.pos, targetYaw: p.yaw };
  }

  refreshHUD();
  setupInput();
  setupJoystick();
  lastT = performance.now();
  requestAnimationFrame(loop);
}

/* ── UTILITIES ───────────────────────────────────────────────────────────────*/
function isMobile() {
  return ('ontouchstart' in window) || window.innerWidth <= 820;
}
function escHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
let _toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.style.opacity = '0', 2800);
}
function copyCode() {
  const code = document.getElementById('lobby-code').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('Code copied! ' + code)).catch(() => {});
}
window.copyCode = copyCode;

/* ── BOOT ─────────────────────────────────────────────────────────────────────*/
window.addEventListener('DOMContentLoaded', () => {
  initSocket();
  showScreen('landing');

  document.getElementById('btn-create').addEventListener('click', () => {
    const name  = document.getElementById('input-name').value.trim() || 'Player';
    const teams = document.getElementById('select-teams').value;
    socket.emit('create-room', { name, teams });
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const name = document.getElementById('input-name').value.trim() || 'Player';
    const code = document.getElementById('input-code').value.trim().toUpperCase();
    if (code.length !== 6) return showToast('Enter a 6-character room code.');
    socket.emit('join-room', { name, code });
  });

  document.getElementById('input-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
  document.getElementById('input-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create').click();
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    socket.emit('start-game');
  });

  document.getElementById('btn-play-again').addEventListener('click', () => {
    socket.emit('play-again');
  });

  // Close upgrade menu on backdrop click
  document.getElementById('upgrade-menu').addEventListener('click', e => {
    if (e.target === document.getElementById('upgrade-menu')) closeUpgrade();
  });
});
