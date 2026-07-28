/**
 * NC Zoning Board: Main Application Logic
 * DOM manipulation, map initialisation, event handlers, sidebar, modals, image gallery.
 * Depends on: constants.js, utils.js, services.js (via NCZ namespace).
 */

document.addEventListener("DOMContentLoaded", () => {
  // Terminal header close buttons: delegates to each modal's existing close button
  document.querySelectorAll(".terminal-close-btn[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = document.getElementById(btn.dataset.closeModal);
      if (modal) modal.classList.add("hidden");
      // Preserve welcome modal session flag
      if (btn.dataset.closeModal === "welcome-modal") {
        sessionStorage.setItem("nc_zoning_board_visited", "true");
      }
    });
  });

  // Welcome Modal Logic: runs immediately, independent of map loading
  const welcomeModal = document.getElementById("welcome-modal");
  const closeModalBtn = document.getElementById("close-modal");

  if (!sessionStorage.getItem("nc_zoning_board_visited")) {
    welcomeModal.classList.remove("hidden");
  } else {
    welcomeModal.classList.add("hidden");
  }

  closeModalBtn.addEventListener("click", () => {
    welcomeModal.classList.add("hidden");
    sessionStorage.setItem("nc_zoning_board_visited", "true");
  });

  // About Modal Logic
  const aboutBtn = document.getElementById("about-btn");
  const aboutModal = document.getElementById("about-modal");
  const closeAboutBtn = document.getElementById("close-about-modal");
  const aboutOpenSubmitLink = document.getElementById("about-open-submit-link");
  const sidebarOpenSubmitLink = document.getElementById("sidebar-open-submit-link");

  aboutBtn.addEventListener("click", () => {
    aboutModal.classList.remove("hidden");
  });

  closeAboutBtn.addEventListener("click", () => {
    aboutModal.classList.add("hidden");
  });

  // WebGPU-unsupported notice: footer button. The header X is handled by the
  // delegated .terminal-close-btn[data-close-modal] listener above.
  const closeWebgpuModalBtn = document.getElementById("close-webgpu-unsupported-modal");
  if (closeWebgpuModalBtn) {
    closeWebgpuModalBtn.addEventListener("click", () => {
      document.getElementById("webgpu-unsupported-modal").classList.add("hidden");
    });
  }

// Parameters Modal Logic
  const parametersBtn = document.getElementById("parameters-btn");
  const parametersModal = document.getElementById("parameters-modal");
  const closeParametersModalBtn = document.getElementById("close-parameters-modal");
  const themeSelect = document.getElementById("theme-select");
  const headerLogoImg = document.getElementById("header-logo-img");
  const themedModalHeaderLabels = document.querySelectorAll(".terminal-header-theme-label[data-modal-title]");
  const themes = Array.isArray(NCZ.THEMES) && NCZ.THEMES.length
    ? NCZ.THEMES
    : [{
      id: "night-corp",
      label: "Night Corp",
      className: "theme-night-corp",
      logo: "assets/img/nightcorp-logo.svg",
      logoAlt: "Night Corp",
    }];

  function openParametersModal() {
    if (parametersModal) parametersModal.classList.remove("hidden");
  }

  function closeParametersModal() {
    if (parametersModal) parametersModal.classList.add("hidden");
  }

  if (parametersBtn) parametersBtn.addEventListener("click", openParametersModal);
  if (closeParametersModalBtn) closeParametersModalBtn.addEventListener("click", closeParametersModal);

  function findThemeById(themeId) {
    return themes.find((theme) => theme.id === themeId) || themes[0];
  }

  function findThemeByClassName(themeClassName) {
    return themes.find((theme) => theme.className === themeClassName) || themes[0];
  }

  function getStoredThemeId() {
    try {
      const storedThemeId = localStorage.getItem(NCZ.THEME_PREFERENCE_KEY);
      if (!storedThemeId) return null;
      return themes.some((theme) => theme.id === storedThemeId) ? storedThemeId : null;
    } catch (_) {
      return null;
    }
  }

  function findActiveThemeClassName() {
    return Array.from(document.documentElement.classList).find((cls) =>
      cls.startsWith("theme-")
    );
  }

  function getInitialThemeId() {
    const storedThemeId = getStoredThemeId();
    if (storedThemeId) return storedThemeId;

    const activeThemeClass = findActiveThemeClassName();
    return activeThemeClass ? findThemeByClassName(activeThemeClass).id : themes[0].id;
  }

  function applyHeaderThemeBranding(theme) {
    if (!headerLogoImg || !theme) return;
    if (theme.logo) headerLogoImg.src = theme.logo;
    headerLogoImg.alt = theme.logoAlt || theme.label || "Header logo";
  }

  function applyModalHeaderThemeBranding(theme) {
    const themePrefix = (theme?.label || "Night Corp").toUpperCase();
    themedModalHeaderLabels.forEach((label) => {
      const modalTitle = label.dataset.modalTitle || "";
      label.textContent = `${themePrefix} // ${modalTitle}`;
    });
  }

  // Reflect a theme's render-toggle defaults (--scene-grade / --scene-edge-glow)
  // into the Settings checkboxes. Reads the CSS var directly so it's independent
  // of the scene's async build timing (buildings, and thus glow, finish after
  // init resolves). Called at initial load and on every theme switch, both of
  // which reset the toggles to the active theme's default.
  function syncRenderToggles() {
    const flag = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) > 0;
    const lut  = document.getElementById('lut-grade-toggle');
    const glow = document.getElementById('edge-glow-toggle');
    if (lut)  lut.checked  = flag('--scene-grade');
    if (glow) glow.checked = flag('--scene-edge-glow');
  }

  function applyThemeById(themeId, { persist = true } = {}) {
    const theme = findThemeById(themeId);
    const targetClass = theme.className || `theme-${theme.id}`;
    const root = document.documentElement;

    Array.from(root.classList)
      .filter((cls) => cls.startsWith("theme-"))
      .forEach((cls) => root.classList.remove(cls));
    root.classList.add(targetClass);

    applyHeaderThemeBranding(theme);
    applyModalHeaderThemeBranding(theme);
    if (themeSelect) themeSelect.value = theme.id;

    if (persist) {
      try {
        localStorage.setItem(NCZ.THEME_PREFERENCE_KEY, theme.id);
      } catch (_) {
        // Ignore storage write failures (private mode / restricted browsers).
      }
    }

    // Update Three.js scene materials and clear the 2D overlay tile cache
    // so both renderers pick up the new CSS custom properties immediately.
    NCZ.ThreeScene?.updateMaterials();
    // A theme switch resets the LUT grade + edge glow to the new theme's
    // defaults; reflect that in the Settings toggles.
    syncRenderToggles();
    NCZ._clearOverlayCache?.();
  }

  // Expose for flyover.js; persist:false so showcase changes don't overwrite
  // the user's saved preference in localStorage.
  NCZ.applyTheme = (id) => applyThemeById(id, { persist: false });

  const initialThemeId = getInitialThemeId();

  if (themeSelect) {
    themeSelect.innerHTML = "";
    themes.forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      themeSelect.appendChild(option);
    });

    applyThemeById(initialThemeId, { persist: false });

    themeSelect.addEventListener("change", () => {
      applyThemeById(themeSelect.value);
    });
  } else {
    applyThemeById(initialThemeId, { persist: false });
  }

  // Submit a Location Modal
  const submitOpenBtn = document.getElementById("submit-open-btn");
  const submitModal = document.getElementById("submit-modal");
  const closeSubmitModalBtn = document.getElementById("close-submit-modal");
  const submitForm = submitModal?.querySelector(".submit-form");
  const modSelect = document.getElementById("submit-mod-select");
  const modManualRow = document.getElementById("submit-mod-manual");
  const modCard = document.getElementById("submit-mod-card");
  const modCardName = document.getElementById("submit-mod-card-name");
  const modThumb = document.getElementById("submit-mod-thumb");
  const nameInput = document.getElementById("submit-name");
  const authorsInput = document.getElementById("submit-authors");
  const descriptionInput = document.getElementById("submit-description");
  const descriptionCount = document.getElementById("submit-description-count");
  const sendBtn = document.getElementById("submit-send-btn");
  const donePanel = document.getElementById("submit-done");
  const formErrorEl = document.getElementById("submit-form-error");

  const reasonInput = document.getElementById("submit-reason");
  const targetBanner = document.getElementById("submit-target");
  const stepsList = document.getElementById("submit-steps");
  const introLine = document.getElementById("submit-intro");

  const MANUAL_MOD_VALUE = "__manual__";
  const ERROR_FIELDS = [
    "nexus_id", "name", "description", "coordinates", "yaw", "category",
    "tags", "authors", "reason", "note", "contact", "turnstile",
  ];
  // The control to focus when a field is refused, in the order the form reads.
  const FIELD_CONTROL = {
    nexus_id: "submit-nexus-ref",
    name: "submit-name",
    description: "submit-description",
    coordinates: "submit-coord-x",
    yaw: "submit-yaw",
    category: "submit-category",
    authors: "submit-authors",
    reason: "submit-reason",
    note: "submit-note",
    contact: "submit-contact",
  };

  let candidates = [];
  let candidatesState = "idle";
  // A prefilled value is replaced when the mod changes; a typed one is not.
  let nameIsPrefilled = true;
  let descriptionIsPrefilled = true;
  let authorsIsPrefilled = true;

  // ── Modes ──────────────────────────────────────────────────────────────────
  //
  // One modal, three jobs: propose a new pin, propose a change to one, or ask
  // for one to be taken down. They post the same three shapes to the same route
  // and share every field, so a second modal would be the same form twice with
  // two sets of validation to keep in step.
  //
  // `create` is the only mode that picks a mod; `remove` carries a reason and no
  // location fields at all, because there is nothing for a reviewer to apply.

  const MODES = {
    create: {
      title: "SUBMIT A LOCATION",
      send: "[ SUBMIT FOR REVIEW ]",
      done: "QUEUED FOR REVIEW",
      doneBody: "is in the review queue. A reviewer checks the coordinates before anything is published, and nothing appears on the map until one approves it.",
    },
    edit: {
      title: "SUGGEST AN EDIT",
      send: "[ SEND THE CHANGES ]",
      done: "CHANGES QUEUED",
      doneBody: "is in the review queue. The pin on the map is unchanged until a reviewer approves the edit.",
    },
    remove: {
      title: "REQUEST A REMOVAL",
      send: "[ SEND THE REQUEST ]",
      done: "REMOVAL REQUESTED",
      doneBody: "is in the review queue. The pin stays on the map until a reviewer decides.",
    },
  };

  let formMode = "create";
  // The record an edit or a report is against, held so the diff has something to
  // compare with. Null in create mode.
  let editTarget = null;

  // The modal header is rebuilt from data-modal-title on every theme change, so
  // the mode has to write the attribute rather than the text.
  function setSubmitModalTitle(title) {
    const label = submitModal?.querySelector(".terminal-header-theme-label[data-modal-title]");
    if (!label) return;
    label.dataset.modalTitle = title;
    const prefix = label.textContent.split("//")[0].trim();
    label.textContent = `${prefix} // ${title}`;
  }

  function applyMode(mode, record) {
    formMode = mode;
    editTarget = record ?? null;
    const config = MODES[mode];

    submitForm?.classList.toggle("is-edit", mode === "edit");
    submitForm?.classList.toggle("is-report", mode === "remove");
    // Kept in step whether the mode came from the radios or from opening the
    // modal, so the form never describes one intent and post another.
    submitModal?.querySelectorAll("input[name='submit-intent']").forEach((radio) => {
      radio.checked = radio.value === (mode === "remove" ? "remove" : "edit");
    });
    submitModal?.querySelectorAll(".submit-report-only").forEach((el) => {
      el.hidden = mode !== "remove";
    });

    // The steps describe finding coordinates for a pin that does not exist yet.
    if (stepsList) stepsList.hidden = mode !== "create";
    if (introLine) introLine.hidden = mode !== "create";

    if (targetBanner) {
      targetBanner.classList.toggle("hidden", !record);
      if (record) {
        const verb = mode === "remove" ? "Asking to remove" : "Editing";
        targetBanner.innerHTML = `${verb} <span class="submit-target-name"></span>`;
        targetBanner.querySelector(".submit-target-name").textContent = record.name;
      }
    }

    setSubmitModalTitle(config.title);
    if (sendBtn) sendBtn.textContent = config.send;
  }

  function openSubmitModal(mode = "create", record = null) {
    resetSubmitForm({ keepMode: true });
    applyMode(mode, record);
    if (record && mode === "edit") prefillFromRecord(record);
    submitModal.classList.remove("hidden");
    submitModal.querySelector(".submit-modal-body").scrollTop = 0;
    if (mode === "create") loadCandidates();
    mountTurnstile();
  }

  function closeSubmitModal() {
    submitModal.classList.add("hidden");
  }

  // Fill the form from a record the map is already holding. No fetch: an edit is
  // proposed against exactly the copy the submitter is looking at.
  function prefillFromRecord(record) {
    const [x, y, z] = record.coordinates ?? [];
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value ?? "";
    };
    set("submit-name", record.name);
    set("submit-description", record.description);
    set("submit-coord-x", x);
    set("submit-coord-y", y);
    set("submit-coord-z", z);
    set("submit-yaw", record.yaw);
    set("submit-category", record.category);
    set("submit-authors", (record.authors ?? []).join(", "));
    set("submit-credits", record.credits);
    document.querySelectorAll("#submit-tag-checkboxes input").forEach((cb) => {
      cb.checked = (record.tags ?? []).includes(cb.value);
    });
    updateDescriptionCount();
  }

  // ── Turnstile ──────────────────────────────────────────────────────────────
  // Loaded when the modal first opens rather than on page load: it is a
  // third-party script every visitor would otherwise fetch to render a map.

  const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  let turnstileScript = null;
  let turnstileWidget = null;

  function loadTurnstileScript() {
    if (turnstileScript) return turnstileScript;
    turnstileScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TURNSTILE_SRC;
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Turnstile script failed to load"));
      document.head.appendChild(script);
    });
    return turnstileScript;
  }

  async function mountTurnstile() {
    if (turnstileWidget !== null) return;
    if (!NCZ.TURNSTILE_SITE_KEY) {
      setFieldError("turnstile", "The bot check is not configured on this site, so the form cannot be sent. Report this to the maintainers.");
      if (sendBtn) sendBtn.disabled = true;
      return;
    }
    try {
      await loadTurnstileScript();
      turnstileWidget = window.turnstile.render("#submit-turnstile", {
        sitekey: NCZ.TURNSTILE_SITE_KEY,
        // Every theme on this site is dark, so the widget's own auto mode
        // (which follows the operating system) gets it wrong half the time.
        theme: "dark",
        callback: () => setFieldError("turnstile", null),
      });
    } catch {
      // A blocked or failed widget script leaves no way to obtain a token, and
      // the server refuses a submission without one, so say that rather than
      // letting the submitter fill the form and lose it at the send.
      setFieldError("turnstile", "The bot check could not load. A content blocker or network filter is the usual cause.");
      if (sendBtn) sendBtn.disabled = true;
    }
  }

  function turnstileToken() {
    if (turnstileWidget === null) return "";
    return window.turnstile?.getResponse(turnstileWidget) ?? "";
  }

  // Tokens are single-use and expire after five minutes, so every refusal path
  // that consumed one has to hand back a fresh widget.
  function resetTurnstile() {
    if (turnstileWidget !== null) window.turnstile?.reset(turnstileWidget);
  }

  // ── Field errors ───────────────────────────────────────────────────────────

  function setFieldError(field, message) {
    const el = document.getElementById(`submit-error-${field}`);
    if (!el) return;
    el.textContent = message ?? "";
    el.hidden = !message;
    const control = document.getElementById(FIELD_CONTROL[field]);
    if (control) control.setAttribute("aria-invalid", message ? "true" : "false");
  }

  // The coordinate row is one message and three boxes, so the message alone
  // cannot say which number is wrong. aria-invalid carries it, and the styling
  // hangs off that attribute rather than a class, so the marking a screen
  // reader announces and the red border are the same fact.
  function markCoordinateAxes(axes) {
    ["x", "y", "z"].forEach((axis) => {
      const box = document.getElementById(`submit-coord-${axis}`);
      box?.setAttribute("aria-invalid", axes.includes(axis) ? "true" : "false");
    });
  }

  function setFormError(message, { tone = "error" } = {}) {
    if (!formErrorEl) return;
    formErrorEl.textContent = message ?? "";
    formErrorEl.hidden = !message;
    formErrorEl.classList.toggle("submit-form-error-notice", tone === "notice");
  }

  function clearErrors() {
    ERROR_FIELDS.forEach((field) => setFieldError(field, null));
    markCoordinateAxes([]);
    setFormError(null);
  }

  function showErrors(errors) {
    Object.entries(errors).forEach(([field, message]) => setFieldError(field, message));
    const raw = readForm();
    markCoordinateAxes(errors.coordinates ? NCZ.coordinateProblems(raw.x, raw.y, raw.z).axes : []);
    const first = ERROR_FIELDS.find((field) => errors[field]);
    const control = document.getElementById(FIELD_CONTROL[first]);
    if (control) control.focus();
  }

  // ── Mod selection ──────────────────────────────────────────────────────────

  function renderCandidateOptions() {
    if (!modSelect) return;
    modSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = candidatesState === "failed"
      ? "Tagged mod list unavailable"
      : "Select your mod";
    modSelect.appendChild(placeholder);

    candidates.forEach((candidate) => {
      const option = document.createElement("option");
      option.value = candidate.nexus_id;
      option.textContent = candidate.name;
      modSelect.appendChild(option);
    });

    const manual = document.createElement("option");
    manual.value = MANUAL_MOD_VALUE;
    manual.textContent = candidates.length ? "My mod isn't listed" : "Enter my mod's Nexus link";
    modSelect.appendChild(manual);

    // Nothing to choose between: the manual path is the only one, so select it
    // rather than making the submitter open a two-item list to find that out.
    if (!candidates.length) {
      modSelect.value = MANUAL_MOD_VALUE;
      onModSelectionChange();
    }
  }

  async function loadCandidates() {
    if (candidatesState === "loading" || candidatesState === "loaded") return;
    candidatesState = "loading";
    try {
      candidates = await NCZ.fetchSubmissionCandidates();
      candidatesState = "loaded";
    } catch {
      candidates = [];
      candidatesState = "failed";
    }
    renderCandidateOptions();
  }

  function selectedCandidate() {
    return candidates.find((c) => c.nexus_id === modSelect?.value) ?? null;
  }

  function onModSelectionChange() {
    if (!modSelect) return;
    const manual = modSelect.value === MANUAL_MOD_VALUE;
    modManualRow?.classList.toggle("hidden", !manual);

    const candidate = selectedCandidate();
    modCard?.classList.toggle("hidden", !candidate);
    if (candidate) {
      modCardName.textContent = candidate.name;
      modThumb.hidden = !candidate.thumbnail_url;
      if (candidate.thumbnail_url) {
        modThumb.src = candidate.thumbnail_url;
        modThumb.alt = "";
      }
      if (nameIsPrefilled && nameInput) nameInput.value = candidate.name;
      // The mod's Nexus summary, truncated the way an auto-discovered record's
      // description was built from it. A starting point to edit, not an answer.
      if (descriptionIsPrefilled && descriptionInput) {
        descriptionInput.value = NCZ.summaryToDescription(candidate.summary);
        updateDescriptionCount();
      }
      // The uploader is the first author on an auto-discovered record, and a
      // co-author is a name only the submitter knows, so the field stays a
      // comma-separated list rather than becoming read-only.
      if (authorsIsPrefilled && authorsInput) {
        authorsInput.value = candidate.uploader ?? "";
      }
    }
    setFieldError("nexus_id", null);
  }

  // The mod id the payload carries: the picked candidate, or whatever the
  // manual field holds. collectLocationForm parses and refuses it, so this
  // hands over the raw text rather than deciding here.
  function nexusRefValue() {
    if (!modSelect || modSelect.value === MANUAL_MOD_VALUE || !modSelect.value) {
      return document.getElementById("submit-nexus-ref")?.value ?? "";
    }
    return modSelect.value;
  }

  function readForm() {
    return {
      name: nameInput?.value,
      description: descriptionInput?.value,
      x: document.getElementById("submit-coord-x").value,
      y: document.getElementById("submit-coord-y").value,
      z: document.getElementById("submit-coord-z").value,
      yaw: document.getElementById("submit-yaw").value,
      category: document.getElementById("submit-category").value,
      authors: document.getElementById("submit-authors").value,
      credits: document.getElementById("submit-credits").value,
      nexusId: nexusRefValue(),
      note: document.getElementById("submit-note")?.value,
      contact: document.getElementById("submit-contact")?.value,
      reason: reasonInput?.value,
      tags: Array.from(
        document.querySelectorAll("#submit-tag-checkboxes input:checked"),
      ).map((cb) => cb.value),
    };
  }

  function knownTagSlugs() {
    return Array.from(
      document.querySelectorAll("#submit-tag-checkboxes input"),
    ).map((cb) => cb.value);
  }

  if (modSelect) modSelect.addEventListener("change", onModSelectionChange);
  if (nameInput) {
    nameInput.addEventListener("input", () => { nameIsPrefilled = false; });
  }
  if (authorsInput) {
    authorsInput.addEventListener("input", () => { authorsIsPrefilled = false; });
  }
  function updateDescriptionCount() {
    if (descriptionCount && descriptionInput) {
      descriptionCount.textContent = String(descriptionInput.value.length);
    }
  }

  if (descriptionInput) {
    descriptionInput.addEventListener("input", () => {
      descriptionIsPrefilled = false;
      updateDescriptionCount();
    });
  }

  // The coordinates are the field most easily got wrong (a swapped axis, a
  // dropped minus sign) and the only one a submitter cannot check against
  // anything else on the page, so they are checked as they are typed.
  //
  // A blank stands in as 0, which is inside every bound: a half-filled row is
  // unfinished rather than wrong, and saying so while someone is still typing
  // the first number teaches them to ignore the message.
  function validateCoordinatesLive() {
    const raw = readForm();
    const typed = ["x", "y", "z"].map((axis) => String(raw[axis] ?? "").trim());
    if (typed.every((value) => !value)) {
      setFieldError("coordinates", null);
      markCoordinateAxes([]);
      return;
    }
    const [x, y, z] = typed;
    const problems = NCZ.coordinateProblems(x || "0", y || "0", z || "0");
    setFieldError("coordinates", problems.message);
    // Only the boxes with something in them: a blank stood in as 0 above, and
    // reddening a box the submitter has not reached yet is a false accusation.
    const filled = new Set(["x", "y", "z"].filter((_, i) => typed[i]));
    markCoordinateAxes(problems.axes.filter((axis) => filled.has(axis)));
  }

  ["submit-coord-x", "submit-coord-y", "submit-coord-z"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", validateCoordinatesLive);
  });

  if (aboutOpenSubmitLink) {
    aboutOpenSubmitLink.addEventListener("click", (event) => {
      event.preventDefault();
      aboutModal.classList.add("hidden");
      openSubmitModal();
    });
  }

  if (sidebarOpenSubmitLink) {
    sidebarOpenSubmitLink.addEventListener("click", (event) => {
      event.preventDefault();
      openSubmitModal();
    });
  }

  // Wrapped, not passed directly: openSubmitModal's first parameter is the mode,
  // and addEventListener would hand it a MouseEvent.
  if (submitOpenBtn) submitOpenBtn.addEventListener("click", () => openSubmitModal());
  if (closeSubmitModalBtn) closeSubmitModalBtn.addEventListener("click", closeSubmitModal);

  // \u2500\u2500 Send \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  // The refusals POST /submissions distinguishes. Each one says something
  // different to a submitter, and collapsing them into "something went wrong"
  // costs the two that are not their fault: an expired token and a rate limit.
  function reportRefusal(result) {
    switch (result.code) {
      case "turnstile_expired":
        resetTurnstile();
        setFieldError("turnstile", "The check timed out, which happens when a form sits open for a few minutes. It has been reset: complete it again and send.");
        break;
      case "turnstile_missing":
      case "turnstile_failed":
        resetTurnstile();
        setFieldError("turnstile", "The check did not pass. Complete it again and send.");
        break;
      case "rate_limited":
        // Not a validation error, and must not read as one: the form is
        // correct and the only fix is time.
        setFormError("This connection has sent the most submissions an hour allows. Nothing is wrong with the form. Try again later, and the submissions already queued are unaffected.", { tone: "notice" });
        break;
      case "verification_unavailable":
      case "submissions_unavailable":
        resetTurnstile();
        setFormError("Submissions are unavailable at the moment. This is a fault on the site, not in what you entered. Try again later.");
        break;
      case "invalid_submission":
        // The browser validated with the same rules, so a refusal here means
        // the two disagree. Show what the server said rather than paraphrasing.
        setFormError(`The server refused this submission: ${result.errors.join("; ") || "no detail given"}`);
        break;
      case "network":
        setFormError("The submission did not reach the server. Check your connection and try again.");
        break;
      default:
        setFormError(`The server refused this submission (HTTP ${result.status}).`);
    }
  }

  function showSubmitted(id) {
    const config = MODES[formMode];
    const idEl = document.getElementById("submit-done-id");
    if (idEl) idEl.textContent = id === null || id === undefined ? "" : `#${id}`;

    const title = donePanel?.querySelector(".submit-done-title");
    if (title) title.textContent = config.done;
    const detail = document.getElementById("submit-done-detail");
    if (detail) detail.textContent = config.doneBody;
    const againBtn = document.getElementById("submit-another-btn");
    if (againBtn) againBtn.textContent = formMode === "create" ? "[ SUBMIT ANOTHER ]" : "[ CLOSE ]";
    submitForm?.classList.add("is-submitted");
    // The steps and the note sit outside the form and describe filling it in,
    // down to "leave a contact below", so they go with it.
    submitModal?.querySelector(".submit-modal-body")?.classList.add("is-submitted");
    donePanel?.classList.remove("hidden");
    donePanel?.scrollIntoView({ block: "nearest" });
  }

  // The submission this form is currently describing, or the errors stopping it.
  //
  // A removal deliberately never reads the location fields: they are hidden in
  // that mode, and the server refuses a payload on `kind: 'remove'` because
  // there is nothing for a reviewer to apply.
  function buildSubmission(raw, token) {
    const meta = NCZ.collectSubmissionMeta(raw);
    const errors = { ...meta.errors };
    if (!token) errors.turnstile = "Complete the check above before submitting.";

    if (formMode === "remove") {
      const reason = String(raw.reason ?? "").trim();
      if (!reason) {
        errors.reason = "Say what is wrong with this pin, so a reviewer can act on it.";
      } else if (reason.length > NCZ.SUBMISSION_NOTE_MAX) {
        errors.reason = `Keep this to ${NCZ.SUBMISSION_NOTE_MAX} characters or fewer.`;
      }
      return {
        errors,
        body: {
          kind: "remove",
          location_id: editTarget?.id,
          reason,
          turnstile_token: token,
          ...meta.values,
        },
      };
    }

    const collected = NCZ.collectLocationForm(raw, {
      knownTags: knownTagSlugs(),
      // An edit never asks which mod this is: the record answers that, and its
      // id may be one the new-pin path would refuse.
      fixedNexusId: formMode === "edit" ? editTarget?.nexus_id : undefined,
    });
    Object.assign(errors, collected.errors);

    if (formMode === "edit") {
      const changed = NCZ.diffLocation(editTarget, collected.values);
      return {
        errors,
        empty: Object.keys(changed).length === 0,
        body: {
          kind: "edit",
          location_id: editTarget?.id,
          payload: changed,
          turnstile_token: token,
          ...meta.values,
        },
      };
    }

    return {
      errors,
      body: {
        kind: "create",
        payload: collected.values,
        turnstile_token: token,
        ...meta.values,
      },
    };
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", async () => {
      clearErrors();
      const raw = readForm();
      const { body, errors, empty } = buildSubmission(raw, turnstileToken());

      if (Object.keys(errors).length) {
        showErrors(errors);
        return;
      }
      if (empty) {
        // Not a validation failure: everything here is valid, there is just
        // nothing to review. The server would refuse it for the same reason.
        setFormError("Nothing has changed yet. Edit a field, then send.", { tone: "notice" });
        return;
      }

      sendBtn.disabled = true;
      sendBtn.textContent = "[ SENDING... ]";
      const result = await NCZ.postSubmission(body);
      sendBtn.disabled = false;
      sendBtn.textContent = MODES[formMode].send;

      if (result.ok) {
        showSubmitted(result.data?.id);
        return;
      }
      reportRefusal(result);
    });
  }

  function resetSubmitForm({ keepMode = false } = {}) {
    document.getElementById("submit-coord-x").value = "";
    document.getElementById("submit-coord-y").value = "";
    document.getElementById("submit-coord-z").value = "";
    document.getElementById("submit-yaw").value = "";
    document.getElementById("submit-category").value = "";
    document.getElementById("submit-credits").value = "";
    document.getElementById("submit-authors").value = "";
    document.querySelectorAll("#submit-tag-checkboxes input:checked").forEach((cb) => (cb.checked = false));

    if (nameInput) nameInput.value = "";
    if (descriptionInput) descriptionInput.value = "";
    if (descriptionCount) descriptionCount.textContent = "0";
    const nexusRef = document.getElementById("submit-nexus-ref");
    if (nexusRef) nexusRef.value = "";
    const noteInput = document.getElementById("submit-note");
    if (noteInput) noteInput.value = "";
    const contactInput = document.getElementById("submit-contact");
    if (contactInput) contactInput.value = "";
    if (modSelect) modSelect.value = candidates.length ? "" : MANUAL_MOD_VALUE;
    nameIsPrefilled = true;
    descriptionIsPrefilled = true;
    authorsIsPrefilled = true;
    onModSelectionChange();

    if (reasonInput) reasonInput.value = "";

    clearErrors();
    resetTurnstile();
    submitForm?.classList.remove("is-submitted");
    submitModal?.querySelector(".submit-modal-body")?.classList.remove("is-submitted");
    donePanel?.classList.add("hidden");

    // Reset lands back on `create` unless the caller is about to set a mode
    // itself, so the Reset button inside an edit does not silently turn it into
    // a new-pin submission carrying that pin's values.
    if (!keepMode && formMode !== "create") applyMode("create", null);
  }

  const submitResetBtn = document.getElementById("submit-reset-btn");
  if (submitResetBtn) submitResetBtn.addEventListener("click", resetSubmitForm);

  const submitAnotherBtn = document.getElementById("submit-another-btn");
  if (submitAnotherBtn) {
    submitAnotherBtn.addEventListener("click", () => {
      // After an edit or a report there is nothing to do again: the pin it was
      // about is the one the submitter just finished with.
      if (formMode !== "create") {
        closeSubmitModal();
        resetSubmitForm();
        return;
      }
      resetSubmitForm();
      modSelect?.focus();
    });
  }

  // ── The popup actions, for both views ──────────────────────────────────────
  //
  // One delegated listener rather than a handler bound per popup. Leaflet
  // rebuilds a popup's DOM every time it opens and the Three.js layer builds a
  // CSS2DObject card per pin, so binding at open time means two wirings, in two
  // files, that have to be kept in step. The buttons carry the location id and
  // this reads it wherever the click lands.
  document.addEventListener("click", (event) => {
    const fixBtn = event.target.closest("[data-edit-location]");
    if (!fixBtn) return;

    const record = NCZ.locationsById?.get(fixBtn.dataset.editLocation);
    if (!record) {
      // The dataset moved under an open popup, which the passive update check
      // makes possible. Saying so beats opening a form against nothing.
      alert("That pin is no longer in the loaded map data. Refresh and try again.");
      return;
    }
    openSubmitModal("edit", record);
  });

  // The intent radios switch between proposing changes and asking for the pin
  // to come off. Same record, same open form: only the shape of what gets sent
  // changes, so this re-applies the mode rather than reopening anything.
  submitModal?.querySelectorAll("input[name='submit-intent']").forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked || !editTarget) return;
      clearErrors();
      applyMode(radio.value === "remove" ? "remove" : "edit", editTarget);
    });
  });

  const copyCetBtn = document.getElementById("submit-copy-cet-btn");
  if (copyCetBtn) {
    let cetCopyRevertTimer = null;
    const revertCetBtn = () => {
      copyCetBtn.innerHTML = '<span class="ui-popup-action-link-icon" aria-hidden="true"></span>';
    };
    copyCetBtn.addEventListener("click", () => {
      const command = document.getElementById("submit-cet-command").textContent;
      clearTimeout(cetCopyRevertTimer);
      navigator.clipboard.writeText(command).then(() => {
        copyCetBtn.textContent = "Copied!";
        cetCopyRevertTimer = setTimeout(revertCetBtn, NCZ.COPY_FEEDBACK_MS);
      }).catch(() => {
        copyCetBtn.textContent = "Failed";
        cetCopyRevertTimer = setTimeout(revertCetBtn, NCZ.COPY_FEEDBACK_MS);
      });
    });
  }

  // Sync Offset Telemetry Animation
  const statusLed = document.querySelector(".status-led");
  const statusLabel = document.querySelector(".status-label");
  const statusTelemetry = document.querySelector(".status-telemetry");

  if (statusLed && statusLabel && statusTelemetry) {
    setInterval(() => {
      // Generate mostly low values with occasional spikes
      let offset;
      const roll = Math.random();
      if (roll < 0.85) {
        offset = Math.random() * 200; // Normal: 0–200ms
      } else if (roll < 0.95) {
        offset = 200 + Math.random() * 600; // Elevated: 200–800ms
      } else {
        offset = 800 + Math.random() * 1000; // Critical: >800ms
      }

      statusTelemetry.textContent = `SYNC_OFFSET: ${offset.toFixed(2)}ms`;

      // Update LED and status based on thresholds
      statusLed.classList.remove("led-amber", "led-red");
      statusLabel.classList.remove("status-elevated", "status-critical");

      if (offset > 800) {
        statusLed.classList.add("led-red");
        statusLabel.classList.add("status-critical");
        statusLabel.textContent = "[SYSTEM_STATUS: CRITICAL]";
      } else if (offset > 200) {
        statusLed.classList.add("led-amber");
        statusLabel.classList.add("status-elevated");
        statusLabel.textContent = "[SYSTEM_STATUS: ELEVATED]";
      } else {
        statusLabel.textContent = "[SYSTEM_STATUS: NOMINAL]";
      }
    }, 2000);
  }

  initMap();
});

/** Controls pin hover tooltip placement and visibility inside map bounds. */
function createPinTooltipController(map) {
  // Create one tooltip element we reuse for every marker.
  const container = map.getContainer();
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "pin-tooltip";
  tooltipEl.innerHTML = `
    <div class="pin-tooltip-content"></div>
    <div class="pin-tooltip-arrow" aria-hidden="true"></div>
  `;
  container.appendChild(tooltipEl);

  const contentEl = tooltipEl.querySelector(".pin-tooltip-content");
  let activeMarker = null;

  function clearDirectionClasses() {
    tooltipEl.classList.remove("dir-top", "dir-bottom", "dir-left", "dir-right");
  }

  function measureTooltip() {
    // Temporarily show tooltip to get its current size.
    tooltipEl.classList.add("visible", "measure");
    const rect = contentEl.getBoundingClientRect();
    tooltipEl.classList.remove("measure");
    return {
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
    };
  }

  function positionTooltip() {
    const markerEl = activeMarker?.getElement?.();
    if (!activeMarker || !markerEl) {
      hide();
      return;
    }

    const point = map.latLngToContainerPoint(activeMarker.getLatLng());
    const mapWidth = container.clientWidth;
    const mapHeight = container.clientHeight;
    const size = measureTooltip();
    const { direction, left, top, arrowX, arrowY } = NCZ.pickDirectionAndPosition(
      point,
      size,
      { x: mapWidth, y: mapHeight },
      {
        marginPx: NCZ.PIN_TOOLTIP_MARGIN_PX,
        gapPx: NCZ.PIN_TOOLTIP_GAP_PX,
        arrowSizePx: NCZ.PIN_TOOLTIP_ARROW_SIZE_PX,
        arrowEdgePaddingPx: NCZ.PIN_TOOLTIP_ARROW_EDGE_PADDING_PX,
      },
    );

    clearDirectionClasses();
    tooltipEl.classList.add(`dir-${direction}`);

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.setProperty("--pin-tooltip-arrow-x", `${arrowX}px`);
    tooltipEl.style.setProperty("--pin-tooltip-arrow-y", `${arrowY}px`);
  }

  function show(marker, text) {
    activeMarker = marker;
    contentEl.textContent = text;
    tooltipEl.classList.add("visible");
    positionTooltip();
  }

  function hide(marker = null) {
    if (marker && marker !== activeMarker) return;
    activeMarker = null;
    tooltipEl.classList.remove("visible");
  }

  return {
    show,
    hide,
    reposition: positionTooltip,
  };
}

/** Repositions an open popup so it stays visible and points to its pin. */
function positionDynamicPopup(map, popup) {
  if (!popup) return;

  const popupEl = popup.getElement?.();
  if (!popupEl) return;

  const wrapperEl = popupEl.querySelector(".leaflet-popup-content-wrapper");
  if (!wrapperEl) return;

  popupEl.classList.add("ncz-dynamic-popup");

  const imageEl = popupEl.querySelector(".custom-popup-header.has-image");
  const titleEl = popupEl.querySelector(".custom-popup-title");
  const imageHeight = imageEl ? Math.ceil(imageEl.getBoundingClientRect().height) : 0;
  const titleHeight = titleEl ? Math.ceil(titleEl.getBoundingClientRect().height) : 0;
  const gradientTopStopPx = imageHeight + titleHeight;
  const gradientBottomStopPx = gradientTopStopPx + 20;
  popupEl.style.setProperty("--ncz-popup-gradient-top-stop", `${gradientTopStopPx}px`);
  popupEl.style.setProperty("--ncz-popup-gradient-bottom-stop", `${gradientBottomStopPx}px`);

  // Read popup size and marker anchor position.
  const size = {
    width: Math.max(1, Math.ceil(wrapperEl.offsetWidth)),
    height: Math.max(1, Math.ceil(wrapperEl.offsetHeight)),
  };
  const mapSize = map.getSize();
  const anchor = map.latLngToContainerPoint(popup.getLatLng());
  const { direction, left, top, arrowX, arrowY } = NCZ.pickDirectionAndPosition(
    anchor,
    size,
    mapSize,
    {
      marginPx: NCZ.PIN_POPUP_MARGIN_PX,
      gapPx: NCZ.PIN_POPUP_GAP_PX,
      arrowSizePx: NCZ.PIN_POPUP_ARROW_SIZE_PX,
      arrowEdgePaddingPx: NCZ.PIN_POPUP_ARROW_EDGE_PADDING_PX,
    },
  );

  const layerPos = map.containerPointToLayerPoint(L.point(left, top));
  L.DomUtil.setPosition(popupEl, layerPos);
  popupEl.style.left = "0px";
  popupEl.style.top = "0px";
  popupEl.style.bottom = "auto";
  popupEl.style.margin = "0";
  popupEl.style.setProperty("--ncz-popup-arrow-x", `${arrowX}px`);
  popupEl.style.setProperty("--ncz-popup-arrow-y", `${arrowY}px`);

  popupEl.classList.remove("ncz-popup-top", "ncz-popup-bottom", "ncz-popup-left", "ncz-popup-right");
  popupEl.classList.add(`ncz-popup-${direction}`);
}

// isRecentlyUpdated moved to NCZ.isRecentlyUpdated in utils.js

async function initMap() {
  const calibratedSimpleCrs = L.extend({}, L.CRS.Simple, {
    distance(latlngA, latlngB) {
      return NCZ.leafletDistanceMeters(latlngA, latlngB);
    },
  });

  // 1. Setup Map
  const map = L.map("map", {
    crs: calibratedSimpleCrs,
    minZoom: 0,
    maxZoom: 8,
    maxBoundsViscosity: 1.0,
    attributionControl: false,
    zoomControl: false, // Disable default top-left zoom control
  });

  // Add distance scale line control (Leaflet native control class: .leaflet-control-scale-line).
  L.control.scale({
    position: "bottomright",
    metric: true,
    imperial: false,
    maxWidth: 160,
    updateWhenIdle: true,
  }).addTo(map);

  // Add zoom control manually to the bottom right
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const maxNativeZoom = 6;
  const southWest = map.unproject([0, 16384], maxNativeZoom);
  const northEast = map.unproject([16384, 0], maxNativeZoom);
  const mapBounds = new L.LatLngBounds(southWest, northEast);
  const panEdgeFraction = 0.5; // Let each map edge travel about halfway toward screen centre.

  function updatePannableBounds() {
    const size = map.getSize();
    const scaleToMaxZoom = map.getZoomScale(maxNativeZoom, map.getZoom());
    const padX = size.x * panEdgeFraction * scaleToMaxZoom;
    const padY = size.y * panEdgeFraction * scaleToMaxZoom;
    const mapSouthWestPoint = map.project(mapBounds.getSouthWest(), maxNativeZoom);
    const mapNorthEastPoint = map.project(mapBounds.getNorthEast(), maxNativeZoom);

    const pannableSouthWest = L.point(mapSouthWestPoint.x - padX, mapSouthWestPoint.y + padY);
    const pannableNorthEast = L.point(mapNorthEastPoint.x + padX, mapNorthEastPoint.y - padY);
    const pannableBounds = L.latLngBounds(
      map.unproject(pannableSouthWest, maxNativeZoom),
      map.unproject(pannableNorthEast, maxNativeZoom),
    );
    map.setMaxBounds(pannableBounds);
  }

  // Tiles are served with `Cache-Control: immutable` (see _headers), so browsers
  // never re-check them. If you regenerate the tile set, bump this ?v= token AND
  // purge the Cloudflare edge cache. Full procedure: docs/caching-strategy.md.
  L.tileLayer("assets/tiles/{z}/{x}/{y}.webp?v=1", {
    minZoom: 0,
    maxNativeZoom: 6,
    maxZoom: 8,
    tileSize: 256,
    noWrap: true,
    bounds: mapBounds,
  }).addTo(map);

  map.invalidateSize();
  map.fitBounds(mapBounds);
  updatePannableBounds();
  map.on("zoomend resize", updatePannableBounds);

  // Initialise SAT district overlay
  NCZ.Overlay.init(map);

  // District hover info panel (shared by both views; stats filled once mods load)
  NCZ.DistrictInfo?.init?.();

  // View switching (SAT ↔ SCHEMA)
  const mapEl   = document.getElementById("map");
  const map3dEl = document.getElementById("map-3d");
  // Set inside the data-load try block once mods + markers are available.
  // switchView calls it after toggling so the open popup persists across views.
  let onViewSwitched = null;
  // Set false once WebGPU is known unavailable (forceSatFallback). Blocks any
  // re-entry into the broken 3D view: deep link, keyboard, stray call.
  let threeDAvailable = true;
  let webgpuFallbackDone = false;
  // ?gamelight: calibration reference mode. Pins the 3D scene to the decoded
  // in-game 3D-map lighting state: sun fixed at the 3dmap.envparam
  // GlobalLightOverride (azimuth 107.12°, elevation 7°), time-of-day slider
  // frozen, and the Districts/Pins overlays stripped so the terrain/buildings
  // can be colour-matched against the in-game SDR capture without obstruction.
  // A reproducible reference frame: same URL always yields the identical
  // lighting state. Debug/calibration only; not linked from the UI.
  const GAMELIGHT = new URLSearchParams(window.location.search).has('gamelight');
  function switchView(viewName) {
    if (viewName === "schema" && !threeDAvailable) return;
    document.querySelectorAll(".map-view-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    // Dim SCHEMA-only overlay toggles when in SAT mode
    document.querySelectorAll(".overlay-toggle.schema-only").forEach(el => {
      el.classList.toggle("sat-active", viewName === "sat");
    });

    if (viewName === "schema") {
      // Capture the Leaflet viewport BEFORE hiding #map: getCenter()/getSize()
      // only read true while the container is laid out. On the *first* SCHEMA
      // entry the scene isn't built yet, so the E5 intro owns the framing; on
      // later toggles we carry the 2D viewport across.
      const wasInit  = NCZ.ThreeScene.isInitialized();
      const leafletView = { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() };
      const leafletPxW  = map.getSize().x;
      mapEl.style.display   = "none";
      map3dEl.style.display = "block";
      // ThreeScene.init() is async under WebGPURenderer (await renderer.init()).
      // Chain startRenderLoop so the loop only ticks once the renderer is ready.
      // First-call goes through full async init; subsequent calls early-out
      // synchronously (initialized guard) and the chain still resolves immediately.
      Promise.resolve(NCZ.ThreeScene.init("map-3d"))
        .then(() => {
          // init() aborts early (no render loop wired) when the renderer fell
          // back to WebGL2 (buildings can't run there). Don't show a broken
          // 3D scene: drop the user onto the 2D Leaflet map instead.
          if (NCZ.ThreeScene.isWebGPUActive()) {
            NCZ.ThreeScene.startRenderLoop();
            if (GAMELIGHT) applyGameLightRef();
            // Sync the 2D viewport into the 3D camera, but only once the scene
            // already exists, so the first-entry intro fly-in isn't stomped.
            if (wasInit) NCZ.ThreeScene.frameLeafletView({ ...leafletView, leafletPxW });
          } else {
            forceSatFallback();
          }
        });
    } else {
      // Carry the 3D camera's viewport back to the Leaflet map. Capture from the
      // canvas (Leaflet-independent) before showing #map; round zoom to an
      // integer for tile crispness, clamp to the map's range. Use the *visible*
      // 3D container's width for the px basis: map.getSize() reads 0 while #map
      // is still display:none, which would collapse the derived zoom.
      const view = NCZ.ThreeScene.getLeafletView?.({ leafletPxW: map3dEl.clientWidth });
      map3dEl.style.display = "none";
      mapEl.style.display   = "block";
      NCZ.ThreeScene.stopRenderLoop();
      map.invalidateSize();
      if (view) {
        const zoom = NCZ.clamp(Math.round(view.zoom), map.getMinZoom(), map.getMaxZoom());
        map.setView(view.center, zoom, { animate: false });
      }
    }
    onViewSwitched?.(viewName);
  }

  // Frame the 2D map at the view equivalent to the *default* 3D framing (the E5
  // intro rest pose). Used by the WebGPU fallback, where the 3D camera never
  // gets built; without this the map sits at its init fitBounds(mapBounds)
  // (the whole 16k image, framing nothing). Runs the intro rest constants
  // through the same horizontal-extent transform a real SCHEMA→SAT switch uses,
  // so the fallback lands exactly where switching to 2D from the default 3D view
  // would. Must be called while #map is visible (getSize() reads 0 otherwise).
  function applyDefaultSatView() {
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const [cetX, cetY] = NCZ.SCHEMA_INTRO_REST_CENTER;
    const { lat, lng, zoom } = NCZ.cameraExtentToLeafletView({
      cetX, cetY,
      distance: NCZ.SCHEMA_INTRO_REST_DISTANCE,
      aspect3d: size.x / size.y,
      fov: NCZ.SCHEMA_CAMERA_FOV,
      leafletPxW: size.x,
    });
    const z = NCZ.clamp(Math.round(zoom), map.getMinZoom(), map.getMaxZoom());
    map.setView([lat, lng], z, { animate: false });
  }

  // WebGPU unavailable → the 3D view can't render correctly. Lock it off and
  // present the fully-functional 2D Leaflet map plus a one-time notice.
  // Idempotent: only the first call does anything.
  function forceSatFallback() {
    if (webgpuFallbackDone) return;
    webgpuFallbackDone = true;
    threeDAvailable = false;
    switchView("sat");
    // switchView's SAT branch can't carry a view across (no 3D camera exists on
    // the fallback), so it leaves the init fitBounds in place; override it with
    // the default 3D-equivalent framing now that #map is laid out.
    applyDefaultSatView();
    const schemaBtn = document.querySelector('.map-view-btn[data-view="schema"]');
    if (schemaBtn) {
      schemaBtn.disabled = true;
      schemaBtn.classList.add("unavailable");
      schemaBtn.title = "3D view unavailable — WebGPU not supported";
    }
    const modal = document.getElementById("webgpu-unsupported-modal");
    if (modal) modal.classList.remove("hidden");
  }

  document.querySelectorAll(".map-view-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("scene-reset-btn").addEventListener("click", () => {
    NCZ.ThreeScene.resetCamera();
  });

  // ── Sun slider: time of day at Morro Bay, CA (Night City's real-world location)
  // Slider values are always in Morro Bay PDT (UTC-7, the summer offset).
  // All conversions use UTC internally so the browser's local timezone never
  // affects the sun position calculation.
  const SUN_LAT  = 35.370781, SUN_LNG = -120.851173;
  const PDT_OFFSET = -7; // Morro Bay summer (PDT) = UTC-7
  // June 21 at UTC midnight; year doesn't matter for sun geometry
  const SOLSTICE = new Date(Date.UTC(new Date().getFullYear(), 5, 21));

  const sunSlider      = document.getElementById("scene-sun-slider");
  const sunTimeDisplay = document.getElementById("scene-sun-time");

  // The decoded 3dmap.envparam GlobalLightOverride sun: fixed, no time of day.
  const GAMELIGHT_SUN_AZIMUTH   = 107.121956 * Math.PI / 180;
  const GAMELIGHT_SUN_ELEVATION = 7 * Math.PI / 180;

  function applySunTime(morroMinutes) {
    // ?gamelight: pin to the decoded reference sun, ignore the slider value.
    // Gating here (not just at the call sites) means every path that drives the
    // sun (slider setup, terrain-loaded apply, the UI-sync poll) keeps it
    // pinned, so the reference frame can't drift.
    if (GAMELIGHT) {
      NCZ.ThreeScene?.setSunPosition?.(GAMELIGHT_SUN_AZIMUTH, GAMELIGHT_SUN_ELEVATION);
      if (sunTimeDisplay) sunTimeDisplay.textContent = 'REF';
      return;
    }
    // morroMinutes = Morro Bay PDT (e.g. 600 = 10:00 AM PDT)
    if (typeof SunCalc === 'undefined' || !NCZ.ThreeScene?.setSunPosition) return;
    const date = new Date(SOLSTICE);
    // Convert PDT → UTC: PDT = UTC-7, so UTC = PDT + 7
    date.setUTCHours((Math.floor(morroMinutes / 60) - PDT_OFFSET) % 24, morroMinutes % 60, 0, 0);
    const pos = SunCalc.getPosition(date, SUN_LAT, SUN_LNG);
    NCZ.ThreeScene.setSunPosition(pos.azimuth, pos.altitude);
    // Time-of-day exposure: floor the dark ends without flattening the natural
    // day/night variation. Keyed on elevation so the flyover shares it. See
    // NCZ.SCENE_EXPOSURE_CURVE + NCZ.exposureForSunElevation.
    NCZ.ThreeScene?.setSceneExposure?.(NCZ.exposureForSunElevation(pos.altitude));
    const h = String(Math.floor(morroMinutes / 60)).padStart(2, '0');
    const m = String(morroMinutes % 60).padStart(2, '0');
    if (sunTimeDisplay) sunTimeDisplay.textContent = `${h}:${m}`;
  }

  if (sunSlider) {
    sunSlider.addEventListener("input", () => applySunTime(parseInt(sunSlider.value)));

    if (typeof SunCalc !== 'undefined') {
      // Compute solstice sunrise/sunset in UTC minutes, then convert to Morro Bay PDT
      const times      = SunCalc.getTimes(SOLSTICE, SUN_LAT, SUN_LNG);
      const utcToMorro = (date) => ((date.getUTCHours() * 60 + date.getUTCMinutes()) + PDT_OFFSET * 60 + 1440) % 1440;
      sunSlider.min    = utcToMorro(times.sunrise); // ~353 min = 05:53 PDT
      sunSlider.max    = utcToMorro(times.sunset);  // ~1216 min = 20:16 PDT
    } else {
      sunSlider.min = 353;
      sunSlider.max = 1216;
    }

    // Default: 8:00 AM PDT (sun ~24° elevation from the east). The high-noon
    // default (10am, el 48°) over-lights building tops under the new photometric
    // lighting; a moderate morning sun reads as 3D-massed city without blasting.
    const DEFAULT_SUN_MINUTES = 480;
    sunSlider.value = DEFAULT_SUN_MINUTES;
    applySunTime(DEFAULT_SUN_MINUTES);
  }

  // ── Shadows toggle
  document.getElementById("overlay-shadows")?.addEventListener("change", e => {
    NCZ.ThreeScene?.setShadowsEnabled?.(e.target.checked);
  });

  // Settings → "Colour grade (LUT)" toggle. Overrides the active theme's
  // --scene-grade default for the session; a theme switch resets it (see
  // applyThemeById). Initial state synced from the scene once it's live.
  const lutToggle = document.getElementById("lut-grade-toggle");
  if (lutToggle) {
    lutToggle.addEventListener("change", e => {
      NCZ.ThreeScene?.setGradeEnabled?.(e.target.checked);
    });
  }

  // Settings → "Edge glow" toggle: binary self-lit building edges. Same
  // override-the-theme-default pattern as the LUT toggle above.
  const glowToggle = document.getElementById("edge-glow-toggle");
  if (glowToggle) {
    glowToggle.addEventListener("change", e => {
      NCZ.ThreeScene?.setEdgeGlowEnabled?.(e.target.checked);
    });
  }

  // Settings → "Fixed building assets" toggle: selects the 3D-map building
  // asset set: checked = malgalad's alignment-fixed textures, unchecked =
  // base-game. Unlike the render toggles above, this is a PERSISTED user
  // preference (localStorage, not theme-scoped). The building data is CPU-
  // decoded once at scene init (loadBuildings reads the set at load time), so
  // switching reloads the page rather than rebuilding the instanced meshes live.
  const assetToggle = document.getElementById("asset-set-toggle");
  if (assetToggle) {
    const current = localStorage.getItem(NCZ.ASSET_SET_KEY) || NCZ.ASSET_SET_DEFAULT;
    assetToggle.checked = current === "fixed";
    assetToggle.addEventListener("change", e => {
      localStorage.setItem(NCZ.ASSET_SET_KEY, e.target.checked ? "fixed" : "cdpr");
      location.reload();
    });
  }

  // ?gamelight: apply the calibration reference state once the 3D scene is
  // live (called from switchView's schema branch). The sun is already pinned
  // by applySunTime()'s GAMELIGHT gate; here we freeze the slider and strip the
  // Districts/Pins overlays so they don't obscure the surfaces being matched
  // against the in-game capture. Shadows default off, so no action needed there.
  function applyGameLightRef() {
    applySunTime(0); // GAMELIGHT-gated → pins the decoded reference sun
    if (sunSlider) {
      sunSlider.disabled = true;
      sunSlider.title = '?gamelight — sun pinned to the decoded in-game reference';
    }
    document.querySelectorAll('[data-overlay]').forEach(cb => {
      const overlay = cb.dataset.overlay;
      if ((overlay === 'districts' || overlay === 'pins') && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
      }
    });
    console.info('[NCZ] ?gamelight — calibration reference: sun az 107.12°/el 7°, overlays stripped.');
  }

  const flyoverBtn = document.getElementById("scene-flyover-btn");
  // Elements to hide during showcase. We save each one's inline display value
  // so we can restore it exactly; this handles elements that JS may have
  // already toggled (e.g. sidebar-open uses a .visible class, not display).
  const _showcaseEls = [];

  // ── Showcase Options modal ──────────────────────────────────────────────
  const showcaseModal           = document.getElementById("showcase-modal");
  const showcaseStartBtn        = document.getElementById("showcase-start-btn");
  const showcaseResetBtn        = document.getElementById("showcase-reset-btn");
  const showcaseCancelBtn       = document.getElementById("close-showcase-modal");
  const showcaseThemeSelect     = document.getElementById("showcase-theme");
  const showcaseShowPinsCb      = document.getElementById("showcase-show-pins");
  const showcaseRevealLayersCb  = document.getElementById("showcase-reveal-layers");
  const showcaseDistrictNamesCb    = document.getElementById("showcase-district-names");
  const showcaseDistrictOutlinesCb = document.getElementById("showcase-district-outlines");
  const showcaseAudioCb         = document.getElementById("showcase-audio");
  const showcaseLoopCb          = document.getElementById("showcase-loop");

  // Populate the theme dropdown from NCZ.THEMES so it stays the single source
  // of truth. "Cycle" is preserved as the first option from the markup.
  if (showcaseThemeSelect && Array.isArray(NCZ.THEMES)) {
    NCZ.THEMES.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      showcaseThemeSelect.appendChild(opt);
    });
  }

  const SHOWCASE_DEFAULTS = Object.freeze({
    theme: "cycle",
    showPins: false,
    revealLayers: false,
    districtNames: false,
    districtOutlines: false,
    audio: true,
    loop: false,
  });

  function readStoredShowcaseOptions() {
    try {
      const raw = localStorage.getItem(NCZ.SHOWCASE_OPTIONS_KEY);
      if (!raw) return { ...SHOWCASE_DEFAULTS };
      const parsed = JSON.parse(raw);
      const validThemes = new Set(["cycle", ...(NCZ.THEMES || []).map(t => t.id)]);
      // Back-compat: the single `districts` boolean (pre-split) seeds both
      // new options so a stored "on" preference survives the upgrade.
      const legacyDistricts = typeof parsed.districts === "boolean" ? parsed.districts : null;
      return {
        theme:        validThemes.has(parsed.theme) ? parsed.theme : SHOWCASE_DEFAULTS.theme,
        showPins:     typeof parsed.showPins     === "boolean" ? parsed.showPins     : SHOWCASE_DEFAULTS.showPins,
        revealLayers: typeof parsed.revealLayers === "boolean" ? parsed.revealLayers : SHOWCASE_DEFAULTS.revealLayers,
        districtNames:    typeof parsed.districtNames    === "boolean" ? parsed.districtNames    : (legacyDistricts ?? SHOWCASE_DEFAULTS.districtNames),
        districtOutlines: typeof parsed.districtOutlines === "boolean" ? parsed.districtOutlines : (legacyDistricts ?? SHOWCASE_DEFAULTS.districtOutlines),
        audio:        typeof parsed.audio        === "boolean" ? parsed.audio        : SHOWCASE_DEFAULTS.audio,
        loop:         typeof parsed.loop         === "boolean" ? parsed.loop         : SHOWCASE_DEFAULTS.loop,
      };
    } catch (_) {
      return { ...SHOWCASE_DEFAULTS };
    }
  }

  function openShowcaseModal() {
    const opts = readStoredShowcaseOptions();
    if (showcaseThemeSelect)    showcaseThemeSelect.value      = opts.theme;
    if (showcaseShowPinsCb)     showcaseShowPinsCb.checked     = opts.showPins;
    if (showcaseRevealLayersCb) showcaseRevealLayersCb.checked = opts.revealLayers;
    if (showcaseDistrictNamesCb)    showcaseDistrictNamesCb.checked    = opts.districtNames;
    if (showcaseDistrictOutlinesCb) showcaseDistrictOutlinesCb.checked = opts.districtOutlines;
    if (showcaseAudioCb)        showcaseAudioCb.checked        = opts.audio;
    if (showcaseLoopCb)         showcaseLoopCb.checked         = opts.loop;
    showcaseModal?.classList.remove("hidden");
  }

  function closeShowcaseModal() {
    showcaseModal?.classList.add("hidden");
  }

  function enterShowcase(opts) {
    ['header', '#sidebar', '#sidebar-open', '#discover-location-btn',
     '#overlay-controls', '#map-view-toggle', '#scene-controls', '#scene-scale']
      .forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        _showcaseEls.push({ el, display: el.style.display });
        el.style.display = 'none';
      });

    // Marker-overlay visibility during the showcase is owned by flyover.js:
    // it sets the flyCamera's layer mask based on opts.showPins and swaps
    // ThreeMarkers' active camera reference so projection lands correctly.
    document.getElementById('map-3d').classList.add('showcase-fullscreen');
    NCZ.Flyover.startFlyover(opts); // creates and manages the fade overlay internally
    flyoverBtn.classList.add("active");
    flyoverBtn.textContent = "Exit showcase";
    // Request native browser fullscreen; must be called from a user gesture (button click)
    document.documentElement.requestFullscreen().catch(() => {});
    // Reconcile the renderer + CSS2DRenderer to the new container size: the
    // fullscreen class grows #map-3d without firing a window resize, and the
    // CSS2DRenderer must adopt the new client size or every pin/cluster/
    // district label drifts off its world anchor (#769). (Mid-showcase
    // setSize was suppressed here while the r185 resize wedge (#771) was
    // unmitigated; the dispose-on-resize fix in three-scene.js made it safe.)
    setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
  }

  function exitShowcase() {
    try { NCZ.Flyover.stopFlyover(); } catch (e) { console.error('[NCZ] stopFlyover error:', e); }

    _showcaseEls.forEach(({ el }) => el.style.removeProperty('display'));
    _showcaseEls.length = 0;

    document.getElementById('map-3d').classList.remove('showcase-fullscreen');
    flyoverBtn.classList.remove("active");
    flyoverBtn.textContent = "Showcase";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // Reconcile the canvas to its true (windowed) size.
    setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
  }

  flyoverBtn.addEventListener("click", () => {
    if (flyoverBtn.classList.contains("active")) { exitShowcase(); return; }
    openShowcaseModal();
  });

  showcaseStartBtn?.addEventListener("click", () => {
    const opts = {
      theme:        showcaseThemeSelect?.value ?? SHOWCASE_DEFAULTS.theme,
      showPins:     !!showcaseShowPinsCb?.checked,
      revealLayers: !!showcaseRevealLayersCb?.checked,
      districtNames:    !!showcaseDistrictNamesCb?.checked,
      districtOutlines: !!showcaseDistrictOutlinesCb?.checked,
      audio:        !!showcaseAudioCb?.checked,
      loop:         !!showcaseLoopCb?.checked,
    };
    try { localStorage.setItem(NCZ.SHOWCASE_OPTIONS_KEY, JSON.stringify(opts)); } catch (_) {}
    closeShowcaseModal();
    enterShowcase(opts); // synchronous → fullscreen request stays inside the user-gesture task
  });

  showcaseCancelBtn?.addEventListener("click", closeShowcaseModal);

  // Reset rewinds the form inputs to SHOWCASE_DEFAULTS and persists them
  // immediately. Closing the modal (or hitting Cancel) after a Reset still
  // leaves defaults as the saved preference, so "Reset" reads as a complete
  // "wipe to defaults" action rather than a Start-gated form reset.
  showcaseResetBtn?.addEventListener("click", () => {
    if (showcaseThemeSelect)    showcaseThemeSelect.value      = SHOWCASE_DEFAULTS.theme;
    if (showcaseShowPinsCb)     showcaseShowPinsCb.checked     = SHOWCASE_DEFAULTS.showPins;
    if (showcaseRevealLayersCb) showcaseRevealLayersCb.checked = SHOWCASE_DEFAULTS.revealLayers;
    if (showcaseDistrictNamesCb)    showcaseDistrictNamesCb.checked    = SHOWCASE_DEFAULTS.districtNames;
    if (showcaseDistrictOutlinesCb) showcaseDistrictOutlinesCb.checked = SHOWCASE_DEFAULTS.districtOutlines;
    if (showcaseAudioCb)        showcaseAudioCb.checked        = SHOWCASE_DEFAULTS.audio;
    if (showcaseLoopCb)         showcaseLoopCb.checked         = SHOWCASE_DEFAULTS.loop;
    try { localStorage.setItem(NCZ.SHOWCASE_OPTIONS_KEY, JSON.stringify(SHOWCASE_DEFAULTS)); } catch (_) {}
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && flyoverBtn.classList.contains("active")) exitShowcase();
  });

  // Auto-exit when flyover reaches the end naturally (fires after the fade-to-black)
  document.addEventListener("flyover:ended", () => {
    if (flyoverBtn.classList.contains("active")) exitShowcase();
  });

  // If the user exits native fullscreen manually (Escape / F11), also exit the showcase
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && flyoverBtn.classList.contains("active")) exitShowcase();
  });

  // Overlay toggles: delegate to the right renderer based on active view
  document.querySelectorAll("[data-overlay]").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      const overlay = checkbox.dataset.overlay;
      const visible = checkbox.checked;
      if (overlay === "districts") {
        NCZ.Overlay.setDistricts(visible);           // SAT: Leaflet GeoJSON
        NCZ.ThreeScene.setLayerVisibility("districts", visible); // SCHEMA: THREE.Line
      } else {
        NCZ.ThreeScene.setLayerVisibility(overlay, visible);     // SCHEMA only
      }
    });
  });

  // UI sync: keep overlay checkboxes and sun slider in sync with actual scene state.
  // Runs at 200ms so console commands (setLayerVisibility, setCameraState etc.)
  // are reflected immediately in the UI. Cost: negligible (boolean reads + DOM writes
  // that short-circuit when unchanged).
  let _lastPolledSunEl = null;
  setInterval(() => {
    if (!NCZ.ThreeScene?.getLayerVisibility) return;

    // ?gamelight: hold the calibration reference state. Districts and the
    // shadow pass initialise asynchronously (after terrain load), so the
    // one-shot applyGameLightRef() can't catch them; re-assert here. The
    // checkbox sync below then unticks them to match. Guarded so it's a no-op
    // once settled (no per-tick shadow-map invalidation).
    if (GAMELIGHT) {
      if (NCZ.ThreeScene.getLayerVisibility('districts')) {
        NCZ.ThreeScene.setLayerVisibility('districts', false);
      }
      if (NCZ.ThreeScene.getShadowsEnabled?.()) {
        NCZ.ThreeScene.setShadowsEnabled(false);
      }
    }

    // Overlay checkboxes
    document.querySelectorAll("[data-overlay]").forEach(cb => {
      const vis = NCZ.ThreeScene.getLayerVisibility(cb.dataset.overlay);
      if (vis !== null && cb.checked !== vis) cb.checked = vis;
    });

    // Sun slider: reverse-map scene elevation back to morroMinutes via SunCalc scan
    if (sunSlider && typeof SunCalc !== 'undefined') {
      const el = NCZ.ThreeScene.getSunElevation?.();
      if (el !== undefined && el !== _lastPolledSunEl) {
        _lastPolledSunEl = el;
        let bestMin = 0, bestDiff = Infinity;
        for (let m = 0; m < 1440; m++) {
          const d = new Date(SOLSTICE);
          d.setUTCHours((Math.floor(m / 60) - PDT_OFFSET + 24) % 24, m % 60, 0, 0);
          const diff = Math.abs(SunCalc.getPosition(d, SUN_LAT, SUN_LNG).altitude - el);
          if (diff < bestDiff) { bestDiff = diff; bestMin = m; }
        }
        if (Number(sunSlider.value) !== bestMin) {
          sunSlider.value = bestMin;
          if (sunTimeDisplay) {
            const h = String(Math.floor(bestMin / 60)).padStart(2, '0');
            const m = String(bestMin % 60).padStart(2, '0');
            sunTimeDisplay.textContent = `${h}:${m}`;
          }
        }
      }
    }
  }, 200);

  switchView("schema");

  // 2. State & UI Elements
  const markerClusterGroup = L.markerClusterGroup({
    spiderfyOnMaxZoom: false,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,
    maxClusterRadius: 40,
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      // Colour ramp uses 10 steps across a bounded 0..100 count range.
      const boundedCount = Math.max(0, Math.min(count, 100));
      const colorStep = Math.round(boundedCount / 11);

      return L.divIcon({
        html: `<div><span>${count}</span></div>`,
        className: `marker-cluster marker-cluster-step marker-cluster-step-${colorStep}`,
        iconSize: L.point(40, 40),
      });
    },
    polygonOptions: {
      fillColor: "#00f0ff",
      color: "#00f0ff",
      weight: 1,
      opacity: 1,
      fillOpacity: 0.1,
    },
  }).addTo(map);

  const pinTooltip = createPinTooltipController(map);
  let activePopup = null;
  let popupRepositionFrame = null;
  let focusedMarker = null;
  let isZoomTransitioning = false;
  let focusedRestoreFrame = null;
  // The single non-panel marker currently pulled out of the cluster group
  // for focus (Discover / sidebar / deep-link). The 2D analogue of 3D's
  // "popupModId is excluded from the clusterer" rule; replaces spiderfy as
  // the way a clustered-but-focused pin stays visible. Panel-set markers are
  // owned by applyPanelPinFocus instead; this is only for the lone-pin paths.
  let soloFocusMarker = null;

  // ?mod= deep-link sync. Mirrors NCZ.ThreeMarkers.syncUrlForMod so the two
  // views stay coherent. Called EAGERLY when focus is initiated (not only
  // from popupopen): the popup now opens deferred (on flyTo's moveend), so
  // waiting for popupopen left a window where switching views lost the
  // pin (clustered pins go through the deferred path; unclustered ones
  // opened synchronously and were unaffected).
  function setModUrlParam(mod) {
    if (!mod) return;
    const url = new URL(window.location.href);
    url.searchParams.set(NCZ.URL_PARAM_MOD, NCZ.modLinkId(mod));
    history.replaceState(null, "", url.toString());
  }
  function clearModUrlParam() {
    const url = new URL(window.location.href);
    url.searchParams.delete(NCZ.URL_PARAM_MOD);
    history.replaceState(null, "", url.toString());
  }

  function repositionActivePopup() {
    if (!activePopup) return;
    positionDynamicPopup(map, activePopup);
  }

  // Coalesce bursty map/popup events into one popup reposition per animation frame.
  function scheduleActivePopupReposition() {
    if (popupRepositionFrame !== null) return;
    popupRepositionFrame = requestAnimationFrame(() => {
      popupRepositionFrame = null;
      repositionActivePopup();
    });
  }

  // Safety net only: re-open the focused popup if it closed while the marker
  // is an un-clustered singleton. Spiderfy was removed entirely (per product
  // decision); focused/selected markers are now kept visible by pulling
  // them OUT of the cluster group (soloFocusMarker / applyPanelPinFocus), so
  // a focused marker is never hidden inside a bubble and never needs
  // spiderfying. For force-individual markers this whole function early-
  // returns at the hasLayer check (they're not in the group); it survives
  // only for any legacy clustered-focus edge.
  function restoreFocusedPopupIfVisible() {
    if (!focusedMarker) return;
    if (panelSelectedModId !== null) return;
    if (!markerClusterGroup.hasLayer(focusedMarker)) return;
    const visibleParent = markerClusterGroup.getVisibleParent(focusedMarker);
    if (!visibleParent) return;
    if (visibleParent === focusedMarker && !focusedMarker.isPopupOpen()) {
      focusedMarker.openPopup();
    }
  }

  function scheduleFocusedPopupRestore() {
    if (!focusedMarker || focusedRestoreFrame !== null) return;
    focusedRestoreFrame = requestAnimationFrame(() => {
      focusedRestoreFrame = null;
      restoreFocusedPopupIfVisible();
    });
  }

  map.on("popupopen", (e) => {
    pinTooltip.hide();
    activePopup = e.popup;
    const popupSource = e.popup?._source;
    if (popupSource?.modData) {
      focusedMarker = popupSource;
      setModUrlParam(popupSource.modData);
    }
    repositionActivePopup();
    scheduleActivePopupReposition();
    const popupImages = activePopup.getElement()?.querySelectorAll("img") || [];
    popupImages.forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", scheduleActivePopupReposition, { once: true });
      }
    });

    // Clipboard copy handler for Copy Link button
    const copyBtn = e.popup.getElement()?.querySelector(".ui-popup-action-link-copy-link");
    if (copyBtn) {
      let copyRevertTimer = null;
      copyBtn.addEventListener("click", () => {
        const url = copyBtn.dataset.copyUrl;
        clearTimeout(copyRevertTimer);
        navigator.clipboard.writeText(url).then(() => {
          copyBtn.textContent = "Copied!";
          copyRevertTimer = setTimeout(() => {
            copyBtn.innerHTML = '<span class="ui-popup-action-link-icon" aria-hidden="true"></span>';
          }, NCZ.COPY_FEEDBACK_MS);
        });
      });
    }
  });
  map.on("popupclose", (e) => {
    activePopup = null;
    const popupSource = e.popup?._source;
    const isZoomRelatedClose =
      isZoomTransitioning ||
      Boolean(map._animatingZoom) ||
      Boolean(markerClusterGroup._inZoomAnimation);
    // URL sync: clear the mod param when popup closes (unless zoom-related)
    if (popupSource?.modData && !isZoomRelatedClose) {
      clearModUrlParam();
    }
    if (
      focusedMarker &&
      popupSource === focusedMarker &&
      !isZoomRelatedClose &&
      map.hasLayer(focusedMarker)
    ) {
      // Manual close on a visible marker clears focused state.
      focusedMarker = null;
    }
    // Genuine dismissal of the soloed lone-pin's popup → let it re-cluster.
    // Skipped on zoom-driven closes (transient) and when the marker belongs
    // to an open panel set (clearPanelPinFocus owns that restore).
    if (
      soloFocusMarker &&
      popupSource === soloFocusMarker &&
      !isZoomRelatedClose &&
      !panelClusterModIds?.has(soloFocusMarker.modData.id)
    ) {
      setSoloFocusMarker(null);
    }
    if (popupRepositionFrame !== null) {
      cancelAnimationFrame(popupRepositionFrame);
      popupRepositionFrame = null;
    }
  });

  map.on("move zoom resize", () => {
    pinTooltip.reposition();
    scheduleActivePopupReposition();
  });

  const allMarkers = [];
  const modCountEl = document.getElementById("mod-count");
  const modListEl = document.getElementById("mod-list");
  const filterContainer = document.getElementById("category-filters");
  const authorFilterContainer = document.getElementById("author-filters");
  const tagFilterCountEl = document.getElementById("tag-filter-count");
  const authorFilterCountEl = document.getElementById("author-filter-count");
  const clearTagFiltersBtn = document.getElementById("clear-tag-filters");
  const clearAuthorFiltersBtn = document.getElementById("clear-author-filters");
  const sidebar = document.getElementById("sidebar");
  const sidebarClose = document.getElementById("sidebar-close");
  const sidebarOpen = document.getElementById("sidebar-open");
  const discoverLocationBtn = document.getElementById("discover-location-btn");
  // Cluster menu DOM references
  const clusterPanel = document.getElementById("cluster-panel");
  const clusterPanelResizeHandle = document.getElementById("cluster-panel-resize-handle");
  const clusterPanelClose = document.getElementById("cluster-panel-close");
  const clusterPanelCount = document.getElementById("cluster-panel-count");
  const clusterModList = document.getElementById("cluster-mod-list");

  function updateDiscoverButtonPosition() {
    if (!discoverLocationBtn || !sidebar) return;

    const isDesktop = window.innerWidth >= NCZ.MOBILE_BREAKPOINT;
    const isSidebarVisible = isDesktop && !sidebar.classList.contains("hidden");

    if (isSidebarVisible) {
      const sidebarWidth = Math.round(sidebar.getBoundingClientRect().width);
      discoverLocationBtn.style.left = `calc(${sidebarWidth}px + var(--space-md))`;
    } else {
      discoverLocationBtn.style.left = "var(--space-md)";
    }
  }

  // Compute the maximum allowed cluster menu width for current viewport
  function getClusterPanelMaxWidth() {
    const viewportBound = Math.floor(window.innerWidth * 0.7);
    return Math.max(
      NCZ.CLUSTER_PANEL_MIN_WIDTH,
      Math.min(NCZ.CLUSTER_PANEL_MAX_WIDTH, viewportBound),
    );
  }

  // Clamp width so dragging cannot make the panel too small or too wide
  function clampClusterPanelWidth(width) {
    return Math.min(
      getClusterPanelMaxWidth(),
      Math.max(NCZ.CLUSTER_PANEL_MIN_WIDTH, Math.round(width)),
    );
  }

  // Apply panel width (desktop only), and optionally save it in localStorage
  function setClusterPanelWidth(width, persist = true) {
    if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
      clusterPanel.style.removeProperty("width");
      return;
    }

    const clampedWidth = clampClusterPanelWidth(width);
    clusterPanel.style.width = `${clampedWidth}px`;

    if (persist) {
      try {
        localStorage.setItem(NCZ.CLUSTER_PANEL_WIDTH_KEY, String(clampedWidth));
      } catch {
        // Ignore storage failures (e.g. private mode/quota)
      }
    }
  }

  // Enable drag-to-resize from the panel's left edge
  function initClusterPanelResize() {
    if (!clusterPanelResizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    // While dragging, update width based on horizontal mouse movement
    const onMouseMove = (event) => {
      if (!isResizing) return;
      const deltaX = startX - event.clientX;
      setClusterPanelWidth(startWidth + deltaX, false);
    };

    // End drag operation, restore normal interactions, then persist final width
    const stopResizing = () => {
      if (!isResizing) return;
      isResizing = false;
      clusterPanel.classList.remove("resizing");
      document.body.classList.remove("cluster-panel-resizing");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopResizing);

      const finalWidth = clusterPanel.getBoundingClientRect().width;
      if (finalWidth) {
        setClusterPanelWidth(finalWidth, true);
      }

      if (map.dragging) map.dragging.enable();
    };

    // Start drag operation when user presses the resize handle
    clusterPanelResizeHandle.addEventListener("mousedown", (event) => {
      if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) return;
      event.preventDefault();
      event.stopPropagation();

      isResizing = true;
      startX = event.clientX;
      startWidth = clusterPanel.getBoundingClientRect().width;
      clusterPanel.classList.add("resizing");
      document.body.classList.add("cluster-panel-resizing");

      if (map.dragging) map.dragging.disable();

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", stopResizing);
    });

    // Keep width valid when viewport size changes
    window.addEventListener("resize", () => {
      if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
        clusterPanel.style.removeProperty("width");
        return;
      }

      const inlineWidth = Number.parseFloat(clusterPanel.style.width);
      const currentWidth =
        Number.isFinite(inlineWidth) && inlineWidth > 0
          ? inlineWidth
          : clusterPanel.getBoundingClientRect().width || NCZ.CLUSTER_PANEL_DEFAULT_WIDTH;
      setClusterPanelWidth(currentWidth, false);
    });

    // Restore saved width, or use default width on first visit
    const savedWidth = Number.parseInt(
      localStorage.getItem(NCZ.CLUSTER_PANEL_WIDTH_KEY),
      10,
    );
    if (Number.isFinite(savedWidth)) {
      setClusterPanelWidth(savedWidth, false);
    } else {
      setClusterPanelWidth(NCZ.CLUSTER_PANEL_DEFAULT_WIDTH, false);
    }
  }

  initClusterPanelResize();

  // Tracks which mod IDs the cluster panel is currently showing. Used by the
  // 3D map-aware staleness check so the panel auto-closes when a recompute
  // breaks up the cluster the panel was opened for.
  let panelClusterModIds = null;

  // The panel mod the user last clicked. null = panel just opened, no pin
  // chosen yet (cluster still on screen). Once set, the panel becomes a
  // static comparison list: successor tracking is suppressed (the cluster
  // it followed has been flown into and dissolved) and the cluster bubble's
  // toggle-close no longer applies (there's no bubble to re-click). Drives
  // the "selected pin prominent, rest dimmed" emphasis.
  let panelSelectedModId = null;

  // True only while pin emphasis is actually applied (a panel item was
  // clicked). Lets clearPanelPinFocus() short-circuit when there's nothing
  // to undo; important because populateClusterPanel() calls it on EVERY
  // (re)populate, including the high-frequency successor-tracking path
  // during camera moves. Without this, each successor recompute would do a
  // full marker sweep + a synchronous 3D recomputeClusters for no reason.
  let panelPinFocusApplied = false;

  // Adds .marker-cluster-active to the SAT cluster bubble whose modIds best
  // match panelClusterModIds. Called after each Leaflet cluster recompute
  // (zoomend / animationend / filter) because Leaflet recreates DOM elements.
  function refreshActiveSatClusterMark() {
    document.querySelectorAll('.leaflet-marker-icon.marker-cluster-active').forEach((el) => {
      el.classList.remove('marker-cluster-active');
    });
    if (!panelClusterModIds || panelClusterModIds.size === 0) return;
    if (mapEl.style.display === "none") return;  // SCHEMA active, ThreeMarkers handles its own
    // Find best parent by overlap count, same logic as recomputeSatClusterPanel
    const parentBuckets = new Map();
    for (const modId of panelClusterModIds) {
      const marker = allMarkers.find((m) => m.modData.id === modId);
      if (!marker || !markerClusterGroup.hasLayer(marker)) continue;
      const parent = markerClusterGroup.getVisibleParent(marker);
      if (!parent || typeof parent.getAllChildMarkers !== "function") continue;
      const key = parent._leaflet_id;
      if (!parentBuckets.has(key)) parentBuckets.set(key, { parent, count: 0 });
      parentBuckets.get(key).count++;
    }
    let bestEntry = null;
    for (const entry of parentBuckets.values()) {
      if (!bestEntry || entry.count > bestEntry.count) bestEntry = entry;
    }
    if (bestEntry && bestEntry.parent.getElement) {
      const el = bestEntry.parent.getElement();
      if (el) el.classList.add('marker-cluster-active');
    }
  }

  // True iff `set` contains exactly the IDs in `list`. Used by both cluster
  // bubble click handlers (2D + 3D) to detect "user clicked the cluster
  // whose contents are already in the panel" → toggle-close instead of
  // re-populate. Cheap O(n): cluster sizes are bounded by markercluster's
  // disable-clustering-at-zoom threshold.
  function isSameModSet(set, list) {
    if (!set || set.size !== list.length) return false;
    for (const id of list) if (!set.has(id)) return false;
    return true;
  }

  // "Top pin, rest fade": after a panel item is clicked the cluster has
  // dissolved (focusMarker/focusMod flew in past the cluster radius), so the
  // member pins are individually visible. Dim every panel pin except the
  // selected one. 2D uses Leaflet's marker.setOpacity (survives the marker
  // DOM being recreated on zoom) + a zIndexOffset so the chosen pin sits
  // above its now-faded neighbours; 3D delegates to ThreeMarkers, which sets
  // the inner .marker-pin opacity (the only mechanism that survives
  // CSS2DRenderer's per-frame inline restyling). Two mechanisms, one
  // behaviour: the divergence is forced by the two views' DOM lifecycles,
  // not parallel styling.
  function applyPanelPinFocus() {
    if (!panelClusterModIds) return;
    for (const id of panelClusterModIds) {
      const marker = allMarkers.find((m) => m.modData.id === id);
      if (!marker) continue;
      // 2D force-individual: Leaflet.markercluster has no per-marker
      // "don't cluster" flag; the idiomatic way to keep specific markers
      // always visible is to pull them out of the cluster group and add
      // them straight to the map. Idempotent: only move if still grouped.
      if (markerClusterGroup.hasLayer(marker)) {
        markerClusterGroup.removeLayer(marker);
        marker.addTo(map);
      }
      const selected = id === panelSelectedModId;
      marker.setOpacity(selected ? 1 : 0.3);
      marker.setZIndexOffset(selected ? 1000 : 0);
    }
    const ids = [...panelClusterModIds];
    NCZ.ThreeMarkers?.setPanelPinFocus?.(ids, panelSelectedModId);
    // 3D equivalent: exclude the whole set from the distance-based clusterer
    // so dissolution doesn't depend on how tightly the mods are packed.
    NCZ.ThreeMarkers?.setForcedIndividualIds?.(new Set(ids));
    panelPinFocusApplied = true;
  }

  // Restore every panel pin to full opacity / default stacking. Must run
  // before panelClusterModIds is cleared (it drives the 2D iteration).
  // No-ops unless emphasis was actually applied; keeps the per-populate
  // call cheap and breaks the populateClusterPanel→clear→setForced→recompute
  // re-entry in the common (no pin picked) case.
  function clearPanelPinFocus() {
    if (!panelPinFocusApplied) return;
    if (panelClusterModIds) {
      for (const id of panelClusterModIds) {
        const marker = allMarkers.find((m) => m.modData.id === id);
        if (!marker) continue;
        marker.setOpacity(1);
        marker.setZIndexOffset(0);
        // Return the marker to the cluster group so it re-clusters normally.
        // Only if we actually pulled it out (standalone on the map and not
        // in the group); guards the cluster-mode-then-close path where no
        // marker was ever moved.
        if (map.hasLayer(marker) && !markerClusterGroup.hasLayer(marker)) {
          map.removeLayer(marker);
          markerClusterGroup.addLayer(marker);
        }
      }
    }
    NCZ.ThreeMarkers?.setPanelPinFocus?.(null, null);
    NCZ.ThreeMarkers?.setForcedIndividualIds?.(null);
    panelPinFocusApplied = false;
  }

  // Hide and reset cluster menu state
  function hideClusterPanel() {
    clusterModList.innerHTML = "";
    clusterPanelCount.textContent = "";
    clusterPanel.classList.add("cluster-panel-closed");
    clearPanelPinFocus();          // restore pin opacity/stacking first
    panelClusterModIds = null;
    panelSelectedModId = null;
    // Clear the active mark on whichever bubble was highlighted.
    refreshActiveSatClusterMark();
    NCZ.ThreeMarkers?.setActiveClusterMods?.(null);
  }

  // Shared 2D focus motion.
  //
  // 1. Close any popup that's already open FIRST. A lingering popup from the
  //    previously-selected pin would otherwise stay visible through the
  //    0.6s flyTo, repositioned every animation frame by the custom dynamic-
  //    popup placer → the "ghost / vibrating, faded double-popup". Nothing
  //    visible during the fly = no vibration.
  // 2. Sync ?mod= EAGERLY (not from popupopen). The popup is opened deferred
  //    on moveend, so a view switch during the fly would otherwise see no
  //    ?mod= and fail to restore (clustered pins route through this deferred
  //    path; unclustered ones open synchronously and were unaffected).
  // 3. Open the popup only once the flyTo settles. `opened` + the
  //    `focusedMarker === marker` guard handle rapid re-clicks (flyTo B
  //    interrupts flyTo A → A's moveend still fires, but focus moved on).
  // targetZoom never zooms OUT; keep the user's zoom if already close.
  // (6/8 is a building-detail zoom; tune here if it feels too near/far.)
  function flyToMarkerAndOpen(marker) {
    map.closePopup();
    focusedMarker = marker;
    setModUrlParam(marker.modData);
    const targetZoom = Math.max(map.getZoom(), 6);
    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      if (focusedMarker === marker) marker.openPopup();
    };
    map.once("moveend", openOnce);
    map.flyTo(marker.getLatLng(), targetZoom, { duration: 0.6 });
  }

  // Pull `marker` out of the cluster group so a clustered-but-focused pin is
  // visible without spiderfy. Returns the previously soloed marker to the
  // group first, unless it belongs to an active panel set, which
  // applyPanelPinFocus / clearPanelPinFocus own. This is the lone-pin path
  // (Discover / sidebar / deep-link); the panel path force-individuals the
  // whole set separately.
  // IMPORTANT ordering: reassign `soloFocusMarker` to the new marker FIRST,
  // operate on a local `prev`. `map.removeLayer(prev)` synchronously closes
  // prev's popup → the popupclose handler's solo-release branch fires
  // re-entrantly; if `soloFocusMarker` still pointed at `prev` there, that
  // branch would call setSoloFocusMarker(null) mid-call and the line below
  // would `markerClusterGroup.addLayer(null)`: prev removed from the map
  // and never re-added, so a second click on a Discover pin deleted it.
  // Reassigning first makes `popupSource === soloFocusMarker` false in
  // the re-entrant check, so it no-ops; using the `prev` local makes the
  // re-add robust regardless.
  function setSoloFocusMarker(marker) {
    const prev = soloFocusMarker;
    soloFocusMarker = marker || null;
    if (prev && prev !== marker) {
      const ownedByPanel = panelClusterModIds?.has(prev.modData.id);
      if (
        !ownedByPanel &&
        map.hasLayer(prev) &&
        !markerClusterGroup.hasLayer(prev)
      ) {
        map.removeLayer(prev);
        markerClusterGroup.addLayer(prev);
      }
    }
    if (marker && markerClusterGroup.hasLayer(marker)) {
      markerClusterGroup.removeLayer(marker);
      marker.addTo(map);
    }
  }

  // Lone-pin focus (Discover / sidebar / deep-link). Force the marker
  // individual (no clustering, no spiderfy), then fly + open.
  function focusMarker(marker) {
    setSoloFocusMarker(marker);
    flyToMarkerAndOpen(marker);
  }

  // Panel-item focus. The marker is already individual (applyPanelPinFocus
  // pulled the whole panel set out of the cluster group before this runs),
  // so just fly + open; no solo bookkeeping needed.
  function flyToPanelMarker(marker) {
    flyToMarkerAndOpen(marker);
  }

  function focusRandomVisibleMarker() {
    // Route to whichever view is currently active. Each view holds its own
    // pin layer; visibility (after filters) is queried per-layer rather than
    // re-running the filter computation.
    const isSchema = mapEl.style.display === "none";

    if (isSchema) {
      const visibleIds = NCZ.ThreeMarkers?.getVisibleModIds?.() ?? [];
      if (visibleIds.length === 0) {
        alert("No visible locations match the current filters.");
        return;
      }
      const randomId = visibleIds[Math.floor(Math.random() * visibleIds.length)];
      NCZ.ThreeMarkers.focusMod(randomId);
    } else {
      const visibleMarkers = allMarkers.filter((marker) => markerClusterGroup.hasLayer(marker));
      if (visibleMarkers.length === 0) {
        alert("No visible locations match the current filters.");
        return;
      }
      const randomMarker = visibleMarkers[Math.floor(Math.random() * visibleMarkers.length)];
      focusMarker(randomMarker);
    }
    hideClusterPanel();

    if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
      sidebar.classList.add("hidden");
      sidebarOpen.classList.add("visible");
    }

    updateDiscoverButtonPosition();
  }

  if (discoverLocationBtn) {
    discoverLocationBtn.addEventListener("click", focusRandomVisibleMarker);
  }

  // Populates the cluster panel with a sorted list of mods. View-agnostic:
  // both the Leaflet clusterclick handler and ThreeMarkers cluster clicks
  // call this. onItemClick receives the mod object; the active view flies to
  // it (focusMarker for SAT, NCZ.ThreeMarkers.focusMod for SCHEMA); the fly
  // dissolves the cluster but the panel stays open as a comparison list, so
  // the user can click each member in turn. The clicked pin is kept at full
  // opacity and the rest dim (applyPanelPinFocus).
  function populateClusterPanel(modsList, opts = {}) {
    const { onItemClick, nexusThumbs = {} } = opts;

    // New cluster context → drop any prior pin emphasis and selection.
    // Runs before panelClusterModIds is reassigned (below) so the old set
    // is the one un-dimmed.
    clearPanelPinFocus();
    panelSelectedModId = null;

    clusterModList.innerHTML = "";
    clusterPanelCount.textContent = `(${modsList.length})`;

    if (modsList.length === 0) {
      const empty = document.createElement("li");
      empty.className = "cluster-empty";
      empty.textContent = "No mods found in this cluster.";
      clusterModList.appendChild(empty);
    } else {
      modsList.forEach((mod) => {
        const catStyle = NCZ.CATEGORY_STYLES[mod.category] || NCZ.CATEGORY_STYLES.other;
        const modTagsHtml = (mod.tags || [])
          .map((tag) => `<span class="tag-badge">${NCZ.escapeHtml(tag)}</span>`)
          .join("");

        // Look up thumb/full URLs from the opts-passed nexusThumbs map.
        // Kept as an explicit arg (not closure-captured) so this function
        // can live outside the try block where nexusThumbs is declared.
        const nexusThumb = nexusThumbs[String(mod.nexus_id)];
        const thumbSrc = nexusThumb?.thumbnailUrl || null;
        const fullSrc = nexusThumb?.pictureUrl || null;
        const isThumbClickable = Boolean(fullSrc);
        const thumbMarkup = thumbSrc
          ? `<img class="cluster-mod-thumb${isThumbClickable ? " cluster-mod-thumb-clickable" : ""}" src="${NCZ.escapeHtml(thumbSrc)}" alt="${NCZ.escapeHtml(mod.name)} thumbnail" referrerpolicy="no-referrer"${isThumbClickable ? ` data-full-src="${NCZ.escapeHtml(fullSrc)}"` : ""}>`
          : `<span class="cluster-mod-thumb cluster-mod-thumb-placeholder" aria-hidden="true"></span>`;

        const item = document.createElement("li");
        item.className = "cluster-mod-item";
        item.style.setProperty("--cluster-mod-color", catStyle.color);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "cluster-mod-btn";
        button.innerHTML = `
          <span class="cluster-mod-layout">
            ${thumbMarkup}
            <span class="cluster-mod-content">
              <span class="cluster-mod-name">${NCZ.escapeHtml(mod.name)}${NCZ.isRecentlyUpdated(mod) ? ` <span class="badge-updated" title="Updated on Nexus within the last ${NCZ.recentlyUpdatedDays ?? NCZ.RECENTLY_UPDATED_DAYS} days">${NCZ.UPDATED_LABEL}</span>` : ""}</span>
              <span class="cluster-mod-separator"></span>
              <span class="cluster-mod-meta">by ${NCZ.escapeHtml(mod.authors.join(", "))}</span>
              <span class="cluster-mod-tags">
                ${modTagsHtml}
              </span>
              <span class="cluster-mod-desc">${NCZ.escapeHtml(mod.description || "No description provided.")}</span>
            </span>
          </span>
        `;

        // Open image modal when thumbnail is clicked
        const imageButton = button.querySelector(".cluster-mod-thumb[data-full-src]");
        if (imageButton) {
          imageButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.openImageGallery([imageButton.dataset.fullSrc], 0);
          });
        }

        button.addEventListener("click", () => {
          // Order matters: select → force-individual → fly.
          // applyPanelPinFocus must run BEFORE the fly so the whole panel
          // set is already pulled out of the cluster group (2D) / excluded
          // from the clusterer (3D); otherwise the bubble persists through
          // the fly. The panel stays open on
          // desktop; mobile still closes it (full-screen panel + fly +
          // popup at once is too much there).
          panelSelectedModId = mod.id;
          applyPanelPinFocus();
          onItemClick?.(mod);
          if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) hideClusterPanel();
        });

        item.appendChild(button);
        clusterModList.appendChild(item);
      });
    }

    // Record which mods this panel is showing so 3D's stale-cluster check
    // can compare current cluster contents against this set on each recompute.
    panelClusterModIds = new Set(modsList.map((m) => m.id));
    clusterPanel.classList.remove("cluster-panel-closed");

    // Update the active-cluster mark in both views. The SAT side runs a
    // DOM scan; the 3D side hands the set to ThreeMarkers which finds and
    // marks the matching bubble itself. Both are no-ops in the inactive view.
    refreshActiveSatClusterMark();
    NCZ.ThreeMarkers?.setActiveClusterMods?.(panelClusterModIds);
  }

  clusterPanelClose.addEventListener("click", hideClusterPanel);

  // Close Sidebar
  sidebarClose.addEventListener("click", () => {
    sidebar.classList.add("hidden");
    sidebarOpen.classList.add("visible");
    updateDiscoverButtonPosition();
  });

  // Open Sidebar
  sidebarOpen.addEventListener("click", () => {
    sidebar.classList.remove("hidden");
    sidebarOpen.classList.remove("visible");
    updateDiscoverButtonPosition();
  });

  // Auto-hide sidebar on mobile screens
  if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
    sidebar.classList.add("hidden");
    sidebarOpen.classList.add("visible");
  }

  updateDiscoverButtonPosition();
  window.addEventListener("resize", updateDiscoverButtonPosition);

  map.on("click", hideClusterPanel);
  map.on("zoomstart", () => {
    isZoomTransitioning = true;
    // Note: the cluster panel intentionally stays open during the zoom
    // animation (matches SCHEMA). recomputeSatClusterPanel runs on zoomend
    // and closes it only if its cluster dissolved or went singleton; the
    // other close paths (outside-click, close button, toggle re-click,
    // view switch) are unaffected by zoom.
  });
  map.on("zoomend", () => {
    isZoomTransitioning = false;
    scheduleFocusedPopupRestore();
  });
  markerClusterGroup.on("animationend", scheduleFocusedPopupRestore);

  // 3. Fetch and Setup Data
  try {
    // The server-built Data API (/v1) is the site's sole data source: it does
    // the manual + Nexus auto-discovery merge, district enrichment and thumbnail
    // resolution server-side, so the browser makes no Nexus calls here. Tags now
    // come from /v1/tags too — one origin, one contract — since the D1 `tags`
    // table replaced data/tags.json as the source of truth. There is no
    // client-side fallback for LOCATIONS — if the API is down the outer catch
    // shows a loud "map data unavailable" state, keeping the site a real canary
    // for the API (whose in-game consumer has no fallback either).
    //
    // Tags are the one exception: they degrade to the static file rather than
    // taking the map down, because a missing tag registry costs tooltips and
    // filter labels, not pins.
    const [apiResult, tagsPayload] = await Promise.all([
      NCZ.fetchLocationsFromApi(),
      fetch(`${NCZ.API_BASE}/v1/tags`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body) => body.data)
        .catch((err) => {
          console.warn("/v1/tags unavailable, falling back to the static file:", err);
          return fetch(NCZ.DATA_TAGS_PATH).then((r) => r.json());
        }),
    ]);
    // Accepts both the array-of-records shape and the legacy dictionary, so the
    // site and the Worker can deploy in either order during the migration.
    const tagsDict = NCZ.normaliseTags(tagsPayload);
    const { mods, nexusThumbs } = apiResult;
    // The API owns the recency window (it computes each mod's recently_updated
    // bool against it). Adopt it so the tooltip text matches; fall back to the
    // local constant if an older API omits it.
    NCZ.recentlyUpdatedDays = apiResult.recentlyUpdatedDays ?? NCZ.RECENTLY_UPDATED_DAYS;
    console.log(`Data source: /v1 API — ${mods.length} mods`);

    modCountEl.textContent = `(${mods.length})`;

    const sortedMods = mods.sort(NCZ.sortModsByUpdated);
    // The popup's edit and report actions carry a location id and nothing else,
    // so the delegated handler needs one place to resolve it. Built from the
    // same array the pins and the 3D layer are built from, and the passive
    // update check announces rather than re-renders, so this cannot describe a
    // different data set from the one on screen.
    NCZ.locationsById = new Map(sortedMods.map((mod) => [String(mod.id), mod]));
    // Hand the same data set to the 3D pin layer; pins won't appear until ThreeScene
    // is initialised (first switch to SCHEMA), but the call is safe before that and the
    // data is held internally so the layer can build pins on attach.
    NCZ.ThreeMarkers?.setMods?.(sortedMods, nexusThumbs, tagsDict);
    // District info panel stats: attribute each mod to its district/subdistrict.
    NCZ.DistrictInfo?.setMods?.(sortedMods);

    // ── Passive dataset updates ──────────────────────────────────────────
    //
    // An open tab notices when the map data changes underneath it. Before
    // this, a tab loaded once and stayed on that snapshot forever, and even a
    // manual reload could serve the previous copy for up to 5 minutes, because
    // /v1/locations is `max-age=300` and the browser honoured it.
    //
    // Costs effectively nothing: the poll is a plain fetch that the browser
    // answers from its own cache inside the TTL, so the Worker sees ~1 request
    // per tab per 5 minutes. See NCZ.checkForDatasetUpdate.
    //
    // This DETECTS and announces; it does not re-render. Injecting pins
    // live would mean rebuilding allMarkers, the sidebar list and the 3D pin
    // layer from a data set that is closed over in a dozen places: an
    // init-path refactor, not a feature flag. The notice offers a reload, and
    // the reload is now guaranteed to fetch fresh data because the ETag is
    // finally readable (see worker/src/index.js CORS_HEADERS).
    let knownDatasetVersion = apiResult.datasetVersion ?? null;
    if (knownDatasetVersion) {
      setInterval(async () => {
        const fresh = await NCZ.checkForDatasetUpdate(knownDatasetVersion);
        if (!fresh) return;
        // Adopt the new version immediately, so a user who dismisses the notice
        // is not told about the same change on the next tick.
        knownDatasetVersion = fresh.dataset_version;

        const before = new Set(mods.map((m) => m.id));
        const after = new Set(fresh.data.map((m) => m.id));
        const added = fresh.data.filter((m) => !before.has(m.id));
        const removed = mods.filter((m) => !after.has(m.id));
        showDatasetUpdateNotice({ added, removed });
      }, NCZ.DATASET_POLL_MS);
    }

    // The notice itself. Built once and reused, so a change that lands while an
    // earlier notice is still showing replaces its text rather than stacking a
    // second toast over the map.
    let updateNoticeEl = null;
    function showDatasetUpdateNotice({ added, removed }) {
      if (!updateNoticeEl) {
        updateNoticeEl = document.createElement("div");
        updateNoticeEl.className = "dataset-update-notice";
        updateNoticeEl.setAttribute("role", "status");
        document.body.appendChild(updateNoticeEl);
      }

      // Say what changed, in the user's terms, and NAME it when there is one.
      // "1 new location" tells you something happened; "Sea Wall Towers
      // Detailed" tells you what, which is the difference between refreshing
      // and then hunting 298 pins for whatever moved.
      const parts = [];
      if (added.length === 1) parts.push(`${added[0].name} added`);
      else if (added.length) parts.push(`${added.length} new locations`);
      if (removed.length === 1) parts.push(`${removed[0].name} removed`);
      else if (removed.length) parts.push(`${removed.length} removed`);
      // Neither: an existing record was edited. Still worth surfacing, since a
      // corrected coordinate or description is exactly the kind of change a
      // stale tab would keep showing wrongly.
      const summary = parts.length ? parts.join(", ") : "Locations updated";

      updateNoticeEl.replaceChildren();
      const text = document.createElement("span");
      text.className = "dataset-update-text";
      text.textContent = `Map updated: ${summary}`;
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "dataset-update-refresh";
      // Land ON the new pin, not merely on a fresher map. Reuses the existing
      // ?mod= deep link, so the reload opens its popup and flies to it, the
      // same path a shared link takes.
      const focusTarget = added[0] ?? null;
      refresh.textContent = focusTarget ? "Show me" : "Refresh";
      refresh.addEventListener("click", () => {
        // Rebuild from the CURRENT url so ?api=dev and any other params
        // survive; a bare location.search assignment would drop them and
        // silently send a dev tab back to production.
        const url = new URL(window.location.href);
        if (focusTarget) {
          url.searchParams.set(NCZ.URL_PARAM_MOD, NCZ.modLinkId(focusTarget));
        }
        window.location.href = url.toString();
      });
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "dataset-update-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.textContent = "✕";
      dismiss.addEventListener("click", () => updateNoticeEl.classList.remove("is-visible"));

      updateNoticeEl.append(text, refresh, dismiss);
      updateNoticeEl.classList.add("is-visible");
    }

    // Cluster panel wiring: both views call the same populateClusterPanel
    // helper. Registered here (inside the try block) so each handler's
    // closure can pass `nexusThumbs` and reference the loaded `mods` array.

    // 2D (Leaflet) cluster click → cluster panel
    markerClusterGroup.on("clusterclick", (a) => {
      if (a.originalEvent) L.DomEvent.stop(a.originalEvent);
      const childMarkers = a.layer
        .getAllChildMarkers()
        .slice()
        .sort((left, right) => NCZ.sortModsByUpdated(left.modData, right.modData));
      const childMods = childMarkers.map((m) => m.modData);
      // Toggle-close: re-clicking the cluster whose contents the panel shows
      // closes it, but only before a pin was picked. Once a pin is selected
      // the cluster has dissolved (flown into), so this path can't be hit
      // for that cluster anyway; the guard makes the intent explicit.
      if (
        panelSelectedModId === null &&
        isSameModSet(panelClusterModIds, childMods.map((m) => m.id))
      ) {
        hideClusterPanel();
        return;
      }
      populateClusterPanel(childMods, {
        nexusThumbs,
        onItemClick: (mod) => {
          const marker = childMarkers.find((m) => m.modData.id === mod.id);
          if (marker) flyToPanelMarker(marker);
        },
      });
    });

    // 3D (ThreeMarkers) cluster click → cluster panel
    NCZ.ThreeMarkers?.setClusterClickHandler?.((modIds) => {
      // Toggle-close on the active cluster, before a pin is picked (parity
      // with 2D; see that handler for the rationale).
      if (panelSelectedModId === null && isSameModSet(panelClusterModIds, modIds)) {
        hideClusterPanel();
        return;
      }
      const idSet = new Set(modIds);
      const childMods = mods
        .filter((m) => idSet.has(m.id))
        .sort(NCZ.sortModsByUpdated);
      populateClusterPanel(childMods, {
        nexusThumbs,
        onItemClick: (mod) => NCZ.ThreeMarkers.focusMod(mod.id),
      });
    });

    // 3D empty-canvas click → close the cluster panel. Parity with the 2D
    // `map.on("click", hideClusterPanel)` below: clicking empty space (not a
    // pin / cluster / popup) dismisses the panel in both views.
    NCZ.ThreeMarkers?.setEmptyClickHandler?.(hideClusterPanel);

    // 3D map-aware panel: when 3D clusters recompute (camera moved/zoomed/
    // tilted), follow the cluster the panel was opened for. Find the
    // "successor" (the current cluster with the most overlap with the
    // panel's mod set) and update the panel's contents to match. Close
    // only when no current cluster has any of the original mods, OR the
    // best successor has fewer than 2 mods (no longer a real cluster).
    NCZ.ThreeMarkers?.setClustersChangedHandler?.((clusterSets) => {
      if (!panelClusterModIds || panelClusterModIds.size === 0) return;
      // Once a pin is picked the panel is a static comparison list; the
      // flyTo already dissolved the cluster it tracked, so don't let the
      // recompute close or rewrite the panel out from under the user.
      if (panelSelectedModId !== null) return;
      // Skip while SAT is active; SAT panel state is independent.
      if (mapEl.style.display !== "none") return;

      let bestSet = null;
      let bestOverlap = 0;
      for (const ids of clusterSets) {
        let overlap = 0;
        for (const id of ids) if (panelClusterModIds.has(id)) overlap++;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSet = ids;
        }
      }

      // No surviving cluster contains any of the original mods → close.
      // Or the successor has dissolved into a singleton → close.
      if (bestOverlap === 0 || !bestSet || bestSet.length < 2) {
        hideClusterPanel();
        return;
      }

      // If the successor's membership matches the current panel exactly,
      // skip the DOM rebuild (avoids flicker during continuous camera moves).
      if (bestSet.length === panelClusterModIds.size) {
        let identical = true;
        for (const id of bestSet) {
          if (!panelClusterModIds.has(id)) { identical = false; break; }
        }
        if (identical) return;
      }

      // Successor differs → re-populate the panel with its mods.
      const newMods = bestSet
        .map((id) => mods.find((m) => m.id === id))
        .filter(Boolean)
        .sort(NCZ.sortModsByUpdated);
      populateClusterPanel(newMods, {
        nexusThumbs,
        onItemClick: (mod) => NCZ.ThreeMarkers.focusMod(mod.id),
      });
    });

    // SAT map-aware panel: same successor-tracking logic as SCHEMA, but using
    // Leaflet's markerClusterGroup.getVisibleParent to find each panel mod's
    // current cluster. Used by zoomend and applyFilters to keep the panel in
    // sync with Leaflet's automatic cluster recomputation.
    function recomputeSatClusterPanel() {
      if (!panelClusterModIds || panelClusterModIds.size === 0) return;
      // Pin picked → static comparison list; the panel set is force-
      // individual now, so don't auto-close or rewrite the panel.
      if (panelSelectedModId !== null) return;
      // Skip while SCHEMA is active; SCHEMA panel state is independent.
      if (mapEl.style.display === "none") return;

      // Group panel mods by their current visible parent (cluster or singleton).
      const parentBuckets = new Map();
      for (const modId of panelClusterModIds) {
        const marker = allMarkers.find((m) => m.modData.id === modId);
        if (!marker || !markerClusterGroup.hasLayer(marker)) continue;
        const parent = markerClusterGroup.getVisibleParent(marker);
        if (!parent) continue;
        const key = parent._leaflet_id;
        if (!parentBuckets.has(key)) parentBuckets.set(key, { parent, count: 0 });
        parentBuckets.get(key).count++;
      }

      // Find the parent that absorbed the most panel mods.
      let bestEntry = null;
      for (const entry of parentBuckets.values()) {
        if (!bestEntry || entry.count > bestEntry.count) bestEntry = entry;
      }

      // No surviving parent contains any panel mod → close.
      if (!bestEntry || bestEntry.count === 0) {
        hideClusterPanel();
        return;
      }

      // Parent is a singleton marker (zoomed in past clustering) → close.
      if (typeof bestEntry.parent.getAllChildMarkers !== "function") {
        hideClusterPanel();
        return;
      }

      const childMarkers = bestEntry.parent.getAllChildMarkers().slice()
        .sort((l, r) => NCZ.sortModsByUpdated(l.modData, r.modData));
      if (childMarkers.length < 2) {
        hideClusterPanel();
        return;
      }

      // Skip rebuild if membership identical (avoid flicker during continuous interaction).
      // Still re-apply the active mark: Leaflet recreates cluster DOM elements
      // on zoom, so the previously-marked element may no longer exist.
      if (childMarkers.length === panelClusterModIds.size) {
        let identical = true;
        for (const m of childMarkers) {
          if (!panelClusterModIds.has(m.modData.id)) { identical = false; break; }
        }
        if (identical) {
          refreshActiveSatClusterMark();
          return;
        }
      }

      const childMods = childMarkers.map((m) => m.modData);
      populateClusterPanel(childMods, {
        nexusThumbs,
        onItemClick: (mod) => {
          const m = childMarkers.find((cm) => cm.modData.id === mod.id);
          if (m) flyToPanelMarker(m);
        },
      });
    }

    // Re-evaluate SAT panel after Leaflet finishes its zoom transition (clusters
    // recomputed at the new zoom level).
    map.on("zoomend", recomputeSatClusterPanel);
    // markercluster fires animationend after cluster animations settle;
    // covers zoom-driven cluster regrouping (spiderfy is no longer used).
    markerClusterGroup.on("animationend", recomputeSatClusterPanel);

    sortedMods.forEach((mod) => {
        const [lat, lng] = NCZ.cetToLeaflet(mod.coordinates[0], mod.coordinates[1]);
        const { catStyle, popupHtml, thumbSrc, fullSrc } = NCZ.prepareModRenderData(mod, nexusThumbs, tagsDict);

        // Custom Marker Icon (Diamond/Square for Night Corp)
        const icon = L.divIcon({
          className: "category-marker",
          html: `<div class="marker-pin ${catStyle.class}"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });

        const marker = L.marker([lat, lng], { icon });
        marker.modData = mod; // Store data for filtering later
        allMarkers.push(marker);
        markerClusterGroup.addLayer(marker);

        marker.on("mouseover", () => {
          pinTooltip.show(marker, mod.name);
        });
        marker.on("mouseout", () => {
          pinTooltip.hide(marker);
        });
        marker.on("click", () => {
          pinTooltip.hide(marker);
        });
        marker.on("remove", () => {
          pinTooltip.hide(marker);
        });

        marker.modThumb = thumbSrc;
        marker.modFull = fullSrc;

        marker.bindPopup(popupHtml, {
          autoPan: false,
          offset: [0, 0],
          minWidth: 360,
          maxWidth: 360,
          className: `ncz-dynamic-popup popup-${catStyle.class}`,
        });

        // Add to Sidebar
        const li = document.createElement("li");
        li.className = "mod-item";
        li.dataset.category = mod.category;
        li.dataset.tags = [...(mod.tags || []), ...(NCZ.isRecentlyUpdated(mod) ? ["updated"] : [])].join(",");
        li.dataset.authors = mod.authors.join(",");
        const sidebarBadge = mod._source === "nexus-auto"
          ? ` <span class="nexus-auto-badge" title="Sourced automatically from Nexus Mods" aria-hidden="true"></span>`
          : "";
        const sidebarUpdatedBadge = NCZ.isRecentlyUpdated(mod)
          ? ` <span class="badge-updated" title="Updated on Nexus within the last ${NCZ.recentlyUpdatedDays ?? NCZ.RECENTLY_UPDATED_DAYS} days">${NCZ.UPDATED_LABEL}</span>`
          : "";
        li.innerHTML = `
                <div class="mod-item-header">
                    <span class="mod-item-name">${NCZ.escapeHtml(mod.name)}</span>${sidebarBadge}${sidebarUpdatedBadge}
                </div>
                <span class="mod-item-author">by ${NCZ.escapeHtml(mod.authors.join(", "))}</span>
                <div class="mod-item-meta">
                    <span class="mod-item-category badge-${NCZ.escapeHtml(mod.category)}">${NCZ.escapeHtml(catStyle.label)}</span>
                </div>
            `;
        li.addEventListener("click", (e) => {
          if (e.target.tagName !== "A") {
            // Route to whichever view is currently active. mapEl hidden = 3D mode.
            if (mapEl.style.display === "none") {
              NCZ.ThreeMarkers?.focusMod?.(mod.id);
            } else {
              focusMarker(marker);
            }
            hideClusterPanel();
            if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) sidebar.classList.add("hidden");
          }
        });

        // Pulse marker (or parent cluster) on sidebar hover. Both views share
        // the `.pulsing` class + @keyframes markerPulse; calling both layers
        // is idempotent and keeps SAT/SCHEMA in sync without checking which
        // is active.
        li.addEventListener("mouseenter", () => {
          const element = marker.getElement();
          if (element) {
            const pin = element.querySelector(".marker-pin");
            if (pin) pin.classList.add("pulsing");
          } else {
            const visibleParent = markerClusterGroup.getVisibleParent(marker);
            if (visibleParent && visibleParent !== marker) {
              const clusterEl = visibleParent.getElement();
              if (clusterEl) clusterEl.classList.add("pulsing");
            }
          }
          NCZ.ThreeMarkers?.setPulse?.(mod.id, true);
        });
        li.addEventListener("mouseleave", () => {
          const element = marker.getElement();
          if (element) {
            const pin = element.querySelector(".marker-pin");
            if (pin) pin.classList.remove("pulsing");
          } else {
            const visibleParent = markerClusterGroup.getVisibleParent(marker);
            if (visibleParent && visibleParent !== marker) {
              const clusterEl = visibleParent.getElement();
              if (clusterEl) clusterEl.classList.remove("pulsing");
            }
          }
          NCZ.ThreeMarkers?.setPulse?.(mod.id, false);
        });

        modListEl.appendChild(li);
      });

    // (No initial fit-to-pins here.) The 2D map starts hidden under the 3D view;
    // its visible framing comes from view-sync on a SCHEMA→SAT switch, or from
    // applyDefaultSatView() on the WebGPU fallback. A fit-to-all-pins default
    // squashed the city into a corner (badlands outliers stretch the bounds) and
    // only ever showed on the fallback; superseded by the 3D-equivalent default.

    // Deep-link: open pin if ?mod= is in the URL.
    //
    // MUST route by active view, exactly as onViewSwitched below does. This
    // used to always take the Leaflet path, which broke every shared ?mod= link
    // once the 3D scene became the default view: the Leaflet container is
    // `display: none` then, so `map.getSize()` is 0x0, `flyTo` divides by zero
    // and Leaflet throws `Invalid LatLng object: (NaN, NaN)` from unproject.
    //
    // The throw escaped into the outer catch, so the whole map rendered as
    // "Map data temporarily unavailable", an API-outage message for what is
    // actually a view-routing bug, with the API perfectly healthy.
    const deepLinkParam = new URLSearchParams(window.location.search).get(NCZ.URL_PARAM_MOD);
    if (deepLinkParam) {
      // Same test onViewSwitched and focusRandomVisibleMarker use.
      const isSchema = mapEl.style.display === "none";
      if (isSchema) {
        const mod = mods.find(
          (m) => String(m.nexus_id) === deepLinkParam || m.id === deepLinkParam,
        );
        if (mod) NCZ.ThreeMarkers?.focusMod?.(mod.id);
      } else {
        const targetMarker = allMarkers.find(
          (m) => String(m.modData.nexus_id) === deepLinkParam || m.modData.id === deepLinkParam,
        );
        if (targetMarker) focusMarker(targetMarker);
      }
    }

    // Re-open the popup in the freshly-activated view. Both ThreeMarkers and
    // the Leaflet popupopen handler keep ?mod= in sync, so this restore picks
    // up whatever was open before the switch; popups stay coherent across modes.
    onViewSwitched = (viewName) => {
      // Cluster panel state is view-specific: SAT and SCHEMA cluster differently
      // (Leaflet's stable IDs vs Three's screen-space recompute), so the panel's
      // mod set isn't meaningful in the other view. Close on switch.
      hideClusterPanel();

      const param = new URLSearchParams(window.location.search).get(NCZ.URL_PARAM_MOD);
      if (!param) return;
      if (viewName === "schema") {
        const mod = mods.find(
          (m) => String(m.nexus_id) === param || m.id === param,
        );
        if (mod) NCZ.ThreeMarkers?.focusMod?.(mod.id);
      } else {
        const targetMarker = allMarkers.find(
          (m) => String(m.modData.nexus_id) === param || m.modData.id === param,
        );
        if (targetMarker) focusMarker(targetMarker);
      }
    };

    // 5. Setup Category Filters
    const activeCategories = new Set(mods.map((m) => m.category));
    activeCategories.forEach((cat) => {
      const style = NCZ.CATEGORY_STYLES[cat] || NCZ.CATEGORY_STYLES["other"];
      const btn = document.createElement("button");
      btn.className = "filter-btn active";
      btn.textContent = style.label;
      btn.dataset.category = cat;
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        applyFilters();
      });
      filterContainer.appendChild(btn);
    });

    // 5b. Setup Author Filters
    const usedAuthors = new Set();
    mods.forEach((mod) => mod.authors.forEach((a) => usedAuthors.add(a)));
    Array.from(usedAuthors)
      .sort()
      .forEach((author) => {
        const btn = document.createElement("button");
        btn.className = "tag-filter-btn"; // Reusing tag style for consistency
        btn.textContent = author;
        btn.dataset.author = author;
        btn.addEventListener("click", () => {
          btn.classList.toggle("active");
          applyFilters();
        });
        authorFilterContainer.appendChild(btn);
      });

    // Add Tags filter UI (targets static #tag-filters div in HTML)
    const tagsFilterContainer = document.getElementById("tag-filters");
    function clearActiveTagLikeFilters(container) {
      container.querySelectorAll(".tag-filter-btn.active").forEach((btn) => {
        btn.classList.remove("active");
      });
    }

    if (clearTagFiltersBtn) {
      clearTagFiltersBtn.addEventListener("click", () => {
        clearActiveTagLikeFilters(tagsFilterContainer);
        applyFilters();
      });
    }

    if (clearAuthorFiltersBtn) {
      clearAuthorFiltersBtn.addEventListener("click", () => {
        clearActiveTagLikeFilters(authorFilterContainer);
        applyFilters();
      });
    }

    const usedTags = new Set();
    mods.forEach((mod) => (mod.tags || []).forEach((t) => usedTags.add(t)));

    // Prepend synthetic "updated" button if any mod is recently updated
    if (mods.some(NCZ.isRecentlyUpdated)) {
      const btn = document.createElement("button");
      btn.className = "tag-filter-btn";
      btn.textContent = NCZ.UPDATED_LABEL;
      btn.title = `Updated on Nexus within the last ${NCZ.recentlyUpdatedDays ?? NCZ.RECENTLY_UPDATED_DAYS} days`;
      btn.dataset.tag = "updated";
      btn.addEventListener("click", () => { btn.classList.toggle("active"); applyFilters(); });
      tagsFilterContainer.appendChild(btn);
    }

    Array.from(usedTags)
      .sort((a, b) => {
        if (a === "nczoning") return -1;
        if (b === "nczoning") return 1;
        return a.localeCompare(b);
      })
      .forEach((tag) => {
        const def = tag === "nczoning"
          ? "Sourced automatically from Nexus Mods"
          : tagsDict[tag] || "";
        const btn = document.createElement("button");
        btn.className = "tag-filter-btn";
        btn.textContent = tag;
        btn.title = def;
        btn.dataset.tag = tag;
        btn.addEventListener("click", () => {
          btn.classList.toggle("active");
          applyFilters();
        });
        tagsFilterContainer.appendChild(btn);
      });

    // Setup collapsible section headers
    document.querySelectorAll(".sidebar-section-header.collapsible").forEach((header) => {
      const target = document.getElementById(header.dataset.collapseTarget);
      if (!target) return;
      header.addEventListener("click", () => {
        header.classList.toggle("collapsed");
        target.classList.toggle("filter-collapsed");
      });
    });

    // 6. Populate the submit form's tag checkboxes (requires tagsDict from this scope)
    const submitTagGrid = document.getElementById("submit-tag-checkboxes");
    if (submitTagGrid) {
      Object.keys(tagsDict)
        .sort()
        .forEach((tag) => {
          const label = document.createElement("label");
          label.className = "submit-tag-checkbox";
          label.title = tagsDict[tag] || "";
          label.innerHTML = `<input type="checkbox" value="${tag}"> ${tag}`;
          submitTagGrid.appendChild(label);
        });
    }

    // 7. Setup Text Search (debounced to avoid excessive re-filtering)
    const searchInput = document.getElementById("mod-search");
    const searchClearBtn = document.getElementById("mod-search-clear");
    let searchDebounce;
    function updateSearchClearButtonVisibility() {
      if (!searchClearBtn) return;
      searchClearBtn.hidden = searchInput.value.length === 0;
    }

    function clearSearchQuery() {
      if (searchInput.value.length === 0) return;
      searchInput.value = "";
      updateSearchClearButtonVisibility();
      clearTimeout(searchDebounce);
      applyFilters();
      searchInput.focus();
    }

    searchInput.addEventListener("input", () => {
      updateSearchClearButtonVisibility();
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(applyFilters, NCZ.SEARCH_DEBOUNCE_MS);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (searchInput.value.length === 0) return;
      event.preventDefault();
      clearSearchQuery();
    });

    if (searchClearBtn) {
      searchClearBtn.addEventListener("click", clearSearchQuery);
    }
    updateSearchClearButtonVisibility();

    // Centralised Filter Logic
    function applyFilters() {
      const query = searchInput.value.toLowerCase();
      const activeCats = Array.from(
        filterContainer.querySelectorAll(".filter-btn.active"),
      ).map((b) => b.dataset.category);
      const activeTags = Array.from(
        document.querySelectorAll("#tag-filters .tag-filter-btn.active"),
      ).map((b) => b.dataset.tag);
      const activeAuthors = Array.from(
        authorFilterContainer.querySelectorAll(".tag-filter-btn.active"),
      ).map((b) => b.dataset.author);
      if (tagFilterCountEl) tagFilterCountEl.textContent = activeTags.length > 0 ? ` (${activeTags.length})` : "";
      if (authorFilterCountEl) authorFilterCountEl.textContent = activeAuthors.length > 0 ? ` (${activeAuthors.length})` : "";
      if (clearTagFiltersBtn) clearTagFiltersBtn.hidden = activeTags.length === 0;
      if (clearAuthorFiltersBtn) clearAuthorFiltersBtn.hidden = activeAuthors.length === 0;

      // Close any open cluster panel FIRST. hideClusterPanel →
      // clearPanelPinFocus returns any force-individual (comparison-mode)
      // markers from the map back into the cluster group before we wipe it,
      // so they can't orphan on the map or survive a filter that excludes
      // them. Order matters: this must precede clearLayers().
      hideClusterPanel();
      // Clear current cluster group
      markerClusterGroup.clearLayers();
      const visibleMarkers = [];

      // Compute which mods pass all filters (view-agnostic)
      const visibleIds = NCZ.computeVisibleMods(mods, { query, activeCats, activeTags, activeAuthors });

      // Apply to Leaflet markers
      allMarkers.forEach((marker) => {
        if (visibleIds.has(marker.modData.id)) {
          markerClusterGroup.addLayer(marker);
          visibleMarkers.push(marker);
        }
      });

      // Apply same filter set to 3D pin layer
      NCZ.ThreeMarkers?.applyFilters?.(visibleIds);

      // SAT cluster panel may need to update or close after filter change:
      // some of its mods might no longer be in the visible cluster set.
      recomputeSatClusterPanel();

      // Filter the sidebar list items
      const listItems = modListEl.querySelectorAll(".mod-item");
      listItems.forEach((li) => {
        const modName = li
          .querySelector(".mod-item-name")
          .textContent.toLowerCase();
        const modAuthor = li
          .querySelector(".mod-item-author")
          .textContent.toLowerCase();
        const modCat = li.dataset.category;
        const modTags = (li.dataset.tags || "").split(",");
        const modAuthors = (li.dataset.authors || "").split(",").filter(Boolean);

        const matchesSearch =
          modName.includes(query) || modAuthor.includes(query);
        const matchesCategory = activeCats.includes(modCat);
        const matchesTags =
          activeTags.length === 0 ||
          activeTags.some((t) => modTags.includes(t));
        const matchesAuthor =
          activeAuthors.length === 0 ||
          activeAuthors.some((a) => modAuthors.includes(a));

        li.style.display =
          matchesSearch && matchesCategory && matchesTags && matchesAuthor
            ? "block"
            : "none";
      });

      // Update visible mod count
      modCountEl.textContent = `(${visibleMarkers.length}/${mods.length})`;

      if (focusedMarker && !markerClusterGroup.hasLayer(focusedMarker)) {
        focusedMarker = null;
      } else {
        scheduleFocusedPopupRestore();
      }
    }
  } catch (error) {
    // No fallback path: the /v1 API is the only data source (see step 3). Rather
    // than leave a silent blank map (which would mask an API outage the in-game
    // consumer can't survive), surface a loud, auto-retrying error state.
    console.error("Error loading map data:", error);
    showMapDataUnavailable(error);
  }
}

// Loud "map data unavailable" state, shown when the /v1 API load fails. Reveals
// the static #map-unavailable overlay (covers both the 2D and 3D views), then
// polls the API on a backoff. A successful poll means the outage cleared, so we
// reload for a clean init rather than trying to resume a half-built page. Idempotent:
// re-entry (e.g. a second failure) just leaves the existing retry loop running.
let mapUnavailableActive = false;
function showMapDataUnavailable(error) {
  const overlay = document.getElementById("map-unavailable");
  if (!overlay) return;
  const detailEl = overlay.querySelector(".map-unavailable__detail");
  if (detailEl && error) detailEl.textContent = String(error.message || error);
  overlay.classList.remove("hidden");

  if (mapUnavailableActive) return; // retry loop already running
  mapUnavailableActive = true;

  const statusEl = overlay.querySelector(".map-unavailable__status");
  const retryBtn = overlay.querySelector(".map-unavailable__retry");
  let attempt = 0;
  let timer = null;

  // Backoff: 10s, 20s, 40s, capped at 60s — frequent enough to recover promptly,
  // slow enough not to hammer a down API from every open tab.
  const nextDelay = () => Math.min(10000 * 2 ** attempt, 60000);

  async function attemptReload() {
    if (statusEl) statusEl.textContent = "Checking…";
    try {
      await NCZ.fetchLocationsFromApi();
      if (statusEl) statusEl.textContent = "Reconnected — reloading…";
      location.reload();
    } catch (err) {
      attempt++;
      const secs = Math.round(nextDelay() / 1000);
      if (statusEl) statusEl.textContent = `Still unavailable — retrying in ${secs}s`;
      console.warn("Map data still unavailable; will retry:", err);
      timer = setTimeout(attemptReload, nextDelay());
    }
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      clearTimeout(timer);
      attempt = 0;
      attemptReload();
    });
  }

  timer = setTimeout(attemptReload, nextDelay());
}

// --- Image Gallery Modal Logic ---
let currentGallery = [];
let currentIndex = 0;

window.openImageGallery = function (images, index) {
  currentGallery = images;
  currentIndex = index;
  updateModalImage();
  const imageModal = document.getElementById("image-modal");
  if (imageModal) imageModal.classList.remove("hidden");
};

function updateModalImage() {
  const modalImage = document.getElementById("modal-image");
  const imageCounter = document.getElementById("image-counter");
  const prevBtn = document.getElementById("prev-image");
  const nextBtn = document.getElementById("next-image");

  if (modalImage) {
    modalImage.src = currentGallery[currentIndex];
    modalImage.referrerPolicy = "no-referrer";
  }
  if (imageCounter)
    imageCounter.textContent = `IMAGE ${currentIndex + 1} / ${currentGallery.length}`;
  if (prevBtn)
    prevBtn.style.display = currentGallery.length > 1 ? "block" : "none";
  if (nextBtn)
    nextBtn.style.display = currentGallery.length > 1 ? "block" : "none";
}

function closeGallery() {
  const imageModal = document.getElementById("image-modal");
  const modalImage = document.getElementById("modal-image");
  if (imageModal) imageModal.classList.add("hidden");
  if (modalImage) modalImage.src = "";
}

// Delegated click handler for popup thumbnails (avoids inline onclick / XSS risk)
document.addEventListener("click", (e) => {
  const thumb = e.target.closest(".popup-thumb[data-full-src]");
  if (thumb) {
    window.openImageGallery([thumb.dataset.fullSrc], 0);
  }
});

// Global Event Listeners for Image Modal
document.addEventListener("DOMContentLoaded", () => {
  const closeImageModal = document.getElementById("close-image-modal");
  const imageModal = document.getElementById("image-modal");
  const prevBtn = document.getElementById("prev-image");
  const nextBtn = document.getElementById("next-image");

  if (closeImageModal) closeImageModal.addEventListener("click", closeGallery);
  if (imageModal) {
    const overlay = imageModal.querySelector(".modal-overlay");
    if (overlay) overlay.addEventListener("click", closeGallery);
  }

  if (prevBtn)
    prevBtn.addEventListener("click", () => {
      currentIndex =
        (currentIndex - 1 + currentGallery.length) % currentGallery.length;
      updateModalImage();
    });

  if (nextBtn)
    nextBtn.addEventListener("click", () => {
      currentIndex = (currentIndex + 1) % currentGallery.length;
      updateModalImage();
    });
});

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  const imageModal = document.getElementById("image-modal");
  const isImageModalOpen = imageModal && !imageModal.classList.contains("hidden");

  if (e.key === "Escape") {
    if (isImageModalOpen) {
      closeGallery();
      return;
    }

    const visibleModal = document.querySelector(".modal:not(.hidden)");
    if (visibleModal) {
      visibleModal.classList.add("hidden");
      if (visibleModal.id === "welcome-modal") {
        sessionStorage.setItem("nc_zoning_board_visited", "true");
      }
      return;
    }

    document.querySelector(".leaflet-popup-close-button")?.click();
    return;
  }

  if (!isImageModalOpen) return;
  if (e.key === "ArrowLeft" && currentGallery.length > 1) {
    currentIndex =
      (currentIndex - 1 + currentGallery.length) % currentGallery.length;
    updateModalImage();
  }
  if (e.key === "ArrowRight" && currentGallery.length > 1) {
    currentIndex = (currentIndex + 1) % currentGallery.length;
    updateModalImage();
  }
});
