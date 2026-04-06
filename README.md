# Orbit-Hub

## Local dev in the current window

`F5` launches a separate Extension Development Host window. If you want Orbit Hub running in the editor window you're already using, use the install flow instead:

```bash
npm run install:local
```

What this does:

- Compiles the extension
- Packages it as `.dist/orbit-hub-dev.vsix`
- Installs it with `code`/`cursor`/`windsurf`/`codium` if one of those CLIs is available

If no editor CLI is on your `PATH`, the script still creates the `.vsix`. Then in your editor:

1. Run `Extensions: Install from VSIX...`
2. Pick `.dist/orbit-hub-dev.vsix`
3. Run `Developer: Reload Window`

For iterative work:

- Keep `npm run watch` running in a terminal
- After code changes, rerun `npm run install:local`
- Reload the same editor window
