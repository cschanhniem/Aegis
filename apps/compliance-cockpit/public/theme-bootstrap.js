// No-flash theme bootstrap. Runs before paint, reads the saved
// preference from localStorage, and sets the .dark or .light class on
// <html> so anything depending on CSS variables renders correctly on
// first paint.
//
// Served as a static asset (not inlined via React) so a future bug
// can NEVER template user input into a <script> body. The dropdown
// of options is hard-coded here — no user-controlled string ever
// reaches eval / document.write.
(function () {
  try {
    var stored = localStorage.getItem('aegis:theme');
    var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var apply = stored === 'dark' || ((stored === 'system' || !stored) && sysDark);
    if (apply) document.documentElement.classList.add('dark');
    else if (stored === 'light') document.documentElement.classList.add('light');
  } catch (_) {}
})();
