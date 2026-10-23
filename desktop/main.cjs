const { app, BrowserWindow, dialog, session, shell } = require("electron");
const { mkdirSync } = require("node:fs");
const { readFile, stat } = require("node:fs/promises");
const http = require("node:http");
const { extname, join, normalize, sep } = require("node:path");

const APP_ID = "com.basketikun.infinite-canvas";
const APP_TITLE = "无限画布";
// 端口是存储身份的一部分：IndexedDB / localStorage 按 origin 隔离，发布后不要改。
const APP_PORT = 32123;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const APP_URL = `${APP_ORIGIN}/`;
// 固定目录名：productName 或安装路径变化都不能改动它，否则 Chromium 会换一套存储。
// 画布素材可能很大，放 LocalAppData，避免被漫游配置同步。
const USER_DATA_DIR = join(process.env.LOCALAPPDATA || app.getPath("appData"), "infinite-canvas");
const WEB_ROOT = join(__dirname, "dist");
const INDEX_FILE = join(WEB_ROOT, "index.html");

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".wasm": "application/wasm",
};

app.setName("Infinite Canvas");
app.setAppUserModelId(APP_ID);
// app.setPath 要求目标目录已存在，首次启动时先创建。
mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath("userData", USER_DATA_DIR);
// 显式把 Chromium 的会话数据（IndexedDB、localStorage、Cookie、Cache）也固定到同一目录。
app.setPath("sessionData", USER_DATA_DIR);

let mainWindow = null;

async function resolveFile(filePath, relativePath) {
    try {
        if ((await stat(filePath)).isFile()) return filePath;
    } catch {
        // 文件不存在时继续走 SPA 回落。
    }
    if (extname(relativePath)) return null;
    return INDEX_FILE;
}

async function serveAppFile(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url || "/", APP_ORIGIN).pathname);
    } catch {
        response.writeHead(400).end("Bad Request");
        return;
    }

    const relativePath = pathname.replace(/^\/+/, "");
    const filePath = normalize(join(WEB_ROOT, relativePath));
    if (filePath !== WEB_ROOT && !filePath.startsWith(`${WEB_ROOT}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
    }

    try {
        // BrowserRouter 的深链接（例如 /canvas/xxx）找不到文件时回落到 index.html。
        const target = await resolveFile(filePath, relativePath);
        if (!target) {
            response.writeHead(404).end("Not Found");
            return;
        }
        const body = await readFile(target);
        const isAsset = relativePath.startsWith("assets/");
        response.writeHead(200, {
            "content-type": MIME_TYPES[extname(target).toLowerCase()] || "application/octet-stream",
            "content-length": body.length,
            "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
        });
        response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
        response.writeHead(500).end(`Failed to read app file: ${String(error)}`);
    }
}

const server = http.createServer((request, response) => {
    void serveAppFile(request, response);
});

function startServer() {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(APP_PORT, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#1c1917",
        title: APP_TITLE,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });

    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (url === APP_ORIGIN || url.startsWith(APP_URL)) return;
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });

    mainWindow.loadURL(APP_URL).catch((error) => {
        dialog.showErrorBox("无法启动无限画布", String(error));
        app.quit();
    });
}

// 只保留剪贴板权限：画布支持从剪贴板粘贴图片，其他权限默认拒绝。
function configurePermissions() {
    const allowed = new Set(["clipboard-read", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(allowed.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        try {
            await startServer();
        } catch (error) {
            dialog.showErrorBox("无法启动无限画布", `本地端口 ${APP_PORT} 启动失败，请关闭占用该端口的程序后重试。\n\n${String(error)}`);
            app.quit();
            return;
        }

        configurePermissions();
        createWindow();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });
    app.on("will-quit", () => {
        if (server.listening) server.close();
    });
}
