function removeSignatureParagraphMargins(html) {
  if (!html) return html;
 
  return html.replace(/<p(\s[^>]*)?>/gi, (match, attrs = "") => {
    // If a style attribute already exists, prepend margin:0; to it
    if (/style\s*=/i.test(attrs)) {
      return match.replace(
        /style\s*=\s*["']([^"']*)["']/i,
        (styleMatch, existing) => `style="margin:0;${existing}"`
      );
    }
 
    // No style attribute yet — add one
    return `<p${attrs} style="margin:0; margin-bottom:4px; font-size:15px; line-height: 18px;">`;
  });
}
 

function applyEmailBodyStyles(html) {
  if (!html) return html;

  // Apply styles to <p> tags
  html = html.replace(/<p(\s[^>]*)?>/gi, (match, attrs = "") => {
    if (/style\s*=/i.test(attrs)) {
      return match.replace(
        /style\s*=\s*["']([^"']*)["']/i,
        (styleMatch, existing) => `style="margin:0; margin-bottom:8px; font-size:15px; line-height:1.7; ${existing}"`
      );
    }
    return `<p${attrs} style="margin:0; margin-bottom:8px; font-size:15px; line-height:1.7;">`;
  });

  // Apply styles to <li> tags
  html = html.replace(/<li(\s[^>]*)?>/gi, (match, attrs = "") => {
    if (/style\s*=/i.test(attrs)) {
      return match.replace(
        /style\s*=\s*["']([^"']*)["']/i,
        (styleMatch, existing) => `style="font-size:15px; line-height:1.7; margin-bottom:4px; ${existing}"`
      );
    }
    return `<li${attrs} style="font-size:15px; line-height:1.7; margin-bottom:4px;">`;
  });

  return html;
}
 
module.exports = { removeSignatureParagraphMargins, applyEmailBodyStyles };