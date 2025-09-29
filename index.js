// index.js
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { google } from 'googleapis';

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'VC_Roster';
const GOOGLE_CREDS_PATH = process.env.GOOGLE_CREDS_PATH;
const TARGET_CHANNEL_IDS = process.env.TARGET_CHANNEL_IDS
  ? process.env.TARGET_CHANNEL_IDS.split(',').map(id => id.trim())
  : [];

if (!BOT_TOKEN || !SPREADSHEET_ID || !GOOGLE_CREDS_PATH || TARGET_CHANNEL_IDS.length === 0) {
  console.error('Missing required environment variables!');
  process.exit(1);
}

// --- Google Sheets setup ---
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_CREDS_PATH,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- Queue to serialize sheet operations ---
let opQueue = Promise.resolve();
function enqueue(fn) {
  opQueue = opQueue.then(() => fn()).catch(console.error);
  return opQueue;
}

// --- In-memory set to track current members ---
const trackedUsers = new Set();

// --- Sheet helpers ---
async function ensureHeader() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:A1`,
  }).catch(() => ({ data: {} }));

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Username']] },
    });
    console.log('Sheet header initialized.');
  }
}

async function getAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:A`,
  }).catch(() => ({ data: {} }));

  return res.data.values || [];
}

async function updateSheetFromSet() {
  // Convert set to array
  let values = Array.from(trackedUsers).map(name => [name]);

  // Remove duplicates just in case
  const unique = [];
  const seen = new Set();
  for (const row of values) {
    if (!seen.has(row[0])) {
      seen.add(row[0]);
      unique.push(row);
    }
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:A`,
  });

  if (unique.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: unique },
    });
  }

  console.log('Sheet updated.');
}

// --- Debounced sheet update ---
let pendingUpdate = false;
function enqueueUpdateSheet() {
  if (pendingUpdate) return;
  pendingUpdate = true;
  enqueue(async () => {
    await updateSheetFromSet();
    pendingUpdate = false;
  });
}

// --- Initial sync ---
async function syncAllChannels(client) {
  await ensureHeader();

  trackedUsers.clear();

  for (const channelId of TARGET_CHANNEL_IDS) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.members) continue;

    for (const member of channel.members.values()) {
      const displayName =
        member.displayName ||
        member.nickname ||
        member.user.username.split('#')[0];

      trackedUsers.add(displayName);
    }
  }

  enqueueUpdateSheet();
  console.log('Initial sync complete.');
}

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}.`);
  await syncAllChannels(client);
});

// --- Voice state updates ---
client.on('voiceStateUpdate', async (oldState, newState) => {
  const oldId = oldState.channelId;
  const newId = newState.channelId;

  // --- User joined a tracked channel ---
  if (TARGET_CHANNEL_IDS.includes(newId) && oldId !== newId) {
    const member = newState.member;
    if (!member) return;

    const displayName =
      member.displayName ||
      member.nickname ||
      member.user.username.split('#')[0];

    trackedUsers.add(displayName);
    enqueueUpdateSheet();
  }

  // --- User left a tracked channel or moved out ---
  if (TARGET_CHANNEL_IDS.includes(oldId) && oldId !== newId) {
    let member = oldState.member;
    if (!member) {
      try {
        member = await oldState.guild.members.fetch(oldState.id);
      } catch {
        // fallback if member cannot be fetched
        member = { displayName: null, nickname: null, user: { username: oldState.id } };
      }
    }

    const displayName =
      member.displayName ||
      member.nickname ||
      member.user.username.split('#')[0];

    trackedUsers.delete(displayName);
    enqueueUpdateSheet();
  }
});

// --- Start bot ---
client.login(BOT_TOKEN).catch(console.error);
