/**
 * Pure helpers for the chat panel's "jump to bottom" affordance.
 *
 * The chat panel auto-scrolls to the latest message while the user is
 * pinned to the bottom, but as soon as they scroll back to read earlier
 * content we stop following new messages. A floating "jump to bottom"
 * button appears once they're more than a viewport's worth above the
 * bottom \u2014 a slightly larger threshold than the casual "I drifted up
 * one paragraph" case, so the button doesn't flicker in and out for
 * small inertial-scroll overshoots.
 *
 * Both predicates are pure functions of `{ scrollTop, scrollHeight,
 * clientHeight }`; the React side passes the DOM element's properties
 * straight through. Pulling them out makes the thresholds testable
 * without jsdom + scroll event plumbing.
 */

export interface ScrollMetrics {
  /** Distance the viewport has scrolled from the top of the content. */
  scrollTop: number;
  /** Total scrollable content height. */
  scrollHeight: number;
  /** Height of the viewport itself. */
  clientHeight: number;
}

/**
 * Pixel tolerance for considering the viewport "at the bottom". Scroll
 * positions are floats on high-DPI displays and can drift by a fraction
 * of a pixel during a smooth-scroll animation; without a fudge factor
 * the pinned-to-bottom check would flicker on every wheel tick.
 *
 * 4px matches the look of the rounded chat-panel scroll thumb in
 * styles.css, so the eye can't tell the difference anyway.
 */
const BOTTOM_FUDGE_PX = 4;

/**
 * True when the viewport's bottom edge is at (or within
 * `BOTTOM_FUDGE_PX` of) the content's bottom edge. The auto-scroll
 * side uses this to decide whether to keep following new messages.
 */
export function isAtBottom(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= BOTTOM_FUDGE_PX;
}

/**
 * True when the viewport has scrolled back by more than one
 * `clientHeight` from the bottom \u2014 the trigger for the "jump to
 * bottom" button. One viewport is the user-facing "more than a page"
 * the feature is named after; tighter than that and the button
 * appears for trivial scrollbacks, looser and the user has to hunt
 * for it after reading a single off-screen message.
 */
export function isMoreThanOneViewportFromBottom(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight > m.clientHeight;
}
