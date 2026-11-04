# Tele-Photo

A Google Photos alternative that keeps your originals in your own Telegram account, at full quality.

You sign in with your Telegram phone number. Tele-Photo creates a private channel on your account called **Tele-Photo Library** and stores each photo there as one untouched file. A timeline, albums, favorites, search and a trash all run on top of it, in a liquid glass interface.

![The Tele-Photo timeline, with glass panels floating over a grid of photos](docs/screenshots/timeline.webp)

[See all the screenshots](#screenshots)

## Setup

You need Node 22 or newer, [pnpm](https://pnpm.io), and a free Telegram API key.

1. Go to [my.telegram.org/apps](https://my.telegram.org/apps), sign in, and create an app. Any name works. Keep the **api_id** and **api_hash** it gives you.
2. Install and configure:

   ```bash
   pnpm install
   cp .env.example .env     # then fill in TELEGRAM_API_ID and TELEGRAM_API_HASH
   ```

3. Build and start:

   ```bash
   pnpm build
   pnpm start
   ```

4. Open <http://127.0.0.1:8787> and sign in with your phone number. Telegram sends the code to your Telegram app.

### Confirm it works with real Telegram

Once you have signed in, stop the server and run this once:

```bash
pnpm verify:telegram
```

It sends a few generated images to your library channel, downloads each one, compares SHA-256 hashes, and deletes them again. Every format should print `PASS`. This is the one check the automated tests cannot do for you, because they have no Telegram account to use.

## How your photos are stored

```
Browser ──► Server ──► SHA-256, EXIF, thumbnails ──► Telegram private channel
                │                                      one photo = one message
                └── SQLite index + thumbnails (local)
```

| What | Where | Lost if this machine dies? |
| --- | --- | --- |
| Original photos | Your Telegram channel | No |
| Capture date, dimensions, content hash | Telegram (in each caption) and the local index | No |
| Thumbnails, camera details, search index | Local (`data/`) | No, rebuilt from Telegram |
| Albums and favorites | Local (`data/`) only | **Yes** |

**Back up the `data/` folder if your albums and favorites matter to you.**

To rebuild after losing `data/`, sign in again. The app finds your existing channel and restores the library automatically. You can also run this any time from the account menu with **Restore from Telegram**.

### Why quality stays intact

- Photos are sent as **documents with `force_file` set**, never as Telegram photos, which get recompressed.
- After each upload the app checks that Telegram kept a document of exactly the same size. If not, it deletes that message and tries again.
- The original bytes are never modified. Only the web-sized thumbnails and previews are generated copies, and they stay on your server.
- Each photo's SHA-256 is recorded at upload, which also stops the same photo being stored twice.

### If something goes wrong mid-upload

The local copy is deleted only after Telegram has confirmed the file and that has been saved to the database, so a crash cannot lose a photo. Uploads resume on the next start. Rate limits from Telegram pause the queue rather than failing it. Files that keep failing stay on the server and appear in the uploads panel with a **Retry** button.

## Good to know

- **Size limit:** 2,097,152,000 bytes per photo (about 1.95 GB). This is Telegram's real ceiling for non-Premium accounts: 4000 parts of 512 KB. Larger files are refused up front.
- **Formats:** anything that is recognisably an image, by its contents rather than its name. JPEG, PNG, WebP, GIF, AVIF, TIFF and HEIC get thumbnails. Camera RAW uses its embedded preview when it has one. If no preview can be made, the photo is still stored and gets a placeholder tile.
- **Privacy:** only your account can see the channel, but channels are not end-to-end encrypted, so Telegram itself could read them. The server also holds your Telegram session, encrypted at rest. That session is full access to your account, so keep `data/` private. Use **Disconnect Telegram** in the account menu, or end the session under Devices in Telegram, to revoke it.
- **Your Telegram account:** this uses the official API with your own key, signing in like any third-party client. Telegram does not promise it as a storage service, and it can rate-limit or restrict accounts it considers abusive. Bulk uploads are paced to respect its limits, but keep other copies of anything irreplaceable.
- **Deleting:** Trash keeps photos for 30 days (`TP_TRASH_RETENTION_DAYS`), then deletes them from Telegram for good. Deleting the channel from inside Telegram deletes your originals, and the app cannot get them back.
- **Glass effect:** true refraction appears in Chromium browsers. Safari and Firefox automatically show frosted glass instead.

## Using it from other devices

The server listens on this computer only by default. To reach it from your phone on the same Wi-Fi, set these in `.env`:

```bash
HOST=0.0.0.0
TP_ALLOWED_PHONES=+15551234567   # your number, so nobody else on the network can sign in
```

Do not expose it to the internet without HTTPS in front of it (a reverse proxy works). Then also set `TP_COOKIE_SECURE=true`.

## Screenshots

These were taken in demo mode with stock sample photos from [Lorem Picsum](https://picsum.photos), which is why they carry a yellow banner. In demo mode nothing really goes to Telegram, even where a label says it did. Select any image to see it full size.

### Signing in

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/sign-in.webp"><img src="docs/screenshots/sign-in.webp" alt="Sign-in card over a colourful mosaic"></a><br>Sign in with your Telegram phone number.</td><td width="50%" valign="top"><a href="docs/screenshots/sign-in-wrong-code.webp"><img src="docs/screenshots/sign-in-wrong-code.webp" alt="Sign-in card showing a code error"></a><br>A wrong code gets a clear message, and you can try again.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/setup-needed.webp"><img src="docs/screenshots/setup-needed.webp" alt="Setup instructions on the sign-in card"></a><br>Shown until your API key is in <code>.env</code>.</td><td width="50%" valign="top"><a href="docs/screenshots/empty-library.webp"><img src="docs/screenshots/empty-library.webp" alt="Empty library with an upload button"></a><br>A new library, ready for its first photos.</td></tr>
</table>

### Uploading

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/uploading.webp"><img src="docs/screenshots/uploading.webp" alt="Upload panel showing progress for several files"></a><br>Each file shows its progress, and photos appear in the grid as they arrive.</td><td width="50%" valign="top"><a href="docs/screenshots/upload-done.webp"><img src="docs/screenshots/upload-done.webp" alt="Upload panel listing finished files"></a><br>The finished batch.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/folder-drop.webp"><img src="docs/screenshots/folder-drop.webp" alt="Upload panel after a folder was dropped, with a notice about a skipped file"></a><br>Drop a whole folder. Anything that isn't a photo is skipped, and you are told.</td><td width="50%" valign="top"><a href="docs/screenshots/upload-refused.webp"><img src="docs/screenshots/upload-refused.webp" alt="Upload panel showing a refused file with its reason"></a><br>A file that only pretends to be a photo is refused, with the reason.</td></tr>
</table>

### Browsing

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/scrubber.webp"><img src="docs/screenshots/scrubber.webp" alt="Timeline scrubber showing a month label"></a><br>The strip on the right jumps through your years.</td><td width="50%" valign="top"><a href="docs/screenshots/search.webp"><img src="docs/screenshots/search.webp" alt="Search results for 2025"></a><br>Search by name, camera or date.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/selecting.webp"><img src="docs/screenshots/selecting.webp" alt="Photos selected, with an action bar along the top"></a><br>Select photos to favorite, add to an album, download or remove them.</td><td width="50%" valign="top"><a href="docs/screenshots/favorites-marked.webp"><img src="docs/screenshots/favorites-marked.webp" alt="Grid with star marks on favorite photos"></a><br>Favorites are marked with a star.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/stress-test.webp"><img src="docs/screenshots/stress-test.webp" alt="Grid of photos spanning many years"></a><br>A stress test with 50,000 simulated photos. Only the tiles near the screen are ever loaded.</td><td width="50%"></td></tr>
</table>

### Viewing a photo

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/viewer-info.webp"><img src="docs/screenshots/viewer-info.webp" alt="Full-screen photo with an info panel"></a><br>Date, camera details and where the original is stored.</td><td width="50%" valign="top"><a href="docs/screenshots/viewer.webp"><img src="docs/screenshots/viewer.webp" alt="Full-screen portrait photo with glass controls"></a><br>Full screen, with the panel closed.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/viewer-zoom.webp"><img src="docs/screenshots/viewer-zoom.webp" alt="Zoomed-in photo of a tram"></a><br>Zoom in, and the original loads from Telegram for full detail.</td><td width="50%" valign="top"><a href="docs/screenshots/viewer-trash.webp"><img src="docs/screenshots/viewer-trash.webp" alt="Viewer showing a photo in Trash with days remaining"></a><br>A photo in Trash shows how long it has left.</td></tr>
</table>

### Albums

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/add-to-album.webp"><img src="docs/screenshots/add-to-album.webp" alt="Dialog for adding photos to an album"></a><br>Add selected photos to a new or existing album.</td><td width="50%" valign="top"><a href="docs/screenshots/albums.webp"><img src="docs/screenshots/albums.webp" alt="Albums page with one album"></a><br>Your albums.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/album.webp"><img src="docs/screenshots/album.webp" alt="Album page with four photos"></a><br>Inside an album.</td><td width="50%" valign="top"><a href="docs/screenshots/album-renamed.webp"><img src="docs/screenshots/album-renamed.webp" alt="Album page after renaming"></a><br>A renamed album.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/album-menu.webp"><img src="docs/screenshots/album-menu.webp" alt="Album options menu"></a><br>Rename or delete an album. Deleting it keeps the photos.</td><td width="50%"></td></tr>
</table>

### Trash

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/trash-undo.webp"><img src="docs/screenshots/trash-undo.webp" alt="Notice with an Undo button after moving a photo to Trash"></a><br>Moved something by mistake? Undo is right there.</td><td width="50%" valign="top"><a href="docs/screenshots/trash.webp"><img src="docs/screenshots/trash.webp" alt="Trash page with one photo"></a><br>Photos wait in Trash before they are deleted for good.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/empty-trash.webp"><img src="docs/screenshots/empty-trash.webp" alt="Confirmation dialog for emptying the Trash"></a><br>Anything permanent asks first.</td><td width="50%"></td></tr>
</table>

### Account and dark mode

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/account-menu.webp"><img src="docs/screenshots/account-menu.webp" alt="Account menu with appearance options"></a><br>Appearance, restore, sign out and disconnect.</td><td width="50%" valign="top"><a href="docs/screenshots/account-menu-over-photos.webp"><img src="docs/screenshots/account-menu-over-photos.webp" alt="Account menu open over photos"></a><br>The menu stays readable over any photo.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/dark.webp"><img src="docs/screenshots/dark.webp" alt="Timeline in dark mode"></a><br>Dark mode.</td><td width="50%" valign="top"><a href="docs/screenshots/dark-scrolled.webp"><img src="docs/screenshots/dark-scrolled.webp" alt="Scrolled timeline in dark mode"></a><br>Photos scroll underneath the glass.</td></tr>
</table>

### On a phone

<table>
<tr><td width="25%" valign="top"><a href="docs/screenshots/phone.webp"><img src="docs/screenshots/phone.webp" alt="Timeline on a phone with star marks on favorites"></a><br>Favorites show a star.</td><td width="25%" valign="top"><a href="docs/screenshots/phone-timeline.webp"><img src="docs/screenshots/phone-timeline.webp" alt="Timeline on a phone"></a><br>The timeline.</td><td width="25%" valign="top"><a href="docs/screenshots/phone-selecting.webp"><img src="docs/screenshots/phone-selecting.webp" alt="Selecting a photo on a phone"></a><br>Press and hold to select.</td><td width="25%" valign="top"><a href="docs/screenshots/phone-viewer.webp"><img src="docs/screenshots/phone-viewer.webp" alt="Photo viewer on a phone"></a><br>The viewer.</td></tr>
</table>

<a href="docs/screenshots/phone-tabs.webp"><img src="docs/screenshots/phone-tabs.webp" alt="The tab bar on a phone, with Photos, Favorites, Albums and Trash" width="390"></a>

## Development

```bash
pnpm dev              # server on :8787, web app with hot reload on :5173
pnpm test             # server test suite
```

To try the app without a Telegram account, set `TP_STORAGE=fake` in `.env`. Any phone number works with code `12345` (a number ending in 2 also asks for the password `hunter2`). Photos stay on local disk, and a yellow banner says so.

| Path | What it does |
| --- | --- |
| `server/src/storage/telegram.ts` | Everything that talks to Telegram |
| `server/src/storage/fake.ts` | The stand-in used by tests and demo mode |
| `server/src/queue.ts` | The durable upload queue |
| `server/src/media.ts` | File checks, EXIF, thumbnails |
| `server/src/caption.ts` | What each Telegram message's caption holds |
| `web/src/components/` | The interface |
| `web/src/components/ui/` | [Liqui UI](https://liqui.design) components, installed as source |

The stack is Fastify, SQLite and [GramJS](https://github.com/gram-js/gramjs) on the server, and React, Tailwind and Liqui UI in the browser.
