// ============================================================
//  bot.js — MoonTrade: бот + раздача мини-аппа (index.html) с одного сервиса
//  Без зависимостей (только встроенные модули, Node 18+).
//  Render ENV: BOT_TOKEN (обязательно). RENDER_EXTERNAL_URL Render ставит сам.
//  Необязательно: WEBHOOK_SECRET, WEBAPP_URL (по умолчанию = адрес сервиса)
// ============================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }
const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }
const WEBAPP_URL = process.env.WEBAPP_URL || EXTERNAL_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex');
const APP_NAME = 'MoonTrade';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, body) {
    const r = await fetch(`${API}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
}

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

// ====== /start ======
const openKeyboard = {
    inline_keyboard: [[{ text: `Открыть ${APP_NAME}`, web_app: { url: WEBAPP_URL }, style: 'success' }]],
};

async function onUpdate(u) {
    // Оплата Stars: Telegram спрашивает «можно ли списать» — отвечаем да (быстро, до 10 сек)
    if (u.pre_checkout_query) {
        await tg('answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
        return;
    }
    const m = u.message;
    if (m && m.successful_payment) return onPaid(m);
    if (!m || !m.text || m.chat.type !== 'private') return;
    if (m.text.startsWith('/start') || m.text.startsWith('/play')) {
        const name = (m.from.first_name || 'трейдер').replace(/[<>&]/g, '');
        await tg('sendMessage', {
            chat_id: m.chat.id, parse_mode: 'HTML', reply_markup: openKeyboard,
            text: `<b>Добро пожаловать в ${APP_NAME}, ${name}!</b>\n\n` +
                `Торгуй мем-коином $MOON на бирже MoonDEX 2031 года. Старт — $100, цель — стать крипто-китом.\n\n` +
                `Только важное: напишу, если случится крупный памп, крах или ты возьмёшь новый уровень (редко, без спама).`,
        });
    }
}

// ====== ДОНАТ ЗВЁЗДАМИ (Telegram Stars, валюта XTR) ======
const USD_PER_STAR = 1000;
async function onPaid(m) {
    const sp = m.successful_payment, id = String(m.from.id);
    if (sp.currency !== 'XTR' || !String(sp.invoice_payload || '').startsWith(`don:${id}:`)) return;
    const charge = sp.telegram_payment_charge_id;
    if (M.seen.includes(charge)) return; // повторная доставка того же платежа
    M.seen.push(charge); if (M.seen.length > 500) M.seen.shift();
    const stars = Math.floor(sp.total_amount), usd = stars * USD_PER_STAR;
    // донат = крупная покупка $MOON: двигает курс вверх (в DON_BOOST раз сильнее обычной сделки)
    const before = M.price, im = Math.min(8, usd / M.price / 1e5 * 25 * DON_BOOST);
    applyPct(im);
    M.paid[id] = (M.paid[id] || 0) + stars;
    saveMarket();
    await tg('sendMessage', {
        chat_id: m.chat.id, reply_markup: openKeyboard,
        text: `✅ Вы успешно задонатили ${stars}⭐\nНа баланс: +$${usd.toLocaleString('en-US')}\nКурс $MOON: +${im.toFixed(2)}% (${before.toFixed(3)} → ${M.price.toFixed(3)})`,
    }).catch((e) => console.warn('paid msg:', e.message));
}

// ====== ВАЖНЫЕ УВЕДОМЛЕНИЯ (из мини-аппа, с проверкой подписи Telegram) ======
function validInitData(initData) {
    try {
        const p = new URLSearchParams(initData);
        const hash = p.get('hash'); p.delete('hash');
        if (!hash) return null;
        const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
        if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
        if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
        return JSON.parse(p.get('user'));
    } catch { return null; }
}

// Анти-спам: не чаще 1 сообщения в 30 минут и не более 3 в сутки на человека
const notifyLog = new Map(); // userId -> { last, day, count }
function allowNotify(id) {
    id = String(id);
    const now = Date.now(), day = new Date().toISOString().slice(0, 10);
    const s = notifyLog.get(id) || { last: 0, day, count: 0 };
    if (s.day !== day) { s.day = day; s.count = 0; }
    if (now - s.last < 30 * 60 * 1000 || s.count >= 3) return false;
    s.last = now; s.count++; notifyLog.set(id, s);
    return true;
}

const NOTES = {
    pump: (v) => `🚀 $MOON взлетел на +${v}%! Самое время проверить позицию.`,
    crash: (v) => `🔻 Крах: $MOON упал на ${v}%! У тебя есть монеты — загляни в ${APP_NAME}.`,
    level: (v) => `🏆 Новый уровень: ${v}! Ты растёшь как трейдер.`,
};

async function handleNotify(body) {
    const user = validInitData(body.initData);
    if (!user || !NOTES[body.type]) return false;
    const v = Math.abs(Math.round(Number(body.value) || 0));
    if (body.type === 'level' && (v % 10 !== 0 || v < 10)) return false; // только круглые уровни
    if ((body.type === 'pump' || body.type === 'crash') && v < 30) return false; // только критичное
    if (!allowNotify(user.id)) return false;
    await tg('sendMessage', {
        chat_id: user.id, text: NOTES[body.type](v), reply_markup: openKeyboard,
    }).catch((e) => console.warn('notify:', e.message)); // если юзер не нажал /start — тихо игнорим
    return true;
}

// ====== РЫНОК: живёт на сервере 24/7, цена меняется даже когда никто не играет ======
const STATE_FILE = path.join(__dirname, 'market.json');
const TICK_MS = 2000; // цена обновляется каждые 2 секунды
const SC = 0.0003;   // дрейф тренда за тик (2 сек): тренды длятся 10-40 мин и тянут цену на доли процента
const NOISE = 0.03;  // случайный шаг базовой цены за тик, % (симметричный: вверх и вниз поровну)
const JIT = 0.08;    // «дрожание» цены каждые 2 сек: ± доли процента вокруг базовой цены, в сумме ровно 0
const REV = 0.0003;   // очень слабое притяжение к $10, чтобы цена не улетала навсегда
const EV_SC = 0.05;  // размер новостей: Binance ≈ +2%, Rug pull ≈ -2%
const CRIT = 1.8;      // |%| события, с которого шлём уведомление держателям монет
const REGIME_P = 0.00015; // шанс при смене тренда на редкое ралли/обвал на 1-3 дня (≈6% в неделю, поровну вверх и вниз)
const TR = [['MOONSHOT', 2, 5, 5], ['STRONG_UP', 1, 2.5, 10], ['UP', .3, 1, 20], ['FLAT', -.2, .2, 25], ['DOWN', -1, -.3, 20], ['STRONG_DOWN', -2.5, -1, 10], ['CRASH', -5, -2, 5], ['CHAOS', -4, 4, 5]];
const VO = [['SLEEPY', .5, 15], ['NORMAL', 1, 45], ['EXCITED', 1.5, 20], ['HYPE', 2.5, 10], ['PANIC', 2, 10]];
const EVP = [['rocket', 'Илон Маск твитнул о $MOON', 25], ['bank', 'Binance листит $MOON', 40], ['whale', 'Кит закупился', 12], ['bolt', 'Халвинг', 18], ['fire', 'Мем стал виральным', 22], ['bank', 'Фонд инвестировал', 15], ['fire', 'Сжигание 10% токенов', 30]];
const EVN = [['warning', 'SEC начала расследование', -30], ['whale', 'Кит продал всё', -20], ['skull', 'Взлом биржи', -35], ['news', 'FUD от ютубера', -15], ['skull', 'Rug pull', -50], ['warning', 'Запрет в Китае', -25]];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const wpick = (a) => { let r = Math.random() * 100; for (const x of a) { r -= x[x.length - 1]; if (r <= 0) return x; } return a[0]; };

let M = { price: 10, trend: 'FLAT', trV: 0, trEnd: 0, vol: 1, force: null, nextImp: 0, nextEv: 0, last: Date.now(), h: [], m: [], lastMin: 0, evs: [], evId: 0, sched: [], holders: {}, reg: null, base: 10, j: 0, paid: {}, seen: [], moonAt: {} };
try { Object.assign(M, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { /* первый запуск */ }
if (!M.base) M.base = M.price;
M.paid = M.paid || {}; M.seen = M.seen || []; M.moonAt = M.moonAt || {};
if (!M.h.length) M.h = Array(60).fill(M.price);
if (!M.m.length) M.m = [M.price];
if (!M.nextEv) { M.nextEv = Date.now() + rnd(600, 1800) * 1e3; M.nextImp = Date.now() + rnd(600, 1800) * 1e3; }
let CLK = Date.now(), quiet = false;

// Влияние считается в логарифмах: +x% и потом -x% возвращают цену точно назад (идеальный баланс)
const applyPct = (p) => { M.base = Math.min(1e4, Math.max(0.01, M.base * Math.exp(p / 100))); M.price = M.base * (1 + M.j / 100); };
function notifyHolders(p, text, emoji) {
    if (quiet) return;
    const msg = `${emoji || (p > 0 ? '🚀' : '🔻')} ${text}${p ? ` (${p > 0 ? '+' : ''}${p}%)` : ''}. Загляни в ${APP_NAME}.`;
    for (const [id, h] of Object.entries(M.holders)) {
        if (h.moon > 0 && !h.off && allowNotify(id)) tg('sendMessage', { chat_id: id, text: msg, reply_markup: openKeyboard }).catch(() => {});
    }
}
function addEv(icon, text, pct, kind) {
    pct = +pct.toFixed(1);
    M.evs.push({ id: ++M.evId, t: CLK, icon, text, pct, kind });
    if (M.evs.length > 30) M.evs.shift();
    if (Math.abs(pct) >= CRIT) notifyHolders(pct, text);
}
function fireEvent(now) {
    const r = Math.random();
    // минусы чуть мягче (×0.8), чтобы плюсы и минусы уравновешивались
    const doEv = (e) => { const p = e[2] * EV_SC * (e[2] < 0 ? 0.8 : 1); applyPct(p); addEv(e[0], e[1], p, 'ev'); };
    if (r < .35) return doEv(pick(EVP));
    if (r < .7) return doEv(pick(EVN));
    const n = pick(['air', 'calm', 'chaos', 'fcrash', 'fpump', 'rumor']);
    if (n === 'air') addEv('gift', 'Airdrop: +10 $MOON каждому трейдеру', 0, 'air');
    else if (n === 'calm') { M.force = { v: 0, until: now + 6e5 }; addEv('sleep', 'Рынок затих на 10 минут', 0, 'ev'); }
    else if (n === 'chaos') { M.force = { v: rnd(-4, 4), until: now + 3e5 }; addEv('dice', 'Неопределённость: хаос 5 минут', 0, 'ev'); }
    else if (n === 'fcrash') { const p = -15 * EV_SC; applyPct(p); addEv('bolt', 'Флеш-крах!', p, 'ev'); M.sched.push({ at: now + 12e4, pct: -p }); }
    else if (n === 'fpump') { const p = 15 * EV_SC; applyPct(p); addEv('bolt', 'Флеш-памп!', p, 'ev'); M.sched.push({ at: now + 12e4, pct: -p }); }
    else { const p = 5 * EV_SC; applyPct(p); addEv('news', 'Слух о партнёрстве', p, 'ev'); M.sched.push({ at: now + 6e5, pct: 20 * EV_SC, text: 'Партнёрство подтверждено', icon: 'handshake' }); }
}
function step(now) {
    CLK = now;
    // ДЛИННЫЕ ВОЛНЫ: каждые 1.5-4 часа рынок выбирает направление и идёт туда на 8-25% (≈ ±$1-3 при цене $10).
    // Чем дальше цена от $10, тем вероятнее разворот — курс гуляет примерно в коридоре $6-15 и не залипает.
    if (!M.leg || now > M.leg.until) {
        const dur = rnd(1.5, 4) * 36e5;
        const pUp = Math.min(.85, Math.max(.15, .5 - Math.log(M.base / 10) * 1.6));
        const up = Math.random() < pUp;
        const tot = (up ? 1 : -1) * rnd(8, 25) * (Math.random() < .2 ? 1.5 : 1);
        M.leg = { v: tot / (dur / TICK_MS), until: now + dur };
        addEv(up ? 'rocket' : 'down', up ? 'Покупатели заходят в рынок: курс растёт' : 'Продавцы давят рынок: курс снижается', 0, 'ev');
    }
    if (M.force && now > M.force.until) M.force = null;
    if (now > M.trEnd) { const t = wpick(TR); M.trend = t[0]; M.trV = rnd(t[1], t[2]); M.trEnd = now + rnd(600, 2400) * 1e3; M.vol = wpick(VO)[1];
        if (!M.reg && Math.random() < REGIME_P) { // редкая удача (или беда): долгий тренд на несколько часов
            const d = Math.random() < .5 ? 1 : -1;
            M.reg = { d, v: rnd(.0006, .0014), until: now + rnd(24, 72) * 36e5 };
            const txt = d > 0 ? 'Крупные игроки раскручивают $MOON: начинается ралли' : 'Паника на рынке: начинается затяжная распродажа';
            addEv(d > 0 ? 'rocket' : 'skull', txt, 0, 'ev'); notifyHolders(0, txt, d > 0 ? '🚀' : '🔻');
        }
    }
    if (M.reg && now > M.reg.until) M.reg = null;
    const t = M.force ? M.force.v : (M.trend === 'CHAOS' ? rnd(-4, 4) : M.trV);
    applyPct((t * SC + gauss() * NOISE) * M.vol + Math.log(10 / M.base) * REV + (M.reg ? M.reg.d * M.reg.v : 0) + (M.leg ? M.leg.v : 0));
    M.sched = M.sched.filter((s) => { if (s.at > now) return true; applyPct(s.pct); if (s.text) addEv(s.icon, s.text, s.pct, 'ev'); return false; });
    if (now > M.nextImp) {
        M.nextImp = now + rnd(3600, 10800) * 1e3;
        const r = Math.random(), m = rnd(8, 25) * 0.03;
        if (r < .45) { applyPct(m); addEv('rocket', 'Памп на рынке', m, 'ev'); }
        else if (r < .9) { applyPct(-m); addEv('down', 'Дамп на рынке', -m, 'ev'); }
        else { applyPct(m); M.sched.push({ at: now + 3e5, pct: -m }); }
    }
    if (now > M.nextEv) { M.nextEv = now + rnd(7200, 21600) * 1e3; fireEvent(now); }
    M.j = M.j * 0.85 + gauss() * JIT; M.price = M.base * (1 + M.j / 100);
    M.h.push(M.price); if (M.h.length > 1800) M.h.shift();
    const mi = Math.floor(now / 6e4);
    if (mi !== M.lastMin) { M.lastMin = mi; M.m.push(M.price); if (M.m.length > 10080) M.m.shift(); }
}
// Догоняем время, пока сервер был выключен/перезапускался (до 6 часов)
{ quiet = true; const n = Math.min(Math.floor((Date.now() - M.last) / TICK_MS), 10800); for (let i = 1; i <= n; i++) step(M.last + i * TICK_MS); quiet = false; M.last = Date.now(); }
const saveMarket = () => fs.writeFile(STATE_FILE, JSON.stringify(M), () => {});
setInterval(() => { step(Date.now()); M.last = Date.now(); }, TICK_MS);
setInterval(saveMarket, 30000);
process.on('SIGTERM', () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(M)); } catch { /* ignore */ } process.exit(0); });

// ====== API для мини-аппа ======
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const downs = (a, n) => { if (a.length <= n) return a; const o = []; for (let i = 0; i < n; i++) o.push(a[Math.floor(i * (a.length - 1) / (n - 1))]); return o; };
const tradeAt = new Map();
const MOON_CD = 24 * 36e5;   // секретный бонус: раз в 24 часа на человека
const MOON_IMPACT = 0.5;     // +% к курсу за секретный бонус
const DON_BOOST = 20;        // донат двигает курс в 20 раз сильнее обычной покупки (1⭐ ≈ +0.5%)
const miscAt = new Map();
function api(req, res) {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/api/market') {
        json(res, 200, { p: M.price, ch: (M.price / (M.m.slice(-1440)[0] || M.price) - 1) * 100, ev: M.evs.slice(-8), h: downs(M.h.slice(-150), 75), now: Date.now() });
        return true;
    }
    if (req.method === 'GET' && u.pathname === '/api/history') {
        const r = u.searchParams.get('r');
        json(res, 200, downs(r === '7d' ? M.m : r === '24h' ? M.m.slice(-1440) : M.h, 120));
        return true;
    }
    if (req.method === 'POST' && (u.pathname === '/api/trade' || u.pathname === '/api/sync')) {
        readBody(req, res, (b) => {
            let d; try { d = JSON.parse(b); } catch { return json(res, 400, {}); }
            const user = validInitData(d.initData);
            if (!user) return json(res, 401, { error: 'auth' });
            const id = String(user.id);
            if (u.pathname === '/api/sync') {
                const moon = Math.max(0, Number(d.moon) || 0);
                if (moon > 0) M.holders[id] = { moon, off: d.notif === false }; else delete M.holders[id];
                return json(res, 200, { ok: true });
            }
            const now = Date.now();
            if (now - (tradeAt.get(id) || 0) < 1500) return json(res, 429, { error: 'rate' });
            tradeAt.set(id, now);
            const a = Math.min(1e6, Math.max(0, Number(d.amount) || 0));
            if (a <= 0 || (d.side !== 'b' && d.side !== 's')) return json(res, 400, {});
            const p = M.price, im = Math.min(5, a / 1e5 * 25);
            applyPct(d.side === 'b' ? im : -im);
            // комиссия возвращается в рынок как покупка $MOON (курс чуть растёт)
            const fee = Math.min(0.1, Math.max(0, Number(d.fee) || 0));
            if (fee > 0) applyPct(Math.min(5, a * fee / 1e5 * 25));
            json(res, 200, { p, np: M.price });
        });
        return true;
    }
    if (req.method === 'POST' && ['/api/moon', '/api/invoice', '/api/claim'].includes(u.pathname)) {
        readBody(req, res, async (b) => {
            let d; try { d = JSON.parse(b); } catch { return json(res, 400, {}); }
            const user = validInitData(d.initData);
            if (!user) return json(res, 401, { error: 'auth' });
            const id = String(user.id), now = Date.now();
            if (u.pathname === '/api/claim') { // забрать оплаченные звёзды (деньги придут на баланс в мини-аппе)
                const stars = M.paid[id] || 0;
                delete M.paid[id];
                if (stars) saveMarket();
                return json(res, 200, { stars, usd: stars * USD_PER_STAR, np: M.price });
            }
            if (now - (miscAt.get(id) || 0) < 2000) return json(res, 429, { error: 'rate' });
            miscAt.set(id, now);
            if (u.pathname === '/api/moon') { // скрытая команда /moon
                if (now - (M.moonAt[id] || 0) < MOON_CD) return json(res, 429, { error: 'cooldown' });
                M.moonAt[id] = now;
                applyPct(MOON_IMPACT);
                return json(res, 200, { usd: 1000, np: M.price });
            }
            const stars = Math.floor(Number(d.stars) || 0); // /api/invoice
            if (stars < 1 || stars > 1000) return json(res, 400, { error: 'stars' });
            try {
                const link = await tg('createInvoiceLink', {
                    title: 'Донат в MoonTrade', description: `${stars}⭐ = $${(stars * USD_PER_STAR).toLocaleString('en-US')} игровых денег`,
                    payload: `don:${id}:${stars}`, currency: 'XTR', prices: [{ label: 'Донат', amount: stars }],
                });
                json(res, 200, { link });
            } catch (e) { console.error('invoice:', e.message); json(res, 500, { error: 'invoice' }); }
        });
        return true;
    }
    return false;
}

// ====== СЕРВЕР ======
const MAX_BODY = 1024 * 1024;
const readBody = (req, res, cb) => {
    let b = '', big = false;
    req.on('data', (c) => { if (big) return; b += c; if (b.length > MAX_BODY) { big = true; res.writeHead(413); res.end(); req.destroy(); } });
    req.on('end', () => { if (!big) cb(b); });
};

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
        if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
            res.writeHead(401); res.end('{"ok":false}'); req.destroy(); return;
        }
        return readBody(req, res, (b) => {
            try { onUpdate(JSON.parse(b)).catch((e) => console.error('update:', e.message)); } catch (e) { console.error('parse:', e); }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
        });
    }
    if (req.url.startsWith('/api/') && api(req, res)) return;
    if (req.method === 'POST' && req.url === '/notify') {
        return readBody(req, res, async (b) => {
            let ok = false;
            try { ok = await handleNotify(JSON.parse(b)); } catch (e) { console.error('notify:', e.message); }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok }));
        });
    }
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', bot: 'running', uptime: process.uptime() }));
    }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?') || req.url.startsWith('/index.html'))) {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); return res.end('index.html not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(data);
        });
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

server.listen(PORT, async () => {
    console.log(`✅ Сервер на порту ${PORT}`);
    try {
        await tg('setWebhook', { url: `${EXTERNAL_URL}${WEBHOOK_PATH}`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query'] });
        console.log('✅ Webhook установлен');
    } catch (e) { console.error('❌ Webhook error:', e.message); }
    try {
        await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: APP_NAME, web_app: { url: WEBAPP_URL } } });
    } catch (e) { console.error('menu button:', e.message); }
    keepAliveLoop();
    heartbeatLoop();
});

// ====== АНТИ-СЛИП (как в chat.js) ======
async function keepAliveLoop() {
    const url = `${EXTERNAL_URL}/health`;
    await new Promise((r) => setTimeout(r, 10000));
    while (true) {
        let success = false;
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                console.log(`🔄 Keep-alive пинг: ${res.status}`);
                success = true;
            } catch (e) {
                console.warn(`⚠️ Keep-alive не удался (${attempt}/3): ${e.message}`);
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
        if (!success) console.error('❌ Keep-alive: все попытки провалились');
        await new Promise((r) => setTimeout(r, 150000)); // раз в 2.5 минуты
    }
}

function heartbeatLoop() {
    setInterval(() => {
        try {
            const mod = EXTERNAL_URL.startsWith('https') ? https : http;
            const req = mod.get(`${EXTERNAL_URL}/health`, { timeout: 10000 }, (res) => { console.log(`💓 Heartbeat: ${res.statusCode}`); res.resume(); });
            req.on('timeout', () => req.destroy());
            req.on('error', (e) => console.warn(`⚠️ Heartbeat: ${e.message}`));
        } catch (e) { console.warn(`⚠️ Heartbeat ошибка: ${e.message}`); }
    }, 240000); // раз в 4 минуты
}
