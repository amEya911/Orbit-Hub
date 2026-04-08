const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, ".dist");
const extensionName = "orbit-hub-dev.vsix";
const vsixPath = path.join(distDir, extensionName);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function findEditorCli() {
  const candidates = [
    "code",
    "cursor",
    "windsurf",
    "codium",
    "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      cwd: root,
      stdio: "ignore",
      shell: process.platform === "win32",
    });

    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
}

fs.mkdirSync(distDir, { recursive: true });

console.log("\nBuilding extension...");
run("npm", ["run", "compile"]);

console.log(`\nPackaging extension to ${vsixPath}...`);
run("npx", ["@vscode/vsce", "package", "--out", vsixPath]);

const editorCli = findEditorCli();

if (editorCli) {
  console.log(`\nInstalling into your current ${editorCli} profile...`);
  run(editorCli, ["--install-extension", vsixPath, "--force"]);
  console.log("\nInstalled successfully.");
  console.log("Run 'Developer: Reload Window' in the window you're working in.");
} else {
  console.log("\nPackaged successfully.");
  console.log("No editor CLI was found on PATH.");
  console.log("In your editor, run 'Extensions: Install from VSIX...' and choose:");
  console.log(vsixPath);
  console.log("Then run 'Developer: Reload Window' in the same window.");
}
