import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static files from root directory & static assets folder
app.use(express.static(__dirname));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Custom request headers for API calls
const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
};

// Track account cooldowns (24-hour lockout memory map)
// Format: { accountIndex: timestampWhenCooldownExpires }
const accountCooldowns = {};
const COOLDOWN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 Hours

// Load all configured Cloudflare accounts dynamically (1 to 10)
function getAccounts() {
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    const id = process.env[`CF_ACCOUNT_ID_${i}`];
    const token = process.env[`CF_TOKEN_${i}`];
    if (id && token) {
      accounts.push({ index: i - 1, id, token, label: `Profile ${i}` });
    }
  }
  return accounts;
}

// Multi-account rotating Cloudflare AI call with 24-hour cooldown memory & failover
async function callCloudflare(prompt) {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    throw new Error('No Cloudflare accounts configured in environment variables.');
  }

  const now = Date.now();
  let attempts = 0;

  while (attempts < accounts.length) {
    // Find next available account that is NOT on 24-hour cooldown
    let selectedAccount = null;

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      // Check if cooldown has expired
      if (accountCooldowns[acc.index] && now > accountCooldowns[acc.index]) {
        delete accountCooldowns[acc.index]; // Clear expired cooldown
      }

      // If account is free of cooldown, pick it as default/next
      if (!accountCooldowns[acc.index]) {
        selectedAccount = acc;
        break;
      }
    }

    // If ALL accounts are currently on 24-hour cooldown
    if (!selectedAccount) {
      throw new Error('All 10 Cloudflare account profiles are currently exhausted on 24-hour cooldown. Please wait for resets.');
    }

    const model = '@cf/meta/llama-3.2-1b-instruct';
    const url = `https://api.cloudflare.com/client/v4/accounts/${selectedAccount.id}/ai/run/${model}`;

    try {
      console.log(`[Cluster Dispatch] Routing request through ${selectedAccount.label}...`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Authorization': `Bearer ${selectedAccount.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
        }),
      });

      const data = await response.json();

      // Check for rate limit (429) or quota/rate error messages
      if (response.status === 429 || (!data.success && JSON.stringify(data.errors).toLowerCase().includes('rate'))) {
        console.warn(`[Rate Limit] ${selectedAccount.label} hit limit. Locking out for 24 hours and rotating...`);
        accountCooldowns[selectedAccount.index] = Date.now() + COOLDOWN_DURATION_MS;
        attempts++;
        continue;
      }

      if (!data.success) {
        throw new Error(JSON.stringify(data.errors));
      }

      // Success! Return generated response
      return data.result.response;

    } catch (error) {
      console.error(`[Cluster Error] ${selectedAccount.label} failed: ${error.message}`);
      accountCooldowns[selectedAccount.index] = Date.now() + COOLDOWN_DURATION_MS;
      attempts++;
      if (attempts >= accounts.length) {
        throw new Error(`All active accounts failed. Last error: ${error.message}`);
      }
    }
  }

  throw new Error('All Cloudflare accounts are currently rate-limited or locked out.');
}

// REST AI endpoint
app.post('/api/ask', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  try {
    const result = await callCloudflare(prompt);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket connection handling with Idle detection & Heartbeat
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes Idle threshold to avoid token/resource cost

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => {
        ws.lastActivity = Date.now(); // Update activity timestamp on interaction
        try {
            const parsed = JSON.parse(message.toString());
            const prompt = parsed.prompt;
            if (!prompt) {
                ws.send(JSON.stringify({ error: 'Prompt is required.' }));
                return;
            }

            const result = await callCloudflare(prompt);
            ws.send(JSON.stringify({ success: true, result }));
        } catch (error) {
            ws.send(JSON.stringify({ success: false, error: error.message }));
        }
    });

    // Idle check interval per connection
    const idleCheck = setInterval(() => {
        if (Date.now() - ws.lastActivity > IDLE_TIMEOUT_MS) {
            ws.send(JSON.stringify({ systemInfo: 'Connection entering IDLE state due to inactivity to conserve cluster resources.' }));
        }
    }, 60000);

    ws.on('close', () => {
        clearInterval(idleCheck);
    });
});

// Global Heartbeat interval to keep connections alive
const interval = setInterval(() => {
    wss.clients.forEach((client) => {
        if (client.isAlive === false) return client.terminate();
        client.isAlive = false;
        client.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cluster Sync Engine Backend running on port ${PORT}`));
