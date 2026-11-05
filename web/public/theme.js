// Runs before first paint, so a dark-mode user never sees a white flash.
try {
  var t = localStorage.getItem('tele-photo-theme');
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
