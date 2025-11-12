// server.js (ESM)
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// load env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LNBITS_URL = process.env.LNBITS_URL || "https://demo.lnbits.com";
const LNBITS_ADMIN_KEY = process.env.LNBITS_ADMIN_KEY || "8fb982a7fbda42b085436dd8617b3b5f";

if (!LNBITS_URL || !LNBITS_ADMIN_KEY) {
  console.warn("⚠️  Warning: LNBITS_URL or LNBITS_ADMIN_KEY not set in environment. Deposit will fail until set.");
}

// fetch compat (Node 18+ tiene fetch global)
let fetchLib = globalThis.fetch;
if (!fetchLib) {
  const mod = await import("node-fetch");
  fetchLib = mod.default;
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

// ✅ sirve archivos estáticos desde /public
app.use(express.static(path.join(__dirname, "public")));

// ---------- DB init ----------
const db = await open({
  filename: path.join(__dirname, "slot.db"),
  driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  balance INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  nonce INTEGER,
  lines TEXT,
  prize INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  payment_hash TEXT UNIQUE,
  payment_request TEXT,
  paid INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------- Helpers ----------
const SYMBOLS = ["🍒", "🍋", "🍉", "🔔", "💎", "7️⃣", "⭐"];
const PAY = {
  "⭐,⭐,⭐": 360,
  "7️⃣,7️⃣,7️⃣": 156,
  "💎,💎,💎": 84,
  "🔔,🔔,🔔": 21,
  "🍉,🍉,🍉": 8,
  "🍋,🍋,🍋": 2,
  "🍒,🍒,🍒": 3,
};

function randomSpin() {
  const cols = [];
  for (let c = 0; c < 3; c++) {
    const col = [];
    for (let r = 0; r < 3; r++) {
      col.push(SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
    }
    cols.push(col);
  }
  const lines = [
    [cols[0][1], cols[1][1], cols[2][1]],
    [cols[0][0], cols[1][1], cols[2][2]],
    [cols[0][2], cols[1][1], cols[2][0]],
  ];
  let prizeCredits = 0;
  const winners = [];
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].join(",");
    const p = PAY[key] || 0;
    if (p > 0) winners.push({ lineIndex: i + 1, triple: key, prizeCredits: p });
    prizeCredits += p;
  }
  return { columns: cols, lines, winners, prizeCredits };
}

// ---------- REST: login / invoice / check ----------
app.post("/api/login", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || typeof username !== "string" || username.trim().length === 0)
      return res.status(400).json({ error: "username inválido" });

    const clean = username.trim();
    let user = await db.get("SELECT * FROM users WHERE username = ?", clean);
    if (!user) {
      const info = await db.run("INSERT INTO users (username, balance) VALUES (?, 0)", clean);
      user = await db.get("SELECT * FROM users WHERE id = ?", info.lastID);
    }

    res.json({ id: user.id, username: user.username, balance: user.balance });
  } catch (e) {
    console.error("login error", e);
    res.status(500).json({ error: "error interno" });
  }
});

// ---------- LNbits: create invoice ----------
app.post("/api/create_invoice", async (req, res) => {
  try {
    const { userId, sats } = req.body;
    const u = Number(userId);
    const s = Number(sats);
    if (!u || isNaN(s) || s <= 0) {
      return res.status(400).json({ error: "userId o sats inválidos (sats>0)" });
    }

    const payload = {
      out: false,
      amount: Math.floor(s),
      memo: `Depósito Slot: ${s} sats (user ${u})`,
    };

    const resp = await fetchLib(`${LNBITS_URL.replace(/\/$/, "")}/api/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": LNBITS_ADMIN_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok || !data?.payment_request || !data?.payment_hash) {
      console.error("LNbits create invoice failed:", resp.status, data);
      return res.status(500).json({ error: "Error creando invoice LNbits", details: data });
    }

    await db.run(
      "INSERT OR IGNORE INTO invoices (user_id, amount, payment_hash, payment_request, paid) VALUES (?, ?, ?, ?, 0)",
      u,
      s,
      data.payment_hash,
      data.payment_request
    );

    res.json({ invoice: data.payment_request, payment_hash: data.payment_hash });
  } catch (err) {
    console.error("/api/create_invoice error:", err);
    res.status(500).json({ error: "error interno" });
  }
});

// ---------- LNbits: check payment ----------
app.post("/api/check_payment", async (req, res) => {
  try {
    const { userId, payment_hash } = req.body;
    const u = Number(userId);
    if (!u || !payment_hash) return res.status(400).json({ error: "userId o payment_hash inválidos" });

    const resp = await fetchLib(`${LNBITS_URL.replace(/\/$/, "")}/api/v1/payments/${encodeURIComponent(payment_hash)}`, {
      headers: { "X-Api-Key": LNBITS_ADMIN_KEY },
    });
    const data = await resp.json();

    if (!resp.ok) {
      console.error("LNbits check payment failed:", resp.status, data);
      return res.status(500).json({ error: "Error consultando LNbits", details: data });
    }

    if (data.paid) {
      const paidAmount = Number(data.amount ?? data.details?.amount ?? 0);
      const paidSats = paidAmount > 1000000 ? Math.floor(paidAmount / 1000) : paidAmount;

      const inv = await db.get("SELECT * FROM invoices WHERE payment_hash = ?", payment_hash);
      if (!inv) {
        await db.run(
          "INSERT INTO invoices (user_id, amount, payment_hash, payment_request, paid) VALUES (?, ?, ?, ?, 1)",
          u,
          paidSats,
          payment_hash,
          ""
        );
      } else if (!inv.paid) {
        await db.run("UPDATE invoices SET paid = 1 WHERE payment_hash = ?", payment_hash);
      }

      const user = await db.get("SELECT * FROM users WHERE id = ?", u);
      const newBalance = (user.balance || 0) + paidSats;
      await db.run("UPDATE users SET balance = ? WHERE id = ?", newBalance, u);

      return res.json({ success: true, balance: newBalance, paidSats });
    }

    res.json({ success: false, details: data });
  } catch (err) {
    console.error("/api/check_payment error:", err);
    res.status(500).json({ error: "error interno" });
  }
});

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("login", async ({ username }) => {
    try {
      if (!username || typeof username !== "string")
        return socket.emit("login-error", "username inválido");
      const clean = username.trim();
      let user = await db.get("SELECT * FROM users WHERE username = ?", clean);
      if (!user) {
        const r = await db.run("INSERT INTO users(username) VALUES (?)", clean);
        user = await db.get("SELECT * FROM users WHERE id = ?", r.lastID);
      }
      socket.data.userId = user.id;
      socket.emit("login-success", { id: user.id, username: user.username, balance: user.balance });
    } catch (e) {
      console.error("socket login error", e);
      socket.emit("login-error", "error interno");
    }
  });

  socket.on("spin", async ({ betCredits, satsPerCredit }) => {
    try {
      const userId = socket.data.userId;
      if (!userId) return socket.emit("error", "No logueado");
      const user = await db.get("SELECT * FROM users WHERE id = ?", userId);
      if (!user) return socket.emit("error", "Usuario no encontrado");
      const betCreditsN = Number(betCredits);
      const satsPerCreditN = Number(satsPerCredit);
      if (!betCreditsN || !satsPerCreditN) return socket.emit("error", "Parámetros inválidos");
      const cost = betCreditsN * satsPerCreditN;
      if ((user.balance || 0) < cost) return socket.emit("error", "Saldo insuficiente");

      const afterBet = user.balance - cost;
      await db.run("UPDATE users SET balance = ? WHERE id = ?", afterBet, userId);

      const spinRes = randomSpin();
      const prizeSats = (spinRes.prizeCredits || 0) * satsPerCreditN;
      const finalBalance = afterBet + prizeSats;

      await db.run(
        "INSERT INTO spins (user_id, nonce, lines, prize) VALUES (?, ?, ?, ?)",
        userId,
        Date.now(),
        JSON.stringify(spinRes.lines),
        prizeSats
      );

      await db.run("UPDATE users SET balance = ? WHERE id = ?", finalBalance, userId);

      socket.emit("spin-result", {
        columns: spinRes.columns,
        winners: spinRes.winners,
        prize: prizeSats,
        balance: finalBalance,
      });
    } catch (err) {
      console.error("spin error", err);
      socket.emit("error", "Error al girar");
    }
  });
});

// ✅ sirve index.html para cualquier ruta desconocida
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`✅ Servidor listo en http://localhost:${PORT}`));
