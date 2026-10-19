import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static files (like your index.html) from the root directory
app.use(express.static(__dirname));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Custom request headers for API calls
const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
};

// Load all configured Cloudflare accounts dynamically from environment variables (1 to 10)
function getAccounts() {
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    const id = process.env[`CF_ACCOUNT_ID_${i}`];
    const token = process.env[`CF_TOKEN_${i}`];
    if (id && token) {
      accounts.push({ id, token });
    }
  }
  return accounts;
}

let currentAccountIndex = 0;

// Multi-account rotating Cloudflare AI call with smart rate-limit failover
async function callCloudflare(prompt) {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    throw new Error('No Cloudflare accounts configured in environment variables.');
  }

  let attempts = 0;

  while (attempts < accounts.length) {
    const account = accounts[currentAccountIndex];
    const model = '@cf/meta/llama-3.2-1b-instruct';
    const url = `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/${model}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Authorization': `Bearer ${account.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
        }),
      });

      const data = await response.json();

      // Check for rate limit (429) or rate limit error messages
      if (response.status === 429 || (!data.success && JSON.stringify(data.errors).toLowerCase().includes('rate'))) {
        console.warn(`Account index ${currentAccountIndex} hit rate limit. Auto-switching...`);
        currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
        attempts++;
        continue;
      }

      if (!data.success) {
        throw new Error(JSON.stringify(data.errors));
      }

      // Success, rotate index for next request
      currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
      return data.result.response;

    } catch (error) {
      attempts++;
      currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
      if (attempts >= accounts.length) {
        throw new Error(`All accounts failed. Last error: ${error.message}`);
      }
    }
  }

  throw new Error('All Cloudflare accounts are currently rate-limited.');
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

// WebSocket connection handling with heartbeat
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => {
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
});

// Heartbeat interval to keep connections alive
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
