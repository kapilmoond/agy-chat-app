# Aakalan Agy

Desktop chat app for **Google Antigravity CLI (`agy`)**.

This is **not** Aakalan Agent. Aakalan Agent stays a separate product. Aakalan Agy only talks to `agy`.

Company: **Aaklan Infra Consultancy**  
Suggested GitHub repo: `https://github.com/kapilmoond/aakalan-agy`

## What the user gets

1. Download the Windows installer EXE from the website or GitHub Releases.
2. Install (Start Menu + Desktop shortcut).
3. First launch asks to install `agy` if missing.
4. Continue to chat. This app does **not** have its own Google login and must not read leftover Gemini `google_accounts.json`.
5. Chat, WhatsApp QR connect, Hermes-style memory, audio/file input.

Website button (after you upload the Release):

`https://github.com/kapilmoond/aakalan-agy/releases/download/v1.1.0/AakalanAgy-Setup-1.1.0-win-x64.exe`

## Run from source

```bat
cd agy-chat-app
npm install
npm start
```

Python fallback (no EXE):

```bat
start_agy_chat.bat
```

## Build the Windows installer

On Windows, with Node.js installed:

```bat
npm install
npm run dist:win
```

Installer output:

`release\AakalanAgy-Setup-1.0.0-win-x64.exe`

## Push with GitHub Desktop

1. In GitHub, create an empty repo named `aakalan-agy` (no README).
2. Open GitHub Desktop → Add → Add existing repository → this folder.
3. Publish to GitHub.
4. After a version tag `v1.0.0`, the Release workflow can build the EXE.

Do not commit `node_modules` or `release`.

## First-run login (CLI, not this app)

Aakalan Agy uses the **agy CLI** session. It does not sign in as a second Google account.

- Do not treat `%USERPROFILE%\.gemini\google_accounts.json` as the app login. That file is Gemini leftover and can show the wrong email (for example canal vs the CLI account).
- Do not run `agy --print` to force Google login. Print mode opens Chrome once, then later fails without opening the browser.
- On a **new PC**, if chat says the CLI is not logged in, use **Open agy window** and finish Google sign-in there. After that, Windows keeps `gemini:antigravity` in Credential Manager.
- Aakalan Agy always starts agy with `--dangerously-skip-permissions` and `--mode accept-edits`. First launch also writes CLI settings so tools run with no allow prompts and no extra user setup.
