export default {
  async fetch(request, env) {
    const upgrade = request.headers.get("Upgrade");

    if (upgrade !== "websocket") {
      return new Response(
        "Roblox Bridge is Online! (Connect via WSS)",
        { status: 200 }
      );
    }

    // Use the Durable Object binding Chat_KV
    const id = env.Chat_KV.idFromName("global-chat");
    const room = env.Chat_KV.get(id);

    // Only return inside the fetch function
    return room.fetch(request);
  }
};

// Durable Object class
export class Chat_KV {
  constructor(state) {
    this.state = state;
    this.clients = new Set(); // Stores all connected sockets
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    this.clients.add(server);

    server.addEventListener("message", (event) => {
      for (const ws of this.clients) {
        if (ws.readyState === 1) {
          ws.send(event.data);
        }
      }
    });

    server.addEventListener("close", () => {
      this.clients.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
