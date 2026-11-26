import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopBridge', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('config:set', patch),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { received: number; total: number }) => cb(p);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
});
