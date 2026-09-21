/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

function backupHelpHTML() {
  return (
    '<div class="help-section">' +
      '<h4>What is this page?</h4>' +
      '<p>This installation runs on a <strong>single server</strong>. Everything on the ' +
      '<strong>Backends</strong> page &mdash; the two FHIR nodes, the two OpenSRP nodes, the database ' +
      'standby &mdash; protects against a container dying. None of it protects against losing the ' +
      'machine. Backups are what cover that, so on this deployment the backup is not a precaution, ' +
      'it is the disaster recovery plan.</p>' +
      '<p>The headline figure is the <strong>age of the newest archive</strong>, not whether the last ' +
      'run said it worked. A schedule that quietly stopped firing weeks ago still leaves a status ' +
      'saying "ok"; the age is what catches it.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>What is in an archive</h4>' +
      '<table role="grid">' +
        '<thead><tr><th>Source</th><th>Holds</th></tr></thead>' +
        '<tbody>' +
        '<tr><td><code>hapi_fhir</code></td><td>Every patient, stock Observation, and the app ' +
          'configuration Binaries the phones download</td></tr>' +
        '<tr><td><code>keycloak</code></td><td>Every user account and credential</td></tr>' +
        '<tr><td><code>opensrp</code></td><td>Practitioners, teams, assignments</td></tr>' +
        '<tr><td><code>dhis2</code></td><td>Aggregate reporting data</td></tr>' +
        '<tr><td><code>mediator</code></td><td>Order buffer, dispatch history, stock on hand</td></tr>' +
        '<tr><td><code>superset</code></td><td>Analytics dashboards</td></tr>' +
        '<tr><td><code>open_lmis</code></td><td>Facilities, products, stock cards, requisitions</td></tr>' +
        '<tr><td><code>openhim</code></td><td>Channels, clients, transaction log</td></tr>' +
        '<tr><td>config files</td><td>Compose files, <code>config/</code>, mediator mappings</td></tr>' +
        '</tbody>' +
      '</table>' +
      '<p>Databases are <strong>enumerated</strong> when the backup runs, not read from a list in the ' +
      'script. An earlier version of the backup worked from a fixed list and so omitted ' +
      '<code>hapi_fhir</code> and <code>keycloak</code> &mdash; the two databases whose loss would end ' +
      'the deployment &mdash; while reporting success every night.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Getting a copy off the server</h4>' +
      '<p>An archive on the same disk as the database does not survive losing that disk. ' +
      '<strong>Download</strong> writes the archive to whatever machine you are browsing from, which ' +
      'is the simplest way to hold a copy somewhere else.</p>' +
      '<p>Do this on a schedule you will actually keep &mdash; weekly is far better than an intention ' +
      'to do it daily. Keep the downloaded copies as carefully as the server itself: an archive ' +
      'contains every patient record, and the deployment credentials unless ' +
      '<code>BACKUP_INCLUDE_ENV</code> has been set to <code>false</code>.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>The schedule</h4>' +
      '<p>A backup runs automatically at the time shown under the archive table &mdash; 02:00 daily ' +
      'unless it has been changed. <strong>Back up now</strong> runs one immediately without ' +
      'disturbing the schedule; it is worth using before an upgrade or any bulk data change.</p>' +
      '<p>Change the schedule or how many archives are kept in <code>docker-compose.yml</code>:</p>' +
      '<pre>BACKUP_CRON=0 2 * * *   # 02:00 daily\nBACKUP_KEEP=14          # archives retained</pre>' +
      '<p>Old archives are pruned only <em>after</em> a new one has been written and read back, so a ' +
      'failing backup can never delete the last good one.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Restoring</h4>' +
      '<p>There is no restore button, on purpose. A restore overwrites every database in place, and ' +
      'unlike a failed backup it cannot be retried &mdash; whatever it replaced is gone. The same ' +
      'reasoning applies as to promoting the database standby: a dialog only asks a human to be ' +
      'careful, and during an incident people click through.</p>' +
      '<p>On the server, stop the applications first, then restore:</p>' +
      '<pre>docker compose stop hapi-fhir hapi-fhir-2 \\\n  opensrp-server opensrp-server-2 keycloak \\\n  dhis2-web bkm-mediator superset openhim-core\n\ndocker exec -it bkm-backup restore.sh\n\ndocker compose start hapi-fhir hapi-fhir-2 \\\n  opensrp-server opensrp-server-2 keycloak \\\n  dhis2-web bkm-mediator superset openhim-core</pre>' +
      '<p>Run with no argument it lists the archives and asks which one. It verifies the checksum ' +
      'before dropping anything, so a corrupt archive is found while the databases are still there.</p>' +
      '<p>Configuration files from the archive are staged into <code>./backups/restored-config-*</code> ' +
      'rather than written back over the live tree &mdash; the config in an old archive may be older ' +
      'than the code now deployed.</p>' +
    '</div>' +

    '<div class="help-section">' +
      '<h4>Test the restore, not just the backup</h4>' +
      '<p>A backup that has never been restored is a hypothesis. There is a drill that turns it into ' +
      'a fact, and it is safe to run on a live server &mdash; it restores into a scratch database, ' +
      'counts what arrived and drops it again, touching nothing else:</p>' +
      '<pre>make backup-verify</pre>' +
      '<p>Run it after the first backup and occasionally thereafter, the same way as ' +
      '<code>make ha-drill</code>. A dump that restores into an empty database looks identical to a ' +
      'good one until the day you need it. Full procedure in ' +
      '<code>docs/backup-and-restore.md</code>.</p>' +
    '</div>'
  );
}
