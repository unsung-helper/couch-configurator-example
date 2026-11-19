/**
 * Returns the display label for a parameter or output:
 * uses the display name if non-empty, otherwise falls back to the id.
 */
export function displayLabel(item) {
  return (item.name && item.name.trim()) ? item.name : item.id;
}

/**
 * The URL to load an option image (enumParameter detail.images) from: a
 * "resources/<name>" URI is a file in public/resources, shipped next to
 * unsung.wasm; data URLs embedded by the Qt editor carry the bare file
 * extension instead of a MIME type ("data:png;base64,…").
 */
export function imageUrl(uri) {
  if (!uri) return '';
  if (/^data:/i.test(uri)) {
    const comma = uri.indexOf(',');
    if (comma < 0) return '';
    const header = uri.slice(5, comma).split(';');
    if (!header[0].includes('/')) {
      const ext = header[0].toLowerCase();
      header[0] = 'image/' + (ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext);
    }
    return 'data:' + header.join(';') + uri.slice(comma);
  }
  return uri;
}
