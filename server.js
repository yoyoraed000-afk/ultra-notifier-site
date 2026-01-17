require('dotenv').config({ path: './config.env' });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();

// ============================================================
// DISCORD BOT FOR ROLE ASSIGNMENT
// ============================================================

const discordBot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// Role IDs for each tier - UPDATE THESE WITH YOUR ACTUAL ROLE IDs FROM DISCORD
const TIER_ROLES = {
    1: process.env.ROLE_TIER_1 || '',  // Bronze - 50M
    2: process.env.ROLE_TIER_2 || '',  // Silver - 200M
    3: process.env.ROLE_TIER_3 || '',  // Gold - 400M
    4: process.env.ROLE_TIER_4 || '',  // Diamond - 1B
    5: process.env.ROLE_TIER_5 || '',  // Diamond Private
};

const GUILD_ID = process.env.DISCORD_GUILD_ID || '';

// Connect bot
if (process.env.DISCORD_BOT_TOKEN) {
    discordBot.login(process.env.DISCORD_BOT_TOKEN)
        .then(() => console.log('✅ Discord bot connected for role management'))
        .catch(err => console.log('❌ Discord bot failed to connect:', err.message));
}

// Assign role to user
async function assignDiscordRole(discordId, tier) {
    if (!discordBot.isReady() || !GUILD_ID || !TIER_ROLES[tier]) {
        console.log(`[Roles] Skipped - Bot not ready or role not configured for tier ${tier}`);
        return false;
    }
    
    try {
        const guild = await discordBot.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);
        
        // Remove all tier roles first
        const allTierRoles = Object.values(TIER_ROLES).filter(r => r);
        for (const roleId of allTierRoles) {
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId);
            }
        }
        
        // Add new tier role
        const roleId = TIER_ROLES[tier];
        if (roleId) {
            await member.roles.add(roleId);
            console.log(`[Roles] ✅ Assigned tier ${tier} role to ${member.user.username}`);
            return true;
        }
    } catch (err) {
        console.log(`[Roles] ❌ Failed to assign role: ${err.message}`);
    }
    return false;
}

// Remove all tier roles from user
async function removeDiscordRoles(discordId) {
    if (!discordBot.isReady() || !GUILD_ID) {
        return false;
    }
    
    try {
        const guild = await discordBot.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);
        
        const allTierRoles = Object.values(TIER_ROLES).filter(r => r);
        for (const roleId of allTierRoles) {
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId);
            }
        }
        console.log(`[Roles] Removed all tier roles from ${member.user.username}`);
        return true;
    } catch (err) {
        console.log(`[Roles] ❌ Failed to remove roles: ${err.message}`);
    }
    return false;
}

// ============================================================
// ADMIN CONFIG
// ============================================================

const ADMIN_DISCORD_USERNAMES = ['yvyoo']; // Add more admins here

// ============================================================
// SIMPLE JSON DATABASE (with Render Disk persistence)
// ============================================================

// Use persistent disk on Render (/data), fallback to local for development
const DATA_DIR = fs.existsSync('/data') ? '/data' : '.';
const DB_FILE = path.join(DATA_DIR, 'database.json');

console.log(`[Database] Using path: ${DB_FILE}`);

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            console.log(`[Database] Loaded ${data.users?.length || 0} users`);
            return data;
        }
    } catch (e) {
        console.error('[Database] Error loading:', e.message);
    }
    console.log('[Database] Starting fresh database');
    return { users: [], logs: [], banned_hwids: [], warnings: [] };
}

function saveDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[Database] Error saving:', e.message);
    }
}

let db = loadDB();

// Ensure arrays exist
if (!db.banned_hwids) db.banned_hwids = [];
if (!db.warnings) db.warnings = [];
if (db.global_paused === undefined) db.global_paused = false;
if (db.sales_closed === undefined) db.sales_closed = false;

// Helper functions
function findUser(query) {
    if (query.id) return db.users.find(u => u.id === query.id);
    if (query.discord_id) return db.users.find(u => u.discord_id === query.discord_id);
    if (query.license_key) return db.users.find(u => u.license_key === query.license_key);
    if (query.hwid) return db.users.find(u => u.hwid === query.hwid);
    return null;
}

function updateUser(id, updates) {
    const index = db.users.findIndex(u => u.id === id);
    if (index !== -1) {
        db.users[index] = { ...db.users[index], ...updates };
        saveDB(db);
        return db.users[index];
    }
    return null;
}

function createUser(userData) {
    db.users.push(userData);
    saveDB(db);
    return userData;
}

function isAdmin(user) {
    return user && ADMIN_DISCORD_USERNAMES.includes(user.username.toLowerCase());
}

function isHWIDBanned(hwid) {
    return db.banned_hwids.includes(hwid);
}

// ============================================================
// REAL-TIME LOGS (Server-Sent Events)
// ============================================================

let logClients = [];

function broadcastLog(log) {
    logClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(log)}\n\n`);
    });
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

// SECURITY: Block direct access to .lua files (except loader which is safe)
app.use((req, res, next) => {
    if (req.path.endsWith('.lua') && !req.path.endsWith('/loader.lua') && req.path !== '/j') {
        console.log(`[Security] Blocked direct .lua access: ${req.path} from ${req.ip}`);
        return res.status(403).send('-- Access denied. Use your license key to load scripts.');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Auto-create sessions folder - use persistent disk if available
const sessionsPath = fs.existsSync('/data') ? '/data/sessions' : path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsPath)) {
    fs.mkdirSync(sessionsPath, { recursive: true });
    console.log(`✅ Created sessions folder at: ${sessionsPath}`);
}
console.log(`[Sessions] Using path: ${sessionsPath}`);

// File-based session store (persists across restarts)
const FileStore = require('session-file-store')(session);

app.use(session({
    store: new FileStore({
        path: sessionsPath,
        ttl: 30 * 24 * 60 * 60, // 30 days in seconds (longer persistence)
        retries: 2,
        reapInterval: 3600, // Clean expired sessions every hour
        secret: process.env.SESSION_SECRET || 'ultra-notifier-secret-key'
    }),
    secret: process.env.SESSION_SECRET || 'ultra-notifier-secret-key',
    resave: true, // Always resave session to refresh TTL
    saveUninitialized: false,
    rolling: true, // Reset expiry on each request
    cookie: { 
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: false, // Set to true if using HTTPS
        sameSite: 'lax'
    }
}));
app.use(passport.initialize());
app.use(passport.session());

// Admin middleware
function requireAdmin(req, res, next) {
    if (!req.user || !isAdmin(req.user)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ============================================================
// DISCORD AUTH
// ============================================================

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    const user = findUser({ id });
    done(null, user);
});

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    let user = findUser({ discord_id: profile.id });
    
    if (!user) {
        const id = uuidv4();
        const licenseKey = generateLicenseKey();
        user = createUser({
            id,
            discord_id: profile.id,
            username: profile.username,
            avatar: profile.avatar,
            license_key: licenseKey,
            hwid: null,
            roblox_username: null,
            balance: 0,
            subscription_tier: 0,
            subscription_expires: 0,
            warnings: 0,
            created_at: Date.now(),
            last_active: Date.now()
        });
    } else {
        user = updateUser(user.id, {
            username: profile.username,
            avatar: profile.avatar,
            last_active: Date.now()
        });
    }
    
    return done(null, user);
}));

function generateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = 'ULTRA-';
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            key += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        if (i < 3) key += '-';
    }
    return key;
}

// ============================================================
// PLAN CONFIGURATION (with slots)
// ============================================================

// Default plan config (can be overridden in db)
// All plans start at 0 minimum - maxValue is the cap they can see UP TO
const DEFAULT_PLANS = {
    1: { name: 'Bronze', tier: 1, maxValue: 50000000, price: 1.00, slots: 2, minHours: 2, color: '#CD7F32', enabled: true },       // 0 to 50M
    2: { name: 'Silver', tier: 2, maxValue: 200000000, price: 2.00, slots: 2, minHours: 2, color: '#C0C0C0', enabled: true },      // 0 to 200M
    3: { name: 'Gold', tier: 3, maxValue: 400000000, price: 3.50, slots: 4, minHours: 2, color: '#FFD700', enabled: true },        // 0 to 400M
    4: { name: 'Diamond', tier: 4, maxValue: Infinity, price: 4.25, slots: 2, minHours: 2, color: '#B9F2FF', enabled: true },      // 0 to 1B+ (unlimited)
    5: { name: 'Diamond Private', tier: 5, maxValue: Infinity, price: 5.00, slots: 1, minHours: 2, color: '#FF00FF', adminOnly: true, enabled: true } // 0 to 1B+ (unlimited)
};

// Global minimum hours (can be overridden in db)
function getGlobalMinHours() {
    return db.global_min_hours || 2;
}

// Get current plans (from db if set, otherwise defaults)
function getPlans() {
    if (db.plans) {
        return db.plans;
    }
    return DEFAULT_PLANS;
}

// Shorthand for current plans
const PLANS = new Proxy({}, {
    get: (target, prop) => getPlans()[prop]
});

// ============================================================
// AUTH ROUTES
// ============================================================

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
);

app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// ============================================================
// API ROUTES
// ============================================================

// Get live slots status for all plans
app.get('/api/slots-status', (req, res) => {
    const now = Date.now();
    const plans = getPlans();
    
    // Get all active subscribers grouped by tier
    const activeUsers = db.users.filter(u => u.subscription_tier > 0 && u.subscription_expires > now);
    
    const slotsStatus = {};
    
    for (const tier of [1, 2, 3, 4, 5]) {
        const plan = plans[tier];
        if (!plan) continue;
        
        const tierUsers = activeUsers
            .filter(u => u.subscription_tier == tier)
            .sort((a, b) => a.subscription_expires - b.subscription_expires);
        
        const activeCount = tierUsers.length;
        const maxSlots = plan.slots || 2;
        
        // Find next available slot time (earliest expiring user)
        let nextSlotMs = null;
        if (tierUsers.length > 0) {
            nextSlotMs = tierUsers[0].subscription_expires - now;
        }
        
        slotsStatus[tier] = {
            name: plan.name,
            activeUsers: activeCount,
            maxSlots: maxSlots,
            nextSlotMs: nextSlotMs,
            color: plan.color,
            adminOnly: plan.adminOnly || false,
            enabled: plan.enabled !== undefined ? plan.enabled : true
        };
    }
    
    // Calculate totals
    const totalBrainrots = db.logs.length;
    
    res.json({
        plans: slotsStatus,
        totalBrainrots
    });
});

// Get current user
app.get('/api/user', (req, res) => {
    if (!req.user) return res.json({ authenticated: false });
    
    const user = findUser({ id: req.user.id });
    
    // If paused, show frozen time. Otherwise show live countdown.
    let isActive = false;
    let effectiveExpires = user.subscription_expires;
    
    if (user.paused && user.paused_time_remaining) {
        // User is paused - they still have an active sub (frozen)
        isActive = user.paused_time_remaining > 0;
        // Show what the expiry WOULD be if unpaused now
        effectiveExpires = Date.now() + user.paused_time_remaining;
    } else {
        isActive = user.subscription_expires > Date.now();
    }
    
    res.json({
        authenticated: true,
        isAdmin: isAdmin(user),
        user: {
            username: user.username,
            avatar: user.avatar,
            discord_id: user.discord_id,
            license_key: user.license_key,
            balance: user.balance || 0,
            subscription_tier: isActive ? user.subscription_tier : 0,
            subscription_expires: effectiveExpires,
            plan: isActive ? PLANS[user.subscription_tier] : null,
            warnings: user.warnings || 0,
            paused: user.paused || false,
            pause_locked: user.pause_locked || false,
            paused_time_remaining: user.paused_time_remaining || null
        }
    });
});

// Reset HWID
app.post('/api/reset-hwid', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const user = findUser({ id: req.user.id });
    const history = user.hwid_history || [];
    if (user.hwid) {
        history.push({ hwid: user.hwid, timestamp: Date.now(), action: 'reset' });
    }
    
    updateUser(req.user.id, { hwid: null, hwid_history: history });
    res.json({ success: true, message: 'HWID reset successfully!' });
});

// Unpause (user can unpause themselves if not locked)
app.post('/api/unpause', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const user = findUser({ id: req.user.id });
    
    if (!user.paused) {
        return res.json({ success: false, error: 'Your plan is not paused' });
    }
    
    // Check if pause is locked by admin
    if (user.pause_locked) {
        return res.json({ success: false, error: 'Your pause is locked by an admin. Contact support.' });
    }
    
    // Unpause the user and restore their subscription time
    const timeRemaining = user.paused_time_remaining || 0;
    const newExpires = Date.now() + timeRemaining;
    
    updateUser(req.user.id, { 
        paused: false, 
        unpause_requested: false,
        subscription_expires: newExpires,
        paused_time_remaining: null,
        paused_at: null
    });
    
    console.log(`[UNPAUSE] User ${user.discord_username} (${req.user.id}) unpaused their own plan (restored ${(timeRemaining / 3600000).toFixed(1)}h)`);
    
    res.json({ success: true, message: 'Your plan has been unpaused! Time restored.' });
});

// Get user config (include/exclude with values)
app.get('/api/user/config', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const user = findUser({ id: req.user.id });
    
    const config = {
        general_min: user.general_min || 0,
        include_config: user.include_config || {},
        exclude_config: user.exclude_config || {},
        // Legacy support
        include_list: user.include_list || [],
        exclude_list: user.exclude_list || []
    };
    
    const includeCount = Object.keys(config.include_config).length;
    const excludeCount = Object.keys(config.exclude_config).length;
    console.log(`[Config] GET ${req.user.username}: min=${config.general_min}, ${includeCount} includes, ${excludeCount} excludes`);
    
    res.json(config);
});

// Save user config
app.post('/api/user/config', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { include_config, exclude_config, include_list, exclude_list, general_min } = req.body;
    
    const updates = {};
    
    // General minimum value
    if (general_min !== undefined) {
        updates.general_min = parseInt(general_min) || 0;
    }
    
    // New format: { "Meowl": 1000000, "Skibidi Toilet": 0 }
    if (include_config && typeof include_config === 'object') {
        updates.include_config = include_config;
    }
    if (exclude_config && typeof exclude_config === 'object') {
        updates.exclude_config = exclude_config;
    }
    
    // Legacy format support
    if (Array.isArray(include_list)) {
        updates.include_list = include_list.slice(0, 100);
    }
    if (Array.isArray(exclude_list)) {
        updates.exclude_list = exclude_list.slice(0, 100);
    }
    
    updateUser(req.user.id, updates);
    
    const includeCount = Object.keys(updates.include_config || {}).length;
    const excludeCount = Object.keys(updates.exclude_config || {}).length;
    const minFormatted = updates.general_min ? (updates.general_min >= 1000000000 ? (updates.general_min / 1000000000).toFixed(1) + 'B' : (updates.general_min / 1000000).toFixed(0) + 'M') : '0';
    console.log(`[Config] ${req.user.username} updated: min=${minFormatted}, ${includeCount} includes, ${excludeCount} excludes`);
    
    res.json({ success: true });
});

// ============================================================
// REAL-TIME LOGS
// ============================================================

app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    const clientId = Date.now();
    const client = { id: clientId, res };
    logClients.push(client);
    
    const recentLogs = db.logs.slice(-20).reverse();
    res.write(`data: ${JSON.stringify({ type: 'init', logs: recentLogs })}\n\n`);
    
    req.on('close', () => {
        logClients = logClients.filter(c => c.id !== clientId);
    });
});

app.get('/api/logs', (req, res) => {
    const logs = db.logs.slice(-20).reverse();
    res.json(logs);
});

app.post('/api/logs', (req, res) => {
    const { brainrot_name, brainrot_value, image_url, api_key } = req.body;
    
    if (api_key !== process.env.SCANNER_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const log = {
        id: Date.now(),
        brainrot_name,
        brainrot_value,
        image_url: image_url || getBrainrotImageUrl(brainrot_name),
        timestamp: Date.now()
    };
    
    db.logs.push(log);
    if (db.logs.length > 100) db.logs = db.logs.slice(-100);
    saveDB(db);
    
    broadcastLog({ type: 'new', log });
    
    res.json({ success: true });
});

function getBrainrotImageUrl(name) {
    const formatted = name.toLowerCase().replace(/ /g, '_').replace(/[^a-z0-9_]/g, '');
    return `https://calculadora.estevao1098.com/images/brainrots/${formatted}.png`;
}

// ============================================================
// BALANCE & SUBSCRIPTION
// ============================================================

app.post('/api/paymento/webhook', (req, res) => {
    const crypto = require('crypto');
    const paymentoSecret = process.env.PAYMENTO_SECRET;
    
    // Get the signature from header (Paymento sends it in header)
    const signature = req.headers['x-paymento-signature'] || req.headers['x-signature'] || req.body.signature;
    
    // Verify HMAC-SHA256 signature if secret is set
    if (paymentoSecret && signature) {
        const payload = JSON.stringify(req.body);
        const expectedSignature = crypto
            .createHmac('sha256', paymentoSecret)
            .update(payload)
            .digest('hex');
        
        // Check both raw signature and with 'sha256=' prefix
        const isValid = signature === expectedSignature || 
                        signature === `sha256=${expectedSignature}` ||
                        signature === paymentoSecret; // Also allow direct secret match
        
        if (!isValid) {
            console.log(`[Paymento] ❌ Invalid signature`);
            console.log(`[Paymento] Expected: ${expectedSignature}`);
            console.log(`[Paymento] Got: ${signature}`);
            // For now, log but don't reject (for testing)
            // return res.status(401).json({ error: 'Invalid signature' });
        }
    }
    
    // Extract user_id from Paymento's structure
    // User puts their Discord ID in the Email field
    const user_id = req.body.Customer?.Email || 
                    req.body.customer?.email ||
                    req.body.user_id || 
                    req.body.email;
    
    // Extract amount from Paymento's structure
    const amount = req.body.Transaction?.Amount || 
                   req.body.Transaction?.amount ||
                   req.body.transaction?.amount ||
                   req.body.amount || 
                   req.body.PaymentLink?.Amount ||
                   1; // Default to $1 if no amount found
    
    console.log(`[Paymento] Webhook received:`, JSON.stringify(req.body));
    
    if (!user_id) {
        console.log(`[Paymento] ❌ No user_id in webhook`);
        return res.status(400).json({ error: 'Missing user_id' });
    }
    
    if (!amount) {
        console.log(`[Paymento] ❌ No amount in webhook`);
        return res.status(400).json({ error: 'Missing amount' });
    }
    
    const user = findUser({ discord_id: user_id });
    if (!user) {
        console.log(`[Paymento] ❌ User not found: ${user_id}`);
        return res.status(404).json({ error: 'User not found' });
    }
    
    const newBalance = (user.balance || 0) + parseFloat(amount);
    updateUser(user.id, { balance: newBalance });
    
    console.log(`[Paymento] ✅ Added $${amount} to ${user.username}'s balance (new: $${newBalance.toFixed(2)})`);
    res.json({ success: true, new_balance: newBalance });
});

app.post('/api/subscribe', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const user = findUser({ id: req.user.id });
    
    // Check if user's HWID is banned
    if (user && user.hwid && isHWIDBanned(user.hwid)) {
        return res.status(403).json({ error: 'Your account is banned. You cannot purchase subscriptions.' });
    }
    
    // Check if user has 2+ warnings (banned)
    if (user && (user.warnings || 0) >= 2) {
        return res.status(403).json({ error: 'Your account is banned due to warnings. You cannot purchase subscriptions.' });
    }
    
    // Check if sales are closed
    if (db.sales_closed) {
        return res.status(400).json({ error: 'Sales are currently closed. Please check back later!' });
    }
    
    // Check if all plans are globally paused
    if (db.global_paused) {
        return res.status(400).json({ error: 'All plans are currently paused. Purchases are disabled.' });
    }
    
    const { tier, hours } = req.body;
    
    const minHours = getGlobalMinHours();
    const parsedHours = Math.round(parseFloat(hours) * 10) / 10;
    if (isNaN(parsedHours) || parsedHours < minHours || parsedHours > 168) {
        return res.status(400).json({ error: `Minimum purchase is ${minHours} hours` });
    }
    
    const plan = PLANS[tier];
    if (!plan) return res.status(400).json({ error: 'Invalid tier' });
    
    // Check if plan is enabled
    if (plan.enabled === false) {
        return res.status(400).json({ error: 'This plan is currently disabled' });
    }
    
    // Check if plan is admin-only
    if (plan.adminOnly) {
        // Check if user is admin
        if (!isAdmin(req.user)) {
            return res.status(403).json({ error: 'This plan is not available' });
        }
    }
    
    // Check if slots are available (only if user is not already on this tier)
    const now = Date.now();
    const activeUsersOnTier = db.users.filter(u => 
        u.subscription_tier == tier && 
        u.subscription_expires > now &&
        u.id !== user.id // Don't count current user if they're renewing same tier
    ).length;
    
    const maxSlots = plan.slots || 2;
    if (activeUsersOnTier >= maxSlots) {
        return res.status(400).json({ 
            error: `${plan.name} slots are full (${activeUsersOnTier}/${maxSlots}). Try again later or choose a different plan.`
        });
    }
    
    const cost = parsedHours * plan.price;
    
    if ((user.balance || 0) < cost) {
        return res.status(400).json({ error: 'Insufficient balance', needed: cost, have: user.balance || 0 });
    }
    
    // FAIR CONVERSION: Convert existing time to $ value, then to new tier hours
    let convertedHours = 0;
    let conversionNote = '';
    
    if (user.subscription_expires > Date.now() && user.subscription_tier > 0) {
        const oldPlan = PLANS[user.subscription_tier];
        const remainingMs = user.subscription_expires - Date.now();
        const remainingHours = remainingMs / 3600000;
        const remainingValue = remainingHours * oldPlan.price; // $ value of remaining time
        
        // Convert $ value to new tier hours
        convertedHours = remainingValue / plan.price;
        conversionNote = ` (converted ${remainingHours.toFixed(1)}h ${oldPlan.name} → ${convertedHours.toFixed(1)}h ${plan.name})`;
    }
    
    // New subscription: converted time + purchased time
    const totalHours = convertedHours + parsedHours;
    const newExpires = Date.now() + (totalHours * 3600 * 1000);
    const newBalance = (user.balance || 0) - cost;
    
    updateUser(user.id, {
        balance: newBalance,
        subscription_tier: tier,
        subscription_expires: newExpires
    });
    
    // Assign Discord role
    assignDiscordRole(user.discord_id, tier);
    
    console.log(`[Subscribe] ${user.username} bought ${parsedHours}h of ${plan.name} for $${cost.toFixed(2)}${conversionNote}`);
    
    res.json({ 
        success: true, 
        new_balance: newBalance,
        expires: newExpires,
        hours_added: parsedHours,
        converted_hours: convertedHours,
        total_hours: totalHours,
        slots: plan.slots
    });
});

app.post('/api/add-balance', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { amount } = req.body;
    const user = findUser({ id: req.user.id });
    const newBalance = (user.balance || 0) + parseFloat(amount);
    
    updateUser(user.id, { balance: newBalance });
    res.json({ success: true, new_balance: newBalance });
});

// Validate license key (called by Roblox script)
app.get('/api/validate', (req, res) => {
    const { key, hwid, roblox_username } = req.query;
    
    if (!key) return res.json({ valid: false, error: 'No key provided' });
    
    // Check if HWID is banned
    if (hwid && isHWIDBanned(hwid)) {
        return res.json({ valid: false, error: 'BANNED: Your HWID has been permanently blocked.' });
    }
    
    const user = findUser({ license_key: key });
    
    if (!user) return res.json({ valid: false, error: 'Invalid key' });
    
    // Check warnings - 2 warnings = banned
    if ((user.warnings || 0) >= 2) {
        return res.json({ valid: false, error: 'BANNED: Your account received 2 warnings and has been permanently blocked.' });
    }
    
    // Check if user's HWID is banned (in case they got banned after setting HWID)
    if (user.hwid && isHWIDBanned(user.hwid)) {
        return res.json({ valid: false, error: 'BANNED: Your HWID has been permanently blocked.' });
    }
    
    const isActive = user.subscription_expires > Date.now();
    if (!isActive) return res.json({ valid: false, error: 'Subscription expired' });
    
    if (user.hwid && user.hwid !== hwid) {
        return res.json({ valid: false, error: 'HWID mismatch. Reset your HWID on the website.' });
    }
    
    // Update HWID and Roblox username
    const updates = { last_active: Date.now() };
    if (!user.hwid && hwid) {
        updates.hwid = hwid;
        // Add to HWID history
        const history = user.hwid_history || [];
        history.push({ hwid: hwid, timestamp: Date.now(), action: 'set' });
        updates.hwid_history = history;
    }
    if (roblox_username) updates.roblox_username = roblox_username;
    if (Object.keys(updates).length > 1) updateUser(user.id, updates);
    
    const plan = PLANS[user.subscription_tier];
    
    res.json({
        valid: true,
        tier: user.subscription_tier,
        minValue: plan?.minValue || 0,
        plan: plan?.name || 'None',
        slots: plan?.slots || 1,
        include_config: user.include_config || {},
        exclude_config: user.exclude_config || {},
        include_list: user.include_list || [],
        exclude_list: user.exclude_list || []
    });
});

// ============================================================
// ADMIN API
// ============================================================

// Get all users (admin only)
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = db.users.map(u => {
        const isHwidBanned = u.hwid && db.banned_hwids.includes(u.hwid);
        
        // If paused, show frozen time. Otherwise show live countdown.
        let hoursRemaining = 0;
        let isActive = false;
        
        if (u.paused && u.paused_time_remaining) {
            // User is paused - show the frozen time
            hoursRemaining = u.paused_time_remaining / 3600000;
            isActive = u.paused_time_remaining > 0;
        } else {
            // Normal countdown
            isActive = u.subscription_expires > Date.now();
            hoursRemaining = isActive ? Math.max(0, (u.subscription_expires - Date.now()) / 3600000) : 0;
        }
        
        return {
            id: u.id,
            discord_id: u.discord_id,
            username: u.username,
            avatar: u.avatar,
            license_key: u.license_key,
            hwid: u.hwid,
            hwid_history: u.hwid_history || [],
            hwid_banned: isHwidBanned,
            roblox_username: u.roblox_username,
            balance: u.balance || 0,
            subscription_tier: isActive ? u.subscription_tier : 0,
            plan_name: isActive ? PLANS[u.subscription_tier]?.name : 'None',
            hours_remaining: hoursRemaining.toFixed(1),
            warnings: u.warnings || 0,
            paused: u.paused || false,
            pause_locked: u.pause_locked || false,
            paused_time_remaining: u.paused_time_remaining || null,
            created_at: u.created_at,
            last_active: u.last_active
        };
    });
    
    res.json(users);
});

// Get admin stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const totalUsers = db.users.length;
    const activeSubscriptions = db.users.filter(u => u.subscription_expires > Date.now()).length;
    const totalBalance = db.users.reduce((sum, u) => sum + (u.balance || 0), 0);
    const bannedCount = db.banned_hwids.length;
    
    res.json({
        total_users: totalUsers,
        active_subscriptions: activeSubscriptions,
        total_balance: totalBalance.toFixed(2),
        banned_hwids: bannedCount,
        total_logs: db.logs.length
    });
});

// Get plan prices (admin only)
app.get('/api/admin/plans', requireAdmin, (req, res) => {
    res.json({
        plans: getPlans(),
        globalMinHours: db.global_min_hours || 2
    });
});

// Update plan prices (admin only)
app.post('/api/admin/plans', requireAdmin, (req, res) => {
    const { plans, globalMinHours } = req.body;
    
    if (!plans || typeof plans !== 'object') {
        return res.status(400).json({ error: 'Invalid plans data' });
    }
    
    // Validate and merge with defaults
    const updatedPlans = {};
    for (const tier of [1, 2, 3, 4, 5]) {
        const defaultPlan = DEFAULT_PLANS[tier];
        const newPlan = plans[tier] || {};
        
        updatedPlans[tier] = {
            name: newPlan.name || defaultPlan.name,
            tier: tier,
            maxValue: newPlan.maxValue !== undefined ? (newPlan.maxValue === 'Infinity' || newPlan.maxValue === Infinity ? Infinity : parseInt(newPlan.maxValue)) : defaultPlan.maxValue,
            price: parseFloat(newPlan.price) || defaultPlan.price,
            slots: parseInt(newPlan.slots) || defaultPlan.slots,
            minHours: parseFloat(newPlan.minHours) || defaultPlan.minHours || 2,
            color: newPlan.color || defaultPlan.color,
            adminOnly: defaultPlan.adminOnly || false,
            enabled: newPlan.enabled !== undefined ? newPlan.enabled : (defaultPlan.enabled !== undefined ? defaultPlan.enabled : true)
        };
    }
    
    db.plans = updatedPlans;
    
    // Update global min hours if provided
    if (globalMinHours !== undefined) {
        db.global_min_hours = parseFloat(globalMinHours) || 2;
    }
    
    saveDB(db);
    
    console.log(`[Admin] ${req.user.username} updated plan configuration`);
    
    res.json({ success: true, plans: updatedPlans, globalMinHours: db.global_min_hours || 2 });
});

// Get active users (public - for active users page)
app.get('/api/active-users', (req, res) => {
    const now = Date.now();
    
    // Get all users with active subscriptions
    const activeUsers = db.users.filter(u => {
        // If paused with remaining time, they count as active
        if (u.paused && u.paused_time_remaining > 0) return true;
        // Otherwise check normal expiry
        return u.subscription_tier > 0 && u.subscription_expires > now;
    });
    
    // Map to public info only (no sensitive data like license keys, hwid, etc)
    const publicUsers = activeUsers.map(u => {
        let hoursRemaining = 0;
        
        if (u.paused && u.paused_time_remaining) {
            hoursRemaining = u.paused_time_remaining / 3600000;
        } else {
            hoursRemaining = Math.max(0, (u.subscription_expires - now) / 3600000);
        }
        
        return {
            username: u.username,
            avatar: u.avatar,
            discord_id: u.discord_id,
            subscription_tier: u.subscription_tier,
            hours_remaining: hoursRemaining,
            paused: u.paused || false
        };
    });
    
    // Calculate stats
    const totalHours = publicUsers.reduce((sum, u) => sum + u.hours_remaining, 0);
    const avgHours = publicUsers.length > 0 ? totalHours / publicUsers.length : 0;
    
    res.json({
        users: publicUsers,
        stats: {
            active: publicUsers.length,
            total: db.users.length,
            avgHours: avgHours
        }
    });
});

// Get plans (public - for dashboard)
app.get('/api/plans', (req, res) => {
    res.json({
        plans: getPlans(),
        globalMinHours: db.global_min_hours || 2,
        globalPaused: db.global_paused || false,
        salesClosed: db.sales_closed || false
    });
});

// Warn user (admin only) - 2 warnings = auto ban
app.post('/api/admin/warn/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const newWarnings = (user.warnings || 0) + 1;
    updateUser(userId, { warnings: newWarnings });
    
    // Log warning
    db.warnings.push({
        user_id: userId,
        username: user.username,
        reason: reason || 'No reason provided',
        timestamp: Date.now(),
        admin: req.user.username
    });
    saveDB(db);
    
    console.log(`[Admin] ${req.user.username} warned ${user.username} (${newWarnings} total)`);
    
    // AUTO-BAN at 2 warnings
    let autoBanned = false;
    if (newWarnings >= 2 && user.hwid) {
        if (!db.banned_hwids.includes(user.hwid)) {
            db.banned_hwids.push(user.hwid);
            saveDB(db);
            autoBanned = true;
            console.log(`[Auto-Ban] ${user.username} auto-banned (2 warnings) - HWID: ${user.hwid}`);
        }
    }
    
    res.json({ 
        success: true, 
        warnings: newWarnings,
        auto_banned: autoBanned,
        message: autoBanned ? `User auto-banned (2 warnings). HWID: ${user.hwid}` : `Warning issued (${newWarnings}/2)`
    });
});

// Ban HWID (admin only)
app.post('/api/admin/ban/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (!user.hwid) {
        return res.status(400).json({ error: 'User has no HWID to ban' });
    }
    
    if (!db.banned_hwids.includes(user.hwid)) {
        db.banned_hwids.push(user.hwid);
        saveDB(db);
    }
    
    // Also set warnings to max
    updateUser(userId, { warnings: 99 });
    
    console.log(`[Admin] ${req.user.username} banned HWID for ${user.username}: ${user.hwid}`);
    
    res.json({ success: true, banned_hwid: user.hwid });
});

// Unban HWID (admin only)
app.post('/api/admin/unban/:hwid', requireAdmin, (req, res) => {
    const { hwid } = req.params;
    
    db.banned_hwids = db.banned_hwids.filter(h => h !== hwid);
    saveDB(db);
    
    console.log(`[Admin] ${req.user.username} unbanned HWID: ${hwid}`);
    
    res.json({ success: true });
});

// Unban user by userId (finds HWID and unbans + clears warnings)
app.post('/api/admin/unban-user/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    let unbannedHwid = false;
    if (user.hwid && db.banned_hwids.includes(user.hwid)) {
        db.banned_hwids = db.banned_hwids.filter(h => h !== user.hwid);
        unbannedHwid = true;
    }
    
    // Clear warnings too
    updateUser(userId, { warnings: 0 });
    saveDB(db);
    
    console.log(`[Admin] ${req.user.username} unbanned user ${user.username} (HWID: ${user.hwid}, cleared warnings)`);
    
    res.json({ success: true, unbanned_hwid: unbannedHwid, hwid: user.hwid });
});

// Add balance to user (admin only)
app.post('/api/admin/add-balance/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const newBalance = (user.balance || 0) + parseFloat(amount);
    updateUser(userId, { balance: newBalance });
    
    console.log(`[Admin] ${req.user.username} added $${amount} to ${user.username}`);
    
    res.json({ success: true, new_balance: newBalance });
});

// Add subscription time (admin only)
app.post('/api/admin/add-time/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { hours, tier } = req.body;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const currentExpires = Math.max(user.subscription_expires || 0, Date.now());
    const newExpires = currentExpires + (parseFloat(hours) * 3600 * 1000);
    
    updateUser(userId, { 
        subscription_expires: newExpires,
        subscription_tier: tier || user.subscription_tier || 1
    });
    
    console.log(`[Admin] ${req.user.username} added ${hours}h to ${user.username}`);
    
    res.json({ success: true, new_expires: newExpires });
});

// Clear warnings (admin only)
app.post('/api/admin/clear-warnings/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    updateUser(userId, { warnings: 0 });
    
    console.log(`[Admin] ${req.user.username} cleared warnings for ${user.username}`);
    
    res.json({ success: true });
});

// Reset user HWID (admin only)
app.post('/api/admin/reset-hwid/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const history = user.hwid_history || [];
    if (user.hwid) {
        history.push({ hwid: user.hwid, timestamp: Date.now(), action: 'admin_reset', admin: req.user.username });
    }
    
    updateUser(userId, { hwid: null, hwid_history: history });
    
    console.log(`[Admin] ${req.user.username} reset HWID for ${user.username}`);
    
    res.json({ success: true });
});

// Remove subscription entirely (admin only)
app.post('/api/admin/remove-subscription/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    updateUser(userId, { 
        subscription_tier: 0, 
        subscription_expires: 0 
    });
    
    // Remove Discord roles
    removeDiscordRoles(user.discord_id);
    
    console.log(`[Admin] ${req.user.username} removed subscription for ${user.username}`);
    
    res.json({ success: true });
});

// Remove hours from subscription (admin only)
app.post('/api/admin/remove-hours/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { hours } = req.body;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const hoursToRemove = parseFloat(hours) || 0;
    if (hoursToRemove <= 0) {
        return res.status(400).json({ error: 'Invalid hours' });
    }
    
    const msToRemove = hoursToRemove * 3600 * 1000;
    let newExpires = (user.subscription_expires || 0) - msToRemove;
    
    // If expires in the past, set to 0 (subscription ended)
    if (newExpires < Date.now()) {
        newExpires = 0;
        updateUser(userId, { 
            subscription_expires: 0,
            subscription_tier: 0
        });
    } else {
        updateUser(userId, { subscription_expires: newExpires });
    }
    
    const hoursRemaining = Math.max(0, (newExpires - Date.now()) / 3600000).toFixed(1);
    
    console.log(`[Admin] ${req.user.username} removed ${hoursToRemove}h from ${user.username} (${hoursRemaining}h left)`);
    
    res.json({ success: true, hours_remaining: hoursRemaining });
});

// ============================================================
// PAUSE SYSTEM (admin only)
// ============================================================

// Get pause status
app.get('/api/admin/pause-status', requireAdmin, (req, res) => {
    res.json({ 
        global_paused: db.global_paused || false,
        sales_closed: db.sales_closed || false,
        paused_users: db.users.filter(u => u.paused).map(u => u.id)
    });
});

// Toggle sales (open/close)
app.post('/api/admin/toggle-sales', requireAdmin, (req, res) => {
    db.sales_closed = !db.sales_closed;
    saveDB(db);
    
    console.log(`[Admin] ${req.user.username} ${db.sales_closed ? 'CLOSED' : 'OPENED'} subscription sales`);
    
    res.json({ 
        success: true, 
        sales_closed: db.sales_closed,
        message: db.sales_closed ? 'Sales are now CLOSED' : 'Sales are now OPEN'
    });
});

// Get sales status (public)
app.get('/api/sales-status', (req, res) => {
    res.json({ sales_closed: db.sales_closed || false });
});

// Toggle global pause (pause ALL plans)
app.post('/api/admin/pause-all', requireAdmin, (req, res) => {
    db.global_paused = !db.global_paused;
    saveDB(db);
    
    console.log(`[Admin] ${req.user.username} ${db.global_paused ? 'PAUSED' : 'RESUMED'} all plans globally`);
    
    res.json({ 
        success: true, 
        global_paused: db.global_paused,
        message: db.global_paused ? 'All plans paused' : 'All plans resumed'
    });
});

// Toggle individual user pause
app.post('/api/admin/pause/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const newPausedState = !user.paused;
    
    if (newPausedState) {
        // PAUSING: Save the remaining time so it doesn't keep counting down
        const timeRemaining = Math.max(0, user.subscription_expires - Date.now());
        updateUser(userId, { 
            paused: true, 
            pause_locked: false,
            paused_time_remaining: timeRemaining,  // Store remaining ms
            paused_at: Date.now()
        });
        console.log(`[Admin] ${req.user.username} PAUSED plan for ${user.username} (${(timeRemaining / 3600000).toFixed(1)}h remaining frozen)`);
    } else {
        // UNPAUSING: Restore the subscription time from when it was paused
        const timeRemaining = user.paused_time_remaining || 0;
        const newExpires = Date.now() + timeRemaining;
        updateUser(userId, { 
            paused: false, 
            pause_locked: false,
            subscription_expires: newExpires,
            paused_time_remaining: null,
            paused_at: null
        });
        console.log(`[Admin] ${req.user.username} RESUMED plan for ${user.username} (restored ${(timeRemaining / 3600000).toFixed(1)}h)`);
    }
    
    res.json({ 
        success: true, 
        paused: newPausedState,
        message: newPausedState ? `${user.username}'s plan paused (time frozen)` : `${user.username}'s plan resumed (time restored)`
    });
});

// Lock ALL paused users at once (or all users if global pause is on)
app.post('/api/admin/lock-all-paused', requireAdmin, (req, res) => {
    // If global pause is on, lock ALL users with active subscriptions
    // Otherwise, only lock individually paused users
    let usersToLock;
    if (db.global_paused) {
        // Lock all users with active subscriptions who aren't already locked
        usersToLock = db.users.filter(u => u.subscription_tier > 0 && u.subscription_expires > Date.now() && !u.pause_locked);
    } else {
        usersToLock = db.users.filter(u => u.paused && !u.pause_locked);
    }
    
    if (usersToLock.length === 0) {
        return res.json({ success: false, error: 'No paused users to lock' });
    }
    
    let lockedCount = 0;
    usersToLock.forEach(user => {
        // Also set individual pause if global pause is on (so they stay paused when global is lifted)
        if (db.global_paused && !user.paused) {
            updateUser(user.id, { paused: true, pause_locked: true });
        } else {
            updateUser(user.id, { pause_locked: true });
        }
        lockedCount++;
    });
    
    console.log(`[Admin] ${req.user.username} locked ${lockedCount} paused users`);
    
    res.json({ 
        success: true, 
        message: `Locked ${lockedCount} paused user(s)`,
        locked_count: lockedCount
    });
});

// Lock/unlock pause (prevents user from requesting unpause)
app.post('/api/admin/lock-pause/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    
    const user = findUser({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (!user.paused) {
        return res.status(400).json({ error: 'User is not paused. Pause them first.' });
    }
    
    const newLockedState = !user.pause_locked;
    updateUser(userId, { pause_locked: newLockedState });
    
    console.log(`[Admin] ${req.user.username} ${newLockedState ? 'locked' : 'unlocked'} pause for ${user.username}`);
    
    res.json({ 
        success: true, 
        pause_locked: newLockedState,
        message: newLockedState ? `${user.username}'s pause is now locked` : `${user.username}'s pause is now unlocked`
    });
});

// ============================================================
// VPS TRACKING SYSTEM
// ============================================================

// Initialize VPS data
if (!db.vps_config) {
    db.vps_config = [
        { id: 1, name: 'VPS 1', bots: 25, enabled: true },
        { id: 2, name: 'VPS 2', bots: 25, enabled: true },
        { id: 3, name: 'VPS 3', bots: 25, enabled: true },
        { id: 4, name: 'VPS 4', bots: 25, enabled: true },
        { id: 5, name: 'VPS 5', bots: 25, enabled: true },
        { id: 6, name: 'VPS 6', bots: 25, enabled: true },
    ];
    saveDB(db);
}
if (!db.vps_status) db.vps_status = {};

// Bot reports its status (called by scanner script)
app.post('/api/vps/heartbeat', (req, res) => {
    const { vps_id, bot_id, status, api_key } = req.body;
    
    if (api_key !== process.env.SCANNER_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    if (!db.vps_status[vps_id]) {
        db.vps_status[vps_id] = {};
    }
    
    db.vps_status[vps_id][bot_id] = {
        status: status, // 'hopping' or 'idle'
        last_seen: Date.now()
    };
    
    // Clean up old bot entries (older than 2 minutes)
    const timeout = 120000;
    const now = Date.now();
    for (const vpsId in db.vps_status) {
        for (const botId in db.vps_status[vpsId]) {
            if (now - db.vps_status[vpsId][botId].last_seen > timeout) {
                delete db.vps_status[vpsId][botId];
            }
        }
    }
    
    res.json({ success: true });
});

// Get VPS status (for admin panel)
app.get('/api/admin/vps', requireAdmin, (req, res) => {
    const now = Date.now();
    const timeout = 60000; // 60 seconds timeout - bot is offline if no heartbeat in 60s
    
    const vpsData = db.vps_config.map(vps => {
        const botStatuses = db.vps_status[vps.id] || {};
        let hopping = 0;
        let idle = 0;
        let online = 0;
        
        // Count active bots (those that sent heartbeat recently)
        Object.values(botStatuses).forEach(bot => {
            if (bot && (now - bot.last_seen) <= timeout) {
                online++;
                if (bot.status === 'hopping') {
                    hopping++;
                } else {
                    idle++;
                }
            }
        });
        
        const expected = vps.bots;
        const offline = Math.max(0, expected - online);
        const hoppingPercent = online > 0 ? Math.round((hopping / online) * 100) : 0;
        const onlinePercent = expected > 0 ? Math.round((online / expected) * 100) : 0;
        
        return {
            id: vps.id,
            name: vps.name,
            bots: expected,
            enabled: vps.enabled,
            hopping,
            idle,
            offline,
            online,
            hoppingPercent,
            onlinePercent
        };
    });
    
    // Calculate totals
    const totals = vpsData.reduce((acc, vps) => {
        acc.totalBots += vps.bots;
        acc.hopping += vps.hopping;
        acc.idle += vps.idle;
        acc.offline += vps.offline;
        acc.online += vps.online;
        return acc;
    }, { totalBots: 0, hopping: 0, idle: 0, offline: 0, online: 0 });
    
    totals.hoppingPercent = totals.online > 0 ? Math.round((totals.hopping / totals.online) * 100) : 0;
    totals.onlinePercent = totals.totalBots > 0 ? Math.round((totals.online / totals.totalBots) * 100) : 0;
    
    res.json({ vps: vpsData, totals });
});

// Update VPS config (admin)
app.post('/api/admin/vps/:vpsId', requireAdmin, (req, res) => {
    const { vpsId } = req.params;
    const { name, bots, enabled } = req.body;
    
    const vps = db.vps_config.find(v => v.id === parseInt(vpsId));
    if (!vps) {
        return res.status(404).json({ error: 'VPS not found' });
    }
    
    if (name !== undefined) vps.name = name;
    if (bots !== undefined) vps.bots = parseInt(bots);
    if (enabled !== undefined) vps.enabled = enabled;
    
    saveDB(db);
    
    console.log(`[VPS] Updated VPS ${vpsId}: ${JSON.stringify(vps)}`);
    
    res.json({ success: true, vps });
});

// Add new VPS (admin)
app.post('/api/admin/vps', requireAdmin, (req, res) => {
    const { name, bots } = req.body;
    
    const newId = Math.max(...db.vps_config.map(v => v.id), 0) + 1;
    
    const newVps = {
        id: newId,
        name: name || `VPS ${newId}`,
        bots: parseInt(bots) || 25,
        enabled: true
    };
    
    db.vps_config.push(newVps);
    saveDB(db);
    
    console.log(`[VPS] Added new VPS: ${JSON.stringify(newVps)}`);
    
    res.json({ success: true, vps: newVps });
});

// Delete VPS (admin)
app.delete('/api/admin/vps/:vpsId', requireAdmin, (req, res) => {
    const { vpsId } = req.params;
    
    const index = db.vps_config.findIndex(v => v.id === parseInt(vpsId));
    if (index === -1) {
        return res.status(404).json({ error: 'VPS not found' });
    }
    
    db.vps_config.splice(index, 1);
    delete db.vps_status[vpsId];
    saveDB(db);
    
    console.log(`[VPS] Deleted VPS ${vpsId}`);
    
    res.json({ success: true });
});

// ============================================================
// MANUAL PAYMENT SYSTEM
// ============================================================

// Initialize pending payments array
if (!db.pending_payments) db.pending_payments = [];

// User submits a payment
app.post('/api/payment/submit', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    
    const { amount, txId, crypto } = req.body;
    
    if (!amount || amount < 1) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!txId || txId.length < 10) {
        return res.status(400).json({ error: 'Invalid transaction ID' });
    }
    
    // Check if txId already used
    const existingTx = db.pending_payments.find(p => p.txId === txId) || 
                       db.used_transactions?.includes(txId);
    if (existingTx) {
        return res.status(400).json({ error: 'This transaction ID has already been submitted' });
    }
    
    const payment = {
        id: Date.now().toString(),
        userId: req.user.id,
        discord_id: req.user.discord_id,
        username: req.user.username,
        amount: parseFloat(amount),
        txId: txId,
        crypto: crypto || 'btc',
        status: 'pending',
        submitted_at: Date.now()
    };
    
    db.pending_payments.push(payment);
    saveDB(db);
    
    console.log(`[Payment] ${req.user.username} submitted $${amount} payment (${crypto}) - TX: ${txId}`);
    
    res.json({ success: true, message: 'Payment submitted for verification' });
});

// Admin: Get pending payments
app.get('/api/admin/payments', requireAdmin, (req, res) => {
    const payments = db.pending_payments || [];
    res.json(payments.sort((a, b) => b.submitted_at - a.submitted_at));
});

// Admin: Approve payment
app.post('/api/admin/payments/:paymentId/approve', requireAdmin, (req, res) => {
    const { paymentId } = req.params;
    
    const paymentIndex = db.pending_payments.findIndex(p => p.id === paymentId);
    if (paymentIndex === -1) {
        return res.status(404).json({ error: 'Payment not found' });
    }
    
    const payment = db.pending_payments[paymentIndex];
    
    // Add balance to user
    const user = findUser({ id: payment.userId }) || findUser({ discord_id: payment.discord_id });
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    const newBalance = (user.balance || 0) + payment.amount;
    updateUser(user.id, { balance: newBalance });
    
    // Mark transaction as used
    if (!db.used_transactions) db.used_transactions = [];
    db.used_transactions.push(payment.txId);
    
    // Remove from pending
    db.pending_payments.splice(paymentIndex, 1);
    saveDB(db);
    
    console.log(`[Payment] ✅ APPROVED: ${payment.username} +$${payment.amount} (TX: ${payment.txId})`);
    
    res.json({ success: true, new_balance: newBalance });
});

// Admin: Deny payment
app.post('/api/admin/payments/:paymentId/deny', requireAdmin, (req, res) => {
    const { paymentId } = req.params;
    const { reason } = req.body;
    
    const paymentIndex = db.pending_payments.findIndex(p => p.id === paymentId);
    if (paymentIndex === -1) {
        return res.status(404).json({ error: 'Payment not found' });
    }
    
    const payment = db.pending_payments[paymentIndex];
    
    // Remove from pending
    db.pending_payments.splice(paymentIndex, 1);
    saveDB(db);
    
    console.log(`[Payment] ❌ DENIED: ${payment.username} $${payment.amount} - Reason: ${reason || 'Not specified'}`);
    
    res.json({ success: true });
});

// ============================================================
// JOINER API (for Roblox joiner script)
// ============================================================

// Validate key and get user info for joiner
app.get('/api/joiner/validate', (req, res) => {
    const { key, hwid, roblox_username } = req.query;
    
    if (!key) {
        return res.json({ valid: false, error: 'No key provided' });
    }
    
    // Check if HWID is banned
    if (hwid && isHWIDBanned(hwid)) {
        return res.json({ valid: false, error: 'BANNED: Your HWID has been permanently blocked.' });
    }
    
    const user = findUser({ license_key: key });
    
    if (!user) {
        return res.json({ valid: false, error: 'Invalid key! Get your key from ultranotifier.live' });
    }
    
    // Check warnings
    if ((user.warnings || 0) >= 2) {
        return res.json({ valid: false, error: 'BANNED: Your account received 2 warnings.' });
    }
    
    // Check subscription
    const isActive = user.subscription_expires > Date.now();
    if (!isActive) {
        return res.json({ valid: false, error: 'Subscription expired! Renew at ultranotifier.live' });
    }
    
    // Check pause
    if (db.global_paused || user.paused) {
        return res.json({ valid: false, error: 'Your subscription is currently paused.' });
    }
    
    // Check HWID
    if (user.hwid && user.hwid !== hwid) {
        return res.json({ valid: false, error: 'HWID mismatch. Reset HWID on website.' });
    }
    
    // Build updates object
    const updates = { last_active: Date.now() };
    
    // Set HWID if not set
    if (!user.hwid && hwid) {
        const history = user.hwid_history || [];
        history.push({ hwid: hwid, timestamp: Date.now(), action: 'joiner_set' });
        updates.hwid = hwid;
        updates.hwid_history = history;
    }
    
    // Always update Roblox username if provided
    if (roblox_username) {
        updates.roblox_username = roblox_username;
    }
    
    // Save updates
    updateUser(user.id, updates);
    console.log(`[Joiner] Validated: ${user.username} (Roblox: ${roblox_username || 'N/A'})`);
    
    const plan = PLANS[user.subscription_tier];
    const hoursLeft = ((user.subscription_expires - Date.now()) / 3600000).toFixed(1);
    
    res.json({
        valid: true,
        username: user.username,
        tier: user.subscription_tier,
        plan: plan?.name || 'None',
        minValue: plan?.minValue || 0,
        maxValue: plan?.maxValue || 0, // 0 means unlimited
        hoursLeft: hoursLeft,
        expires: user.subscription_expires
    });
});

// Get servers for joiner (from cloud storage)
app.get('/api/joiner/servers', (req, res) => {
    const { key } = req.query;
    
    // Validate key first
    const user = findUser({ license_key: key });
    if (!user) {
        return res.json({ error: 'Invalid key' });
    }
    
    const isActive = user.subscription_expires > Date.now();
    if (!isActive) {
        return res.json({ error: 'Subscription expired' });
    }
    
    const plan = PLANS[user.subscription_tier];
    const maxValue = plan?.maxValue || Infinity; // Each plan has a max cap
    
    // Return servers from database (scanners save here)
    const servers = db.servers || [];
    
    // Filter servers - ALL plans see from 0, but capped at their maxValue
    // Bronze (tier 1): 0 to 200M
    // Silver (tier 2): 0 to 400M
    // Gold (tier 3): 0 to 1B
    // Diamond (tier 4/5): 0 to infinity
    const filteredServers = servers.filter(s => s.bestValue <= maxValue);
    
    res.json({
        servers: filteredServers.slice(0, 20),
        minValue: 0,
        maxValue: maxValue === Infinity ? 'unlimited' : maxValue,
        plan: plan?.name
    });
});

// Banana bridge status (for debugging)
app.get('/api/banana/status', (req, res) => {
    res.json({
        connected: bananaWs && bananaWs.readyState === 1,
        wsState: bananaWs ? bananaWs.readyState : 'null',
        logsCount: bananaLiveLogs.length,
        recentLogs: bananaLiveLogs.slice(0, 3).map(l => ({
            name: l.bestName,
            value: l.bestValue,
            time: new Date(l.timestamp).toISOString()
        }))
    });
});

// Get live logs from Banana relay (for in-game display)
app.get('/api/joiner/live-logs', (req, res) => {
    const { key, limit } = req.query;
    
    // Validate key
    const user = findUser({ license_key: key });
    if (!user) {
        return res.json({ error: 'Invalid key' });
    }
    
    const isActive = user.subscription_expires > Date.now();
    if (!isActive) {
        return res.json({ error: 'Subscription expired' });
    }
    
    // Get plan's max value cap
    const plan = PLANS[user.subscription_tier];
    const maxValue = plan?.maxValue || Infinity;
    
    // Filter logs by user's plan cap (all plans see from 0 to their max)
    const filteredLogs = bananaLiveLogs.filter(log => log.bestValue <= maxValue);
    
    // Return live logs
    const maxLogs = Math.min(parseInt(limit) || 20, 50);
    
    res.json({
        logs: filteredLogs.slice(0, maxLogs),
        total: filteredLogs.length,
        maxValue: maxValue === Infinity ? 'unlimited' : maxValue,
        connected: bananaWs && bananaWs.readyState === 1
    });
});

// Scanner saves servers here
app.post('/api/joiner/servers', (req, res) => {
    const { api_key, server } = req.body;
    
    if (api_key !== process.env.SCANNER_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    if (!db.servers) db.servers = [];
    
    // Remove old entry for same jobId
    db.servers = db.servers.filter(s => s.jobId !== server.jobId);
    
    // Add new server at the beginning
    db.servers.unshift({
        ...server,
        timestamp: Date.now()
    });
    
    // Keep only last 50 servers, remove old ones (older than 30 min)
    const thirtyMinAgo = Date.now() - (30 * 60 * 1000);
    db.servers = db.servers
        .filter(s => s.timestamp > thirtyMinAgo)
        .slice(0, 50);
    
    saveDB(db);
    
    console.log(`[Joiner] Server saved: ${server.bestName} (${server.bestValue})`);
    
    res.json({ success: true, serverCount: db.servers.length });
});

// ============================================================
// ESP SYSTEM - Track active Ultra users for in-game ESP
// ============================================================

// Heartbeat - client reports they're still active in a server
app.post('/api/joiner/heartbeat', (req, res) => {
    const { key, jobId, userId, username } = req.body;
    
    if (!key || !jobId || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate the license key
    const user = findUser({ license_key: key });
    if (!user) {
        return res.status(401).json({ error: 'Invalid license key' });
    }
    
    // Check if subscription is active
    const isActive = user.subscription_expires > Date.now();
    if (!isActive) {
        return res.status(401).json({ error: 'Subscription expired' });
    }
    
    // Create job entry if it doesn't exist
    if (!activeJoinerSessions[jobId]) {
        activeJoinerSessions[jobId] = {};
    }
    
    // Update or create user session
    activeJoinerSessions[jobId][userId] = {
        username: username || 'Unknown',
        lastSeen: Date.now()
    };
    
    res.json({ success: true });
});

// Get active Ultra users in a specific JobId
app.get('/api/joiner/active-users', (req, res) => {
    const { key, jobId, userId } = req.query;
    
    if (!key || !jobId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate the license key
    const user = findUser({ license_key: key });
    if (!user) {
        return res.status(401).json({ error: 'Invalid license key' });
    }
    
    // Get all users in this job (exclude the requesting user)
    const jobUsers = activeJoinerSessions[jobId] || {};
    const now = Date.now();
    
    const activeUsers = [];
    for (const odId in jobUsers) {
        // Skip the requesting user
        if (odId === userId) continue;
        
        // Skip stale sessions
        if (now - jobUsers[odId].lastSeen > SESSION_TIMEOUT) continue;
        
        activeUsers.push({
            userId: odId,
            username: jobUsers[odId].username
        });
    }
    
    res.json({ users: activeUsers });
});

// ============================================================
// BOT SERVER TRACKING (for scanner bots to avoid each other)
// ============================================================

if (!db.bot_servers) db.bot_servers = {};

// Get list of servers where bots are (for scanners to avoid)
app.get('/api/scanner/bot-servers', (req, res) => {
    const { api_key } = req.query;
    
    if (api_key !== process.env.SCANNER_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Clean old entries (older than 2 minutes)
    const twoMinAgo = Date.now() - (2 * 60 * 1000);
    for (const jobId in db.bot_servers) {
        if (db.bot_servers[jobId].timestamp < twoMinAgo) {
            delete db.bot_servers[jobId];
        }
    }
    
    // Return list of active bot servers
    const servers = Object.entries(db.bot_servers).map(([jobId, data]) => ({
        jobId,
        botId: data.botId,
        timestamp: data.timestamp
    }));
    
    res.json(servers);
});

// Register bot's current/target server
app.post('/api/scanner/bot-servers', (req, res) => {
    const { api_key, jobId, botId } = req.body;
    
    if (api_key !== process.env.SCANNER_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    if (!jobId) {
        return res.status(400).json({ error: 'Missing jobId' });
    }
    
    db.bot_servers[jobId] = {
        botId: botId || 'unknown',
        timestamp: Date.now()
    };
    
    // Clean old entries
    const twoMinAgo = Date.now() - (2 * 60 * 1000);
    for (const jid in db.bot_servers) {
        if (db.bot_servers[jid].timestamp < twoMinAgo) {
            delete db.bot_servers[jid];
        }
    }
    
    saveDB(db);
    
    res.json({ success: true, totalBotServers: Object.keys(db.bot_servers).length });
});

// Check pause status (for Roblox script to call)
app.get('/api/check-pause', (req, res) => {
    const { key, hwid } = req.query;
    
    // Check global pause first
    if (db.global_paused) {
        return res.json({ 
            paused: true, 
            reason: 'All plans are currently paused by admin',
            kick: true
        });
    }
    
    // Find user by key or hwid
    let user = null;
    if (key) user = findUser({ license_key: key });
    if (!user && hwid) user = findUser({ hwid });
    
    if (!user) {
        return res.json({ paused: false, reason: 'User not found' });
    }
    
    // Check individual pause
    if (user.paused) {
        return res.json({ 
            paused: true, 
            reason: 'Your plan has been paused by admin',
            kick: true
        });
    }
    
    res.json({ paused: false });
});

// ============================================================
// SERVE SCANNER SCRIPT (SECURE - requires valid key)
// ============================================================

app.get('/api/scanner/script', async (req, res) => {
    const { key, hwid, roblox_username } = req.query;
    
    if (!key) {
        return res.status(401).send('-- ERROR: No license key provided');
    }
    
    // Validate the license key
    const user = findUser({ license_key: key });
    if (!user) {
        return res.status(401).send('-- ERROR: Invalid license key\n-- Get your key at https://ultranotifier.live/dashboard');
    }
    
    // Check if subscription is active
    const isActive = user.subscription_expires > Date.now();
    if (!isActive) {
        return res.status(401).send('-- ERROR: Subscription expired\n-- Renew at https://ultranotifier.live/dashboard');
    }
    
    // Save HWID and Roblox username
    const updates = { last_active: Date.now() };
    if (hwid && !user.hwid) {
        updates.hwid = hwid;
    }
    if (roblox_username) {
        updates.roblox_username = roblox_username;
    }
    if (Object.keys(updates).length > 1) {
        updateUser(user.id, updates);
    }
    
    // Serve JOINER script from local file (stored in server folder for security)
    const joinerPath = path.join(__dirname, 'joiner.lua');
    
    try {
        const script = fs.readFileSync(joinerPath, 'utf8');
        res.setHeader('Content-Type', 'text/plain');
        res.send(script);
        console.log(`[Joiner] Script served to user: ${user.discord_username} (Roblox: ${roblox_username || 'N/A'})`);
    } catch (err) {
        console.error('[Joiner] Failed to read script:', err);
        res.status(500).send('-- ERROR: Server error loading script.');
    }
});

// ============================================================
// PAGES
// ============================================================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Clean loader URL - ultranotifier.live/j
app.get('/j', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(path.join(__dirname, 'public', 'loader.lua'));
});

// REMOVED: Direct joiner access - use /api/scanner/script with license key instead
// This was a security risk - anyone could download the script!

app.get('/dashboard', (req, res) => {
    if (!req.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin', (req, res) => {
    if (!req.user || !isAdmin(req.user)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/config', (req, res) => {
    if (!req.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// ============================================================
// START SERVER
// ============================================================

// ============================================================
// EXPIRED SUBSCRIPTION CHECKER (runs every 5 minutes)
// ============================================================

setInterval(async () => {
    const now = Date.now();
    
    // Find users whose subscription just expired (in last 5 minutes)
    const expiredUsers = db.users.filter(u => 
        u.subscription_tier > 0 && 
        u.subscription_expires > 0 && 
        u.subscription_expires < now &&
        u.subscription_expires > (now - 5 * 60 * 1000) // Expired in last 5 min
    );
    
    for (const user of expiredUsers) {
        // Remove their Discord role
        await removeDiscordRoles(user.discord_id);
        
        // Update their tier to 0
        updateUser(user.id, { subscription_tier: 0 });
        
        console.log(`[Expiry] ${user.username}'s subscription expired - removed roles`);
    }
}, 5 * 60 * 1000); // Every 5 minutes

// ============================================================
// BANANA RELAY BRIDGE - Forwards logs from Railway to Discord
// ============================================================

const WebSocket = require('ws');

const BANANA_CONFIG = {
    // Your Banana relay WebSocket URL from Railway
    relayUrl: process.env.BANANA_RELAY_URL || 'wss://web-production-3bf63.up.railway.app/ws',
    webhookMain: process.env.BANANA_WEBHOOK_MAIN || '',
    // Highlights: 100M - 999M
    webhookHighlights: 'https://discord.com/api/webhooks/1460653836845846579/zPkhSWxVf_HtWUgKXDiHO6qdmzvoCYbGUjJOs7IcjdjTB7QxAqDk2yhTRyaDUOYQWDSl',
    // Ultralights: 1B+
    webhookUltralights: 'https://discord.com/api/webhooks/1460653760014450729/_gP7Gd5ICIRRNONpNwBIfv7Slnvz7ToSvRhSObq_cpsA1C5wjUHQht7x4Po_qVIOv7_0',
    // Personal 1B+ alert webhook
    webhook1B: 'https://discord.com/api/webhooks/1430333154668974134/O6X4Zcf34HedyfgVKeTta6rz3FGwoCmgkPv4lEF4Q8foXD0klsUW90bMLsVV9teRkRGX',
    enabled: true // Always enabled - stores logs for in-game even without webhooks
};

console.log('[Banana Config] Relay URL:', BANANA_CONFIG.relayUrl);
console.log('[Banana Config] Webhook Main:', BANANA_CONFIG.webhookMain ? 'SET' : 'NOT SET');

let bananaWs = null;
let bananaReconnectAttempts = 0;
let bananaLiveLogs = []; // Store last 50 live logs for in-game clients
const MAX_BANANA_LOGS = 50;

// ============================================================
// ACTIVE JOINER SESSIONS (for ESP between Ultra users)
// ============================================================
// Track users running the joiner script by JobId
// Structure: { jobId: { odId: { username, lastSeen }, ... } }
let activeJoinerSessions = {};
const SESSION_TIMEOUT = 30000; // 30 seconds - consider user gone if no heartbeat

// Clean up stale sessions every 15 seconds
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const jobId in activeJoinerSessions) {
        for (const odId in activeJoinerSessions[jobId]) {
            if (now - activeJoinerSessions[jobId][odId].lastSeen > SESSION_TIMEOUT) {
                delete activeJoinerSessions[jobId][odId];
                cleaned++;
            }
        }
        // Remove empty job entries
        if (Object.keys(activeJoinerSessions[jobId]).length === 0) {
            delete activeJoinerSessions[jobId];
        }
    }
    
    if (cleaned > 0) {
        console.log(`[ESP] Cleaned ${cleaned} stale sessions`);
    }
}, 15000);

function formatBananaNumber(n) {
    if (n >= 1e15) return (n / 1e15).toFixed(1) + 'q';
    if (n >= 1e12) return (n / 1e12).toFixed(1) + 't';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'b';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return n.toString();
}

// Get thumbnail image for an animal
const THUMBNAIL_CACHE = {
    "Mieteteira Bicicleteira": "https://static.wikia.nocookie.net/stealabr/images/8/86/Mieteteira_Bicicleteira.png",
    "Strawberry Elephant": "https://static.wikia.nocookie.net/pet-simulator-99/images/a/a5/Strawberry_Elephant.png",
    "Tralalero Tralala": "https://static.wikia.nocookie.net/pet-simulator-99/images/t/t1/Tralalero_Tralala.png",
    "Tung Tung Tung Sahur": "https://static.wikia.nocookie.net/pet-simulator-99/images/t/tu/Tung_Tung_Tung_Sahur.png",
    "Bombardiro Crocodilo": "https://static.wikia.nocookie.net/pet-simulator-99/images/b/bo/Bombardiro_Crocodilo.png",
    "Brr Brr Patapim": "https://static.wikia.nocookie.net/pet-simulator-99/images/b/br/Brr_Brr_Patapim.png",
    "La Vaca Saturno Saturnita": "https://static.wikia.nocookie.net/pet-simulator-99/images/l/la/La_Vaca_Saturno_Saturnita.png",
};

const WIKI_BASE = "https://static.wikia.nocookie.net/pet-simulator-99/images/";

function getAnimalThumbnail(animalName) {
    if (!animalName) return null;
    
    // Check cache first
    if (THUMBNAIL_CACHE[animalName]) {
        return THUMBNAIL_CACHE[animalName];
    }
    
    // Generate URL from name
    const formatted = animalName.replace(/ /g, '_');
    const firstLetter = formatted.charAt(0).toLowerCase();
    const secondLetter = formatted.substring(0, 2).toLowerCase();
    
    return `${WIKI_BASE}${firstLetter}/${secondLetter}/${formatted}.png`;
}

// Store banana log for in-game clients
function storeBananaLog(scanData) {
    const animals = scanData.animals || [];
    if (animals.length === 0) return;
    
    const best = animals[0];
    const logEntry = {
        jobId: scanData.jobId || 'Unknown',
        players: scanData.players || '?',
        owners: scanData.owners || 'Unknown',
        bestName: best.name || 'Unknown',
        bestValue: best.genValue || best.value || 0,
        animalCount: animals.length,
        timestamp: Date.now(),
        animals: animals.slice(0, 5).map(a => ({
            name: a.name,
            value: a.genValue || a.value || 0,
            mutation: a.mutation,
            traits: a.traits
        }))
    };
    
    // Add to front of array (newest first)
    bananaLiveLogs.unshift(logEntry);
    
    // Keep only last 50
    if (bananaLiveLogs.length > MAX_BANANA_LOGS) {
        bananaLiveLogs = bananaLiveLogs.slice(0, MAX_BANANA_LOGS);
    }
    
    console.log(`[Banana Bridge] Stored log: ${logEntry.bestName} - ${formatBananaNumber(logEntry.bestValue)}/s (${bananaLiveLogs.length} total)`);
}

async function sendBananaToDiscord(data) {
    const animals = data.animals || [];
    if (animals.length === 0) return;
    
    // Get best animal (first one, sorted by value)
    const best = animals[0];
    const bestValue = best.genValue || best.value || 0;
    const jobId = data.jobId || 'Unknown';
    const players = data.players || '?';
    const owners = data.owners || 'Unknown';
    
    // Check if we have any webhooks to send to
    const hasHighlightsWebhook = bestValue >= 1e8 && bestValue < 1e9 && BANANA_CONFIG.webhookHighlights;
    const hasUltralightsWebhook = bestValue >= 1e9 && BANANA_CONFIG.webhookUltralights;
    const hasPersonalWebhook = bestValue >= 1e9 && BANANA_CONFIG.webhook1B;
    const hasMainWebhook = BANANA_CONFIG.webhookMain && BANANA_CONFIG.webhookMain !== 'YOUR_DISCORD_WEBHOOK_FOR_BANANA_LOGS';
    
    if (!hasHighlightsWebhook && !hasUltralightsWebhook && !hasPersonalWebhook && !hasMainWebhook) {
        console.log('[Banana Bridge] No matching webhooks for this value, skipping...');
        return;
    }
    
    // Build embed description
    const lines = animals.slice(0, 15).map((a, i) => {
        let line = `${i + 1}. ${a.name || 'Unknown'} — $${formatBananaNumber(a.genValue || a.value || 0)}/s`;
        if (a.mutation && a.mutation !== 'None') line += ` [${a.mutation}]`;
        if (a.traits) line += ` (${a.traits} traits)`;
        return line;
    });
    
    if (animals.length > 15) {
        lines.push(`... and ${animals.length - 15} more`);
    }
    
    // Color based on value
    let embedColor = 0xFFD700; // Gold for 100M+
    if (bestValue >= 1e12) embedColor = 0xFF00FF; // Purple for 1T+
    else if (bestValue >= 1e9) embedColor = 0x00FFFF; // Cyan for 1B+
    
    // Get thumbnail image for the best animal
    const thumbnailUrl = getAnimalThumbnail(best.name);
    
    // HIGHLIGHTS embed (100M-999M) - NO Job ID
    const highlightsPayload = {
        embeds: [{
            title: `🔥 ${best.name || 'Scan'} — $${formatBananaNumber(bestValue)}/s`,
            description: `**🐾 Brainrots Found**\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
            color: embedColor,
            thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
            fields: [
                { name: '👥 Players', value: `\`\`\`${players}\`\`\``, inline: true },
                { name: '👤 Owner', value: `\`\`\`${owners}\`\`\``, inline: true }
            ],
            footer: { text: '⚡ Ultra Notifier | Highlights' },
            timestamp: new Date().toISOString()
        }]
    };
    
    // ULTRALIGHTS embed (1B+) - WITH Job ID
    const ultralightsPayload = {
        embeds: [{
            title: `💎 ${best.name || 'Scan'} — $${formatBananaNumber(bestValue)}/s`,
            description: `**🐾 Brainrots Found**\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
            color: embedColor,
            thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
            fields: [
                { name: '👥 Players', value: `\`\`\`${players}\`\`\``, inline: true },
                { name: '🆔 Job ID', value: `\`\`\`${jobId}\`\`\``, inline: true },
                { name: '👤 Owner', value: `\`\`\`${owners}\`\`\``, inline: false }
            ],
            footer: { text: '⚡ Ultra Notifier | Ultralights' },
            timestamp: new Date().toISOString()
        }]
    };
    
    // Send to HIGHLIGHTS (100M-999M) - NO Job ID
    if (bestValue >= 1e8 && bestValue < 1e9 && BANANA_CONFIG.webhookHighlights) {
        try {
            await fetch(BANANA_CONFIG.webhookHighlights, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(highlightsPayload)
            });
            console.log(`[Banana Bridge] Sent to Highlights: ${best.name} - $${formatBananaNumber(bestValue)}/s`);
        } catch (err) {
            console.error('[Banana Bridge] Highlights webhook error:', err.message);
        }
    }
    
    // Send to ULTRALIGHTS (1B+) - WITH Job ID
    if (bestValue >= 1e9 && BANANA_CONFIG.webhookUltralights) {
        try {
            await fetch(BANANA_CONFIG.webhookUltralights, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ultralightsPayload)
            });
            console.log(`[Banana Bridge] Sent to Ultralights: ${best.name} - $${formatBananaNumber(bestValue)}/s`);
        } catch (err) {
            console.error('[Banana Bridge] Ultralights webhook error:', err.message);
        }
    }
    
    // Send to personal 1B+ webhook - WITH Job ID
    if (bestValue >= 1e9 && BANANA_CONFIG.webhook1B) {
        try {
            await fetch(BANANA_CONFIG.webhook1B, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ultralightsPayload)
            });
            console.log(`[Banana Bridge] Sent to Personal 1B+: ${best.name} - $${formatBananaNumber(bestValue)}/s`);
        } catch (err) {
            console.error('[Banana Bridge] Personal webhook error:', err.message);
        }
    }
    
    // Send to main webhook if configured
    if (BANANA_CONFIG.webhookMain && BANANA_CONFIG.webhookMain !== 'YOUR_DISCORD_WEBHOOK_FOR_BANANA_LOGS') {
        const mainPayload = bestValue >= 1e9 ? ultralightsPayload : highlightsPayload;
        try {
            await fetch(BANANA_CONFIG.webhookMain, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(mainPayload)
            });
            console.log(`[Banana Bridge] Sent to Main: ${best.name} - $${formatBananaNumber(bestValue)}/s`);
        } catch (err) {
            console.error('[Banana Bridge] Main webhook error:', err.message);
        }
    }
}

function connectBananaRelay() {
    if (!BANANA_CONFIG.enabled) {
        console.log('[Banana Bridge] Disabled - set BANANA_CONFIG.enabled = true to enable');
        return;
    }
    
    // Note: We connect even without webhooks to store logs for in-game display
    if (!BANANA_CONFIG.webhookMain) {
        console.log('[Banana Bridge] No Discord webhook - logs will only be stored for in-game display');
    }
    
    console.log('[Banana Bridge] Connecting to Railway relay: ' + BANANA_CONFIG.relayUrl);
    
    try {
        bananaWs = new WebSocket(BANANA_CONFIG.relayUrl);
        
        bananaWs.on('open', () => {
            console.log('🍌 [Banana Bridge] Connected to Railway relay!');
            bananaReconnectAttempts = 0;
        });
        
        bananaWs.on('message', async (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                
                // Handle different message types
                if (parsed.type === 'welcome') {
                    console.log(`[Banana Bridge] Connected! Server has ${parsed.cached_results} cached results`);
                    return;
                }
                
                if (parsed.type === 'cache') {
                    // Store cached results for in-game clients (but don't spam Discord)
                    const cacheData = parsed.data || [];
                    console.log(`[Banana Bridge] Received ${cacheData.length} cached results`);
                    
                    // Store up to 30 most recent cached results
                    const sorted = [...cacheData].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                    sorted.slice(0, 30).forEach(scan => {
                        if (scan.type === 'scan_result' && scan.animals && scan.animals.length > 0) {
                            storeBananaLog(scan);
                        }
                    });
                    return;
                }
                
                if (parsed.type === 'scan_result') {
                    // Live scan result!
                    const animals = parsed.animals || [];
                    console.log(`[Banana Bridge] Live scan: ${animals.length} animals, jobId: ${parsed.jobId}`);
                    
                    if (animals.length > 0) {
                        // Store for in-game clients FIRST (always)
                        storeBananaLog(parsed);
                        console.log(`[Banana Bridge] Stored! Total logs: ${bananaLiveLogs.length}`);
                        
                        // Then forward to Discord if webhook is set
                        if (BANANA_CONFIG.webhookMain) {
                            await sendBananaToDiscord(parsed);
                        }
                    }
                    return;
                }
                
                // Unknown format with animals - try to send anyway
                if (parsed.animals && parsed.animals.length > 0) {
                    await sendBananaToDiscord(parsed);
                }
            } catch (err) {
                console.error('[Banana Bridge] Parse error:', err.message);
            }
        });
        
        bananaWs.on('close', () => {
            console.log('[Banana Bridge] Disconnected from Railway relay');
            bananaReconnectAttempts++;
            const delay = Math.min(1000 * bananaReconnectAttempts, 30000);
            console.log(`[Banana Bridge] Reconnecting in ${delay}ms...`);
            setTimeout(connectBananaRelay, delay);
        });
        
        bananaWs.on('error', (err) => {
            console.error('[Banana Bridge] WebSocket error:', err.message);
        });
    } catch (err) {
        console.error('[Banana Bridge] Connection error:', err.message);
        setTimeout(connectBananaRelay, 5000);
    }
}

// Start Banana relay bridge after server starts
setTimeout(connectBananaRelay, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`⚡ Ultra Notifier running on http://localhost:${PORT}`);
    console.log('==========================================');
    console.log('📡 Waiting for real scanner data...');
    if (process.env.DISCORD_BOT_TOKEN) {
        console.log('🤖 Discord role bot enabled');
    }
    if (BANANA_CONFIG.enabled) {
        console.log('🍌 Banana relay bridge enabled');
    }
});
