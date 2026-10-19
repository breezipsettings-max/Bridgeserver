import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static files (like your index.html) from the root directory
app.use(express.static(__dirname));

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

// Multi-account rotating Cloudflare Workers AI call
async function callCloudflare(prompt) {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    throw new Error('No Cloudflare accounts configured in environment variables.');
  }

  // Select the current account and rotate index for the next request
  const account = accounts[currentAccountIndex];
  currentAccountIndex = (currentAccountIndex + 1) % accounts.length;

  const model = '@cf/meta/llama-3.2-1b-instruct';
  const url = `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/${model}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${account.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors));

  return data.result.response;
}

// AI endpoint
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
