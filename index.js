const WebSocket = require('ws');

const wss8080 = new WebSocket.Server({ 
    port: 8080, 
    host: '0.0.0.0' 
});

wss8080.on('connection', (ws) => {
    console.log("--- New Player Connected ---");
    
    ws.on('message', (data) => {
        const message = data.toString();
        
        // THIS LINE IS KEY: It prints the chat to your Laptop 2 screen
        console.log("CHAT RECEIVED: " + message);

        // This sends the message back to everyone in Roblox
        wss8080.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        console.log("--- Player Disconnected ---");
    });
});

console.log("Bridge-server is LIVE on port 8080");