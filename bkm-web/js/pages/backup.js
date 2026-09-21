/*
 * NEC XON (c) Copyright 2025.
 *
 * Backup page - how old the newest backup is, what is in it, and a button to
 * take one now.
 *
 * The headline number is the AGE of the newest archive, not whether the last
 * run reported success. A schedule that silently stopped firing three weeks ago
 * leaves a status file that still says "ok", and the age is the only figure
 * that catches that.
 *
 * Restoring is not on this page on purpose. See the Help tab.
 */
'use strict';

var _backupTimer = null;
var _backupTab = 'backup-data';

function _bkBytes(n) {
  if (!n) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(n) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function _bkAge(hours) {
  if (hours === null || hours === undefined) return 'never';
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' min ago';
  if (hours < 48) return Math.round(hours) + ' hours ago';
  return Math.round(hours / 24) + ' days ago';
}

function _bkBanner(d) {
  var map = {
    ok:   ['#2e7d32', 'Backed up', ''],
    warn: ['#ef6c00', 'Needs attention', ''],
    down: ['#c62828', 'Not protected', ''],
  };
  var m = map[d.health] || map.down;
  var headline = d.newest
    ? 'Newest backup ' + _bkAge(d.newest.ageHours) + ' (' + _bkBytes(d.newest.bytes) + ')'
    : 'No backup on this server';
  return '<div style="border-left:4px solid ' + m[0] + ';background:#fafafa;padding:12px 16px;margin-bottom:18px">' +
         '<strong style="color:' + m[0] + '">' + m[1] + '</strong> &mdash; ' + headline +
         (d.detail ? '<br><small>' + d.detail + '</small>' : '') +
         '</div>';
}

/* One server means the backup is the entire disaster recovery plan, and a copy
 * on the same disk as the database is not a copy. This says so every time the
 * page is opened rather than once in a document nobody rereads. */
function _bkOffsiteNote() {
  return '<div style="border:1px solid #ef6c00;background:#fff8f0;padding:12px 16px;margin:16px 0">' +
    '<strong style="color:#ef6c00">These archives are on the same server as the data</strong>' +
    '<p style="margin:6px 0 0"><small>They protect against a bad deployment, a wrong delete or a ' +
    'corrupted database. They do <strong>not</strong> protect against losing the machine, which on a ' +
    'single-server installation is the failure that ends the deployment. Download the newest archive ' +
    'to somewhere else - a laptop, a USB disk, a cloud drive - on a regular basis.</small></p>' +
    '<p style="margin:6px 0 0"><small>An archive holds every patient record and, unless ' +
    '<code>BACKUP_INCLUDE_ENV</code> is set to false, the deployment credentials. Keep a downloaded ' +
    'copy as carefully as you keep the server.</small></p>' +
    '</div>';
}

function runBackupNow() {
  var btn = document.getElementById('bk-run');
  var out = document.getElementById('bk-run-out');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  out.innerHTML = '<small>Asking the backup engine…</small>';

  mediatorFetch('backup/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
    .then(function(r) { return r.json().then(function(b) { return { ok: r.ok, body: b }; }); })
    .then(function(r) {
      if (!r.ok) {
        out.innerHTML = '<small style="color:#c62828">' +
          (r.body.error || 'could not start') +
          (r.body.detail ? ' &mdash; ' + r.body.detail : '') + '</small>';
        btn.disabled = false;
        btn.textContent = 'Back up now';
        return;
      }
      out.innerHTML = '<small>Running. A large database can take several minutes; ' +
                      'this page updates on its own.</small>';
    })
    .catch(function(e) {
      out.innerHTML = '<small style="color:#c62828">' + e.message + '</small>';
      btn.disabled = false;
      btn.textContent = 'Back up now';
    });
}

function renderBackup(el) {
  function paint(d) {
    if (!d.engineUp) {
      el.innerHTML =
        '<h2>Backup</h2>' +
        '<div style="border-left:4px solid #c62828;background:#fafafa;padding:12px 16px">' +
        '<strong style="color:#c62828">The backup engine is not running</strong>' +
        '<p><small>' + (d.detail || '') + '</small></p>' +
        '<p><small>Start it with <code>docker compose up -d bkm-backup</code>.</small></p></div>';
      return;
    }

    var rows = d.archives.map(function(a) {
      return '<tr>' +
        '<td>' + new Date(a.createdAt).toLocaleString() + '</td>' +
        '<td>' + _bkAge(a.ageHours) + '</td>' +
        '<td>' + _bkBytes(a.bytes) + '</td>' +
        '<td><a href="/mediator-api/backup/download/' + a.name + '">Download</a></td>' +
        '<td><a href="/mediator-api/backup/manifest/' + a.name + '" target="_blank">Contents</a></td>' +
        '</tr>';
    }).join('');

    if (!rows) {
      rows = '<tr><td colspan="5"><small>No archives yet. The first scheduled run will create one, ' +
             'or press <strong>Back up now</strong>.</small></td></tr>';
    }

    var last = d.last || {};

    // "pending" is a request the engine has not picked up yet. Without it the
    // 10s repaint would re-enable the button during that gap and invite a
    // second click on a backup that is about to start.
    var busy = d.running || d.pending;
    var busyNote = d.running
      ? '<small>Started ' + new Date(last.startedAt).toLocaleTimeString() +
        '. This page updates on its own.</small>'
      : (d.pending ? '<small>Requested. Starting within a few seconds…</small>' : '');

    var runBox =
      '<div style="margin:16px 0">' +
      '<button id="bk-run"' + (busy ? ' disabled' : '') + ' onclick="runBackupNow()">' +
      (busy ? 'Backup running…' : 'Back up now') + '</button>' +
      '<span id="bk-run-out" style="margin-left:12px">' + busyNote + '</span></div>';

    var lastRunNote = '';
    if (last.state === 'failed' && !busy) {
      lastRunNote = '<div style="border:1px solid #c62828;background:#fdf1f1;padding:10px 14px;margin:12px 0">' +
        '<strong style="color:#c62828">The last run did not complete</strong><br>' +
        '<small>' + (last.error || last.warnings || 'no reason recorded') + '</small>' +
        '<p style="margin:6px 0 0"><small>The full log is <code>./backups/backup.log</code> on the server.' +
        '</small></p></div>';
    }

    el.innerHTML =
      '<h2>Backup</h2>' +
      '<div class="page-tabs">' +
        '<button class="page-tab active" data-tab="backup-data">Status</button>' +
        '<button class="page-tab" data-tab="backup-help">? Help</button>' +
      '</div>' +
      '<div id="backup-data">' +
      _bkBanner(d) +
      lastRunNote +
      runBox +
      _bkOffsiteNote() +
      '<h3>Archives</h3>' +
      '<p><small>Every database on both PostgreSQL servers, the OpenHIM MongoDB, and the ' +
      'configuration files needed to rebuild the stack. Databases are enumerated at backup time, ' +
      'so a new one cannot quietly fall out of the set.</small></p>' +
      '<table role="grid"><thead><tr><th>Taken</th><th>Age</th><th>Size</th><th></th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p><small>' +
      (d.schedule ? 'Schedule <code>' + d.schedule + '</code> (server time). ' : '') +
      (d.keep ? 'Keeping the newest ' + d.keep + '. ' : '') +
      'Using ' + _bkBytes(d.totalBytes) + ' in <code>./backups</code>. ' +
      'Flagged as stale after ' + d.staleAfterHours + ' hours.' +
      '</small></p>' +
      '<p><small>Restoring is a command line operation, deliberately &mdash; see the Help tab. ' +
      'Full procedure: <code>docs/backup-and-restore.md</code>.</small></p>' +
      '</div>' +
      '<div id="backup-help" class="help-panel" hidden>' + backupHelpHTML() + '</div>';

    // Re-bound on every repaint, because the refresh replaces this markup.
    el.querySelectorAll('.page-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        el.querySelectorAll('.page-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var target = tab.getAttribute('data-tab');
        _backupTab = target;
        document.getElementById('backup-data').hidden = (target !== 'backup-data');
        document.getElementById('backup-help').hidden = (target !== 'backup-help');
      });
    });

    if (_backupTab === 'backup-help') {
      el.querySelector('[data-tab="backup-help"]').click();
    }
  }

  function tick() {
    mediatorFetch('backup/status')
      .then(function(r) { return r.json(); })
      .then(paint)
      .catch(function(e) {
        el.innerHTML = '<h2>Backup</h2><p style="color:#c62828">Could not read backup status: ' +
          e.message + '</p>';
      });
  }

  tick();
  if (_backupTimer) clearInterval(_backupTimer);
  // 10s rather than the Backends page's 15s: this page is mostly watched while
  // a run is in progress, and a stale "running" button is the thing people
  // click twice.
  _backupTimer = setInterval(function() {
    if (location.hash.indexOf('#/backup') !== 0) {
      clearInterval(_backupTimer);
      _backupTimer = null;
      return;
    }
    tick();
  }, 10000);
}
