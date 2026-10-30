/**
 * What the cook typed in the "Source link" box, as the value to save.
 *
 * `null` for an empty box, the link itself when it is http or https, and a bare address
 * ("kingarthurbaking.com/recipes/...") is taken as https, because that is how people paste one
 * out of a phone's address bar. Anything else (`javascript:`, `ftp:`, spaces) is `invalid`: the
 * value is rendered as an `href`, and `recipe.create`/`update` refuse those schemes too.
 */
export function sourceUrlInput(text: string): { url: string | null } | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return { url: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'invalid';
    if (!parsed.hostname.includes('.') || /\s/.test(trimmed)) return 'invalid';
    return { url: withScheme };
  } catch {
    return 'invalid';
  }
}

/**
 * A source link worth rendering, reduced to the site's name, or `null`.
 *
 * Two jobs in one pass. It refuses anything that is not http or https, because this value ends
 * up in an `href` and React does not sanitize one - `recipe.create` refuses the other schemes
 * as well, and this is the second lock rather than the only one. And it gives the link a name a
 * cook recognises: "budgetbytes.com" reads better than sixty characters of slug and tracking
 * parameters, and the full URL is still there in the `href` and the tooltip.
 */
export function sourceSite(sourceUrl: string | null): { href: string; site: string } | null {
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { href: sourceUrl, site: parsed.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}
