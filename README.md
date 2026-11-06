# Cove · Offline Music Player

English · [한국어](docs/public/README.ko.md) · [简体中文](docs/public/README.zh-CN.md) · [日本語](docs/public/README.ja.md)

Cove is an open-source offline music player and local library for macOS, with a Windows preview. Play your own FLAC, MP3, and M4A files, follow synced LRC lyrics, and keep playlists and notes on your device.

I like Apple. I like the fruit too, but here I mean the company that keeps trying new things while caring about simplicity. I built Cove because I wanted a quiet place to listen to the music I love, without ads or a subscription.

![Cove Today with favorite tracks and recent listening from a sample library](docs/public/screenshots/cove-today.png)

[Collection screenshot](docs/public/screenshots/cove-collection.png) · [Synced lyrics screenshot](docs/public/screenshots/cove-lyrics.png)

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/woodychoi777/Cove/releases). Verify your download with the SHA-256 checksums on the release page.

- **Mac, Apple Silicon, macOS 13 or later.** Open the DMG and move Cove to Applications. The app is ad-hoc signed and is not notarized. If macOS blocks the launch, see [Apple's app-opening instructions](https://support.apple.com/en-gb/102445).
- **Windows 10/11, x64 preview.** Run the setup EXE for a per-user installation, or extract the entire portable ZIP and open Cove.exe from the extracted folder. Windows builds are unsigned. The packaged app has been exercised on a GitHub Windows runner. Installation and removal still need physical Windows testing. [Windows build and verification notes](docs/public/WINDOWS.md)
- **Language.** Choose System, English, Simplified Chinese, Korean, or Japanese in **Settings → Appearance → Language**. Quit and reopen Cove to apply your choice.

On first launch, create a library or open an existing one. New libraries default to **Music/Cove**. To reconnect an existing library, select the folder containing both `soriseojae.sqlite` and the `library` subfolder.

## Add and play music

1. Choose **Add music** in the sidebar, or press ⌘O on Mac or Ctrl+O on Windows.
2. Choose files or a folder, or drag audio files onto the import area. Cove copies the selected files by default. Turn on **Review track info first** to edit titles and artist names before importing.
3. Select a track in **Collection** to play from that point in the list. The player provides shuffle, repeat, a queue, and track transitions. Select the playing track to open its lyrics, favorites, and notes.

Cove supports FLAC, ALAC/M4A, MP3, AAC, and Ogg Vorbis/Opus. Cove keeps the audio as-is. For synced lyrics, include a UTF-8 `.lrc` file alongside the audio with the same basename. Cove can extract embedded artwork or use an image you choose.

**Add tracks** puts music already in your library into a playlist. **Add music** imports files from disk. Track and playlist menus also open with a right-click, Shift+F10, or a long press.

## Automatically import from a folder

In **Settings → Auto-import**, choose a dedicated folder, review the preview, and confirm. While Cove is running, it watches that folder and its subfolders. It waits for files to settle and skips exact duplicates. The default **Copy** mode keeps originals. **Move** removes them after the stored audio and linked lyrics are verified.

Keep the watched folder separate from the library folder. If a drive disconnects, reconnect it and choose **Check again** or select a new folder. For best results choose a specific music folder with at most 8 levels and 10,000 items.

### Example with QQ Music and QM Unlock

For local files you are allowed to access and convert, [QM Unlock](https://github.com/mary20050520/qmunlock) can watch the QQ Music download folder and write compatible audio to a separate output folder. Use its folder import to process files already present. In Cove, set **Auto-import** to watch the **output folder** in Copy mode. Keep both apps open. See the [Chinese guide](docs/public/README.zh-CN.md) for the same workflow in Chinese.

## Your library and updates

Cove organizes its managed audio by artist, album, and track number using file tags. **Settings → Storage and export** shows the location and exports track info, lyrics, notes, history summaries, playlists, and saved queues as JSON. For a complete backup including audio and artwork, quit Cove and copy the entire library folder.

Before updating, save any drafts and quit Cove. On Mac, replace the app in Applications. On Windows, run the new setup EXE. Cove can reconnect a moved library from its startup dialog.

The alarm requires Cove to be running. Wake from sleep depends on the Mac setup and is unavailable on Windows. If Cove has trouble reading your library, check the selected path or the `service.log` in that library. Please remove private paths and personal data before sharing diagnostics.

## Develop

Use Node.js 24 or later. Run `npm ci` and `npm start`, then open `http://127.0.0.1:4317`. See the [development guide](docs/public/DEVELOPMENT.md) for tests and packaging.

Cove source is available under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependencies.

Made by woodychoi777
