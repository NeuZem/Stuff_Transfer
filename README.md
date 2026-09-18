# Stuff Transfer

[![CI](https://github.com/NeuZem/Stuff_Transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/NeuZem/Stuff_Transfer/actions/workflows/ci.yml)

Send files from your phone to a shared college lab PC by scanning a QR code.

No WhatsApp Web. No email login. Nothing left signed in on a machine everyone uses.

**Phone to PC only.** The PC can never send files to a phone, by design.

---

## For students

### 1. On the PC

Open a terminal and run:

```bash
npx stuff-transfer
```

A page opens in the browser. It takes about 40 seconds to get ready. Then click **Receive files**, and a QR code appears.

### 2. On your phone

1. Scan the QR code with your camera.
2. Check that the 4 digits on your phone match the PC.
3. Tap **Choose files**, pick what you need, and tap **Send to PC**.

Files are saved to `Desktop\Received\<date and time>\`. Use **Open folder** on the PC page to get to them.

To save somewhere else, click **Change** under the folder path on the PC page, then type a path or click **Browse…**. It lasts until the app is closed, so the next student's files never end up in your folder.

When you are finished, click **Done** on the PC. The code stops working immediately.

### Good to know

- **It uses your mobile data.** Sending 100 MB of files uses about 100 MB of data, the same as sending them on WhatsApp.
- **Most transfers take under 2 minutes.** Your phone's upload speed is the limit, not the app.
- **1 GB per session** at most.
- **Lost signal? Keep going.** The upload waits and carries on by itself when the signal comes back, and nothing already sent is sent again. If you reload the page, pick the same files again and it continues where it stopped.
- **Keep the screen on** while sending. Phones pause web pages in the background.
- **Sending a folder from an iPhone:** iPhones can't pick folders in a browser. In the Files app, long-press the folder and choose **Compress**, then send the `.zip`. On the PC, click **Unpack** next to it.

## For lab admins

- **Needs Node.js 20 or newer.** Nothing else to install.
- **Never asks for an admin password.** It writes only to the user's own folders and installs nothing system-wide. Verified by running the full end-to-end test under a restricted Basic User token, including the first-run download.
- **No firewall rule and no open port.** The app only makes outgoing connections. Its own page listens on `127.0.0.1`, so nothing on the network can reach it and Windows never shows a firewall prompt.
- **Uses a Cloudflare quick tunnel** so phones on mobile data can reach the PC. On first run it downloads `cloudflared` (about 55 MB) from Cloudflare's official GitHub releases to `%LOCALAPPDATA%\stuff-transfer\bin\`.
- **If a PC lacks Node.js:** the official `.msi` installer needs admin rights, but the **portable `.zip`** from nodejs.org does not. Extract it into the user's folder and run it from there.

### Options

```text
npx stuff-transfer [options]

  --dir <folder>   Default save folder (normally Desktop\Received).
                   Students can still change it for one run on the PC page.
  --no-open        Do not open the browser automatically
  -v, --version    Show the version
  -h, --help       Show this help
```

### Security

The upload address is on the public internet, so the app treats every phone request as hostile until proven otherwise.

| Protection | What it does |
|---|---|
| Separate public and private servers | The tunnel only ever reaches the upload server. The PC's own page and controls are on a second server that is never exposed, so *"a phone cannot pull files off this PC"* is structural, not a check someone could forget. |
| Other websites are shut out | A website open in the PC's browser can still send requests to `127.0.0.1`. The PC server only accepts requests from its own page, and refuses foreign host names, which blocks DNS-rebinding attacks. |
| 128-bit code in the QR | The only way into a session. Compared in constant time. |
| The code changes every 90 seconds | Until a phone scans it, so a photo of an old QR is useless. A code replaced in the last 10 seconds still works, so a phone that scanned mid-change isn't punished. |
| One phone per session | The first phone to scan claims it, and the PC hides the QR. Any other phone is refused, even with a valid code. |
| Wrong codes end the session | Five bad attempts and the session closes, so the code can't be guessed. |
| Closes itself | After 3 minutes of silence from the phone (10 minutes mid-transfer, to survive lost signal), 30 minutes total (up to 2 hours while data is still arriving), or 10 minutes with nobody scanning. |
| 4-digit PIN on both screens | So a student can confirm they are sending to the right PC. |
| Size-capped uploads | Each chunk is checked against its exact expected size *as it streams in*, and the connection is cut the moment it's exceeded, so no client can exhaust the PC's memory. |
| SHA-256 per chunk | Corrupted or tampered data is rejected before it touches the disk. |
| Safe file names | Blocks `..` traversal, Windows reserved names like `CON`, and illegal characters. Nothing is ever overwritten: a repeated name becomes `report (1).pdf`. |
| Safe unzipping | Refuses zips with `../` or absolute paths, refuses zip bombs *before* writing anything, skips symbolic links, and never leaves a half-unpacked folder behind. Only the person at the PC can trigger it. |
| 1 GB cap and disk-space check | Refused up front, before the student spends any data. |

Every row has automated tests. Run `npm test` to check them yourself.

## License

[MIT](LICENSE)
