import { EventEmitter } from 'node:events';
import type { GuestDeviceCommand } from '@sandrobina/shared';

class HubEventBus extends EventEmitter {
  emitUserUpdated(userId: number): void {
    this.emit('user-updated', userId);
  }

  emitModelsUpdated(): void {
    this.emit('models-updated');
  }

  emitAdminNodesUpdated(): void {
    this.emit('admin-nodes-updated');
  }

  emitDevicesUpdated(): void {
    this.emit('devices-updated');
  }

  emitDeviceCommand(userId: number, deviceId: string, command: GuestDeviceCommand): void {
    this.emit('device-command', { userId, deviceId, command });
  }
}

export const hubEvents = new HubEventBus();
hubEvents.setMaxListeners(200);
