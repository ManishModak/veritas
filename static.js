// static.js - Veritas static mode fetch shim and notice
(function(global) {
  const STATIC_ERROR = 'This is the static demo. Run the app locally for live runs, feedback and search.';

  // Mark <html> with data-static="true"
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-static', 'true');
  }

  // Clear any leftover live job in sessionStorage
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.removeItem('veritas-live-job'); } catch {}
  }

  // Insert static banner under .app-header
  function insertStaticBanner() {
    if (typeof document === 'undefined') return;
    const header = document.querySelector('.app-header');
    if (header && !document.querySelector('.static-notice')) {
      const banner = document.createElement('div');
      banner.className = 'static-notice';
      banner.textContent = 'Static demo of recorded runs. Run it locally for live analysis.';
      header.insertAdjacentElement('afterend', banner);
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', insertStaticBanner);
    } else {
      insertStaticBanner();
    }
  }

  // Determine site base URL (works under any sub-path, e.g. /site/ or /veritas/)
  function getSiteBase() {
    if (typeof document !== 'undefined') {
      if (document.currentScript && document.currentScript.src) {
        return new URL('.', document.currentScript.src).href;
      }
      const scripts = document.querySelectorAll('script[src*="static.js"]');
      if (scripts.length > 0) {
        const last = scripts[scripts.length - 1];
        if (last && 'src' in last && last.src) {
          return new URL('.', last.src).href;
        }
      }
    }
    if (typeof window !== 'undefined' && window.location && window.location.href) {
      let pathname = window.location.pathname;
      if (!pathname.endsWith('/')) {
        pathname += '/';
      }
      return new URL(pathname, window.location.origin).href;
    }
    return 'http://localhost/';
  }

  /**
   * Maps an API URL to a relative static JSON file or indicates a blocked call.
   * @param {string} urlString
   * @param {string} [base]
   * @returns {{ isBlocked: boolean; error?: string; relPath?: string; url?: string } | null}
   */
  function mapApiUrl(urlString, base = getSiteBase()) {
    if (!urlString) return null;
    let parsed;
    try {
      parsed = new URL(urlString, 'http://localhost');
    } catch {
      return null;
    }

    const pathname = parsed.pathname;
    const apiIdx = pathname.indexOf('/api/');
    if (apiIdx === -1) return null;

    const apiPath = pathname.slice(apiIdx + '/api/'.length).replace(/\/$/, '');
    const searchParams = parsed.searchParams;

    // GET /api/cases or /api/cases?reveal=true
    if (apiPath === 'cases') {
      const relPath = searchParams.get('reveal') === 'true'
        ? 'api/cases-reveal.json'
        : 'api/cases.json';
      const targetUrl = new URL(relPath, base).href;
      return { isBlocked: false, relPath, url: targetUrl };
    }

    // Paths starting with cases/
    if (apiPath.startsWith('cases/')) {
      const parts = apiPath.split('/');
      // parts[0] === 'cases', parts[1] === '<id>'
      const caseId = parts[1];

      // GET /api/cases/<id>
      if (parts.length === 2) {
        const relPath = `api/cases/${caseId}.json`;
        const targetUrl = new URL(relPath, base).href;
        return { isBlocked: false, relPath, url: targetUrl };
      }

      // GET /api/cases/<id>/evidence/<eid>
      if (parts.length === 4 && parts[2] === 'evidence') {
        const eid = parts[3];
        const relPath = `api/cases/${caseId}/evidence/${eid}.json`;
        const targetUrl = new URL(relPath, base).href;
        return { isBlocked: false, relPath, url: targetUrl };
      }

      // GET /api/cases/<id>/memory (default or custom query)
      if (parts.length === 3 && parts[2] === 'memory') {
        const q = searchParams.get('q');
        if (q !== null && q.trim().length > 0) {
          // Custom memory search is blocked in static demo
          return { isBlocked: true, error: STATIC_ERROR };
        }
        const relPath = `api/cases/${caseId}/memory.json`;
        const targetUrl = new URL(relPath, base).href;
        return { isBlocked: false, relPath, url: targetUrl };
      }
    }

    return null;
  }

  // Helper to wrap a fetch implementation
  function installFetchShim(target = (typeof window !== 'undefined' ? window : global)) {
    if (!target || typeof target.fetch !== 'function') return null;
    const originalFetch = target.fetch;
    const wrappedFetch = async function(input, init) {
      const method = (init?.method || (typeof input === 'object' && input && 'method' in input ? input.method : 'GET')).toUpperCase();
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url ? input.url : '');

      // All writes (non-GET) return a static demo error response
      if (method !== 'GET') {
        return new Response(JSON.stringify({ error: STATIC_ERROR }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      const mapping = mapApiUrl(urlString);
      if (mapping) {
        if (mapping.isBlocked) {
          return new Response(JSON.stringify({ error: mapping.error || STATIC_ERROR }), {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        }
        if (mapping.url) {
          return originalFetch.call(this, mapping.url, init);
        }
      }

      return originalFetch.call(this, input, init);
    };

    target.fetch = wrappedFetch;
    return wrappedFetch;
  }

  // Intercept window.fetch if window exists in a browser
  if (typeof window !== 'undefined') {
    installFetchShim(window);
  }

  // Expose for testing and inspection
  const VeritasStatic = {
    STATIC_ERROR,
    mapApiUrl,
    getSiteBase,
    installFetchShim
  };

  global.VeritasStatic = VeritasStatic;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VeritasStatic;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
