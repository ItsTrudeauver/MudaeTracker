require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');

// --- 1. RENDER COMPATIBILITY (The Fake Web Server) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Mudae Debt Tracker is running.');
});

app.listen(PORT, () => {
    console.log(`✅ Web server listening on port ${PORT}`);
});

// --- CONFIGURATION ---
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const databaseUrl = process.env.DATABASE_URL;
const adminIds = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!token || !databaseUrl || !clientId) {
    console.error("❌ Missing .env variables.");
    process.exit(1);
}

// --- DATABASE SETUP (With SSL for Cloud) ---
const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false // Required for Neon/Render/Cockroach
    }
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
        console.log("✅ Database Table Verified.");
    } catch (err) {
        console.error("❌ DB Init Failed:", err);
    } finally {
        client.release();
    }
}

// --- DISCORD CLIENT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- INTEREST LOGIC (The "Notary" Math) ---
// This logic is safe even if Render puts the bot to sleep.
// It calculates interest based on the DATE, not a timer.
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

                // Update timestamp exact weeks forward
                const newDate = new Date(lastInterest);
                newDate.setDate(newDate.getDate() + (weeksPassed * 7));

                await client.query(
                    "UPDATE debts SET amount_remaining=$1, last_interest_at=$2 WHERE id=$3",
                    [newAmount, newDate.toISOString(), debt.id]
                );
                console.log(`📈 Debt #${debt.id}: +${weeksPassed} weeks interest.`);
                updates++;
            }
        }
        if (updates > 0) console.log(`✅ Interest updated for ${updates} debts.`);
    } catch (err) {
        console.error("Interest Error:", err);
    } finally {
        client.release();
    }
}

// --- TRANSACTION FUNCTIONS ---
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

// --- COMMANDS ---
const commands = [
    new SlashCommandBuilder().setName('debt_status').setDescription('Show all active debts'),
    new SlashCommandBuilder().setName('debt_add').setDescription('Manually add debt')
        .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true))
        .addStringOption(opt => opt.setName('note').setDescription('Note')),
    new SlashCommandBuilder().setName('debt_delete').setDescription('Delete a debt ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('Debt ID').setRequired(true))
].map(c => c.toJSON());

// --- EVENTS ---
client.once('ready', async () => {
    await initDB();
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(token);
    try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        console.log('✅ Commands Registered');
    } catch (e) { console.error(e); }

    // Run interest check on startup (Safe against Render spin-downs)
    await applyInterest();
    // Then try every hour (if bot stays alive)
    setInterval(applyInterest, 1000 * 60 * 60);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !adminIds.includes(message.author.id)) return;
    if (message.content.toLowerCase().includes('#exempt')) return;

    // Regex: Matches $givescrap or $givekakera | $kakeraremove or $takekakera
    const giveRegex = /^\$(givescrap|givekakera)\s+<@!?(\d+)>\s+(\d+)/i;
    const takeRegex = /^\$(kakeraremove|takekakera)\s+<@!?(\d+)>\s+(\d+)/i;

    // ADD DEBT
    const giveMatch = message.content.match(giveRegex);
    if (giveMatch) {
        const userId = giveMatch[2];
        const amount = parseInt(giveMatch[3]);
        // Trigger interest update BEFORE adding new debt to keep timestamps clean
        await applyInterest(); 
        const debtId = await logDebt(userId, message.author.id, amount, "Auto-detected");
        
        await message.react('📝');
        await message.channel.send(`📉 **Debt Recorded:** <@${userId}> borrowed **${amount}k** (ID: ${debtId}).`);
        return;
    }

    // PAY DEBT
    const takeMatch = message.content.match(takeRegex);
    if (takeMatch) {
        const userId = takeMatch[2];
        const amount = parseInt(takeMatch[3]);
        // Trigger interest update BEFORE payment to ensure they pay the current owed amount
        await applyInterest();
        const logs = await payDebt(userId, amount);
        
        await message.react('💸');
        if (logs.length > 0) {
            await message.channel.send(`**Repayment Recorded:**\n${logs.join('\n')}`);
        } else {
            await message.channel.send(`❓ <@${userId}> has no active debts.`);
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!adminIds.includes(interaction.user.id)) return interaction.reply({content:"❌ Unauthorized", ephemeral:true});

    // Update interest before showing status
    if (interaction.commandName === 'debt_status') {
        await applyInterest(); // Ensure report is up to the second
        const client = await pool.connect();
        const res = await client.query("SELECT * FROM debts WHERE status='open' ORDER BY borrower_id");
        client.release();

        if (res.rows.length === 0) return interaction.reply("No active debts.");

        let report = "**Active Debts:**\n";
        for (const row of res.rows) {
            const last = new Date(row.last_interest_at);
            const next = new Date(last);
            next.setDate(next.getDate() + 7);
            const daysUntil = Math.ceil((next - new Date()) / (1000 * 60 * 60 * 24));
            report += `🆔 \`${row.id}\` | <@${row.borrower_id}>: **${row.amount_remaining}k** | Interest in ${daysUntil}d\n`;
        }
        await interaction.reply(report);
    } 
    
    else if (interaction.commandName === 'debt_add') {
        const user = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const note = interaction.options.getString('note') || "";
        const id = await logDebt(user.id, interaction.user.id, amount, note);
        await interaction.reply(`✅ Created Debt #${id} for ${user}: ${amount}k`);
    }

    else if (interaction.commandName === 'debt_delete') {
        const id = interaction.options.getInteger('id');
        const client = await pool.connect();
        await client.query("DELETE FROM debts WHERE id=$1", [id]);
        client.release();
        await interaction.reply(`🗑️ Deleted Debt #${id}.`);
    }
});

client.login(token);