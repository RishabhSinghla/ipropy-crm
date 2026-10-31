/* Runs before the app paints (CSP forbids inline scripts, so it is a file).
   Re-applies the brand colours the last visit saved, so a refresh never shows
   the stylesheet's default violet before the saved brand arrives. */
try {
  var saved = JSON.parse(localStorage.getItem('ipropy.brandVars') || 'null');
  if (saved) for (var k in saved) document.documentElement.style.setProperty(k, saved[k]);
} catch (e) { /* no storage: the app applies the brand once it loads */ }
