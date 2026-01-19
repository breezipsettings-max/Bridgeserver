export default {
  async fetch(request, env) {
    // Check if the request is trying to open a WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Roblox Bridge is Online! (Connect via WSS)', { status: 200 });
    }

    // Create a WebSocket pair: one for the client, one for the server
    const [client, server] = Object.values(new WebSocketPair());

    // Accept the connection on the server side
    server.accept();

    server.addEventListener('message', (event) => {
      const message = event.data;
      console.log("Chat Received: " + message);

      // In a standard Worker, messages are sent back to the single connecting client.
      // To relay to EVERYONE (like a real chat), you must use Durable Objects.
      server.send(message); 
    });

    server.addEventListener('close', () => {
      console.log("--- Player Disconnected ---");
    });

    // Return the client side of the pair to the Roblox script
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
