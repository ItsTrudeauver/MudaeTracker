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

// IDS & CONSTANTS
const MUDAE_ID = '432610292342587392'; 
const CHECKMARK = '✅'; 

if (!TOKEN || !DATABASE_URL || !CLIENT_ID) {
    console.error("❌ CRITICAL ERROR: Missing .env variables.");
    process.exit(1);
}

// ==========================================
// 2. RENDER COMPATIBILITY
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`Mudae Debt Tracker is active. Tracking Mode: ${isTrackingEnabled ? 'ON' : 'OFF'}`);
});

app.listen(PORT, () => {
    console.log(`✅ Web server listening on port ${PORT}`);
});

// ==========================================
// 3. DATABASE SETUP
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
    } catch (err) {
        console.error("❌ Database Init Failed:", err);
    } finally {
        client.release();
    }
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

// --- GLOBAL STATE ---
let isTrackingEnabled = true; 
const pendingActions = new Map();

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
                for (let i = 0; i < weeksPassed; i++) {
                    newAmount = Math.ceil(newAmount * 1.05);
                }
                const newDate = new Date(lastInterest);
                newDate.setDate(newDate.getDate() + (weeksPassed * 7));

                await client.query(
                    "UPDATE debts SET amount_remaining=$1, last_interest_at=$2 WHERE id=$3",
                    [newAmount, newDate.toISOString(), debt.id]
                );
                updates++;
            }
        }
        if (updates > 0) console.log(`✅ Interest update complete for ${updates} debts.`);
    } catch (err) {
        console.error("Interest Logic Error:", err);
    } finally {
        client.release();
    }
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
    } finally {
        client.release();
    }
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
    } finally {
        client.release();
    }
}

// ==========================================
// 6. SLASH COMMANDS
// ==========================================
const commands = [
    new SlashCommandBuilder().setName('debt_status').setDescription('Show all active debts'),
    new SlashCommandBuilder().setName('debt_toggle').setDescription('Turn debt tracking ON or OFF (For mass giveaways)')
        .addStringOption(option => 
            option.setName('mode')
                .setDescription('Enable or Disable tracking')
                .setRequired(true)
                .addChoices({ name: 'ON', value: 'on' }, { name: 'OFF', value: 'off' })),
    new SlashCommandBuilder().setName('debt_add').setDescription('Manually add a debt')
        .addUserOption(opt => opt.setName('user').setDescription('The borrower').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true))
        .addStringOption(opt => opt.setName('note').setDescription('Optional note')),
    new SlashCommandBuilder().setName('debt_delete').setDescription('Delete a specific debt ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('Debt ID').setRequired(true))
].map(command => command.toJSON());

// ==========================================
// 7. LISTENERS
// ==========================================

client.once('ready', async () => {
    console.log(`🤖 Logged in as ${client.user.tag}`);
    await initDB();

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('✅ Slash Commands registered.');
    } catch (error) { console.error(error); }

    await applyInterest();
    setInterval(applyInterest, 1000 * 60 * 60);

    // Cleanup old pending actions
    setInterval(() => {
        const now = Date.now();
        for (const [msgId, data] of pendingActions.entries()) {
            if (now - data.timestamp > 300000) {
                pendingActions.delete(msgId);
                console.log(`🧹 Garbage Collected: Pending action ${msgId} expired.`);
            }
        }
    }, 60000);
});

// --- LISTENER 1: Catch Command (The Proposal) ---
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!ADMIN_IDS.includes(message.author.id)) return;
    
    // Global Switch
    if (!isTrackingEnabled) return; 

    if (message.content.toLowerCase().includes('#exempt')) return;

    const giveRegex = /^\$(givescrap|givekakera)\s+<@!?(\d+)>\s+(\d+)/i;
    const takeRegex = /^\$(kakeraremove|takekakera)\s+<@!?(\d+)>\s+(\d+)/i;

    const giveMatch = message.content.match(giveRegex);
    if (giveMatch) {
        console.log(`📝 Command detected ($givescrap). Waiting for Mudae reaction...`);
        pendingActions.set(message.id, {
            type: 'LOAN',
            adminId: message.author.id,
            userId: giveMatch[2],
            amount: parseInt(giveMatch[3]),
            timestamp: Date.now()
        });
        return; // <--- STRICT RETURN. NO DB WRITE HERE.
    }

    const takeMatch = message.content.match(takeRegex);
    if (takeMatch) {
        console.log(`📝 Command detected ($kakeraremove). Waiting for Mudae reaction...`);
        pendingActions.set(message.id, {
            type: 'REPAY',
            adminId: message.author.id,
            userId: takeMatch[2],
            amount: parseInt(takeMatch[3]),
            timestamp: Date.now()
        });
        return; // <--- STRICT RETURN. NO DB WRITE HERE.
    }
});

// --- LISTENER 2: Catch Reaction (The Verification) ---
client.on('messageReactionAdd', async (reaction, user) => {
    if (reaction.partial) {
        try { await reaction.fetch(); } catch (e) { return; }
    }
    
    // Debugging Logs
    if (user.id === MUDAE_ID && pendingActions.has(reaction.message.id)) {
        console.log(`👀 Mudae reacted with ${reaction.emoji.name}`);
    }

    if (user.id !== MUDAE_ID) return;
    if (reaction.emoji.name !== CHECKMARK && reaction.emoji.name !== 'white_check_mark') return;
    if (!isTrackingEnabled) return;

    const action = pendingActions.get(reaction.message.id);
    if (!action) return;

    console.log(`✅ Reaction verified. Executing DB Write for ${action.type}...`);

    try {
        if (action.type === 'LOAN') {
            await applyInterest();
            const debtId = await logDebt(action.userId, action.adminId, action.amount, "Verified by Mudae");
            await reaction.message.reply(`📉 **Confirmed:** Loan recorded. <@${action.userId}> borrowed **${action.amount}k** (ID: ${debtId}).`);
        } 
        else if (action.type === 'REPAY') {
            await applyInterest();
            const logs = await payDebt(action.userId, action.amount);
            if (logs.length > 0) await reaction.message.reply(`💸 **Confirmed:**\n${logs.join('\n')}`);
            else await reaction.message.reply(`❓ <@${action.userId}> has no active debts.`);
        }
    } catch (err) {
        console.error("Transaction Error:", err);
    } finally {
        pendingActions.delete(reaction.message.id);
    }
});

// --- LISTENER 3: Slash Commands ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: "❌ Unauthorized.", ephemeral: true });

    if (interaction.commandName === 'debt_toggle') {
        const mode = interaction.options.getString('mode');
        isTrackingEnabled = (mode === 'on');
        
        const statusEmoji = isTrackingEnabled ? '🟢' : '🔴';
        const statusText = isTrackingEnabled ? 'ENABLED' : 'DISABLED';
        
        console.log(`🔄 Tracking toggled to ${statusText}`);
        await interaction.reply(`${statusEmoji} **Debt Tracking is now ${statusText}.**\n${isTrackingEnabled ? 'Bot will record loans.' : 'Bot is sleeping. Mass distributions are safe.'}`);
    }

    else if (interaction.commandName === 'debt_status') {
        await applyInterest();
        const client = await pool.connect();
        try {
            const res = await client.query("SELECT * FROM debts WHERE status='open' ORDER BY borrower_id");
            let statusHeader = isTrackingEnabled ? "🟢 **System Status: ONLINE**" : "🔴 **System Status: PAUSED**";
            if (res.rows.length === 0) return interaction.reply(`${statusHeader}\nNo active debts.`);

            let report = `${statusHeader}\n**Active Debts:**\n`;
            for (const row of res.rows) {
                const last = new Date(row.last_interest_at);
                const next = new Date(last);
                next.setDate(next.getDate() + 7);
                const daysUntil = Math.ceil((next - new Date()) / (1000 * 60 * 60 * 24));
                report += `🆔 \`${row.id}\` | <@${row.borrower_id}>: **${row.amount_remaining}k** | Interest in ${daysUntil}d\n`;
            }
            await interaction.reply(report);
        } finally {
            client.release();
        }
    } 
    
    else if (interaction.commandName === 'debt_add') {
        const user = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const note = interaction.options.getString('note') || "Manual Entry";
        const id = await logDebt(user.id, interaction.user.id, amount, note);
        await interaction.reply(`✅ Manually created Debt #${id} for ${user}: ${amount}k`);
    }

    else if (interaction.commandName === 'debt_delete') {
        const id = interaction.options.getInteger('id');
        const client = await pool.connect();
        try {
            await client.query("DELETE FROM debts WHERE id=$1", [id]);
            await interaction.reply(`🗑️ Deleted Debt #${id}.`);
        } finally {
            client.release();
        }
    }
});

client.login(TOKEN);