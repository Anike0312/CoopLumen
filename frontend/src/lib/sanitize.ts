import DOMPurify from 'isomorphic-dompurify';

/** Converts stored user-authored content to inert plain text before rendering. */
export function sanitizeUserText(value: string | null | undefined): string {
  if (!value) return '';
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  });
}
