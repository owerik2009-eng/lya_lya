require('dotenv').config();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===== База данных SQLite =====
const db = new Database('database.sqlite');
db.pragma('journal_mode = WAL');

// Создаём все таблицы сразу
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 0,
    status TEXT DEFAULT 'Новичок',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT,
    price INTEGER DEFAULT 0,
    name TEXT,
    phone TEXT,
    child TEXT,
    date TEXT,
    time TEXT,
    kids INTEGER DEFAULT 1,
    comment TEXT,
    status TEXT DEFAULT 'new',
    paid INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bonus_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    type TEXT,
    amount INTEGER,
    description TEXT,
    admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cash_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT,
    client_phone TEXT,
    amount INTEGER,
    service TEXT,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
console.log('✅ База данных готова');

// ===== Telegram бот =====
let bot = null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DISABLE_BOT = process.env.DISABLE_BOT === 'true';

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.length > 10 && !DISABLE_BOT) {
  try {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    console.log('✅ Telegram-бот подключён');

    bot.onText(/\/start|\/help/, (msg) => {
      const allowed = [CHAT_ID, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
      if (!allowed.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, '⛔ Нет доступа');
      bot.sendMessage(msg.chat.id, '🎀 *Ляля — бот администратора*\nКоманды: /stats, /today, /clients', { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, (msg) => {
      const allowed = [CHAT_ID, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
      if (!allowed.includes(String(msg.chat.id))) return;
      const today = new Date().toISOString().split('T')[0];
      const todayCount = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date = ?').get(today).c;
      const revenue = db.prepare('SELECT COALESCE(SUM(price),0) as s FROM bookings').get().s;
      const usersCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
      bot.sendMessage(msg.chat.id, `📊 *Статистика*\nЗаписей сегодня: *${todayCount}*\nВыручка: *${revenue} ₽*\nКлиентов: *${usersCount}*`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/today/, (msg) => {
      const allowed = [CHAT_ID, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
      if (!allowed.includes(String(msg.chat.id))) return;
      const today = new Date().toISOString().split('T')[0];
      const rows = db.prepare('SELECT * FROM bookings WHERE date = ? ORDER BY time').all(today);
      if (rows.length === 0) return bot.sendMessage(msg.chat.id, 'На сегодня записей нет');
      const text = rows.map(r => `🕐 *${r.time}* — ${r.name}\n👶 ${r.child} · ${r.price} ₽`).join('\n\n');
      bot.sendMessage(msg.chat.id, `📅 *Записи на сегодня:*\n\n${text}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/clients/, (msg) => {
      const allowed = [CHAT_ID, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
      if (!allowed.includes(String(msg.chat.id))) return;
      const rows = db.prepare('SELECT * FROM users ORDER BY balance DESC LIMIT 10').all();
      const text = rows.map((r, i) => `${i + 1}. \`${r.phone}\` — ${r.balance} 🎁`).join('\n');
      bot.sendMessage(msg.chat.id, `🏆 *Топ клиентов:*\n\n${text}`, { parse_mode: 'Markdown' });
    });
  } catch (err) { console.error('❌ Ошибка Telegram-бота:', err.message); }
} else { console.log('⚠️ Telegram-бот не настроен'); }

function notifyNewBooking(booking) {
  if (!bot) return;
  const text = `🆕 *Новая запись!*\n👤 *${booking.name}*\n📞 \`${booking.phone}\`\n👶 ${booking.child}\n📅 ${booking.date} в ${booking.time}\n🎀 ${booking.service || '—'} · ${booking.price} ₽`;
  const allowed = [CHAT_ID, process.env.TELEGRAM_CHAT_ID_2].filter(Boolean);
  allowed.forEach(id => bot.sendMessage(id, text, { parse_mode: 'Markdown' }).catch(() => {}));
}

// ===== API: Админ =====
app.post('/api/admin/login', (req, res) => {
  if (req.body.login === (process.env.ADMIN_LOGIN || 'admin') && req.body.password === (process.env.ADMIN_PASS || 'admin123')) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  }
});

// ===== API: Записи =====
app.get('/api/bookings', (req, res) => res.json(db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all()));

app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const stmt = db.prepare(`INSERT INTO bookings (service, price, name, phone, child, date, time, kids, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(b.service, b.price || 0, b.name, b.phone, b.child, b.date, b.time, b.kids || 1, b.comment || '');
  const booking = { id: result.lastInsertRowid, ...b };
  if (b.price > 0) {
    const exists = db.prepare('SELECT 1 FROM users WHERE phone = ?').get(b.phone);
    if (!exists) {
      db.prepare('INSERT INTO users (phone, balance) VALUES (?, 100)').run(b.phone);
      db.prepare('INSERT INTO bonus_history (phone, type, amount, description) VALUES (?, ?, ?, ?)').run(b.phone, 'plus', 100, 'Бонус за регистрацию');
    }
    const bonus = Math.floor(b.price * 0.1);
    const user = db.prepare('SELECT balance FROM users WHERE phone = ?').get(b.phone);
    db.prepare('UPDATE users SET balance = ? WHERE phone = ?').run(user.balance + bonus, b.phone);
    db.prepare('INSERT INTO bonus_history (phone, type, amount, description) VALUES (?, ?, ?, ?)').run(b.phone, 'plus', bonus, `Начислено за ${b.service}`);
    booking.bonusEarned = bonus;
  }
  notifyNewBooking(booking);
  res.json({ success: true, booking });
});

app.patch('/api/bookings/:id/status', (req, res) => {
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ success: true });
});

app.patch('/api/bookings/:id/pay', (req, res) => {
  db.prepare('UPDATE bookings SET paid = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== API: Пользователи и бонусы =====
app.post('/api/users/login', (req, res) => {
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(req.body.phone);
  let isNew = false;
  if (!user) {
    db.prepare('INSERT INTO users (phone, balance) VALUES (?, 100)').run(req.body.phone);
    db.prepare('INSERT INTO bonus_history (phone, type, amount, description) VALUES (?, ?, ?, ?)').run(req.body.phone, 'plus', 100, 'Регистрация');
    user = db.prepare('SELECT * FROM users WHERE phone = ?').get(req.body.phone);
    isNew = true;
  }
  const history = db.prepare('SELECT * FROM bonus_history WHERE phone = ? ORDER BY created_at DESC').all(req.body.phone);
  res.json({ user, history, isNew });
});

app.get('/api/users', (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY created_at DESC').all()));

app.post('/api/bonus', (req, res) => {
  const { phone, amount, type, reason } = req.body;
  const user = db.prepare('SELECT balance FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const finalAmount = type === 'minus' ? -Math.abs(amount) : Math.abs(amount);
  db.prepare('UPDATE users SET balance = ? WHERE phone = ?').run(user.balance + finalAmount, phone);
  db.prepare('INSERT INTO bonus_history (phone, type, amount, description, admin) VALUES (?, ?, ?, ?, 1)').run(phone, type, Math.abs(amount), reason || 'Ручная операция');
  res.json({ success: true });
});

app.get('/api/bonus/log', (req, res) => res.json(db.prepare('SELECT * FROM bonus_history WHERE admin = 1 ORDER BY created_at DESC LIMIT 50').all()));
// ===== API: Оплата (Наличные / Терминал / Новый клиент) =====

// 1. Оплата существующей записи
app.post('/api/cash-payments', (req, res) => {
  try {
    const { client_name, client_phone, amount, service, comment, booking_id, payment_method } = req.body;
    if (!client_name || !amount) return res.status(400).json({ error: 'Укажите имя и сумму' });

    db.prepare(`INSERT INTO cash_payments (client_name, client_phone, amount, service, comment, booking_id, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      client_name, client_phone || '', amount, service || '', comment || '', booking_id || null, payment_method || 'cash'
    );

    if (booking_id) {
      const newStatus = payment_method === 'card' ? 'confirmed' : 'done';
      db.prepare('UPDATE bookings SET paid = 1, status = ? WHERE id = ?').run(newStatus, booking_id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Ошибка оплаты:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. НОВЫЙ КЛИЕНТ: Оплата + Мгновенный старт сеанса
app.post('/api/start-walkin-session', (req, res) => {
  try {
    const { client_name, child_name, client_phone, service, amount, kids, comment, payment_method } = req.body;
    if (!client_name || !child_name || !amount) return res.status(400).json({ error: 'Заполните имя родителя, ребенка и сумму' });

    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 5);

    const bookingStmt = db.prepare(`
      INSERT INTO bookings (service, price, name, phone, child, date, time, kids, comment, status, paid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1)
    `);
    const result = bookingStmt.run(service, amount, client_name, client_phone || '', child_name, today, timeStr, kids || 1, comment || '');
    const bookingId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO cash_payments (client_name, client_phone, amount, service, comment, booking_id, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(client_name, client_phone || '', amount, service || '', comment || '', bookingId, payment_method || 'cash');

    // Начисление бонусов
    if (amount > 0 && client_phone) {
      const exists = db.prepare('SELECT 1 FROM users WHERE phone = ?').get(client_phone);
      if (!exists) {
        db.prepare('INSERT INTO users (phone, balance) VALUES (?, 100)').run(client_phone);
        db.prepare('INSERT INTO bonus_history (phone, type, amount, description) VALUES (?, ?, ?, ?)').run(client_phone, 'plus', 100, 'Регистрация');
      }
      const bonus = Math.floor(amount * 0.1);
      const user = db.prepare('SELECT balance FROM users WHERE phone = ?').get(client_phone);
      if (user) {
        db.prepare('UPDATE users SET balance = ? WHERE phone = ?').run(user.balance + bonus, client_phone);
        db.prepare('INSERT INTO bonus_history (phone, type, amount, description) VALUES (?, ?, ?, ?)').run(client_phone, 'plus', bonus, `Оплата сеанса #${bookingId}`);
      }
    }
    res.json({ success: true, bookingId });
  } catch (err) {
    console.error('❌ Ошибка старта сеанса:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Итог дня
app.get('/api/today-income', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const onlineRow = db.prepare(`SELECT COALESCE(SUM(price), 0) as total FROM bookings WHERE date = ? AND paid = 1`).get(today);
    const cashRow = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM cash_payments WHERE DATE(created_at) = ?`).get(today);
    const cashPayments = db.prepare(`SELECT * FROM cash_payments WHERE DATE(created_at) = ? ORDER BY created_at DESC`).all(today);
    
    res.json({
      onlineIncome: onlineRow ? onlineRow.total : 0,
      cashTerminalIncome: cashRow ? cashRow.total : 0,
      totalIncome: (onlineRow ? onlineRow.total : 0) + (cashRow ? cashRow.total : 0),
      cashPayments: cashPayments || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cash-payments/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM cash_payments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
  {
  try {
    db.prepare('DELETE FROM cash_payments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Ошибка удаления:', err);
    res.status(500).json({ error: err.message });
  }
};

// ===== API: Статистика =====
app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({
    todayCount: db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date = ?').get(today).c,
    revenue: db.prepare('SELECT COALESCE(SUM(price),0) as s FROM bookings').get().s,
    usersCount: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalBonus: db.prepare('SELECT COALESCE(SUM(balance),0) as s FROM users').get().s
  });
});

// ===== API: Онлайн-оплата через ЮKassa =====

// Создание платежа
app.post('/api/create-payment', async (req, res) => {
  try {
    const { bookingId, amount, description } = req.body;
    
    if (!bookingId || !amount) {
      return res.status(400).json({ error: 'Укажите bookingId и amount' });
    }

    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    
    if (!shopId || !secretKey) {
      console.error('❌ ЮKassa не настроена! Проверьте .env');
      return res.status(500).json({ error: 'Платёжная система не настроена' });
    }

    const paymentId = uuidv4();
    const returnUrl = `http://localhost:${process.env.PORT || 3000}/payment-success.html?bookingId=${bookingId}&paymentId=${paymentId}`;

    // Создаём платёж в ЮKassa
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': paymentId,
        'Authorization': 'Basic ' + Buffer.from(shopId + ':' + secretKey).toString('base64')
      },
      body: JSON.stringify({
        amount: {
          value: amount.toString(),
          currency: 'RUB'
        },
        confirmation: {
          type: 'redirect',
          return_url: returnUrl
        },
        capture: true,
        description: description || `Оплата записи #${bookingId}`,
        metadata: {
          booking_id: bookingId,
          payment_id: paymentId
        }
      })
    });

    const paymentData = await response.json();

    if (response.ok && paymentData.confirmation && paymentData.confirmation.confirmation_url) {
      // Сохраняем payment_id в базе
      db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run('pending_payment', bookingId);
      
      res.json({ 
        success: true, 
        confirmation_url: paymentData.confirmation.confirmation_url,
        payment_id: paymentId
      });
    } else {
      console.error('❌ Ошибка создания платежа:', paymentData);
      res.status(500).json({ error: paymentData.description || 'Ошибка создания платежа' });
    }
  } catch (err) {
    console.error('❌ Ошибка платежа:', err);
    res.status(500).json({ error: err.message });
  }
});

// Проверка статуса платежа
app.get('/api/payment-status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;

    const response = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(shopId + ':' + secretKey).toString('base64')
      }
    });

    const paymentData = await response.json();

    if (paymentData.status === 'succeeded') {
      const bookingId = paymentData.metadata?.booking_id;
      if (bookingId) {
        db.prepare('UPDATE bookings SET status = ?, paid = ? WHERE id = ?').run('confirmed', 1, bookingId);
        
        // Начисляем бонусы
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (booking && booking.price > 0) {
          const bonus = Math.floor(booking.price * 0.1);
          const user = db.prepare('SELECT balance FROM users WHERE phone = ?').get(booking.phone);
          if (user) {
            db.prepare('UPDATE users SET balance = ? WHERE phone = ?').run(user.balance + bonus, booking.phone);
            db.prepare('INSERT INTO bonus_history (phone, type, amount, description) VALUES (?, ?, ?, ?)').run(
              booking.phone, 'plus', bonus, `Бонус за онлайн-оплату записи #${bookingId}`
            );
          }
        }
      }
      res.json({ success: true, status: 'paid', booking_id: bookingId });
    } else {
      res.json({ success: false, status: paymentData.status });
    }
  } catch (err) {
    console.error('❌ Ошибка проверки платежа:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Запуск =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎀 «Ляля» запущена: http://localhost:${PORT}`);
  console.log(`📱 Клиенты: http://localhost:${PORT}/index.html`);
  console.log(`🔐 Админ: http://localhost:${PORT}/admin.html\n`);
});