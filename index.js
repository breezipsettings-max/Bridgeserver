const WebSocket = require('ws');
const http = require('http');

// This allows the cloud host to tell the server which port to use
const port = process.env.PORT || 3000;

// Create a basic HTTP server (Required by most free hosts)
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Roblox Bridge is Online!");
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("--- New Player Connected to Cloud Bridge ---");
    
    ws.on('message', (data) => {
        const message = data.toString();
        console.log("Chat Received: " + message);

        // Relay to everyone
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        console.log("--- Player Disconnected ---");
    });
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
