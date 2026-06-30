/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

// Static help panel for the Care Teams page. Loaded as a global before
// js/pages/careteams.js (see index.html). Kept separate so the page file
// holds only dynamic rendering logic.
function careTeamsHelpHTML() {
  return `
    <div class="help-section">
      <h4>What is this page?</h4>
      <p>Lists all <strong>FHIR CareTeam</strong> resources. A CareTeam groups practitioners —
      for example, a VHW team under a supervisor covering a catchment area. CareTeams define which
      health workers operate together and who supervises them.</p>
    </div>
    <div class="help-section">
      <h4>CareTeam structure</h4>
      <table>
        <thead><tr><th>Field</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><strong>Name</strong></td><td>Human-readable team name (e.g. "Maseru North VHW Team")</td></tr>
          <tr><td><strong>Status</strong></td><td>active / proposed / inactive</td></tr>
          <tr><td><strong>Member</strong></td><td>Practitioner reference — each row is one team member</td></tr>
          <tr><td><strong>Role</strong></td><td>Member's role within this team (supervisor, community-health-worker, etc.)</td></tr>
          <tr><td><strong>Period</strong></td><td>When this member joined the team</td></tr>
        </tbody>
      </table>
    </div>
    <div class="help-section">
      <h4>Data source</h4>
      <p>Reads from HAPI FHIR: <code>GET /fhir/CareTeam?_count=50</code>.<br>
      The seeded team is <code>team-maseru-north</code> (1 supervisor + 3 VHWs).</p>
    </div>`;
}
