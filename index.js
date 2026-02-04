export default {
  async fetch(request, env) {
    const upgrade = request.headers.get("Upgrade");

    if (upgrade !== "websocket") {
      return new Response(
        "Roblox Bridge is Online! (Connect via WSS)",
        { status: 200 }
      );
    }

    const id = env.CHAT_ROOM.idFromName("global-chat");
    const room = env.CHAT_ROOM.get(id);

    return room.fetch(request);
  }
};

export class ChatRoom {
  constructor(state) {
    this.state = state;
    this.clients = new Set();
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
