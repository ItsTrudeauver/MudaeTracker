require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    REST, 
    Routes, 
    SlashCommandBuilder 
} = require('discord.js');
const { Pool } = require('pg');
const express = require('express');

// ==========================================
// 1. CONFIGURATION
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

const MUDAE_ID = '432610292342587392'; 
const CHECKMARK = '✅'; 

if (!TOKEN || !DATABASE_URL || !CLIENT_ID) {
    console.error("❌ CRITICAL ERROR: Missing .env variables.");
    process.exit(1);
}

// ==========================================
// 2. RENDER KEEPALIVE
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send(`Mudae Ledger is Online. Mode: ${isTrackingEnabled ? 'ON' : 'OFF'}`));
app.listen(PORT, () => console.log(`✅ Web server listening on port ${PORT}`));

// ==========================================
// 3. DATABASE
// ==========================================
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS debts (
                id SERIAL PRIMARY KEY,
                borrower_id VARCHAR(255),
                admin_id VARCHAR(255),
                amount_initial INTEGER,
                amount_remaining INTEGER,
                created_at TIMESTAMP,
                last_interest_at TIMESTAMP,
                status TEXT,
                note TEXT
            );
        `);
        console.log("✅ Database Schema Verified.");
    } catch (err) { console.error("DB Init Failed:", err); } 
    finally { client.release(); }
}

// ==========================================
// 4. CLIENT & STATE
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,       
        GatewayIntentBits.GuildMessageReactions 
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction] 
});

let isTrackingEnabled = true; 

// SEPARATE PENDING LISTS
// 1. LOANS: Key = MessageID (Waiting for Reaction)
const pendingLoans = new Map(); 
// 2. REPAYMENTS: Key = ChannelID (Waiting for Mudae Message)
const pendingRepayments = new Map();

// ==========================================
// 5. CORE LOGIC
// ==========================================
async function applyInterest() {
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT * FROM debts WHERE status='open'");
        const now = new Date();
        let updates = 0;

        for (const debt of res.rows) {
            const lastInterest = new Date(debt.last_interest_at);
            const diffTime = Math.abs(now - lastInterest);
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            const weeksPassed = Math.floor(diffDays / 7);

            if (weeksPassed > 0) {
                let newAmount = debt.amount_remaining;
                for (let i = 0; i < weeksPassed; i++) { newAmount = Math.ceil(newAmount * 1.05); }
                const newDate = new Date(lastInterest);
                newDate.setDate(newDate.getDate() + (weeksPassed * 7));

                await client.query(
                    "UPDATE debts SET amount_remaining=$1, last_interest_at=$2 WHERE id=$3",
                    [newAmount, newDate.toISOString(), debt.id]
                );
                updates++;
            }
        }
        if (updates > 0) console.log(`✅ Applied interest to ${updates} debts.`);
    } catch (err) { console.error("Interest Error:", err); } 
    finally { client.release(); }
}

async function logDebt(borrowerId, adminId, amount, note = "") {
    const client = await pool.connect();
    try {
        const now = new Date().toISOString();
        const res = await client.query(`
            INSERT INTO debts (borrower_id, admin_id, amount_initial, amount_remaining, created_at, last_interest_at, status, note)
            VALUES ($1, $2, $3, $3, $4, $4, 'open', $5)
            RETURNING id
        `, [borrowerId, adminId, amount, now, note]);
        return res.rows[0].id;
    } finally { client.release(); }
}

async function payDebt(borrowerId, amount) {
    const client = await pool.connect();
    try {
        const res = await client.query(
            "SELECT * FROM debts WHERE borrower_id=$1 AND status='open' ORDER BY created_at ASC",
            [borrowerId]
        );
        let remaining = amount;
        let logs = [];
        for (const debt of res.rows) {
            if (remaining <= 0) break;
            if (remaining >= debt.amount_remaining) {
                await client.query("UPDATE debts SET amount_remaining=0, status='paid' WHERE id=$1", [debt.id]);
                remaining -= debt.amount_remaining;
                logs.push(`✅ Debt #${debt.id} paid fully (${debt.amount_remaining}k).`);
            } else {
                const newAmt = debt.amount_remaining - remaining;
                await client.query("UPDATE debts SET amount_remaining=$1 WHERE id=$2", [newAmt, debt.id]);
                logs.push(`📉 Debt #${debt.id} reduced by ${remaining}k (Remaining: ${newAmt}k).`);
                remaining = 0;
            }
        }
        return logs;
    } finally { client.release(); }
}

// ==========================================
// 6. SLASH COMMANDS
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('debt_status').setDescription('Show active debts'),
    new SlashCommandBuilder().setName('debt_toggle').setDescription('Toggle tracking ON/OFF')
        .addStringOption(o => o.setName('mode').setDescription('ON/OFF').setRequired(true).addChoices({name:'ON',value:'on'},{name:'OFF',value:'off'})),
    new SlashCommandBuilder().setName('debt_add').setDescription('Manual debt add')
        .addUserOption(o => o.setName('user').setDescription('Borrower').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
        .addStringOption(o => o.setName('note').setDescription('Note')),
    new SlashCommandBuilder().setName('debt_delete').setDescription('Delete debt ID')
        .addIntegerOption(o => o.setName('id').setDescription('ID').setRequired(true))
].map(c => c.toJSON());

// ==========================================
// 7. LISTENERS
// ==========================================

client.once('ready', async () => {
    console.log(`🤖 Logged in as ${client.user.tag}`);
    await initDB();
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }); } catch(e){}

    await applyInterest();
    setInterval(applyInterest, 1000 * 60 * 60);

    // Garbage Collection (Every 1 min)
    setInterval(() => {
        const now = Date.now();
        // Clear Loans
        for (const [key, data] of pendingLoans) { if (now - data.timestamp > 300000) pendingLoans.delete(key); }
        // Clear Repayments
        for (const [key, data] of pendingRepayments) { if (now - data.timestamp > 300000) pendingRepayments.delete(key); }
    }, 60000);
});

// --- LISTENER 1: ADMIN MESSAGES (Triggers) ---
client.on('messageCreate', async message => {
    if (message.author.bot) return; // Wait, we handle Mudae separately below
    
    // A. IF ADMIN SPEAKS
    if (ADMIN_IDS.includes(message.author.id)) {
        if (!isTrackingEnabled) return;
        if (message.content.includes('#exempt')) return;

        const giveRegex = /^\$(givescrap|givekakera)\s+<@!?(\d+)>\s+(\d+)/i;
        const takeRegex = /^\$(kakeraremove|takekakera)\s+<@!?(\d+)>\s+(\d+)/i;

        // LOAN TRIGGER
        const giveMatch = message.content.match(giveRegex);
        if (giveMatch) {
            // Track by MESSAGE ID (Waiting for reaction on this msg)
            pendingLoans.set(message.id, {
                adminId: message.author.id,
                userId: giveMatch[2],
                amount: parseInt(giveMatch[3]),
                timestamp: Date.now()
            });
            return;
        }

        // REPAY TRIGGER
        const takeMatch = message.content.match(takeRegex);
        if (takeMatch) {
            // Track by CHANNEL ID (Waiting for next msg in this channel)
            pendingRepayments.set(message.channel.id, {
                adminId: message.author.id,
                userId: takeMatch[2],
                amount: parseInt(takeMatch[3]),
                timestamp: Date.now()
            });
            return;
        }
    }
});

// --- LISTENER 2: MUDAE MESSAGES (Repayment Confirmation) ---
client.on('messageCreate', async message => {
    // 1. Filter: Must be Mudae
    if (message.author.id !== MUDAE_ID) return;

    // 2. Filter: Must be in a channel where we are waiting for a repayment
    const pending = pendingRepayments.get(message.channel.id);
    if (!pending) return;

    // --- DEBUG LOGGING (Check your Render logs if this fails!) ---
    console.log(`🔍 Mudae spoke in pending channel. Content: "${message.content}"`);

    // 3. LOGIC: LOOSE PARSING
    // We don't care about formatting. We just look for the specific amount and the word "removed".
    const content = message.content.toLowerCase();
    
    // Check if the specific amount exists in the string (e.g. "1000")
    // We check `pending.amount` to ensure we don't trigger on random numbers.
    const hasAmount = content.includes(pending.amount.toString());
    const hasKeyword = content.includes('removed');

    if (hasAmount && hasKeyword) {
        console.log("✅ Match found! Processing repayment...");
        
        try {
            // Apply interest BEFORE payment to be fair
            await applyInterest();
            
            const logs = await payDebt(pending.userId, pending.amount);
            
            if (logs.length > 0) {
                await message.reply(`💸 **Repayment Confirmed:**\n${logs.join('\n')}`);
            } else {
                await message.reply(`❓ <@${pending.userId}> has no active debts.`);
            }
        } catch (err) {
            console.error("Payment Error:", err);
        } finally {
            // Clear the pending state so it doesn't trigger twice
            pendingRepayments.delete(message.channel.id);
            console.log("🧹 Pending repayment cleared.");
        }
    } else {
        console.log(`❌ Message ignored. Looking for "${pending.amount}" and "removed".`);
    }
});

// --- LISTENER 3: MUDAE REACTIONS (Loan Confirmation) ---
client.on('messageReactionAdd', async (reaction, user) => {
    if (reaction.partial) try { await reaction.fetch(); } catch (e) { return; }
    
    if (user.id !== MUDAE_ID) return;
    if (!isTrackingEnabled) return;
    if (reaction.emoji.name !== CHECKMARK && reaction.emoji.name !== 'white_check_mark') return;

    const action = pendingLoans.get(reaction.message.id);
    if (!action) return;

    try {
        await applyInterest();
        const debtId = await logDebt(action.userId, action.adminId, action.amount, "Verified by Mudae");
        await reaction.message.reply(`📉 **Confirmed:** Loan recorded. <@${action.userId}> borrowed **${action.amount}k** (ID: ${debtId}).`);
    } catch (e) { console.error(e); } 
    finally { pendingLoans.delete(reaction.message.id); }
});

// --- LISTENER 4: SLASH COMMANDS ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: "❌ Unauthorized.", ephemeral: true });

    if (interaction.commandName === 'debt_toggle') {
        isTrackingEnabled = (interaction.options.getString('mode') === 'on');
        await interaction.reply(`${isTrackingEnabled ? '🟢' : '🔴'} Tracking **${isTrackingEnabled?'ENABLED':'DISABLED'}**`);
    }

    else if (interaction.commandName === 'debt_status') {
        await applyInterest();
        const client = await pool.connect();
        try {
            const res = await client.query("SELECT * FROM debts WHERE status='open' ORDER BY borrower_id");
            let header = isTrackingEnabled ? "🟢 **ONLINE**" : "🔴 **PAUSED**";
            if (res.rows.length === 0) return interaction.reply(`${header}\nNo active debts.`);
            
            let report = `${header}\n**Active Debts:**\n`;
            for (const row of res.rows) {
                const next = new Date(new Date(row.last_interest_at).setDate(new Date(row.last_interest_at).getDate() + 7));
                const days = Math.ceil((next - new Date()) / (86400000));
                report += `🆔 \`${row.id}\` | <@${row.borrower_id}>: **${row.amount_remaining}k** | Interest in ${days}d\n`;
            }
            await interaction.reply(report);
        } finally { client.release(); }
    }

    else if (interaction.commandName === 'debt_add') {
        const id = await logDebt(interaction.options.getUser('user').id, interaction.user.id, interaction.options.getInteger('amount'), interaction.options.getString('note')||"Manual");
        await interaction.reply(`✅ Added Debt #${id}`);
    }

    else if (interaction.commandName === 'debt_delete') {
        const client = await pool.connect();
        await client.query("DELETE FROM debts WHERE id=$1", [interaction.options.getInteger('id')]);
        client.release();
        await interaction.reply(`🗑️ Deleted Debt #${interaction.options.getInteger('id')}`);
    }
});

client.login(TOKEN);