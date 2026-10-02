const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,
    downloadUpdate: (downloadUrl, version) => ipcRenderer.send('download-update', { downloadUrl, version }),
    onUpdateProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('update-progress', handler);
        return () => ipcRenderer.removeListener('update-progress', handler);
    },
    onUpdateComplete: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('update-complete', handler);
        return () => ipcRenderer.removeListener('update-complete', handler);
    },
    onUpdateError: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('update-error', handler);
        return () => ipcRenderer.removeListener('update-error', handler);
    }
});
