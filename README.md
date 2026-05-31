# Ambient Audio

Background music and ambient sounds for your Lumiverse chats. Upload your own audio, then link each track to a background or a character expression. Everything is manual and predictable.

---

## What it does

- Works with both **image and video** backgrounds
- **Per-track mute** plus a master mute
- **Loop toggle per track**, so music and ambience loop, but a one-shot effect like a gasp plays just once
- **Three ways to trigger a track:**
  - **Global** plays all the time
  - **Background** plays when a chosen background is showing
  - **Expression** plays when a chosen character expression is active
- **Friendly nicknames** for backgrounds, so you are not stuck reading random filenames
- **Dropdown or keywords** linking, so you pick from a list or type one or more keywords. You only need one of them.
- **Rename audio** right in the app
- **TTS auto-lower** so music drops while a character is speaking, then comes back
- **Auto-play on startup** toggle, so the app can open quietly if you prefer
- **A live status panel** showing the current background, expression, and what is playing
- **Pop-out floating players**, so you can pop one or more tracks into small draggable boxes with play/pause, volume, and a seek bar, plus album art if the file has it
- **Backup: export and import** your whole setup, including the audio, to a file

---

## Install

1. Open Lumiverse and go to the Extensions drawer
2. Click Install and paste the repo URL:
   ```
   https://github.com/starlitcode/Lumiverse-Ambient-Audio
   ```
3. That is it. The extension asks for no permissions.

---

## How linking works

Open the **Audio** tab in the sidebar. Add a track, then choose how it should play.

### Backgrounds

Lumiverse gives uploaded backgrounds randomized filenames, so you will not recognize them at first. To make this easy:

1. Click the image button in the header to open **Backgrounds & expressions**
2. Find your background in the list and give it a nickname like "tavern" or "concert"
3. Back on the track, set it to **Background** mode and pick that nickname from the dropdown

The keyword field is an alternative to the dropdown. Type one keyword or several separated by commas, and the track plays if any of them matches. Multiple keywords let one track cover several backgrounds at once, like `tavern, inn, pub` for one tavern music file.

### Expressions

Expressions are easier than backgrounds, because Lumiverse hands the extension the actual emotion word. Set a track to **Expression** mode and either pick the expression from the dropdown or type a keyword. The keyword also matches longer labels, so typing "angry" will catch an expression named "angry - annoyed". Typing also works for custom expressions that are not in the list.

Expression-linked tracks only fire if Lumiverse is actually changing the character's expression. In the character editor, the **Expression Detection** setting must be on **Automatic** (or Council Tool Only with Council configured), not Manual / Off.

For short sound effects like a gasp or a door slam, turn off the loop button on the track so it plays once instead of repeating.

### Ambient sounds

Ambient effects work through the same linking. A crowd-noise file linked to a background you nicknamed "concert" plays whenever that background is up. Link it once and it just works.

### Pop-out players

Click the pop-out button on any track to float a small player on your screen, with play/pause, a volume slider, and a seek bar. You can drag it anywhere and open one for several tracks at once. While a track is popped out, you control it directly from its player instead of by its trigger. If the audio file has embedded album art it shows on the player, and you can turn art off in settings. Embedded art is read best from MP3 files; other formats show a music-note placeholder.

---

## Settings

The gear button opens settings:

- **Auto-play on startup** controls whether audio starts the moment the app loads
- **Show album art in pop-out players** turns embedded artwork on or off (default on)
- **TTS auto-lower** drops the music while speech plays
- **Pop-out player look** lets you set the box width and inner spacing, accent color, box color, shadow color and size, a glass or solid background, blur, roundness, and border for the floating players. Colors default to your current theme. The look applies to all of them.
- **Backup** lets you export your whole setup to a file and import it back
- **Reset** restores every setting here to its defaults, leaving your tracks and nicknames alone

---

## Backup and storage

Your audio files and settings live in your browser. If you clear your browser data, they go away. Use **Export** in settings to save a full backup file (tracks, audio, links, and settings), and **Import** to restore it on the same browser or a new one. Keep your original audio files somewhere safe too.