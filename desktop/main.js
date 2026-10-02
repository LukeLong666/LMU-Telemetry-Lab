const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

let backendProcess = null;

function downloadFileWithRedirects(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destPath);
        
        const request = (currentUrl) => {
            const protocol = currentUrl.startsWith('https') ? https : http;
            
            protocol.get(currentUrl, {
                headers: { 'User-Agent': 'LMU-Telemetry-Lab-Updater' }
            }, (response) => {
                // Follow HTTP redirects (301, 302, 307, 308)
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    return request(response.headers.location);
                }
                
                if (response.statusCode !== 200) {
                    fileStream.close();
                    fs.unlink(destPath, () => {});
                    return reject(new Error(`Download failed with status code ${response.statusCode}`));
                }

                const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                let lastTime = Date.now();
                let lastDownloaded = 0;

                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    fileStream.write(chunk);

                    const now = Date.now();
                    const elapsed = (now - lastTime) / 1000;
                    
                    if (elapsed >= 0.2 || downloadedBytes === totalBytes) {
                        const speed = elapsed > 0 ? (downloadedBytes - lastDownloaded) / elapsed : 0;
                        const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
                        
                        onProgress({
                            percent,
                            transferred: downloadedBytes,
                            total: totalBytes,
                            speedBytesPerSec: speed
                        });

                        lastTime = now;
                        lastDownloaded = downloadedBytes;
                    }
                });

                response.on('end', () => {
                    fileStream.end();
                    resolve(destPath);
                });

                response.on('error', (err) => {
                    fileStream.close();
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            }).on('error', (err) => {
                fileStream.close();
                fs.unlink(destPath, () => {});
                reject(err);
            });
        };

        request(url);
    });
}

// Handle Auto-Update download IPC request
ipcMain.on('download-update', async (event, { downloadUrl, version }) => {
    const sender = event.sender;
    const tempDir = app.getPath('temp');
    const safeVersion = (version || 'latest').replace(/[^a-zA-Z0-9._-]/g, '');
    const fileName = `LMU_Telemetry_Lab_Setup_${safeVersion}.exe`;
    const targetPath = path.join(tempDir, fileName);

    console.log(`[AutoUpdate] Starting download from: ${downloadUrl}`);
    console.log(`[AutoUpdate] Installer target path: ${targetPath}`);

    try {
        await downloadFileWithRedirects(downloadUrl, targetPath, (progressData) => {
            sender.send('update-progress', progressData);
        });

        console.log(`[AutoUpdate] Download complete! Launching installer at ${targetPath}...`);
        sender.send('update-complete', { targetPath });

        // Delay 1.2s to let UI display 100% completed status before launching installer and exiting
        setTimeout(() => {
            if (process.platform === 'win32') {
                console.log(`[AutoUpdate] Launching installer with progress window: ${targetPath}`);

                // Launch installer directly with oneClick progress bar (no interactive prompts, auto-relaunch when finished)
                spawn(targetPath, [], {
                    detached: true,
                    stdio: 'ignore'
                }).unref();
                
                app.quit();
            }
        }, 1200);

    } catch (err) {
        console.error("[AutoUpdate] Download error:", err);
        sender.send('update-error', { error: err.message });
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1600,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        title: "LMU Telemetry Lab",
    });

    // Prevent web page from changing the window title
    win.on('page-title-updated', (e) => e.preventDefault());

    // Decide where to find the backend
    // In development, we might assume the backend is already running at 8000
    // Or we launch it from the source.
    // When packaged, we look for the exe in the resources folder
    const isPackaged = app.isPackaged;

    if (isPackaged) {
        // Path to the bundled backend exe
        const backendPath = path.join(process.resourcesPath, 'backend-dist', 'lmu-telemetry-backend', 'lmu-telemetry-backend.exe');
        const appRoot = path.join(process.resourcesPath, '..');
        const dataDir = path.join(appRoot, 'DuckDB_data');

        console.log(`Launching backend at: ${backendPath}`);
        
        // KILL ANY PREVIOUS PROCESS ON PORT 8000 before starting
        const killExisting = () => {
            return new Promise((resolve) => {
                if (process.platform === 'win32') {
                    // Find PID using netstat and kill it
                    const checkCmd = `netstat -ano | findstr :8000 | findstr LISTENING`;
                    require('child_process').exec(checkCmd, (err, stdout) => {
                        if (stdout) {
                            const lines = stdout.trim().split('\n');
                            const match = lines[0].trim().match(/\s+(\d+)$/);
                            if (match && match[1]) {
                                const pid = match[1];
                                console.log(`Found stale backend on port 8000, PID: ${pid}. Killing...`);
                                require('child_process').exec(`taskkill /F /PID ${pid}`, () => resolve());
                            } else resolve();
                        } else resolve();
                    });
                } else resolve();
            });
        };

        killExisting().then(() => {
            backendProcess = spawn(backendPath, [], {
                stdio: 'ignore',
                cwd: path.dirname(backendPath),
                windowsHide: true,
                env: {
                    ...process.env,
                    DUCKDB_DATA_DIR: dataDir
                }
            });

            backendProcess.on('error', (err) => {
                console.error('Failed to start backend process:', err);
                const { dialog } = require('electron');
                dialog.showErrorBox('Backend Error', `Failed to start backend: ${err.message}\nPath: ${backendPath}`);
            });
        });

        const checkBackend = () => {
            return new Promise((resolve) => {
                http.get('http://127.0.0.1:8000/api/v1/health', (res) => {
                    resolve(res.statusCode === 200);
                }).on('error', (err) => {
                    console.log('Backend not ready yet:', err.message);
                    resolve(false);
                });
            });
        };

        const waitForBackend = async (maxRetries = 60) => { // Up to 30s
            for (let i = 0; i < maxRetries; i++) {
                console.log(`Checking backend health (Attempt ${i + 1}/${maxRetries})...`);
                const isHealthy = await checkBackend();
                if (isHealthy) {
                    console.log('Backend is ready!');
                    return true;
                }
                await new Promise(r => setTimeout(r, 500)); // wait 500ms
            }
            return false;
        };

        waitForBackend().then(async (isReady) => {
            if (isReady) {
                try {
                    await win.webContents.session.clearCache();
                    console.log('Cache cleared, loading app...');
                } catch (err) {
                    console.error('Failed to clear cache:', err);
                }
                win.loadURL('http://127.0.0.1:8000');
            } else {
                const { dialog } = require('electron');
                dialog.showErrorBox('Backend Timeout', 'The backend service failed to start within the expected time limit (30s). Please check the backend_debug.log file.');
            }
        });
    } else {
        // In dev mode
        win.loadURL('http://127.0.0.1:8000');
    }

    win.on('closed', () => {
        if (backendProcess) {
            backendProcess.kill();
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (backendProcess) {
        backendProcess.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

