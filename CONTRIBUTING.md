# Contributing

Thanks for your interest in SimpleDeskNote!

## Development setup

1. Clone the repository and install the extension from source:

   ```bash
   make install
   ```

2. On Wayland, GNOME Shell only loads new extension code after you log out
   and back in. Then enable it:

   ```bash
   gnome-extensions enable simpledesknote@lucas.local
   ```

3. Watch the logs while testing:

   ```bash
   journalctl --user -f -g SimpleDeskNote
   ```

## Project layout

| Path | What it is |
|---|---|
| `simpledesknote@lucas.local/extension.js` | All extension code |
| `simpledesknote@lucas.local/stylesheet.css` | Note, toolbar and tooltip styles |
| `simpledesknote@lucas.local/icons/` | Top bar icon |
| `docs/` | Logo and screenshots used by the README |

## Pull requests

- Keep changes focused, and describe how you tested them.
- Follow the style of the surrounding code.
- `make pack` must still produce a working zip.
