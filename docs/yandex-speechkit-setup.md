# Yandex SpeechKit setup: from an empty account to working voice

This guide walks through the whole Yandex Cloud side for the two DSH voice plugins:

| Plugin | What it does | SpeechKit service |
|---|---|---|
| [`dsh-voice-reply`](../dsh-voice-reply/README.md) | Reads a short spoken summary of every finished answer (TTS) | Speech synthesis |
| [`dsh-speech-to-text-yandex`](../dsh-speech-to-text-yandex/README.md) | Adds the `yandex-speechkit` provider to Voice input (STT) | Speech recognition |

The plugins are independent, but the setup is almost the same: one cloud account, one billing account, one folder, one service account with one or two roles, and one or two API keys. **A TTS key and an STT key are different keys** — their scopes are different, and one will not work in place of the other.

**Quick path (if you already know Yandex Cloud):** create a folder → create a service account → grant `ai.speechkit-tts.user` and/or `ai.speechkit-stt.user` on that folder → create an API key with the scope `yc.ai.speechkitTts.execute` and/or `yc.ai.speechkitStt.execute` → copy the key into `plugin-config.json` next to the installed plugin (or into the environment) → restart `dsh web` → check the result on the plugin settings page. The rest of this document explains each step, the exact names, and what to do when it does not work.

> SpeechKit is a paid service. Nothing here is free by default: every uncached synthesis and every recognition request is billed by Yandex Cloud. See [Cost](#7-cost) before you leave it running.

This guide was checked against the Yandex Cloud documentation in November 2026. Yandex now documents SpeechKit as part of Yandex AI Studio, so some `yandex.cloud/.../speechkit/...` links redirect to `aistudio.yandex.ru`; both are official.

## Contents

1. [What you need](#1-what-you-need)
2. [Create the cloud side](#2-create-the-cloud-side)
3. [Deliver the secret to the plugin](#3-deliver-the-secret-to-the-plugin)
4. [Verify that it works](#4-verify-that-it-works)
5. [Troubleshooting](#5-troubleshooting)
6. [Rotation and security](#6-rotation-and-security)
7. [Cost](#7-cost)
8. [Official documentation links](#8-official-documentation-links)

## 1. What you need

| Piece | Why it is needed |
|---|---|
| **Yandex Cloud account** (a Yandex ID) | Owns the cloud, the folder and the keys; you work in the [management console](https://console.yandex.cloud) |
| **Active billing account** | SpeechKit is a paid service; an account without active billing cannot call it |
| **Folder** (Russian: *каталог*) | The container that holds the service account; roles are assigned on the folder and its ID is the `folderId` |
| **Service account** | A non-human account that owns the API key; the plugin authenticates as this account |
| **Role** on the folder | Gives the service account permission to call synthesis or recognition |
| **API key with a scope** (or an IAM token) | The secret itself; the scope restricts what this particular key may call |

Plus, on the DSH side:

- DSH `>=0.2.2-rc.1 <0.3.0-0`, profile `web`, Node.js `>=24.9.0`;
- outbound HTTPS to `tts.api.cloud.yandex.net` and/or `stt.api.cloud.yandex.net`;
- a browser that can play audio (for TTS) and a microphone (for STT).

### The two plugins and what they share

| | `dsh-voice-reply` (TTS) | `dsh-speech-to-text-yandex` (STT) |
|---|---|---|
| Role on the folder | `ai.speechkit-tts.user` | `ai.speechkit-stt.user` |
| API-key scope | `yc.ai.speechkitTts.execute` | `yc.ai.speechkitStt.execute` |
| Endpoint | `https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize` | `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize` |
| Credential sources | environment, then `plugin-config.json` | `cordis.patch.yml` config, then environment, then `plugin-config.json`, then defaults |
| Install | `dsh plugin --profile web add dsh-voice-reply` | `dsh plugin --profile web add dsh-speech-to-text-yandex` |

What they share:

- the same cloud account, folder and (if you want) the same service account;
- the same two local delivery mechanisms — environment variables and a local `plugin-config.json`;
- the same authentication modes — `Authorization: Api-Key <key>` or `Authorization: Bearer <IAM token>` plus a folder ID;
- the same security model — the key stays in the `dsh web` host process, is never sent to the browser and never written to the plugin log;
- the same billing — Yandex Cloud charges for every call that is not served from a local cache.

One service account with both roles is enough. Create **two API keys** (one per scope) rather than one key with both scopes: if a key leaks, you revoke only the affected service.

## 2. Create the cloud side

You need access to the folder with permission to create service accounts and assign roles (`iam.serviceAccounts.admin` or higher, or the folder owner). If you are the only user of a fresh account, you already have it.

### 2.1 Enable billing

1. Open [Yandex Cloud Billing](https://center.yandex.cloud/billing/accounts).
2. Create a billing account if you do not have one and link a payment method.
3. Make sure the account is **active** and has no blocking debt. For individuals, new accounts usually start in paid consumption; a trial and a starting grant depend on the account type, region and date — check what your billing page shows instead of assuming a free period.

Official page: [Register an account in Yandex Cloud](https://yandex.cloud/en/docs/billing/quickstart/).

**Checkpoint:** the billing page says the account is active, and the cloud is not blocked for non-payment.

### 2.2 Create a folder

The folder is where the service account and its roles live. Its ID is what the plugins call `folderId`.

Console:

1. In the [console](https://console.yandex.cloud), select your cloud in the top bar.
2. Open the cloud page and click **Create folder**.
3. Give it a clear name, for example `dsh-speechkit`, and create it.
4. Open the folder and copy its **ID** (a string like `b1g...`). The ID is not a secret, but you will need it for IAM mode.

CLI (optional):

```powershell
yc resource-manager folder create --name dsh-speechkit
yc resource-manager folder list
yc config get folder-id
```

`yc config get folder-id` prints the folder selected in the current CLI profile; `yc resource-manager folder list` shows all folders with their IDs.

Official pages: [Create a folder](https://yandex.cloud/en/docs/resource-manager/operations/folder/create) and [Get a folder ID](https://yandex.cloud/en/docs/resource-manager/operations/folder/get-id).

**Checkpoint:** you have a folder ID written down somewhere that is not the plugin config.

### 2.3 Create a service account

Console:

1. Select the folder in the top bar.
2. Go to **Identity and Access Management** (the console shortcut is [console.yandex.cloud/link/iam](https://console.yandex.cloud/link/iam)).
3. Open **Service accounts** and click **Create service account**.
4. Name it, for example `dsh-speechkit`. Names are 3–63 characters: lowercase Latin letters, digits and hyphens, starting with a letter and not ending with a hyphen.
5. Click **Create**. The account is created inside the selected folder and cannot be moved later.

CLI:

```powershell
yc iam service-account create --name dsh-speechkit
yc iam service-account get dsh-speechkit
```

The `id:` field of the output is the service-account ID; you will need it for CLI role assignment.

Official page: [Create a service account](https://yandex.cloud/en/docs/iam/operations/sa/create).

### 2.4 Grant the roles

The service account needs permission on the **folder** (roles assigned to a cloud or organization are inherited by the folder too, but assigning on the folder is the least surprising option).

| Plugin | Role |
|---|---|
| `dsh-voice-reply` | `ai.speechkit-tts.user` |
| `dsh-speech-to-text-yandex` | `ai.speechkit-stt.user` |

If you use both plugins, grant both roles to the same account.

Console:

1. Open the folder page.
2. Go to the **Access bindings** tab.
3. Click **Configure access**.
4. Open the **Service accounts** section and select `dsh-speechkit`.
5. Click **Add role**, find `ai.speechkit-tts.user` and/or `ai.speechkit-stt.user`, and add them.
6. Click **Save**.

CLI:

```powershell
yc resource-manager folder add-access-binding <folder-id> `
  --role ai.speechkit-tts.user `
  --service-account-id <service-account-id>

yc resource-manager folder add-access-binding <folder-id> `
  --role ai.speechkit-stt.user `
  --service-account-id <service-account-id>
```

Check what is assigned:

```powershell
yc resource-manager folder list-access-bindings <folder-id>
```

Official pages: [Assign a role to a service account](https://yandex.cloud/en/docs/iam/operations/sa/assign-role-for-sa) and [SpeechKit access management](https://yandex.cloud/en/docs/speechkit/security/).

**Propagation:** new permissions usually apply within seconds, but can take a few minutes. A single `401`/`403` immediately after granting a role is normal; retry in a couple of minutes before changing anything else.

**Checkpoint:** the folder's access list contains the role and the service account; or `list-access-bindings` prints it.

### 2.5 Create an API key

The API key is the recommended credential for a desktop install: it does not expire unless you set an expiry date, and it does not need a refresh job.

Console:

1. Go to **Identity and Access Management → Service accounts**.
2. Open `dsh-speechkit`.
3. In the **API keys** block, click **Create new key** and choose **Create API key**.
4. Add a description, for example `dsh-voice-reply TTS` or `dsh-speech-to-text STT`. It makes the keys easy to tell apart later.
5. In **Scope**, select exactly one scope for this key:
   - `yc.ai.speechkitTts.execute` — for `dsh-voice-reply`;
   - `yc.ai.speechkitStt.execute` — for `dsh-speech-to-text-yandex`.
6. Optionally set an **expiry date**. A key with an expiry date is safer, but you must remember to rotate it.
7. Click **Create**.
8. **Copy the secret key immediately.** Yandex Cloud shows it only once, in the creation dialog; after you close the dialog only the masked value remains. If you lose it, delete the key and create a new one — it cannot be recovered.

CLI:

```powershell
yc iam api-key create `
  --service-account-name dsh-speechkit `
  --description "dsh-voice-reply TTS" `
  --scopes yc.ai.speechkitTts.execute

yc iam api-key create `
  --service-account-name dsh-speechkit `
  --description "dsh-speech-to-text STT" `
  --scopes yc.ai.speechkitStt.execute
```

Each command prints YAML that contains the `secret:` field — save it immediately.

Two details that often cause confusion:

- **No scope is not the same as the CLI default.** If you leave the scope empty in the console, the key is limited only by the service account's roles (broader). If you omit `--scopes` in the CLI, Yandex assigns a default list of scopes that already includes both SpeechKit scopes. For least privilege, specify the one scope you need explicitly.
- **An API key is not an IAM token.** Do not paste it into `YANDEX_TTS_IAM_TOKEN` or `YANDEX_STT_IAM_TOKEN`. The API key goes into `..._API_KEY`; the IAM token is a different, short-lived string.

Official pages: [Manage API keys](https://yandex.cloud/en/docs/iam/operations/authentication/manage-api-keys) and [API key concepts and scopes](https://yandex.cloud/en/docs/iam/concepts/authorization/api-key).

**Checkpoint:** you have two secrets (or one, if you only use one plugin) stored in a password manager, and each key's scope matches its plugin.

### 2.6 IAM token instead of an API key

An IAM token is a short-lived bearer token. The plugins support it, but for a desktop install an API key is simpler.

Get a token with the Yandex Cloud CLI:

```powershell
yc iam create-token
```

The output is the token (it starts with `t1.`). Requirements:

- the CLI must be installed and authenticated ([CLI quick start](https://yandex.cloud/en/docs/cli/quickstart));
- for a **service-account** token, the CLI profile must be configured with an authorized key of that service account; the authorized key file is not the same thing as an API key, and it must not be pasted into the plugin;
- the token lives **at most 12 hours**, and Yandex recommends refreshing it more often, for example every hour;
- in IAM mode you must also provide the folder ID: `YANDEX_TTS_FOLDER_ID` / `YANDEX_STT_FOLDER_ID`, or `folderId` in `plugin-config.json`.

When an IAM token is reasonable:

- a short debugging session where you do not want to create a key;
- automation that obtains a fresh token itself (metadata service, JWT exchange, CI secret refresh) and can replace it before it expires;
- a machine where a secret manager injects a short-lived token at process start.

When it is a bad fit:

- a desktop that runs `dsh web` for days: the token expires and TTS/STT start returning `401` in the middle of the day;
- a setup where nobody will remember to update it.

**Important:** if both an IAM token and an API key are present, **the IAM token wins**. An expired token then produces `401` even though a perfectly valid API key is sitting in the same file. If you switch back to an API key, clear the IAM fields rather than leaving a stale token next to the key.

Official pages: [Get an IAM token for a Yandex account](https://yandex.cloud/en/docs/iam/operations/iam-token/create) and [Get an IAM token for a service account](https://yandex.cloud/en/docs/iam/operations/iam-token/create-for-sa).

### 2.7 Checklist before touching DSH

- [ ] billing account is active;
- [ ] folder exists, its ID is known;
- [ ] service account `dsh-speechkit` exists;
- [ ] the folder access list contains `ai.speechkit-tts.user` and/or `ai.speechkit-stt.user`;
- [ ] one API key per plugin, each with the matching scope;
- [ ] the secrets are stored somewhere safe and are not in the repository;
- [ ] the plugin(s) are installed:
  ```powershell
  dsh plugin --profile web add dsh-voice-reply
  dsh plugin --profile web add dsh-speech-to-text-yandex
  ```

## 3. Deliver the secret to the plugin

### 3.1 How the plugins read credentials

Both plugins resolve credentials per request. The exact precedence differs, and this matters when you change one source and nothing happens:

| Plugin | Order (first non-empty wins) |
|---|---|
| `dsh-voice-reply` | **environment → `plugin-config.json`** |
| `dsh-speech-to-text-yandex` | **`cordis.patch.yml` config → environment → `plugin-config.json` → built-in defaults** |

Common rules in both:

- **IAM token beats API key.** If any IAM token field is non-empty, the plugin authenticates with `Bearer` and expects a folder ID; otherwise it uses `Api-Key`. The precedence is applied **per field**, and the auth mode is chosen afterwards: a stale IAM token left in the lower-priority source still beats a fresh API key in the higher-priority source. Clear the IAM fields when you switch to a key.
- **Empty values fall through.** An empty string (or whitespace) in a higher-priority source is skipped, not treated as "deliberately empty".
- **`plugin-config.json` is re-read on every request.** Replacing a key there takes effect on the next synthesis or recognition, with no `dsh web` restart.
- **Environment variables are fixed when `dsh web` starts.** Changing them requires restarting the process.
- The plugin-specific names differ (`YANDEX_TTS_*` vs `YANDEX_STT_*`), but the legacy fallback names are identical in both plugins. Do not use the legacy names to give the two plugins different keys — they will read the same value.

Environment variables:

| Purpose | TTS (`dsh-voice-reply`) | STT (`dsh-speech-to-text-yandex`) |
|---|---|---|
| API key | `YANDEX_TTS_API_KEY` | `YANDEX_STT_API_KEY` |
| IAM token | `YANDEX_TTS_IAM_TOKEN` | `YANDEX_STT_IAM_TOKEN` |
| Folder ID (IAM only) | `YANDEX_TTS_FOLDER_ID` | `YANDEX_STT_FOLDER_ID` |
| Legacy fallbacks | `YANDEX_SPEECHKIT_API_KEY`, `YANDEX_SPEECHKIT_IAM_TOKEN`, `YANDEX_SPEECHKIT_FOLDER_ID` | the same three names |
| Short aliases | `YC_API_KEY`, `YC_IAM_TOKEN`, `YC_FOLDER_ID` | the same three names |

The plugin strips a pasted authorization prefix (`Api-Key `, `Bearer `, `apikey `) from the value, so copying the whole header is harmless. Still, paste only the secret.

One optional shortcut: DSH loads a `.env` file from the directory it is started in and from `$DSH_HOME\.env` into the process environment at boot. Values already present in the real environment win. This behaves like environment variables — it is read at startup and needs a restart — but it keeps the secret out of your PowerShell profile and out of `node_modules`.

### 3.2 Option A — environment variables

Use this when you do not want the secret inside the plugin package directory, or when several processes should get it from one place.

Temporary, for the current PowerShell window only:

```powershell
$env:YANDEX_TTS_API_KEY = '<tts-api-key>'
$env:YANDEX_STT_API_KEY = '<stt-api-key>'
dsh web
```

Permanent, for the current Windows user (new processes only):

```powershell
[Environment]::SetEnvironmentVariable('YANDEX_TTS_API_KEY', '<tts-api-key>', 'User')
[Environment]::SetEnvironmentVariable('YANDEX_STT_API_KEY', '<stt-api-key>', 'User')
```

The classic alternative:

```powershell
setx YANDEX_TTS_API_KEY "<tts-api-key>"
setx YANDEX_STT_API_KEY "<stt-api-key>"
```

Both forms write to the user environment. `setx` does not update the current window and also applies only to processes started afterwards.

If you use an IAM token, set the token and the folder ID instead:

```powershell
[Environment]::SetEnvironmentVariable('YANDEX_TTS_IAM_TOKEN', '<iam-token>', 'User')
[Environment]::SetEnvironmentVariable('YANDEX_TTS_FOLDER_ID', '<folder-id>', 'User')
```

Then **restart `dsh web` from the same environment**:

1. Stop the running `dsh web` process (Ctrl+C in its window, or close the window it was started from).
2. Close the terminal in which you set the variables and open a new one — an already-open terminal does not see the new user environment.
3. Start `dsh web` again and open the URL it prints.

If `dsh web` is started from a desktop shortcut, a scheduled task or the startup folder, the shortcut is launched by Explorer. After setting a user variable, sign out and sign back in (or restart Explorer) so the new process inherits it. Restarting only the DSH session or reloading the page is not enough: **environment variables are read once, when the host process starts.**

Check that the variable is visible without printing the secret:

```powershell
if ([Environment]::GetEnvironmentVariable('YANDEX_TTS_API_KEY', 'User')) { 'set' } else { 'missing' }
```

Why this order matters: `plugin-config.json` is read on every request, while the environment is a snapshot of the process. If you change an environment variable and the plugin still behaves as before, the host was not restarted from an environment that contains the new value.

### 3.3 Option B — `plugin-config.json` next to the plugin

This is the easiest option for a single-user desktop: one file per plugin, no restart, no system-wide state.

After a normal `dsh plugin --profile web add`, the packages live in the `web` profile:

| Plugin | File |
|---|---|
| `dsh-voice-reply` | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-voice-reply\plugin-config.json` |
| `dsh-speech-to-text-yandex` | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-speech-to-text-yandex\plugin-config.json` |

If `DSH_HOME` is set, replace `%USERPROFILE%\.dsh` with its value:

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ttsDir = Join-Path $dshHome 'profiles\web\node_modules\dsh-voice-reply'
$sttDir = Join-Path $dshHome 'profiles\web\node_modules\dsh-speech-to-text-yandex'
```

Create the files from the shipped examples:

```powershell
Copy-Item (Join-Path $ttsDir 'plugin-config.example.json') (Join-Path $ttsDir 'plugin-config.json')
Copy-Item (Join-Path $sttDir 'plugin-config.example.json') (Join-Path $sttDir 'plugin-config.json')
notepad (Join-Path $ttsDir 'plugin-config.json')
notepad (Join-Path $sttDir 'plugin-config.json')
```

If a file already exists, edit it instead of overwriting it — it may already contain your key and your settings.

Minimal TTS file (fields you omit fall back to defaults):

```json
{
  "apiKey": "<tts-api-key>"
}
```

Minimal STT file:

```json
{
  "apiKey": "<stt-api-key>"
}
```

With the full example file, keep the tuning fields and fill only the credentials. For TTS:

```json
{
  "apiKey": "<tts-api-key>",
  "iamToken": "",
  "folderId": "",
  "endpoint": "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize",
  "voice": "marina",
  "lang": "ru-RU",
  "format": "mp3",
  "speed": 1.32,
  "summaryMaxChars": 500,
  "debug": false,
  "logFile": ".state/events.log",
  "autoSpeak": true
}
```

For STT, the example file is:

```json
{
  "apiKey": "<stt-api-key>",
  "folderId": "",
  "iamToken": "",
  "endpoint": "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
  "topic": "general",
  "profanityFilter": false,
  "rawResults": false,
  "chunkSeconds": 25,
  "searchBackSeconds": 3,
  "requestTimeoutMs": 45000,
  "maxAttempts": 3,
  "debug": true,
  "logFile": ".state/events.log"
}
```

Notes that save time:

- **No restart is needed.** The file is re-read on every request; the next answer or recording uses the new key.
- **The plugin settings page writes to the same file.** `dsh-voice-reply` stores its UI preferences there (`autoSpeak`, `summaryMaxChars`, and the voice/speed values on builds that let you edit them); its writer preserves the credential fields. This is why the file may change after you press Save in the UI — that is expected.
- **Only the example is versioned.** The repository ships `plugin-config.example.json` with empty fields; `plugin-config.json` is in `.gitignore`. In a normal install the file lives under the profile's `node_modules`, so it is not part of any repository anyway.
- **A plugin update can replace the package directory.** Keep a copy of the key in a password manager, not only in this file.
- **JSON is strict.** No comments, no trailing commas, no BOM. On Windows, an editor that saves "UTF-8 with BOM" makes the plugin report an invalid-JSON error. VS Code should show `UTF-8`, not `UTF-8 with BOM`.
- Validate the file exactly as Node will read it:

  ```powershell
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('ok')" (Join-Path $ttsDir 'plugin-config.json')
  ```

### 3.4 Option C — the plugin row in the profile's `cordis.patch.yml`

The profile's own patch layer is `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` (or `$DSH_HOME\profiles\web\cordis.patch.yml`). It is meant for behaviour settings, not for secrets:

```yaml
- id: voice-reply
  config:
    voice: marina
    summaryMaxChars: 500

- id: speech-to-text-yandex
  config:
    chunkSeconds: 20
```

**Do not put API keys or IAM tokens here.** This file is part of the profile configuration: it is easy to copy to another machine, attach to a bug report, or sync to a dotfiles repository. Both plugin READMEs and `SECURITY.md` describe credentials as coming from the environment or the local `plugin-config.json`, not from the profile patch. For `dsh-voice-reply` the `config` block cannot provide credentials at all — the code reads only the environment and `plugin-config.json` for the key. For `dsh-speech-to-text-yandex`, the patch config has the **highest** priority and would silently override the environment and the file — another reason to keep credentials out of it.

### 3.5 Which option to choose

| Situation | Recommendation |
|---|---|
| One person, one Windows desktop | **`plugin-config.json`** — no restart, easy to change, easy to delete |
| The key must not live inside `node_modules` | **User environment variables** — restart `dsh web` once after each change |
| Several `dsh web` processes or a service account for automation | Environment variables or a `.env` read at boot; make sure each process gets the intended key |
| A server or CI with a secret manager | Environment injected at process start, or a short-lived IAM token refreshed automatically |
| You are tempted to put the key in `cordis.patch.yml` | Don't — use one of the two options above |

## 4. Verify that it works

### 4.1 Restart and open DSH

After installing a plugin, restart `dsh web` (bundles are mounted at boot) and open the URL it prints. After changing only `plugin-config.json`, a restart is not needed. If you are unsure, restart once: it removes the "is it the host or the file?" question.

### 4.2 TTS (`dsh-voice-reply`)

1. Open **Settings → General**. Find the **“Read answers aloud”** row (**«Озвучивать ответы голосом»** in Russian) and switch it on. This is the `autoSpeak` preference.
2. Open **Plugins → Voice replies → Configure** (**«Плагины» → «Голосовые ответы» → «Настроить»**). The page shows the spoken-summary budget, `autoSpeak`, the voice and the speed. Set the character limit; 500 characters is about 30 seconds of speech.
3. If your build has a **Preview** / **«Прослушать»** button on that page, press it. This is the fastest check that does not involve the chat: it asks the host to synthesize a short sample with the current voice and speed. Older builds may not have this button — skip to the next step.
4. Without a preview button: ask a trivial question and let the answer finish. The plugin speaks only answers that finish **after** it is installed; it does not re-read history. Alternatively press the **🔊** button on any finalized answer — replay works even for old answers.
5. Expected result: a chip above the composer says it is preparing/reading the summary, audio plays, and pressing 🔊 again replays it from the on-disk cache without a new Yandex call.

If the chip says **“Text-to-speech is not configured”** / **«Озвучивание не настроено…»**, the host sees neither an environment variable nor a file field. Go back to [section 3](#3-deliver-the-secret-to-the-plugin) and check the path and the field name.

### 4.3 STT (`dsh-speech-to-text-yandex`)

1. Make sure the built-in **Voice input** bundle is enabled: **Plugins → Voice input**. The Yandex plugin only registers a recognition provider; the microphone UI belongs to that bundle.
2. Open the Voice input settings. Set **Recognition service** (**«Служба распознавания»**) to **Yandex SpeechKit**, and the recognition language to `ru` or `en`.
3. The status should say **“Cloud speech recognition is ready”** / **«Облачное распознавание речи готово»**. This provider needs no model download, so it is ready immediately.
4. Click the microphone, allow microphone access in the browser if asked, say a phrase, and stop the recording. The recognized text should appear in the message draft.
5. If the provider is missing or another service is selected, choose Yandex SpeechKit explicitly and reload the page. The plugin's bundle patch selects it by default, but a profile-level preference can override that.

### 4.4 Logs

Both plugins write diagnostics to `.state/events.log` **inside their package directory**:

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = Join-Path $dshHome 'profiles\web\node_modules'

Get-Content (Join-Path $profile 'dsh-voice-reply\.state\events.log') -Tail 20
Get-Content (Join-Path $profile 'dsh-speech-to-text-yandex\.state\events.log') -Tail 20
```

The log is JSON Lines: one object per request. It contains counts, timings, HTTP statuses and error codes — **no answer text, no audio, no keys**.

What to look for:

| Plugin | Event | Meaning |
|---|---|---|
| TTS | `activate` | The host loaded the plugin |
| TTS | `speak.ok` | A synthesis succeeded; includes character count and timing |
| TTS | `preview.ok` | The settings-page sample succeeded |
| TTS | `speak.error`, `preview.error` | A failure; the `status` and `code` fields tell you whether it is 401, 403, 429, etc. |
| TTS | `preferences.ok` | The settings page saved a preference |
| STT | `activate` | The host loaded the plugin |
| STT | `provider.registered` | `yandex-speechkit` appeared in Voice input |
| STT | `transcribe.ok` | Recognition succeeded; includes audio seconds and chunk count |
| STT | `transcribe.error` | A failure; includes the HTTP status and the error message |

If the STT log stays empty, check that you copied the example file (which sets `"debug": false`) or set `"debug": true`. The TTS plugin writes its log regardless of the `debug` value. If the file does not exist at all, the path is wrong — check whether the package is under `profiles\web\node_modules` and whether `DSH_HOME` is overridden.

In `dsh-voice-reply` the log path is fixed at `.state/events.log`; the `logFile` field in the example does not move it. In `dsh-speech-to-text-yandex` the `logFile` field is honoured.

### 4.5 First-run checks

- The host was restarted after `dsh plugin add`.
- The page was reloaded after the restart.
- The correct plugin is enabled in the plugin list.
- For TTS, the answer finished after the plugin was installed (or you used 🔊).
- For TTS, the browser tab was focused; auto-speak is deliberately deferred in a hidden tab.
- For STT, the Voice input bundle is enabled and the microphone is allowed.

## 5. Troubleshooting

### 5.1 TTS

| Symptom | Most likely cause | What to do |
|---|---|---|
| Chip: **“Text-to-speech is not configured”** / **«Озвучивание не настроено…»**; the status endpoint reports `configured: false` | No key in either source; typo in the variable name; wrong file path; an empty `apiKey` field | Put the key in `YANDEX_TTS_API_KEY` (then restart `dsh web`) or in `plugin-config.json` next to `index.js`. The plugin's error text points to `plugin-config.json` as the file to fill |
| `401 UNAUTHORIZED` / “Yandex SpeechKit rejected the key” | The STT key was used for TTS; the key has only `yc.ai.speechkitStt.execute`; the key was revoked or expired; a stale IAM token overrides the good API key | Create/reissue a key with `yc.ai.speechkitTts.execute`; clear expired IAM fields; check the key's scope and last-used date in the console |
| `403 PERMISSION_DENIED` / “Yandex SpeechKit denied access” | `ai.speechkit-tts.user` is not granted on the folder; the key belongs to a service account from another folder; the role was granted seconds ago | Grant the role on the folder that owns the service account; wait a few minutes; retry |
| `429` / “quota exceeded” | SpeechKit quota or rate limit; a burst of answers | The plugin retries 429/5xx automatically. If it repeats, check [quotas](https://yandex.cloud/en/docs/speechkit/concepts/limits), wait, or shorten the spoken summary |
| `400` / “rejected the request” | Bad request parameters (voice/format/emotion combination, empty text) | Use the default voice/format first; switch the emotion off; check the chip text for the upstream message |
| No sound, but the chip says it is playing | Tab muted, system output device, volume, Bluetooth | Check the tab's mute state and the OS output device; the plugin's own stop button is in the chip |
| The first automatic playback is blocked | Browser autoplay policy | Click anywhere on the page, then press 🔊. This is a browser rule, not a plugin error |
| The answer is not read automatically | `autoSpeak` is off; the tab was hidden; the answer finished before the plugin was installed | Turn on Settings → General → “Read answers aloud”; focus the tab; press 🔊 for old answers |
| “Invalid JSON” error from the plugin | Comments, a trailing comma, or a UTF-8 BOM in `plugin-config.json` | Validate with the `node -e` command from section 3.3; re-save the file as UTF-8 without BOM |
| Nothing changes after editing an environment variable | The host was not restarted, or it was restarted from an old terminal | Stop `dsh web`, open a new terminal, start it again; if launched from a shortcut, sign out and back in |
| Everything worked, then `401` appeared after a while | An IAM token expired (they live at most 12 hours) | Replace the token, or switch to an API key and clear the IAM fields |

### 5.2 STT

| Symptom | Most likely cause | What to do |
|---|---|---|
| “Yandex SpeechKit is not configured” when recording | No `apiKey`/`iamToken` in the file or environment | Fill `plugin-config.json` next to `index.mjs` or set `YANDEX_STT_API_KEY`; restart only for the environment route |
| `401 UNAUTHENTICATED` | The TTS key was used for STT; the key lacks `yc.ai.speechkitStt.execute`; the service account was deleted; a stale IAM token wins | Create an STT-scoped key; check the service account; clear expired IAM fields |
| `403 PERMISSION_DENIED` | `ai.speechkit-stt.user` is missing on the folder; wrong folder ID in IAM mode | Grant the role on the correct folder; check `YANDEX_STT_FOLDER_ID` / `folderId`; wait a few minutes |
| `429 RESOURCE_EXHAUSTED` | Quota/rate limit | The plugin retries with backoff; if it persists, check quotas or dictate shorter pieces |
| `400 INVALID_ARGUMENT` | The audio was rejected (wrong format/sample rate or an empty recording) | Use the normal Voice input flow, allow the microphone, reload the page; check the log's error detail |
| Recognition service does not list Yandex SpeechKit | The plugin is not installed/mounted, or the Voice input bundle is disabled | Reinstall `dsh-speech-to-text-yandex`, restart `dsh web`, enable Plugins → Voice input |
| No recognition provider is selected, or local recognition is used | Another recognition service is selected in Voice input, or the provider entry is missing | Choose **Yandex SpeechKit** explicitly and reload the page |
| A long recording loses a word at the seam | Recordings longer than 28 seconds are split; the cut is placed in the quietest 100 ms window, but a word can still be clipped | Dictate in 20–25 second pieces; this is a SpeechKit REST v1 limit, not a plugin setting |
| The transcript has no punctuation | SpeechKit REST v1 returns plain text | Expected; the service does not add punctuation or timings |
| Microphone unavailable | Browser permission or a missing input device | Allow the microphone for the DSH page; pick another input device in Voice input |
| The STT log is empty | `debug` is `false` (the example file sets it to false), or the path is wrong | Set `"debug": true` in `plugin-config.json`; check the log path |

### 5.3 Notes on the most confusing errors

- **401 vs 403.** `401` means the credential itself is not accepted: wrong key type, missing scope, revoked/expired key, expired IAM token. `403` means the credential is recognized but the service account lacks the role on the folder. Fixing one will not fix the other.
- **The scope is not the role.** The scope limits what a particular API key may call; the role grants the service account permission to use the service. Both are required: a key with the right scope but no role gets `403`; a key with the right role but the wrong scope is rejected — usually as `401`, sometimes as `403`; check the scope in either case.
- **Propagation.** Immediately after granting a role, calls can still fail with `403`. Wait a few minutes and retry before recreating keys.
- **A key shown once.** If you cannot find the secret, it is not recoverable. Delete the key and create a new one; do not try to "recover" it from the console.

## 6. Rotation and security

### 6.1 Rotate an API key

1. In the console, open **Identity and Access Management → Service accounts → dsh-speechkit → API keys**.
2. Create a new key with the same scope and a new description (for example, `dsh-voice-reply TTS 2026-11`).
3. Put the new secret into the same place the old one came from: `plugin-config.json` (no restart) or the environment variable (restart `dsh web`).
4. Trigger a synthesis or a recognition and check the log for `speak.ok` / `transcribe.ok`.
5. Delete the old key: the row menu → **Delete**, or
   ```powershell
   yc iam api-key delete <old-key-id>
   ```
6. Record the rotation date somewhere. With an expiry date on the key, put the date in your calendar.

### 6.2 Rotate an IAM token

Just obtain a new one with `yc iam create-token` and replace the value. In `plugin-config.json` the change is live; in an environment variable it needs a restart. Do not keep an expired token next to a valid API key — the token wins.

### 6.3 Rules

- **Never commit a key.** The repository contains only `plugin-config.example.json` with empty fields; `plugin-config.json` is in `.gitignore`.
- **Never paste a key into a chat, an issue, a screenshot or a bug report.** The console shows only the masked value after creation for a reason.
- **Use separate keys for TTS and STT.** Different scopes; a leak affects one service, and revoking one does not break the other.
- **Use the least privilege.** One scope per key; the `ai.speechkit-*` role on the folder, not on the whole cloud, unless you have a reason.
- **Set an expiry date** if the console offers it, and rotate on schedule.
- **Keep the file private.** `plugin-config.json` lives in your user profile; do not copy it into a project directory that is under version control.
- **Check `last_used_at`.** The service account page shows when a key was last used; an unexpected recent use is a reason to revoke it.
- **If a key leaks:** revoke it first, then create a replacement and update the plugin. Revoking it first is what stops the leak; updating the plugin can wait.

What the plugins do with the secret:

- it stays in the `dsh web` host process;
- it is sent only to the configured SpeechKit endpoint over HTTPS;
- it is never sent to the browser, never written to `.state/events.log` and never included in the npm package;
- the package ships only the example file with empty fields.

## 7. Cost

SpeechKit is a paid service. The exact amount depends on the current Yandex Cloud tariffs, the API version and the mode:

- **TTS** is billed for synthesis; the plugins use TTS API v1 and a short spoken summary (500 characters by default) rather than the whole answer;
- **STT** is billed for the duration of recognized audio; the plugin sends the recording in chunks (25 seconds target, 28 seconds maximum), and each chunk is a separate request;
- **Caching in `dsh-voice-reply`** means a replay of the same answer with the same voice/speed/format does not call Yandex again. The cache lives in the OS temp directory (`%TEMP%\dsh-voice-reply-cache` on Windows), keeps entries for 7 days and is capped at 512 MB. STT has no cache: every recording is sent and billed.

Do not rely on prices from blog posts or on this document — rates and billing units change. Check the official pricing page for the current numbers and for the free-tier/grant conditions of your account:

- [SpeechKit pricing](https://yandex.cloud/en/docs/speechkit/pricing)
- [SpeechKit quotas and limits](https://yandex.cloud/en/docs/speechkit/concepts/limits)

Practical cost control:

- keep the spoken-summary budget at 500 characters unless you really need more;
- use the same voice/speed/format so cached replays hit;
- dictate in short pieces; a long recording becomes several STT requests;
- watch the **Billing** section of the console after the first day of use.

## 8. Official documentation links

SpeechKit:

- [SpeechKit access management and roles](https://yandex.cloud/en/docs/speechkit/security/)
- [Speech synthesis (TTS)](https://yandex.cloud/en/docs/speechkit/tts/)
- [Speech recognition (STT)](https://yandex.cloud/en/docs/speechkit/stt/)
- [SpeechKit quotas and limits](https://yandex.cloud/en/docs/speechkit/concepts/limits)
- [SpeechKit pricing](https://yandex.cloud/en/docs/speechkit/pricing)

Yandex Cloud and IAM:

- [Register an account and enable billing](https://yandex.cloud/en/docs/billing/quickstart/)
- [Create a folder](https://yandex.cloud/en/docs/resource-manager/operations/folder/create)
- [Get a folder ID](https://yandex.cloud/en/docs/resource-manager/operations/folder/get-id)
- [Create a service account](https://yandex.cloud/en/docs/iam/operations/sa/create)
- [Assign a role to a service account](https://yandex.cloud/en/docs/iam/operations/sa/assign-role-for-sa)
- [Manage API keys](https://yandex.cloud/en/docs/iam/operations/authentication/manage-api-keys)
- [API key concepts and scopes](https://yandex.cloud/en/docs/iam/concepts/authorization/api-key)
- [Get an IAM token](https://yandex.cloud/en/docs/iam/operations/iam-token/create)
- [Get an IAM token for a service account](https://yandex.cloud/en/docs/iam/operations/iam-token/create-for-sa)
- [Yandex Cloud CLI quick start](https://yandex.cloud/en/docs/cli/quickstart)

## Appendix: CLI cheat sheet

```powershell
# Folder
yc resource-manager folder create --name dsh-speechkit
yc resource-manager folder list

# Service account
yc iam service-account create --name dsh-speechkit
yc iam service-account get dsh-speechkit

# Roles (use the folder ID and service-account ID from above)
yc resource-manager folder add-access-binding <folder-id> `
  --role ai.speechkit-tts.user `
  --service-account-id <service-account-id>

yc resource-manager folder add-access-binding <folder-id> `
  --role ai.speechkit-stt.user `
  --service-account-id <service-account-id>

# Two scoped API keys — save the secret: field immediately
yc iam api-key create --service-account-name dsh-speechkit `
  --description "dsh-voice-reply TTS" `
  --scopes yc.ai.speechkitTts.execute

yc iam api-key create --service-account-name dsh-speechkit `
  --description "dsh-speech-to-text STT" `
  --scopes yc.ai.speechkitStt.execute

# Short-lived alternative in IAM mode (needs folder ID too)
yc iam create-token
```
