const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, ".dist");
const extensionName = "orbit-hub-dev.vsix";
const vsixPath = path.join(distDir, extensionName);

/**
 * Run a command cross-platform.
 */
function run(command, args) {
  let result;

  if (isWin) {
    const quoted = args.map((a) => `"${a}"`);
    result = spawnSync(command, quoted, {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
  } else {
    result = spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
    });
  }

  if (result.error) {
    console.error(`Failed to run ${command}:`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Try to detect a VS Code–compatible editor CLI on the current machine.
 * Returns the CLI name/path that works, or null.
 */
function findEditorCli() {
  const candidates = [];

  if (isMac) {
    candidates.push(
      "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
      "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity"
    );
  }

  candidates.push(
    "code",       // VS Code
    "cursor",     // Cursor
    "windsurf",   // Windsurf
    "codium"      // VSCodium
  );

  if (isMac) {
    candidates.push(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
    );
  } else if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
        path.join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd")
      );
    }
    candidates.push(
      path.join(programFiles, "Microsoft VS Code", "bin", "code.cmd")
    );
  }

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        cwd: root,
        stdio: "ignore",
        shell: isWin,
        timeout: 5000,
      });

      if (result.status === 0) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Directly copy built files to all local Antigravity & Cursor extension folders.
 * This guarantees the updates take effect even if the CLI installation targeted
 * a different/secondary editor, or if the CLI symlink is broken.
 */
function syncToLocalExtensions() {
  const home = os.homedir();
  const searchDirs = [
    path.join(home, ".antigravity", "extensions"),
    path.join(home, ".antigravity-ide", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.startsWith("ameyakulkarni.orbit-hub")) {
          const targetPath = path.join(dir, item);
          console.log(`Syncing built files directly to: ${targetPath}`);

          fs.cpSync(path.join(root, "package.json"), path.join(targetPath, "package.json"), { force: true });
          fs.cpSync(path.join(root, "out"), path.join(targetPath, "out"), { recursive: true, force: true });
          fs.cpSync(path.join(root, "webview"), path.join(targetPath, "webview"), { recursive: true, force: true });
          fs.cpSync(path.join(root, "resources"), path.join(targetPath, "resources"), { recursive: true, force: true });

          const sqlJsSrc = path.join(root, "node_modules", "sql.js");
          if (fs.existsSync(sqlJsSrc)) {
            fs.cpSync(sqlJsSrc, path.join(targetPath, "node_modules", "sql.js"), { recursive: true, force: true });
          }
          console.log("  Sync complete.");
        }
      }
    } catch (err) {
      console.error(`Error reading/writing in ${dir}:`, err.message);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

fs.mkdirSync(distDir, { recursive: true });

console.log("\nBuilding extension...");
run("npm", ["run", "compile"]);

console.log(`\nPackaging extension to ${vsixPath}...`);
run("npx", ["@vscode/vsce", "package", "--out", vsixPath]);

// Perform direct filesystem synchronization first for robust caching
console.log("\nSynchronizing built files to extension directories...");
syncToLocalExtensions();

const editorCli = findEditorCli();

if (editorCli) {
  console.log(`\nInstalling into your current editor (${path.basename(editorCli, path.extname(editorCli))})...`);
  run(editorCli, ["--install-extension", vsixPath, "--force"]);
  console.log("\n✅ Installed successfully.");
  console.log("Run 'Developer: Reload Window' in the window you're working in.");
} else {
  console.log("\n✅ Packaged successfully.");
  console.log("No editor CLI was found on PATH.");
  console.log("In your editor, run 'Extensions: Install from VSIX...' and choose:");
  console.log(vsixPath);
  console.log("Then run 'Developer: Reload Window' in the same window.");
}