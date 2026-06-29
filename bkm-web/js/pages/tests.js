/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

function renderTests(el) {
  el.innerHTML =
    '<div class="tests-page">' +
      '<div class="tests-toolbar">' +
        '<h2>E2E Integration Tests</h2>' +
        '<button id="run-tests-btn" class="btn btn-primary" onclick="startTests()">▶ Run Tests</button>' +
      '</div>' +
      '<div id="tests-summary" hidden></div>' +
      '<div id="tests-sections"></div>' +
    '</div>';
}

function startTests() {
  var btn      = document.getElementById('run-tests-btn');
  var summary  = document.getElementById('tests-summary');
  var sections = document.getElementById('tests-sections');

  btn.disabled    = true;
  btn.textContent = '⏳ Running…';
  summary.hidden  = true;
  sections.innerHTML = '';

  var currentSection = null;
  var currentList    = null;
  var pass = 0, fail = 0;
  var startTime = Date.now();

  function handleMessage(data) {
    var msg;
    try { msg = JSON.parse(data); } catch(_) { return; }

    if (msg.type === 'section') {
      currentSection = document.createElement('div');
      currentSection.className = 'test-section';
      currentSection.dataset.index = msg.index;

      var hdr = document.createElement('div');
      hdr.className = 'test-section-hdr';
      hdr.innerHTML =
        '<span class="test-sec-num">' + msg.index + '</span>' +
        '<span class="test-sec-title">' + esc(msg.title) + '</span>' +
        '<span class="test-sec-counts"></span>';

      currentList = document.createElement('ul');
      currentList.className = 'test-result-list';

      currentSection.appendChild(hdr);
      currentSection.appendChild(currentList);
      sections.appendChild(currentSection);
      currentSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    } else if (msg.type === 'result') {
      if (!currentList) return;
      var isPas = msg.status === 'pass';
      if (isPas) pass++; else fail++;

      var li = document.createElement('li');
      li.className = 'test-result ' + (isPas ? 'test-pass' : 'test-fail');
      li.innerHTML =
        '<span class="test-icon">' + (isPas ? '✓' : '✗') + '</span>' +
        '<span class="test-name">' + esc(msg.name) + '</span>' +
        (msg.detail ? '<span class="test-detail">' + esc(msg.detail) + '</span>' : '');
      currentList.appendChild(li);

      var countsEl = currentSection.querySelector('.test-sec-counts');
      var secPass  = currentSection.querySelectorAll('.test-pass').length;
      var secFail  = currentSection.querySelectorAll('.test-fail').length;
      countsEl.innerHTML =
        (secFail === 0
          ? '<span class="badge-pass">' + secPass + ' passed</span>'
          : '<span class="badge-fail">' + secFail + ' failed</span>' +
            (secPass > 0 ? ' <span class="badge-pass">' + secPass + ' passed</span>' : ''));

    } else if (msg.type === 'done' || msg.type === 'error') {
      var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      var total   = msg.type === 'done' ? msg.total : pass + fail;
      var allPass = fail === 0;

      summary.hidden = false;
      summary.className = 'tests-summary ' + (allPass ? 'summary-pass' : 'summary-fail');
      summary.innerHTML =
        '<strong>' + (allPass ? '✓ All tests passed' : '✗ ' + fail + ' test(s) failed') + '</strong>' +
        ' &nbsp;·&nbsp; ' + pass + '/' + total + ' passed' +
        ' &nbsp;·&nbsp; ' + elapsed + 's' +
        (msg.type === 'error' ? ' &nbsp;·&nbsp; <em>Error: ' + esc(msg.message) + '</em>' : '');
      summary.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      btn.disabled    = false;
      btn.textContent = '▶ Run Tests';
    }
  }

  mediatorFetch('test/run')
    .then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var reader  = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer  = '';

      function pump() {
        return reader.read().then(function(result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function(line) {
            if (line.slice(0, 6) === 'data: ') handleMessage(line.slice(6));
          });
          return pump();
        });
      }
      return pump();
    })
    .catch(function(e) {
      btn.disabled    = false;
      btn.textContent = '▶ Run Tests';
      if (sections.children.length === 0) {
        sections.innerHTML =
          '<p class="err">Could not connect to test runner. Is the mediator running?</p>';
      }
    });
}
