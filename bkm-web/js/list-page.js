/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Shared scaffold for FHIR list pages. Renders the page-header (title + debounced
// search + page-size + optional New), a data/help tab pair, and a bundle-link pager,
// and owns the loading/error states. The page supplies the data-specific bits.
//
// listPage({
//   el,                         // container element
//   prefix,                     // id prefix; yields <prefix>-data/-help/-search/-pagesize/-new/-prev/-next
//   title, dataTabLabel,        // header <h2> and the data tab label (defaults to title)
//   helpHTML,                   // static help-panel HTML (e.g. fooHelpHTML())
//   searchPlaceholder,
//   pageSizes = [5,10,20,50], pageSize = 10, onPageSize(n),  // onPageSize persists caller state
//   canNew, newLabel, onNew(reload),                          // New button (omitted if !canNew)
//   headerExtra,                // optional extra HTML in the header (e.g. an Export button/link)
//   onChrome(el),               // optional hook after chrome is built (wire headerExtra buttons)
//   preload(): Promise,         // optional one-off fetch before the first load (e.g. name maps)
//   query(search, pageSize) -> FHIR query string,
//   items(bundle) -> array,     // domain rows from the bundle
//   renderItem(item) -> html,            // card path: one card per row, OR
//   renderData(rows, bundle) -> html,    // table path: full data-area HTML (table+sort headers)
//   emptyText,                  // card path only; shown when items() is empty
//   wireItems(dataEl, items, reload, reRender),  // wire row buttons (reload=refetch, reRender=re-render same bundle, e.g. sort)
// })
// Returns { reload }.
function listPage(opts) {
  var el       = opts.el;
  var id       = function(s) { return opts.prefix + '-' + s; };
  var search   = '';
  var pageSize = opts.pageSize || 10;
  var pageSizes = opts.pageSizes || [5, 10, 20, 50];
  var searchTimer = null;
  var lastBundle = null;

  function dataEl()      { return document.getElementById(id('data')); }
  function loadingState(){ dataEl().innerHTML = '<p aria-busy="true" style="padding:16px">Loading…</p>'; }
  function errorState(m) { dataEl().innerHTML = `<p class="error">${esc(m)}</p>`; }

  function renderBundle(bundle) {
    lastBundle  = bundle;
    var rows    = opts.items ? opts.items(bundle) : entries(bundle);
    var total   = bundle.total !== undefined ? bundle.total : '?';
    var nextUrl = bundleLink(bundle, 'next');
    var prevUrl = bundleLink(bundle, 'previous');
    var body    = opts.renderData
      ? opts.renderData(rows, bundle)
      : (rows.length ? rows.map(opts.renderItem).join('') : `<p>${opts.emptyText || 'No records found.'}</p>`);

    dataEl().innerHTML = body +
      `<div class="pager">` +
        `<span class="pager-info">Showing ${rows.length} of ${total}</span>` +
        `<div class="pager-btns">` +
          `<button class="btn btn-sm btn-outline" id="${id('prev')}"${prevUrl ? '' : ' disabled'}>← Prev</button>` +
          `<button class="btn btn-sm btn-outline" id="${id('next')}"${nextUrl ? '' : ' disabled'}>Next →</button>` +
        `</div>` +
      `</div>`;

    if (opts.wireItems) opts.wireItems(dataEl(), rows, reload, reRender);
    document.getElementById(id('prev')).onclick = function() { if (prevUrl) loadUrl(prevUrl); };
    document.getElementById(id('next')).onclick = function() { if (nextUrl) loadUrl(nextUrl); };
  }

  function reRender() { if (lastBundle) renderBundle(lastBundle); }

  function loadQuery() {
    loadingState();
    fhir(opts.query(search, pageSize)).then(renderBundle).catch(function(e) { errorState(e.message); });
  }
  function loadUrl(url) {
    loadingState();
    fhirFull(url).then(renderBundle).catch(function(e) { errorState(e.message); });
  }
  function reload() { loadQuery(); }

  var pageSizeOpts = pageSizes.map(function(n) {
    return `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n} per page</option>`;
  }).join('');

  el.innerHTML =
    `<div class="page-header">` +
      `<h2>${esc(opts.title)}</h2>` +
      `<input type="search" id="${id('search')}" placeholder="${esc(opts.searchPlaceholder || 'Search…')}" style="max-width:240px">` +
      `<select id="${id('pagesize')}" style="width:auto">${pageSizeOpts}</select>` +
      (opts.canNew ? `<button class="btn btn-primary" id="${id('new')}">${esc(opts.newLabel || '+ New')}</button>` : '') +
      (opts.headerExtra || '') +
    `</div>` +
    `<div class="page-tabs">` +
      `<button class="page-tab active" data-tab="${id('data')}">${esc(opts.dataTabLabel || opts.title)}</button>` +
      `<button class="page-tab" data-tab="${id('help')}">? Help</button>` +
    `</div>` +
    `<div id="${id('data')}"></div>` +
    `<div id="${id('help')}" class="help-panel" hidden>${opts.helpHTML || ''}</div>`;

  wirePageTabs(el);

  if (opts.canNew) {
    document.getElementById(id('new')).onclick = function() { opts.onNew(reload); };
  }
  document.getElementById(id('pagesize')).onchange = function() {
    pageSize = parseInt(this.value, 10);
    if (opts.onPageSize) opts.onPageSize(pageSize);
    loadQuery();
  };
  document.getElementById(id('search')).addEventListener('input', function(e) {
    clearTimeout(searchTimer);
    var val = e.target.value.trim();
    searchTimer = setTimeout(function() { search = val; loadQuery(); }, 350);
  });

  if (opts.onChrome) opts.onChrome(el);

  if (opts.preload) { loadingState(); opts.preload().then(loadQuery).catch(function(e) { errorState(e.message); }); }
  else loadQuery();

  return { reload: reload };
}
