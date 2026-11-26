import { EventEmitter } from 'node:events';

class HubEventBus extends EventEmitter {
  emitUserUpdated(userId: number): void {
    this.emit('user-updated', userId);
  }

  emitModelsUpdated(): void {
    this.emit('models-updated');
  }
}

export const hubEvents = new HubEventBus();
hubEvents.setMaxListeners(200);
