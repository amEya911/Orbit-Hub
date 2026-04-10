#!/usr/bin/env bash
set -euo pipefail

REPO="amEya911/Orbit-Hub"

# --- Resolve CLI ---
CLI=""
for cmd in antigravity cursor code; do
  if command -v "$cmd" &>/dev/null; then
    CLI="$cmd"
    break
  fi
done

if [ -z "$CLI" ]; then
  echo "✗ No supported editor CLI found (antigravity, cursor, code)."
  exit 1
fi

# --- Fetch latest release ---
echo "🔍 Fetching latest Orbit Hub release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")

TAG=$(echo "$RELEASE_JSON" | grep -m 1 '"tag_name":' | cut -d '"' -f 4)

if [ -z "$TAG" ]; then
  echo "✗ Could not determine latest version."
  exit 1
fi

# --- Get VSIX URL dynamically ---
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url" | grep ".vsix" | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "✗ Could not find VSIX in latest release."
  exit 1
fi

TMPDIR_PATH=$(mktemp -d)
VSIX_PATH="${TMPDIR_PATH}/orbit-hub.vsix"

echo "⬇️ Downloading extension..."
curl -fL --retry 3 --progress-bar -o "$VSIX_PATH" "$DOWNLOAD_URL"

# --- Install ---
echo "📦 Installing via ${CLI}..."
"$CLI" --install-extension "$VSIX_PATH" --force

# --- Cleanup ---
rm -rf "$TMPDIR_PATH"

echo "✅ Orbit Hub installed successfully!"
echo "↻ Reload your editor window to activate."
