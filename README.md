<p align="center">
  <img src="docs/icon.svg" width="128" height="128" alt="SimpleDeskNote icon">
</p>

<h1 align="center">SimpleDeskNote</h1>

<p align="center">Sticky notes that live on your GNOME desktop.</p>

---

SimpleDeskNote is a GNOME Shell extension that puts sticky notes right on the
desktop, behind your windows and above the wallpaper (and desktop icons). Notes
support light formatting that renders as you type, clickable checklists and
radio options, and they remember where they were on each monitor.

## Features

- **Notes on the desktop**: below windows, above the wallpaper and desktop
  icons. Optionally keep them **above all windows**.
- **Title** next to the color dot, and a body that **scrolls** when the text
  grows.
- **Live formatting**: the markup is hidden and rendered as you type.
- **Clickable checkboxes and radio options**, with lists that continue when you
  press <kbd>Enter</kbd>.
- **Formatting toolbar** while editing, with hints on every button.
- **Five colors**, drag to move, resize from the corner.
- **Per-monitor positions**: unplug a monitor and its notes move to the last
  place they had on a connected monitor; plug it back and they return.
- Everything is saved automatically.

## Markup

Type the shortcut, or use the toolbar at the bottom of the note.

| You type | You get |
|---|---|
| `[ ] task` / `[x] done` | ☐ checkbox / ☑ checked (struck through) |
| `( ) option` / `(x) chosen` | ○ radio / ◉ selected (one per group of lines) |
| `- item` | • bullet |
| `# Heading` / `## Subheading` | larger bold line |
| `**bold**` `*italic*` `__underline__` `~~strike~~` `` `code` `` | inline styles |

- Click a ☐ or ○ symbol to toggle it.
- <kbd>Enter</kbd> continues a list; <kbd>Enter</kbd> on an empty item ends it;
  <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a plain line break.
- Select text and click **B**, **I**, **U** or **S** again to remove a style.

## Installation

Requires **GNOME Shell 51**.

### From a release zip

Download `simpledesknote@lucas.local.shell-extension.zip`, then:

```bash
gnome-extensions install --force simpledesknote@lucas.local.shell-extension.zip
```

Log out and back in (needed on Wayland), then:

```bash
gnome-extensions enable simpledesknote@lucas.local
```

### From source

```bash
git clone <this repository>
cd SimpleDeskNote
make install
```

Log out and back in, then enable it as above. `make pack` only builds the zip
into `dist/`.

## Usage

Click the pencil icon in the top bar:

- **New note** creates a note in the middle of the primary monitor.
- **Show notes** hides or shows all notes.
- **Above windows** keeps notes on top of every window.
- The list below opens a note and puts the cursor in it.

On a note:

- Drag the header (or the title, while it is not being edited) to move it.
- Click the colored dot to change the color.
- Click ✕ to delete; notes with text ask you to confirm.
- Drag ◢ to resize. A note never gets narrower than its toolbar.

## Multiple monitors

Each note remembers its position on every monitor it has been on, and the
monitor where you last placed it (its *home*). Monitors are recognized by
vendor, model and serial number, so moving a cable to another port does not
matter; screens that report no serial (such as most laptop panels) are
recognized by their connector.

- When the home monitor is disconnected, the note moves to the most recent
  position it had on a monitor that is still connected, or to the primary
  monitor.
- When the home monitor comes back, the note returns to its saved position
  there.

## Data

Notes are stored in `~/.local/share/simpledesknote/notes.json`.

## License

SimpleDeskNote is free software, licensed under the
[GNU General Public License v3.0 or later](LICENSE).

The pencil icon comes from the [Yaru icon theme](https://github.com/ubuntu/yaru)
(`document-edit-symbolic`) by Sam Hewitt and the Ubuntu Yaru team, licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The logo in
`docs/icon.svg` places that pencil on a sticky note and is also licensed
CC BY-SA 4.0.
