/*
 * NC Zoning Board — admin dashboard.
 *
 * Phase 4c. The server side already exists (worker/src/admin.js); this is the
 * surface for it. No framework and no build step, matching the rest of the
 * site: a few hundred lines of DOM against a JSON API does not need one.
 *
 * Three rules run through the whole file, and all three exist because the
 * opposite already shipped once:
 *
 * 1. A response is a success only when it says so. `res.ok` is checked
 *    explicitly and an unrecognised status is an error, never a fall-through to
 *    the happy path. The stub once rendered "Signed in as undefined —
 *    collaborator access confirmed" against a 404 by doing the reverse.
 * 2. 403 and 503 are different things. 403 is "you are not a collaborator".
 *    503 `check_unavailable` is "GitHub could not be reached", which is not a
 *    refusal and is never worded as one.
 * 3. Writes send only fields that actually changed. The API rejects unknown
 *    keys with a 422 rather than ignoring them, so a typo is loud — but only if
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
  const SOURCES = ['manual', 'auto'];

  /** Exactly the fields the API will accept. Anything else is a 422. */
  const WRITABLE = [
    'name', 'authors', 'credits', 'coordinates', 'yaw', 'nexus_id',
    'description', 'category', 'tags', 'status', 'admin_notes', 'source',
  ];

  // Reasons the OAuth callback can bounce back with. `check_unavailable` is
  // deliberately worded as "cannot tell", not "denied" — GitHub being
  // unreachable is not a statement about who you are, and telling an admin they
  // lack access because of a transient blip is a lie the UI should not tell.
  const CALLBACK_ERRORS = {
    bad_state: ['error', 'Login could not be verified. Start again from this page.'],
    oauth_failed: ['error', 'GitHub sign-in failed. Try again.'],
    not_authorised: ['error', 'That account is not a collaborator on the repository.'],
    check_unavailable: ['warn', 'Could not reach GitHub to confirm access. This is not a refusal — try again shortly.'],
  };

  // --------------------------------------------------------------- state --

  const state = {
    login: null,
    locations: [],
    tags: [],
    selectedLocation: null,   // id, or '' for a new record
    selectedTag: null,        // slug, or '' for a new tag
  };

  // ----------------------------------------------------------- DOM utils --

  const $ = (sel) => document.querySelector(sel);

  /**
   * Element builder. Text goes in via textContent, never innerHTML, so mod
   * names and admin notes cannot inject markup — this page renders strings
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

  // ------------------------------------------------------------ requests --

  /**
   * One JSON call. Always credentialed — the session is an HttpOnly cookie, and
   * the origin has to be in ADMIN_ORIGINS (worker/src/auth.js) for the browser
   * to send it. `*.pages.dev` preview URLs are NOT on that list, so a PR
   * preview cannot exercise auth; test on dev.nczoning.net.
   *
   * Never throws on an HTTP error: the status IS the information here, and
   * callers have to branch on 403 vs 503 vs 409 rather than on "it failed".
   */
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        credentials: 'include',
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
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
        return ['warn', 'GitHub could not be reached to confirm your access. This is not a refusal — try again shortly.'];
      case 404:
        return ['error', 'Not found. It may have been deleted in another tab.'];
      case 409:
        return ['error', res.body?.error === 'tag_exists'
          ? `A tag with the slug "${res.body.slug}" already exists.`
          : 'Conflict — nothing was changed.'];
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
          ? `The rename did not propagate — ${res.body.detail}. The registry and the location links are now out of step; do not retry, check the database.`
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
   * 🔴 Success requires an explicit 200 AND collaborator === true. Everything
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

  const tagsOf = (loc) => (loc.source === 'auto' ? ['nczoning', ...loc.tags] : loc.tags);

  function locationMatches(loc, { q, status, category }) {
    if (status && loc.status !== status) return false;
    if (category && loc.category !== category) return false;
    if (!q) return true;
    const hay = [loc.name, loc.nexus_id, ...(loc.authors || []), ...(loc.tags || [])]
      .join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function renderLocations() {
    const filters = {
      q: $('#loc-search').value.trim(),
      status: $('#loc-status').value,
      category: $('#loc-category').value,
    };
    const shown = state.locations.filter((l) => locationMatches(l, filters));

    replace($('#loc-rows'), shown.map((loc) => h('tr', {
      'aria-selected': loc.id === state.selectedLocation ? 'true' : 'false',
      onclick: () => selectLocation(loc.id),
      style: 'cursor:pointer',
    },
    h('td', {}, loc.name),
    h('td', {}, loc.category.replace(/-/g, ' ')),
    h('td', {}, tagsOf(loc).map((t) => h('span', {
      class: `badge${t === 'nczoning' ? ' synthetic' : ''}`,
      title: t === 'nczoning' ? 'Synthetic marker, added to auto-discovered records. Not editable.' : null,
      text: t,
    }))),
    h('td', {},
      h('span', { class: `badge status-${loc.status}`, text: loc.status }),
      loc.source === 'auto' ? h('span', { class: 'badge source-auto', text: 'auto' }) : null),
    h('td', {}, loc.nexus_id))));

    $('#loc-count').textContent = shown.length === state.locations.length
      ? `${shown.length} locations`
      : `${shown.length} of ${state.locations.length} locations`;
  }

  async function loadLocations() {
    const res = await api('/admin/locations');
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      return;
    }
    state.locations = res.body.locations || [];
    renderLocations();
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
      source: val('source'),
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
   * than a signal. It also makes `updated_at` mean something.
   */
  function diffPayload(current, original) {
    const patch = {};
    for (const key of WRITABLE) {
      if (!sameValue(current[key], original[key])) patch[key] = current[key];
    }
    return patch;
  }

  const field = (label, control, hint) => h('div', { class: 'field', 'data-field': control.name || control.dataset?.field },
    h('label', { text: label }), control, hint ? h('p', { class: 'muted', text: hint }) : null);

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
    source: 'manual', coordinates: ['', '', ''], yaw: null, credits: null,
    admin_notes: null, description: '', authors: [], tags: [],
  };

  function renderLocationEditor(loc) {
    const isNew = !loc.id;
    const [x, y, z] = loc.coordinates ?? ['', '', ''];

    const form = h('form', { autocomplete: 'off', onsubmit: (e) => e.preventDefault() },
      field('Name', input('name', loc.name, { required: true, minlength: '3' })),
      h('div', { class: 'field row' },
        field('Category', select('category', CATEGORIES, loc.category)),
        field('Status', select('status', STATUSES, loc.status))),
      h('div', { class: 'field row' },
        field('Nexus ID', input('nexus_id', loc.nexus_id, { placeholder: '12345, WIP or Dummy' })),
        field('Source', select('source', SOURCES, loc.source))),
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
      field('Tags', tagPicker(loc.tags || []),
        loc.source === 'auto'
          ? 'nczoning is added automatically for auto-sourced records and is not listed here.'
          : null),
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
        class: 'btn secondary', type: 'button', text: 'Cancel',
        onclick: () => selectLocation(null),
      }),
      dirtyLabel,
      h('span', { class: 'spacer' }),
      isNew ? null : h('button', {
        class: 'btn danger', type: 'button', text: 'Delete',
        onclick: () => deleteLocation(loc),
      }),
    );

    replace($('#loc-editor'),
      h('h2', { style: 'margin-top:0;font-size:var(--text-md)', text: isNew ? 'New location' : loc.name }),
      isNew ? null : h('p', { class: 'muted', text: `id ${loc.id} · updated ${loc.updated_at}` }),
      form, actions);

    refreshDirty();
    if (isNew) saveBtn.disabled = false;
  }

  const TAG_FIELDS = ['slug', 'name', 'description', 'sort_order'];

  /**
   * Paint server-side field errors next to the inputs they belong to.
   *
   * `fields` is the form's own writable set — the location list for the record
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
      : await api(`/admin/locations/${encodeURIComponent(loc.id)}`, { method: 'PATCH', body: payload });
    button.disabled = false;

    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      if (res.status === 422) applyFieldErrors(form, res.body.errors || []);
      return;
    }

    banner('ok', isNew
      ? `Created "${res.body.location.name}".`
      : `Saved ${Object.keys(payload).join(', ')} on "${res.body.location.name}".`);
    await loadLocations();
    selectLocation(res.body.location.id);
  }

  async function deleteLocation(loc) {
    // `hidden` keeps the row and pulls the pin; delete is for records that
    // should never have existed. Say so, rather than asking "are you sure?".
    const ok = confirm(
      `Delete "${loc.name}" outright?\n\n`
      + 'The full record is preserved in the audit log, so this is recoverable — but if you '
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
    await loadLocations();
    replace($('#loc-editor'), h('p', { class: 'muted', text: 'Select a location to edit it, or create a new one.' }));
  }

  function selectLocation(id) {
    state.selectedLocation = id;
    clearBanner();
    if (id === null) {
      renderLocations();
      return replace($('#loc-editor'),
        h('p', { class: 'muted', text: 'Select a location to edit it, or create a new one.' }));
    }
    renderLocations();
    const loc = id === '' ? { ...BLANK_LOCATION } : state.locations.find((l) => l.id === id);
    if (loc) renderLocationEditor(loc);
  }

  // ---------------------------------------------------------------- tags --

  function renderTags() {
    replace($('#tag-rows'), state.tags.map((tag) => h('tr', {
      'aria-selected': tag.slug === state.selectedTag ? 'true' : 'false',
      onclick: () => selectTag(tag.slug),
      style: 'cursor:pointer',
    },
    h('td', {}, h('code', { text: tag.slug })),
    h('td', {}, tag.name || h('span', { class: 'muted', text: '— (falls back to the slug)' })),
    h('td', {}, tag.description),
    h('td', { class: 'num' }, String(tag.usage_count)))));
  }

  async function loadTags() {
    const res = await api('/admin/tags');
    if (!res.ok) {
      const [kind, message] = describeFailure(res);
      banner(kind, message);
      return;
    }
    state.tags = res.body.tags || [];
    renderTags();
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
      // 🔴 Renaming a slug is an ON UPDATE CASCADE through location_tags and a
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
      h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onclick: () => selectTag(null) }),
      h('span', { class: 'spacer' }),
      isNew ? null : h('button', {
        class: 'btn danger', type: 'button', text: 'Delete', onclick: () => deleteTag(tag),
      }),
    );

    replace($('#tag-editor'),
      h('h2', { style: 'margin-top:0;font-size:var(--text-md)', text: isNew ? 'New tag' : tag.slug }),
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

    banner('ok', isNew ? `Created tag "${res.body.tag.slug}".` : `Saved tag "${res.body.tag.slug}".`);
    await Promise.all([loadTags(), loadLocations()]);
    selectTag(res.body.tag.slug);
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
        onclick: () => {
          switchTab('locations');
          $('#loc-search').value = tag.slug;
          $('#loc-status').value = '';
          $('#loc-category').value = '';
          renderLocations();
        },
      });
      return banner('error',
        `"${tag.slug}" is still attached to ${res.body.usage_count} location(s), so it was not deleted. `
        + 'Remove it from those records first — nothing was changed.',
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
    replace($('#tag-editor'), h('p', { class: 'muted', text: 'Select a tag to edit it, or create a new one.' }));
  }

  function selectTag(slug) {
    state.selectedTag = slug;
    clearBanner();
    if (slug === null) {
      renderTags();
      return replace($('#tag-editor'),
        h('p', { class: 'muted', text: 'Select a tag to edit it, or create a new one.' }));
    }
    renderTags();
    const tag = slug === '' ? { ...BLANK_TAG } : state.tags.find((t) => t.slug === slug);
    if (tag) renderTagEditor(tag);
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
   * Read dataset age off /v1/health — public and uncached, so no extra route.
   *
   * 🔴 An unreadable health check renders as `unknown`, never as fresh. A blank
   * or green indicator that actually means "I could not tell" is the same class
   * of lie as reporting an unrecognised status as a successful login.
   */
  async function refreshFreshness() {
    const el = $('#freshness');
    let age = null;
    try {
      const res = await fetch(`${API}/v1/health`);
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

  /** Rebuild the served dataset from whatever DATA_SOURCE says. */
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
    // "Nothing changed" is a real outcome, not a nicer way of saying "done".
    // If the admin just edited a record and the rebuild reports no change,
    // that is worth knowing rather than smoothing over.
    banner('ok', res.body.changed
      ? `Rebuilt from ${res.body.source}. New dataset version ${res.body.dataset_version}.`
      : `Rebuilt from ${res.body.source}. The content hash was unchanged, so nothing was rewritten.`);
    await refreshFreshness();
    // A rebuild is precisely what resolves registry-vs-served drift, so the
    // panel that reports it has to be recomputed or it keeps showing the gap
    // it just closed.
    if (!$('#tab-overview').hidden) await renderOverview();
  }

  // ------------------------------------------------------------ overview --

  /**
   * The stats panel.
   *
   * 🔴 EVERY number here is derived from records already fetched for the other
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

  const stat = (value, label, kind) => h('div', { class: `stat${kind ? ` ${kind}` : ''}` },
    h('span', { class: 'value', text: String(value) }),
    h('span', { class: 'label', text: label }));

  function breakdown(entries, total) {
    if (!entries.length) return h('p', { class: 'muted', text: 'Nothing to count yet.' });
    const max = Math.max(...entries.map(([, n]) => n));
    return entries.map(([name, n]) => h('div', { class: 'breakdown-row' },
      h('span', { class: 'k', text: String(name).replace(/-/g, ' ') }),
      // The bar is decoration on top of the number, never a replacement for it.
      h('span', { class: 'bar' }, h('span', { style: `width:${Math.round((n / max) * 100)}%` })),
      h('span', { class: 'n', text: total ? `${n}  (${Math.round((n / total) * 100)}%)` : String(n) })));
  }

  const kvRow = (k, v, kind) => h('div', { class: 'kv-row' },
    h('span', { class: 'k', text: k }),
    h('span', { class: `v${kind ? ` ${kind}` : ''}`, text: v }));

  /**
   * Health, and the one comparison that matters most.
   *
   * `registry` is what D1 holds; `served` is what the public API returns. They
   * are two independent counts of the same thing, and a gap between them means
   * a write has not reached the map. That gap is exactly what went unnoticed
   * for 14 hours — staging had no cron, so D1 said 297 while /v1 served 296 and
   * nothing anywhere said so. Prefer the dumbest possible comparison.
   */
  async function renderOverview() {
    const records = state.locations;
    const published = records.filter((r) => r.status === 'published');

    replace($('#stat-registry'),
      stat(records.length, 'in D1'),
      stat(published.length, 'published', 'good'),
      stat(records.filter((r) => r.status === 'hidden').length, 'hidden',
        records.some((r) => r.status === 'hidden') ? 'warn' : null),
      stat(records.filter((r) => r.status === 'draft').length, 'draft'),
      stat(records.filter((r) => r.source === 'auto').length, 'auto-discovered'),
      stat(records.filter((r) => !/^\d+$/.test(String(r.nexus_id))).length, 'WIP / Dummy'),
      stat(state.tags.length, 'tags'),
      stat(records.filter((r) => !r.tags.length).length, 'untagged',
        records.some((r) => !r.tags.length) ? 'warn' : null));

    replace($('#stat-category'), breakdown(countBy(records, (r) => r.category), records.length));
    replace($('#stat-tag'), breakdown(countBy(records, (r) => r.tags), records.length));

    // --- health, from the public endpoints -------------------------------
    let health = null;
    let servedCount = null;
    let servedDistricts = [];
    try {
      const [h1, l1] = await Promise.all([
        fetch(`${API}/v1/health`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/v1/locations`).then((r) => (r.ok ? r.json() : null)),
      ]);
      health = h1?.data ?? null;
      if (Array.isArray(l1?.data)) {
        servedCount = l1.data.length;
        servedDistricts = countBy(l1.data, (r) => r.district);
      }
    } catch { /* rendered as unknown below */ }

    replace($('#stat-district'), breakdown(servedDistricts, servedCount ?? 0));

    const rows = [];
    if (!health) {
      // Unreadable is its own state. Never draw a blank as healthy.
      rows.push(kvRow('status', 'could not reach the API', 'bad'));
    } else {
      const age = health.refresh_age_seconds;
      const stale = typeof age === 'number' && age > STALE_AFTER_S;
      rows.push(kvRow('status', health.status ?? 'unknown', health.status === 'ok' ? 'ok' : 'bad'));
      rows.push(kvRow('api version', health.version ?? '—'));
      rows.push(kvRow('last refresh', typeof age === 'number' ? describeAge(age) : 'unknown',
        stale ? 'warn' : 'ok'));
      rows.push(kvRow('last refresh at', health.last_refresh_at ?? '—', 'mono'));
      // discovery_stale means the last cycle failed and last-known-good is being
      // served. Absent is not the same as false, so it is reported as unknown.
      const ds = health.discovery_stale;
      rows.push(kvRow('discovery', ds === true ? 'STALE — last cycle failed'
        : ds === false ? 'ok' : 'not reported',
      ds === true ? 'bad' : ds === false ? 'ok' : null));
    }

    // 🔴 Two independent counts of the same thing.
    rows.push(kvRow('registry (D1)', String(records.length)));
    rows.push(kvRow('published in D1', String(published.length)));
    rows.push(kvRow('served by /v1', servedCount === null ? 'unknown' : String(servedCount),
      servedCount === null ? null : servedCount === published.length ? 'ok' : 'bad'));
    if (servedCount !== null && servedCount !== published.length) {
      rows.push(kvRow('drift',
        `${published.length - servedCount} record(s) not on the map — rebuild`, 'bad'));
    }
    rows.push(kvRow('api host', API.replace('https://', ''), 'mono'));

    replace($('#health-kv'), rows);
  }

  // --------------------------------------------------------------- audit --

  /** Field-level diff between two audit snapshots. */
  function renderDiff(before, after) {
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
    const rows = [];
    for (const key of keys) {
      const from = before ? before[key] : undefined;
      const to = after ? after[key] : undefined;
      // updated_at moves on every write; showing it as a change is noise that
      // makes the real change harder to find.
      if (key === 'updated_at') continue;
      if (sameValue(from, to)) continue;
      rows.push(h('div', {},
        h('span', { class: 'k', text: `${key}: ` }),
        before ? h('span', { class: 'from', text: JSON.stringify(from) }) : null,
        before && after ? ' → ' : null,
        after ? h('span', { class: 'to', text: JSON.stringify(to) }) : null));
    }
    return rows.length ? h('div', { class: 'diff' }, rows) : h('p', { class: 'muted', text: 'No field changes recorded.' });
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
          h('time', { datetime: e.at, text: new Date(e.at).toLocaleString() }),
          h('span', { class: 'action', text: e.action }),
          h('span', { class: 'who', text: e.actor }),
          h('span', { class: 'target', text: e.target || '' })),
        h('details', {}, h('summary', { text: 'What changed' }), renderDiff(e.before, e.after))))
      : h('p', { class: 'muted', text: 'No entries yet.' }));
  }

  // ---------------------------------------------------------------- tabs --

  const TABS = ['overview', 'locations', 'tags', 'audit'];

  function switchTab(name) {
    for (const btn of document.querySelectorAll('nav.tabs button')) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    }
    for (const id of TABS) {
      $(`#tab-${id}`).hidden = id !== name;
    }
    if (name === 'audit') loadAudit();
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
    for (const id of ['#loc-search', '#loc-status', '#loc-category']) {
      $(id).addEventListener('input', renderLocations);
    }
    $('#loc-new').onclick = () => selectLocation('');
    $('#tag-new').onclick = () => selectTag('');
    $('#audit-refresh').onclick = loadAudit;
    $('#audit-limit').onchange = loadAudit;
    $('#rebuild').onclick = (e) => rebuildDataset(e.currentTarget);

    // Tags first: the location editor's picker is built from them.
    await loadTags();
    await loadLocations();
    await refreshFreshness();
    // Overview is the landing tab, and its numbers come from what was just
    // loaded, so it is rendered after both rather than on its own fetch.
    await renderOverview();
  }

  main();
})();
