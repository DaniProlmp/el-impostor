const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, "../public")));

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
  ["Helado", "Sorbete"], ["Cohete", "Misil"], ["Lobo", "Zorro"],
  ["Trompeta", "Saxofón"], ["Escuela", "Universidad"], ["Tren", "Metro"],
];

const rooms = {};

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function createRoom(hostId, hostName) {
  const code = generateCode();
  rooms[code] = {
    code, host: hostId,
    players: [{ id: hostId, name: hostName, score: 0, connected: true }],
    phase: "lobby", round: 0, maxRounds: 3, hintTimer: 20,
    wordPair: null, impostorId: null, currentPlayerIdx: 0,
    hints: [], votes: {}, eliminated: null, impostorCaught: false,
    readyPlayers: [],   // Always Array so it serializes via socket.io
    roundTimers: {},
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code] || null; }

function safeRoom(room) {
  return {
    code: room.code, host: room.host, players: room.players,
    phase: room.phase, round: room.round, maxRounds: room.maxRounds,
    hintTimer: room.hintTimer, wordPair: room.wordPair,
    impostorId: room.impostorId, currentPlayerIdx: room.currentPlayerIdx,
    hints: room.hints, votes: room.votes, eliminated: room.eliminated,
    impostorCaught: room.impostorCaught,
    readyPlayers: Array.isArray(room.readyPlayers) ? room.readyPlayers : [...(room.readyPlayers || [])],
  };
}

function emitRoom(code) {
  const room = rooms[code];
  if (!room) return;
  const base = safeRoom(room);
  room.players.forEach(p => {
    if (!p.connected) return;
    const word = room.wordPair
      ? (p.id === room.impostorId ? room.wordPair[1] : room.wordPair[0])
      : null;
    io.to(p.id).emit("room:update", { ...base, myWord: word });
  });
}

function clearRoomTimers(room) {
  Object.values(room.roundTimers).forEach(t => clearTimeout(t));
  room.roundTimers = {};
}

function startRound(code) {
  const room = rooms[code];
  if (!room) return;
  clearRoomTimers(room);
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
  room.readyPlayers = [];
  room.phase = "reveal";
  room.round += 1;
  emitRoom(code);
}

function advanceTurn(code) {
  const room = rooms[code];
  if (!room) return;
  const alive = room.players.filter(p => p.connected);
  const hintedIds = new Set(room.hints.map(h => h.playerId));
  const allHinted = alive.every(p => hintedIds.has(p.id));
  if (allHinted) {
    clearRoomTimers(room);
    room.phase = "vote";
    emitRoom(code);
    return;
  }
  const next = alive.find(p => !hintedIds.has(p.id));
  if (!next) return;
  room.currentPlayerIdx = room.players.indexOf(next);
  clearTimeout(room.roundTimers[next.id]);
  room.roundTimers[next.id] = setTimeout(() => {
    const r = rooms[code];
    if (!r || r.phase !== "game") return;
    const alreadyHinted = r.hints.some(h => h.playerId === next.id);
    if (!alreadyHinted) {
      r.hints.push({ playerId: next.id, playerName: next.name, text: "…" });
      advanceTurn(code);
    }
  }, (room.hintTimer + 3) * 1000);
  emitRoom(code);
}

function tallyVotes(code) {
  const room = rooms[code];
  if (!room) return;
  const tally = {};
  Object.values(room.votes).forEach(v => { tally[v] = (tally[v] || 0) + 1; });
  let eliminated = null;
  if (Object.keys(tally).length > 0) {
    const maxV = Math.max(...Object.values(tally));
    const suspects = Object.entries(tally).filter(([, c]) => c === maxV).map(([id]) => id);
    eliminated = suspects[Math.floor(Math.random() * suspects.length)];
  }
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

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("room:create", ({ name }) => {
    if (!name?.trim()) return socket.emit("error", "Escribe tu nombre");
    const room = createRoom(socket.id, name.trim());
    currentRoom = room.code;
    socket.join(room.code);
    emitRoom(room.code);
    socket.emit("room:joined", { code: room.code });
  });

  socket.on("room:join", ({ code, name }) => {
    const room = getRoom(code?.toUpperCase());
    if (!room) return socket.emit("error", "Sala no encontrada");
    if (!name?.trim()) return socket.emit("error", "Nombre requerido");
    const trimmedName = name.trim();
    const existing = room.players.find(p => p.name === trimmedName);
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
    } else {
      if (room.phase !== "lobby") return socket.emit("error", "La partida ya comenzó");
      if (room.players.length >= 10) return socket.emit("error", "Sala llena");
      room.players.push({ id: socket.id, name: trimmedName, score: 0, connected: true });
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
    const alive = room.players.filter(p => p.connected);
    if (alive.length < 3) return socket.emit("error", "Mínimo 3 jugadores");
    startRound(currentRoom);
  });

  // KEY FIX: readyPlayers was a Set (doesn't serialize over socket.io), now always Array
  socket.on("game:ready", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.phase !== "reveal") return;
    if (!Array.isArray(room.readyPlayers)) room.readyPlayers = [];
    if (room.readyPlayers.includes(socket.id)) return; // already ready
    room.readyPlayers.push(socket.id);
    const alive = room.players.filter(p => p.connected);
    if (room.readyPlayers.length >= alive.length) {
      room.phase = "game";
      room.readyPlayers = [];
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
    const hintText = text?.trim();
    if (!hintText) return socket.emit("error", "Escribe una pista");
    clearTimeout(room.roundTimers[socket.id]);
    room.hints.push({ playerId: socket.id, playerName: currentPlayer.name, text: hintText });
    advanceTurn(currentRoom);
  });

  socket.on("game:vote", ({ targetId }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.phase !== "vote") return;
    if (room.votes[socket.id]) return;
    const target = room.players.find(p => p.id === targetId);
    if (!target) return socket.emit("error", "Jugador inválido");
    room.votes[socket.id] = targetId;
    const alive = room.players.filter(p => p.connected);
    const allVoted = alive.every(p => room.votes[p.id]);
    if (allVoted) {
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
      clearRoomTimers(room);
      room.phase = "lobby";
      room.round = 0;
      room.wordPair = null;
      room.impostorId = null;
      room.hints = [];
      room.votes = {};
      room.readyPlayers = [];
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

    // Remove from readyPlayers
    if (Array.isArray(room.readyPlayers)) {
      room.readyPlayers = room.readyPlayers.filter(id => id !== socket.id);
    }

    // Transfer host
    if (room.host === socket.id) {
      const next = room.players.find(p => p.connected);
      if (next) {
        room.host = next.id;
        io.to(next.id).emit("notice", "Ahora eres el host 👑");
      }
    }

    const alive = room.players.filter(p => p.connected);

    if (alive.length === 0) {
      clearRoomTimers(room);
      delete rooms[currentRoom];
      return;
    }

    // If it was their turn during game, auto-skip
    if (room.phase === "game") {
      const currentPlayer = room.players[room.currentPlayerIdx];
      if (currentPlayer?.id === socket.id) {
        const alreadyHinted = room.hints.some(h => h.playerId === socket.id);
        if (!alreadyHinted) {
          room.hints.push({ playerId: socket.id, playerName: player?.name || "?", text: "…" });
          advanceTurn(currentRoom);
          return;
        }
      }
    }

    // If during vote and everyone remaining voted, tally
    if (room.phase === "vote") {
      const allVoted = alive.every(p => room.votes[p.id]);
      if (allVoted) { tallyVotes(currentRoom); return; }
    }

    // If during reveal and everyone remaining is ready, advance
    if (room.phase === "reveal") {
      const allReady = alive.every(p => room.readyPlayers.includes(p.id));
      if (allReady) {
        room.phase = "game";
        room.readyPlayers = [];
        advanceTurn(currentRoom);
        return;
      }
    }

    emitRoom(currentRoom);
  });
});

app.get("/health", (_, res) => res.json({ status: "ok", rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎭 El Impostor corriendo en http://localhost:${PORT}`));
