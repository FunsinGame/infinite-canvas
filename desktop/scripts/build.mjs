import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoDir = dirname(desktopDir);
const webDir = join(repoDir, "web");
const webDist = join(webDir, "dist");
const desktopDist = join(desktopDir, "dist");

const args = new Set(process.argv.slice(2));
const isDev = args.has("--dev");
const isDir = args.has("--dir");
const skipWeb = args.has("--skip-web");

function tryRun(command, commandArgs, cwd, env) {
    const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status ?? 1;
}

function run(command, commandArgs, cwd, env) {
    const code = tryRun(command, commandArgs, cwd, env);
    if (code !== 0) process.exit(code);
}

// Windows 上杀毒软件可能短暂占用刚解压的 Electron 文件，导致 electron-builder 把 win-unpacked.tmp 改名失败。
function cleanPackagingOutput() {
    for (const name of ["win-unpacked", "win-unpacked.tmp"]) {
        const target = join(desktopDir, "release", name);
        try {
            rmSync(target, { recursive: true, force: true });
        } catch (error) {
            console.warn(`failed to remove ${target}: ${error.message}`);
        }
    }
}

function syncVersion() {
    const version = readFileSync(join(repoDir, "VERSION"), "utf8").trim().replace(/^v/, "");
    const pkgPath = join(desktopDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.version === version) return;
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
    console.log(`desktop/package.json version -> ${version}`);
}

syncVersion();

if (!skipWeb) {
    const viteBin = join(webDir, "node_modules", "vite", "bin", "vite.js");
    if (!existsSync(viteBin)) {
        console.error("web dependencies are missing. Run `bun install` (or `npm install`) in web/ first.");
        process.exit(1);
    }
    // 直接调用 Vite：Bun 在 Windows 上可能是 .cmd shim，Node 的 spawn 无法直接执行它。
    console.log("building web...");
    run(process.execPath, [viteBin, "build"], webDir, { VITE_BASE: "/" });
}

if (!existsSync(join(webDist, "index.html"))) {
    console.error("web/dist/index.html not found. Run `bun run build` in web/ first, or drop --skip-web.");
    process.exit(1);
}

rmSync(desktopDist, { recursive: true, force: true });
cpSync(webDist, desktopDist, { recursive: true });

const electronDir = join(desktopDir, "node_modules", "electron");
const electronDist = join(electronDir, "dist");
const electronCli = join(electronDir, "cli.js");
const builderCli = join(desktopDir, "node_modules", "electron-builder", "cli.js");
if (!existsSync(electronCli) || !existsSync(builderCli)) {
    console.error("desktop dependencies are missing. Run `npm ci` in desktop/ first.");
    process.exit(1);
}

// 直接解压 Electron 运行时，避免 electron-builder 先解压到 win-unpacked.tmp 再重命名；
// Windows 上这一步经常被杀毒软件或文件监听占用，报 EPERM。
if (!existsSync(join(electronDist, "electron.exe"))) {
    console.log("preparing electron runtime...");
    run(process.execPath, [join(electronDir, "install.js")], desktopDir);
}
if (!existsSync(join(electronDist, "electron.exe"))) {
    console.error("Electron runtime is not ready. Check network/mirror and run the build again.");
    process.exit(1);
}

if (isDev) {
    run(process.execPath, [electronCli, "."], desktopDir);
} else {
    const builderArgs = isDir ? ["--dir", "--publish", "never"] : ["--win", "nsis", "--publish", "never"];
    builderArgs.push(`--config.electronDist=${electronDist}`);
    const maxAttempts = process.platform === "win32" ? 3 : 1;
    const tempOutput = join(desktopDir, "release", "win-unpacked.tmp");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        cleanPackagingOutput();
        const code = tryRun(process.execPath, [builderCli, ...builderArgs], desktopDir);
        if (code === 0) break;
        const retryable = existsSync(tempOutput);
        if (attempt === maxAttempts || !retryable) {
            if (!retryable) console.error("packaging failed before win-unpacked.tmp was created; not retrying.");
            console.error("packaging failed. Close the running app and any open release folder, or exclude desktop\\release from antivirus scanning, then retry.");
            process.exit(code);
        }
        console.warn(`packaging failed (attempt ${attempt}/${maxAttempts}); cleaning win-unpacked and retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}
