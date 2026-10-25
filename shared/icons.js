// =============================================================================
// shared/icons.js — a small set of line icons (inline SVG, no icon font needed)
// -----------------------------------------------------------------------------
// Usage in HTML:  <span class="icon" data-icon="bell"></span>
// UI.icons.render() replaces every [data-icon] element with the matching SVG.
// UI.icons.svg('bell') returns the SVG markup as a string.
// =============================================================================
(function () {
  // Each icon is a list of SVG path "d" strings drawn on a 24×24 grid.
  const PATHS = {
    overview: ['M4 13h6V4H4z', 'M14 20h6v-9h-6z', 'M4 20h6v-4H4z', 'M14 4v4h6V4z'],
    licence: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h4'],
    tariff: ['M3 12V4h8l10 10-8 8z', 'M7.5 8.5h.01'],
    usage: ['M4 12a8 8 0 0 1 16 0', 'M7.5 12a4.5 4.5 0 0 1 9 0', 'M12 12v8', 'M9 20h6'],
    compliance: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
    runs: ['M12 3v18', 'M12 8l-6 4', 'M12 8l6 4', 'M6 12v5', 'M18 12v5'],
    claims: ['M12 3v18', 'M5 7h14', 'M5 7l-3 7a3 3 0 0 0 6 0z', 'M19 7l-3 7a3 3 0 0 0 6 0z', 'M8 21h8'],
    catalogue: ['M9 18V5l11-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    audit: ['M9 12a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1', 'M15 12a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1'],
    settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z'],
    works: ['M9 18V5l11-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    confirm: ['M20 6L9 17l-5-5'],
    statements: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6', 'M9 16h3'],
    unclaimed: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3', 'M11 8v3', 'M11 14h.01'],
    disputes: ['M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z', 'M9 10h6', 'M9 14h4'],
    profile: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
    report: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v4h16v-4'],
    keys: ['M15 9a4 4 0 1 1-4-4 4 4 0 0 1 4 4z', 'M13.5 11.5L21 19', 'M18 16l2-2', 'M16 14l2-2'],
    bell: ['M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10 21a2 2 0 0 0 4 0'],
    sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'M4.2 4.2l1.4 1.4', 'M18.4 18.4l1.4 1.4', 'M1 12h2', 'M21 12h2', 'M4.2 19.8l1.4-1.4', 'M18.4 5.6l1.4-1.4'],
    moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
    menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
    print: ['M6 9V3h12v6', 'M6 18H4v-7h16v7h-2', 'M6 14h12v7H6z'],
    logout: ['M9 21H5V3h4', 'M16 17l5-5-5-5', 'M21 12H9'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
    radio: ['M3 9h18v11H3z', 'M7 9l10-5', 'M8 15a2 2 0 1 0 0-.01', 'M14 13h4', 'M14 16h4'],
    plus: ['M12 5v14', 'M5 12h14'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
    public: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18']
  };

  function svg(name, extraClass = '') {
    const paths = PATHS[name] || PATHS.overview;
    return `<svg class="icon-svg ${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
  }

  // Fill every <span data-icon="..."> on the page (once).
  function render(root = document) {
    root.querySelectorAll('[data-icon]:not([data-icon-done])').forEach((el) => {
      el.innerHTML = svg(el.dataset.icon);
      el.setAttribute('data-icon-done', '');
    });
  }

  window.UIIcons = { svg, render, names: Object.keys(PATHS) };
})();
