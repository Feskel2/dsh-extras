# Installing DSH Extras plugins without npm

DSH Extras is a small collection of plugins for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). The
plugins are distributed as `.tgz` files attached to a GitHub release — **there
is no npm package and no npm account is needed**. `dsh plugin` uses pnpm under
the hood to unpack the tarball into a DSH profile; that is the only package
manager involved.

The current release is
[v1.1.0](https://github.com/Feskel2/dsh-extras/releases/tag/v1.1.0). It contains:

| Plugin | Tarball | What it adds |
|---|---|---|
| `dsh-topmost-notify` | `dsh-topmost-notify.tgz` | Always-on-top Windows notification when a task finishes or the agent asks a question |
| `dsh-voice-reply` | `dsh-voice-reply.tgz` | Speaks a short summary of finished answers via Yandex SpeechKit TTS |
| `dsh-speech-to-text-yandex` | `dsh-speech-to-text-yandex.tgz` | Yandex SpeechKit speech recognition for the built-in Voice input |

**Short version** — run these one at a time in PowerShell, then restart
`dsh web`:

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

The rest of this guide explains each step, how to check the result, how to
update or remove a plugin, and what to do when something fails. If a second
command fails with `ERR_PNPM_MISSING_TARBALL_INTEGRITY`, jump to
[section 6](#6-install-several-plugins) — the downloaded-file route is the
reliable fix.

## Contents

1. [What you need](#1-what-you-need)
2. [Open PowerShell](#2-open-powershell)
3. [Choose the `web` profile](#3-choose-the-web-profile)
4. [Install the plugins](#4-install-the-plugins)
5. [Restart and check](#5-restart-and-check)
6. [Install several plugins](#6-install-several-plugins)
7. [Update a plugin](#7-update-a-plugin)
8. [Uninstall a plugin](#8-uninstall-a-plugin)
9. [Offline install](#9-offline-install)
10. [After install: the Yandex SpeechKit key](#10-after-install-the-yandex-speechkit-key)
11. [Troubleshooting](#11-troubleshooting)
12. [Quick reference](#12-quick-reference)

## 1. What you need

| Requirement | Why it is needed | How to check |
|---|---|---|
| **Windows 10/11** | `dsh-topmost-notify` is a native WPF window and works only on Windows. The two voice plugins are DSH Web plugins and are tested on Windows 11. | — |
| **DSH `>=0.2.2-rc.1 <0.3.0-0`** | The plugins declare this engine range. A 0.3 build may refuse them. | `dsh --version` |
| **Node.js `>=24.9.0`** | The DSH runtime requirement. | `node --version` |
| **pnpm on `PATH`** | `dsh plugin` forwards `add`/`remove` to pnpm. This is not an npm package dependency and does not require an npm account. | `pnpm --version` |
| **PowerShell 5.1 or newer** | Windows PowerShell 5.1 is included in Windows 10/11; the commands below also work in PowerShell 7. | `$PSVersionTable.PSVersion` |
| **Internet access to GitHub** | The one-command install downloads the tarball from a GitHub release. For a fully offline machine see [Offline install](#9-offline-install). | Open the release page in a browser. |
| **A Yandex Cloud account** | Only for `dsh-voice-reply` and `dsh-speech-to-text-yandex`. The key is **not** inside the packages. | See [Yandex SpeechKit setup](yandex-speechkit-setup.md). |

You do **not** need:

- an npm account, an npm token, or `npm publish`;
- to clone this repository;
- administrator rights (the plugins are installed into your user profile);
- a compiler or build tools — the tarballs contain ready-to-run JavaScript.

> npm publication is not planned for the near future. If the packages ever
> appear on npm, the only simplification will be a shorter command such as
> `dsh plugin --profile web add dsh-topmost-notify`. Until then, always use a
> `.tgz` URL or a downloaded `.tgz` file.

## 2. Open PowerShell

1. Press **Win + X** and choose **Terminal** or **Windows PowerShell**. You can
   also press **Win**, type `PowerShell`, and open **Windows PowerShell**.
2. In the window, check the three commands DSH needs:

   ```powershell
   dsh --version
   node --version
   pnpm --version
   ```

   You should see a DSH version in the `0.2.x` line, a Node version `24.9.0` or
   newer, and a pnpm version. If one command is not recognized, see
   [Troubleshooting](#11-troubleshooting) before continuing.

3. Go to a convenient folder. This is where the install commands run and where
   you can keep downloaded `.tgz` files:

   ```powershell
   cd $env:USERPROFILE\Downloads
   ```

4. Paste commands with a right-click (or **Ctrl + V**). PowerShell runs each
   line when you press **Enter**. Keep the quotes around URLs — they are not
   required for this particular URL, but they make the command unambiguous.

`dsh web` may already be running in another terminal. That is fine for
installing; you will restart it in [section 5](#5-restart-and-check). Do not
close its terminal until you are ready to restart, because it prints the Web UI
URL.

If PowerShell refuses to run `dsh.ps1` because of the execution policy, use
`dsh.cmd` instead of `dsh` (both launchers are installed side by side), or see
the corresponding row in [Troubleshooting](#11-troubleshooting).

## 3. Choose the `web` profile

DSH keeps separate profiles under `~/.dsh/profiles`. These plugins target the
**`web`** profile — the browser UI that `dsh web` boots. That is why every
command in this guide contains:

```text
--profile web
```

The profile directory is:

```text
%USERPROFILE%\.dsh\profiles\web
```

or, if `DSH_HOME` is set:

```text
%DSH_HOME%\profiles\web
```

In PowerShell you can print the exact path:

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$profileDir
```

Notes:

- The first `dsh plugin --profile web add ...` creates the profile directory if
  it does not exist yet.
- Do not use the `desktop` profile with these commands. The Desktop application
  manages its own profile and these plugins are documented for `dsh web`.
- You do not need to edit `package.json`, `cordis.patch.yml` or
  `pnpm-workspace.yaml` by hand. `dsh plugin` adds the dependency and the bundle
  row for you.

## 4. Install the plugins

All release URLs have the same shape:

```text
https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/<plugin>.tgz
```

Use the **explicit version** `v1.1.0` in the URL. Do not replace it with
`latest`: GitHub redirects `latest/download/...` to a signed asset URL, and pnpm
can fail with `ERR_PNPM_MISSING_TARBALL_INTEGRITY`. The explicit tag is stable
and reproducible. When a newer release appears, replace `v1.1.0` with the new
tag from the [releases page](https://github.com/Feskel2/dsh-extras/releases).

Run the commands **one at a time** and wait for pnpm to print `Done`. If one
fails, fix it before starting the next one. If a later URL install fails with
`ERR_PNPM_MISSING_TARBALL_INTEGRITY`, use the local-file route in
[section 6](#6-install-several-plugins).

### 4.1 `dsh-topmost-notify` — Windows notifications

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
```

What you get after the restart:

- an always-on-top card in the top-right corner when a task finishes;
- an amber card when the agent asks a question;
- a per-chat bell in the chat header and a master switch in
  **Settings → General**;
- its own settings page under **Plugins → Task notifications →
  `topmost-notify` → chevron**, where you can change display times, upload your
  own MP3/WAV sound, and preview both the sound and the window.

No account and no API key are required. Windows 10/11 is required.

### 4.2 `dsh-voice-reply` — spoken answers

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
```

What you get after the restart:

- a short spoken summary of each finished answer (Yandex SpeechKit TTS);
- a 🔊 replay button on every answer (replays are served from the local cache);
- a settings page under **Plugins → Voice replies → Configure** for the summary
  length, voice, intonation, speed and automatic playback;
- a **Settings → General → “Read answers aloud”** switch.

The plugin needs a Yandex SpeechKit key; without it the plugin is installed but
reports “Text-to-speech is not configured”. See
[section 10](#10-after-install-the-yandex-speechkit-key).

### 4.3 `dsh-speech-to-text-yandex` — Yandex speech recognition

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

What you get after the restart:

- the `yandex-speechkit` provider in **Plugins → Voice input → Recognition
  service**;
- recognition of the recording in the cloud, without preparing the local
  SenseVoice model;
- automatic splitting of recordings longer than 28 seconds at quiet points.

The stock **Voice input** bundle must be enabled: this plugin only registers a
recognition service, the microphone UI belongs to DSH. A Yandex SpeechKit key
is also required; see [section 10](#10-after-install-the-yandex-speechkit-key).

### 4.4 Optional: the GitHub Pages mirror

The same tarballs are also published on GitHub Pages:

```powershell
dsh plugin --profile web add "https://feskel2.github.io/dsh-extras/tarballs/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://feskel2.github.io/dsh-extras/tarballs/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://feskel2.github.io/dsh-extras/tarballs/dsh-speech-to-text-yandex.tgz"
```

These URLs are shorter and normally answer without a redirect. The Pages
mirror is updated from the release; if a brand-new release is not on the mirror
yet (404), use the release URL above. Both serve the same tarballs. At the time
of writing all three Pages URLs answered **200**.

Installing several plugins in a row from any URL can hit the pnpm integrity
issue described in [section 6](#6-install-several-plugins). The downloaded-file
form below is the reliable route when that happens.

### 4.5 Optional: install a downloaded `.tgz`

If you downloaded a tarball (for example from the release page’s **Assets**
section), install it by path. From the folder that contains the file:

```powershell
dsh plugin --profile web add ".\dsh-topmost-notify.tgz"
```

An absolute path works too:

```powershell
dsh plugin --profile web add "$env:USERPROFILE\Downloads\dsh-topmost-notify.tgz"
```

This form is the most reliable one, especially when you install more than one
plugin: pnpm records an integrity hash for each local file, while a tarball URL
can lose it when the cached copy is reused. It is also the offline path and the
most reliable fallback when pnpm reports
`ERR_PNPM_MISSING_TARBALL_INTEGRITY` (see
[Troubleshooting](#11-troubleshooting)).

Keep the `.tgz` files in the same folder until you remove or update the plugin:
the profile records their paths in `package.json`, and pnpm may need the files
again when the profile changes. If a file is missing, `remove`/`add` can fail
with `ENOENT` before it touches the package.

### 4.6 After all installs

The bundle rows are written immediately, but the plugin code is loaded only
when `dsh web` starts. **Restart `dsh web` once** after the last install — see
the next section.

## 5. Restart and check

Bundles are mounted at boot. A page refresh is not enough, and settings changes
inside a plugin do not require a restart — only new plugin code does.

1. Find the terminal where `dsh web` is running and press **Ctrl + C**.
2. Start it again:

   ```powershell
   dsh web
   ```

3. Open the URL it prints. The default is usually
   `http://127.0.0.1:3080`, but the port can differ; use the exact URL from the
   terminal.
4. Open **Plugins** and check the cards/rows:

| Plugin | Where to look | What proves it is working |
|---|---|---|
| `dsh-topmost-notify` | **Plugins → Task notifications** (RU: **Плагины → Уведомления о задачах**), row `topmost-notify` → chevron | The settings page opens; **Show window** draws a sample card; **Listen** plays the chime; **Settings → General** has the master toggle |
| `dsh-voice-reply` | **Plugins → Voice replies** (RU: **Плагины → Голосовые ответы**) → **Configure** | The settings page opens; **Preview** plays a short sample after the Yandex key is configured; **Settings → General** has **Read answers aloud** |
| `dsh-speech-to-text-yandex` | **Plugins → Voice input** (RU: **Плагины → Голосовой ввод**) | The recognition service list contains **Yandex SpeechKit**; the provider reports ready; the microphone transcribes after the key is configured |

You can also ask pnpm what is installed in the profile:

```powershell
dsh plugin --profile web list --depth 0
```

You should see the package names and versions (`dsh-topmost-notify@1.1.0`,
`dsh-voice-reply@1.1.0`, `dsh-speech-to-text-yandex@0.1.0`). If the list is
empty, the command went to the wrong profile — check the `--profile web` part.

To test the notification end to end, send a short message in a chat and wait
until the turn finishes. The card appears about two seconds after the turn
ends, not instantly.

## 6. Install several plugins

All three plugins can live in the same `web` profile. Install them **one at a
time**, in any order, and restart once at the end.

The one-command URL form works on a clean profile:

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

Do not run two `dsh plugin` commands in parallel terminals: they both modify the
same profile manifest and lockfile.

### If the second URL install fails

With pnpm 10.34.9 we reproduced `ERR_PNPM_MISSING_TARBALL_INTEGRITY` on the
second command even with the explicit `v1.1.0` URL. The cause is pnpm’s cached
tarball handling: when it reuses a tarball already in its store, it can rewrite
the previously installed plugin’s lockfile entry without an integrity hash. The
tarball itself is fine — this is a pnpm cache/lockfile issue, not a broken
release. Another pnpm version may behave differently; the local-file route below
works regardless.

The reliable route for several plugins is to download all three `.tgz` files
once and install the **local files** one after another:

```powershell
$dir = Join-Path $env:USERPROFILE 'Downloads\dsh-extras'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -L -o "$dir\dsh-topmost-notify.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
curl.exe -L -o "$dir\dsh-voice-reply.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
curl.exe -L -o "$dir\dsh-speech-to-text-yandex.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"

dsh plugin --profile web add "$dir\dsh-topmost-notify.tgz"
dsh plugin --profile web add "$dir\dsh-voice-reply.tgz"
dsh plugin --profile web add "$dir\dsh-speech-to-text-yandex.tgz"
```

A local file always gets an integrity hash, so this sequence does not hit the
error. It is also the offline route.

If you already hit the error and one plugin is installed with a broken lockfile
entry, recover in this order:

1. Delete the lockfile.
2. Remove the package **named in the error** (usually the plugin that was
   already installed).
3. Download all three `.tgz` files and install them as local files above.
4. Restart `dsh web`.

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
Remove-Item (Join-Path $profileDir 'pnpm-lock.yaml') -Force
dsh plugin --profile web remove dsh-topmost-notify   # use the name from the error
```

If `remove` itself stops on the same error for another package, delete the
lockfile again and remove that package too, until the broken entries are gone.

### Other failures

- **`ERR_PNPM_OUTDATED_LOCKFILE` / lockfile error** — delete only
  `pnpm-lock.yaml` in the profile directory and retry. The profile regenerates
  the lockfile; `package.json` and `pnpm-workspace.yaml` must stay.

  ```powershell
  Remove-Item (Join-Path $profileDir 'pnpm-lock.yaml') -Force
  ```

- **`ERR_PNPM_MISSING_TARBALL_INTEGRITY`** — use the local-file sequence
  above. This is more common when the same version is reinstalled or after a
  previous failed attempt.

- **Peer warning about `@deepseek-ai/schemastery`** — expected for
  `dsh-topmost-notify`; DSH supplies that package at runtime. The warning does
  not mean the install failed. See [Troubleshooting](#11-troubleshooting).

The order does not matter: the voice plugins are independent, and
`dsh-speech-to-text-yandex` only adds a provider to the stock Voice input
bundle.

## 7. Update a plugin

There is no `dsh plugin update` command that understands “the next GitHub
release”. Updating means: **remove the old package, install the new tarball,
restart**. This is also how you reinstall the same version.

### 7.1 What survives and what is deleted

The pnpm install replaces the package directory under
`node_modules\<plugin>`. Anything stored inside that directory is deleted:

| Plugin | Deleted on update | Where it lives |
|---|---|---|
| `dsh-voice-reply` | The Yandex key **and** the UI choices (voice, intonation, speed, summary length, auto-speak) | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-voice-reply\plugin-config.json` |
| `dsh-speech-to-text-yandex` | The Yandex key and the plugin settings (topic, chunk size, debug, …) | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-speech-to-text-yandex\plugin-config.json` |
| `dsh-topmost-notify` | Custom sounds uploaded through the settings page | `...\node_modules\dsh-topmost-notify\sounds\` |

`dsh-topmost-notify` display times, sound switches and the master toggle are
stored in the **profile configuration** (`cordis.patch.yml`), not in the package
directory, so those choices survive. A custom sound file does not: the setting
still points to the old `sounds\...` path, the file is gone, and the plugin
falls back to the bundled chime until you upload it again.

### 7.2 Back up the local files first

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$backup = Join-Path $env:USERPROFILE 'Desktop\dsh-extras-backup'
New-Item -ItemType Directory -Force -Path $backup | Out-Null

Copy-Item "$profileDir\node_modules\dsh-voice-reply\plugin-config.json" `
  "$backup\dsh-voice-reply.plugin-config.json" -ErrorAction SilentlyContinue
Copy-Item "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.json" `
  "$backup\dsh-speech-to-text-yandex.plugin-config.json" -ErrorAction SilentlyContinue
Copy-Item "$profileDir\node_modules\dsh-topmost-notify\sounds" `
  "$backup\topmost-sounds" -Recurse -ErrorAction SilentlyContinue
```

If a file does not exist, the `-ErrorAction SilentlyContinue` simply skips it.
You can also copy these files by hand in File Explorer.

### 7.3 Update procedure

1. Find the new tag on the
   [releases page](https://github.com/Feskel2/dsh-extras/releases) and download
   the new asset, for example `dsh-voice-reply.tgz`, to a local folder such as
   `%USERPROFILE%\Downloads\dsh-extras\`.
2. Stop `dsh web` (**Ctrl + C**). This is not strictly required on every
   system, but on Windows it avoids “file is in use” errors and makes the
   update deterministic.
3. Remove the old package.
4. Install the new tarball from the downloaded file.
5. Restore the backup files.
6. Start `dsh web` again.

```powershell
dsh plugin --profile web remove dsh-voice-reply
dsh plugin --profile web add "$env:USERPROFILE\Downloads\dsh-extras\dsh-voice-reply.tgz"

Copy-Item "$backup\dsh-voice-reply.plugin-config.json" `
  "$profileDir\node_modules\dsh-voice-reply\plugin-config.json" -ErrorAction SilentlyContinue
```

If the old install came from a local `.tgz`, keep that file where it was:
`remove` resolves every local `file:` dependency in the profile, and a missing
old file makes it fail with `ENOENT`.

On a profile with only this plugin, the URL form also works:
`dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.1/dsh-voice-reply.tgz"`.
In a profile with several plugins, prefer the downloaded file: a URL add can hit
the integrity issue described in [section 6](#6-install-several-plugins) on
another installed plugin.

For `dsh-topmost-notify`, restore the sounds after the install:

```powershell
New-Item -ItemType Directory -Force -Path "$profileDir\node_modules\dsh-topmost-notify\sounds" | Out-Null
Copy-Item "$backup\topmost-sounds\*" `
  "$profileDir\node_modules\dsh-topmost-notify\sounds\" -Recurse -ErrorAction SilentlyContinue
```

Then restart `dsh web`. The downloaded file always records an integrity hash,
which is why it is the preferred update form in a profile with several plugins.
If you reinstall the **same** version and a URL add still produces
`ERR_PNPM_MISSING_TARBALL_INTEGRITY`, use the local file form:

```powershell
dsh plugin --profile web add ".\dsh-voice-reply.tgz"
```

## 8. Uninstall a plugin

Remove one package at a time, then restart `dsh web`:

```powershell
dsh plugin --profile web remove dsh-topmost-notify
dsh plugin --profile web remove dsh-voice-reply
dsh plugin --profile web remove dsh-speech-to-text-yandex
```

You only need the line for the plugin you want to remove. `remove` also deletes
the bundle row from the profile, so the plugin disappears from **Plugins** after
the restart.

What remains:

- `dsh-topmost-notify`: the package folder (including `sounds\` and
  `host\notify-debug.log`) is deleted. Back up `sounds\` first if you want to
  keep your custom files. If you once added a `- id:
  topmost-notify` block to the profile’s `cordis.patch.yml` by hand, remove that
  block too.
- `dsh-voice-reply`: the package folder is deleted. The audio cache in
  `%TEMP%\dsh-voice-reply-cache` may remain; delete it manually for a clean
  removal.
- `dsh-speech-to-text-yandex`: the package folder is deleted together with its
  `plugin-config.json` and `.state\events.log`. The stock SenseVoice provider
  stays available in Voice input.

## 9. Offline install

The tarballs are self-contained: the plugins have no runtime dependencies of
their own (the `dsh-topmost-notify` schemastery peer is supplied by DSH), so a
machine that can receive a `.tgz` file can install it without npm.

On a connected machine:

1. Open the [v1.1.0 release page](https://github.com/Feskel2/dsh-extras/releases/tag/v1.1.0).
2. Under **Assets**, download the three `.tgz` files (or only the one you need).
3. Copy them to the offline machine, for example into
   `C:\Users\<you>\Downloads\dsh-extras\`.

Alternatively, download with PowerShell:

```powershell
$dir = Join-Path $env:USERPROFILE 'Downloads\dsh-extras'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -L -o "$dir\dsh-topmost-notify.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
curl.exe -L -o "$dir\dsh-voice-reply.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
curl.exe -L -o "$dir\dsh-speech-to-text-yandex.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

On the offline machine, in PowerShell:

```powershell
cd "$env:USERPROFILE\Downloads\dsh-extras"
dsh plugin --profile web add ".\dsh-topmost-notify.tgz"
dsh plugin --profile web add ".\dsh-voice-reply.tgz"
dsh plugin --profile web add ".\dsh-speech-to-text-yandex.tgz"
```

Then restart `dsh web`. The installed copy stays in the profile, but the profile
records the local path in `package.json`; keep the `.tgz` files if you want to be
able to reinstall or repair the profile later.

Caveat: if the profile is brand new and pnpm needs to resolve other profile
dependencies from the registry, the first install may still want network access.
On a machine that already runs `dsh web`, the profile is initialized and the
local tarballs are enough. No checksums are published with the release; download
the files from the official release page and do not use mirrors you do not
trust.

## 10. After install: the Yandex SpeechKit key

The two voice plugins are installed without credentials. The key is **not**
inside any `.tgz`; it is created in Yandex Cloud and stored locally. The full
walkthrough — billing, folder, service account, roles, key scopes, verification,
logs and rotation — is in:

- [Yandex SpeechKit setup](yandex-speechkit-setup.md) (English)
- [Настройка Yandex SpeechKit](yandex-speechkit-setup.ru.md) (Russian)

The short version:

| Plugin | Role on the folder | API-key scope | Environment variable | Local file |
|---|---|---|---|---|
| `dsh-voice-reply` | `ai.speechkit-tts.user` | `yc.ai.speechkitTts.execute` | `YANDEX_TTS_API_KEY` | `...\node_modules\dsh-voice-reply\plugin-config.json` |
| `dsh-speech-to-text-yandex` | `ai.speechkit-stt.user` | `yc.ai.speechkitStt.execute` | `YANDEX_STT_API_KEY` | `...\node_modules\dsh-speech-to-text-yandex\plugin-config.json` |

A TTS key and an STT key are different keys. A key issued only for recognition
is rejected by synthesis with `401 UNAUTHORIZED`, and vice versa.

The simplest local route is `plugin-config.json`:

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}

# voice replies (TTS)
Copy-Item "$profileDir\node_modules\dsh-voice-reply\plugin-config.example.json" `
  "$profileDir\node_modules\dsh-voice-reply\plugin-config.json"
notepad "$profileDir\node_modules\dsh-voice-reply\plugin-config.json"

# speech recognition (STT)
Copy-Item "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.example.json" `
  "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.json"
notepad "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.json"
```

Fill `apiKey` (or `iamToken` + `folderId`) and save the file as **UTF-8 without
BOM**. `plugin-config.json` is re-read on every request, so replacing the key
does not require a restart. Environment variables are read when `dsh web`
starts, so they do require a restart.

Check the result:

- `dsh-voice-reply`: **Plugins → Voice replies → Configure → Preview**, then ask
  a short question in a chat. The first automatic playback may require one click
  on the page because of the browser autoplay policy.
- `dsh-speech-to-text-yandex`: **Plugins → Voice input**, choose **Yandex
  SpeechKit** if it is not selected, allow microphone access, and record a short
  phrase.

SpeechKit is a paid service: every uncached synthesis and every recognition
request is billed by Yandex Cloud. Cached replays in `dsh-voice-reply` are free.
Never put the key into this repository, a chat message, a screenshot, or the
profile’s `cordis.patch.yml`.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `dsh : The term 'dsh' is not recognized…` | DSH’s global bin directory is not on `PATH`, or the terminal was opened before DSH was installed | Close and reopen PowerShell; run `Get-Command dsh` and `where.exe dsh`. If nothing is found, add the npm global prefix (`npm config get prefix`) to `PATH`, or call the launcher by its full path (`& "$env:APPDATA\npm\dsh.cmd"`). |
| `dsh.ps1 cannot be loaded because running scripts is disabled` | PowerShell execution policy blocks the `.ps1` launcher | Use `dsh.cmd` instead of `dsh` (it is installed next to it), or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and confirm. |
| `dsh: pnpm was not found; install pnpm…` / exit code `127` | `dsh plugin` forwards to pnpm, but pnpm is not on `PATH` | Install pnpm (for example with Corepack: `corepack enable pnpm`) and reopen the terminal; check `pnpm --version`. |
| `ERR_PNPM_MISSING_TARBALL_INTEGRITY` | The URL redirects (`latest/download`), or pnpm is reusing a cached tarball without an integrity hash — especially on the second plugin install | Use an explicit version URL (`.../download/v1.1.0/...`), delete `pnpm-lock.yaml` and retry. If it persists, follow the recovery in [section 6](#6-install-several-plugins): delete the lockfile, remove the package named in the error, then install all three from downloaded local `.tgz` files. A local file always records the hash. |
| `ERR_PNPM_OUTDATED_LOCKFILE` or another lockfile error | The profile lockfile is stale after an interrupted or concurrent install | Delete **only** `pnpm-lock.yaml` in the profile directory (`$profileDir\pnpm-lock.yaml`) and retry. Do not delete `package.json` or `pnpm-workspace.yaml`; the lockfile is regenerated. |
| `WARN Issues with peer dependencies found … missing peer @deepseek-ai/schemastery@^3.19.0` | `dsh-topmost-notify` declares DSH’s schemastery as a peer; pnpm does not install peers in a DSH profile | Harmless. DSH supplies the package at runtime; the install still succeeds. Do not run `npm install` inside the profile to “fix” it. |
| Pages URL answers `404` | The Pages deployment is unavailable or still being built | Use the explicit release URL from [section 4](#4-install-the-plugins), or the local `.tgz`. Both contain the same files. |
| GitHub URL answers `404` | Wrong tag, wrong file name, or a typo in the URL | Open the [releases page](https://github.com/Feskel2/dsh-extras/releases), copy the exact asset link for the tag. Use `v1.1.0`, not `1.1.0`, and keep the file name exact. |
| Download fails: TLS, proxy, timeout | Corporate proxy, VPN, or GitHub is unreachable | Test `curl.exe -I https://github.com`; set `HTTPS_PROXY` for the DSH process; try another network; or use the offline `.tgz` route. |
| `EPERM: operation not permitted` / “file is in use” during update or remove | `dsh web` or an editor is holding a file in the package directory | Stop `dsh web` (**Ctrl + C**), close editors/antivirus scans on that folder, retry the command. |
| `ENOENT: no such file or directory … .tgz` | The profile was installed from a local `.tgz`, and that file was moved or deleted; pnpm resolves every local `file:` dependency on the next change | Restore the `.tgz` to the recorded path (or re-download it there) and retry. Keep local tarballs in place until you remove or update the plugin. |
| Install prints `Done`, but the plugin is missing after restart | Installed into another profile, or `dsh web` was not restarted | Check the command contains `--profile web`; run `dsh plugin --profile web list --depth 0`; restart `dsh web` again and check **Plugins**. |
| `dsh: installation rejected: … engines.dsh` or a version warning | DSH is outside `>=0.2.2-rc.1 <0.3.0-0` | Update DSH to a `0.2.x` build in that range (`dsh --version`). Do not edit the plugin’s `package.json`. |
| `Cannot find module '@deepseek-ai/schemastery'` at boot | DSH installation is incomplete, or the plugin was loaded outside DSH | Reinstall/update DSH; the peer is supplied by DSH. The `WARN` during install is not this error. |
| Notification card does not appear | Master toggle off, chat muted with the bell, exclusive fullscreen, or the turn is still running | Check **Settings → General** and the 🔔 in the chat header; wait ~2–3 seconds after the turn ends; test with **Plugins → Task notifications → Show window**. Exclusive DirectX fullscreen can cover topmost windows. |
| Notification card appears but there is no sound | Sound disabled for that kind, system volume, or a custom file was deleted by an update | Check the plugin settings page; re-upload the MP3/WAV; the bundled chime is the fallback. |
| `dsh-voice-reply` says “Text-to-speech is not configured” | No key in the environment or `plugin-config.json` | Follow [section 10](#10-after-install-the-yandex-speechkit-key); check the key is in the file next to `index.js`. |
| Voice reply returns `401 UNAUTHORIZED` / `Permission denied` | The key belongs to an STT-only key, the service account lacks `ai.speechkit-tts.user`, or the role has not propagated yet | Create a TTS-scoped key (`yc.ai.speechkitTts.execute`) and grant the TTS role; wait a few minutes after a role change. |
| Voice reply is silent on the first answer | Browser autoplay policy blocked automatic playback | Click the page once, then press the 🔊 button; later answers can autoplay. The plugin also defers speech while the tab is hidden or unfocused. |
| Voice reply returns `429` or stops mid-answer | Yandex quota/rate limit, or a long text is being synthesized in chunks | Wait and retry; reduce the spoken-summary length on the plugin settings page; check Yandex Cloud quotas. |
| `dsh-speech-to-text-yandex` is not in the recognition-service list | The stock **Voice input** bundle is disabled, or `dsh web` was not restarted | Enable **Plugins → Voice input**, restart `dsh web`, reopen the settings page. The provider appears as **Yandex SpeechKit**. |
| STT returns `401` / `403` | Wrong key type (TTS key used for STT), missing `ai.speechkit-stt.user`, or an IAM token without a folder ID | Use an STT-scoped key (`yc.ai.speechkitStt.execute`) or an IAM token plus `folderId`; check the role on the folder. |
| Microphone records but nothing is inserted | Browser microphone permission, wrong recognition service selected, or no network to `stt.api.cloud.yandex.net` | Allow the microphone for the DSH origin; select **Yandex SpeechKit**; check the browser console and the plugin’s `.state\events.log`. |
| Plugin reports “Invalid JSON” for `plugin-config.json` | Comments, a trailing comma, or a UTF-8 BOM in the file | Remove comments/trailing commas and save as UTF-8 without BOM; validate with `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "path\to\plugin-config.json"`. |
| Everything installed, but `dsh web` starts the old UI | The running process was not restarted, or another `dsh web` instance owns the port | Stop the old process (**Ctrl + C**) and start `dsh web` again; open the URL printed by the new process. |

## 12. Quick reference

```powershell
# Check the environment
dsh --version
node --version
pnpm --version

# Profile path
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$profileDir

# Install (release v1.1.0) — one at a time
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"

# Installed packages
dsh plugin --profile web list --depth 0

# Remove
dsh plugin --profile web remove dsh-topmost-notify
dsh plugin --profile web remove dsh-voice-reply
dsh plugin --profile web remove dsh-speech-to-text-yandex

# Restart after install/update/remove
dsh web
```

- Release page: <https://github.com/Feskel2/dsh-extras/releases/tag/v1.1.0>
- Yandex SpeechKit setup:
  [English](yandex-speechkit-setup.md) ·
  [Русский](yandex-speechkit-setup.ru.md)
- Plugin sources:
  [`dsh-topmost-notify`](../dsh-topmost-notify/README.md) ·
  [`dsh-voice-reply`](../dsh-voice-reply/README.md) ·
  [`dsh-speech-to-text-yandex`](../dsh-speech-to-text-yandex/README.md)
