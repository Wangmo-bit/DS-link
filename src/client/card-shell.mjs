/**
 * card-shell — shared visual shell for session-link business cards.
 *
 * One frame, two directions. The frame (border / radius / tinted surface) is
 * owned by the outer `.sl-card.sl-card--{direction}` div only; the header
 * toggle and the expanded sibling never draw a second card. Colours follow the
 * direction the CURRENT conversation is viewing the message from:
 *   - sent      = this session sent it        (light blue-grey)
 *   - received  = this session received it    (light green-grey)
 * Both light surfaces are deliberately low-saturation; the chip text
 * 发送 / 接收 is the non-colour cue that carries the direction.
 *
 * Dark theme is the host's existing `body[data-ds-dark-theme]` marker (the
 * local ui-layout source uses exactly that attribute); light is the default.
 * Only CSS classes are used here — never per-node inline styles — so the two
 * renderers share one visual contract.
 */

/**
 * Absolute party labels (who really sent / received). These are NOT the
 * viewing direction: colour alone carries "this session sent/received".
 */
export const CARD_PARTY = Object.freeze({ sender: '发件人', recipient: '收件人', subject: '主题' });

/** Visible direction, keyed by transport direction (data/QA only, no chip). */
export const CARD_DIRECTION = Object.freeze({ sent: '发送', received: '接收' });

/** Unknown/absent direction falls back to the receiver side (safe default). */
function normalizeDirection(direction) {
  return direction === 'sent' ? 'sent' : 'received';
}

/**
 * Chip label for a direction: 发送 for sent, 接收 for received.
 * @param {'sent'|'received'} direction
 * @returns {string}
 */
export function directionLabel(direction) {
  return CARD_DIRECTION[normalizeDirection(direction)];
}

/**
 * Outer frame class list. The direction modifier is the ONLY surface switch;
 * it is applied to the outer div exclusively.
 * @param {'sent'|'received'} direction
 * @returns {string}
 */
export function cardClass(direction) {
  return `sl-card sl-card--${normalizeDirection(direction)}`;
}

/** Toggle text on the SAME header button (never a nested control). */
export function toggleText(open) {
  return open === true ? '收起 ⌃' : '展开 ⌄';
}

/**
 * Direction data attribute spread on the outer frame (test/QA hook only; the
 * value mirrors the class modifier).
 * @param {'sent'|'received'} direction
 * @returns {{'data-session-link-direction': 'sent'|'received'}}
 */
export function directionAttribute(direction) {
  return { 'data-session-link-direction': normalizeDirection(direction) };
}

/**
 * Complete stylesheet for the shared shell. Appended once by index.jsx after
 * the existing plugin CSS (`style.textContent = css + CARD_CSS`).
 */
export const CARD_CSS = `
.sl-card {
  margin: 2px 0;
  border: 1px solid #B9C8DE;
  border-radius: 8px;
  overflow: hidden;
  background: #EDF1F7;
  color: #212A38;
  font: inherit;
}
.sl-card--sent {
  border-color: #B9C8DE;
  background: #EDF1F7;
  color: #212A38;
}
.sl-card--received {
  border-color: #BFD6CC;
  background: #ECF3F0;
  color: #223029;
}
body[data-ds-dark-theme] .sl-card--sent {
  border-color: #3C5477;
  background: #1C2636;
  color: #E6E8ED;
}
body[data-ds-dark-theme] .sl-card--received {
  border-color: #3E655B;
  background: #1A2C29;
  color: #E6E8ED;
}
.sl-card__toggle {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.sl-card__toggle:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}
.sl-card__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.sl-card__party {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  width: 100%;
}
.sl-card__party-label {
  flex: none;
  opacity: 0.7;
  font-size: 0.85em;
}
.sl-card__party-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-card__toggle-text {
  flex: none;
  margin-left: auto;
  white-space: nowrap;
  opacity: 0.85;
  font-size: 0.9em;
}
.sl-card__subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
}
.sl-card__status {
  flex: none;
  margin-left: auto;
  font-size: 0.8em;
  white-space: nowrap;
  opacity: 0.72;
}
.sl-card__expanded {
  padding: 6px 10px 8px;
  border-top: 1px solid rgba(127, 127, 127, 0.28);
}
.sl-card__notice {
  margin-bottom: 4px;
  font-size: 0.9em;
  opacity: 0.75;
}
.sl-card__placeholder {
  opacity: 0.82;
}
.sl-card__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sl-card__retry {
  font: inherit;
}
.sl-card__body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 100%;
}
.sl-card__body--pre {
  font: inherit;
}
.sl-card__tech {
  margin-top: 6px;
}
.sl-card__tech summary {
  cursor: pointer;
  opacity: 0.75;
}
.sl-card__techblock {
  font-family: monospace;
  font-size: 0.85em;
  overflow-wrap: anywhere;
}
.sl-card__techpre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.85em;
}
.sl-card__rawtext {
  margin: 4px 0 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.85em;
}
.sl-card__inspect {
  margin-top: 6px;
  font: inherit;
}
`;

/**
 * Stable chat-shell overrides: one bubble-shaped message row for both
 * directions. The existing two/three-line DOM stays intact (tests and
 * attributes depend on it); only its visual hierarchy becomes a message.
 */
export const BUBBLE_CSS = `
.sl-card {
  max-width: min(78%, 720px);
  margin: 8px 0;
  border: 0;
  border-radius: 15px;
  background: #ECF3F0;
  color: #223029;
  box-shadow: 0 1px 2px rgba(16,19,24,.04);
}
.sl-card--sent {
  margin-left: auto;
  margin-right: 0;
  border-radius: 15px 15px 4px 15px;
  background: #E8EFFA;
  color: #1E2A3B;
}
.sl-card--received {
  margin-left: 0;
  margin-right: auto;
  border-radius: 15px 15px 15px 4px;
  background: #EDF3F0;
  color: #223029;
}
body[data-ds-dark-theme] .sl-card--sent { background: #263248; color: #E8EDF6; border: 0; }
body[data-ds-dark-theme] .sl-card--received { background: #23302D; color: #E6EEEA; border: 0; }
.sl-card__toggle {
  gap: 5px;
  padding: 10px 13px 11px;
  border-radius: inherit;
  flex-wrap: wrap;
}
.sl-card__party {
  width: auto;
  flex: 0 1 auto;
  align-items: baseline;
  gap: 5px;
}
.sl-card__party[data-session-link-card-sender-row] { max-width: calc(100% - 56px); }
.sl-card__party[data-session-link-card-recipient-row] { max-width: 100%; }
.sl-card__party[data-session-link-card-recipient-row]::before {
  content: "→";
  flex: none;
  opacity: .45;
}
.sl-card__party[data-session-link-card-subject-row],
.sl-card__party[data-session-link-card-subject] { flex-basis: 100%; width: 100%; }
.sl-card__party-label { display: none; }
.sl-card__party-name { font-size: 11px; line-height: 1.4; opacity: .72; flex: 0 1 auto; }
.sl-card__toggle-text {
  margin-left: auto;
  font-size: 11px;
  opacity: .55;
}
.sl-card__subject {
  flex: 1 1 auto;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.6;
  opacity: 1;
}
.sl-card__status {
  flex: none;
  align-self: flex-end;
  font-size: 10px;
  opacity: .6;
}
.sl-card__expanded {
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  padding: 10px 13px 12px;
}
.sl-card__body--pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; font-size: 13px; line-height: 1.6; }
.sl-card__notice { display: none; }
`;
