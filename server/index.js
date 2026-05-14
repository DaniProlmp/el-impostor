const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "../public")));

// ─── Word pairs [civilian, impostor] ─────────────────────────────────────────
const WORD_PAIRS = [
  ["Playa", "Piscina"], ["Pizza", "Hamburguesa"], ["Perro", "Gato"],
  ["Avión", "Helicóptero"], ["Hospital", "Clínica"], ["Rey", "Presidente"],
  ["Guitarra", "Violín"], ["Café", "Té"], ["Montaña", "Colina"],
  ["Submarino", "Barco"], ["Vampiro", "Zombi"], ["Espada", "Lanza"],
  ["Chocolate", "Caramelo"], ["Luna", "Sol"], ["Biblioteca", "Museo"],
  ["Tigre", "León"], ["Whiskey", "Ron"], ["Cine", "Teatro"],
  ["Invierno", "Otoño"], ["Béisbol", "Softball"], ["Sushi", "Tacos"],
  ["Castillo", "Fortaleza"], ["Dragón", "Fénix"], ["Piano", "Órgano"],
  ["Carro", "Moto"], ["Médico", "Enfermero"], ["Policía", "Soldado"],
  ["Circo", "Carnaval"], ["Fútbol", "Rugby"], ["Río", "Lago"],
];

// ─── Rooms state ──────────────────────────────────────────────────────────────
const rooms = {}; // code -> Room

function generateCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function createRoom(hostId, hostName) {
  let code;
  do { code = generateCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    host: hostId,
    players: [{ id: hostId, name: hostName, score: 0, connected: true }],
    phase: "lobby", // lobby | reveal | game | vote | results
    round: 0,
    maxRounds: 3,
    hintTimer: 20,
    wordPair: null,
    impostorId: null,
    currentPlayerIdx: 0,
    hints: [],
    votes: {},
    eliminated: null,
    impostorCaught: false,
    roundTimers: {},
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code] || null; }

function emitRoom(code) {
  const room = rooms[code];
  if (!room) return;
  // Send each player their own secret word
  room.players.forEach(p => {
    const word = room.wordPair
      ? (p.id === room.impostorId ? room.wordPair[1] : room.wordPair[0])
      : null;
    io.to(p.id).emit("room:update", { ...room, myWord: word });
  });
}

function startRound(code) {
  const room = rooms[code];
  if (!room) return;
  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  const alive = room.players.filter(p => p.connected);
  const impostorIdx = Math.floor(Math.random() * alive.length);
  room.wordPair = pair;
  room.impostorId = alive[impostorIdx].id;
  room.currentPlayerIdx = 0;
  room.hints = [];
  room.votes = {};
  room.eliminated = null;
  room.impostorCaught = false;
  room.phase = "reveal";
  room.round += 1;
  emitRoom(code);
}

function advanceTurn(code) {
  const room = rooms[code];
  if (!room) return;
  const alive = room.players.filter(p => p.connected);
  const allHinted = room.hints.length >= alive.length;
  if (allHinted) {
    room.phase = "vote";
    emitRoom(code);
    return;
  }
  // find next player who hasn't hinted
  const hintedIds = new Set(room.hints.map(h => h.playerId));
  let next = room.players.find(p => p.connected && !hintedIds.has(p.id));
  room.currentPlayerIdx = room.players.indexOf(next);

  // Start server-side timer for this player
  clearTimeout(room.roundTimers[next.id]);
  room.roundTimers[next.id] = setTimeout(() => {
    // Auto-skip if they haven't hinted
    const r = rooms[code];
    if (!r || r.phase !== "game") return;
    const alreadyHinted = r.hints.some(h => h.playerId === next.id);
    if (!alreadyHinted) {
      r.hints.push({ playerId: next.id, playerName: next.name, text: "…" });
      advanceTurn(code);
    }
  }, (room.hintTimer + 2) * 1000);

  emitRoom(code);
}

function tallyVotes(code) {
  const room = rooms[code];
  if (!room) return;
  const tally = {};
  Object.values(room.votes).forEach(v => { tally[v] = (tally[v] || 0) + 1; });
  const maxV = Math.max(...Object.values(tally));
  const suspects = Object.entries(tally).filter(([, c]) => c === maxV).map(([id]) => id);
  const eliminated = suspects[Math.floor(Math.random() * suspects.length)];
  const impostorCaught = eliminated === room.impostorId;

  room.players.forEach(p => {
    if (impostorCaught && p.id !== room.impostorId) p.score += 2;
    if (!impostorCaught && p.id === room.impostorId) p.score += 3;
  });

  room.eliminated = eliminated;
  room.impostorCaught = impostorCaught;
  room.phase = "results";
  emitRoom(code);
}

// ─── Socket events ─────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("room:create", ({ name }) => {
    if (!name?.trim()) return;
    const room = createRoom(socket.id, name.trim());
    currentRoom = room.code;
    socket.join(room.code);
    emitRoom(room.code);
    socket.emit("room:joined", { code: room.code });
  });

  socket.on("room:join", ({ code, name }) => {
    const room = getRoom(code?.toUpperCase());
    if (!room) return socket.emit("error", "Sala no encontrada");
    if (room.phase !== "lobby") return socket.emit("error", "La partida ya comenzó");
    if (room.players.length >= 10) return socket.emit("error", "Sala llena");
    if (!name?.trim()) return socket.emit("error", "Nombre requerido");

    // Reconnect if same name exists
    const existing = room.players.find(p => p.name === name.trim());
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
    } else {
      room.players.push({ id: socket.id, name: name.trim(), score: 0, connected: true });
    }
    currentRoom = room.code;
    socket.join(room.code);
    emitRoom(room.code);
    socket.emit("room:joined", { code: room.code });
  });

  socket.on("game:start", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) return socket.emit("error", "Mínimo 3 jugadores");
    startRound(currentRoom);
  });

  socket.on("game:ready", () => {
    // Player confirmed they've seen their word
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    if (!room.readyPlayers) room.readyPlayers = new Set();
    room.readyPlayers.add(socket.id);
    const alive = room.players.filter(p => p.connected);
    if (room.readyPlayers.size >= alive.length) {
      room.phase = "game";
      room.readyPlayers = new Set();
      advanceTurn(currentRoom);
    } else {
      emitRoom(currentRoom);
    }
  });

  socket.on("game:hint", ({ text }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.phase !== "game") return;
    const currentPlayer = room.players[room.currentPlayerIdx];
    if (currentPlayer?.id !== socket.id) return;
    const alreadyHinted = room.hints.some(h => h.playerId === socket.id);
    if (alreadyHinted) return;

    clearTimeout(room.roundTimers[socket.id]);
    room.hints.push({
      playerId: socket.id,
      playerName: currentPlayer.name,
      text: text?.trim() || "…",
    });
    advanceTurn(currentRoom);
  });

  socket.on("game:vote", ({ targetId }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.phase !== "vote") return;
    if (room.votes[socket.id]) return; // already voted
    room.votes[socket.id] = targetId;

    const alive = room.players.filter(p => p.connected);
    if (Object.keys(room.votes).length >= alive.length) {
      tallyVotes(currentRoom);
    } else {
      emitRoom(currentRoom);
    }
  });

  socket.on("game:nextRound", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.host !== socket.id) return;
    if (room.round >= room.maxRounds) {
      room.phase = "lobby";
      room.round = 0;
      room.players.forEach(p => p.score = 0);
      emitRoom(currentRoom);
    } else {
      startRound(currentRoom);
    }
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.connected = false;

    // Transfer host if needed
    if (room.host === socket.id) {
      const next = room.players.find(p => p.connected);
      if (next) room.host = next.id;
    }

    // Clean empty rooms
    if (!room.players.some(p => p.connected)) {
      delete rooms[currentRoom];
    } else {
      emitRoom(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎭 El Impostor corriendo en http://localhost:${PORT}`));
