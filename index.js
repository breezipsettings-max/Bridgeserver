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
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const ADMIN_CLUSTER_KEY = process.env.ADMIN_CLUSTER_KEY;

if (!WEBHOOK_SECRET) {
    console.error("❌ CRITICAL ERROR: GITHUB_WEBHOOK_SECRET environment variable is not set!");
    process.exit(1);
}

if (!ADMIN_CLUSTER_KEY) {
    console.warn("⚠️ WARNING: ADMIN_CLUSTER_KEY environment variable is not set. Admin commands will be locked.");
}

// Track site build version state for client refresh polling
let currentSiteVersion = Date.now().toString();

// In-memory Visitor & User Tracking (Anti-bot & IP Logging)
const visitorList = [];
let neuronAllocation = { total: 10000, used: 140, resetTime: Date.now() + (24 * 60 * 60 * 1000) };

// Grab the raw body from incoming requests to safely verify the GitHub signature (with 10mb payload limit to prevent size truncation issues)
app.use(express.json({
    limit: '10mb',
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

// Safely sanitize and truncate prompts to prevent Cloudflare AI 60,000 token context limit crashes
function sanitizeAndTruncatePrompt(prompt) {
  const MAX_CHAR_LIMIT = 16000; // ~4000 tokens safety cap
  if (prompt.length > MAX_CHAR_LIMIT) {
    console.warn(`[Prompt Safeguard] Prompt length (${prompt.length} chars) exceeds safety cap. Truncating...`);
    return prompt.substring(0, MAX_CHAR_LIMIT) + "\n\n[SYSTEM NOTICE: Payload truncated to prevent context window overflow]";
  }
  return prompt;
}

// Multi-account rotating Cloudflare AI call with 24-hour cooldown memory & failover
async function callCloudflare(prompt) {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    throw new Error('No Cloudflare accounts configured in environment variables.');
  }

  // Check neuron limits (10,000 free Neurons allocation resets every 24 hours)
  if (Date.now() > neuronAllocation.resetTime) {
      neuronAllocation.used = 0;
      neuronAllocation.resetTime = Date.now() + (24 * 60 * 60 * 1000);
  }
  if (neuronAllocation.used >= neuronAllocation.total) {
      throw new Error('Daily Neuron limit reached (10,000 free Neurons allocation exhausted). Resets in 24 hours.');
  }
  neuronAllocation.used += 15; // Increment per prompt token cost approximation

  const safePrompt = sanitizeAndTruncatePrompt(prompt);
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
      console.log(`[Cluster Dispatch] Routing request through secure profile...`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Authorization': `Bearer ${selectedAccount.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: safePrompt }],
          max_tokens: 300,
        }),
      });

      const data = await response.json();

      if (response.status === 429 || (!data.success && JSON.stringify(data.errors).toLowerCase().includes('rate'))) {
        console.warn(`[Rate Limit] Profile hit limit. Locking out for 24 hours and rotating...`);
        accountCooldowns[selectedAccount.index] = Date.now() + COOLDOWN_DURATION_MS;
        attempts++;
        continue;
      }

      if (!data.success) {
        const errorMsg = JSON.stringify(data.errors);
        // Do not put account on 24h cooldown for context window errors
        if (errorMsg.includes('5021') || errorMsg.includes('context window limit')) {
           throw new Error("Payload error: Input text/attachment exceeds model context limit.");
        }
        throw new Error(errorMsg);
      }

      return data.result.response;

    } catch (error) {
      console.error(`[Cluster Error] Profile failed: ${error.message}`);
      if (error.message.includes('context window limit') || error.message.includes('Payload error')) {
        throw error;
      }
      accountCooldowns[selectedAccount.index] = Date.now() + COOLDOWN_DURATION_MS;
      attempts++;
      if (attempts >= accounts.length) {
        throw new Error(`All active accounts failed. Last error: ${error.message}`);
      }
    }
  }

  throw new Error('All Cloudflare accounts are currently rate-limited or locked out.');
}

// Visitor registration endpoint to track IPs & Flags via ipwho.is
app.post('/api/register-visitor', (req, res) => {
    const { ip, flagImg, flagEmoji, country, type } = req.body;
    const fallbackIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
    const finalIp = ip || fallbackIp;
    
    let existing = visitorList.find(v => v.ip === finalIp);
    if (!existing) {
        const userCode = `USER#${visitorList.length + 1}`;
        existing = {
            user: userCode,
            ip: finalIp,
            flagImg: flagImg || '',
            flagEmoji: flagEmoji || '🏳️',
            country: country || 'Unknown',
            type: type || 'IPv4',
            visits: 1,
            lastSeen: Date.now(),
            timeout: false
        };
        visitorList.push(existing);
        console.log(`New visitor registered: ${userCode} [IP: ${finalIp} (${country || 'Unknown'})]`);
    } else {
        existing.visits++;
        existing.lastSeen = Date.now();
    }
    res.json({ success: true, user: existing.user, visitors: visitorList, neurons: neuronAllocation });
});

// Per-User Timeout Endpoint
app.post('/api/timeout-user', (req, res) => {
    const { user } = req.body;
    const target = visitorList.find(v => v.user === user);
    if (target) {
        target.timeout = !target.timeout;
        neuronAllocation.used += 5;
        console.log(`[Admin Action] User ${user} timeout status changed to: ${target.timeout}`);
        return res.json({ success: true, visitors: visitorList, neurons: neuronAllocation, message: `User ${user} has been ${target.timeout ? 'timed out/throttled' : 'restored'}.` });
    }
    res.status(404).json({ success: false, error: 'User not found.' });
});

// REST AI endpoint with Admin command interceptor (/AN_CLUSTER)
app.post('/api/ask', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  const censoredLogPrompt = prompt.trim().includes('/AN_CLUSTER') 
      ? '/AN_CLUSTER = [CENSORED_KEY_SECURELY_HIDDEN]' 
      : prompt;
  console.log(`[Incoming Request] ${censoredLogPrompt}`);

  if (prompt.trim().startsWith('/AN_CLUSTER')) {
      const parts = prompt.split('=');
      const providedKey = parts[1] ? parts[1].trim() : '';
      if (ADMIN_CLUSTER_KEY && providedKey === ADMIN_CLUSTER_KEY) {
          return res.json({ 
              success: true, 
              isAdmin: true, 
              visitors: visitorList,
              neurons: neuronAllocation,
              result: "🔓 **ADMIN ACCESS GRANTED**: Admin command panel unlocked on right side."
          });
      } else {
          return res.status(403).json({ success: false, error: 'Access Denied: Invalid Admin Cluster Key.' });
      }
  }

  if (prompt.trim() === '/purge') {
      neuronAllocation.used += 5;
      return res.json({ success: true, isAction: true, title: '🧹 CACHE PURGE', result: 'Bot query caches and RAM buffers cleared.', neurons: neuronAllocation });
  }
  if (prompt.trim() === '/stats') {
      neuronAllocation.used += 5;
      return res.json({ success: true, isAction: true, title: '📊 CLUSTER TELEMETRY', result: `Visitors: ${visitorList.length} | Neurons: ${neuronAllocation.used}/${neuronAllocation.total} | Status: Optimal`, neurons: neuronAllocation });
  }

  try {
    const result = await callCloudflare(prompt);
    res.json({ success: true, result, neurons: neuronAllocation });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/version', (req, res) => {
    res.json({ version: currentSiteVersion });
});

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

app.post('/webhook', verifyGitHubSignature, (req, res) => {
    const githubEvent = req.headers['x-github-event'];
    const payload = req.body;

    if (githubEvent === 'push') {
        const branch = payload.ref ? payload.ref.replace('refs/heads/', '') : '';
        if (branch === 'main') {
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
    res.status(200).send('Webhook received.');
});

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => {
        ws.lastActivity = Date.now();
        try {
            const parsed = JSON.parse(message.toString());
            const prompt = parsed.prompt;
            if (!prompt) return;

            const censoredLogPrompt = prompt.trim().includes('/AN_CLUSTER') 
                ? '/AN_CLUSTER = [CENSORED_KEY_SECURELY_HIDDEN]' 
                : prompt;
            console.log(`[WebSocket Incoming] ${censoredLogPrompt}`);

            if (prompt.trim().startsWith('/AN_CLUSTER')) {
                const parts = prompt.split('=');
                const providedKey = parts[1] ? parts[1].trim() : '';
                if (ADMIN_CLUSTER_KEY && providedKey === ADMIN_CLUSTER_KEY) {
                    ws.send(JSON.stringify({ 
                        success: true, 
                        isAdmin: true, 
                        visitors: visitorList,
                        neurons: neuronAllocation,
                        result: "🔓 **ADMIN ACCESS GRANTED**: Admin command panel unlocked on right side."
                    }));
                    return;
                } else {
                    ws.send(JSON.stringify({ success: false, error: 'Access Denied: Invalid Admin Cluster Key.' }));
                    return;
                }
            }

            if (prompt.trim() === '/purge') {
                neuronAllocation.used += 5;
                ws.send(JSON.stringify({ success: true, isAction: true, title: '🧹 CACHE PURGE', result: 'Bot query caches and RAM buffers cleared.', neurons: neuronAllocation }));
                return;
            }
            if (prompt.trim() === '/stats') {
                neuronAllocation.used += 5;
                ws.send(JSON.stringify({ success: true, isAction: true, title: '📊 CLUSTER TELEMETRY', result: `Visitors: ${visitorList.length} | Neurons: ${neuronAllocation.used}/${neuronAllocation.total} | Status: Optimal`, neurons: neuronAllocation }));
                return;
            }

            const result = await callCloudflare(prompt);
            ws.send(JSON.stringify({ success: true, result, neurons: neuronAllocation }));
        } catch (error) {
            ws.send(JSON.stringify({ success: false, error: error.message }));
        }
    });

    const idleCheck = setInterval(() => {
        if (Date.now() - ws.lastActivity > IDLE_TIMEOUT_MS) {
            ws.send(JSON.stringify({ systemInfo: 'Connection entering IDLE state due to inactivity.' }));
        }
    }, 60000);

    ws.on('close', () => { clearInterval(idleCheck); });
});

server.listen(PORT, () => console.log(`🚀 Cluster Sync Engine Backend running on port ${PORT}`));
