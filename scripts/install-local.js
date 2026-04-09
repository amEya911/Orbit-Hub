const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, ".dist");
const extensionName = "orbit-hub-dev.vsix";
const vsixPath = path.join(distDir, extensionName);

/**
 * Run a command cross-platform.
 *
 * On Windows we must use `shell: true` so that npm/npx (which are .cmd/.ps1
 * scripts) can be found. But `shell: true` with `spawnSync` just concatenates
 * the args with spaces, so any arg that contains a space (e.g. a user-profile
 * path like "C:\Users\Jyothi Deshpande\...") will be split into multiple
 * tokens by cmd.exe.  We fix this by wrapping every argument in double-quotes.
 *
 * On macOS / Linux we do NOT use shell: true, so Node passes each arg as a
 * discrete argv entry and spaces are never a problem.
 */
function run(command, args) {
  let result;

  if (isWin) {
    // Quote every argument so cmd.exe never splits on spaces.
    const quoted = args.map((a) => `"${a}"`);
    result = spawnSync(command, quoted, {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
  } else {
    // Unix: no shell needed; args are passed as-is.
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
  // Common CLI names that exist on $PATH / %PATH%
  const candidates = [
    "code",       // VS Code
    "cursor",     // Cursor
    "windsurf",   // Windsurf
    "codium",     // VSCodium
  ];

  // Platform-specific absolute paths for editors that may not be on PATH
  if (isMac) {
    candidates.push(
      "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    );
  } else if (isWin) {
    // On Windows, VS Code's CLI is usually on PATH after install, but add
    // well-known locations as fallbacks.
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
        path.join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      );
    }
    candidates.push(
      path.join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
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
      // ignore – candidate simply not available
    }
  }

  return null;
}

// ── Main ────────────────────────────────────────────────────────────

fs.mkdirSync(distDir, { recursive: true });

console.log("\nBuilding extension...");
run("npm", ["run", "compile"]);

console.log(`\nPackaging extension to ${vsixPath}...`);
run("npx", ["@vscode/vsce", "package", "--out", vsixPath]);

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