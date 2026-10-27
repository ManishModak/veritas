/**
 * Veritas UI - Vanilla Application Controller
 * Strict compliance with M4 UI brief and API contract.
 */
(function() {
  'use strict';

  // State Store
  const state = {
    currentRoute: '',
    currentCaseId: null,
    revealRoles: false,
    cohortData: null,
    caseData: null,
    selectedSampleIndex: 0,
    activeSse: null,
    activeJobId: null,
    sseCompletedStages: 0,
    feedbackCache: new Map(), // memoryId -> { kind, confidence }
    activeDrawerEid: null,
    requestVersion: 0,
    drawerRequest: 0,
    completedStageKeys: new Set(),
    runStatuses: {},
    activeJobCaseId: null,
  };

  // Safe HTML Escaping (untusted model & MD&A text)
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Parse and link evidence tokens (e.g. E1, E13, E28) into interactive buttons
  function linkEvidence(text, caseId) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    return escaped.replace(/\bE([1-9]\d*)\b/g, (match, num) => {
      return '<button type="button" class="ev-link"' + (caseId ? ' data-case-id="' + escapeHtml(caseId) + '"' : '') + ' data-eid="E' + num + '" title="Inspect evidence E' + num + '">E' + num + '</button>';
    });
  }

  // Format agreement labels: "N of 3 runs: <label>"
  function renderAgreementChips(agreementObj, totalSamples = 3) {
    if (!agreementObj || typeof agreementObj !== 'object') return '<span class="text-muted">None recorded</span>';
    const entries = Object.entries(agreementObj);
    if (entries.length === 0) return '<span class="text-muted">None recorded</span>';
    
    return entries.map(([label, count]) => {
      let badgeClass = 'chip-unverified';
      const lower = label.toLowerCase();
      if (lower === 'explanation fits the numbers') {
        badgeClass = 'chip-fit';
      } else if (lower === 'explanation does not fit the numbers') {
        badgeClass = 'chip-contradicted';
      }
      // Display "explanation X the numbers" as just "X"; other labels render as supplied.
      const short = label.replace(/^explanation\s+/i, '').replace(/\s+the numbers$/i, '');
      return '<span class="chip ' + badgeClass + '" title="' + escapeHtml(label) + '">' +
        '<span class="chip-count">' + count + '/' + totalSamples + '</span> ' +
        escapeHtml(short) +
        '</span>';
    }).join(' ');
  }

  // Global Alert Banner
  function showBanner(message, isError = false) {
    const banner = document.getElementById('global-banner');
    const msgEl = document.getElementById('banner-message');
    if (!banner || !msgEl) return;
    msgEl.textContent = message;
    banner.classList.remove('hidden');
    if (isError) {
      banner.classList.add('banner-error');
    } else {
      banner.classList.remove('banner-error');
    }
  }

  function hideBanner() {
    const banner = document.getElementById('global-banner');
    if (banner) banner.classList.add('hidden');
  }

  // API Fetch Helper
  async function apiFetch(endpoint, options = {}) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          'Accept': 'application/json',
          ...(options.headers || {})
        },
        ...options
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errorMsg = data && data.error ? data.error : ('Request failed with status ' + res.status);
        throw new Error(errorMsg);
      }
      return data;
    } catch (err) {
      console.error('API Error (' + endpoint + '):', err);
      throw err;
    }
  }

  // View Navigation
  function showView(viewId) {
    document.querySelectorAll('.view-section').forEach(el => {
      if (el.id === viewId) {
        el.classList.add('active');
        el.classList.remove('hidden');
      } else {
        el.classList.remove('active');
        el.classList.add('hidden');
      }
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // Router
  async function handleRoute() {
    state.requestVersion++;
    const hash = window.location.hash || '#/';
    state.currentRoute = hash;

    // Reset drawer if route changes
    closeEvidenceDrawer();

    if (hash === '#/' || hash === '#' || hash === '') {
      await loadCohort();
    } else if (hash.startsWith('#/case/')) {
      const caseId = hash.slice('#/case/'.length).trim();
      if (!/^\d+_\d{4}-\d{2}-\d{2}$/.test(caseId)) {
        renderNotFound('Invalid case format: ' + caseId + '. Please select a valid case from the cohort.');
      } else {
        await loadCase(caseId);
      }
    } else {
      renderNotFound('Page not found.');
    }
  }

  // ----------------------------------------------------
  // COHORT VIEW
  // ----------------------------------------------------
  async function loadCohort() {
    state.currentCaseId=null;
    const requestVersion = ++state.requestVersion;
    showView('view-cohort');
    hideBanner();
    const tbody = document.getElementById('cohort-tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center loading-cell"><span class="spinner" aria-hidden="true"></span> Loading cohort from server...</td></tr>';
    }

    try {
      const url = '/api/cases' + (state.revealRoles ? '?reveal=true' : '');
      const data = await apiFetch(url);
      if(requestVersion !== state.requestVersion) return;
      state.cohortData = data;
      renderCohort(data);
    } catch (err) {
      if(requestVersion !== state.requestVersion) return;
      showBanner('Unable to load cohort data: ' + err.message, true);
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center loading-cell text-muted">Failed to load cohort. ' + escapeHtml(err.message) + '</td></tr>';
      }
    }
  }

  function renderCohort(data) {
    // Header badges
    const modeBadge = document.getElementById('mode-badge');
    if (modeBadge) {
      modeBadge.textContent = data.mode === 'live' ? 'Live Mode' : 'Recorded runs';
    }
    const dataModeBadge = document.getElementById('datamode-badge');
    if (dataModeBadge) {
      dataModeBadge.textContent = (data.dataMode || 'CSV').toUpperCase();
    }

    // Results honest strip
    const res = data.results || {};
    const callsEl = document.getElementById('res-calls');
    if (callsEl) callsEl.textContent = res.calls !== undefined ? res.calls : 99;
    
    const unkEl = document.getElementById('res-unknown');
    if (unkEl) unkEl.textContent = res.unknownIds !== undefined ? res.unknownIds : 0;

    const fraudEl = document.getElementById('res-blind-fraud');
    if (fraudEl && res.blindFraud) {
      fraudEl.textContent = res.blindFraud.majorityDoesNotFit + ' / ' + res.blindFraud.total;
    }

    const peersEl = document.getElementById('res-blind-peers');
    if (peersEl && res.blindPeers) {
      peersEl.textContent = res.blindPeers.majorityDoesNotFit + ' / ' + res.blindPeers.total;
    }

    // Revealed role column toggle
    const thRole = document.getElementById('th-role');
    const revealBtn = document.getElementById('btn-toggle-reveal');
    const revealBtnText = document.getElementById('reveal-btn-text');

    if (state.revealRoles) {
      if (thRole) thRole.classList.remove('hidden');
      if (revealBtn) revealBtn.setAttribute('aria-pressed', 'true');
      if (revealBtnText) revealBtnText.textContent = 'Hide SEC cases';
    } else {
      if (thRole) thRole.classList.add('hidden');
      if (revealBtn) revealBtn.setAttribute('aria-pressed', 'false');
      if (revealBtnText) revealBtnText.textContent = 'Reveal which had SEC cases';
    }

    // Render Table Rows
    const tbody = document.getElementById('cohort-tbody');
    if (!tbody) return;

    if (!data.cases || data.cases.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center loading-cell">No cases available.</td></tr>';
      return;
    }

    // Added companies first, then the hero case, then the cohort alphabetically.
    const rank=c=>c.split==='added'?0:c.id==='1336917_2015-12-31'?1:2;
    const ordered=[...data.cases].sort((a,b)=>rank(a)-rank(b)||a.company.localeCompare(b.company)||a.fyEnd.localeCompare(b.fyEnd));
    tbody.innerHTML = ordered.map(c => {
      const splitBadge = c.split === 'development'
        ? '<span class="badge badge-split-dev">Tuning</span>'
        : c.split === 'added' ? '<span class="badge badge-split-added">Added</span>'
        : '<span class="badge badge-split-blind">Blind</span>';

      let roleCell = '';
      if (state.revealRoles) {
        let roleBadge = '<span class="badge badge-role-peer">Comparison peer</span>';
        if (c.role === 'fraud') {
          roleBadge = '<span class="badge badge-role-fraud">SEC case</span>';
        }
        roleCell = '<td>' + roleBadge + '</td>';
      }

      // Industry: Blank in CSV, show Zetaris only
      const industryText = c.industry ? escapeHtml(c.industry) : '<span class="text-muted">' + escapeHtml(c.industryLabel || 'Zetaris only') + '</span>';

      // Beneish score & flag
      let beneishBadge = '';
      if (c.beneish) {
        if (c.beneish.flagged === true) {
          beneishBadge = '<span class="badge badge-flagged">Flagged</span>';
        } else if (c.beneish.flagged === false) {
          beneishBadge = '<span class="badge badge-safe">Not Flagged</span>';
        }
      }

      const notRun = '<span class="text-muted">Not run yet</span>';
      const invChips = c.agreement ? renderAgreementChips(c.agreement.investigator, c.samples || 3) : notRun;
      const judgeChips = c.agreement ? renderAgreementChips(c.agreement.judge, c.samples || 3) : notRun;

      return '<tr data-case-id="' + escapeHtml(c.id) + '">' +
        '<td>' +
          '<a href="#/case/' + encodeURIComponent(c.id) + '" class="company-cell-name">' + escapeHtml(c.company) + '</a>' +
          '<span class="company-cell-meta">FY ended ' + escapeHtml(c.fyEnd) + ' &bull; Filed ' + escapeHtml(c.filed || '') + '</span>' +
          (c.liveAvailable?'<span class="badge badge-split-dev">New live analysis available</span>':'')+
        '</td>' +
        '<td>' + splitBadge + '</td>' +
        roleCell +
        '<td>' + industryText + '</td>' +
        '<td>' +
          '<div class="beneish-cell">' +
            '<span class="beneish-score">M = ' + escapeHtml(c.beneish ? c.beneish.score : 'N/A') + '</span>' +
            beneishBadge +
            '<span class="beneish-sub" title="Beneish M-Score is a screening metric, not a fraud verdict">Screening index</span>' +
          '</div>' +
        '</td>' +
        '<td><div class="chips-group">' + invChips + '</div></td>' +
        '<td><div class="chips-group">' + judgeChips + '</div></td>' +
        '<td class="col-question"><p class="question-text" title="' + escapeHtml(c.topQuestion || '') + '">' + linkEvidence(c.topQuestion || (c.agreement ? 'No question recorded' : '—'), c.id) + '</p></td>' +
        '<td><a href="#/case/' + encodeURIComponent(c.id) + '" class="btn btn-outline" style="padding: 0.35rem 0.65rem; font-size: 0.78rem;">Inspect</a></td>' +
      '</tr>';
    }).join('');
  }

  // ----------------------------------------------------
  // CASE DETAIL VIEW
  // ----------------------------------------------------
  async function loadCase(caseId) {
    const requestVersion = ++state.requestVersion;
    showView('view-case');
    hideBanner();
    state.currentCaseId = caseId;
    state.selectedSampleIndex = 0;

    const heading = document.getElementById('case-heading');
    if (heading) heading.textContent = 'Loading Case ' + caseId + '...';

    try {
      const data = await apiFetch('/api/cases/' + encodeURIComponent(caseId));
      if(requestVersion !== state.requestVersion) return;
      state.caseData = data;
      renderCase(data);
    } catch (err) {
      if(requestVersion !== state.requestVersion) return;
      if (err.message && err.message.includes('404')) {
        renderNotFound(err.message);
      } else {
        showBanner('Error loading case detail: ' + err.message, true);
        renderNotFound('Unable to load case ' + caseId + ': ' + err.message);
      }
    }
  }

  function renderCase(data) {
    const run = data.run || {};
    const filing = data.filing || {};
    let savedJob=null;
    try{savedJob=JSON.parse(sessionStorage.getItem('veritas-live-job')||'null');}catch{}
    const liveJob=Object.hasOwn(data,'liveJob')?data.liveJob:(savedJob?.caseId===data.id&&/^\/api\/runs\/[a-f0-9-]+\/events$/.test(savedJob.eventsUrl)?savedJob:null);
    if(Object.hasOwn(data,'liveJob')&&!data.liveJob){try{sessionStorage.removeItem('veritas-live-job');}catch{}}

    // Header title and metadata
    const heading = document.getElementById('case-heading');
    if (heading) heading.textContent = (data.filing ? data.filing.company : run.company) + ' · FY' + (data.filing ? data.filing.fyEnd.slice(0, 4) : '');
    document.getElementById('mode-badge').textContent = data.mode === 'live' ? 'Live enabled' : 'Recorded runs';
    document.getElementById('datamode-badge').textContent = data.dataMode.toUpperCase();
    const question=(run.samples||[]).flatMap(s=>s.investigator.questions_for_management||[]);
    const leadQuestion=question[0]||'';
    document.getElementById('case-key-question').innerHTML='<strong>Question for management:</strong> '+linkEvidence(leadQuestion);

    const metaRow = document.getElementById('case-meta-row');
    if (metaRow) {
      const edgarLink = filing.url
        ? '<a href="' + escapeHtml(filing.url) + '" target="_blank" rel="noopener noreferrer" class="case-meta-value">' + escapeHtml(filing.accn || 'SEC Link') + ' &UpperRightArrow;</a>'
        : '<span class="case-meta-value">' + escapeHtml(filing.accn || 'N/A') + '</span>';

      metaRow.innerHTML =
        '<span class="case-meta-item"><span class="case-meta-label">CIK:</span> <span class="case-meta-value">' + escapeHtml(filing.cik || run.cik) + '</span></span>' +
        '<span class="case-meta-item"><span class="case-meta-label">FY Ended:</span> <span class="case-meta-value">' + escapeHtml(filing.fyEnd || run.fy_end) + '</span></span>' +
        '<span class="case-meta-item"><span class="case-meta-label">Filed Date:</span> <span class="case-meta-value">' + escapeHtml(filing.filed || 'N/A') + '</span></span>' +
        '<span class="case-meta-item"><span class="case-meta-label">SEC Accession:</span> ' + edgarLink + '</span>';
    }

    const badgesContainer = document.getElementById('case-header-badges');
    if (badgesContainer) {
      const splitBadge = data.split === 'development'
        ? '<span class="badge badge-split-dev">Used for prompt tuning</span>'
        : data.split === 'added' ? '<span class="badge badge-split-added">Added from SEC EDGAR</span>'
        : '<span class="badge badge-split-blind">Blind</span>';
      const modeBadge = data.resultMode === 'live'
        ? '<span class="badge badge-mode">Live runs</span>'
        : data.resultMode === 'none' ? '<span class="badge badge-mode">Not run</span>'
        : '<span class="badge badge-mode">Recorded</span>';
      const dataModeBadge = '<span class="badge badge-datamode">' + escapeHtml((data.dataMode || 'csv').toUpperCase()) + '</span>';
      // Which provider and model answered the shown live run (recorded from each Nightshift receipt).
      const viaBadge = data.run && data.run.provider === 'meterless-nightshift'
        ? ' <span class="badge badge-datamode" title="Every model request in this run went through Meterless Nightshift">' + escapeHtml(String(data.run.model || '').replace(/^nvidia\//, '')) + ' · via Meterless Nightshift</span>'
        : '';
      badgesContainer.innerHTML = splitBadge + ' ' + modeBadge + ' ' + dataModeBadge + viaBadge;
    }

    // Live Run button & hints
    const btnLive = document.getElementById('btn-run-live');
    const liveHint = document.getElementById('live-hint');
    if (btnLive) {
      btnLive.disabled = !data.liveEnabled || Boolean(liveJob);
    }
    if (liveHint) {
      if (!data.liveEnabled) {
        liveHint.textContent = data.liveUnavailableReason || 'Live run disabled on server.';
      } else if(liveJob) {
        liveHint.textContent='A live case is running. Its progress survives navigation and reload.';
      } else {
        liveHint.textContent = data.liveVia === 'meterless-nightshift' ? 'Runs the debate 3 times (9 Nemotron calls through Meterless Nightshift)' : 'Runs the debate 3 times (9 Nemotron calls)';
      }
    }
    const progressCard=document.getElementById('live-progress-card');
    if(liveJob?.caseId===data.id){
      progressCard.classList.remove('hidden');
      if(state.activeJobId!==liveJob.id){
        state.activeJobId=liveJob.id;state.activeJobCaseId=data.id;state.completedStageKeys=new Set();state.sseCompletedStages=0;state.runStatuses={};
        document.getElementById('live-status-text').textContent='Live run in progress';
        initEventSource(liveJob.eventsUrl,data.id);
      }
    }else progressCard.classList.add('hidden');

    // Before an added company's first run there are no findings: show the evidence count and the next step.
    const notRun = !data.run;
    ['.agreement-card', '.findings-section', '.inquiry-grid'].forEach(sel => document.querySelector('#view-case ' + sel)?.classList.toggle('hidden', notRun));
    document.getElementById('case-key-question').classList.toggle('hidden', notRun);
    document.getElementById('not-run-card').classList.toggle('hidden', !notRun);
    if (notRun) document.getElementById('not-run-text').textContent = 'Veritas pulled ' + data.evidenceCount + ' evidence items from this company\'s SEC filings: the numbers below and its MD&A.' +
      (data.liveEnabled ? ' Click "Run live" to check its growth story. It takes a few minutes.' : '');

    // Agreement Chips (Headline)
    const invChipsContainer = document.getElementById('headline-investigator-chips');
    if (invChipsContainer) {
      invChipsContainer.innerHTML = renderAgreementChips(run.agreement ? run.agreement.investigator : null, (run.samples ? run.samples.length : 3));
    }
    const judgeChipsContainer = document.getElementById('headline-judge-chips');
    if (judgeChipsContainer) {
      judgeChipsContainer.innerHTML = renderAgreementChips(run.agreement ? run.agreement.judge : null, (run.samples ? run.samples.length : 3));
    }

    // Four-Quarter Comparison
    renderQuarterComparison(data);

    // Sample Tabs & Findings
    setupSampleTabs(run.samples || []);
    renderSelectedSample();

    // Memory / Seen Before
    renderMemorySection(data.memory, data.id);
  }

  // ----------------------------------------------------
  // FOUR-QUARTER COMPARISON
  // ----------------------------------------------------
  function renderQuarterComparison(data) {
    const chartContainer = document.getElementById('quarter-chart-container');
    const tableContainer = document.getElementById('quarter-table-container');
    const heroNote = document.getElementById('quarter-hero-note');
    const quarters = data.quarterComparison || [];

    if (!quarters || quarters.length === 0) {
      if (chartContainer) chartContainer.innerHTML = '<div class="empty-state">Quarterly breakdown data incomplete or unavailable for this case.</div>';
      if (tableContainer) tableContainer.innerHTML = '';
      if (heroNote) heroNote.classList.add('hidden');
      return;
    }

    // Divergence note: the quarter where receivables outgrew revenue the most (15+ points),
    // with each sample's first question that names that quarter.
    if (heroNote) {
      const gap = q => q.receivablesGrowth - q.revenueGrowth;
      const top = quarters.reduce((a, q) => (gap(q) > gap(a) ? q : a));
      if (gap(top) >= 15) {
        const samples = (data.run && data.run.samples) || [];
        const named = new RegExp('\\bQ' + top.quarter + '\\b');
        const asked = samples.map((s, i) => [i + 1, (s.investigator.questions_for_management || []).find(q => named.test(q))]).filter(([, q]) => q);
        heroNote.classList.remove('hidden');
        heroNote.innerHTML = '<strong>Where receivables outran revenue:</strong> in Q' + top.quarter + ' receivables grew ' + top.receivablesGrowth.toFixed(1) + '% while revenue grew ' + top.revenueGrowth.toFixed(1) + '%. DSO moved from ' + Math.round(top.dsoPrior) + ' to ' + Math.round(top.dsoCurrent) + ' days. ' + linkEvidence(top.evidenceId) +
          (asked.length ? '<br>' + asked.length + ' of ' + samples.length + ' runs asked about Q' + top.quarter + ':<ul>' + asked.map(([n, q]) => '<li>Run ' + n + ': ' + linkEvidence(q) + '</li>').join('') + '</ul>' : '');
      } else {
        heroNote.classList.add('hidden');
      }
    }

    // Max growth rate for scaling the bar chart
    let maxGrowth = 1, minGrowth = 0;
    quarters.forEach(q => {
      if (q.revenueGrowth > maxGrowth) maxGrowth = q.revenueGrowth;
      if (q.receivablesGrowth > maxGrowth) maxGrowth = q.receivablesGrowth;
      minGrowth=Math.min(minGrowth,q.revenueGrowth,q.receivablesGrowth);
    });
    maxGrowth = Math.ceil(maxGrowth * 1.15); // headroom
    minGrowth=Math.floor(minGrowth*1.15);
    const y=value=>20+(maxGrowth-value)/(maxGrowth-minGrowth)*120;
    const zero=y(0), percent=value=>(value>=0?'+':'')+value.toFixed(1)+'%';

    // Chart HTML
    let chartHtml = '<div class="chart-legend">' +
      '<span class="legend-item"><span class="legend-box legend-revenue"></span> YoY Revenue Growth (%)</span>' +
      '<span class="legend-item"><span class="legend-box legend-receivables"></span> YoY Receivables Growth (%)</span>' +
    '</div>';

    chartHtml += '<div class="chart-bars-grid">';
    quarters.forEach(q => {
      const bar=(value,x,color)=>{
        const top=Math.min(y(value),zero),height=Math.abs(y(value)-zero),labelY=value>=0?top-7:top+height+15;
        return '<rect x="'+x+'" y="'+top+'" width="28" height="'+Math.max(height,0.5)+'" fill="'+color+'"/><text x="'+(x+14)+'" y="'+labelY+'" text-anchor="middle" font-size="11" fill="#17324D">'+percent(value)+'</text>';
      };

      chartHtml += '<div class="quarter-bar-column" data-eid="' + escapeHtml(q.evidenceId) + '" title="Inspect ' + escapeHtml(q.evidenceId) + ' provenance">' +
        '<svg viewBox="0 0 140 180" width="140" height="180" role="img" aria-label="Revenue growth '+percent(q.revenueGrowth)+', receivables growth '+percent(q.receivablesGrowth)+'"><line x1="8" x2="132" y1="'+zero+'" y2="'+zero+'" stroke="#D8E0E8"/>'+bar(q.revenueGrowth,24,'#236B64')+bar(q.receivablesGrowth,82,'#17324D')+'</svg>'+
        '<span class="bar-col-label">Q' + q.quarter + '</span>' +
        '<span class="bar-col-period">' + escapeHtml(q.period) + '</span>' +
        '<button type="button" class="ev-badge" data-eid="' + escapeHtml(q.evidenceId) + '">' + escapeHtml(q.evidenceId) + '</button>' +
      '</div>';
    });
    chartHtml += '</div>';
    if (chartContainer) chartContainer.innerHTML = chartHtml;

    // Table HTML
    let tableHtml = '<div class="table-responsive"><table class="quarter-table">' +
      '<thead><tr>' +
        '<th>Quarter</th>' +
        '<th>Period End</th>' +
        '<th>Revenue YoY</th>' +
        '<th>Receivables YoY</th>' +
        '<th>Prior DSO</th>' +
        '<th>Current DSO</th>' +
        '<th>Source Evidence</th>' +
      '</tr></thead><tbody>';

    quarters.forEach(q => {
      const revSign = q.revenueGrowth >= 0 ? '+' : '';
      const recSign = q.receivablesGrowth >= 0 ? '+' : '';
      tableHtml += '<tr class="quarter-row-clickable" data-eid="' + escapeHtml(q.evidenceId) + '">' +
        '<td><strong>Fiscal Q' + q.quarter + '</strong></td>' +
        '<td>' + escapeHtml(q.period) + '</td>' +
        '<td><span style="color: var(--teal); font-weight:600;">' + revSign + q.revenueGrowth.toFixed(1) + '%</span></td>' +
        '<td><span style="color: var(--navy); font-weight:600;">' + recSign + q.receivablesGrowth.toFixed(1) + '%</span></td>' +
        '<td>' + Math.round(q.dsoPrior) + ' days</td>' +
        '<td><strong>' + Math.round(q.dsoCurrent) + ' days</strong></td>' +
        '<td><button type="button" class="ev-badge" data-eid="' + escapeHtml(q.evidenceId) + '">' + escapeHtml(q.evidenceId) + '</button></td>' +
      '</tr>';
    });

    tableHtml += '</tbody></table></div>';
    if (tableContainer) tableContainer.innerHTML = tableHtml;
  }

  // ----------------------------------------------------
  // SAMPLE TABS & FINDINGS SCORECARD
  // ----------------------------------------------------
  function setupSampleTabs(samples) {
    const tabsContainer = document.getElementById('sample-tabs');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = samples.map((s, idx) => {
      const activeClass = idx === state.selectedSampleIndex ? 'active' : '';
      const selected = idx === state.selectedSampleIndex ? 'true' : 'false';
      return '<button type="button" class="tab-btn ' + activeClass + '" role="tab" aria-selected="' + selected + '" id="tab-sample-' + idx + '" data-sample="' + idx + '">Run ' + (idx + 1) + '</button>';
    }).join('');

    tabsContainer.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sampleIdx = Number(btn.getAttribute('data-sample'));
        if (state.selectedSampleIndex !== sampleIdx) {
          state.selectedSampleIndex = sampleIdx;
          tabsContainer.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
          });
          btn.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
          renderSelectedSample();
        }
      });
    });
  }

  function renderSelectedSample() {
    const run = (state.caseData && state.caseData.run) || {};
    const samples = run.samples || [];
    const sampleIndex = state.selectedSampleIndex;
    const sample = samples[sampleIndex];
    const container = document.getElementById('findings-container');

    if (!container) return;
    if (!sample) {
      container.innerHTML = '<div class="empty-state">No data for Run ' + (sampleIndex + 1) + '</div>';
      return;
    }

    const investigator = sample.investigator || {};
    const redTeam = sample.red_team || {};
    const judge = sample.judge || {};
    const findings = investigator.findings || [];
    const findingMemoryIds = state.caseData.findingMemoryIds || [];

    // Render findings list
    if (findings.length === 0) {
      container.innerHTML = '<div class="empty-state">No findings recorded in this sample.</div>';
    } else {
      container.innerHTML = findings.map((f, i) => {
        // IMPORTANT: Join red-team and judge strictly by finding_index, never array offset!
        // Investigator findings use their array index in the frozen schema; only replies carry finding_index.
        const findingIdx = i;
        const rebuttal = (redTeam.rebuttals || []).find(r => r.finding_index === findingIdx);
        const ruling = (judge.rulings || []).find(rl => rl.finding_index === findingIdx);

        // Fit Badge
        let fitClass = 'badge-unverified';
        const fitLower = (f.fit || '').toLowerCase();
        if (fitLower === 'fits') {
          fitClass = 'badge-fit';
        } else if (fitLower === 'does not fit') {
          fitClass = 'badge-contradicted';
        }

        // Feedback thumbs: Sample 1 only uses findingMemoryIds[i]
        let feedbackHtml = '';
        if (sampleIndex === 0 && findingMemoryIds[findingIdx]) {
          const memId = findingMemoryIds[findingIdx];
          const cached = state.feedbackCache.get(memId);
          const helpfulActive = cached && cached.kind === 'helpful' ? 'active' : '';
          const notHelpfulActive = cached && cached.kind === 'not_helpful' ? 'active' : '';
          const confText = cached && cached.confidence !== undefined ? '<span class="confidence-tag">Memory trust: ' + cached.confidence.toFixed(2) + '</span>' : '';

          feedbackHtml = '<div class="finding-feedback-bar">' +
            '<span>Useful finding? Your answer is saved to H-MEM.</span>' +
            '<div class="feedback-actions">' +
              confText +
              '<button type="button" class="btn-thumb ' + helpfulActive + '" data-feedback-id="' + escapeHtml(memId) + '" data-kind="helpful" title="Mark finding explanation as helpful">&#x1F44D; Helpful</button>' +
              '<button type="button" class="btn-thumb ' + notHelpfulActive + '" data-feedback-id="' + escapeHtml(memId) + '" data-kind="not_helpful" title="Mark finding explanation as not helpful">&#x1F44E; Not Helpful</button>' +
            '</div>' +
          '</div>';
        }

        // Rebuttal block
        let rebuttalHtml = '<div class="joined-panel panel-red-team">' +
          '<div class="joined-panel-title"><span>Red-team: the innocent explanation</span><span class="badge-mono">' + escapeHtml((rebuttal && rebuttal.support) ? ('support: ' + rebuttal.support) : '') + '</span></div>' +
          '<p class="joined-panel-text">' + (rebuttal ? linkEvidence(rebuttal.innocent_explanation) : '<span class="text-muted">No rebuttal for finding #' + (findingIdx + 1) + '</span>') + '</p>' +
          (rebuttal && rebuttal.evidence ? ('<div class="finding-evidence-row"><span>Cites:</span> ' + rebuttal.evidence.map(e => '<button type="button" class="ev-badge" data-eid="' + escapeHtml(e) + '">' + escapeHtml(e) + '</button>').join(' ') + '</div>') : '') +
        '</div>';

        // Ruling block
        let rulingBadge = '';
        if (ruling && ruling.ruling) {
          let rClass = 'badge-unverified';
          if (ruling.ruling.toLowerCase()==='fits') rClass = 'badge-fit';
          else if (ruling.ruling.toLowerCase()==='does not fit') rClass = 'badge-contradicted';
          rulingBadge = '<span class="badge ' + rClass + '">' + escapeHtml(ruling.ruling) + '</span>';
        }

        let rulingHtml = '<div class="joined-panel panel-judge">' +
          '<div class="joined-panel-title"><span>Judge</span> ' + rulingBadge + '</div>' +
          '<p class="joined-panel-text">' + (ruling ? linkEvidence(ruling.reason) : '<span class="text-muted">No ruling for finding #' + (findingIdx + 1) + '</span>') + '</p>' +
          (ruling && ruling.evidence ? ('<div class="finding-evidence-row"><span>Cites:</span> ' + ruling.evidence.map(e => '<button type="button" class="ev-badge" data-eid="' + escapeHtml(e) + '">' + escapeHtml(e) + '</button>').join(' ') + '</div>') : '') +
        '</div>';

        const findingEvidenceChips = (f.evidence || []).map(eid => '<button type="button" class="ev-badge" data-eid="' + escapeHtml(eid) + '">' + escapeHtml(eid) + '</button>').join(' ');

        return '<article class="finding-card">' +
          '<div class="finding-card-header">' +
            '<span class="finding-index-pill">Finding #' + (findingIdx + 1) + '</span>' +
            '<span class="badge ' + fitClass + ' finding-fit-badge">Investigator: ' + escapeHtml(f.fit || 'unverified') + '</span>' +
          '</div>' +
          '<div class="finding-grid">' +
            '<div class="finding-box">' +
              '<span class="finding-box-label">Management says</span>' +
              '<p class="finding-box-text">' + linkEvidence(f.management_says) + '</p>' +
            '</div>' +
            '<div class="finding-box">' +
              '<span class="finding-box-label">The numbers show</span>' +
              '<p class="finding-box-text">' + linkEvidence(f.numbers_show) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="finding-evidence-row"><span>Cites:</span> ' + findingEvidenceChips + '</div>' +
          '<details class="finding-discussion"><summary>Red-team and judge: '+escapeHtml(ruling?.ruling||'unverified')+'</summary><div class="joined-panels-row">' +
            rebuttalHtml +
            rulingHtml +
          '</div></details>' +
          feedbackHtml +
        '</article>';
      }).join('');
    }

    // Inquiry & Deciding lists
    const qList = document.getElementById('inquiry-questions');
    if (qList) {
      const questions = investigator.questions_for_management || [];
      qList.innerHTML = questions.length
        ? questions.map(q => '<li>' + linkEvidence(q) + '</li>').join('')
        : '<li class="text-muted">No questions recorded for this sample.</li>';
    }

    const cList = document.getElementById('inquiry-change-mind');
    if (cList) {
      const items = investigator.what_would_change_my_mind || [];
      cList.innerHTML = items.length
        ? items.map(it => '<li>' + linkEvidence(it) + '</li>').join('')
        : '<li class="text-muted">No change-of-mind criteria recorded.</li>';
    }

    const decEl = document.getElementById('deciding-evidence-text');
    if (decEl) {
      decEl.innerHTML = judge.deciding_evidence
        ? ('<strong>Decided by:</strong> ' + linkEvidence(judge.deciding_evidence))
        : '<span class="text-muted">No deciding evidence synthesis recorded.</span>';
    }

    const setList = document.getElementById('settle-it-list');
    if (setList) {
      const settleItems = judge.evidence_that_would_settle_it || [];
      setList.innerHTML = settleItems.length
        ? settleItems.map(it => '<li>' + linkEvidence(it) + '</li>').join('')
        : '<li class="text-muted">No settling evidence list recorded.</li>';
    }

    // Attach feedback handlers for thumbs
    container.querySelectorAll('.btn-thumb').forEach(btn => {
      btn.addEventListener('click', () => {
        const memId = btn.getAttribute('data-feedback-id');
        const kind = btn.getAttribute('data-kind');
        if (memId && kind) handleFeedback(memId, kind);
      });
    });
  }

  // ----------------------------------------------------
  // H-MEM RECALL & TRACE VIEW
  // ----------------------------------------------------
  function renderMemorySection(recallData, caseId) {
    recallData = recallData || {};
    const trace = recallData.trace || {};
    const memories = recallData.memories || [];
    document.getElementById('trace-query-detail').textContent=(trace.retrievalReason||'')+'; threshold '+(trace.threshold??'')+'; '+(trace.embedder||'');

    // Trace header & statistics
    const ruleEl = document.getElementById('trace-rule');
    if (ruleEl) ruleEl.textContent = trace.rule || 'Only cases filed before this 10-K';

    const statsGrid = document.getElementById('trace-stats-grid');
    if (statsGrid) {
      statsGrid.innerHTML =
        '<div class="trace-stat-item"><span class="trace-stat-label">Eligible memories</span><span class="trace-stat-value">' + (trace.eligible !== undefined ? trace.eligible : 'N/A') + '</span></div>' +
        '<div class="trace-stat-item"><span class="trace-stat-label">Excluded by date or case</span><span class="trace-stat-value">' + (trace.excluded !== undefined ? trace.excluded : 'N/A') + '</span></div>' +
        '<div class="trace-stat-item"><span class="trace-stat-label">Cutoff Filing Date</span><span class="trace-stat-value">' + escapeHtml(trace.cutoff || 'Current Case Date') + '</span></div>' +
        '<div class="trace-stat-item"><span class="trace-stat-label">Embedder / Strategy</span><span class="trace-stat-value">' + escapeHtml(trace.strategy || 'comprehensive') + '</span></div>';
    }

    // Memories list
    renderMemoriesList(memories);

    // Memory query form
    const form = document.getElementById('memory-query-form');
    const input = document.getElementById('memory-query-input');
    const resetBtn = document.getElementById('btn-memory-reset');

    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        try {
          if (resetBtn) resetBtn.classList.remove('hidden');
          const res = await apiFetch('/api/cases/' + encodeURIComponent(caseId) + '/memory?q=' + encodeURIComponent(q));
          renderMemorySection(res, caseId);
        } catch (err) {
          showBanner('Memory search failed: ' + err.message, true);
        }
      };
    }

    if (resetBtn) {
      resetBtn.onclick = async () => {
        input.value = '';
        resetBtn.classList.add('hidden');
        try {
          const res = await apiFetch('/api/cases/' + encodeURIComponent(caseId) + '/memory');
          renderMemorySection(res, caseId);
        } catch (err) {
          showBanner('Memory reset failed: ' + err.message, true);
        }
      };
    }
  }

  function renderMemoriesList(memories) {
    const listContainer = document.getElementById('memories-list');
    if (!listContainer) return;

    if (!memories || memories.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">No matching memories from earlier-filed cases.</div>';
      return;
    }

    listContainer.innerHTML = memories.map(m => {
      const cached = state.feedbackCache.get(m.memoryId);
      const helpfulActive = cached && cached.kind === 'helpful' ? 'active' : '';
      const notHelpfulActive = cached && cached.kind === 'not_helpful' ? 'active' : '';
      const confScore = (cached && cached.confidence !== undefined) ? cached.confidence : m.confidence;

      return '<div class="memory-item-card">' +
        '<div class="memory-item-header">' +
          '<div class="memory-item-company">' +
            '<a href="#/case/' + encodeURIComponent(m.caseId) + '">' + escapeHtml(m.company) + ' (FY' + escapeHtml(m.fyEnd.slice(0, 4)) + ')</a>' +
          '</div>' +
          '<div class="memory-item-meta">' +
            '<span>Filed ' + escapeHtml(m.filed) + '</span>' +
            '<span class="badge-mono">Score: ' + (m.score !== undefined ? m.score.toFixed(4) : 'N/A') + '</span>' +
            '<span class="badge-mono" style="color: var(--teal);">Memory trust: ' + Number(confScore ?? 1).toFixed(2) + '</span>' +
          '</div>' +
        '</div>' +
        '<p class="memory-item-content">' + linkEvidence(m.content.slice(0,350)+(m.content.length>350?'…':''),m.caseId) + '</p>' +
        '<details class="memory-full"><summary>Full finding and questions</summary><p class="memory-item-content">'+linkEvidence(m.content,m.caseId)+'</p></details>'+
        '<div class="memory-item-footer">' +
          '<span class="text-muted">Memory ID: <code class="code-inline">' + escapeHtml(m.memoryId) + '</code></span>' +
          '<div class="feedback-actions">' +
            '<button type="button" class="btn-thumb ' + helpfulActive + '" data-feedback-id="' + escapeHtml(m.memoryId) + '" data-kind="helpful">&#x1F44D; Helpful</button>' +
            '<button type="button" class="btn-thumb ' + notHelpfulActive + '" data-feedback-id="' + escapeHtml(m.memoryId) + '" data-kind="not_helpful">&#x1F44E; Not Helpful</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    // Attach feedback handlers
    listContainer.querySelectorAll('.btn-thumb').forEach(btn => {
      btn.addEventListener('click', () => {
        const memId = btn.getAttribute('data-feedback-id');
        const kind = btn.getAttribute('data-kind');
        if (memId && kind) handleFeedback(memId, kind);
      });
    });
  }

  // Handle Feedback POST
  async function handleFeedback(memoryId, kind) {
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryId, kind })
      });
      state.feedbackCache.set(memoryId, { kind, confidence: res.confidence });
      // Re-render current sample and memories to reflect updated confidence
      renderSelectedSample();
      if (state.caseData && state.caseData.memory) {
        renderMemoriesList(state.caseData.memory.memories);
      }
    } catch (err) {
      showBanner('Failed to record feedback: ' + err.message, true);
    }
  }

  // ----------------------------------------------------
  // EVIDENCE DRAWER & PROVENANCE MODAL
  // ----------------------------------------------------
  async function openEvidenceDrawer(eid, caseId = state.currentCaseId) {
    if (!caseId || !eid) return;
    const request=++state.drawerRequest;
    state.drawerFocus=document.activeElement;
    state.activeDrawerEid = eid;

    const drawer = document.getElementById('evidence-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const eidBadge = document.getElementById('drawer-evidence-id');
    const loadingEl = document.getElementById('drawer-loading');
    const errorEl = document.getElementById('drawer-error');
    const bodyEl = document.getElementById('drawer-body');

    if (!drawer || !backdrop) return;
    document.getElementById('drawer-content').scrollTop=0;

    if (eidBadge) eidBadge.textContent = eid;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.classList.remove('hidden');
    backdrop.setAttribute('aria-hidden', 'false');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    if (bodyEl) bodyEl.classList.add('hidden');

    // Focus close button for accessibility
    const closeBtn = document.getElementById('drawer-close');
    if (closeBtn) closeBtn.focus();

    try {
      const data = await apiFetch('/api/cases/' + encodeURIComponent(caseId) + '/evidence/' + encodeURIComponent(eid));
      if(request!==state.drawerRequest)return;
      renderDrawerProvenance(data);
    } catch (err) {
      if(request!==state.drawerRequest)return;
      if (loadingEl) loadingEl.classList.add('hidden');
      if (errorEl) {
        errorEl.classList.remove('hidden');
        errorEl.innerHTML = '<div class="callout-notice" style="border-left-color: var(--coral);">' +
          '<strong>Error loading provenance for ' + escapeHtml(eid) + ':</strong> ' + escapeHtml(err.message) +
          '</div>';
      }
    }
  }

  function closeEvidenceDrawer() {
    state.drawerRequest++;
    const drawer = document.getElementById('evidence-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) {
      backdrop.classList.add('hidden');
      backdrop.setAttribute('aria-hidden', 'true');
    }
    state.activeDrawerEid = null;
    if(state.drawerFocus?.isConnected)state.drawerFocus.focus();
    state.drawerFocus=null;
  }

  function renderDrawerProvenance(data) {
    const drawerCaseId=data.company?.attrs?.cik+'_'+data.company?.attrs?.fy_end;
    document.getElementById('drawer-title').textContent=(data.company?.attrs?.company||'Evidence')+' sources';
    const loadingEl = document.getElementById('drawer-loading');
    const bodyEl = document.getElementById('drawer-body');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (bodyEl) bodyEl.classList.remove('hidden');

    const ev = data.evidence || {};
    const origins = data.origins || {};
    const queries = origins.queries || [];
    const filings = data.filings || [];
    const findings = data.findings || [];
    const rulings = data.rulings || [];
    const audit = data.audit || [];

    // Statement & Source
    const statementEl = document.getElementById('drawer-statement');
    if (statementEl) statementEl.textContent = ev.text || 'No statement provided.';

    const sourceTagEl = document.getElementById('drawer-source-tag');
    if (sourceTagEl) sourceTagEl.textContent = 'Evidence Kind: ' + (ev.kind || 'fact') + ' | Source: ' + (ev.source || 'SEC XBRL filing');

    // Primary Filing
    const filingGrid = document.getElementById('drawer-filing-grid');
    if (filingGrid) {
      if (filings.length > 0) {
        filingGrid.innerHTML = filings.map(f => {
          const attrs = f.attrs || {};
          const urlLink = attrs.url
            ? '<a href="' + escapeHtml(attrs.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(attrs.accn || 'SEC Edgar') + ' &UpperRightArrow;</a>'
            : escapeHtml(attrs.accn || 'N/A');

          return '<div class="filing-meta-item"><span class="filing-meta-label">Accession:</span><span class="filing-meta-val">' + urlLink + '</span></div>' +
            '<div class="filing-meta-item"><span class="filing-meta-label">Filing Date:</span><span class="filing-meta-val">' + escapeHtml(attrs.filed || 'N/A') + '</span></div>' +
            '<div class="filing-meta-item"><span class="filing-meta-label">Form Type:</span><span class="filing-meta-val">' + escapeHtml(attrs.form || '10-K') + '</span></div>' +
            '<div class="filing-meta-item"><span class="filing-meta-label">Entity:</span><span class="filing-meta-val">' + escapeHtml(attrs.company || 'N/A') + '</span></div>';
        }).join('');
      } else {
        filingGrid.innerHTML = '<span class="text-muted">No associated filing entity.</span>';
      }
    }

    // Queries & SQL
    const originsContainer = document.getElementById('drawer-origins-container');
    if (originsContainer) {
      if (queries.length === 0) {
        originsContainer.innerHTML = '<span class="text-muted">No origin queries recorded for this evidence item.</span>';
      } else {
        originsContainer.innerHTML = queries.map((q, idx) => {
          let rowsHtml = '';
          if (q.rows && q.rows.length > 0) {
            const cols = Object.keys(q.rows[0]);
            rowsHtml = '<details class="drawer-details" style="margin-top: 0.5rem;">' +
              '<summary class="drawer-details-summary">Input rows used for this evidence (' + q.rows.length + ' rows)</summary>' +
              '<div class="drawer-details-content">' +
                '<table class="provenance-rows-table">' +
                  '<thead><tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead>' +
                  '<tbody>' +
                    q.rows.map(r => '<tr>' + cols.map(c => '<td>' + escapeHtml(r[c] !== undefined ? r[c] : '') + '</td>').join('') + '</tr>').join('') +
                  '</tbody>' +
                '</table>' +
              '</div>' +
            '</details>';
          }

          return '<div style="margin-bottom: 0.85rem;">' +
            '<span class="badge-mono" style="font-weight:600; color:var(--navy);">' + escapeHtml(q.label || ('Query #' + (idx + 1))) + '</span> ' +
            '<span class="text-muted" style="font-size:0.75rem;">(' + escapeHtml(q.mode || 'csv') + ' mode, table: ' + escapeHtml(q.table || 'default') + ')</span>' +
            '<pre class="sql-block"><code>' + escapeHtml(q.sql || '') + '</code></pre>' +
            rowsHtml +
          '</div>';
        }).join('');
      }
    }

    // World Model Relationships (Findings & Rulings citing this)
    const relContainer = document.getElementById('drawer-relationships-container');
    if (relContainer) {
      let relHtml = '';
      if (findings.length > 0) {
        relHtml += '<div style="margin-bottom: 0.65rem;"><strong style="font-size:0.78rem; text-transform:uppercase; color:var(--text-muted);">Findings citing this evidence (' + findings.length + '):</strong><ul class="inquiry-list" style="margin-top:0.3rem;">';
        findings.forEach(f => {
          const attrs = f.attrs || {};
          relHtml += '<li><strong>Run ' + ((attrs.sampleIndex || 0) + 1) + ', Finding #' + ((attrs.findingIndex || 0) + 1) + ':</strong> ' + linkEvidence(attrs.management_says || '',drawerCaseId) + '</li>';
        });
        relHtml += '</ul></div>';
      }
      if (rulings.length > 0) {
        relHtml += '<div><strong style="font-size:0.78rem; color:var(--text-muted);">Related judge rulings (' + rulings.length + '):</strong><ul class="inquiry-list" style="margin-top:0.3rem;">';
        rulings.forEach(rl => {
          const attrs = rl.attrs || {};
          relHtml += '<li><strong>Run ' + ((attrs.sampleIndex || 0) + 1) + ', Ruling (' + escapeHtml(attrs.ruling || '') + '):</strong> ' + linkEvidence(attrs.reason || '',drawerCaseId) + '</li>';
        });
        relHtml += '</ul></div>';
      }
      if (!relHtml) {
        relHtml = '<span class="text-muted">No graph relationships recorded for this revision.</span>';
      }
      relContainer.innerHTML = relHtml;
    }

    // Audit log
    const auditCountEl = document.getElementById('drawer-audit-count');
    if (auditCountEl) auditCountEl.textContent = audit.length;

    const auditListEl = document.getElementById('drawer-audit-list');
    if (auditListEl) {
      if (audit.length === 0) {
        auditListEl.innerHTML = '<span class="text-muted">No audit trail events.</span>';
      } else {
        auditListEl.innerHTML = audit.map(a => {
          return '<div class="audit-item">' +
            '<span class="audit-seq">#' + (a.seq || 0) + '</span>' +
            '<span>[' + escapeHtml(a.actor || 'system') + '] ' + escapeHtml(a.summary || a.kind || '') + '</span>' +
          '</div>';
        }).join('');
      }
    }
  }

  // ----------------------------------------------------
  // LIVE RUN SSE CONTROLLER
  // ----------------------------------------------------
  async function triggerLiveRun() {
    if (!state.currentCaseId) return;
    const jobCaseId=state.currentCaseId;
    const btn = document.getElementById('btn-run-live');
    const card = document.getElementById('live-progress-card');
    const counter = document.getElementById('live-stage-counter');
    const fill = document.getElementById('live-progress-fill');
    const details = document.getElementById('live-progress-details');

    if (btn) btn.disabled = true;
    if (card) card.classList.remove('hidden');
    if (counter) counter.textContent = 'Stage 0 of 9';
    if (fill) fill.style.width = '0%';
    if (details) details.textContent = 'Starting 3 live runs...';

    state.sseCompletedStages = 0;
    state.completedStageKeys=new Set();
    state.runStatuses={};
    document.getElementById('live-status-text').textContent='Live run in progress';

    try {
      const res = await apiFetch('/api/cases/' + encodeURIComponent(jobCaseId) + '/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const eventsUrl = res.eventsUrl;
      state.activeJobId = res.id;
      state.activeJobCaseId=jobCaseId;
      try{sessionStorage.setItem('veritas-live-job',JSON.stringify({id:res.id,caseId:jobCaseId,eventsUrl}));}catch{}
      initEventSource(eventsUrl,jobCaseId);
    } catch (err) {
      if (details) details.textContent = 'Live run error: ' + err.message;
      if (btn) btn.disabled = false;
      showBanner('Failed to launch live run: ' + err.message, true);
    }
  }

  function initEventSource(url, jobCaseId) {
    if (state.activeSse) {
      state.activeSse.close();
      state.activeSse = null;
    }

    const sse = new EventSource(url);
    state.activeSse = sse;

    const card = document.getElementById('live-progress-card');
    const counter = document.getElementById('live-stage-counter');
    const fill = document.getElementById('live-progress-fill');
    const details = document.getElementById('live-progress-details');
    const statusText = document.getElementById('live-status-text');
    let disconnects=0;

    sse.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        disconnects=0;
        if (payload.type === 'started') {
          state.runStatuses = {};
          if (details) details.textContent = 'Run started: ' + payload.total + ' samples requested.';
        } else if (payload.type === 'progress') {
          if (payload.status === 'completed') {
            state.completedStageKeys.add(payload.sample+':'+payload.stage);
            state.sseCompletedStages=state.completedStageKeys.size;
          }
          const pct = Math.min(100, Math.round((state.sseCompletedStages / 9) * 100));
          if (fill) fill.style.width = pct + '%';
          if (counter) counter.textContent = 'Stage ' + state.sseCompletedStages + ' of 9 (' + pct + '%)';

          state.runStatuses = state.runStatuses || {};
          const stageName = payload.stage === 'red_team' ? 'red-team' : payload.stage;
          let statusText = stageName;
          if (payload.status === 'retry') {
            statusText += ' (retry ' + payload.attempt + ')';
          } else if (payload.status === 'completed' && payload.elapsedMs) {
            statusText += ' (' + Math.round(payload.elapsedMs / 1000) + 's)';
          }
          state.runStatuses[payload.sample] = statusText;

          const totalRuns = payload.total || 3;
          const parts = [];
          for (let s = 1; s <= totalRuns; s++) {
            if (state.runStatuses[s]) {
              parts.push('Run ' + s + ': ' + state.runStatuses[s]);
            }
          }
          if (details && parts.length > 0) details.textContent = parts.join(' · ');
        } else if (payload.type === 'completed') {
          state.runStatuses = {};
          if (statusText) statusText.textContent = 'Live Run Completed!';
          if (fill) fill.style.width = '100%';
          if (counter) counter.textContent = 'Stage 9 of 9 (100%)';
          if (details) details.textContent = 'All 3 runs done, citations checked. Refreshing...';
          sse.close();
          state.activeSse = null;
          state.activeJobId=null;
          state.activeJobCaseId=null;
          try{sessionStorage.removeItem('veritas-live-job');}catch{}
          setTimeout(() => {
            if (card) card.classList.add('hidden');
            if(state.currentCaseId===jobCaseId)loadCase(jobCaseId);
            else if(state.currentRoute==='#/'||state.currentRoute==='#')loadCohort();
          }, 1200);
        } else if (payload.type === 'failed') {
          state.runStatuses = {};
          if (statusText) statusText.textContent = 'Run Failed';
          if (details) details.textContent = 'Actionable Error: ' + (payload.error || 'Unknown error occurred');
          sse.close();
          state.activeSse = null;
          state.activeJobId=null;
          state.activeJobCaseId=null;
          try{sessionStorage.removeItem('veritas-live-job');}catch{}
          showBanner('Live run failed: ' + (payload.error || 'Server error'), true);
          const btn = document.getElementById('btn-run-live');
          if (btn) btn.disabled = false;
        }
      } catch (err) {
        console.error('Error handling SSE event:', err);
      }
    };

    sse.onerror = (err) => {
      if(details)details.textContent='Progress connection lost; reconnecting. The run continues on the server.';
      if(++disconnects>=3){
        sse.close();state.activeSse=null;state.activeJobId=null;
        try{sessionStorage.removeItem('veritas-live-job');}catch{}
        if(statusText)statusText.textContent='Progress unavailable';
        showBanner('Could not reconnect to live progress. Reload the case to check saved results.',true);
      }
      console.warn('SSE disconnected or encountered an error:', err);
      // EventSource automatically retries transient disconnects.
    };
  }

  // ----------------------------------------------------
  // NOT FOUND VIEW
  // ----------------------------------------------------
  function renderNotFound(message) {
    showView('view-not-found');
    const msgEl = document.getElementById('notfound-message');
    if (msgEl) {
      msgEl.textContent = message || 'This case is not in the cohort.';
    }
  }

  // ====================================================
  // THEME CONTROLLER (Dark mode toggle, system sync & storage)
  // ====================================================
  function initTheme() {
    const toggleBtn = document.getElementById("theme-toggle");

    function getSystemTheme() {
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
          return "dark";
        }
      } catch (_) {}
      return "light";
    }

    function getSavedTheme() {
      try {
        return localStorage.getItem("theme") || localStorage.getItem("veritas-theme");
      } catch (_) {
        return null;
      }
    }

    function saveTheme(theme) {
      try {
        localStorage.setItem("theme", theme);
        localStorage.setItem("veritas-theme", theme);
      } catch (_) {
        // storage blocked or throwing
      }
    }

    function updateToggleButton(theme) {
      if (!toggleBtn) return;
      const isDark = theme === "dark";
      toggleBtn.setAttribute("aria-pressed", isDark ? "true" : "false");
      toggleBtn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
      toggleBtn.setAttribute("title", isDark ? "Switch to light theme" : "Switch to dark theme");
    }

    function applyTheme(theme, save) {
      document.documentElement.setAttribute("data-theme", theme);
      if (save) {
        saveTheme(theme);
      }
      updateToggleButton(theme);
    }

    // Initialize toggle state to match currently active theme
    const activeTheme = document.documentElement.getAttribute("data-theme") || getSavedTheme() || getSystemTheme();
    applyTheme(activeTheme, false);

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
        const nextTheme = current === "dark" ? "light" : "dark";
        applyTheme(nextTheme, true);
      });
    }

    try {
      if (window.matchMedia) {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        mq.addEventListener("change", (e) => {
          if (!getSavedTheme()) {
            applyTheme(e.matches ? "dark" : "light", false);
          }
        });
      }
    } catch (_) {}
  }

  // ----------------------------------------------------
  // INITIALIZATION & EVENT DELEGATION
  // ----------------------------------------------------
  // Fetch any company-year from SEC EDGAR through the server, then open its case page.
  async function addCompany(ev) {
    ev.preventDefault();
    const status = document.getElementById('add-company-status'), btn = document.getElementById('btn-add-company');
    const company = document.getElementById('add-company-input').value.trim();
    const year = Number(document.getElementById('add-company-year').value);
    btn.disabled = true;
    status.textContent = 'Fetching the 10-K and XBRL facts from SEC EDGAR...';
    try {
      const res = await apiFetch('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company, year }) });
      status.textContent = '';
      location.hash = '#/case/' + encodeURIComponent(res.id);
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function initApp() {
    // Router bindings
    window.addEventListener('hashchange', handleRoute);
    document.getElementById('add-company-form')?.addEventListener('submit', addCompany);

    // Global click delegation for evidence buttons
    document.addEventListener('click', (e) => {
      const evBtn = e.target.closest('[data-eid]');
      if (evBtn) {
        const eid = evBtn.getAttribute('data-eid');
        if (eid) {
          e.preventDefault();
          openEvidenceDrawer(eid,evBtn.getAttribute('data-case-id')||state.currentCaseId);
        }
      }
    });

    // Keyboard ESC listener for drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        closeEvidenceDrawer();
      }
      if(e.key==='Tab'&&document.getElementById('evidence-drawer').classList.contains('open')){
        const focusable=[...document.querySelectorAll('#evidence-drawer button,#evidence-drawer a[href],#evidence-drawer summary')].filter(el=>el.getClientRects().length);
        const first=focusable[0],last=focusable.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    });

    // Drawer close button & backdrop
    const closeBtn = document.getElementById('drawer-close');
    if (closeBtn) closeBtn.addEventListener('click', closeEvidenceDrawer);

    const backdrop = document.getElementById('drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeEvidenceDrawer);

    // Banner close
    const bannerClose = document.getElementById('banner-close');
    if (bannerClose) bannerClose.addEventListener('click', hideBanner);

    // Role reveal toggle
    const toggleRevealBtn = document.getElementById('btn-toggle-reveal');
    if (toggleRevealBtn) {
      toggleRevealBtn.addEventListener('click', () => {
        state.revealRoles = !state.revealRoles;
        loadCohort();
      });
    }

    // Live run trigger
    const btnLive = document.getElementById('btn-run-live');
    if (btnLive) {
      btnLive.addEventListener('click', triggerLiveRun);
    }
    const quarterLink=document.getElementById('jump-to-quarters');
    quarterLink.addEventListener('click',e=>{e.preventDefault();document.querySelector('.quarter-section').scrollIntoView({block:'start',behavior:'smooth'});});
    // Keep the explanation scorecard above the detailed quarterly exhibit.
    document.querySelector('.findings-section').after(document.querySelector('.quarter-section'));

    // Theme initialization
    initTheme();

    // Initial Route Execution
    handleRoute();
  }

  // Launch on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
