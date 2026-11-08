// -*- mode: js -*-
/*
 * CAD双模式智能识图 · Electron 桌面应用 主进程
 * 职责：拉起本地后端（CADEngine.exe serve），等就绪后开窗口加载 web 页。
 * 打包后独立可运行，用户无需安装 Python。
 */
'use strict';

// 某些宿主环境（Electron 嵌入式 IDE、部分 CI）会设置 ELECTRON_RUN_AS_NODE，
// 一旦继承它，本应用会被当成纯 Node 进程启动并立刻退出。这里强制清掉。
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

// 读取「exe 同目录」的 ai_config.json，把各家 API Key 注入环境变量，
// 后端（ai.py）会按模型名从环境变量取 Key，因此无需改动打包内的配置。
function loadAiConfigEnv() {
  var dirs = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR);
  try { dirs.push(path.dirname(app.getPath('exe'))); } catch (e) {}
  dirs.push(__dirname);
  var map = {
    'DeepSeek': 'DEEPSEEK_API_KEY',
    '通义千问': 'DASHSCOPE_API_KEY',
    '智谱 GLM': 'ZHIPU_API_KEY',
    '硅基流动': 'SILICONFLOW_API_KEY'
  };
  for (var i = 0; i < dirs.length; i++) {
    var cfgPath = path.join(dirs[i], 'ai_config.json');
    try {
      if (!fs.existsSync(cfgPath)) continue;
      var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      var models = (cfg && cfg.models) || [];
      var n = 0;
      for (var j = 0; j < models.length; j++) {
        var m = models[j] || {};
        var env = map[m.name];
        if (env && m.key && !process.env[env]) {
          process.env[env] = String(m.key);
          n++;
        }
      }
      console.log('[ai] loaded ' + cfgPath + ' keys=' + n);
      return n;
    } catch (e) {}
  }
  return 0;
}

function findEngine() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'CADEngine.exe');
  }
  return null;
}

function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitHttp(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 500) return resolve();
        setTimeout(tick, 150);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('后端启动超时'));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}

let backendProc = null;
let backendUrl = 'http://127.0.0.1:8710/';

async function startBackend(port) {
  const exe = findEngine();
  if (!exe) {
    const py = process.env.CAD_PYTHON || 'python';
    backendProc = spawn(py, ['-m','image2cad','serve','--port',String(port),'--host','127.0.0.1'], {
      cwd: path.join(__dirname, '..', 'CAD-DualMode-v2.0'),
      stdio: 'ignore',
    });
  } else {
    backendProc = spawn(exe, ['serve','--port',String(port),'--host','127.0.0.1'], {
      cwd: path.dirname(exe),
      stdio: 'ignore',
    });
  }
  backendUrl = 'http://127.0.0.1:' + port + '/';
  return waitHttp(backendUrl, 30000);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 620,
    title: 'CAD 双模式智能识图',
    backgroundColor: '#1e2430',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  });
  win.removeMenu();

  const loader = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#1e2430;color:#d7dde8;font-family:Microsoft YaHei,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;font-size:16px}.box{text-align:center}.spin{width:34px;height:34px;border:4px solid #3a4456;border-top-color:#4ea1ff;border-radius:50%;animation:ss 1s linear infinite;margin:0 auto 18px}@keyframes ss{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="spin"></div>正在启动本地服务…</div></body></html>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loader));
  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL().indexOf('data:') === 0) win.loadURL(backendUrl);
  });
  return win;
}

app.whenReady().then(async () => {
  loadAiConfigEnv();
  const port = await findFreePort();
  try { await startBackend(port); }
  catch (e) { dialog.showErrorBox('CAD双模式智能识图 · 启动失败', '无法启动本地识别服务：' + e.message); return app.quit(); }
  createWindow();
});

app.on('window-all-closed', () => { if (backendProc) { backendProc.kill(); backendProc = null; } if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && backendUrl) createWindow(); });
