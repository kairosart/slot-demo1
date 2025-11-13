// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// === DATABASE ===
const db = new sqlite3.Database("slots.db");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    balance INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    invoice TEXT,
    amount INTEGER,
    paid INTEGER DEFAULT 0
  )`);
});

// === LND CONFIG ===
const LND_REST_URL = process.env.LND_REST_URL;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const MACAROON_PATH = process.env.MACAROON_PATH;

if (!LND_REST_URL || !TLS_CERT_PATH || !MACAROON_PATH) {
  console.warn("⚠️ Missing LND credentials in .env. Deposits will fail.");
}

// Convert macaroon to HEX automatically
let MACAROON_HEX = null;
try {
  const macaroon = fs.readFileSync(MACAROON_PATH);
  MACAROON_HEX = macaroon.toString("hex");
  console.log("✅ Macaroon loaded and converted to HEX");
} catch (err) {
  console.error("❌ Error reading macaroon:", err.message);
}

let TLS_CERT = null;
try {
  TLS_CERT = fs.readFileSync(TLS_CERT_PATH);
  console.log("✅ TLS cert loaded");
} catch (err) {
  console.error("❌ Error reading TLS cert:", err.message);
}

// === ROUTES ===
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// === SOCKET.IO ===
io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  // --- LOGIN ---
  socket.on("login", (username) => {
    if (!username) return socket.emit("loginError", "Nombre inválido");

    db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
      if (err) return socket.emit("loginError", "DB error");
      if (!row) {
        db.run("INSERT INTO users (username, balance) VALUES (?, ?)", [username, 0]);
        console.log("Nuevo usuario:", username);
        socket.username = username;
        socket.emit("loginSuccess", { username, balance: 0 });
      } else {
        socket.username = username;
        socket.emit("loginSuccess", { username, balance: row.balance });
      }
    });
  });

  // --- REQUEST DEPOSIT ---
  socket.on("requestDeposit", async (amount) => {
    if (!socket.username) return socket.emit("depositError", "No logueado");
    if (!amount || amount <= 0) return socket.emit("depositError", "Cantidad inválida");

    try {
      console.log(`⚡ Creating invoice for ${socket.username}, amount: ${amount} sats`);

      const response = await fetch(`${LND_REST_URL}/v1/invoices`, {
        method: "POST",
        headers: {
          "Grpc-Metadata-macaroon": MACAROON_HEX,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          value: amount, // LND espera "value", no "amount"
          memo: `Depósito ${socket.username}`,
        }),
      });

      const data = await response.json();
      console.log("📡 LND response:", data);

      if (!data.payment_request) throw new Error("Error creando invoice");

      db.run(
        "INSERT INTO deposits (username, invoice, amount, paid) VALUES (?, ?, ?, 0)",
        [socket.username, data.payment_request, amount]
      );

      socket.emit("depositInvoice", data.payment_request);
    } catch (err) {
      console.error("Deposit error:", err);
      socket.emit("depositError", "Error creando factura");
    }
  });

  // --- SIMULATE PAYMENT CHECK ---
  socket.on("simulatePayment", (amount) => {
    if (!socket.username) return;
    db.run("UPDATE users SET balance = balance + ? WHERE username = ?", [amount, socket.username]);
    db.get("SELECT balance FROM users WHERE username = ?", [socket.username], (err, row) => {
      socket.emit("balanceUpdate", row.balance);
    });
  });

  // --- SPIN SLOT ---
  socket.on("spin", () => {
    if (!socket.username) return socket.emit("spinError", "No logueado");
    const bet = 10;

    db.get("SELECT balance FROM users WHERE username = ?", [socket.username], (err, row) => {
      if (err || !row) return socket.emit("spinError", "Usuario no encontrado");
      if (row.balance < bet) return socket.emit("spinError", "Saldo insuficiente");

      const reels = [
        ["🍒", "🍋", "🍊", "🍉", "⭐", "💎"],
        ["🍒", "🍋", "🍊", "🍉", "⭐", "💎"],
        ["🍒", "🍋", "🍊", "🍉", "⭐", "💎"],
      ];

      const result = reels.map((r) => r[Math.floor(Math.random() * r.length)]);
      let win = 0;
      if (result[0] === result[1] && result[1] === result[2]) {
        win = bet * 10;
      }

      const newBalance = row.balance - bet + win;
      db.run("UPDATE users SET balance = ? WHERE username = ?", [newBalance, socket.username]);
      socket.emit("spinResult", { result, win, balance: newBalance });
    });
  });
});

// === START SERVER ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
