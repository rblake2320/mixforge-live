(function () {
  const state = {
    token: localStorage.getItem("mixforge_token") || "",
    user: null,
    mediaRecorder: null,
    stream: null,
    chunks: [],
    recordStartedAt: 0,
    timerId: null,
    levelFrame: 0,
    audioContext: null,
    lastBlob: null,
    lastObjectUrl: "",
    lastRecording: null,
    beats: []
  };

  function addStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .api-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--color-border);
        background: var(--color-surface-2);
        color: var(--color-text-muted);
        font-size: 12px;
        font-weight: 700;
      }
      .api-pill.online { color: var(--color-green); }
      .api-pill.offline { color: var(--color-orange); }
      .mixforge-toast-wrap {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 1600;
        display: grid;
        gap: 10px;
        max-width: min(360px, calc(100vw - 36px));
      }
      .mixforge-toast {
        padding: 12px 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
        color: var(--color-text);
        background: var(--color-surface-2);
        box-shadow: var(--shadow-md);
        font-size: 14px;
        line-height: 1.35;
      }
      .mixforge-toast.success {
        border-color: rgba(0,229,160,0.45);
        background: linear-gradient(135deg, var(--color-green-dim), var(--color-surface-2));
      }
      .mixforge-toast.warning {
        border-color: rgba(255,140,66,0.5);
        background: linear-gradient(135deg, rgba(255,140,66,0.16), var(--color-surface-2));
      }
      .beat-thumb {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0;
      }
      #modes, #studio, #features, #pricing, #community {
        scroll-margin-top: 88px;
      }
      .mixforge-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1200;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(0,0,0,0.64);
        backdrop-filter: blur(10px);
      }
      .mixforge-modal {
        width: min(560px, 100%);
        max-height: min(720px, calc(100dvh - 40px));
        overflow: auto;
        padding: 20px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-surface);
        color: var(--color-text);
        box-shadow: var(--shadow-lg);
      }
      .mixforge-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 16px;
      }
      .mixforge-modal-title {
        font-size: var(--text-lg);
        font-weight: 800;
      }
      .mixforge-modal-close {
        width: 34px;
        height: 34px;
        border-radius: var(--radius-full);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        color: var(--color-text);
      }
      .mixforge-form {
        display: grid;
        gap: 12px;
      }
      .mixforge-form label {
        display: grid;
        gap: 6px;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        font-weight: 700;
      }
      .mixforge-form input,
      .mixforge-form textarea {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface-2);
        color: var(--color-text);
      }
      .mixforge-form textarea {
        min-height: 120px;
        resize: vertical;
      }
      .mixforge-beat-grid {
        display: grid;
        gap: 10px;
      }
      .mixforge-beat-choice {
        display: grid;
        grid-template-columns: 42px 1fr auto;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface-2);
        text-align: left;
      }
      .mixforge-beat-choice:hover {
        border-color: var(--color-primary);
        background: var(--color-surface-3);
      }
      .mixforge-empty-state {
        padding: 16px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface-2);
        color: var(--color-text-muted);
      }
    `;
    document.head.appendChild(style);
  }

  function toast(message, options = {}) {
    let wrap = document.querySelector(".mixforge-toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "mixforge-toast-wrap";
      wrap.setAttribute("aria-live", "polite");
      document.body.appendChild(wrap);
    }
    const node = document.createElement("div");
    node.className = `mixforge-toast ${options.type || ""}`.trim();
    node.setAttribute("role", "status");
    node.textContent = message;
    wrap.appendChild(node);
    setTimeout(() => node.remove(), options.durationMs || 8000);
    return node;
  }

  function showActionResult(message, options = {}) {
    toast(message, { type: options.type || "success", durationMs: options.durationMs || 10000 });
  }

  function setApiStatus(status, label) {
    let pill = document.querySelector(".api-pill");
    const navActions = document.querySelector(".nav-actions");
    if (!pill && navActions) {
      pill = document.createElement("span");
      pill.className = "api-pill";
      navActions.prepend(pill);
    }
    if (pill) {
      pill.className = `api-pill ${status}`;
      pill.textContent = label;
    }
  }

  function closeModal() {
    document.querySelector(".mixforge-modal-backdrop")?.remove();
  }

  function openModal(title, content) {
    closeModal();
    const backdrop = document.createElement("div");
    backdrop.className = "mixforge-modal-backdrop";
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeModal();
      }
    });

    const modal = document.createElement("div");
    modal.className = "mixforge-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="mixforge-modal-header">
        <div class="mixforge-modal-title">${title}</div>
        <button class="mixforge-modal-close" type="button" aria-label="Close">x</button>
      </div>
    `;

    const body = document.createElement("div");
    if (typeof content === "string") {
      body.innerHTML = content;
    } else {
      body.appendChild(content);
    }
    modal.appendChild(body);
    modal.querySelector(".mixforge-modal-close").addEventListener("click", closeModal);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modal.querySelector("input, textarea, button")?.focus();
  }

  function scrollToHash(hash) {
    if (!hash || hash === "#") {
      return false;
    }
    const id = decodeURIComponent(hash.slice(1));
    const target = document.getElementById(id);
    if (!target) {
      return false;
    }

    const navHeight = document.getElementById("nav")?.offsetHeight || 72;
    const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - navHeight - 16);
    const scroller = document.scrollingElement || document.documentElement;
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }

    const priorBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    scroller.scrollTop = top;
    document.documentElement.scrollTop = top;
    document.body.scrollTop = top;
    window.scrollTo(0, top);
    window.requestAnimationFrame(() => {
      if (Math.abs((window.scrollY || scroller.scrollTop) - top) > 4) {
        scroller.scrollTop = top;
        window.scrollTo(0, top);
      }
      document.documentElement.style.scrollBehavior = priorBehavior;
    });
    return true;
  }

  function wireHashNavigation() {
    const handleLink = (event, forcedLink = null) => {
      const link = forcedLink || event.currentTarget || event.target.closest('a[href^="#"]');
      const href = link?.getAttribute("href");
      if (!href || href === "#" || !document.getElementById(decodeURIComponent(href.slice(1)))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (typeof window.closeMobileNav === "function") {
        window.closeMobileNav();
      }
      scrollToHash(href);
    };

    document.querySelectorAll('a[href^="#"]').forEach((link) => {
      const href = link.getAttribute("href");
      if (href && href !== "#" && document.getElementById(decodeURIComponent(href.slice(1)))) {
        link.addEventListener("click", handleLink, { capture: true });
      }
    });

    document.addEventListener("click", (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) {
        return;
      }
      handleLink(event, link);
    }, true);

    if (window.location.hash) {
      setTimeout(() => scrollToHash(window.location.hash), 0);
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const hasForm = options.body instanceof FormData;
    if (!hasForm && options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (state.token) {
      headers.set("Authorization", `Bearer ${state.token}`);
    }

    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : `Request failed: ${response.status}`);
    }
    return payload;
  }

  function selectedBeat() {
    const active = document.querySelector(".beat-item.active");
    return {
      id: active ? active.getAttribute("data-beat-id") || "" : "",
      name: active ? active.querySelector(".beat-name")?.textContent.trim() || "" : ""
    };
  }

  function selectedPreset() {
    return document.querySelector(".preset-btn.active")?.textContent.trim() || "Natural";
  }

  async function requireAuthenticated(mode = "signup") {
    if (state.token) {
      try {
        const me = await api("/api/me");
        state.user = me.user;
        return state.user;
      } catch {
        localStorage.removeItem("mixforge_token");
        state.token = "";
      }
    }

    openAuthModal(mode);
    throw new Error("Create an account or log in first.");
  }

  async function loginWithPrompt() {
    openAuthModal("login");
  }

  function openAuthModal(mode = "signup") {
    let activeMode = mode;
    const form = document.createElement("form");
    form.className = "mixforge-form";

    const render = () => {
      const modalTitle = document.querySelector(".mixforge-modal-title");
      if (modalTitle) {
        modalTitle.textContent = activeMode === "signup" ? "Start Free" : "Log In";
      }
      form.innerHTML = `
        ${activeMode === "signup" ? `
          <label>
            Name
            <input name="name" autocomplete="name" required>
          </label>
        ` : ""}
        <label>
          Email
          <input name="email" type="email" autocomplete="email" required>
        </label>
        <label>
          Password
          <input name="password" type="password" autocomplete="${activeMode === "signup" ? "new-password" : "current-password"}" minlength="6" required>
        </label>
        <button class="btn btn-primary" type="submit" style="justify-content:center;">
          ${activeMode === "signup" ? "Create Free Account" : "Log In"}
        </button>
        <button class="btn btn-secondary" type="button" data-switch-auth style="justify-content:center;">
          ${activeMode === "signup" ? "I already have an account" : "Create an account"}
        </button>
      `;
    };

    render();
    form.addEventListener("click", (event) => {
      const switchButton = event.target.closest("[data-switch-auth]");
      if (!switchButton) {
        return;
      }
      activeMode = activeMode === "signup" ? "login" : "signup";
      render();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      const endpoint = activeMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      try {
        const result = await api(endpoint, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        state.token = result.token;
        state.user = result.user;
        localStorage.setItem("mixforge_token", state.token);
        closeModal();
        toast(`${activeMode === "signup" ? "Account created" : "Logged in"} as ${state.user.email}`);
        if (activeMode === "signup") {
          scrollToHash("#studio");
        }
      } catch (error) {
        toast(error.message);
      }
    });

    openModal(activeMode === "signup" ? "Start Free" : "Log In", form);
  }

  function updateTimer() {
    const seconds = Math.floor((Date.now() - state.recordStartedAt) / 1000);
    const timer = document.getElementById("recordTimer");
    if (timer) {
      timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
  }

  function stopLevelMeter() {
    cancelAnimationFrame(state.levelFrame);
    state.levelFrame = 0;
    if (state.audioContext) {
      state.audioContext.close().catch(() => {});
      state.audioContext = null;
    }
  }

  function beginLevelMeter(stream) {
    const level = document.getElementById("voiceLevel");
    if (!level || !window.AudioContext) {
      return;
    }

    stopLevelMeter();
    state.audioContext = new AudioContext();
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 512;
    state.audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    const update = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centered = sample - 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / samples.length);
      level.style.width = `${Math.min(100, Math.round(rms * 3.8))}%`;
      state.levelFrame = requestAnimationFrame(update);
    };
    update();
  }

  function setRecordingUi(isRecording, statusText) {
    const btn = document.getElementById("recordBtn");
    const label = document.getElementById("recordLabel");
    const status = document.getElementById("recordStatus");
    if (btn) {
      btn.classList.toggle("recording", isRecording);
    }
    if (label) {
      label.textContent = isRecording ? "Recording..." : "Tap to Record Again";
    }
    if (status) {
      status.textContent = statusText;
    }
  }

  async function finishRecording() {
    clearInterval(state.timerId);
    stopLevelMeter();

    const level = document.getElementById("voiceLevel");
    if (level) {
      level.style.width = "0%";
    }

    const mimeType = state.mediaRecorder?.mimeType || "audio/webm";
    const blob = new Blob(state.chunks, { type: mimeType });
    state.lastBlob = blob;
    if (state.lastObjectUrl) {
      URL.revokeObjectURL(state.lastObjectUrl);
    }
    state.lastObjectUrl = URL.createObjectURL(blob);

    const seconds = Math.max(1, Math.round((Date.now() - state.recordStartedAt) / 1000));
    const beat = selectedBeat();
    const form = new FormData();
    form.append("audio", blob, `mixforge-take-${Date.now()}.webm`);
    form.append("durationSeconds", String(seconds));
    form.append("beatId", beat.id);
    form.append("beatName", beat.name);
    form.append("preset", selectedPreset());
    form.append("title", `${beat.name || "MixForge"} Vocal Take`);

    try {
      const saved = await api("/api/recordings", {
        method: "POST",
        body: form
      });
      state.lastRecording = saved.recording;
      setRecordingUi(false, "Saved to backend");
      ["playbackBtn", "saveBtn", "exportBtn"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) {
          button.disabled = false;
        }
      });
      toast("Recording uploaded and ready.");
    } catch (error) {
      setRecordingUi(false, "Saved in browser only");
      toast(error.message);
    } finally {
      if (state.stream) {
        state.stream.getTracks().forEach((track) => track.stop());
      }
      state.stream = null;
      state.mediaRecorder = null;
    }
  }

  async function startRecording() {
    if (!window.isSecureContext) {
      toast("Microphone access requires HTTPS on a live domain.");
      setRecordingUi(false, "HTTPS required for microphone");
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast("This browser does not support microphone recording.");
      return;
    }

    await requireAuthenticated("signup");
    setRecordingUi(false, "Waiting for microphone permission...");
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = "audio/webm;codecs=opus";
    const options = MediaRecorder.isTypeSupported(preferred) ? { mimeType: preferred } : undefined;
    state.mediaRecorder = new MediaRecorder(state.stream, options);
    state.chunks = [];
    state.recordStartedAt = Date.now();

    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });
    state.mediaRecorder.addEventListener("stop", finishRecording);
    state.mediaRecorder.start(250);

    setRecordingUi(true, "Live recording");
    updateTimer();
    clearInterval(state.timerId);
    state.timerId = setInterval(updateTimer, 1000);
    beginLevelMeter(state.stream);
  }

  async function toggleRecordReal() {
    try {
      if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
        state.mediaRecorder.stop();
      } else {
        await startRecording();
      }
    } catch (error) {
      setRecordingUi(false, "Microphone permission is required");
      toast(error.message);
      if (state.stream) {
        state.stream.getTracks().forEach((track) => track.stop());
      }
      stopLevelMeter();
    }
  }

  function wireRecordingButtons() {
    window.toggleRecord = toggleRecordReal;

    const playback = document.getElementById("playbackBtn");
    if (playback) {
      playback.addEventListener("click", () => {
        if (!state.lastObjectUrl) {
          toast("Record a take first.");
          return;
        }
        new Audio(state.lastObjectUrl).play();
      });
    }

    const save = document.getElementById("saveBtn");
    if (save) {
      save.addEventListener("click", async () => {
        try {
          await requireAuthenticated("signup");
          const beat = selectedBeat();
          const saved = await api("/api/projects", {
            method: "POST",
            body: JSON.stringify({
              title: `${beat.name || "MixForge"} Project`,
              mode: "vocal",
              recordingId: state.lastRecording?.id,
              beatId: beat.id,
              preset: selectedPreset()
            })
          });
          toast(`Project saved: ${saved.project.title}`);
        } catch (error) {
          toast(error.message);
        }
      });
    }

    const exportButton = document.getElementById("exportBtn");
    if (exportButton) {
      exportButton.addEventListener("click", () => {
        if (!state.lastBlob) {
          toast("Record a take first.");
          return;
        }
        const link = document.createElement("a");
        link.href = state.lastRecording?.audioUrl || state.lastObjectUrl;
        link.download = "mixforge-take.webm";
        link.click();
      });
    }
  }

  async function hydrateBeats() {
    const beatList = document.querySelector(".beat-list");
    if (!beatList) {
      return;
    }

    try {
      const payload = await api("/api/beats");
      state.beats = payload.beats;
      const colorMap = {
        pink: "var(--color-pink-dim)",
        cyan: "var(--color-cyan-dim)",
        green: "var(--color-green-dim)",
        purple: "var(--color-primary-glow)",
        orange: "rgba(255,140,66,0.15)"
      };
      beatList.innerHTML = payload.beats
        .map(
          (beat, index) => `
            <div class="beat-item ${index === 0 ? "active" : ""}" data-beat-id="${beat.id}" onclick="selectBeat(this)">
              <div class="beat-thumb" style="background:${colorMap[beat.color] || "var(--color-surface-3)"};">${beat.icon}</div>
              <div><div class="beat-name">${beat.name}</div><div class="beat-genre">${beat.genre}</div></div>
              <div class="beat-bpm">${beat.bpm}</div>
            </div>
          `
        )
        .join("");
    } catch (error) {
      toast(error.message);
    }
  }

  async function openBeatBrowser() {
    if (state.beats.length === 0) {
      const payload = await api("/api/beats");
      state.beats = payload.beats;
    }

    const colorMap = {
      pink: "var(--color-pink-dim)",
      cyan: "var(--color-cyan-dim)",
      green: "var(--color-green-dim)",
      purple: "var(--color-primary-glow)",
      orange: "rgba(255,140,66,0.15)"
    };
    const body = document.createElement("div");
    body.className = "mixforge-beat-grid";
    body.innerHTML = state.beats
      .map(
        (beat) => `
          <button class="mixforge-beat-choice" type="button" data-beat-id="${beat.id}">
            <span class="beat-thumb" style="background:${colorMap[beat.color] || "var(--color-surface-3)"};">${beat.icon}</span>
            <span>
              <strong>${beat.name}</strong><br>
              <small>${beat.genre} - ${beat.key}</small>
            </span>
            <span>${beat.bpm} BPM</span>
          </button>
        `
      )
      .join("");

    body.addEventListener("click", (event) => {
      const choice = event.target.closest(".mixforge-beat-choice");
      if (!choice) {
        return;
      }
      const beatItem = document.querySelector(`.beat-item[data-beat-id="${choice.dataset.beatId}"]`);
      if (beatItem) {
        window.selectBeat(beatItem);
      }
      closeModal();
      toast("Beat selected.");
    });

    openModal("Beat Library", body);
  }

  function wireBeatBrowser() {
    document.querySelectorAll("button").forEach((button) => {
      if (button.textContent.trim().toLowerCase() === "browse all") {
        button.addEventListener("click", async () => {
          try {
            await openBeatBrowser();
          } catch (error) {
            toast(error.message);
          }
        });
      }
    });
  }

  async function uploadAudioFile(file) {
    await requireAuthenticated("signup");
    const form = new FormData();
    form.append("audio", file, file.name);
    form.append("durationSeconds", "0");
    form.append("beatId", selectedBeat().id);
    form.append("beatName", selectedBeat().name);
    form.append("preset", selectedPreset());
    form.append("title", file.name.replace(/\.[^.]+$/, "") || "Mashup Upload");
    const saved = await api("/api/recordings", { method: "POST", body: form });
    state.lastRecording = saved.recording;
    return saved.recording;
  }

  async function importLinkStemJob(sourceUrl, button) {
    await requireAuthenticated("signup");
    const created = await api("/api/stems/jobs", {
      method: "POST",
      body: JSON.stringify({
        sourceUrl,
        stems: "vocals,drums,bass,other",
        bpmSync: true,
        keyMatch: true
      })
    });
    const completed = await pollStemJob(created.job.id, button);
    return completed;
  }

  function wireMashup() {
    const button = document.querySelector("#panel-mashup .mashup-controls .btn-primary");
    if (!button) {
      return;
    }
    button.onclick = null;
    const panel = document.querySelector("#panel-mashup .mashup-panel");
    const controls = button.closest(".mashup-controls");
    let uploadInput = document.getElementById("mashupUploadInput");
    if (!uploadInput && controls) {
      uploadInput = document.createElement("input");
      uploadInput.id = "mashupUploadInput";
      uploadInput.type = "file";
      uploadInput.accept = "audio/*";
      uploadInput.hidden = true;
      const uploadButton = document.createElement("button");
      uploadButton.className = "btn btn-secondary";
      uploadButton.type = "button";
      uploadButton.textContent = "Load from device / phone";
      uploadButton.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", async () => {
        const file = uploadInput.files?.[0];
        if (!file) {
          return;
        }
        try {
          await uploadAudioFile(file);
          toast("Audio loaded and ready for stem separation.");
        } catch (error) {
          toast(error.message);
        } finally {
          uploadInput.value = "";
        }
      });
      controls.insertBefore(uploadButton, button);
      controls.appendChild(uploadInput);
    }

    // Paste-a-link import: forwards the URL to the backend, which routes it to
    // StemSplit (YouTube / SoundCloud / direct audio URL). No client-side ripping.
    if (panel && !document.getElementById("mashupLinkRow")) {
      const linkRow = document.createElement("div");
      linkRow.id = "mashupLinkRow";
      linkRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px;";
      const linkInput = document.createElement("input");
      linkInput.type = "url";
      linkInput.id = "mashupLinkInput";
      linkInput.placeholder = "Paste a YouTube / SoundCloud / audio link…";
      linkInput.autocomplete = "off";
      linkInput.style.cssText =
        "flex:1;min-width:220px;padding:10px 12px;border-radius:8px;border:1px solid var(--color-border,#333);background:var(--color-surface,#141414);color:inherit;";
      const linkButton = document.createElement("button");
      linkButton.className = "btn btn-secondary";
      linkButton.type = "button";
      linkButton.textContent = "Import Link";
      linkButton.addEventListener("click", async () => {
        const value = linkInput.value.trim();
        if (!value) {
          toast("Paste a link first.");
          return;
        }
        const original = linkButton.textContent;
        linkButton.disabled = true;
        linkButton.textContent = "Importing…";
        try {
          const completed = await importLinkStemJob(value, linkButton);
          linkInput.value = "";
          toast(
            completed.provider === "demo"
              ? completed.diagnostic || "Demo import completed. Configure StemSplit for real separation."
              : `Imported and ${completed.status}.`,
            { type: completed.provider === "demo" ? "warning" : "success", durationMs: 12000 }
          );
        } catch (error) {
          toast(error.message);
        } finally {
          linkButton.disabled = false;
          linkButton.textContent = original;
        }
      });
      linkRow.appendChild(linkInput);
      linkRow.appendChild(linkButton);
      const hint = document.createElement("div");
      hint.style.cssText = "flex-basis:100%;font-size:12px;color:var(--color-text-muted,#888);";
      hint.textContent = "Import your own or licensed audio only. You are responsible for the rights to imported content.";
      linkRow.appendChild(hint);
      controls.parentElement.insertBefore(linkRow, controls.nextSibling);
    }

    // Drag-and-drop any audio file onto the mashup panel.
    if (panel && !panel.dataset.dropWired) {
      panel.dataset.dropWired = "true";
      const stop = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      ["dragenter", "dragover"].forEach((type) =>
        panel.addEventListener(type, (event) => {
          stop(event);
          panel.style.outline = "2px dashed var(--color-accent, #7c5cff)";
        })
      );
      ["dragleave", "drop"].forEach((type) =>
        panel.addEventListener(type, (event) => {
          stop(event);
          panel.style.outline = "";
        })
      );
      panel.addEventListener("drop", async (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (!file) {
          return;
        }
        if (!file.type.startsWith("audio/")) {
          toast("Drop an audio file (mp3, wav, m4a, flac, ogg…).");
          return;
        }
        try {
          await uploadAudioFile(file);
          toast(`Loaded "${file.name}". Ready for stem separation.`);
        } catch (error) {
          toast(error.message);
        }
      });
    }

    button.addEventListener("click", async () => {
      const original = button.textContent;
      button.textContent = "Processing...";
      button.disabled = true;
      try {
        await requireAuthenticated("signup");
        if (!state.lastRecording?.id) {
          throw new Error("Record or upload audio before previewing a mashup.");
        }
        const created = await api("/api/stems/jobs", {
          method: "POST",
          body: JSON.stringify({
            sourceName: "Mashup Preview",
            stems: "vocals,drums,bass,other",
            bpmSync: true,
            keyMatch: true,
            recordingId: state.lastRecording.id
          })
        });
        const completed = await pollStemJob(created.job.id, button);
        button.textContent = completed.status === "completed" ? "Preview Ready" : "Preview Mashup";
        toast(
          completed.provider === "demo"
            ? completed.diagnostic || "Demo stem preview completed. Configure StemSplit for real separation."
            : `Stem job ${completed.status}.`,
          { type: completed.provider === "demo" ? "warning" : "success", durationMs: 12000 }
        );
      } catch (error) {
        button.textContent = original;
        toast(error.message);
      } finally {
        button.disabled = false;
        setTimeout(() => {
          button.textContent = "Preview Mashup";
        }, 2500);
      }
    });
  }

  async function pollStemJob(jobId, button) {
    const startedAt = Date.now();
    const timeoutMs = 90_000;
    const intervalMs = 3_000;

    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const payload = await api(`/api/stems/jobs/${jobId}`);
      const job = payload.job;
      if (job.progress !== undefined && job.progress !== null) {
        button.textContent = `Processing ${Math.round(job.progress)}%`;
      }
      if (job.status === "completed") {
        return job;
      }
      if (job.status === "failed") {
        throw new Error(job.errorMessage || "Stem job failed.");
      }
    }

    throw new Error("Stem job is still processing. Check again from Projects shortly.");
  }

  function openContactForm(context = "General") {
    const form = document.createElement("form");
    form.className = "mixforge-form";
    form.innerHTML = `
      <label>
        Name
        <input name="name" autocomplete="name" required>
      </label>
      <label>
        Email
        <input name="email" type="email" autocomplete="email" required>
      </label>
      <label>
        Message
        <textarea name="message" required>${context === "General" ? "" : `I'm interested in ${context}.`}</textarea>
      </label>
      <button class="btn btn-primary" type="submit" style="justify-content:center;">Send</button>
    `;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      try {
        await api("/api/contact", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        closeModal();
        toast("Message saved. MixForge can follow up from the backend inbox.");
      } catch (error) {
        toast(error.message);
      }
    });
    openModal("Contact MixForge", form);
  }

  function planIdFromCard(card) {
    const name = card.querySelector(".plan-name")?.textContent.toLowerCase() || "";
    if (name.includes("creator")) return "creator";
    if (name.includes("dj")) return "dj_pro";
    if (name.includes("label") || name.includes("agency")) return "label";
    return "free";
  }

  function wirePricing() {
    document.querySelectorAll(".pricing-card .btn").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const card = button.closest(".pricing-card");
        const planId = planIdFromCard(card);
        if (button.textContent.trim().toLowerCase().includes("contact")) {
          openContactForm("Label / Agency");
          return;
        }
        try {
          await requireAuthenticated("signup");
          const checkout = await api("/api/billing/checkout", {
            method: "POST",
            body: JSON.stringify({ planId })
          });
          if (checkout.checkoutUrl) {
            window.location.href = checkout.checkoutUrl;
          } else {
            const message = checkout.diagnostic
              ? `${checkout.message} ${checkout.diagnostic}`
              : checkout.message || `${checkout.plan.name} plan selected.`;
            showActionResult(message, { type: checkout.mode === "demo" ? "warning" : "success", durationMs: 12000 });
          }
        } catch (error) {
          toast(error.message);
        }
      });
    });
  }

  function wireAuthLinks() {
    document.querySelectorAll("a").forEach((link) => {
      if (link.closest(".pricing-card")) {
        return;
      }
      const text = link.textContent.trim().toLowerCase();
      if (text === "log in") {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          loginWithPrompt();
        });
      }
      if (text.includes("start free") || text.includes("start creating free") || text.includes("get started")) {
        link.addEventListener("click", async (event) => {
          if (link.getAttribute("href") === "#studio") {
            return;
          }
          event.preventDefault();
          openAuthModal("signup");
        });
      }
    });
  }

  function wireFooterLinks() {
    const routes = {
      "everyday mode": "#modes",
      "creator mode": "#modes",
      "dj mode": "#modes",
      "beat marketplace": "#community",
      "pricing": "#pricing",
      "explore mixes": "#community",
      "beat store": "#community",
      "creator profiles": "#community",
      "api docs": "/api/health"
    };

    document.querySelectorAll(".footer a").forEach((link) => {
      const text = link.textContent.trim().toLowerCase();
      if (text === "contact") {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          openContactForm("General");
        });
        return;
      }
      if (routes[text]) {
        link.setAttribute("href", routes[text]);
      } else if (link.getAttribute("href") === "#") {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          toast(`${link.textContent.trim()} page is queued for production content.`);
        });
      }
    });
  }

  async function boot() {
    addStyle();
    wireHashNavigation();
    wireAuthLinks();
    wireRecordingButtons();
    wireBeatBrowser();
    wireMashup();
    wirePricing();
    wireFooterLinks();
    await hydrateBeats();

    try {
      await api("/api/health");
      setApiStatus("online", "API Online");
    } catch {
      setApiStatus("offline", "API Offline");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
