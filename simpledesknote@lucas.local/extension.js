// SimpleDeskNote — sticky notes on the GNOME Shell desktop.
//
// Notes live in their own layer inside global.window_group, right above the
// wallpaper (and the desktop icons window, if any) but below regular windows.
// Optionally they can stay above everything (as chrome).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const COLORS = ['yellow', 'pink', 'green', 'blue', 'purple'];
const SAVE_DELAY_MS = 500;
const CONFIRM_TIMEOUT_MS = 3000;
const DEFAULT_SIZE = [220, 180];
const MIN_SIZE = [140, 100];

const TOOLTIP_DELAY_MS = 500;

// Hover hints; GNOME Shell has no generic tooltip for St widgets. One shared
// label lives in the UI group, above windows and notes.
class Tooltips {
    constructor() {
        this._label = new St.Label({style_class: 'sdn-tooltip', visible: false});
        Main.layoutManager.uiGroup.add_child(this._label);
        this._timeoutId = 0;
        this._actor = null;
    }

    attach(actor, text) {
        actor.track_hover = true;
        actor.connect('notify::hover', () => {
            if (actor.hover)
                this._schedule(actor, text);
            else if (this._actor === actor)
                this.hide();
        });
        actor.connect('destroy', () => {
            if (this._actor === actor)
                this.hide();
        });
    }

    _schedule(actor, text) {
        this.hide();
        this._actor = actor;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY_MS, () => {
            this._timeoutId = 0;
            this._show(actor, text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(actor, text) {
        if (!actor.mapped)
            return;

        this._label.text = text;
        this._label.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this._label, null);

        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const [, labelWidth] = this._label.get_preferred_width(-1);
        const [, labelHeight] = this._label.get_preferred_height(-1);

        let labelX = Math.round(x + width / 2 - labelWidth / 2);
        let labelY = Math.round(y + height + 6);
        if (labelY + labelHeight > global.stage.height)
            labelY = Math.round(y - labelHeight - 6);
        labelX = Math.min(Math.max(labelX, 0), global.stage.width - labelWidth);
        this._label.set_position(labelX, labelY);
    }

    hide() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._actor = null;
        this._label.hide();
    }

    destroy() {
        this.hide();
        this._label.destroy();
    }
}

let tooltips = null;

function addTooltip(actor, text) {
    tooltips?.attach(actor, text);
}

function makeButton(iconName, tooltip, styleClass = 'sdn-button') {
    const button = new St.Button({
        style_class: styleClass,
        can_focus: false,
        child: new St.Icon({icon_name: iconName}),
    });
    addTooltip(button, tooltip);
    return button;
}

// Monitors with a stable identity (vendor/product/serial, or the connector when
// the panel reports no serial), so positions survive plugging and unplugging.
function getMonitors() {
    const ids = new Map();
    try {
        const monitorManager = global.backend.get_monitor_manager();
        for (const monitor of monitorManager.get_monitors()) {
            const connector = monitor.get_connector();
            const index = monitorManager.get_monitor_for_connector(connector);
            if (index < 0 || ids.has(index))
                continue;
            const serial = monitor.get_serial();
            const model = `${monitor.get_vendor()}-${monitor.get_product()}`;
            ids.set(index, serial && !/^(0x)?0*$/.test(serial)
                ? `${model}-${serial}`
                : `${model}-${connector}`);
        }
    } catch (e) {
        console.warn(`[SimpleDeskNote] Could not identify monitors: ${e}`);
    }

    return Main.layoutManager.monitors.map(m => ({
        id: ids.get(m.index) ?? `monitor-${m.index}`,
        index: m.index,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
    }));
}

// Note mini markup, rendered live inside the editable text:
//   [ ] / [x]  → ☐ / ☑   checkbox (click the symbol to toggle)
//   ( ) / (x)  → ○ / ◉   radio (group = consecutive radio lines)
//   -          → •       bullet
//   # Heading / ## Subheading
//   **bold** *italic* __underline__ ~~strikethrough~~ `code`
// Markup markers are always hidden.
const CHECK_RE = /^([☐☑]) /;
const RADIO_RE = /^([○◉]) /;
const CONTINUED_PREFIX_RE = /^([☐☑○◉•]) /;
const LINE_PREFIX_RE = /^([☐☑○◉•] |# |## )/;

// Shortcuts typed at the start of a line become symbols
const SHORTCUTS = [
    [/^\[ \] /gm, '☐ '],
    [/^\[[xX]\] /gm, '☑ '],
    [/^\( \) /gm, '○ '],
    [/^\([xX]\) /gm, '◉ '],
    [/^- /gm, '• '],
];

const INLINE_RULES = [
    {re: /`([^`\n]+)`/g, marker: 1, attrs: () => [Pango.attr_family_new('monospace')]},
    {re: /\*\*([^\n]+?)\*\*/g, marker: 2, attrs: () => [Pango.attr_weight_new(Pango.Weight.BOLD)]},
    {re: /__([^\n]+?)__/g, marker: 2, attrs: () => [Pango.attr_underline_new(Pango.Underline.SINGLE)]},
    {re: /~~([^\n]+?)~~/g, marker: 2, attrs: () => [Pango.attr_strikethrough_new(true)]},
    {re: /(?<!\*)\*(?![*\s])([^*\n]+?)\*(?!\*)/g, marker: 1, attrs: () => [Pango.attr_style_new(Pango.Style.ITALIC)]},
];

function normalizeShortcuts(text) {
    for (const [re, glyph] of SHORTCUTS)
        text = text.replace(re, glyph);
    return text;
}

// UTF-16 (JS) index → UTF-8 byte offset (Pango)
function byteOffsets(text) {
    const map = new Uint32Array(text.length + 1);
    let bytes = 0;
    for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i);
        const units = cp > 0xffff ? 2 : 1;
        map[i] = bytes;
        if (units === 2)
            map[i + 1] = bytes;
        bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        i += units;
    }
    map[text.length] = bytes;
    return map;
}

// ClutterText character position (code point) → UTF-16 index
function charToUtf16(text, pos) {
    if (pos < 0)
        return text.length;
    let i = 0;
    for (let c = 0; c < pos && i < text.length; c++)
        i += text.codePointAt(i) > 0xffff ? 2 : 1;
    return i;
}

function utf16ToChar(text, index) {
    return [...text.slice(0, index)].length;
}

const Note = GObject.registerClass({
    Signals: {
        'changed': {},
        'delete-requested': {},
        'raise-requested': {},
        'moved': {},
    },
}, class Note extends St.BoxLayout {
    _init(data) {
        super._init({
            style_class: 'sdn-note',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });

        this.id = data.id;
        // Last position on each monitor (relative to it), plus the monitor the
        // user last placed the note on
        this.positions = data.positions ?? {};
        this.home = data.home ?? null;
        this._color = COLORS.includes(data.color) ? data.color : COLORS[0];
        this.add_style_class_name(`sdn-${this._color}`);
        this.set_position(data.x ?? 100, data.y ?? 100);
        this.set_size(
            Math.max(data.width ?? DEFAULT_SIZE[0], MIN_SIZE[0]),
            Math.max(data.height ?? DEFAULT_SIZE[1], MIN_SIZE[1]));

        // Header: color, title and buttons; its background drags the note
        this._header = new St.BoxLayout({
            style_class: 'sdn-header',
            reactive: true,
            x_expand: true,
        });
        this.add_child(this._header);

        // Dot showing the next color; clicking it changes the note color
        this._colorButton = new St.Button({
            style_class: 'sdn-dot',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._colorButton.connect('clicked', () => this._cycleColor());
        this._header.add_child(this._colorButton);
        this._syncColorButton();

        addTooltip(this._colorButton, 'Change color');

        // Title next to the color dot. While it has no focus, pressing it can
        // also drag the note; a click without moving starts editing it.
        this._titleEntry = new St.Entry({
            style_class: 'sdn-title',
            hint_text: 'Title',
            text: data.title ?? '',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleText = this._titleEntry.clutter_text;
        titleText.connect('text-changed', () => this.emit('changed'));
        titleText.connect('key-focus-in', () => {
            this._onKeyFocusIn();
            this._syncToolbar();
        });
        titleText.connect('key-focus-out', () => this._syncToolbar());
        titleText.connect('activate', () => this.focusText());
        this._titleEntry.connect('captured-event', this._onTitleEvent.bind(this));
        this._header.add_child(this._titleEntry);

        this._confirmButton = new St.Button({
            style_class: 'sdn-button sdn-confirm',
            label: 'Delete?',
            can_focus: false,
            visible: false,
        });
        this._confirmButton.connect('clicked', () => this.emit('delete-requested'));
        addTooltip(this._confirmButton, 'Click to confirm');
        this._header.add_child(this._confirmButton);

        this._closeButton = makeButton('window-close-symbolic', 'Delete note');
        this._closeButton.connect('clicked', () => this._onCloseClicked());
        this._header.add_child(this._closeButton);

        this._header.connect('button-press-event', (actor, event) => {
            // Clicks on buttons go to them; only the header background drags
            if (global.stage.get_event_actor(event) !== this._header)
                return Clutter.EVENT_PROPAGATE;
            return this._onGrabStart(actor, event, 'move');
        });
        this._connectGrabHandlers(this._header);

        // Text
        this._entry = new St.Entry({
            style_class: 'sdn-entry',
            hint_text: 'Write here…',
            text: normalizeShortcuts(data.text ?? ''),
            can_focus: true,
            x_expand: true,
        });
        const clutterText = this._entry.clutter_text;
        clutterText.set_single_line_mode(false);
        clutterText.set_activatable(false);
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        clutterText.set_ellipsize(Pango.EllipsizeMode.NONE);
        clutterText.connect('text-changed', () => this._onTextChanged());
        clutterText.connect('key-focus-in', () => {
            this._onKeyFocusIn();
            this._syncToolbar();
            this._applyAttributes();
        });
        clutterText.connect('key-focus-out', () => {
            this._syncToolbar();
            this._applyAttributes();
        });
        // cursor-changed also fires on every redraw; only follow the cursor when
        // it moves or the text changes, so manual scrolling is not undone.
        clutterText.connect('cursor-changed', () => {
            const key = `${clutterText.get_cursor_position()}:${clutterText.text.length}`;
            if (key === this._lastCursorKey)
                return;
            this._lastCursorKey = key;
            this._ensureCursorVisible();
        });
        clutterText.connect('key-press-event', this._onKeyPress.bind(this));
        // St.Entry replaces the attributes (theme color) on every style
        // change; keep its list and re-apply our formatting on top of it.
        clutterText.connect('notify::attributes', () => {
            // The notification may arrive late; ignore our own list
            const attrs = clutterText.get_attributes();
            if (attrs?.to_string() === this._appliedAttributes)
                return;
            this._styleAttributes = attrs;
            this._queueApplyAttributes();
        });
        // On GNOME 51 clicks on the text go to an internal ClutterText gesture
        // and never emit button-press-event, so intercept them while capturing.
        this._entry.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            return this._onTextPress(actor, event);
        });

        // The whole note body is clickable to start writing. It scrolls inside
        // the note so long text never pushes the footer out.
        this._body = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._body.add_child(this._entry);
        this._body.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY &&
                global.stage.get_event_actor(event) === this._body)
                this.focusText();
            return Clutter.EVENT_PROPAGATE;
        });
        this._scrollView = new St.ScrollView({
            style_class: 'sdn-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._body,
        });
        this.add_child(this._scrollView);

        // Footer: formatting toolbar (while editing) + resize grip
        const footer = new St.BoxLayout({style_class: 'sdn-footer', x_expand: true});

        this._toolbar = new St.BoxLayout({style_class: 'sdn-toolbar', visible: false});
        const tools = [
            ['<b>B</b>', 'Bold  (**text**)', () => this._wrapSelection('**')],
            ['<i>I</i>', 'Italic  (*text*)', () => this._wrapSelection('*')],
            ['<u>U</u>', 'Underline  (__text__)', () => this._wrapSelection('__')],
            ['<s>S</s>', 'Strikethrough  (~~text~~)', () => this._wrapSelection('~~')],
            ['☐', 'Checkbox  ([ ] item)', () => this._toggleLinePrefix('☐ ')],
            ['◉', 'Radio option  (( ) item)', () => this._toggleLinePrefix('○ ')],
            ['•', 'Bullet  (- item)', () => this._toggleLinePrefix('• ')],
            ['H', 'Heading  (# text)', () => this._toggleLinePrefix('# ')],
        ];
        for (const [markup, name, action] of tools) {
            const label = new St.Label();
            label.clutter_text.set_markup(markup);
            const button = new St.Button({
                style_class: 'sdn-tool',
                can_focus: false,
                child: label,
                accessible_name: name,
            });
            button.connect('clicked', action);
            addTooltip(button, name);
            this._toolbar.add_child(button);
        }
        footer.add_child(this._toolbar);
        footer.add_child(new St.Widget({x_expand: true}));

        this._resizeGrip = new St.Label({
            style_class: 'sdn-grip',
            text: '◢',
            reactive: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._resizeGrip.connect('button-press-event',
            (actor, event) => this._onGrabStart(actor, event, 'resize'));
        this._connectGrabHandlers(this._resizeGrip);
        addTooltip(this._resizeGrip, 'Resize');
        footer.add_child(this._resizeGrip);
        this._footer = footer;
        this.add_child(footer);

        this.connect('button-press-event', () => {
            this.emit('raise-requested');
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('destroy', () => {
            this._dismissGrab();
            this._clearConfirmTimeout();
            if (this._normalizeId) {
                GLib.source_remove(this._normalizeId);
                this._normalizeId = 0;
            }
            if (this._applyId) {
                GLib.source_remove(this._applyId);
                this._applyId = 0;
            }
            if (this._toolbarId) {
                GLib.source_remove(this._toolbarId);
                this._toolbarId = 0;
            }
        });

        this._applyAttributes();
    }

    get text() {
        return this._entry.get_text();
    }

    get label() {
        const title = this._titleEntry.get_text().trim();
        const firstLine = this.text.split('\n').find(l => l.trim() !== '') ?? '';
        const trimmed = title || firstLine.replace(LINE_PREFIX_RE, '').trim();
        return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
    }

    serialize() {
        return {
            id: this.id,
            title: this._titleEntry.get_text(),
            text: this.text,
            color: this._color,
            home: this.home,
            positions: this.positions,
            x: Math.round(this.x),
            y: Math.round(this.y),
            width: Math.round(this.width),
            height: Math.round(this.height),
        };
    }

    // Remember the position on the monitor holding the note's center
    savePosition(monitors) {
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        const monitor = monitors.find(m =>
            cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ??
            monitors[Main.layoutManager.primaryIndex] ?? monitors[0];
        if (!monitor)
            return;

        this.positions[monitor.id] = {
            x: Math.round(this.x - monitor.x),
            y: Math.round(this.y - monitor.y),
            time: Date.now(),
        };
        this.home = monitor.id;
    }

    // Place the note on its home monitor; if that monitor is gone, use the most
    // recent position saved on a connected monitor, else the primary monitor.
    restorePosition(monitors) {
        const byId = new Map(monitors.map(m => [m.id, m]));
        let monitor = byId.get(this.home);
        let pos = this.positions[this.home];

        if (!monitor || !pos) {
            let best = null;
            for (const [id, p] of Object.entries(this.positions)) {
                if (byId.has(id) && (!best || p.time > best.pos.time))
                    best = {id, pos: p};
            }
            if (best) {
                monitor = byId.get(best.id);
                pos = best.pos;
            } else {
                monitor = monitors[Main.layoutManager.primaryIndex] ?? monitors[0];
                pos = pos ?? {x: 40, y: 40};
            }
        }
        if (!monitor)
            return;

        const maxX = Math.max(monitor.width - Math.min(this.width, monitor.width), 0);
        const maxY = Math.max(monitor.height - Math.min(this.height, monitor.height), 0);
        this.set_position(
            monitor.x + Math.min(Math.max(pos.x, 0), maxX),
            monitor.y + Math.min(Math.max(pos.y, 0), maxY));
    }

    focusText() {
        const clutterText = this._entry.clutter_text;
        if (!clutterText.has_key_focus()) {
            clutterText.set_cursor_position(-1);
            clutterText.set_selection_bound(-1);
        }
        clutterText.grab_key_focus();
    }

    // The toolbar stays visible while the title or the text has focus.
    // When focus moves between them, "out" arrives before "in". A drag or
    // resize grab also takes the focus away for a moment; ignore that.
    _syncToolbar() {
        if (this._toolbarId)
            return;
        this._toolbarId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._toolbarId = 0;
            if (this._grab)
                return GLib.SOURCE_REMOVE;
            this._toolbar.visible = this._entry.clutter_text.has_key_focus() ||
                this._titleEntry.clutter_text.has_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensureCursorVisible() {
        const clutterText = this._entry.clutter_text;
        if (!clutterText.has_key_focus())
            return;
        const [ok, , y, lineHeight] =
            clutterText.position_to_coords(clutterText.get_cursor_position());
        if (!ok)
            return;

        const adjustment = this._body.vadjustment;
        const top = this._entry.y + clutterText.y + y;
        const bottom = top + lineHeight + 8;
        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    _onKeyFocusIn() {
        // On Wayland the keyboard keeps going to the focused window until
        // Mutter drops its focus.
        global.display.unset_input_focus(global.get_current_time());
        this.emit('raise-requested');
    }

    _onTextChanged() {
        // Changing the text inside the insertion signal confuses ClutterText;
        // shortcuts become symbols right after.
        if (!this._normalizeId && normalizeShortcuts(this.text) !== this.text) {
            this._normalizeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._normalizeId = 0;
                this._normalize();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._applyAttributes();
        this.emit('changed');
    }

    _normalize() {
        const clutterText = this._entry.clutter_text;
        const text = this.text;
        const normalized = normalizeShortcuts(text);
        if (normalized === text)
            return;

        // Shortcuts sit before the cursor (they were just typed), so shifting
        // by the length difference is enough.
        const cursor = clutterText.get_cursor_position();
        const delta = [...text].length - [...normalized].length;
        clutterText.set_text(normalized);
        const pos = cursor < 0 ? -1 : Math.max(0, cursor - delta);
        clutterText.set_cursor_position(pos);
        clutterText.set_selection_bound(pos);
    }

    _applyAttributes() {
        const clutterText = this._entry.clutter_text;
        const text = this.text;
        const offsets = byteOffsets(text);
        const list = this._styleAttributes?.copy() ?? new Pango.AttrList();

        const add = (attr, start, end) => {
            attr.start_index = offsets[start];
            attr.end_index = offsets[end];
            list.insert(attr);
        };
        const hide = (start, end) => {
            add(Pango.attr_size_new(1), start, end);
            add(Pango.attr_foreground_alpha_new(1), start, end);
        };
        const fade = (start, end) => add(Pango.attr_foreground_alpha_new(0x6000), start, end);

        let lineStart = 0;
        text.split('\n').forEach(line => {
            const lineEnd = lineStart + line.length;
            let contentStart = lineStart;

            let match;
            if ((match = line.match(/^(##?) /))) {
                contentStart = lineStart + match[0].length;
                hide(lineStart, contentStart);
                add(Pango.attr_weight_new(Pango.Weight.BOLD), contentStart, lineEnd);
                add(Pango.attr_scale_new(match[1] === '#' ? 1.4 : 1.2), contentStart, lineEnd);
            } else if ((match = line.match(CHECK_RE))) {
                contentStart = lineStart + match[0].length;
                if (match[1] === '☑') {
                    add(Pango.attr_strikethrough_new(true), contentStart, lineEnd);
                    fade(contentStart, lineEnd);
                }
            }

            // Markers already used become \u0001 in the working copy so that
            // `**bold *italic***` does not confuse the following rules
            let content = text.slice(contentStart, lineEnd);
            for (const rule of INLINE_RULES) {
                const matches = [...content.matchAll(rule.re)];
                for (const m of matches) {
                    const start = contentStart + m.index;
                    const end = start + m[0].length;
                    hide(start, start + rule.marker);
                    hide(end - rule.marker, end);
                    for (const attr of rule.attrs())
                        add(attr, start + rule.marker, end - rule.marker);

                    const mask = '\u0001'.repeat(rule.marker);
                    const i = m.index;
                    const j = m.index + m[0].length;
                    content = content.slice(0, i) + mask +
                        content.slice(i + rule.marker, j - rule.marker) + mask + content.slice(j);
                }
            }

            lineStart = lineEnd + 1;
        });

        const serialized = list.to_string();
        if (clutterText.get_attributes()?.to_string() === serialized)
            return;

        // Safety net: never re-apply in a loop
        const now = GLib.get_monotonic_time();
        if (now - (this._burstStart ?? 0) > 1000000) {
            this._burstStart = now;
            this._burstCount = 0;
        }
        if (++this._burstCount > 60) {
            console.warn('[SimpleDeskNote] formatting re-applied in a loop; ignoring');
            return;
        }

        this._appliedAttributes = serialized;
        clutterText.set_attributes(list);
    }

    _queueApplyAttributes() {
        if (this._applyId)
            return;
        this._applyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._applyId = 0;
            this._applyAttributes();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onKeyPress(actor, event) {
        const symbol = event.get_key_symbol();
        if (symbol !== Clutter.KEY_Return && symbol !== Clutter.KEY_KP_Enter &&
            symbol !== Clutter.KEY_ISO_Enter)
            return Clutter.EVENT_PROPAGATE;

        this._insertNewline(!(event.get_state() & Clutter.ModifierType.SHIFT_MASK));
        return Clutter.EVENT_STOP;
    }

    // Enter continua listas; Enter num item vazio encerra a lista.
    _insertNewline(continueList) {
        const clutterText = this._entry.clutter_text;
        const chars = [...this.text];
        const [start, end] = this._selectionRange();

        let lineStart = start;
        while (lineStart > 0 && chars[lineStart - 1] !== '\n')
            lineStart--;
        let lineEnd = end;
        while (lineEnd < chars.length && chars[lineEnd] !== '\n')
            lineEnd++;

        const line = chars.slice(lineStart, lineEnd).join('');
        const prefix = continueList ? line.match(CONTINUED_PREFIX_RE)?.[0] : null;

        if (prefix && line === prefix && start === end) {
            clutterText.set_text(
                chars.slice(0, lineStart).join('') + chars.slice(lineEnd).join(''));
            clutterText.set_cursor_position(lineStart);
            clutterText.set_selection_bound(lineStart);
            return;
        }

        let insert = '\n';
        if (prefix)
            insert += prefix.replace('☑', '☐').replace('◉', '○');

        clutterText.set_text(
            chars.slice(0, start).join('') + insert + chars.slice(end).join(''));
        const pos = start + [...insert].length;
        clutterText.set_cursor_position(pos);
        clutterText.set_selection_bound(pos);
    }

    // Clicking a checkbox/radio symbol toggles it
    _onTextPress(actor, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const clutterText = this._entry.clutter_text;
        const [stageX, stageY] = event.get_coords();
        const [ok, x, y] = clutterText.transform_stage_point(stageX, stageY);
        if (!ok)
            return Clutter.EVENT_PROPAGATE;

        // coords_to_position returns a UTF-8 byte index
        const text = this.text;
        const byteIndex = clutterText.coords_to_position(x, y);
        let pos = byteOffsets(text).findIndex(b => b >= byteIndex);
        if (pos < 0)
            pos = text.length;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        if (pos - lineStart > 1)
            return Clutter.EVENT_PROPAGATE;

        const lines = text.split('\n');
        const lineIndex = text.slice(0, lineStart).split('\n').length - 1;
        const line = lines[lineIndex];

        // coords_to_position rounds to the nearest character; make sure the
        // click really landed on the symbol
        const symbolEnd = utf16ToChar(text, lineStart) + 1;
        const [, symbolX] = clutterText.position_to_coords(symbolEnd);
        if (x > symbolX + 2)
            return Clutter.EVENT_PROPAGATE;

        if (CHECK_RE.test(line))
            lines[lineIndex] = (line[0] === '☐' ? '☑' : '☐') + line.slice(1);
        else if (RADIO_RE.test(line))
            this._selectRadio(lines, lineIndex);
        else
            return Clutter.EVENT_PROPAGATE;

        const cursor = clutterText.get_cursor_position();
        clutterText.set_text(lines.join('\n'));
        clutterText.set_cursor_position(cursor);
        clutterText.set_selection_bound(cursor);
        return Clutter.EVENT_STOP;
    }

    _selectRadio(lines, index) {
        let start = index;
        let end = index;
        while (start > 0 && RADIO_RE.test(lines[start - 1]))
            start--;
        while (end < lines.length - 1 && RADIO_RE.test(lines[end + 1]))
            end++;
        for (let i = start; i <= end; i++)
            lines[i] = (i === index ? '◉' : '○') + lines[i].slice(1);
    }

    // ClutterText positions are in characters; -1 means the end.
    _selectionRange() {
        const clutterText = this._entry.clutter_text;
        const length = [...clutterText.get_text()].length;
        let a = clutterText.get_cursor_position();
        let b = clutterText.get_selection_bound();
        if (a < 0)
            a = length;
        if (b < 0)
            b = length;
        return a < b ? [a, b] : [b, a];
    }

    _wrapSelection(marker) {
        const clutterText = this._entry.clutter_text;
        const chars = [...clutterText.get_text()];
        const [start, end] = this._selectionRange();
        const selected = chars.slice(start, end).join('');
        const markerLength = [...marker].length;

        // Already formatted (hidden markers around the selection)? Then undo it.
        const before = chars.slice(start - markerLength, start).join('');
        const after = chars.slice(end, end + markerLength).join('');
        const isItalicInsideBold = marker === '*' &&
            (chars[start - markerLength - 1] === '*' || chars[end + markerLength] === '*');
        if (start >= markerLength && before === marker && after === marker &&
            !isItalicInsideBold) {
            clutterText.set_text(
                chars.slice(0, start - markerLength).join('') + selected +
                chars.slice(end + markerLength).join(''));
            clutterText.set_selection(start - markerLength, end - markerLength);
            clutterText.grab_key_focus();
            return;
        }

        clutterText.set_text(
            chars.slice(0, start).join('') + marker + selected + marker +
            chars.slice(end).join(''));
        clutterText.set_selection(start + markerLength, end + markerLength);
        clutterText.grab_key_focus();
    }

    _toggleLinePrefix(prefix) {
        const clutterText = this._entry.clutter_text;
        const chars = [...clutterText.get_text()];
        const [cursor] = this._selectionRange();

        let lineStart = cursor;
        while (lineStart > 0 && chars[lineStart - 1] !== '\n')
            lineStart--;
        let lineEnd = cursor;
        while (lineEnd < chars.length && chars[lineEnd] !== '\n')
            lineEnd++;

        const line = chars.slice(lineStart, lineEnd).join('');
        const existing = line.match(LINE_PREFIX_RE)?.[0] ?? '';
        const rest = line.slice(existing.length);
        const sameKind = existing === prefix ||
            (prefix === '☐ ' && existing === '☑ ') ||
            (prefix === '○ ' && existing === '◉ ');
        const newLine = sameKind ? rest : prefix + rest;

        clutterText.set_text(
            chars.slice(0, lineStart).join('') + newLine + chars.slice(lineEnd).join(''));
        clutterText.set_cursor_position(lineStart + [...newLine].length);
        clutterText.set_selection_bound(lineStart + [...newLine].length);
        clutterText.grab_key_focus();
    }

    _cycleColor() {
        this.remove_style_class_name(`sdn-${this._color}`);
        this._color = COLORS[(COLORS.indexOf(this._color) + 1) % COLORS.length];
        this.add_style_class_name(`sdn-${this._color}`);
        this._syncColorButton();
        this.emit('changed');
    }

    _syncColorButton() {
        const next = COLORS[(COLORS.indexOf(this._color) + 1) % COLORS.length];
        this._colorButton.style_class = `sdn-dot sdn-${next}`;
    }

    _onCloseClicked() {
        if (this.text.trim() === '') {
            this.emit('delete-requested');
            return;
        }
        this._confirmButton.show();
        this._clearConfirmTimeout();
        this._confirmTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_TIMEOUT_MS, () => {
            this._confirmButton.hide();
            this._confirmTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearConfirmTimeout() {
        if (this._confirmTimeoutId) {
            GLib.source_remove(this._confirmTimeoutId);
            this._confirmTimeoutId = 0;
        }
    }

    // A note is never narrower than the toolbar + resize grip
    _minWidth() {
        const [, toolbarWidth] = this._toolbar.get_preferred_width(-1);
        const [, gripWidth] = this._resizeGrip.get_preferred_width(-1);
        const footerNode = this._footer.get_theme_node();
        const padding = footerNode.get_horizontal_padding() +
            this.get_theme_node().get_horizontal_padding();
        return Math.max(MIN_SIZE[0], Math.ceil(toolbarWidth + gripWidth + padding + 4));
    }

    _connectGrabHandlers(actor) {
        actor.connect('motion-event', this._onGrabMotion.bind(this));
        actor.connect('button-release-event', this._onGrabEnd.bind(this));
    }

    _onGrabStart(actor, event, mode) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        this._grabMode = mode;
        this._grabStart = [stageX, stageY, this.x, this.y, this.width, this.height];
        this._grab = global.stage.grab(actor);
        this.emit('raise-requested');
        return Clutter.EVENT_STOP;
    }

    // Pressing the unfocused title either drags the note (after a small
    // movement) or, on release without moving, starts editing the title.
    _onTitleEvent(actor, event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (this._titleEntry.clutter_text.has_key_focus())
                return Clutter.EVENT_PROPAGATE;
            return this._onGrabStart(actor, event, 'title');
        }
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION)
            return this._onGrabMotion(actor, event);
        if (type === Clutter.EventType.BUTTON_RELEASE)
            return this._onGrabEnd(actor, event);
        return Clutter.EVENT_PROPAGATE;
    }

    _onGrabMotion(actor, event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        const [startX, startY, x, y, width, height] = this._grabStart;
        const dx = stageX - startX;
        const dy = stageY - startY;

        if (this._grabMode === 'title') {
            if (Math.abs(dx) + Math.abs(dy) < 5)
                return Clutter.EVENT_STOP;
            this._grabMode = 'move';
        }

        if (this._grabMode === 'move') {
            const maxX = global.stage.width - 40;
            const maxY = global.stage.height - 30;
            this.set_position(
                Math.round(Math.min(Math.max(x + dx, 0), maxX)),
                Math.round(Math.min(Math.max(y + dy, 0), maxY)));
        } else {
            this.set_size(
                Math.round(Math.max(width + dx, this._minWidth())),
                Math.round(Math.max(height + dy, MIN_SIZE[1])));
        }
        return Clutter.EVENT_STOP;
    }

    _onGrabEnd() {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;

        const mode = this._grabMode;
        this._dismissGrab();
        this._syncToolbar();

        if (mode === 'title') {
            const titleText = this._titleEntry.clutter_text;
            titleText.grab_key_focus();
            titleText.set_cursor_position(-1);
            titleText.set_selection_bound(-1);
            return Clutter.EVENT_STOP;
        }
        if (mode === 'move')
            this.emit('moved');
        this.emit('changed');
        return Clutter.EVENT_STOP;
    }

    _dismissGrab() {
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(manager, extensionPath) {
        super._init(0.0, 'SimpleDeskNote');
        this._manager = manager;

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev(
                [extensionPath, 'icons', 'simpledesknote-symbolic.svg'])),
            style_class: 'system-status-icon',
        }));

        const newItem = new PopupMenu.PopupMenuItem('New note');
        newItem.connect('activate', () => this._manager.createNote());
        this.menu.addMenuItem(newItem);

        this._visibleSwitch = new PopupMenu.PopupSwitchMenuItem('Show notes', manager.visible);
        this._visibleSwitch.connect('toggled', (item, state) => this._manager.setVisible(state));
        this.menu.addMenuItem(this._visibleSwitch);

        this._onTopSwitch = new PopupMenu.PopupSwitchMenuItem('Above windows', manager.onTop);
        this._onTopSwitch.connect('toggled', (item, state) => this._manager.setOnTop(state));
        this.menu.addMenuItem(this._onTopSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._notesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._notesSection);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._rebuildNotesList();
        });
    }

    _rebuildNotesList() {
        this._visibleSwitch.setToggleState(this._manager.visible);
        this._onTopSwitch.setToggleState(this._manager.onTop);
        this._notesSection.removeAll();

        const notes = this._manager.notes;
        if (notes.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No notes', {reactive: false});
            this._notesSection.addMenuItem(empty);
            return;
        }

        for (const note of notes) {
            const item = new PopupMenu.PopupMenuItem(note.label || '(empty note)');
            item.connect('activate', () => this._manager.showNote(note));
            this._notesSection.addMenuItem(item);
        }
    }
});

class NotesManager {
    constructor(dataDir) {
        this._file = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'notes.json']));
        this._dataDir = dataDir;
        this.notes = [];
        this.visible = true;
        this.onTop = false;
        this._saveTimeoutId = 0;
        this._laterId = 0;

        this._layer = new St.Widget({
            name: 'simpledesknote-layer',
            reactive: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._layer.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        global.window_group.add_child(this._layer);

        this._restackedId = global.display.connect('restacked', () => this._queueRestack());
        this._overviewShowingId = Main.overview.connect('showing', () => this._syncChromeVisibility());
        this._overviewHiddenId = Main.overview.connect('hidden', () => this._syncChromeVisibility());
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._restorePositions());

        this._load();
        this._restack();
    }

    destroy() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
            this._save({sync: true});
        }
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        global.display.disconnect(this._restackedId);
        Main.overview.disconnect(this._overviewShowingId);
        Main.overview.disconnect(this._overviewHiddenId);
        Main.layoutManager.disconnect(this._monitorsChangedId);

        for (const note of this.notes) {
            if (this.onTop)
                Main.layoutManager.removeChrome(note);
            note.destroy();
        }
        this.notes = [];
        this._layer.destroy();
    }

    createNote() {
        const monitor = Main.layoutManager.primaryMonitor;
        const offset = (this.notes.length % 8) * 28;
        const note = this._addNote({
            id: GLib.uuid_string_random(),
            text: '',
            color: COLORS[this.notes.length % COLORS.length],
            x: monitor.x + Math.round(monitor.width / 2) - 110 + offset,
            y: monitor.y + Math.round(monitor.height / 3) + offset,
        });
        note.savePosition(getMonitors());
        this.setVisible(true);
        note.focusText();
        this._queueSave();
    }

    showNote(note) {
        this.setVisible(true);
        this._raise(note);
        note.focusText();
    }

    setVisible(visible) {
        this.visible = visible;
        this._layer.visible = visible;
        this._syncChromeVisibility();
        this._queueSave();
    }

    setOnTop(onTop) {
        if (onTop === this.onTop)
            return;
        this.onTop = onTop;

        for (const note of this.notes) {
            if (onTop) {
                this._layer.remove_child(note);
                Main.layoutManager.addChrome(note, {trackFullscreen: true});
            } else {
                Main.layoutManager.removeChrome(note);
                this._layer.add_child(note);
            }
        }
        this._syncChromeVisibility();
        this._queueSave();
    }

    _addNote(data) {
        const note = new Note(data);
        note.connect('changed', () => this._queueSave());
        note.connect('moved', () => note.savePosition(getMonitors()));
        note.connect('raise-requested', () => this._raise(note));
        note.connect('delete-requested', () => this._deleteNote(note));

        if (this.onTop)
            Main.layoutManager.addChrome(note, {trackFullscreen: true});
        else
            this._layer.add_child(note);

        this.notes.push(note);
        this._syncChromeVisibility();
        return note;
    }

    _deleteNote(note) {
        this.notes = this.notes.filter(n => n !== note);
        if (this.onTop)
            Main.layoutManager.removeChrome(note);
        note.destroy();
        this._queueSave();
    }

    _raise(note) {
        const parent = note.get_parent();
        if (!parent)
            return;
        if (this.onTop)
            parent.set_child_below_sibling(note, global.top_window_group);
        else
            parent.set_child_above_sibling(note, null);
    }

    // In "above windows" mode notes are chrome and hide with the overview.
    _syncChromeVisibility() {
        if (!this.onTop)
            return;
        const show = this.visible && !Main.overview.visible;
        for (const note of this.notes)
            note.visible = show;
    }

    // Mutter restacks global.window_group on every stacking change and pushes
    // unknown actors to the top. Put the layer back right above the wallpaper /
    // desktop icons window before the next frame.
    _queueRestack() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._restack();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restack() {
        const windowGroup = global.window_group;
        let anchor = Main.layoutManager._backgroundGroup;

        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win?.get_window_type() === Meta.WindowType.DESKTOP &&
                actor.get_parent() === windowGroup)
                anchor = actor;
        }

        if (anchor && anchor.get_parent() === windowGroup)
            windowGroup.set_child_above_sibling(this._layer, anchor);
        else
            windowGroup.set_child_below_sibling(this._layer, null);
    }

    _load() {
        let data = {notes: []};
        try {
            const [, contents] = this._file.load_contents(null);
            data = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`[SimpleDeskNote] Failed to read notes: ${e}`);
        }

        this.visible = data.visible ?? true;
        this.onTop = data.onTop ?? false;
        this._layer.visible = this.visible;

        const monitors = getMonitors();
        for (const n of data.notes ?? []) {
            const note = this._addNote({...n, id: n.id ?? GLib.uuid_string_random()});
            // Notes saved before per-monitor positions: adopt where they are now
            if (!note.home) {
                note.savePosition(monitors);
                this._queueSave();
            }
            note.restorePosition(monitors);
        }
    }

    _restorePositions() {
        const monitors = getMonitors();
        for (const note of this.notes)
            note.restorePosition(monitors);
    }

    _queueSave() {
        if (this._saveTimeoutId)
            GLib.source_remove(this._saveTimeoutId);
        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveTimeoutId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Saves are asynchronous, except the last one when the extension is
    // disabled, which must finish before the notes go away.
    _save({sync = false} = {}) {
        const data = {
            visible: this.visible,
            onTop: this.onTop,
            notes: this.notes.map(n => n.serialize()),
        };
        const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
        const flags = Gio.FileCreateFlags.REPLACE_DESTINATION;
        try {
            GLib.mkdir_with_parents(this._dataDir, 0o700);
            if (sync) {
                this._file.replace_contents(bytes, null, true, flags, null);
                return;
            }
            this._file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, true, flags, null,
                (file, result) => {
                    try {
                        file.replace_contents_finish(result);
                    } catch (e) {
                        console.error(`[SimpleDeskNote] Failed to save notes: ${e}`);
                    }
                });
        } catch (e) {
            console.error(`[SimpleDeskNote] Failed to save notes: ${e}`);
        }
    }
}

export default class SimpleDeskNoteExtension extends Extension {
    enable() {
        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'simpledesknote']);
        tooltips = new Tooltips();
        this._manager = new NotesManager(dataDir);
        this._indicator = new Indicator(this._manager, this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._manager?.destroy();
        this._manager = null;
        tooltips?.destroy();
        tooltips = null;
    }
}
