export default {
  async fetch(request, env) {
    const upgrade = request.headers.get("Upgrade");

    // If it's not a WebSocket, return a simple online message
    if (upgrade !== "websocket") {
      return new Response(
        "Roblox Bridge is Online! (Connect via WSS)",
        { status: 200 }
      );
    }

    // Use the Durable Object binding Chat_KV
    const id = env.Chat_KV.idFromName("global-chat");
    const room = env.Chat_KV.get(id);

    // Forward the request to the Durable Object
    return room.fetch(request);
  }
};

// Durable Object class for WebSocket chat
export class Chat_KV {
  constructor(state) {
    this.state = state;
    this.clients = new Set(); // Stores all connected sockets
  }

  async fetch(request) {
    // Create WebSocket pair
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    // Add the new connection to the set
    this.clients.add(server);

    // Broadcast messages to all connected clients
    server.addEventListener("message", (event) => {
      for (const ws of this.clients) {
        if (ws.readyState === 1) {
          ws.send(event.data);
        }
      }
    });

    // Remove disconnected clients
    server.addEventListener("close", () => {
      this.clients.delete(server);
    });

    // Return the WebSocket upgrade response
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
