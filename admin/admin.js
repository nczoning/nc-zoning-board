/*
 * NC Zoning Board admin dashboard.
 *
 * Phase 4c. The server side already exists (worker/src/admin.js); this is the
 * surface for it. No framework and no build step, matching the rest of the
 * site: a few hundred lines of DOM against a JSON API does not need one.
 *
 * Three rules run through the whole file:
 *
 * 1. A response is a success only when it says so. `res.ok` is checked
 *    explicitly and an unrecognised status is an error, never a fall-through to
 *    the happy path. Treating an unrecognised status as success renders
 *    "Signed in as undefined, collaborator access confirmed" against a 404.
 * 2. 403 and 503 are different things. 403 is "you are not a collaborator".
 *    503 `check_unavailable` is "GitHub could not be reached", which is not a
 *    refusal and is never worded as one.
 * 3. Writes send only fields that actually changed. The API rejects unknown
 *    keys with a 422 rather than ignoring them, so a typo is loud, but only if
 *    the client does not paper over it by resending everything.
 */

(() => {
  'use strict';

  // ------------------------------------------------------------- config --

  // Resolve by hostname, NOT "always production" the way the map does.
  //
  // The map reads the production API from every origin because there has never
  // been a deliberate dev dataset. Auth is the opposite case: the auth routes
  // reach dev before they reach main, so a dev page pointed at production would
  // call routes that do not exist there yet. dev talks to dev.
  const API = (() => {
    const override = new URLSearchParams(location.search).get('api');
    if (override === 'dev') return 'https://api-dev.nczoning.net';
    if (override === 'prod') return 'https://api.nczoning.net';
    return location.hostname === 'dev.nczoning.net'
      ? 'https://api-dev.nczoning.net'
      : 'https://api.nczoning.net';
  })();

  const CATEGORIES = ['location-overhaul', 'new-location', 'other'];
  const STATUSES = ['published', 'hidden', 'draft'];

  /** Exactly the fields the API will accept. Anything else is a 422. */
  const WRITABLE = [
    'name', 'authors', 'credits', 'coordinates', 'yaw', 'nexus_id',
    'description', 'category', 'tags', 'status', 'admin_notes',
  ];

  // Reasons the OAuth callback can bounce back with. `check_unavailable` is
  // deliberately worded as "cannot tell", not "denied". GitHub being
  // unreachable is not a statement about who you are, and telling an admin they
  // lack access because of a transient blip is a lie the UI should not tell.
  const CALLBACK_ERRORS = {
    bad_state: ['error', 'Login could not be verified. Start again from this page.'],
    oauth_failed: ['error', 'GitHub sign-in failed. Try again.'],
    not_authorised: ['error', 'That account is not a collaborator on the repository.'],
    check_unavailable: ['warn', 'Could not reach GitHub to confirm access. This is not a refusal. Try again shortly.'],
  };

  // --------------------------------------------------------------- state --

  const state = {
    login: null,
    locations: [],
    tags: [],
    submissions: [],
    candidates: [],
    dismissed: [],
    // What the Alerts tab last loaded, and the server's own count of what is
    // still unacknowledged. The count is kept separately because the list is
    // subject to the tab's limit and filter, and the Overview must not report
    // "3 open" when it merely fetched 3 of them.
    alerts: [],
    alertsUnacknowledged: 0,
    selectedLocation: null,   // id, or '' for a new record
    selectedTag: null,        // slug, or '' for a new tag
    selectedSubmission: null, // submission id
    // Which tab's detail pane the stacked layout is currently showing, so the
    // one back control and the one history entry know what to close. Null on a
    // wide screen, where the pane is beside the list rather than over it.
    detailTab: null,          // 'locations' | 'tags' | 'queue' | null
    queueStatus: 'pending',   // '' for every status
    // The queue's mini-map, held so it can be torn down before its container
    // is replaced. A Leaflet map on a removed node keeps its resize and zoom
    // handlers, and every review opened would leave another one behind.
    reviewMap: null,
    editing: false,           // detail view vs. the form; see selectLocation
    // District is computed by the materializer, not stored on the record, so it
    // is learned from /v1/locations when the Overview loads. Published records
    // only, which is what "district" means anyway.
    districtById: new Map(),
    // Structured rather than "shove it in the search box": the Overview tiles
    // filter by things free text cannot express (untagged, district),
    // and each one has to be individually removable from the chip row.
    filter: {
      q: '', status: '', category: '', tag: '', district: '', special: '',
    },
    // The API returns locations ordered by name, which is the default here too.
    // Sorting is client-side: the whole registry is already in memory, so a
    // round trip per sort would be slower and would fight the active filter.
    sort: { key: 'name', dir: 'asc' },
  };

  /** Human label for a filter, used on the chips. */
  const FILTER_LABELS = {
    q: 'search',
    status: 'status',
    category: 'category',
    tag: 'tag',
    district: 'district',
    special: '',
  };

  const SPECIAL_LABELS = {
    untagged: 'no tags',
    wip: 'WIP / Dummy id',
  };

  // ----------------------------------------------------------- DOM utils --

  const $ = (sel) => document.querySelector(sel);

  /**
   * Element builder. Text goes in via textContent, never innerHTML, so mod
   * names and admin notes cannot inject markup. This page renders strings
   * written by third parties on Nexus.
   */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const replace = (el, ...nodes) => { clear(el).append(...nodes.flat().filter(Boolean)); return el; };

  // ------------------------------------------------------------- the clock --

  /**
   * Every timestamp the API returns is UTC. Every one rendered here is local
   * AND CARRIES ITS ZONE NAME.
   *
   * The zone name is part of the format rather than an option, because
   * `toLocaleString()` alone renders "28/07/2026, 15:00:00" with no marker at
   * all. Collaborators are spread across AEST and the northern hemisphere, so
   * one event reads as three different unmarked numbers ten hours apart.
   *
   * The canonical UTC value stays in `datetime` and on the `title`, where it
   * can be copied into a query or matched against a log line.
   *
   * `dateStyle`/`timeStyle` are unusable here: ECMA-402 throws a TypeError when
   * either is combined with `timeZoneName`, so the components are listed out.
   */
  const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  });

  /** A UTC timestamp as a labelled local string. Unparseable input passes through. */
  function formatTime(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return String(iso ?? '');
    return TIME_FORMAT.format(ms);
  }

  /**
   * A `<time>` for a stored timestamp: local and labelled on screen, UTC in
   * `datetime` and on hover.
   */
  function timeEl(iso, attrs = {}) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return h('span', { class: 'muted', text: 'unknown' });
    return h('time', {
      datetime: iso,
      title: `${iso} (UTC, as stored)`,
      text: formatTime(iso),
      ...attrs,
    });
  }

  /**
   * A nexus id as a link to the mod page, wherever one is shown.
   *
   * Reviewing anything here almost always means looking at the mod: checking
   * the images, reading the description, seeing whether it is a location mod at
   * all. Retyping a six-digit number into a browser is the friction that stops
   * that happening.
   *
   * NOT every nexus_id is a mod. `WIP` and `Dummy` are valid values for a
   * record with no Nexus page (validate.js accepts them), and linking those
   * would send a reviewer to a 404 that looks like a deleted mod. Only digits
   * become links; the rest render as plain text.
   */
  const isRealNexusId = (id) => /^\d+$/.test(String(id ?? ''));

  const nexusUrl = (id) => `https://www.nexusmods.com/cyberpunk2077/mods/${id}`;

  function nexusLink(id, { label } = {}) {
    const text = label ?? String(id ?? '');
    if (!isRealNexusId(id)) return h('span', { class: 'mono', text });
    return h('a', {
      class: 'mono nexus-link',
      href: nexusUrl(id),
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Open this mod on Nexus in a new tab',
    }, text);
  }

  // ------------------------------------------------------------ requests --

  /**
   * One JSON call. Always credentialed: the session is an HttpOnly cookie, and
   * the origin has to be in ADMIN_ORIGINS (worker/src/auth.js) for the browser
   * to send it. `*.pages.dev` preview URLs are NOT on that list, so a PR
   * preview cannot exercise auth; test on dev.nczoning.net.
   *
   * Never throws on an HTTP error: the status IS the information here, and
   * callers have to branch on 403 vs 503 vs 409 rather than on "it failed".
   */
  async function api(path, { method = 'GET', body, headers } = {}) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        credentials: 'include',
        ...(body === undefined
          ? (headers ? { headers } : {})
          : {
            headers: { 'Content-Type': 'application/json', ...(headers || {}) },
            body: JSON.stringify(body),
          }),
      });
    } catch (err) {
      // Network-level: no status at all. Distinct from every HTTP status, and
      // in particular NOT reported as a refusal.
      return { ok: false, status: 0, body: {}, offline: true, error: String(err) };
    }
    const parsed = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: parsed };
  }

  /**
   * Turn any non-2xx into a message, keeping the distinctions that matter.
   * Returns `[kind, message]` where kind is 'error' or 'warn'.
   */
  function describeFailure(res) {
    if (res.offline) return ['error', `Could not reach ${API}. Check your connection and retry.`];
    switch (res.status) {
      case 401:
        return ['error', 'Your session has expired. Reload the page and sign in again.'];
      case 403:
        return ['error', 'Refused: your account is not a collaborator on the repository.'];
      case 503:
        // Not a refusal. See rule 2 at the top of this file.
        return ['warn', 'GitHub could not be reached to confirm your access. This is not a refusal. Try again shortly.'];
      case 404:
        return ['error', 'Not found. It may have been deleted in another tab.'];
      case 409:
        // `detail` where the server sent one: the review routes use 409 for
        // several distinct conflicts, and one of them (another reviewer won the
        // race after this request had already written the location) is
        // specifically NOT "nothing was changed".
        if (res.body?.error === 'stale_write') {
          return ['error', 'This record changed after you opened it, so nothing was saved. '
            + 'The current version has been loaded; reapply your change and save again.'];
        }
        // The fallback only. An approval refused this way is handled where it
        // happens, because the submission is still pending and the reviewer can
        // approve it over the current record; see staleSubmission.
        if (res.body?.error === 'stale_submission') {
          return ['warn', 'The location changed after this submission was made, so nothing was '
            + 'applied and the submission is still pending. Reload and review it against the '
            + 'current record.'];
        }
        return ['error', res.body?.error === 'tag_exists'
          ? `A tag with the slug "${res.body.slug}" already exists.`
          : res.body?.detail || 'Conflict. Nothing was changed.'];
      case 422:
        return ['error', 'The server rejected this: ' + (res.body?.errors || ['validation failed']).join('; ')];
      case 400:
        return ['error', res.body?.error === 'empty_patch'
          ? 'Nothing changed, so nothing was sent.'
          : 'The request was malformed.'];
      case 500:
        // cascade_failed is the one 500 with something useful to say: the tag
        // was renamed but its links did not follow, which needs a person.
        return ['error', res.body?.error === 'cascade_failed'
          ? `The rename did not propagate: ${res.body.detail}. The registry and the location links are now out of step; do not retry, check the database.`
          : 'The server failed on this request. Nothing is guaranteed to have been written.'];
      default:
        // Anything unrecognised is an error, never a silent success.
        return ['error', `Unexpected response from ${API} (HTTP ${res.status}).`];
    }
  }

  function banner(kind, message, extra) {
    const box = h('div', { class: `notice ${kind}` }, message, extra || null);
    replace($('#banner'), box);
    box.scrollIntoView({ block: 'nearest' });
    return box;
  }

  const clearBanner = () => clear($('#banner'));

  // ---------------------------------------------------------------- gate --

  function renderGate(nodes) {
    document.body.classList.add('gate');
    replace($('#gate-body'), nodes);
  }

  const signInButton = (label = 'Sign in with GitHub') => h('button', {
    class: 'btn',
    type: 'button',
    text: label,
    onclick: () => {
      location.href = `${API}/auth/login?return_to=${encodeURIComponent(location.pathname)}`;
    },
  });

  async function signOut() {
    await api('/auth/logout', { method: 'POST' });
    location.replace(location.pathname);
  }

  /**
   * Decide whether this browser gets a dashboard.
   *
   * Success requires an explicit 200 AND collaborator === true. Everything
   * else falls to the final branch, including statuses this page has never
   * seen. Treating "not one of the failures I listed" as success is how the
   * stub once greeted a 404 with "Signed in as undefined".
   */
  async function checkSession(callbackBanner) {
    const res = await api('/auth/me');

    if (res.offline) {
      return renderGate([
        h('div', { class: 'notice error', text: `Could not reach ${API}.` }),
        signInButton('Retry'),
      ]);
    }

    if (res.status === 401) {
      return renderGate([
        callbackBanner,
        h('p', { class: 'muted', text: 'Sign in with a GitHub account that is a collaborator on the repository.' }),
        signInButton(),
      ]);
    }

    if (res.status === 503) {
      // Distinct from 403 on purpose.
      return renderGate([
        callbackBanner,
        h('div', { class: 'notice warn' },
          'Signed in as ', h('span', { class: 'who', text: res.body.login ?? 'unknown' }),
          ', but GitHub could not be reached to confirm access. This is not a refusal.'),
        signInButton('Retry'),
      ]);
    }

    if (res.status === 403) {
      return renderGate([
        callbackBanner,
        h('div', { class: 'notice error' },
          'Signed in as ', h('span', { class: 'who', text: res.body.login ?? 'unknown' }),
          ', which is not a collaborator on the repository.'),
        h('button', { class: 'btn secondary', type: 'button', text: 'Sign out', onclick: signOut }),
      ]);
    }

    if (res.status === 200 && res.body.collaborator === true) {
      state.login = res.body.login;
      return true;
    }

    return renderGate([
      callbackBanner,
      h('div', { class: 'notice error' },
        `Unexpected response from ${API} (HTTP ${res.status}). The auth routes may not be deployed there.`),
      signInButton('Retry'),
    ]);
  }

  // ----------------------------------------------------------- locations --

  const tagsOf = (loc) => loc.tags;

  /** Category, in the map's own pin colours. See .cat in admin.css. */
  const categoryTag = (category) => h('span', {
    class: `cat cat-${category}`,
    text: category.replace(/-/g, ' '),
  });

  function locationMatches(loc, f) {
    if (f.status && loc.status !== f.status) return false;
    if (f.category && loc.category !== f.category) return false;
    if (f.tag && !(loc.tags || []).includes(f.tag)) return false;
    if (f.district && state.districtById.get(loc.id) !== f.district) return false;
    if (f.special === 'untagged' && (loc.tags || []).length) return false;
    if (f.special === 'wip' && /^\d+$/.test(String(loc.nexus_id))) return false;
    if (!f.q) return true;
    const hay = [loc.name, loc.nexus_id, ...(loc.authors || []), ...(loc.tags || [])]
      .join(' ').toLowerCase();
    return hay.includes(f.q.toLowerCase());
  }

  const activeFilters = () => Object.entries(state.filter).filter(([, v]) => v !== '');

  /**
   * Apply a filter and show the result.
   *
   * `patch` merges, so a tile can narrow an existing filter rather than
   * replacing it. Pass `reset: true` for the Overview tiles, which mean "show
   * me these" rather than "and also these".
   */
  function setFilter(patch, { reset = false, go = false } = {}) {
    if (reset) {
      state.filter = { q: '', status: '', category: '', tag: '', district: '', special: '' };
    }
    Object.assign(state.filter, patch);
    // The selects are a second view of the same state, so they follow it.
    $('#loc-search').value = state.filter.q;
    $('#loc-status').value = state.filter.status;
    $('#loc-category').value = state.filter.category;
    renderLocations();
    if (go) switchTab('locations');
  }

  function renderChips() {
    const active = activeFilters();
    if (!active.length) return replace($('#loc-chips'));

    const chips = active.map(([key, value]) => h('span', { class: 'chip' },
      `${FILTER_LABELS[key] ? `${FILTER_LABELS[key]}: ` : ''}${
        key === 'special' ? SPECIAL_LABELS[value] ?? value : value}`,
      h('button', {
        type: 'button', text: '✕', title: `Remove this filter`,
        onclick: () => setFilter({ [key]: '' }),
      })));

    if (active.length > 1) {
      chips.push(h('button', {
        class: 'btn secondary', type: 'button', text: 'Clear all',
        onclick: () => setFilter({}, { reset: true }),
      }));
    }
    replace($('#loc-chips'), chips);
  }

  /**
   * Value to sort a row on. Dates compare as plain strings because they are all
   * ISO in UTC: the backfill normalises git's local offsets to `Z` precisely so
   * this holds. Mixed offsets would sort by their text, not by their instant.
   */
  function sortValue(loc, key) {
    if (key === 'added_at' || key === 'modified_at') return loc[key] ?? '';
    return String(loc[key] ?? '').toLowerCase();
  }

  function sortLocations(rows) {
    const { key, dir } = state.sort;
    const sign = dir === 'desc' ? -1 : 1;
    const isDate = key === 'added_at' || key === 'modified_at';
    return [...rows].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      // Ties fall back to name, so a re-sort of the same data cannot reshuffle
      // rows that compare equal.
      if (av === bv) return String(a.name).localeCompare(String(b.name));
      // Dates compare by codepoint, NOT localeCompare. They are fixed-format
      // ISO in UTC, so codepoint order is chronological order, whereas locale
      // collation is free to reorder the punctuation these are full of.
      if (isDate) return sign * (av < bv ? -1 : 1);
      // Text does use localeCompare: names carry accents and case that a
      // codepoint comparison orders in ways nobody reading the table expects.
      return sign * av.localeCompare(bv);
    });
  }

  /**
   * Click a header to sort by it, click the same one again to reverse.
   *
   * A new column starts descending for the dates and ascending for the text
   * ones, because "most recently modified" is the question a date column is
   * there to answer, and "A first" is the question a name column is.
   */
  function setSort(key) {
    const dateKey = key === 'added_at' || key === 'modified_at';
    state.sort = state.sort.key === key
      ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: dateKey ? 'desc' : 'asc' };
    renderLocations();
  }

  /** Wire the sortable headers once, and keep aria-sort in step with state. */
  function renderSortHeaders() {
    for (const th of document.querySelectorAll('#loc-table th[data-sort]')) {
      const key = th.dataset.sort;
      const active = state.sort.key === key;
      th.setAttribute('aria-sort', active
        ? (state.sort.dir === 'asc' ? 'ascending' : 'descending')
        : 'none');
      th.classList.toggle('sorted', active);
      th.classList.toggle('desc', active && state.sort.dir === 'desc');
      if (!th.dataset.wired) {
        th.dataset.wired = '1';
        th.tabIndex = 0;
        th.addEventListener('click', () => setSort(key));
        // Keyboard parity: a header that only responds to a mouse is a control
        // half the people using it cannot reach.
        th.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort(key); }
        });
      }
    }
  }

  function renderLocations() {
    renderSortHeaders();
    const shown = sortLocations(state.locations.filter((l) => locationMatches(l, state.filter)));

    replace($('#loc-rows'), shown.map((loc) => h('tr', {
      'aria-selected': loc.id === state.selectedLocation ? 'true' : 'false',
      onclick: () => selectLocation(loc.id),
      style: 'cursor:pointer',
    },
    h('td', {}, loc.name),
    h('td', {}, categoryTag(loc.category)),
    h('td', {}, tagsOf(loc).map((t) => h('span', {
      class: 'badge',
      text: t,
    }))),
    h('td', {},
      h('span', { class: `badge status-${loc.status}`, text: loc.status })),
    h('td', {}, whenCell(loc.added_at)),
    h('td', {}, whenCell(loc.modified_at)),
    // stopPropagation, or opening the mod page also selects the row behind it.
    h('td', { onclick: (e) => e.stopPropagation() }, nexusLink(loc.nexus_id)))));

    $('#loc-count').textContent = shown.length === state.locations.length
      ? `${shown.length} locations`
      : `${shown.length} of ${state.locations.length} locations`;
    renderChips();
  }

  /** @returns {Promise<boolean>} whether the read succeeded. See refreshAll. */
  async function loadLocations() {
    const res = await api('/admin/locations');
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      return false;
    }
    state.locations = res.body.locations || [];
    renderLocations();
    return true;
  }

  // -------------------------------------------------------- record editor --

  /** Read the editor form into a payload of writable fields only. */
  function readLocationForm(form) {
    const val = (name) => form.elements[name]?.value ?? '';
    const trimmed = (name) => val(name).trim();

    // A blank X or Y becomes null, NOT 0. `Number('')` is 0, which would place
    // a new record at the world origin and look like a deliberate coordinate;
    // null fails the server's finite-number check and says so against the field.
    const num = (raw) => (raw === '' ? null : Number(raw));
    const nums = ['x', 'y', 'z'].map((k) => trimmed(`coord_${k}`));
    const coordinates = nums[2] === ''
      ? [num(nums[0]), num(nums[1])]
      : [num(nums[0]), num(nums[1]), num(nums[2])];

    const yawRaw = trimmed('yaw');
    const creditsRaw = trimmed('credits');
    const notesRaw = trimmed('admin_notes');

    return {
      name: trimmed('name'),
      nexus_id: trimmed('nexus_id'),
      category: val('category'),
      status: val('status'),
      coordinates,
      // Blank means "no value", which the API models as null, not as 0 or "".
      yaw: yawRaw === '' ? null : Number(yawRaw),
      credits: creditsRaw === '' ? null : creditsRaw,
      admin_notes: notesRaw === '' ? null : notesRaw,
      description: val('description'),
      authors: trimmed('authors').split(',').map((a) => a.trim()).filter(Boolean),
      tags: [...form.querySelectorAll('input[name="tag"]:checked')].map((i) => i.value),
    };
  }

  const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Only what changed.
   *
   * This is why the API's reject-unknown-keys behaviour stays useful: if the
   * client resent the whole record every time, a field the server does not
   * know about would come back on every save and the 422 would be noise rather
   * than a signal. It also makes `modified_at` mean something.
   */
  function diffPayload(current, original) {
    const patch = {};
    for (const key of WRITABLE) {
      if (!sameValue(current[key], original[key])) patch[key] = current[key];
    }
    return patch;
  }

  const field = (label, control, hint, extra) => h('div', { class: 'field', 'data-field': control.name || control.dataset?.field },
    h('label', { text: label }), control,
    hint ? h('p', { class: 'muted', text: hint }) : null,
    extra || null);

  const input = (name, value, attrs = {}) => h('input', { name, value: value ?? '', ...attrs });

  const select = (name, options, value) => h('select', { name },
    options.map((o) => {
      const opt = h('option', { value: o, text: typeof o === 'string' ? o.replace(/-/g, ' ') : o });
      if (o === value) opt.selected = true;
      return opt;
    }));

  function tagPicker(selected) {
    return h('div', { class: 'tag-picker', 'data-field': 'tags' },
      state.tags.map((t) => {
        const box = h('input', { type: 'checkbox', name: 'tag', value: t.slug });
        box.checked = selected.includes(t.slug);
        return h('label', { title: t.description || '' }, box, t.name || t.slug);
      }));
  }

  const BLANK_LOCATION = {
    id: '', name: '', nexus_id: '', category: 'new-location', status: 'draft',
    coordinates: ['', '', ''], yaw: null, credits: null,
    admin_notes: null, description: '', authors: [], tags: [],
  };

  function renderLocationEditor(loc) {
    const isNew = !loc.id;
    const [x, y, z] = loc.coordinates ?? ['', '', ''];

    // A link that follows what is typed, so a nexus id can be checked against
    // the actual mod page before the record is saved. That check is the whole
    // reason the field is hand-entered rather than picked from a list.
    const nexusInput = input('nexus_id', loc.nexus_id, { placeholder: '12345, WIP or Dummy' });
    const nexusOpen = h('a', {
      class: 'field-link', target: '_blank', rel: 'noopener noreferrer', text: 'open on Nexus',
    });
    const syncNexusLink = () => {
      const id = nexusInput.value.trim();
      nexusOpen.hidden = !isRealNexusId(id);
      if (!nexusOpen.hidden) nexusOpen.href = nexusUrl(id);
    };
    nexusInput.addEventListener('input', syncNexusLink);
    syncNexusLink();

    const form = h('form', { autocomplete: 'off', onsubmit: (e) => e.preventDefault() },
      field('Name', input('name', loc.name, { required: true, minlength: '3' })),
      h('div', { class: 'field row' },
        field('Category', select('category', CATEGORIES, loc.category)),
        field('Status', select('status', STATUSES, loc.status))),
      field('Nexus ID', nexusInput, null, nexusOpen),
      // One data-field for all three, because the validator reports on
      // `coordinates` as a unit ("coordinates must all be finite numbers") and
      // an error that cannot find its input is an error nobody sees.
      h('div', { class: 'field row', 'data-field': 'coordinates' },
        field('X', input('coord_x', x, { type: 'number', step: 'any' })),
        field('Y', input('coord_y', y, { type: 'number', step: 'any' })),
        field('Z', input('coord_z', z ?? '', { type: 'number', step: 'any' }))),
      field('Yaw', input('yaw', loc.yaw ?? '', { type: 'number', step: 'any', placeholder: 'blank for none' })),
      field('Authors', input('authors', (loc.authors || []).join(', '), { placeholder: 'comma separated' })),
      field('Credits', input('credits', loc.credits ?? '', { placeholder: 'blank for none' })),
      field('Description', h('textarea', { name: 'description', maxlength: '500' }, loc.description || '')),
      field('Tags', tagPicker(loc.tags || [])),
      field('Admin notes', h('textarea', { name: 'admin_notes', placeholder: 'internal, never served on /v1' },
        loc.admin_notes || '')),
    );

    const dirtyLabel = h('span', { class: 'dirty-summary' });
    const saveBtn = h('button', { class: 'btn', type: 'button', text: isNew ? 'Create' : 'Save changes' });

    const refreshDirty = () => {
      if (isNew) { dirtyLabel.textContent = ''; return; }
      const patch = diffPayload(readLocationForm(form), loc);
      const keys = Object.keys(patch);
      dirtyLabel.textContent = keys.length ? `will send: ${keys.join(', ')}` : 'no changes';
      saveBtn.disabled = keys.length === 0;
    };
    form.addEventListener('input', refreshDirty);
    form.addEventListener('change', refreshDirty);

    saveBtn.onclick = () => saveLocation(loc, form, saveBtn);

    const actions = h('div', { class: 'editor-actions' },
      saveBtn,
      h('button', {
        // Cancel goes back to reading the record, not to nothing. You were
        // looking at it before you chose to edit.
        class: 'btn secondary', type: 'button', text: 'Cancel',
        onclick: () => {
          state.editing = false;
          if (isNew) selectLocation(null);
          else renderLocationDetail(loc);
        },
      }),
      dirtyLabel,
      h('span', { class: 'spacer' }),
      isNew ? null : h('button', {
        class: 'btn danger', type: 'button', text: 'Delete',
        onclick: () => deleteLocation(loc),
      }),
    );

    replace($('#loc-editor'),
      h('h2', { text: isNew ? 'New location' : `Editing: ${loc.name}` }),
      isNew ? null : h('p', { class: 'muted' }, `id ${loc.id} · modified `, timeEl(loc.modified_at)),
      form, actions);

    refreshDirty();
    if (isNew) saveBtn.disabled = false;
  }

  const TAG_FIELDS = ['slug', 'name', 'description', 'sort_order'];

  /**
   * Paint server-side field errors next to the inputs they belong to.
   *
   * `fields` is the form's own writable set: the location list for the record
   * editor, the tag list for the tag editor. Using one shared list would leave
   * "slug must be lowercase…" with nowhere to land, and an error the admin has
   * to hunt for reads as "the save just did not work".
   */
  function applyFieldErrors(form, errors, fields = WRITABLE) {
    form.querySelectorAll('.field.invalid').forEach((el) => {
      el.classList.remove('invalid');
      el.querySelector('.msg')?.remove();
    });
    for (const message of errors) {
      // The validator's messages lead with the field name where there is one
      // ("name must be…"), with two shapes that do not. Anything still
      // unmatched shows in the banner, so nothing is swallowed.
      const key = message.startsWith('unknown tag(s)') ? 'tags'
        : message.startsWith('id cannot be set') ? null
          : fields.find((k) => message.startsWith(k) || message.startsWith(`unknown field: ${k}`));
      const target = key && form.querySelector(`.field[data-field="${key}"]`);
      if (!target) continue;
      target.classList.add('invalid');
      target.append(h('p', { class: 'msg', text: message }));
    }
  }

  async function saveLocation(loc, form, button) {
    const isNew = !loc.id;
    const current = readLocationForm(form);
    const payload = isNew ? current : diffPayload(current, loc);

    if (!isNew && Object.keys(payload).length === 0) {
      banner('warn', 'Nothing changed, so nothing was sent.');
      return;
    }

    button.disabled = true;
    const res = isNew
      ? await api('/admin/locations', { method: 'POST', body: payload })
      : await api(`/admin/locations/${encodeURIComponent(loc.id)}`, {
        method: 'PATCH',
        body: payload,
        // The version this editor was opened on. The server applies the write
        // only while the record still carries it, so two admins editing the
        // same record cannot silently overwrite each other.
        headers: { 'If-Match': `"${loc.modified_at}"` },
      });
    button.disabled = false;

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      if (res.status === 422) applyFieldErrors(form, res.body.errors || []);
      // A stale write comes back with the record as it stands now. Load it, so
      // the next save is against a version that exists and the admin can see
      // what they would have overwritten.
      if (res.body?.error === 'stale_write' && res.body.current) {
        await loadLocations();
        renderLocationEditor(res.body.current);
      }
      return;
    }

    await loadLocations();
    // Tag usage counts live on the tag records, and a location's tags just
    // moved. Without this the Tags tab and the slug-rename warning keep
    // showing the count from before the edit. That warning exists to say how
    // many records a rename will re-point, so a stale count there is the one
    // number that must not be wrong.
    if (Object.prototype.hasOwnProperty.call(payload, 'tags')) await loadTags();

    // Back to reading it: the save is done, so the form has nothing left to say.
    state.editing = false;
    selectLocation(res.body.location.id);
    // AFTER selectLocation, not before: it calls clearBanner(), so a
    // confirmation set first is wiped by the navigation that follows it. Every
    // successful save reported nothing at all.
    banner('ok', isNew
      ? `Created "${res.body.location.name}".`
      : `Saved ${Object.keys(payload).join(', ')} on "${res.body.location.name}".`);
  }

  async function deleteLocation(loc) {
    // `hidden` keeps the row and pulls the pin; delete is for records that
    // should never have existed. Say so, rather than asking "are you sure?".
    const ok = confirm(
      `Delete "${loc.name}" outright?\n\n`
      + 'The full record is preserved in the audit log, so this is recoverable. If you only '
      + 'only want it off the map, set the status to "hidden" instead.',
    );
    if (!ok) return;

    const res = await api(`/admin/locations/${encodeURIComponent(loc.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }
    banner('ok', `Deleted "${loc.name}". The record is in the audit log if you need it back.`);
    state.selectedLocation = null;
    // This clears the pane itself rather than going through selectLocation, so
    // it has to unwind the stacked-layout view switch on its own.
    closeDetail();
    await loadLocations();
    replace($('#loc-editor'), h('p', { class: 'muted', text: 'Select a location to view it, or create a new one.' }));
  }

  /**
   * Read-only view of a record.
   *
   * Opening a record shows it; changing it is a separate act. A row click that
   * opened a live form would make every browse a potential edit: one stray
   * keystroke in a focused field marks a record dirty that was only being read.
   */
  function renderLocationDetail(loc) {
    const row = (label, value, cls) => [
      h('dt', { text: label }),
      value === null || value === undefined || value === ''
        ? h('dd', { class: 'empty', text: 'not set' })
        : h('dd', { class: cls || null }, value),
    ];

    const coords = loc.coordinates.map((n) => Number(n).toFixed(3)).join(', ');

    replace($('#loc-editor'),
      h('h2', { text: loc.name }),
      h('div', { class: 'detail' }, h('dl', {},
        row('Status', h('span', { class: `badge status-${loc.status}`, text: loc.status })),
        row('Category', categoryTag(loc.category)),
        row('Tags', tagsOf(loc).length
          ? tagsOf(loc).map((t) => h('span', { class: 'badge', text: t }))
          : null),
        row('Authors', (loc.authors || []).join(', ')),
        row('Credits', loc.credits),
        row('Nexus ID', loc.nexus_id ? nexusLink(loc.nexus_id) : null),
        row('Coordinates', coords, 'mono'),
        row('Yaw', loc.yaw === null || loc.yaw === undefined ? null : String(loc.yaw), 'mono'),
        row('District', state.districtById.get(loc.id)),
        row('Description', loc.description),
        // Internal, and never served on /v1. Worth showing plainly here.
        row('Admin notes', loc.admin_notes),
        row('ID', loc.id, 'mono'),
        row('Added', timeEl(loc.added_at)),
        row('Modified', timeEl(loc.modified_at)),
        row('Updated on Nexus', loc.nexus_updated_at ? timeEl(loc.nexus_updated_at) : null),
      )),
      h('div', { class: 'editor-actions' },
        h('button', {
          class: 'btn', type: 'button', text: 'Edit',
          onclick: () => { state.editing = true; renderLocationEditor(loc); },
        }),
        h('button', {
          class: 'btn secondary', type: 'button', text: 'Close',
          onclick: () => selectLocation(null),
        }),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn danger', type: 'button', text: 'Delete',
          onclick: () => deleteLocation(loc),
        })));
  }

  /**
   * @param {string|null} id  a location id, '' for a new record, null for none
   * @param {object} [prefill]  fields a new record starts with. The Candidates
   *   tab passes the mod's name and nexus id, which is everything that is known
   *   without a person standing in the location with CET open. Ignored for an
   *   existing record: prefilling over stored values would be an edit disguised
   *   as a navigation.
   */
  function selectLocation(id, prefill) {
    state.selectedLocation = id;
    state.editing = id === '';   // a new record has nothing to view
    clearBanner();
    if (id === null) {
      closeDetail();
      renderLocations();
      return replace($('#loc-editor'),
        h('p', { class: 'muted', text: 'Select a location to view it, or create a new one.' }));
    }
    if (id === '') switchTab('locations');
    renderLocations();
    const loc = id === ''
      ? { ...BLANK_LOCATION, ...(prefill || {}) }
      : state.locations.find((l) => l.id === id);
    // Nothing to show, so nothing to navigate to: a stacked layout that switched
    // view here would leave the reader on an empty pane with no list behind it.
    if (!loc) return;
    openDetail('locations');
    if (state.editing) renderLocationEditor(loc);
    else renderLocationDetail(loc);
  }

  // ---------------------------------------------------------------- tags --

  function renderTags() {
    replace($('#tag-rows'), state.tags.map((tag) => h('tr', {
      'aria-selected': tag.slug === state.selectedTag ? 'true' : 'false',
      onclick: () => selectTag(tag.slug),
      style: 'cursor:pointer',
    },
    h('td', {}, h('code', { text: tag.slug })),
    h('td', {}, tag.name || h('span', { class: 'muted', text: '(falls back to the slug)' })),
    h('td', {}, tag.description),
    h('td', { class: 'num' }, String(tag.usage_count)))));
  }

  async function loadTags() {
    const res = await api('/admin/tags');
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      return false;
    }
    state.tags = res.body.tags || [];
    renderTags();
    return true;
  }

  const BLANK_TAG = { slug: '', name: null, description: '', sort_order: null, usage_count: 0 };

  function renderTagEditor(tag) {
    const isNew = !tag.slug;

    const slugInput = input('slug', tag.slug, isNew ? {} : { disabled: true });
    const nameInput = input('name', tag.name ?? '', { placeholder: 'blank falls back to the slug' });
    const descInput = h('textarea', { name: 'description', maxlength: '500' }, tag.description || '');
    const orderInput = input('sort_order', tag.sort_order ?? '', { type: 'number', step: '1' });

    const slugField = field('Slug', slugInput);
    let slugUnlocked = isNew;

    if (!isNew) {
      // Renaming a slug is an ON UPDATE CASCADE through location_tags and a
      // link-breaking event: anything pointing at ?tag=<slug> stops resolving.
      // Routine relabelling is what `name` is for, so the identifier is
      // read-only until it is deliberately unlocked.
      const warning = h('div', { class: 'slug-warning', hidden: true },
        'Renaming the identifier re-points every location that uses it '
        + `(${tag.usage_count} right now) and breaks any existing ?tag=${tag.slug} link. `
        + 'To relabel this tag without breaking anything, edit its Name instead.');
      const unlock = h('button', {
        class: 'btn secondary', type: 'button', text: 'Edit identifier',
        onclick: () => {
          slugUnlocked = !slugUnlocked;
          slugInput.disabled = !slugUnlocked;
          warning.hidden = !slugUnlocked;
          unlock.textContent = slugUnlocked ? 'Keep identifier' : 'Edit identifier';
          if (!slugUnlocked) slugInput.value = tag.slug;
          else slugInput.focus();
        },
      });
      slugField.append(h('div', { class: 'slug-lock' },
        h('span', { class: 'muted', text: 'Locked. Editing it re-points existing records.' }), unlock));
      slugField.append(warning);
    }

    const form = h('form', { autocomplete: 'off', onsubmit: (e) => e.preventDefault() },
      slugField,
      field('Name', nameInput, 'The display label. Safe to change at any time.'),
      field('Description', descInput),
      field('Sort order', orderInput, 'Controls the order tags appear in on the site. Blank sorts last.'),
    );

    const saveBtn = h('button', { class: 'btn', type: 'button', text: isNew ? 'Create tag' : 'Save changes' });
    saveBtn.onclick = () => saveTag(tag, form, saveBtn, () => slugUnlocked);

    const actions = h('div', { class: 'editor-actions' },
      saveBtn,
      h('button', {
        class: 'btn secondary', type: 'button', text: 'Cancel',
        onclick: () => (isNew ? selectTag(null) : renderTagDetail(tag)),
      }),
      h('span', { class: 'spacer' }),
      isNew ? null : h('button', {
        class: 'btn danger', type: 'button', text: 'Delete', onclick: () => deleteTag(tag),
      }),
    );

    replace($('#tag-editor'),
      h('h2', { text: isNew ? 'New tag' : `Editing: ${tag.slug}` }),
      isNew ? null : h('p', { class: 'muted', text: `used by ${tag.usage_count} location(s)` }),
      form, actions);
  }

  async function saveTag(tag, form, button, slugUnlocked) {
    const isNew = !tag.slug;
    const name = form.elements.name.value.trim();
    const order = form.elements.sort_order.value.trim();

    const current = {
      slug: form.elements.slug.value.trim(),
      name: name === '' ? null : name,
      description: form.elements.description.value.trim(),
      sort_order: order === '' ? null : Number(order),
    };

    let payload;
    if (isNew) {
      payload = current;
    } else {
      payload = {};
      for (const key of ['name', 'description', 'sort_order']) {
        if (!sameValue(current[key], tag[key])) payload[key] = current[key];
      }
      // The slug only travels when it was deliberately unlocked AND changed.
      if (slugUnlocked() && current.slug !== tag.slug) payload.slug = current.slug;
      if (Object.keys(payload).length === 0) return banner('warn', 'Nothing changed, so nothing was sent.');
    }

    if (payload.slug && payload.slug !== tag.slug && !isNew) {
      const ok = confirm(
        `Rename "${tag.slug}" to "${payload.slug}"?\n\n`
        + `${tag.usage_count} location(s) will be re-pointed, and any existing `
        + `?tag=${tag.slug} link will stop working.`,
      );
      if (!ok) return;
    }

    button.disabled = true;
    const res = isNew
      ? await api('/admin/tags', { method: 'POST', body: payload })
      : await api(`/admin/tags/${encodeURIComponent(tag.slug)}`, { method: 'PATCH', body: payload });
    button.disabled = false;

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      if (res.status === 422) applyFieldErrors(form, res.body.errors || [], TAG_FIELDS);
      return;
    }

    await Promise.all([loadTags(), loadLocations()]);
    selectTag(res.body.tag.slug);
    // After selectTag for the same reason as saveLocation: it clears the banner.
    banner('ok', isNew ? `Created tag "${res.body.tag.slug}".` : `Saved tag "${res.body.tag.slug}".`);
  }

  /**
   * Delete, or explain why not.
   *
   * The API refuses a tag that is still attached (409 `tag_in_use`) rather than
   * cascading, so the answer here is a list of what is in the way, not a
   * failure message. Detaching is the admin's decision to make, one record at a
   * time or in bulk, and this is what turns that into a next step.
   */
  async function deleteTag(tag) {
    const res = await api(`/admin/tags/${encodeURIComponent(tag.slug)}`, { method: 'DELETE' });

    if (res.status === 409 && res.body.error === 'tag_in_use') {
      const jump = h('button', {
        class: 'btn secondary', type: 'button', text: `Show the ${res.body.usage_count} location(s)`,
        // A real tag filter, not a text search for the slug: searching would
        // also match a location whose NAME contains the word.
        onclick: () => setFilter({ tag: tag.slug }, { reset: true, go: true }),
      });
      return banner('error',
        `"${tag.slug}" is still attached to ${res.body.usage_count} location(s), so it was not deleted. `
        + 'Remove it from those records first. Nothing was changed.',
        h('div', { style: 'margin-top:var(--space-sm)' },
          h('ul', {}, res.body.locations.map((l) => h('li', { text: l.name }))),
          jump));
    }

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }

    banner('ok', `Deleted tag "${tag.slug}".`);
    state.selectedTag = null;
    await loadTags();
    replace($('#tag-editor'), h('p', { class: 'muted', text: 'Select a tag to view it, or create a new one.' }));
  }

  /** Read-only view of a tag, for the same reason locations have one. */
  function renderTagDetail(tag) {
    const row = (label, value, cls) => [
      h('dt', { text: label }),
      value === null || value === undefined || value === ''
        ? h('dd', { class: 'empty', text: 'not set' })
        : h('dd', { class: cls || null }, value),
    ];

    replace($('#tag-editor'),
      h('h2', { text: tag.slug }),
      h('div', { class: 'detail' }, h('dl', {},
        row('Slug', tag.slug, 'mono'),
        row('Name', tag.name ?? null),
        row('Description', tag.description),
        row('Sort order', tag.sort_order === null || tag.sort_order === undefined
          ? null : String(tag.sort_order), 'mono'),
        row('Used by', `${tag.usage_count} location(s)`),
      )),
      h('div', { class: 'editor-actions' },
        h('button', {
          class: 'btn', type: 'button', text: 'Edit',
          onclick: () => renderTagEditor(tag),
        }),
        tag.usage_count > 0 ? h('button', {
          class: 'btn secondary', type: 'button', text: `Show the ${tag.usage_count} location(s)`,
          onclick: () => setFilter({ tag: tag.slug }, { reset: true, go: true }),
        }) : null,
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn danger', type: 'button', text: 'Delete',
          onclick: () => deleteTag(tag),
        })));
  }

  function selectTag(slug) {
    state.selectedTag = slug;
    clearBanner();
    if (slug === null) {
      closeDetail();
      renderTags();
      return replace($('#tag-editor'),
        h('p', { class: 'muted', text: 'Select a tag to view it, or create a new one.' }));
    }
    renderTags();
    const tag = slug === '' ? { ...BLANK_TAG } : state.tags.find((t) => t.slug === slug);
    if (!tag) return;
    openDetail('tags');
    // A new tag has nothing to view, so it opens straight in the form.
    if (slug === '') renderTagEditor(tag);
    else renderTagDetail(tag);
  }

  // --------------------------------------------------------------- queue --

  /**
   * The review queue.
   *
   * Every count on this page is derived here from the rows already fetched, and
   * the API has no aggregate to ask for. `decisions/api-per-location-records`
   * removed server-side aggregates because several consumers computing the same
   * counts independently produced bug #823, and a "3 pending" badge that
   * disagrees with a three-row list is exactly that bug wearing a new hat.
   */
  const pendingSubmissions = () => state.submissions.filter((s) => s.status === 'pending');

  const KIND_LABEL = { create: 'new pin', edit: 'edit', remove: 'removal' };

  /** The location a submission refers to, or null for a create. */
  const subjectOf = (sub) => (sub.location_id
    ? state.locations.find((l) => l.id === sub.location_id) ?? null
    : null);

  /** What the row says this submission is about. */
  function subjectLabel(sub) {
    if (sub.kind === 'create') return sub.payload?.name || '(unnamed)';
    const loc = subjectOf(sub);
    // A submission can outlive its location. Saying so beats rendering a blank
    // cell, which reads as a submission about nothing.
    return loc ? loc.name : `${sub.location_id} (deleted)`;
  }

  /**
   * The mod a submission is about.
   *
   * A create carries it in the payload; an edit or a removal names a location,
   * and the mod is whatever that location points at. An edit may also propose a
   * new nexus_id, and the proposed one is the right answer there: it is the one
   * the reviewer has to go and check.
   */
  function submissionNexusId(sub) {
    return sub.payload?.nexus_id ?? subjectOf(sub)?.nexus_id ?? null;
  }

  /**
   * A timestamp as "2h ago", with both exact values on hover.
   *
   * Relative on screen because "2h ago" is what a reviewer is actually asking,
   * and because an elapsed time is the one rendering of a timestamp that means
   * the same thing in every timezone. The labelled local time and the stored
   * UTC are both on the tooltip.
   *
   * A future timestamp reads as "just now" rather than "-2h ago". Submissions
   * are stamped by the Worker, so this only happens when the reviewer's own
   * clock is behind, and a negative age puts that skew on screen as though it
   * were a property of the submission.
   */
  function whenCell(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return h('span', { class: 'muted', text: 'unknown' });
    const seconds = (Date.now() - ms) / 1000;
    return h('time', {
      datetime: iso,
      title: `${formatTime(iso)}\n${iso} (UTC, as stored)`,
      text: seconds < 0 ? 'just now' : describeAge(seconds),
    });
  }

  function renderQueue() {
    const shown = state.queueStatus
      ? state.submissions.filter((s) => s.status === state.queueStatus)
      : state.submissions;

    replace($('#queue-rows'), shown.map((sub) => h('tr', {
      'aria-selected': sub.id === state.selectedSubmission ? 'true' : 'false',
      onclick: () => selectSubmission(sub.id),
      style: 'cursor:pointer',
    },
    h('td', {}, whenCell(sub.created_at)),
    h('td', {}, h('span', { class: `badge kind-${sub.kind}`, text: KIND_LABEL[sub.kind] ?? sub.kind })),
    h('td', {}, subjectLabel(sub)),
    h('td', {}, h('span', { class: `badge review-${sub.status}`, text: sub.status.replace(/_/g, ' ') })))));

    const pending = pendingSubmissions().length;
    $('#queue-summary').textContent = state.submissions.length === 0
      ? 'Nothing has ever been submitted.'
      : `${shown.length} shown, ${pending} pending of ${state.submissions.length} total.`;

    // Only a non-zero count earns a badge: a "0" beside the tab is a standing
    // invitation to check a queue that has nothing in it.
    $('#queue-count').textContent = pending ? String(pending) : '';
    syncNavBadge();
  }

  async function loadQueue() {
    const res = await api('/admin/submissions');
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      return false;
    }
    state.submissions = res.body.submissions || [];
    renderQueue();
    return true;
  }

  /**
   * What this submission would change, and nothing else.
   *
   * renderDiff drops keys whose value is unchanged, so a payload that repeats
   * the record back renders as "no field changes" rather than as a wall of
   * identical lines. A reviewer reads "yaw: 90 -> 45", not the record twice.
   */
  function submissionDiff(sub) {
    if (sub.kind === 'create') return renderDiff(null, sub.payload);
    if (sub.kind === 'remove') {
      return h('p', { class: 'muted', text: 'A removal changes no field. It asks for the pin to come off the map.' });
    }
    const loc = subjectOf(sub);
    if (!loc) return h('p', { class: 'notice error', text: 'The location this edit refers to no longer exists, so there is nothing to compare against. Approving it will be refused.' });
    const before = {};
    for (const key of Object.keys(sub.payload)) before[key] = loc[key];
    return renderDiff(before, sub.payload);
  }

  /**
   * Locations already on the registry for the same mod.
   *
   * A match is NOT a duplicate. One Nexus mod supplies more than one location
   * (23896 supplies two tattoo shops), so `nexus_id` is deliberately not unique
   * and a second pin from the same mod is a normal thing to approve. This is
   * context for that decision, not a warning about it.
   *
   * The distance is the part that decides it: 30m from an existing pin is
   * almost certainly the same place submitted twice, 2km is a second location.
   */
  function siblingLocations(sub) {
    const nexusId = sub.payload?.nexus_id;
    if (sub.kind !== 'create' || !nexusId) return [];
    const proposed = sub.payload?.coordinates;
    return state.locations
      .filter((l) => String(l.nexus_id) === String(nexusId))
      .map((l) => ({
        location: l,
        // CET units, and NCZ.CET_UNITS_PER_METER is 1, so this is metres. Z is
        // left out on purpose: two pins on different floors of one building are
        // the same place for the question being asked here.
        metres: proposed && l.coordinates
          ? Math.hypot(proposed[0] - l.coordinates[0], proposed[1] - l.coordinates[1])
          : null,
      }))
      .sort((a, b) => (a.metres ?? Infinity) - (b.metres ?? Infinity));
  }

  /**
   * The panel that says "this mod is already on the map", and what to do about
   * it when the record it finds is HIDDEN.
   *
   * A hidden match is the resubmission case: a removal was approved, the record
   * went hidden, and now the same mod is back. Approving normally would leave
   * two rows for one pin. Restoring puts the curated record back instead, and
   * still resolves the submission as approved, because the request was granted.
   */
  function siblingPanel(sub) {
    const siblings = siblingLocations(sub);
    if (!siblings.length) return null;

    const hidden = siblings.filter((s) => s.location.status === 'hidden');
    const rows = siblings.map(({ location, metres }) => h('div', { class: 'sibling' },
      h('div', {},
        h('strong', { text: location.name }), ' ',
        h('span', { class: `badge status-${location.status}`, text: location.status }),
        h('p', { class: 'muted', text: metres === null
          ? 'no coordinates to compare'
          : `${Math.round(metres).toLocaleString()} m from the proposed pin` })),
      h('div', { class: 'candidate-actions' },
        location.status === 'hidden'
          ? h('button', {
            class: 'btn', type: 'button', text: 'Restore this instead',
            title: 'Puts this record back on the map as it stands, and marks the submission approved. The submitted coordinates are not applied.',
            onclick: (e) => approveByRestoring(sub, location, e.currentTarget),
          })
          : h('button', {
            class: 'btn secondary', type: 'button', text: 'Open it',
            onclick: () => selectLocation(location.id),
          }))));

    return h('div', { class: `sibling-panel${hidden.length ? ' has-hidden' : ''}` },
      h('p', { class: 'muted', text: hidden.length
        ? `This mod already has a HIDDEN record. That usually means a removal was approved and the mod has been submitted again: restoring keeps one record instead of creating a second.`
        : `This mod already supplies ${siblings.length} location(s). That is allowed, and normal. Check the distances before approving a second pin.` }),
      rows);
  }

  /** Grant a create by putting an existing hidden record back on the map. */
  async function approveByRestoring(sub, location, button) {
    const ok = confirm(
      `Restore "${location.name}" and approve this submission?\n\n`
      + 'The record goes back on the map exactly as it is stored. The submitted '
      + 'coordinates and description are NOT applied, and no second record is created.',
    );
    if (!ok) return;

    button.disabled = true;
    const res = await api(`/admin/submissions/${sub.id}/approve`, {
      method: 'POST',
      body: { restore_location_id: location.id },
    });
    button.disabled = false;

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      if (res.status === 409) await Promise.all([loadQueue(), loadLocations()]);
      return;
    }

    await loadLocations();
    await loadQueue();
    selectSubmission(sub.id);
    banner('ok', `Restored "${res.body.location.name}" and approved the submission. No second record was created.`);
  }

  /** The coordinates a submission wants, and the ones it moves away from. */
  function submissionPins(sub) {
    const loc = subjectOf(sub);
    const proposed = sub.payload?.coordinates ?? (sub.kind === 'create' ? null : loc?.coordinates);
    const pins = [];
    // Current first, so the proposed pin draws on top of it when they overlap.
    if (loc && loc.coordinates && !sameValue(loc.coordinates, proposed)) {
      pins.push({ coords: loc.coordinates, kind: 'current', label: 'current' });
    }
    if (proposed) pins.push({ coords: proposed, kind: 'proposed', label: 'proposed' });
    return pins;
  }

  /**
   * An inline map of the proposed pin.
   *
   * Coordinates cannot be checked by eye, and "this is in the bay" or "this is
   * 4km from the mod it belongs to" is the most common thing wrong with a
   * submission. Reuses NCZ.cetToLeaflet from the map's own utils.js rather than
   * carrying a second copy of the transform.
   *
   * The Leaflet instance is created AFTER the element is in the document: a map
   * built against a detached node measures a zero-sized container and renders a
   * single tile in the corner.
   */
  function miniMap(pins) {
    const el = h('div', { class: 'mini-map' });
    if (!pins.length || typeof L === 'undefined') return el;

    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const map = L.map(el, {
        crs: L.CRS.Simple,
        minZoom: 0,
        maxZoom: 6,
        attributionControl: false,
        zoomControl: false,
      });
      // Same projection the map uses: the tile set is 16384px square at z6.
      const bounds = L.latLngBounds(map.unproject([0, 16384], 6), map.unproject([16384, 0], 6));
      L.tileLayer('../assets/tiles/{z}/{x}/{y}.webp?v=1', {
        minZoom: 0, maxNativeZoom: 6, maxZoom: 6, tileSize: 256, noWrap: true, bounds,
      }).addTo(map);

      const latlngs = pins.map((pin) => {
        const [x, y] = pin.coords;
        const at = NCZ.cetToLeaflet(x, y);
        L.circleMarker(at, {
          radius: pin.kind === 'proposed' ? 7 : 5,
          color: pin.kind === 'proposed' ? '#00f0ff' : '#ffb300',
          weight: 2,
          fillOpacity: pin.kind === 'proposed' ? 0.6 : 0.2,
        }).addTo(map).bindTooltip(`${pin.label}: ${x}, ${y}`);
        return at;
      });

      if (latlngs.length > 1) map.fitBounds(L.latLngBounds(latlngs).pad(0.6));
      else map.setView(latlngs[0], 4);
      // The pane is display:none until its tab is shown, so a map built while
      // hidden has measured nothing. Cheap, and wrong-sized otherwise.
      state.reviewMap = map;
      map.invalidateSize();
    });
    return el;
  }

  /** Drop the current mini-map before its container goes away. */
  function releaseReviewMap() {
    state.reviewMap?.remove?.();
    state.reviewMap = null;
  }

  function renderSubmissionReview(sub) {
    releaseReviewMap();
    const resolved = sub.status !== 'pending';
    const reason = h('textarea', {
      placeholder: resolved ? '' : 'Required to reject or request changes. Kept on the record.',
      maxlength: '1000',
    });

    const detail = (label, value) => (value
      ? [h('dt', { text: label }), h('dd', {}, value)]
      : []);

    const actions = resolved
      ? h('p', { class: 'muted' },
        `${sub.status.replace(/_/g, ' ')} by ${sub.reviewed_by ?? 'unknown'}`,
        sub.reviewed_at ? [' on ', timeEl(sub.reviewed_at)] : '')
      : h('div', { class: 'editor-actions' },
        h('button', {
          class: 'btn', type: 'button', text: 'Approve',
          onclick: (e) => reviewAction(sub, 'approve', reason, e.currentTarget),
        }),
        h('button', {
          class: 'btn secondary', type: 'button', text: 'Hold',
          title: 'Park it, pending a decision between reviewers. Nothing is sent to the submitter.',
          onclick: (e) => reviewAction(sub, 'hold', reason, e.currentTarget),
        }),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn danger', type: 'button', text: 'Reject',
          onclick: (e) => reviewAction(sub, 'reject', reason, e.currentTarget),
        }));

    replace($('#queue-review'),
      h('h2', { text: `${KIND_LABEL[sub.kind] ?? sub.kind}: ${subjectLabel(sub)}` }),
      h('p', { class: 'muted' }, `submission ${sub.id} · `, whenCell(sub.created_at)),

      h('div', { class: 'detail' }, h('dl', {},
        // First, because "is this even a location mod" is answered on the mod
        // page and nowhere in this payload.
        ...detail('Mod', submissionNexusId(sub) ? nexusLink(submissionNexusId(sub)) : null),
        ...detail('From the submitter', sub.submitter_note),
        // Optional, and only ever for asking a question about this submission.
        ...detail('Contact', sub.submitter_contact),
        ...detail('Reason given', sub.kind === 'remove' ? sub.payload?.reason : null),
        ...detail('Review note', sub.review_note))),

      h('h2', { text: 'What it changes' }),
      submissionDiff(sub),

      // Only for a create, and only when the mod is already on the map. Sits
      // above the actions because it can change which action is right.
      resolved ? null : siblingPanel(sub),

      h('h2', { text: 'Where' }),
      miniMap(submissionPins(sub)),

      resolved ? null : field('Reason', reason,
        'Required to reject or hold. Optional on approve, where it is kept as a note.'),
      resolved ? null : reachability(sub),
      actions);
  }

  /**
   * Whether anything you write here can reach the person who sent it.
   *
   * Nothing delivers a review note. Submissions are anonymous, there is no
   * route by which a submitter can read their own row, and `submitter_contact`
   * is optional free text that a human has to act on. Hold means parked, not
   * "sent back", and the reviewer should know which of those they are getting.
   */
  function reachability(sub) {
    return sub.submitter_contact
      ? h('p', { class: 'muted' },
        'Nothing is sent automatically. To ask for a change you have to contact ',
        h('strong', { text: sub.submitter_contact }), ' yourself.')
      : h('p', { class: 'muted' },
        'No contact was given, so nothing written here can reach the submitter. '
        + 'The reason is kept on the record, and Hold parks it for the three of us to decide.');
  }

  function selectSubmission(id) {
    state.selectedSubmission = id;
    clearBanner();
    if (id === null) {
      closeDetail();
      releaseReviewMap();
      renderQueue();
      return replace($('#queue-review'), h('p', { class: 'muted', text: 'Select a submission to review it.' }));
    }
    renderQueue();
    const sub = state.submissions.find((s) => s.id === id);
    if (!sub) return;
    openDetail('queue');
    renderSubmissionReview(sub);
  }

  const REVIEW_VERB = { approve: 'Approved', reject: 'Rejected', hold: 'Put on hold' };

  /**
   * Approve, reject, or send back.
   *
   * The reason is checked here only so the reviewer is told before a round
   * trip; the server enforces it, and that is where the rule lives. A client
   * check is UX, never the enforcement point.
   */
  async function reviewAction(sub, action, reasonEl, button) {
    const reason = reasonEl.value.trim();
    if (action !== 'approve' && !reason) {
      reasonEl.focus();
      return banner('warn', 'Give a reason. It is the only record of why this was turned down, and "no" on its own is not one.');
    }
    return sendReview(sub, action, reason ? { reason } : {}, button);
  }

  /**
   * The record moved after the submission was made, so the approval was
   * refused and nothing was written. The submission is still pending.
   *
   * Reloading first is not politeness: the diff is drawn against the location
   * list, so until that is refreshed the reviewer is reading the approval
   * against the very values it was refused for. Apply anyway re-sends against
   * the version now on screen, which means a third admin saving in between is
   * still caught rather than silently overwritten.
   */
  async function staleSubmission(sub, action, body, current) {
    await loadLocations();
    await loadQueue();
    // Clears the banner, so the banner is set after it. Same trap as saveLocation.
    selectSubmission(sub.id);

    const onScreen = state.locations.find((l) => l.id === current.id) ?? current;
    banner('warn',
      `"${onScreen.name}" changed after this submission was made, so nothing was applied. `
      + 'What it changes now compares against the current record. ',
      h('button', {
        class: 'btn', type: 'button', text: 'Apply anyway',
        title: 'Approves this submission over the record as it stands now, which replaces whatever changed.',
        onclick: (e) => sendReview(
          sub, action, { ...body, base_modified_at: onScreen.modified_at }, e.currentTarget,
        ),
      }));
  }

  /**
   * One review request and everything that follows from the answer.
   *
   * Split out from reviewAction because the stale-submission retry re-sends the
   * same decision after the queue has been reloaded, and by then the textarea
   * the reason was typed into no longer exists.
   */
  async function sendReview(sub, action, body, button) {
    button.disabled = true;
    const res = await api(`/admin/submissions/${sub.id}/${action}`, { method: 'POST', body });
    button.disabled = false;

    if (!res.ok) {
      // Its own path rather than a message: nothing was written, the submission
      // is still pending, and there is something the reviewer can do about it.
      if (res.body?.error === 'stale_submission' && res.body.current) {
        return staleSubmission(sub, action, body, res.body.current);
      }
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      // Someone else got there first, or the payload can no longer be applied.
      // Either way the queue on screen is out of date, so refresh it rather
      // than leaving a resolved submission looking actionable.
      if (res.status === 409 || res.status === 422) await loadQueue();
      return;
    }

    // An approval wrote to the registry, so the location list and everything
    // derived from it have moved.
    if (action === 'approve') await loadLocations();
    await loadQueue();
    selectSubmission(sub.id);
    // After selectSubmission, which clears the banner. Same trap as saveLocation.
    banner('ok', action === 'approve' && res.body.location
      ? `Approved. "${res.body.location.name}" is now ${res.body.location.status} in the registry.`
      : `${REVIEW_VERB[action]}.`);
  }

  // ---------------------------------------------------------- candidates --

  /**
   * Mods tagged NCZoning on Nexus that have no pin and have not been put aside.
   *
   * An empty list is a real answer and the panel says so in words. Measured on
   * staging while this was built: 41 tagged mods, 40 already locations, 1
   * dismissed, so zero candidates was correct. A blank panel with no
   * explanation is the version of this that costs an hour.
   */
  function candidateCard(entry, { dismissed }) {
    const body = h('div', { class: 'candidate-body' },
      h('div', { class: 'candidate-head' },
        h('strong', { text: entry.name || `mod ${entry.nexus_id}` }),
        nexusLink(entry.nexus_id, { label: `nexus ${entry.nexus_id}` })),
      entry.updated_at
        ? h('p', { class: 'muted' }, 'updated ', whenCell(entry.updated_at))
        : null,
      dismissed
        ? h('p', { class: 'muted', text: `${entry.reason || 'no reason given'}, by ${entry.dismissed_by}` })
        : null);

    const actions = h('div', { class: 'candidate-actions' });
    if (dismissed) {
      actions.append(h('button', {
        class: 'btn secondary', type: 'button', text: 'Restore',
        onclick: (e) => restoreCandidate(entry, e.currentTarget),
      }));
    } else {
      actions.append(
        h('button', {
          class: 'btn', type: 'button', text: 'Add to map',
          // Straight into the editor with the two fields a candidate carries:
          // the name and the nexus id. Coordinates have to come from a person
          // standing in the location, and are the part this cannot guess.
          onclick: () => selectLocation('', { name: entry.name || '', nexus_id: entry.nexus_id }),
        }),
        h('button', {
          class: 'btn secondary', type: 'button', text: 'Dismiss',
          onclick: (e) => promptDismiss(entry, e.currentTarget.closest('.candidate')),
        }),
      );
    }

    return h('div', { class: 'candidate' },
      entry.thumbnail_url
        ? h('img', { class: 'candidate-thumb', src: entry.thumbnail_url, alt: '', loading: 'lazy' })
        : h('div', { class: 'candidate-thumb empty' }),
      body, actions);
  }

  /** Dismissal takes a reason, so it opens a field rather than firing at once. */
  function promptDismiss(entry, card) {
    if (card.querySelector('.dismiss-form')) return;
    const reason = h('textarea', { placeholder: 'Why is this not a map location? Optional, and admin-only.', maxlength: '1000' });
    const form = h('div', { class: 'dismiss-form' },
      reason,
      h('div', { class: 'candidate-actions' },
        h('button', {
          class: 'btn', type: 'button', text: 'Dismiss it',
          onclick: (e) => dismissCandidate(entry, reason.value.trim(), e.currentTarget),
        }),
        h('button', {
          class: 'btn secondary', type: 'button', text: 'Cancel', onclick: () => form.remove(),
        })));
    card.append(form);
    reason.focus();
  }

  async function dismissCandidate(entry, reason, button) {
    button.disabled = true;
    const res = await api(`/admin/candidates/${encodeURIComponent(entry.nexus_id)}`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
    button.disabled = false;

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }
    await loadCandidates();
    banner('ok', `Dismissed "${entry.name || entry.nexus_id}". It is in the Dismissed list, and can be restored.`);
  }

  async function restoreCandidate(entry, button) {
    button.disabled = true;
    const res = await api(`/admin/candidates/${encodeURIComponent(entry.nexus_id)}`, { method: 'DELETE' });
    button.disabled = false;

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }
    await loadCandidates();
    banner('ok', `Restored "${entry.name || entry.nexus_id}" to the candidates list.`);
  }

  function renderCandidates() {
    const { candidates, dismissed } = state;

    replace($('#candidate-list'), candidates.length
      ? candidates.map((c) => candidateCard(c, { dismissed: false }))
      // Two numbers, because one empty list cannot tell "nothing qualifies"
      // apart from "nothing was ever swept".
      : h('p', { class: 'muted', text: 'No candidates. Every NCZoning-tagged mod either has a pin already or was dismissed.' }));

    replace($('#dismissed-list'), dismissed.length
      ? dismissed.map((d) => candidateCard(d, { dismissed: true }))
      : h('p', { class: 'muted', text: 'Nothing dismissed.' }));

    $('#candidates-note').textContent =
      `${candidates.length} waiting, ${dismissed.length} dismissed.`;
    $('#candidates-count').textContent = candidates.length ? String(candidates.length) : '';
    syncNavBadge();
  }

  async function loadCandidates() {
    const res = await api('/admin/candidates');
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      // Distinct from "no candidates": a failed read must never render as an
      // empty list, which is the most reassuring thing this panel could say.
      $('#candidates-note').textContent = 'Could not read the candidates list.';
      banner(kind, message);
      return false;
    }
    state.candidates = res.body.candidates || [];
    state.dismissed = res.body.dismissed || [];
    renderCandidates();
    return true;
  }

  // ----------------------------------------------------------- freshness --

  // Matches the external health monitor's threshold. The cron runs every 5
  // minutes, so anything past this is either a failing cron or, on staging,
  // no cron at all.
  const STALE_AFTER_S = 45 * 60;

  function describeAge(seconds) {
    if (seconds < 90) return `${Math.round(seconds)}s ago`;
    if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
  }

  /**
   * Read dataset age off /v1/health, which is public and uncached, so no extra route.
   *
   * An unreadable health check renders as `unknown`, never as fresh. A blank
   * or green indicator that actually means "I could not tell" is the same class
   * of lie as reporting an unrecognised status as a successful login.
   */
  async function refreshFreshness() {
    const el = $('#freshness');
    let age = null;
    try {
      // no-store for the same reason as renderOverview: a cached health payload
      // reports the age it had when it was cached, which is the one number here
      // that must never be stale.
      const res = await fetch(`${API}/v1/health`, { cache: 'no-store' });
      if (res.ok) age = (await res.json())?.data?.refresh_age_seconds ?? null;
    } catch { /* falls through to unknown */ }

    if (typeof age !== 'number') {
      el.className = 'freshness unknown';
      el.textContent = 'dataset age unknown';
      return;
    }
    const stale = age > STALE_AFTER_S;
    el.className = `freshness ${stale ? 'stale' : 'fresh'}`;
    el.textContent = `dataset ${describeAge(age)}`;
    el.title = stale
      ? 'The served dataset is older than the cron interval. Staging has no cron, so this is expected there until you rebuild.'
      : 'The served dataset is current.';
  }

  /**
   * Re-read every collection the dashboard holds, and repaint what is showing.
   *
   * The page loads each collection ONCE and keeps it in `state`. That is right
   * for a dashboard one person is driving, and wrong the moment the registry
   * moves underneath it: another reviewer's approval, a sync script, a hand-run
   * SQL statement. The stale copy looks identical to current data, which is the
   * whole problem with it.
   *
   * `Promise.all` because they are independent reads, and tags must not gate
   * locations here: this is a resync, not the boot sequence that builds the
   * editor's tag picker.
   *
   * @returns {Promise<boolean>} false when any read failed, so the caller does
   *   not paint a success banner over the failure's own message.
   */
  async function refreshAll() {
    const results = await Promise.all([
      loadTags(), loadLocations(), loadQueue(), loadCandidates(),
    ]);

    // A record open in the detail pane can have gone away in the meantime.
    // Leaving it on screen renders a deleted location as though it were still
    // there, editable, with a Save button that would 404.
    if (state.selectedLocation && !state.locations.some((l) => l.id === state.selectedLocation)) {
      selectLocation(null);
    }
    if (state.selectedSubmission
      && !state.submissions.some((s) => s.id === state.selectedSubmission)) {
      selectSubmission(null);
    }

    await refreshFreshness();
    // Recomputed rather than left: its numbers are derived from what was just
    // replaced, and the drift row exists to report exactly this comparison.
    if (!$('#tab-overview').hidden) await renderOverview();
    return results.every(Boolean);
  }

  /**
   * The store a dataset was built from, in words.
   *
   * The Worker records and returns the machine token `d1` (`worker/src/admin.js`,
   * both the `/admin/refresh` response and the `dataset.refresh` audit target).
   * "D1" is the name of a Cloudflare product, not a thing an admin has any
   * reason to know. Two call sites read it (the rebuild banner and the audit
   * sentence), so it is one map. A token this page has not been taught renders
   * as itself rather than as a blank.
   */
  const DATASET_SOURCE_LABEL = { d1: 'the registry' };
  const datasetSource = (s) => DATASET_SOURCE_LABEL[s] ?? s;

  /** Rebuild the served dataset from the registry. */
  async function rebuildDataset(button) {
    button.disabled = true;
    button.textContent = 'Rebuilding…';
    const res = await api('/admin/refresh', { method: 'POST' });
    button.disabled = false;
    button.textContent = 'Rebuild';

    if (!res.ok) {
      const [kind, message] = res.status === 500 && res.body?.error === 'refresh_failed'
        ? ['error', `The rebuild failed, so the previous dataset is still being served: ${res.body.detail}`]
        : describeFailure(res);
      await refreshFreshness();
      return banner(kind, message);
    }

    // Re-read the registry too, not just the age indicator. Rebuild says
    // "make this current" to the person clicking it, and a page that rebuilt
    // the served dataset while still showing its load-time copy of the
    // registry is telling them it did nothing. Runs BEFORE the banner, because
    // selectLocation/selectSubmission clear it.
    const ok = await refreshAll();
    if (!ok) return;

    // "Nothing changed" is a real outcome, not a nicer way of saying "done".
    // If the admin just edited a record and the rebuild reports no change,
    // that is worth knowing rather than smoothing over.
    banner('ok', res.body.changed
      ? `Rebuilt from ${datasetSource(res.body.source)}, and reloaded this page's data. New dataset version ${res.body.dataset_version}.`
      : `Rebuilt from ${datasetSource(res.body.source)}, and reloaded this page's data. The content hash was unchanged, so nothing was rewritten.`);
  }

  // ------------------------------------------------------------ overview --

  /**
   * The stats panel.
   *
   * EVERY number here is derived from records already fetched for the other
   * tabs. Do NOT add aggregate columns to the API or a stats table to D1:
   * `decisions/api-per-location-records` removed server-side aggregates because
   * several consumers computing the same counts independently produced bug
   * #823. This is another consumer that derives, not the first that
   * re-materializes.
   */
  function countBy(records, key) {
    const counts = new Map();
    for (const r of records) {
      for (const v of [].concat(key(r) ?? [])) {
        if (v === null || v === undefined || v === '') continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]));
  }

  /**
   * A headline number. `filter` makes it a button that shows you the records
   * behind it.
   *
   * Only tiles that lead somewhere become buttons: a hover state on an inert
   * number is a promise the UI does not keep.
   */
  const stat = (value, label, kind, filter) => {
    const inner = [
      h('span', { class: 'value', text: String(value) }),
      h('span', { class: 'label', text: label }),
    ];
    const cls = `stat${kind ? ` ${kind}` : ''}`;
    if (!filter || value === 0) return h('div', { class: cls }, inner);
    return h('button', {
      class: cls,
      type: 'button',
      title: `Show these ${value} record(s) in the locations list`,
      onclick: () => setFilter(filter, { reset: true, go: true }),
    }, inner);
  };

  /** A headline number for a collection that is not the location list. */
  const tabStat = (value, label, tab, kind) => h('button', {
    class: `stat${kind ? ` ${kind}` : ''}`,
    type: 'button',
    title: `Open the ${label} tab`,
    onclick: () => switchTab(tab),
  },
  h('span', { class: 'value', text: String(value) }),
  h('span', { class: 'label', text: label }));

  function breakdown(entries, total, filterFor) {
    if (!entries.length) return h('p', { class: 'muted', text: 'Nothing to count yet.' });
    const max = Math.max(...entries.map(([, n]) => n));
    return entries.map(([name, n]) => {
      const inner = [
        h('span', { class: 'k', text: String(name).replace(/-/g, ' ') }),
        // The bar is decoration on top of the number, never a replacement for it.
        h('span', { class: 'bar' }, h('span', { style: `width:${Math.round((n / max) * 100)}%` })),
        h('span', { class: 'n', text: total ? `${n}  (${Math.round((n / total) * 100)}%)` : String(n) }),
      ];
      if (!filterFor) return h('div', { class: 'breakdown-row' }, inner);
      return h('button', {
        class: 'breakdown-row',
        type: 'button',
        title: `Show the ${n} location(s) with ${name}`,
        onclick: () => setFilter(filterFor(name), { reset: true, go: true }),
      }, inner);
    });
  }

  const kvRow = (k, v, kind) => h('div', { class: 'kv-row' },
    h('span', { class: 'k', text: k }),
    h('span', { class: `v${kind ? ` ${kind}` : ''}`, text: v }));

  /**
   * Health, and the one comparison that matters most.
   *
   * `registry` is what D1 holds; `served` is what the public API returns. They
   * are two independent counts of the same thing, and a gap between them means
   * a write has not reached the map. Staging has no cron, so nothing there
   * closes that gap on its own and it can persist indefinitely.
   */
  async function renderOverview() {
    const records = state.locations;
    const published = records.filter((r) => r.status === 'published');

    const hidden = records.filter((r) => r.status === 'hidden').length;
    const untagged = records.filter((r) => !r.tags.length).length;

    replace($('#stat-registry'),
      stat(records.length, 'records', null, {}),
      stat(published.length, 'published', 'good', { status: 'published' }),
      stat(hidden, 'hidden', hidden ? 'warn' : null, { status: 'hidden' }),
      stat(records.filter((r) => r.status === 'draft').length, 'draft', null, { status: 'draft' }),
      stat(records.filter((r) => !/^\d+$/.test(String(r.nexus_id))).length, 'WIP / Dummy', null,
        { special: 'wip' }),
      // Tags are a different collection, so this one leads to the Tags tab, not
      // to a filtered location list. It is a count of tags, not of locations.
      h('button', {
        class: 'stat', type: 'button', title: 'Open the tag registry',
        onclick: () => switchTab('tags'),
      },
      h('span', { class: 'value', text: String(state.tags.length) }),
      h('span', { class: 'label', text: 'tags' })),
      stat(untagged, 'untagged', untagged ? 'warn' : null, { special: 'untagged' }),

      // Counts of other collections, so they lead to their own tabs. Both are
      // derived from rows already fetched: no aggregate route, no stats table.
      tabStat(pendingSubmissions().length, 'pending review', 'queue',
        pendingSubmissions().length ? 'warn' : null),
      tabStat(state.candidates.length, 'candidates', 'candidates'),
      tabStat(state.alertsUnacknowledged, 'open alerts', 'alerts',
        state.alertsUnacknowledged ? 'warn' : null));

    renderOverviewAlerts();

    replace($('#stat-category'),
      breakdown(countBy(records, (r) => r.category), records.length, (name) => ({ category: name })));
    replace($('#stat-tag'),
      breakdown(countBy(records, (r) => r.tags), records.length, (name) => ({ tag: name })));

    // --- health, from the public endpoints -------------------------------
    let health = null;
    let servedCount = null;
    let servedDistricts = [];
    try {
      // `cache: 'no-store'` is load-bearing, not hygiene. /v1/locations is
      // served `public, max-age=300`, so a default fetch can answer from the
      // browser's copy from before the last rebuild, which made the drift row
      // below report 296 against 297 when the origin already had both at 297.
      //
      // A drift alarm that fires spuriously is worse than none: it trains the
      // reader to dismiss it, and the one time it is real it looks identical.
      // The comparison is "what does the ORIGIN serve now", so ask the origin.
      const [h1, l1] = await Promise.all([
        fetch(`${API}/v1/health`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/v1/locations`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      ]);
      health = h1?.data ?? null;
      if (Array.isArray(l1?.data)) {
        servedCount = l1.data.length;
        servedDistricts = countBy(l1.data, (r) => r.district);
        // District is assigned by the materializer and is not on the admin
        // record, so this is the only place it can be learned. Cached on state
        // so the list filter and the detail view can both use it.
        state.districtById = new Map(l1.data.map((r) => [r.id, r.district]));
      }
    } catch { /* rendered as unknown below */ }

    replace($('#stat-district'),
      breakdown(servedDistricts, servedCount ?? 0, (name) => ({ district: name })));

    const rows = [];
    if (!health) {
      // Unreadable is its own state. Never draw a blank as healthy.
      rows.push(kvRow('status', 'could not reach the API', 'bad'));
    } else {
      const age = health.refresh_age_seconds;
      const stale = typeof age === 'number' && age > STALE_AFTER_S;
      rows.push(kvRow('status', health.status ?? 'unknown', health.status === 'ok' ? 'ok' : 'bad'));
      rows.push(kvRow('api version', health.version ?? 'not reported'));
      rows.push(kvRow('last refresh', typeof age === 'number' ? describeAge(age) : 'unknown',
        stale ? 'warn' : 'ok'));
      rows.push(health.last_refresh_at
        ? h('div', { class: 'kv-row' },
          h('span', { class: 'k', text: 'last refresh at' }),
          h('span', { class: 'v' }, timeEl(health.last_refresh_at)))
        : kvRow('last refresh at', 'not reported'));
      // discovery_stale means the last cycle failed and last-known-good is being
      // served. Absent is not the same as false, so it is reported as unknown.
      const ds = health.discovery_stale;
      rows.push(kvRow('discovery', ds === true ? 'STALE: last cycle failed'
        : ds === false ? 'ok' : 'not reported',
      ds === true ? 'bad' : ds === false ? 'ok' : null));
    }

    // Two independent counts of the same thing. The pair is the point: what the
    // registry holds against what the public API hands the map. Renaming them
    // must not collapse them into one number.
    rows.push(kvRow('in the registry', String(records.length)));
    rows.push(kvRow('published in the registry', String(published.length)));
    rows.push(kvRow('served to the map', servedCount === null ? 'unknown' : String(servedCount),
      servedCount === null ? null : servedCount === published.length ? 'ok' : 'bad'));
    if (servedCount !== null && servedCount !== published.length) {
      rows.push(kvRow('drift',
        `${published.length - servedCount} record(s) not on the map. Rebuild.`, 'bad'));
    }
    rows.push(kvRow('api host', API.replace('https://', ''), 'mono'));

    replace($('#health-kv'), rows);

    // Its own request, so a slow or failing analytics read cannot hold up the
    // stats that come from data already in hand.
    renderQuota();
  }

  // --------------------------------------------------------------- quota --

  /**
   * Free-tier burn-down.
   *
   * The panel that would have surfaced the KV write overage before
   * Cloudflare emailed about it. The token stays in the Worker: this reads
   * /admin/quota, never Cloudflare directly.
   *
   * A failed read renders as "could not read", never as empty meters. An
   * empty meter is indistinguishable from zero usage, which is the single most
   * reassuring thing this panel could wrongly say.
   */
  async function renderQuota() {
    const res = await api(`/admin/quota?cb=${Date.now()}`);

    if (!res.ok) {
      const detail = res.body?.errors?.join('; ') ?? describeFailure(res)[1];
      $('#quota-note').textContent = `Could not read usage: ${detail}`;
      return replace($('#quota-meters'),
        h('div', { class: 'kv-row' },
          h('span', { class: 'k', text: 'status' }),
          h('span', { class: 'v bad', text: 'unknown, not zero' })));
    }

    const { date, utc_hours_elapsed: hours, usage, worker_errors: errors } = res.body;
    // Say which day and how far into it. The caps reset at UTC midnight, and
    // AEST runs ~10 hours ahead of that, so "1 of 1,000" early in the UTC day
    // is not the reassurance it looks like.
    //
    // THE ONE PANEL THAT STAYS IN UTC, deliberately. Everything else here is
    // rendered in the reader's own zone, but this window is a property of
    // Cloudflare's billing day rather than of anything the reader did, and
    // showing it as "resets at 10am" for one collaborator and "resets at 1am"
    // for another describes the same cap two ways. Do not "fix" it to local.
    $('#quota-note').textContent =
      `UTC day ${date}, ${hours}h elapsed of 24. Caps are per account, and reset at UTC midnight.`;

    replace($('#quota-meters'), usage.map((u) => {
      // Colour on the PROJECTION, not on what has been spent so far: a cap that
      // will be hit at 22:00 UTC matters at 09:00, and the raw fraction says
      // nothing is wrong until it is too late to act.
      const basis = u.projected ?? u.used;
      const ratio = u.cap ? basis / u.cap : 0;
      const kind = ratio >= 1 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok';
      const pctOfCap = Math.min(100, Math.round((u.used / u.cap) * 100));

      return h('div', { class: 'quota-row' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'k', text: u.label }),
          h('span', { class: `v ${kind}`, text: `${u.used.toLocaleString()} / ${u.cap.toLocaleString()}` })),
        h('span', { class: 'bar' }, h('span', {
          class: kind, style: `width:${Math.max(pctOfCap, u.used > 0 ? 1 : 0)}%`,
        })),
        h('span', { class: 'quota-projection' },
          u.projected === null
            ? 'too early in the UTC day to project'
            : `on track for ~${u.projected.toLocaleString()} by midnight UTC${
              u.projected > u.cap ? ', over the cap' : ''}`));
    }).concat(errors > 0
      ? [h('div', { class: 'kv-row' },
        h('span', { class: 'k', text: 'worker errors today' }),
        h('span', { class: 'v bad', text: String(errors) }))]
      : []));
  }

  // --------------------------------------------------------------- audit --

  /** Field-level diff between two audit snapshots. */
  /**
   * Column name -> what the field IS, in words.
   *
   * The audit sentence is prose; the record expanded under it is column names.
   * `granted_by: "apply"` is the stored shape and it means nothing to anyone who
   * has not read `worker/src/review.js`.
   *
   * Deliberately incomplete, and `fieldLabel` falls back to the raw key: a
   * column added to the Worker must show up here as itself rather than
   * disappear. A label map that silently drops unknown fields would make this
   * log quietly lie by omission, which is the one thing it cannot do.
   */
  const FIELD_LABEL = {
    // A location record.
    id: 'ID',
    name: 'Name',
    nexus_id: 'Nexus mod ID',
    category: 'Category',
    coordinates: 'Coordinates',
    yaw: 'Facing',
    description: 'Description',
    credits: 'Credits',
    authors: 'Authors',
    tags: 'Tags',
    status: 'Status',
    admin_notes: 'Admin notes',
    added_at: 'Added',
    modified_at: 'Last changed',
    // Three different dates that would otherwise read as interchangeable.
    nexus_updated_at: 'Mod last updated on Nexus',

    // A tag record.
    slug: 'Tag ID',
    sort_order: 'Sort order',
    created_at: 'Created',
    updated_at: 'Last changed',

    // A submission, and a review decision on one.
    kind: 'Kind of request',
    location_id: 'Location',
    payload: 'What was submitted',
    review_note: 'Reviewer note',
    granted_by: 'How it was applied',
    base_override: 'Approved over a newer version',
    reason: 'Reason',
    dismissed_by: 'Dismissed by',
    owner_id: 'Owner',
  };

  const fieldLabel = (key) => FIELD_LABEL[key] ?? key;

  /**
   * The same label, for the middle of a sentence.
   *
   * `FIELD_LABEL` is written for a column heading, so it is capitalised. Dropped
   * into "updated X (name, status)" that reads as a list of proper nouns. Any
   * label carrying a capital past the first character is a real one (Nexus,
   * ID) and is left exactly as it is.
   */
  const fieldPhrase = (key) => {
    const label = fieldLabel(key);
    return /[A-Z]/.test(label.slice(1)) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  };

  /**
   * Machine token -> English, per field.
   *
   * Only for fields whose values are a closed set. A name, a note or a reason is
   * already prose and must be shown exactly as recorded, never "tidied".
   */
  const VALUE_LABEL = {
    granted_by: {
      apply: 'applied to the existing record',
      restore: 'put a hidden record back, rather than creating a second one',
    },
    status: {
      published: 'on the map',
      hidden: 'off the map',
      draft: 'draft',
      pending: 'waiting for review',
      approved: 'approved',
      rejected: 'rejected',
      held: 'on hold',
    },
    kind: {
      create: 'a new pin',
      edit: 'an edit to a pin',
      remove: 'a request to take a pin off the map',
    },
  };

  /**
   * One diff value, for reading rather than for parsing.
   *
   * Absent, `null` and `''` are three different facts, so each gets its own
   * word rather than one shared rendering. Objects stay as JSON: a submission
   * payload is a nested record, and there is no flat rendering of one that is
   * not simply a worse JSON.
   */
  function humanValue(key, v) {
    if (v === undefined) return 'not recorded';
    if (v === null) return 'not set';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
    if (typeof v === 'object') return JSON.stringify(v);
    return VALUE_LABEL[key]?.[String(v)] ?? (v === '' ? 'empty' : String(v));
  }

  /**
   * The verbatim values, one fold deeper.
   *
   * Everything above this is a TRANSLATION, and a translated audit log has to
   * stay checkable or it is only a claim. Same reasoning as the raw `action`
   * string kept beside the sentence: what was stored must remain reachable, not
   * merely have been stored. Collapsed, so it costs nothing until it is wanted.
   */
  function rawValues(before, after, label) {
    if (!before && !after) return null;
    const payload = {};
    if (before) payload.before = before;
    if (after) payload.after = after;
    return h('details', { class: 'raw-record' },
      h('summary', { text: label }),
      h('pre', { text: JSON.stringify(payload, null, 2) }));
  }

  function renderDiff(before, after, rawLabel = 'Show the raw values') {
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
    const rows = [];
    for (const key of keys) {
      const from = before ? before[key] : undefined;
      const to = after ? after[key] : undefined;
      // modified_at moves on every write; showing it as a change is noise that
      // makes the real change harder to find.
      if (key === 'modified_at') continue;
      if (sameValue(from, to)) continue;
      rows.push(h('div', {},
        h('span', { class: 'k', text: `${fieldLabel(key)}: ` }),
        before ? h('span', { class: 'from', text: humanValue(key, from) }) : null,
        before && after ? ' → ' : null,
        after ? h('span', { class: 'to', text: humanValue(key, to) }) : null));
    }
    return h('div', { class: 'diff-block' },
      rows.length
        ? h('div', { class: 'diff' }, rows)
        : h('p', { class: 'muted', text: 'No field changes recorded.' }),
      rawValues(before, after, rawLabel));
  }

  /**
   * Fields that actually moved between two audit snapshots, named the way the
   * expanded record names them. The sentence and the diff under it have to call
   * the same field the same thing, or the sentence stops being a summary of it.
   */
  function changedFields(before, after) {
    if (!before || !after) return [];
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => k !== 'modified_at' && !sameValue(before[k], after[k]))
      .map(fieldPhrase)
      .sort();
  }

  const quoted = (name) => h('strong', { text: `“${name}”` });

  /** A name for a location the entry refers to, from the entry or from state. */
  const auditLocationName = (e, id) => e.after?.name ?? e.before?.name
    ?? state.locations.find((l) => l.id === id)?.name ?? null;

  /** A name for a candidate mod, from whichever list currently holds it. */
  const candidateName = (nexusId) => [...state.candidates, ...state.dismissed]
    .find((c) => String(c.nexus_id) === String(nexusId))?.name ?? null;

  const shortNote = (note) => (typeof note === 'string' && note.trim()
    ? `“${note.length > 70 ? `${note.slice(0, 70)}…` : note}”`
    : null);

  /**
   * One audit row as a sentence a person can read.
   *
   * The stored `action` and `target` are built for machines: `candidate.dismiss`
   * against a bare `999001`, or `submission.approve` against `3`, are precise
   * and say nothing about what happened. Someone reading back through a week of
   * decisions needs the mod name, the location name, and what the decision was.
   *
   * The raw action is still rendered beside this, small, so the log stays
   * greppable and this function cannot quietly mislabel something: the two are
   * always visible together.
   *
   * Names are resolved from the audit row FIRST (`before`/`after` carry the
   * record) and only then from loaded state, because a deleted location is not
   * in state and its name is exactly what the log exists to preserve.
   */
  function describeAudit(e) {
    const target = e.target ?? '';
    const after = e.after ?? {};

    switch (e.action) {
      case 'location.create':
        return ['created ', quoted(auditLocationName(e, target) ?? target)];
      case 'location.update': {
        const fields = changedFields(e.before, e.after);
        return [
          'updated ', quoted(auditLocationName(e, target) ?? target),
          fields.length ? ` (${fields.join(', ')})` : '',
        ];
      }
      case 'location.delete':
        return ['deleted ', quoted(auditLocationName(e, target) ?? target)];

      case 'tag.create': return ['created the tag ', h('code', { text: target })];
      case 'tag.update': return ['edited the tag ', h('code', { text: target })];
      case 'tag.rename':
        return ['renamed the tag ', h('code', { text: e.before?.slug ?? '?' }),
          ' to ', h('code', { text: target })];
      case 'tag.delete': return ['deleted the tag ', h('code', { text: target })];

      // The stored target is the machine token `d1`. Mapped here rather than at
      // the write: the audit log is append-only and the stored value is what was
      // true at the time. Rewriting history to read better is not an option.
      case 'dataset.refresh':
        return [`rebuilt the served dataset from ${target ? datasetSource(target) : 'its source'}`];

      // Written by the public route, so the actor is 'anonymous'.
      case 'submission.create':
        return ['submitted a new pin, ', quoted(after.payload?.name ?? 'unnamed')];
      case 'submission.edit':
        return ['proposed an edit to ', quoted(auditLocationName(e, after.location_id)
          ?? after.location_id ?? 'a location')];
      case 'submission.remove':
        return ['asked for ', quoted(auditLocationName(e, after.location_id)
          ?? after.location_id ?? 'a location'), ' to be taken off the map'];

      case 'submission.approve': {
        const name = auditLocationName(e, after.location_id) ?? after.location_id;
        // `granted_by` is the one thing that distinguishes an approval which
        // created a record from one which put an existing record back.
        if (after.granted_by === 'restore') {
          return ['approved submission #', target, ' by restoring ',
            quoted(name ?? 'a hidden record'), ' rather than creating a second one'];
        }
        return ['approved submission #', target, name ? [', applied to ', quoted(name)] : '',
          // The reviewer approved over a record that had moved since the
          // submission was made. The before/after pair says what changed; this
          // says it was a decision rather than the silent overwrite this
          // approval would have been before the guard existed.
          after.base_override ? ', over a newer version of the record' : ''];
      }
      case 'submission.reject': {
        const note = shortNote(after.review_note);
        return ['rejected submission #', target, note ? `: ${note}` : ''];
      }
      case 'submission.hold': {
        const note = shortNote(after.review_note);
        return ['put submission #', target, ' on hold', note ? `: ${note}` : ''];
      }

      case 'candidate.dismiss': {
        const name = candidateName(target);
        const note = shortNote(after.reason);
        return ['dismissed mod ', nexusLink(target), name ? [' ', quoted(name)] : '',
          ' from the candidates list', note ? `: ${note}` : ''];
      }
      case 'candidate.restore':
        return ['put mod ', nexusLink(target), ' back in the candidates list'];

      // An action this page has not been taught. Say what is known rather than
      // rendering a blank line: a new server action must not vanish from view
      // just because the dashboard is behind.
      default:
        return [e.action, target ? ` on ${target}` : ''];
    }
  }

  async function loadAudit() {
    const limit = $('#audit-limit').value;
    const res = await api(`/admin/audit?limit=${encodeURIComponent(limit)}`);
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }
    const entries = res.body.entries || [];
    replace($('#audit-list'), entries.length
      ? entries.map((e) => h('div', { class: 'audit-entry' },
        h('div', { class: 'audit-head' },
          timeEl(e.at),
          h('span', { class: 'who', text: e.actor === 'anonymous' ? 'a visitor' : e.actor }),
          h('span', { class: 'sentence' }, describeAudit(e).flat()),
          // The machine-readable pair, kept visible so the sentence above can
          // always be checked against what was actually recorded.
          h('code', { class: 'action', title: `recorded as ${e.action} on ${e.target ?? 'nothing'}`, text: e.action })),
        h('details', {}, h('summary', { text: 'The full record' }),
          renderDiff(e.before, e.after, 'Show exactly what was recorded'))))
      : h('p', { class: 'muted', text: 'No entries yet.' }));
  }

  // -------------------------------------------------------------- alerts --

  // Severity drives the stripe colour and the word shown. Kept in the same
  // order the Worker uses so the two cannot disagree about what exists.
  const SEVERITY_LABEL = {
    info: 'Info',
    warn: 'Warning',
    error: 'Error',
    recovery: 'Recovered',
  };

  // Where the alert came from, in words. `source` is a machine token stored in
  // the row; this is the only place it is turned into something readable.
  const SOURCE_LABEL = {
    'api-health': 'API health monitor',
    refresh: 'Dataset refresh',
    submissions: 'Submission queue',
    quota: 'Free-tier quota',
    export: 'Nightly data snapshot',
  };

  async function acknowledgeAlert(id, button) {
    button.disabled = true;
    const res = await api(`/admin/alerts/${encodeURIComponent(id)}`, { method: 'PATCH' });
    if (!res.ok) {
      button.disabled = false;
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }
    clearBanner();
    return loadAlerts();
  }

  function alertCard(a) {
    const severity = SEVERITY_LABEL[a.severity] ? a.severity : 'info';
    const acknowledged = Boolean(a.acknowledged_at);
    return h('div', { class: `alert-entry sev-${severity}${acknowledged ? ' acknowledged' : ''}` },
      h('div', { class: 'alert-head' },
        h('span', { class: 'alert-sev', text: SEVERITY_LABEL[severity] }),
        h('strong', { class: 'alert-title', text: a.title }),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'muted', text: SOURCE_LABEL[a.source] ?? a.source }),
        timeEl(a.at)),
      // Pre-wrap: the body is plain text assembled with newlines by the
      // producers, not markup, and it is inserted as text so a Discord-flavoured
      // body can never become HTML here.
      a.body ? h('p', { class: 'alert-body', text: a.body }) : null,
      h('div', { class: 'alert-foot' },
        acknowledged
          ? h('span', { class: 'muted' },
            'Acknowledged by ',
            h('span', { class: 'who', text: a.acknowledged_by || 'someone' }),
            ' ',
            timeEl(a.acknowledged_at))
          : h('button', {
            type: 'button',
            class: 'btn secondary',
            onclick: (e) => acknowledgeAlert(a.id, e.currentTarget),
          }, 'Acknowledge')));
  }

  async function loadAlerts() {
    const limit = $('#alerts-limit').value;
    const unackOnly = $('#alerts-unack-only').checked;
    const res = await api(
      `/admin/alerts?limit=${encodeURIComponent(limit)}${unackOnly ? '&unacknowledged=1' : ''}`,
    );
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      return banner(kind, message);
    }

    const alerts = res.body.alerts || [];
    const unacknowledged = Number(res.body.unacknowledged ?? 0);

    replace($('#alerts-list'), alerts.length
      ? alerts.map(alertCard)
      : h('p', { class: 'muted', text: unackOnly ? 'Nothing unacknowledged.' : 'No alerts yet.' }));

    $('#alerts-note').textContent = alerts.length
      ? `${alerts.length} shown, ${unacknowledged} unacknowledged.`
      : `${unacknowledged} unacknowledged.`;

    // Same rule as the queue badge: only a non-zero count earns one.
    $('#alerts-count').textContent = unacknowledged ? String(unacknowledged) : '';
    syncNavBadge();

    state.alerts = alerts;
    state.alertsUnacknowledged = unacknowledged;
    // The Overview's alerts panel reads this, and acknowledging from the tab
    // has to move the number on the landing page too. Re-rendered rather than
    // patched, for the same reason the other counts are: it derives.
    renderOverviewAlerts();
    return undefined;
  }

  /**
   * The Overview's alerts panel: what is still open, most urgent first.
   *
   * Errors before warnings before the rest, NOT newest first the way the tab
   * is. A landing page answers "is anything wrong", and a fresh `info` sitting
   * above a six-hour-old `error` answers it wrongly.
   */
  function renderOverviewAlerts() {
    const box = $('#overview-alerts');
    if (!box) return;

    const open = state.alerts.filter((a) => !a.acknowledged_at);
    const total = state.alertsUnacknowledged;

    if (!total) {
      replace(box, h('p', { class: 'muted', text: 'Nothing open. Alerts that have been acknowledged stay in the Alerts tab.' }));
      return;
    }

    const RANK = { error: 0, warn: 1, info: 2, recovery: 3 };
    const SHOWN = 4;
    const sorted = [...open].sort(
      (a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || String(b.at).localeCompare(String(a.at)),
    );

    replace(box,
      sorted.slice(0, SHOWN).map((a) => h('div', { class: `overview-alert sev-${SEVERITY_LABEL[a.severity] ? a.severity : 'info'}` },
        h('span', { class: 'alert-sev', text: SEVERITY_LABEL[a.severity] ?? 'Info' }),
        h('span', { class: 'overview-alert-title', text: a.title }),
        h('span', { class: 'muted', text: SOURCE_LABEL[a.source] ?? a.source }),
        timeEl(a.at))),
      // Says what is NOT on screen. A panel capped at four that does not admit
      // it reads as "four open" when there are twenty.
      h('button', {
        class: 'btn secondary', type: 'button',
        onclick: () => switchTab('alerts'),
      }, total > SHOWN ? `See all ${total} open alerts` : 'Open the Alerts tab'));
  }

  // -------------------------------------------------- narrow-screen nav --

  /**
   * The two widths admin.css changes shape at, read back here so the two files
   * agree. 70rem is where `.split` stacks; 60rem is where the tabs fold into the
   * drawer. Both are `matchMedia` rather than a resize handler, so crossing a
   * breakpoint is one event instead of a hundred.
   *
   * If either number moves in the stylesheet it moves here in the same commit.
   * The stylesheet decides what the reader sees; this decides whether the back
   * gesture has anything to dismiss. Disagreement means back leaves the page.
   */
  const NARROW = window.matchMedia('(max-width: 70rem)');
  const MENU = window.matchMedia('(max-width: 60rem)');

  /**
   * What is open OVER the page, held as session history.
   *
   * Two things can cover what is behind them: the nav drawer, and, once the
   * split has stacked, a record's editor. On Android the back gesture is how
   * both get dismissed, and a plain CSS class would take the reader out of the
   * dashboard rather than out of the thing they opened.
   *
   * So each is a real history entry, and `applyOverlays` is the ONLY function
   * that touches the classes. It runs from `popstate`, or from the push that
   * created the entry, so the DOM and the history stack cannot drift apart.
   * Every close route (the Close button, the backdrop, Escape, a tab switch)
   * unwinds through history rather than clearing a class directly.
   *
   * The stack is only ever `[]`, `['menu']`, `['detail']` or `['detail','menu']`:
   * the backdrop covers the whole viewport, so no row can be tapped while the
   * drawer is open. That is why `popOverlay` can assume the thing it is asked to
   * close is the top entry.
   */
  let overlays = [];
  // Set while a popstate is being applied, so the select* call that closes a
  // pane does not try to unwind the very entry that is already unwinding.
  let unwinding = false;

  const CLOSE_DETAIL = {
    locations: () => selectLocation(null),
    tags: () => selectTag(null),
    queue: () => selectSubmission(null),
  };

  function applyOverlays(next) {
    const was = overlays;
    overlays = next;

    const menu = next.includes('menu');
    const detail = next.includes('detail');

    document.body.classList.toggle('menu-open', menu);
    document.body.classList.toggle('detail-open', detail);
    $('#nav-toggle').setAttribute('aria-expanded', String(menu));
    $('#nav-backdrop').hidden = !menu;
    $('#detail-back').hidden = !detail;

    // The entry went, so the pane it stood for goes with it.
    if (was.includes('detail') && !detail) {
      unwinding = true;
      CLOSE_DETAIL[state.detailTab]?.();
      state.detailTab = null;
      unwinding = false;
    }
  }

  function pushOverlay(kind) {
    if (overlays.includes(kind)) return;
    const next = [...overlays, kind];
    history.pushState({ ncz: next }, '');
    applyOverlays(next);
  }

  const popOverlay = (kind) => { if (overlays.includes(kind)) history.back(); };

  /** One `go`, so the whole stack unwinds in a single popstate. */
  const closeOverlays = () => { if (overlays.length) history.go(-overlays.length); };

  const toggleMenu = () => (overlays.includes('menu') ? popOverlay('menu') : pushOverlay('menu'));

  /**
   * A record was opened.
   *
   * Below 70rem that is a navigation: the editor replaces the list, so there has
   * to be something to come back to. Above it the editor fills a pane that is
   * already on screen, and nothing is pushed, because selecting a row on a
   * desktop is not a place anyone should be able to press Back out of.
   */
  function openDetail(tab) {
    state.detailTab = tab;
    if (unwinding || !NARROW.matches) return;
    pushOverlay('detail');
  }

  function closeDetail() {
    if (unwinding) return;
    state.detailTab = null;
    popOverlay('detail');
  }

  /**
   * The number on the closed menu button.
   *
   * Summed from the tab badges already rendered, not recomputed from state. Two
   * independent counts of the same thing is how #823 happened, and this has no
   * reason to be a second consumer of anything.
   */
  function syncNavBadge() {
    const total = ['#queue-count', '#candidates-count', '#alerts-count']
      .reduce((n, sel) => n + (Number($(sel).textContent) || 0), 0);
    $('#nav-count').textContent = total ? String(total) : '';
  }

  // ---------------------------------------------------------------- tabs --

  const TABS = ['overview', 'locations', 'queue', 'candidates', 'tags', 'alerts', 'audit'];

  function switchTab(name) {
    // A tab is a different place, so nothing opened over the old one survives
    // the move. Without this, opening the drawer over an open record and tapping
    // Queue lands on a queue showing its review pane with nothing selected.
    closeOverlays();
    for (const btn of document.querySelectorAll('nav.tabs button')) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    }
    for (const id of TABS) {
      $(`#tab-${id}`).hidden = id !== name;
    }
    if (name === 'audit') loadAudit();
    if (name === 'alerts') loadAlerts();
    // A Leaflet map built while its pane was display:none measured a zero-sized
    // container, so it has to be told the size it actually has now.
    if (name === 'queue') state.reviewMap?.invalidateSize?.();
    // Recomputed on entry rather than cached: the counts are derived from
    // state that any edit in another tab may have moved.
    if (name === 'overview') renderOverview();
  }

  // ---------------------------------------------------------------- boot --

  async function main() {
    // Surface a callback error, then strip it so a refresh does not re-show it.
    const params = new URLSearchParams(location.search);
    const err = params.get('error');
    let callbackBanner = null;
    if (err) {
      const [kind, message] = CALLBACK_ERRORS[err] || ['error', `Sign-in failed (${err}).`];
      callbackBanner = h('div', { class: `notice ${kind}`, text: message });
      params.delete('error');
      history.replaceState({}, '', location.pathname + (params.toString() ? `?${params}` : ''));
    }

    const allowed = await checkSession(callbackBanner);
    if (allowed !== true) return;

    document.body.classList.remove('gate');
    $('#whoami').textContent = state.login;
    $('#api-label').textContent = API.replace('https://', '');
    $('#signout').onclick = signOut;

    for (const btn of document.querySelectorAll('nav.tabs button')) {
      btn.onclick = () => switchTab(btn.dataset.tab);
    }

    // The overlay layer. `popstate` is the only applier; everything else either
    // pushes an entry or asks history to unwind one. See the note on `overlays`.
    window.addEventListener('popstate', (e) => applyOverlays(
      Array.isArray(e.state?.ncz) ? e.state.ncz : [],
    ));
    $('#nav-toggle').onclick = toggleMenu;
    $('#nav-backdrop').onclick = () => popOverlay('menu');
    $('#detail-back').onclick = () => popOverlay('detail');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlays.length) history.back();
    });
    // A rotation can cross the split breakpoint with a record already open.
    // Wide to narrow leaves the editor covering the screen with no entry behind
    // it, so back would leave the dashboard; push one. Narrow to wide leaves an
    // entry for a pane that covers nothing, which is harmless: back deselects.
    NARROW.addEventListener('change', (e) => {
      if (e.matches && state.detailTab && !overlays.includes('detail')) pushOverlay('detail');
    });
    MENU.addEventListener('change', (e) => { if (!e.matches) popOverlay('menu'); });
    // The header gives its wordmark back once the page has moved. A threshold
    // rather than any scroll at all, so a touch bounce does not flicker it.
    window.addEventListener('scroll', () => {
      document.body.classList.toggle('scrolled', window.scrollY > 24);
    }, { passive: true });
    // The inputs write into the filter state rather than being read from it,
    // so the Overview tiles and the controls cannot disagree about what the
    // list is showing.
    $('#loc-search').addEventListener('input', (e) => setFilter({ q: e.target.value.trim() }));
    $('#loc-status').addEventListener('change', (e) => setFilter({ status: e.target.value }));
    $('#loc-category').addEventListener('change', (e) => setFilter({ category: e.target.value }));

    // The split panes are sized against the viewport minus the top bar, and the
    // bar wraps on narrow windows, so measure it rather than assuming a height
    // that would clip the last row or leave a dead gap.
    const topbar = document.querySelector('.topbar');
    const measure = () => document.documentElement.style.setProperty(
      '--topbar-h', `${topbar.offsetHeight}px`,
    );
    measure();
    new ResizeObserver(measure).observe(topbar);
    $('#loc-new').onclick = () => selectLocation('');
    $('#tag-new').onclick = () => selectTag('');
    $('#audit-refresh').onclick = loadAudit;
    $('#audit-limit').onchange = loadAudit;
    $('#alerts-refresh').onclick = loadAlerts;
    $('#alerts-limit').onchange = loadAlerts;
    $('#alerts-unack-only').onchange = loadAlerts;
    $('#rebuild').onclick = (e) => rebuildDataset(e.currentTarget);
    $('#queue-refresh').onclick = loadQueue;
    $('#queue-status').onchange = (e) => {
      state.queueStatus = e.target.value;
      renderQueue();
    };
    $('#candidates-refresh').onclick = loadCandidates;

    // Tags first: the location editor's picker is built from them.
    await loadTags();
    await loadLocations();
    // Both feed counts the Overview and the tab badges derive from, so they
    // load at boot rather than on first visit to their tab. A badge that only
    // appears once you have already gone looking is not a notification.
    await Promise.all([loadQueue(), loadCandidates(), loadAlerts()]);
    await refreshFreshness();
    // Overview is the landing tab, and its numbers come from what was just
    // loaded, so it is rendered after both rather than on its own fetch.
    await renderOverview();
  }

  main();
})();
