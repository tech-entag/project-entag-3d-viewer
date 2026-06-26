/**
 * Bubble app version resolution.
 *
 * Bubble runs two app versions ("test" and "live"), exposed in URLs as a
 * `version-test` / `version-live` path segment. The caller (Bubble) tells us
 * which one to target via a `version` field; this maps any of the accepted
 * spellings to a canonical segment, defaulting to `version-test` for safety.
 *
 *   resolveBubbleVersionSegment("live")          -> "version-live"
 *   resolveBubbleVersionSegment("version-live")  -> "version-live"
 *   resolveBubbleVersionSegment("test")          -> "version-test"
 *   resolveBubbleVersionSegment(undefined)       -> "version-test"
 */

export const DEFAULT_BUBBLE_VERSION_SEGMENT = "version-test";

/** Canonical `version-test` | `version-live` segment from a caller's `version`. */
export const resolveBubbleVersionSegment = (version: unknown): string => {
  if (typeof version === "string") {
    const v = version.trim().toLowerCase();
    if (v === "live" || v === "version-live") return "version-live";
    if (v === "test" || v === "version-test") return "version-test";
  }
  return DEFAULT_BUBBLE_VERSION_SEGMENT;
};
