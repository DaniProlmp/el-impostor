# 🎭 El Impostor — Juego de palabras secretas multijugador

Hasta 10 jugadores en tiempo real con WebSockets.

---

## Cómo jugar

1. Alguien crea una sala y comparte el código de 4 letras
2. Todos se unen con ese código desde sus teléfonos/PCs
3. Cada jugador recibe la misma palabra secreta — **excepto el impostor**, que recibe una diferente
4. Por turno, cada quien dice una pista relacionada a su palabra (timer de 20 segundos)
5. Al final, todos votan quién creen que es el impostor
6. **Civiles +2 pts** si atrapan al impostor · **Impostor +3 pts** si escapa
7. 3 rondas en total

---

## Correr localmente

```bash
npm install
npm start
# Abre http://localhost:3000
```

Para desarrollo con recarga automática:
```bash
npm run dev
```

---

## Deploy en Railway (gratis, 1 clic)

1. Ve a [railway.app](https://railway.app) y crea una cuenta
2. Click **"New Project" → "Deploy from GitHub repo"**
3. Sube este proyecto a GitHub (o usa "Deploy from local" con la CLI)
4. Railway detecta automáticamente Node.js
5. En **Settings → Networking**, activa un dominio público
6. ¡Listo! Comparte el link con tus amigos

### Con Railway CLI (más rápido):
```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

---

## Deploy en Render (alternativa gratuita)

1. Ve a [render.com](https://render.com)
2. New → Web Service → conecta tu repo
3. Build command: `npm install`
4. Start command: `node server/index.js`
5. ¡Deploy!

---

## Estructura

```
el-impostor/
├── server/
│   └── index.js      # Servidor Node.js + Socket.io
├── public/
│   └── index.html    # Cliente completo (HTML/CSS/JS)
├── package.json
└── README.md
```

---

## Personalizar

- **Palabras**: edita el array `WORD_PAIRS` en `server/index.js`
- **Timer**: cambia `hintTimer: 20` (segundos) en la función `createRoom`
- **Rondas**: cambia `maxRounds: 3` en `createRoom`
- **Jugadores máx**: cambia el límite `10` en el evento `room:join`
