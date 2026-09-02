import { WebSocketServer, type WebSocket } from 'ws'
import type { EngineEvent } from '../engine/events.js'

/** Fans engine events out to every connected dashboard. */
export class EventBroadcaster {
  private clients = new Set<WebSocket>()

  attach(wss: WebSocketServer): void {
    wss.on('connection', (socket) => {
      this.clients.add(socket)
      socket.on('close', () => this.clients.delete(socket))
      socket.on('error', () => this.clients.delete(socket))
    })
  }

  broadcast(event: EngineEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.clients) {
      // readyState 1 === OPEN. A dead socket must never throw into the engine.
      if (socket.readyState === 1) {
        try {
          socket.send(payload)
        } catch {
          this.clients.delete(socket)
        }
      }
    }
  }

  get size(): number {
    return this.clients.size
  }
}
