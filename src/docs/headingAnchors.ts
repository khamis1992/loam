/**
 * Neo N22 - heading anchors.
 *
 * The one rule that decides whether a `#fragment` link resolves. It lives here
 * so `src/docs/neoDocs.ts` can build `page.anchors` from it and prove every
 * link against those anchors, while the in-app help page links its outline to
 * the anchors the server already computed (`GET /api/docs` sends both).
 *
 * A second copy of the rule in the UI would drift: the checker would accept an
 * anchor the page cannot reach, or the page would link to one the checker
 * rejects. So the page never derives anchors itself.
 *
 * Kept free of React and of the i18n catalog, like `neoDocs.ts`, so it can run
 * under `node --test`.
 */

/**
 * Turn a heading into the anchor a link uses. GitHub-style: lower case, drop
 * punctuation except hyphens, spaces to hyphens. Non-ASCII letters (Arabic,
 * accented Latin) survive, which is what the browser does too.
 */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}
