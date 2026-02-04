// index.js

// Main Worker: forwards all WebSocket connections to the Durable Object
export default {
  async fetch(request, env) {
    const upgrade = request.headers.get("Upgrade");

    // If not WebSocket, return simple online message
    if (upgrade !== "websocket") {
      return new Response(
        "Roblox Bridge is Online! (Connect via WSS)",
        { status: 200 }
      );
    }

    // Durable Object binding: Chat_KV
    const id = env.Chat_KV.idFromName("global-chat");
    const room = env.Chat_KV.get(id);

    // Forward the request to the Durable Object
    return room.fetch(request);
  }
};

// Durable Object class: manages all WebSocket clients
export class Chat_KV {
  constructor(state) {
    this.state = state;
    this.clients = new Set(); // stores all connected sockets
  }

  async fetch(request) {
    // Create a WebSocket pair
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    // Add new client
    this.clients.add(server);

    // Broadcast any incoming messages to all clients
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

    // Return WebSocket upgrade response
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
