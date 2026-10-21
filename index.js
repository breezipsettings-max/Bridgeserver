import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "your_shared_secret";

// Track site build version state for client refresh polling
let currentSiteVersion = Date.now().toString();

// Grab the raw body from incoming requests to safely verify the GitHub signature
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

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
    let selectedAccount = null;

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (accountCooldowns[acc.index] && now > accountCooldowns[acc.index]) {
        delete accountCooldowns[acc.index];
      }

      if (!accountCooldowns[acc.index]) {
        selectedAccount = acc;
        break;
      }
    }

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

      if (response.status === 429 || (!data.success && JSON.stringify(data.errors).toLowerCase().includes('rate'))) {
        console.warn(`[Rate Limit] ${selectedAccount.label} hit limit. Locking out for 24 hours and rotating...`);
        accountCooldowns[selectedAccount.index] = Date.now() + COOLDOWN_DURATION_MS;
        attempts++;
        continue;
      }

      if (!data.success) {
        throw new Error(JSON.stringify(data.errors));
      }

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

// Version Polling API Endpoint for live updates notification
app.get('/api/version', (req, res) => {
    res.json({ version: currentSiteVersion });
});

// Verification helper function ensuring requests only come from GitHub
function verifyGitHubSignature(req, res, next) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
        return res.status(401).send('Access Denied: Missing X-Hub-Signature-256 header');
    }

    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
        return next();
    } else {
        return res.status(401).send('Access Denied: Invalid signature verification failed.');
    }
}

// Route to listen for GitHub webhook events
app.post('/webhook', verifyGitHubSignature, (req, res) => {
    const githubEvent = req.headers['x-github-event'];
    const payload = req.body;

    console.log(`\n🔔 New Event Received: [${githubEvent ? githubEvent.toUpperCase() : 'UNKNOWN'}]`);

    // Handle standard code push events
    if (githubEvent === 'push') {
        const branch = payload.ref ? payload.ref.replace('refs/heads/', '') : '';
        const repo = payload.repository ? payload.repository.full_name : 'Unknown Repo';
        const commitMsg = payload.head_commit ? payload.head_commit.message : 'No commit message';
        const author = payload.head_commit && payload.head_commit.author ? payload.head_commit.author.username : 'Unknown';

        console.log(`🟢 Code pushed to ${repo} on branch [${branch}] by @${author}`);
        console.log(`💬 Message: "${commitMsg}"`);

        // If code is pushed to main branch, trigger application update version change and broadcast notice
        if (branch === 'main') {
            console.log('🚀 Triggering live site update notification pipeline...');
            currentSiteVersion = Date.now().toString();

            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ 
                        systemInfo: "Site is being Updated! Please refresh to apply the Updated Version!" 
                    }));
                }
            });
        }
    }

    // Handle Pull Request events
    if (githubEvent === 'pull_request') {
        const action = payload.action;
        const prNumber = payload.number;
        const prTitle = payload.pull_request ? payload.pull_request.title : '';
        const user = payload.pull_request && payload.pull_request.user ? payload.pull_request.user.login : 'Unknown';

        console.log(`🔹 Pull Request #${prNumber} was ${action} by @${user}`);
        console.log(`📋 Title: "${prTitle}"`);
    }

    // Handle issue creation or comments
    if (githubEvent === 'issues') {
        console.log(`⚠️ Issue #${payload.issue.number} was ${payload.action}: "${payload.issue.title}"`);
    }

    res.status(200).send('Webhook received and event logged successfully.');
});

// WebSocket connection handling with Idle detection & Heartbeat
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes Idle threshold

    ws.on('pong', () => { 
        ws.isAlive = true; 
    });

    ws.on('message', async (message) => {
        ws.lastActivity = Date.now();
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

    const idleCheck = setInterval(() => {
        if (Date.now() - ws.lastActivity > IDLE_TIMEOUT_MS) {
            ws.send(JSON.stringify({ systemInfo: 'Connection entering IDLE state due to inactivity to conserve cluster resources.' }));
        }
    }, 60000);

    ws.on('close', () => {
        clearInterval(idleCheck);
    });
});

// Heartbeat ping interval (Every 20s to stay well within Render's 30s timeout)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 20000);

server.listen(PORT, () => console.log(`🚀 Cluster Sync Engine Backend & GitHub Webhook Listener running on port ${PORT}`));
