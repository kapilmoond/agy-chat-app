# Aakalan Agy

Desktop chat app for **Google Antigravity CLI (`agy`)**.

This is **not** Aakalan Agent. Aakalan Agent stays a separate product. Aakalan Agy only talks to `agy`.

Company: **Aaklan Infra Consultancy**  
Suggested GitHub repo: `https://github.com/kapilmoond/aakalan-agy`

## What the user gets

1. Download the Windows installer EXE from GitHub Releases.
2. Install (Start Menu + Desktop shortcut).
3. First launch asks to install `agy` if missing.
4. Then **Sign in with Google**.
5. Chat in a normal desktop window.

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

## First-run Google sign-in

`agy` uses Google OAuth / Windows keyring. This app starts that official flow. It does not store your Google password.
