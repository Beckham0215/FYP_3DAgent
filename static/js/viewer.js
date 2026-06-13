(function () {
  const cfg = window.__3DAGENT__ || {};
  const mapId = cfg.mapId;
  const spaceId = cfg.spaceId || "";
  const sdkKey = cfg.sdkKey || "";

  const iframe = document.getElementById("matterport-iframe");
  const statusEl = document.getElementById("sdk-status");
  const logEl = document.getElementById("chat-log");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const voiceBtn = document.getElementById("voice-btn");
  const scanAreaBtn = document.getElementById("scan-area-btn");
  const autoTagBtn = document.getElementById("auto-tag-btn");
  const autoTagStatusEl = document.getElementById("auto-tag-status");
  const scanReviewPanel = document.getElementById("scan-review-panel");
  const scanReviewList = document.getElementById("scan-review-list");
  const scanLocationSelect = document.getElementById("scan-location-select");
  const scanAreaNameInput = document.getElementById("scan-area-name-input");
  const scanSaveBtn = document.getElementById("scan-save-btn");
  const scanCancelBtn = document.getElementById("scan-cancel-btn");
  const scanModePicker = document.getElementById("scan-mode-picker");
  const scanCurrentBtn = document.getElementById("scan-current-btn");
  const scanWholeAreaBtn = document.getElementById("scan-whole-area-btn");
  const scanCategorySelect = document.getElementById("scan-category-select");
  const scanModeCancelBtn = document.getElementById("scan-mode-cancel-btn");
  const scanQualityGroup = document.getElementById("scan-quality-group");

  // Scan quality/accuracy mode chosen in the picker. Drives how many 360° views
  // are captured (client) and how deep the detector runs (server).
  //   fast    → 4 views, YOLO only (no open-vocab pass)
  //   normal  → 6 views, YOLO + open-vocab hybrid (default)
  //   complex → 8 views, YOLO + open-vocab hybrid at lower thresholds
  let scanQualityMode = "normal";
  const SCAN_MODE_ANGLES = {
    fast:    [0, 90, 180, 270],
    normal:  [0, 60, 120, 180, 240, 300],
    complex: [0, 45, 90, 135, 180, 225, 270, 315],
  };
  function _scanStepAngles() {
    return SCAN_MODE_ANGLES[scanQualityMode] || SCAN_MODE_ANGLES.normal;
  }

  let sdk = null;
  let currentSweepUuid = null;
  let isScanning = false;
  let scanShouldStop = false;
  let isAutoTagging = false;
  let autoTagShouldStop = false;
  let pendingScanCounts = null;
  let selectedScanItems = {};
  let pendingScanSweepUuid = null; // sweep where current scan was initiated
  let scanResultTags = {};         // sweepUuid → {tagSids, counts, areaName, confirmed}
  let scanTagsVisible = false;
  let pendingScanViewData = [];    // [{angle, absolute_angle, sweep_uuid, objects, bboxes, image}]
  let pendingScanBaseRotation = { x: 0, y: 0 }; // base rotation at scan start
  let tightBboxCache = {};         // assetName → [x1,y1,x2,y2] — prominent (instance #1) bbox
  let instanceBboxCache = {};      // assetName → { angle, boxes:[[x1,y1,x2,y2],...] } — per-instance
  let _prefetchPromise = null;     // Promise returned by _prefetchTightBboxes — awaited before save
  const chatHistory = []; // [{role:"user"|"assistant", content}] — last 10 msgs

  // Minimap state
  let allSweepData    = {};  // sweepId → SDK sweep object
  let taggedSweepMap  = {};  // sweepId → {label_name, category}
  let floorDataMap    = {};  // floorId → {id, sequence, name}
  let currentFloorId  = null;
  let minimapCollapsed = false;
  let minimapPulse    = 0;   // 0..1 animation phase

  // Route state
  let activeRoute = null;    // {path:[uuid,...], target:uuid, label:string, step:number} | null
  let _routeAbort = false;   // set true to cancel in-progress route walk

  // --- Web Speech API Setup ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;

  if (!SpeechRecognition) {
    voiceBtn.style.display = "none";
    console.warn("[3DAgent] Web Speech API not supported in this browser");
  } else {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = function () {
      isListening = true;
      voiceBtn.classList.add("recording");
      voiceBtn.textContent = "⏹️";
      voiceBtn.title = "Click to stop recording";
      input.placeholder = "Listening...";
    };

    recognition.onresult = function (event) {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      input.value = transcript;
    };

    recognition.onerror = function (event) {
      console.error("[3DAgent] Speech recognition error:", event.error);
      appendLine("system", "Voice input error: " + event.error);
      isListening = false;
      voiceBtn.classList.remove("recording");
      voiceBtn.textContent = "🎤";
      voiceBtn.title = "Start voice input";
      input.placeholder = "Navigate, ask about the view, or chat…";
    };

    recognition.onend = function () {
      isListening = false;
      voiceBtn.classList.remove("recording");
      voiceBtn.textContent = "🎤";
      voiceBtn.title = "Start voice input";
      input.placeholder = "Navigate, ask about the view, or chat…";
    };

    voiceBtn.addEventListener("click", function (e) {
      e.preventDefault();
      if (isListening) {
        recognition.stop();
      } else {
        input.value = "";
        recognition.start();
      }
    });
  }

  function appendLine(role, text) {
    const div = document.createElement("div");
    div.className = "msg msg-" + role;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    if (role === "user" || role === "agent") {
      chatHistory.push({ role: role === "user" ? "user" : "assistant", content: text });
      if (chatHistory.length > 10) chatHistory.shift();
    }
  }

  function setStatus(text) {
    statusEl.textContent = text;
    console.log("[3DAgent SDK Status]", text);
  }

  // Load the local bundle showcase with the space parameters
  const showcaseParams = new URLSearchParams({
    m: spaceId,
    play: "1",
    qs: "1",
    log: "0"
  });
  if (sdkKey) {
    showcaseParams.set("applicationKey", sdkKey);
  }
  iframe.src = "/bundle/showcase.html?" + showcaseParams.toString();
  
  console.log("[3DAgent] Initializing viewer for spaceId:", spaceId);
  console.log("[3DAgent] SDK Key available:", !!sdkKey);
  console.log("[3DAgent] Loading local bundle at:", iframe.src);

  async function connectSdk() {
    if (!sdkKey) {
      setStatus("Set MATTERPORT_SDK_KEY in .env to enable navigation and screenshots.");
      console.warn("[3DAgent] MATTERPORT_SDK_KEY is not configured");
      return;
    }

    try {
      setStatus("Connecting to Matterport SDK...");
      console.log("[3DAgent] Attempting to connect to SDK in iframe...");

      // The iframe's contentWindow has the MP_SDK from the local bundle
      const showcaseWindow = iframe.contentWindow;
      
      if (!showcaseWindow.MP_SDK || typeof showcaseWindow.MP_SDK.connect !== "function") {
        console.error("[3DAgent] MP_SDK not available in iframe contentWindow");
        setStatus(
          "Matterport SDK not initialized.\n" +
          "Make sure /bundle/showcase.html exists and the bundle is complete."
        );
        return;
      }

      console.log("[3DAgent] MP_SDK found, connecting...");
      sdk = await showcaseWindow.MP_SDK.connect(showcaseWindow);
      
      // --- UPDATED SWEEP TRACKING USING OBSERVABLES ---
      try {
        sdk.Sweep.current.subscribe(function (sweep) {
          if (sweep && sweep.sid) {
            currentSweepUuid = sweep.sid;
            _updateSweepDisplay();
          }
        });
      } catch (e) {
        console.warn("[3DAgent] Error subscribing to sweep observable:", e);
      }
      // ------------------------------------------------

      setStatus("✓ SDK connected - you can navigate and use vision.");
      console.log("[3DAgent] ✓ SDK successfully connected");
      initMinimap().catch(function (e) { console.warn("[3DAgent] Minimap init failed:", e); });

      // Deep-link: a maintenance report can open the viewer at
      // ?goto=<sweep_uuid>&hl=<equipment_name> so a manager/mechanic lands on
      // the reported location AND the faulty asset is outlined automatically.
      try {
        var _params = new URLSearchParams(window.location.search);
        var _goto = _params.get("goto");
        var _hl = _params.get("hl");
        if (_goto) {
          appendLine("system", "📍 Navigating to the reported equipment…");
          setTimeout(function () {
            handleNavigate(_goto);
            if (_hl) { setTimeout(function () { _highlightReportedAsset(_goto, _hl); }, 1600); }
          }, 3500);
        }
      } catch (e) { /* no-op */ }
    } catch (e) {
      console.error("[3DAgent] Connection error:", e);
      const msg = e && e.message ? e.message : String(e);
      setStatus("SDK connect failed: " + msg + "\n\nCheck browser console for details.");
    }
  }

  iframe.addEventListener("load", function () {
    console.log("[3DAgent] Showcase iframe loaded, connecting to SDK...");
    setTimeout(() => {
      connectSdk();
    }, 500); // Small delay to ensure showcase is fully initialized
  });

  async function captureViewportBase64() {
    if (!sdk || !sdk.Renderer) {
      throw new Error("SDK not ready for screenshots.");
    }

    try {
      // Match screenshot resolution to the actual viewer size so that
      // normalized bbox coordinates from the vision model map correctly.
      const W = iframe.offsetWidth  || 1280;
      const H = iframe.offsetHeight || 720;
      const resolution = { width: W, height: H };
      const visibility = { measurements: true, mattertags: true, sweeps: true, views: true };

      console.log(`[3DAgent] Capturing screenshot at ${W}x${H}…`);
      let imgStr = await sdk.Renderer.takeScreenShot(resolution, visibility);

      if (!imgStr || imgStr.length < 1000) {
        console.warn("[3DAgent] Screenshot looks too small, trying equirectangular fallback");
        try {
          imgStr = await sdk.Renderer.takeEquirectangular();
          console.log("[3DAgent] Equirectangular screenshot taken");
        } catch (e) {
          console.warn("[3DAgent] Equirectangular fallback failed:", e);
        }
      }

      if (!imgStr) {
        throw new Error("Failed to capture screenshot");
      }

      // Ensure it's in data URL format
      if (typeof imgStr === "string") {
        if (imgStr.startsWith("data:")) {
          return imgStr;
        }
        return "data:image/jpeg;base64," + imgStr;
      }

      if (imgStr && imgStr.url) {
        return imgStr.url;
      }

      throw new Error("Unexpected screenshot format from Matterport SDK.");
    } catch (e) {
      console.error("[3DAgent] Screenshot capture error:", e);
      throw e;
    }
  }

  async function postVla(body) {
    // Attach all history except the current user message (last entry)
    if (!body.history) {
      body.history = chatHistory.slice(0, -1);
    }
    const res = await fetch("/api/vla", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(function () {
      return { ok: false, error: "Invalid JSON from server" };
    });
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || res.statusText);
    }
    return data;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Feature 1: Live Scan Overlay helpers ──────────────────────────────────

  const scanLiveOverlay  = document.getElementById("scan-live-overlay");
  const sloAngleLabel    = document.getElementById("slo-angle-label");
  const sloBadgesEl      = document.getElementById("slo-badges");

  function showLiveOverlay(viewIndex, totalViews, angleDeg, detectedObjects) {
    if (!scanLiveOverlay) return;
    if (sloAngleLabel) {
      sloAngleLabel.textContent = `View ${viewIndex}/${totalViews} — ${angleDeg}°`;
    }
    if (sloBadgesEl) {
      sloBadgesEl.innerHTML = "";
      const entries = Object.entries(detectedObjects || {})
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1]);
      entries.forEach(([name, count], idx) => {
        const badge = document.createElement("span");
        badge.className = "slo-badge";
        badge.style.animationDelay = (idx * 60) + "ms";
        badge.innerHTML = `<span class="slo-badge-name">${name}</span><span class="slo-badge-count">×${count}</span>`;
        sloBadgesEl.appendChild(badge);
      });
    }
    scanLiveOverlay.style.display = "block";
  }

  function clearLiveOverlay() {
    if (!scanLiveOverlay) return;
    scanLiveOverlay.style.display = "none";
    if (sloBadgesEl) sloBadgesEl.innerHTML = "";
  }

  // ── Centered agent loader (Auto-Tag / Scan) ───────────────────────────────
  const agentLoaderEl     = document.getElementById("agent-loader");
  const agentLoaderTitle  = document.getElementById("agent-loader-title");
  const agentLoaderStatus = document.getElementById("agent-loader-status");
  const agentLoaderBar    = document.getElementById("agent-loader-bar");
  const agentLoaderStop   = document.getElementById("agent-loader-stop");
  let   _agentLoaderStopFn = null;

  function setAgentLoaderProgress(pct) {
    if (!agentLoaderBar) return;
    const wrap = agentLoaderBar.parentElement;
    if (pct == null || isNaN(pct)) {
      if (wrap) wrap.classList.add("indeterminate");
      agentLoaderBar.style.width = "";
    } else {
      if (wrap) wrap.classList.remove("indeterminate");
      agentLoaderBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
  }
  function showAgentLoader(title, onStop) {
    if (!agentLoaderEl) return;
    if (agentLoaderTitle) agentLoaderTitle.textContent = title || "Working…";
    if (agentLoaderStatus) agentLoaderStatus.textContent = "";
    _agentLoaderStopFn = onStop || null;
    if (agentLoaderStop) agentLoaderStop.style.display = onStop ? "" : "none";
    setAgentLoaderProgress(null);
    agentLoaderEl.style.display = "flex";
  }
  function setAgentLoader(status, pct) {
    if (agentLoaderStatus && status != null) agentLoaderStatus.textContent = status;
    if (arguments.length > 1) setAgentLoaderProgress(pct);
  }
  function hideAgentLoader() {
    if (agentLoaderEl) agentLoaderEl.style.display = "none";
    _agentLoaderStopFn = null;
  }
  if (agentLoaderStop) {
    agentLoaderStop.addEventListener("click", function () {
      if (_agentLoaderStopFn) { _agentLoaderStopFn(); }
    });
  }

  // ── Feature 2: Scan Highlight Overlay helpers ─────────────────────────────

  const scanHighlightOverlay = document.getElementById("scan-highlight-overlay");
  const shoLabelEl           = document.getElementById("sho-label");
  const shoMarkerEl          = document.getElementById("sho-marker");
  const shoSvgEl             = document.getElementById("sho-svg");
  const shoPolyEl            = document.getElementById("sho-poly");
  const shoDismissBtn        = document.getElementById("sho-dismiss");
  let   _highlightToken      = 0;   // guards against stale async seg results

  if (shoDismissBtn) {
    shoDismissBtn.addEventListener("click", clearHighlightOverlay);
  }

  // label   : text shown to the user (e.g. "chair #2")
  // bbox    : [x1,y1,x2,y2] 0–1 hint from the scan, or null
  // opts    : { segName, instanceIndex } — segName is the bare object name used
  //           for segmentation; instanceIndex selects WHICH instance to outline.
  function showHighlightOverlay(label, bbox, opts) {
    if (!scanHighlightOverlay) return;
    opts = opts || {};
    const segName = opts.segName || label;
    const instanceIndex = (opts.instanceIndex != null) ? opts.instanceIndex : null;

    const token = ++_highlightToken;

    // Reset any previous edge outline; a provisional box shows first, the precise
    // per-instance outline replaces it once segmentation returns.
    if (shoSvgEl)  shoSvgEl.style.display = "none";
    if (shoPolyEl) shoPolyEl.setAttribute("points", "");
    if (shoLabelEl) shoLabelEl.textContent = `🔆 ${label} — locating…`;

    if (shoMarkerEl) {
      if (bbox && bbox.length === 4) {
        const W = iframe.offsetWidth  || 1280;
        const H = iframe.offsetHeight || 720;
        const left = bbox[0] * W, top = bbox[1] * H;
        const width = (bbox[2] - bbox[0]) * W, height = (bbox[3] - bbox[1]) * H;
        if (width > 10 && height > 10) {
          shoMarkerEl.style.left = left + "px";
          shoMarkerEl.style.top = top + "px";
          shoMarkerEl.style.width = width + "px";
          shoMarkerEl.style.height = height + "px";
          shoMarkerEl.style.display = "block";
        } else {
          shoMarkerEl.style.display = "none";
        }
      } else {
        shoMarkerEl.style.display = "none";
      }
    }

    scanHighlightOverlay.style.display = "block";
    _refineHighlightWithSeg(segName, bbox, token, instanceIndex, label);
  }

  // Capture the current viewport and ask the segmentation model to outline the
  // requested instance precisely. The stored bbox disambiguates which instance;
  // failing that, instanceIndex picks the Nth (left-to-right) so #1 and #2 never
  // resolve to the same object.
  async function _refineHighlightWithSeg(segName, bboxHint, token, instanceIndex, displayLabel) {
    displayLabel = displayLabel || segName;
    try {
      if (!sdk || !sdk.Renderer || !shoSvgEl || !shoPolyEl) return;
      const image = await captureViewportBase64();
      const res = await fetch("/api/segment-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          image,
          object_name: segName,
          bbox: bboxHint || null,
          instance_index: (instanceIndex != null) ? instanceIndex : null,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false }));

      // Bail if the user dismissed or triggered another highlight meanwhile.
      if (token !== _highlightToken) return;
      if (!scanHighlightOverlay || scanHighlightOverlay.style.display === "none") return;

      if (data.ok && Array.isArray(data.polygon) && data.polygon.length >= 3) {
        const pts = data.polygon.map((p) => `${(+p[0]).toFixed(4)},${(+p[1]).toFixed(4)}`).join(" ");
        shoPolyEl.setAttribute("points", pts);
        shoSvgEl.style.display = "block";
        if (shoMarkerEl) shoMarkerEl.style.display = "none";  // outline is tighter than the box
        const totalTxt = (data.total > 1) ? ` (of ${data.total})` : "";
        if (shoLabelEl) shoLabelEl.textContent = `🔆 ${displayLabel} — outlined${totalTxt}`;
        return;
      }

      // The object is visible but the requested instance isn't in this view —
      // be honest rather than outline the wrong one.
      if (data.reason === "instance_not_visible") {
        if (shoMarkerEl) shoMarkerEl.style.display = "none";
        if (shoSvgEl) shoSvgEl.style.display = "none";
        if (shoLabelEl) shoLabelEl.textContent = `🔆 ${displayLabel} — not visible from this view`;
        return;
      }

      // Segmentation found nothing: keep the stored box if we have one.
      if (shoMarkerEl && shoMarkerEl.style.display !== "none") {
        if (shoLabelEl) shoLabelEl.textContent = `🔆 ${displayLabel} — highlighted`;
      } else if (shoLabelEl) {
        shoLabelEl.textContent = `🔆 ${displayLabel} — couldn't outline (try moving closer)`;
      }
    } catch (e) {
      if (shoMarkerEl && shoMarkerEl.style.display !== "none" && shoLabelEl) {
        shoLabelEl.textContent = `🔆 ${displayLabel} — highlighted`;
      }
    }
  }

  function clearHighlightOverlay() {
    _highlightToken++;
    if (scanHighlightOverlay) scanHighlightOverlay.style.display = "none";
    if (shoMarkerEl) shoMarkerEl.style.display = "none";
    if (shoSvgEl)  shoSvgEl.style.display = "none";
    if (shoPolyEl) shoPolyEl.setAttribute("points", "");
  }

  async function postScanAsset(body) {
    const res = await fetch("/api/scan-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(function () {
      return { ok: false, error: "Invalid JSON from server" };
    });
    if (!res.ok || data.ok === false) {
      console.error("[3DAgent] Scan API error:", data);
      throw new Error(data.error || res.statusText);
    }
    console.log("[3DAgent] Scan API response:", data);
    return data;
  }

  async function saveScanSummary(assetCounts, areaName) {
    const res = await fetch("/api/scan-assets/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        map_id: mapId,
        area_name: areaName || null,
        asset_counts: assetCounts,
      }),
    });
    const data = await res.json().catch(function () {
      return { ok: false, error: "Invalid JSON from server" };
    });
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || res.statusText);
    }
    return data;
  }

  async function getCurrentRotation() {
    if (!sdk || !sdk.Camera || !sdk.Camera.pose || !sdk.Camera.pose.subscribe) {
      return { x: 0, y: 0 };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (rotation) => {
        if (!settled) {
          settled = true;
          resolve(rotation || { x: 0, y: 0 });
        }
      };

      try {
        const sub = sdk.Camera.pose.subscribe((pose) => {
          const rotation = (pose && pose.rotation) || {};
          const x = Number(rotation.x);
          const y = Number(rotation.y);
          if (typeof sub?.unsubscribe === "function") sub.unsubscribe();
          finish({
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
          });
        });

        setTimeout(() => {
          if (typeof sub?.unsubscribe === "function") sub.unsubscribe();
          finish({ x: 0, y: 0 });
        }, 1000);
      } catch (err) {
        console.warn("[3DAgent] Failed reading camera rotation:", err);
        finish({ x: 0, y: 0 });
      }
    });
  }

  async function rotateToYawAtCurrentSweep(yawDeg, pitchDeg) {
    if (!sdk || !sdk.Sweep || !currentSweepUuid) {
      throw new Error("Sweep is not ready.");
    }

    const transitionEnum = sdk.Sweep.Transition || {};
    const instant = transitionEnum.INSTANT || transitionEnum.FLY || undefined;

    await sdk.Sweep.moveTo(currentSweepUuid, {
      transition: instant,
      transitionTime: 350,
      rotation: { x: pitchDeg, y: yawDeg },
    });
    await sleep(450);
  }

  function mergeViewDetections(viewSightings, detectedCounts) {
    // Merge object counts from this view into overall sightings.
    // detectedCounts is now a dict like {"chair": 8, "table": 2, ...}
    // We track all counts per view to calculate max/mode later
    if (!detectedCounts || typeof detectedCounts !== "object") return;
    
    Object.keys(detectedCounts).forEach((name) => {
      const count = detectedCounts[name];
      if (name && count > 0) {
        if (!viewSightings[name]) {
          viewSightings[name] = [];
        }
        viewSightings[name].push(count);
      }
    });
  }

  // Highlight one scan asset. instanceIndex null → the prominent (whole-asset)
  // box; a number → that specific instance's box (asset #i). Both rotate to the
  // best view and draw the YOLO bbox cached at scan time — no API call.
  async function _highlightScanAsset(assetName, instanceIndex) {
    if (!pendingScanViewData.length) return;
    const insts  = (instanceBboxCache[assetName] && instanceBboxCache[assetName].instances) || [];
    const hasIdx = instanceIndex != null && !Number.isNaN(instanceIndex);
    const inst   = hasIdx ? (insts[instanceIndex] || null) : (insts[0] || null);
    const label  = hasIdx ? `${assetName} #${instanceIndex + 1}` : assetName;

    clearHighlightOverlay();
    if (shoLabelEl) shoLabelEl.textContent = `🔍 ${label} — locating…`;
    if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";

    if (inst) {
      // Cached box from the scan → fly to the exact sweep + camera angle it was
      // seen at, then outline (camera is genuinely looking at the object).
      if (inst.sweep_uuid && inst.sweep_uuid !== currentSweepUuid) {
        await handleNavigate(inst.sweep_uuid);
        await sleep(1200);
      }
      try { await rotateToYawAtCurrentSweep(inst.angle || 0, inst.pitch || 0); } catch (_) {}
      showHighlightOverlay(label, inst.bbox, { segName: assetName });
      return;
    }

    // No cached box: Scout named this item (so the count is real) but the
    // scan-time box pass didn't localise it (e.g. an open-vocab item in normal/
    // fast mode). Fly to the frame where Scout saw it best and locate it LIVE so
    // it can still be outlined — this is what guarantees every listed item is
    // outline-able, not just the COCO ones.
    if (shoLabelEl) shoLabelEl.textContent = `🔍 ${label} — flying in to find it…`;
    const located = await _liveLocateScanAsset(assetName, label);
    if (!located && shoLabelEl) {
      shoLabelEl.textContent = `🔍 ${label} — couldn't outline it from any captured view. Try a Complex-mode re-scan.`;
    }
  }

  // Live, on-demand localisation for a scanned item that has no cached box.
  // Returns true if it outlined the item. Caches the box so the next click is
  // instant.
  async function _liveLocateScanAsset(assetName, label) {
    // The captured frame where Scout saw the most of this item is our best shot.
    let best = null, bestN = 0;
    pendingScanViewData.forEach((v) => {
      const c = (v.objects && v.objects[assetName]) || 0;
      if (c > bestN) { bestN = c; best = v; }
    });
    if (!best) return false;
    try {
      if (best.sweep_uuid && best.sweep_uuid !== currentSweepUuid) {
        await handleNavigate(best.sweep_uuid);
        await sleep(1200);
      }
      const ang = (best.absolute_angle != null ? best.absolute_angle : (best.angle || 0));
      try { await rotateToYawAtCurrentSweep(ang, best.pitch || 0); } catch (_) {}
      await sleep(300);
      const img = await captureViewportBase64();
      const res = await fetch("/api/locate-object", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ object_name: assetName, image_base64: img }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (data.ok && Array.isArray(data.bbox) && data.bbox.length === 4) {
        const instObj = { sweep_uuid: best.sweep_uuid || null, angle: ang, pitch: best.pitch || 0, bbox: data.bbox };
        instanceBboxCache[assetName] = instanceBboxCache[assetName] || { instances: [] };
        instanceBboxCache[assetName].instances = [instObj];
        tightBboxCache[assetName] = data.bbox;
        showHighlightOverlay(label, data.bbox, { segName: assetName });
        return true;
      }
    } catch (e) {
      console.warn("[3DAgent] live locate failed:", e);
    }
    return false;
  }

  // Outline a faulty asset referenced by a maintenance report's equipment name
  // (e.g. "Chair #2"). Looks up the scanned asset row for its exact angle + box,
  // then highlights that specific instance. Used by the ?goto&hl deep-link from
  // the maintenance "Inspect Problem Equipment" list.
  async function _highlightReportedAsset(sweepUuid, equipmentName) {
    try {
      const m = String(equipmentName || "").match(/^(.*?)\s*#(\d+)\s*$/);
      const base = (m ? m[1] : (equipmentName || "")).trim();
      const serial = m ? parseInt(m[2], 10) : null;
      if (!base) return;

      let match = null;
      try {
        const res = await fetch(`/api/spaces/${mapId}/assets-panel`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        const summaries = (data && data.scan_summaries) || [];
        const sameName = s => (s.asset_name || "").toLowerCase() === base.toLowerCase();
        const sameSerial = s => (serial == null) || (s.serial_number === serial);
        match = summaries.find(s => sameName(s) && sameSerial(s) && (!sweepUuid || s.sweep_uuid === sweepUuid))
             || summaries.find(s => sameName(s) && sameSerial(s));
      } catch (_) {}

      const label = serial ? `${base.charAt(0).toUpperCase() + base.slice(1)} #${serial}` : base;
      if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
      if (match) {
        if (match.best_angle != null) { try { await rotateToYawAtCurrentSweep(match.best_angle, 0); } catch (_) {} }
        showHighlightOverlay(label, match.bbox, { segName: base, instanceIndex: (serial || 1) - 1 });
      } else {
        showHighlightOverlay(label, null, { segName: base, instanceIndex: serial != null ? serial - 1 : null });
      }
      appendLine("system", "🔧 Outlining reported equipment: " + label + ".");
    } catch (e) { /* no-op */ }
  }

  function renderScanReview(counts) {
    if (!scanReviewPanel || !scanReviewList) return;

    // Normalize: counts values can be numbers OR {count, viewsDetected, ...}
    const normalized = {};
    Object.entries(counts || {}).forEach(([asset, val]) => {
        normalized[asset] = (typeof val === 'object' && val !== null) ? val.count : val;
    });

     const entries = Object.entries(normalized)
        .filter(([, count]) => count > 0)
        .sort((a, b) => a[0].localeCompare(b[0]));

    
    if (!entries.length) {
      scanReviewList.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">No assets detected.</div>';
    } else {
      // Initialize all items as editable
      selectedScanItems = {};
      entries.forEach(([asset, count]) => {
        selectedScanItems[asset] = parseInt(count) || 0;
      });

      scanReviewList.innerHTML = entries
        .map(([asset, count]) => {
          const numCount = parseInt(count) || count;
          const hasViewData = pendingScanViewData.length > 0;
          const expandable = hasViewData && numCount > 1;
          return `
          <div class="scan-review-group" data-asset="${asset}">
            <div class="scan-review-item" data-asset="${asset}">
              <div class="scan-item-label">
                ${expandable ? `<button type="button" class="scan-expand-btn" data-asset="${asset}" title="List each ${asset} individually">▸</button>` : ""}
                <span class="scan-item-name${hasViewData ? " scan-item-clickable" : ""}" data-asset="${asset}">${asset}</span>
                ${counts[asset] && counts[asset].viewsDetected != null
                  ? `<span class="scan-item-confidence">${counts[asset].viewsDetected}/${counts[asset].totalViews || 6} views</span>`
                  : ""}
              </div>
              <div class="scan-item-controls">
                <button type="button" class="scan-item-btn-minus" title="Decrease count">−</button>
                <input
                  type="number"
                  class="scan-item-count-input"
                  value="${numCount}"
                  min="0"
                  max="999"
                  data-asset="${asset}"
                >
                <button type="button" class="scan-item-btn-plus" title="Increase count">+</button>
                <button type="button" class="scan-item-btn-delete" title="Remove item">✕</button>
              </div>
            </div>
            <div class="scan-instance-list" data-asset="${asset}" style="display:none;"></div>
          </div>
        `})
        .join("");

      // Add event listeners for editing
      scanReviewList.querySelectorAll(".scan-item-count-input").forEach((input) => {
        input.addEventListener("change", function () {
          const asset = this.dataset.asset;
          const newCount = parseInt(this.value) || 0;
          selectedScanItems[asset] = newCount;
          if (newCount <= 0) {
            this.closest(".scan-review-item").style.opacity = "0.5";
          } else {
            this.closest(".scan-review-item").style.opacity = "1";
          }
        });
        input.addEventListener("input", function () {
          const asset = this.dataset.asset;
          selectedScanItems[asset] = parseInt(this.value) || 0;
        });
      });

      // Plus button
      scanReviewList.querySelectorAll(".scan-item-btn-plus").forEach((btn) => {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          const item = this.closest(".scan-review-item");
          const input = item.querySelector(".scan-item-count-input");
          const currentValue = parseInt(input.value) || 0;
          input.value = currentValue + 1;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });

      // Minus button
      scanReviewList.querySelectorAll(".scan-item-btn-minus").forEach((btn) => {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          const item = this.closest(".scan-review-item");
          const input = item.querySelector(".scan-item-count-input");
          const currentValue = parseInt(input.value) || 0;
          if (currentValue > 0) {
            input.value = currentValue - 1;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      });

      // Delete button — removes the whole group (item + instance list)
      scanReviewList.querySelectorAll(".scan-item-btn-delete").forEach((btn) => {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          const group = this.closest(".scan-review-group");
          const asset = group.dataset.asset;
          group.remove();
          delete selectedScanItems[asset];
        });
      });

      // Click asset name → highlight the prominent instance (no API call).
      scanReviewList.querySelectorAll(".scan-item-clickable").forEach((nameEl) => {
        nameEl.addEventListener("click", () => _highlightScanAsset(nameEl.dataset.asset, null));
      });

      // Expand button → list each instance (asset #1 … #N) with its own highlight.
      scanReviewList.querySelectorAll(".scan-expand-btn").forEach((btn) => {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          const asset = this.dataset.asset;
          const group = this.closest(".scan-review-group");
          const list  = group.querySelector(".scan-instance-list");
          if (!list) return;

          if (list.style.display !== "none") {
            list.style.display = "none";
            this.textContent = "▸";
            return;
          }

          // Build rows from the CURRENT (possibly edited) count.
          const input = group.querySelector(".scan-item-count-input");
          const count = Math.max(0, parseInt(input && input.value) || 0);
          const cacheInsts = (instanceBboxCache[asset] && instanceBboxCache[asset].instances) || [];

          let rows = "";
          for (let i = 0; i < count; i++) {
            const hasBox = !!cacheInsts[i];
            rows += `<div class="scan-instance-row">
              <span class="scan-instance-label">${asset} #${i + 1}${hasBox ? "" : " <span class='scan-instance-noloc'>(approx.)</span>"}</span>
              <button type="button" class="scan-instance-hl" data-asset="${asset}" data-index="${i}" title="Highlight ${asset} #${i + 1}">🔆</button>
            </div>`;
          }
          list.innerHTML = rows || `<div class="scan-instance-empty">No instances.</div>`;
          list.querySelectorAll(".scan-instance-hl").forEach((hb) => {
            hb.addEventListener("click", () =>
              _highlightScanAsset(hb.dataset.asset, parseInt(hb.dataset.index)));
          });
          list.style.display = "block";
          this.textContent = "▾";
        });
      });
    }

    scanReviewPanel.style.display = "flex";
    try { scanReviewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_) {}
  }

  function formatCountsForChat(counts) {
    const entries = Object.entries(counts || {})
      .map(([asset, data]) => {
        const isObj = typeof data === "object" && data !== null;
        const count = isObj ? (data.count || 0) : data;
        const detected = isObj ? (data.viewsDetected || 1) : 1;
        const total = isObj ? (data.totalViews || 6) : 6;
        return [asset, count, detected, total];
      })
      .sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
      return "No assets detected in this 360 scan.";
    }
    return entries.map(([asset, count, detected, total]) =>
      `${asset}: ${count} (seen in ${detected}/${total} views)`
    ).join(", ");
  }

  // Build per-instance highlight records from the YOLO boxes captured during the
  // scan. CRITICAL for whole-area scans: each instance must remember the SWEEP and
  // the ABSOLUTE camera angle it was seen at, otherwise the highlighter rotates the
  // wrong sweep and outlines a wall. We take the best view PER SWEEP (most boxes)
  // and keep every box with its sweep/angle/pitch, ordered by prominence so #1 is
  // the clearest. instanceBboxCache[name] = { instances: [{sweep_uuid,angle,pitch,bbox}] }.
  function _prefetchTightBboxes(counts) {
    tightBboxCache = {};
    instanceBboxCache = {};

    const _absAngle = (v) => (v.absolute_angle != null ? v.absolute_angle : (v.angle || 0));

    Object.keys(counts || {}).forEach((name) => {
      // One representative box per distinct physical object (geometry-deduped),
      // so the highlightable instances line up with the de-duplicated count.
      const clusters = _clusterInstancesForName(name);
      let instances = clusters.map((c) => ({
        sweep_uuid: c.rep.sweep_uuid === "_" ? null : c.rep.sweep_uuid,
        angle: c.rep.angle,
        pitch: c.rep.pitch,
        bbox: c.rep.bbox,
      }));

      // Fallback: no per-instance boxes (e.g. Scout text path) → single primary
      // box from the view where it was seen the most.
      if (!instances.length) {
        let bestView = null, bestCount = -1;
        pendingScanViewData.forEach((v) => { const cc = (v.objects && v.objects[name]) || 0; if (cc > bestCount) { bestCount = cc; bestView = v; } });
        const single = (bestView && bestView.bboxes && bestView.bboxes[name]) || null;
        if (bestView && single) {
          instances.push({ sweep_uuid: bestView.sweep_uuid || null, angle: _absAngle(bestView), pitch: bestView.pitch || 0, bbox: single });
        }
      }

      // Clearest first so "#1" is the easiest to outline.
      instances.sort((a, b) => _bboxArea(b.bbox) - _bboxArea(a.bbox));
      instanceBboxCache[name] = { instances };
      tightBboxCache[name] = instances.length ? instances[0].bbox : null;
    });
    return Promise.resolve();
  }

  function hideScanReview() {
    if (!scanReviewPanel) return;
    scanReviewPanel.style.display = "none";
    pendingScanCounts = null;
    selectedScanItems = {};
    pendingScanViewData = [];
    tightBboxCache = {};
    instanceBboxCache = {};
    _prefetchPromise = null;
    if (scanAreaNameInput) scanAreaNameInput.value = "";
    if (scanLocationSelect) scanLocationSelect.value = "";
    clearHighlightOverlay();
  }

  async function loadScanLocations() {
    if (!scanLocationSelect) return;
    try {
      const res = await fetch(`/api/scan-assets/locations?map_id=${encodeURIComponent(mapId)}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || data.ok === false || !Array.isArray(data.locations)) {
        return;
      }

      scanLocationSelect.innerHTML = '<option value="">Select existing location...</option>';
      data.locations.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        scanLocationSelect.appendChild(opt);
      });
    } catch (err) {
      console.warn("[3DAgent] Could not load scan locations:", err);
    }
  }

  function setScanButtonState(scanning, progressText) {
    if (!scanAreaBtn) return;
    scanAreaBtn.disabled = false;
    scanAreaBtn.textContent = scanning ? (progressText || "⏹ Stop Scan") : "Scan Area";
  }

  // ── Feature 2: Auto-suggest location name from detected objects ──────────
  async function suggestLocationName(counts) {
    // Build plain-count dict for the API (strip view-count metadata)
    const plainCounts = {};
    Object.entries(counts || {}).forEach(([k, v]) => {
      plainCounts[k] = (typeof v === "object" && v !== null) ? v.count : v;
    });
    if (!Object.keys(plainCounts).length) return;

    try {
      const res = await fetch("/api/suggest-location-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ map_id: mapId, detected_objects: plainCounts }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.suggested_name) {
        // Pre-fill the area name input if it's still empty
        if (scanAreaNameInput && !scanAreaNameInput.value.trim()) {
          scanAreaNameInput.value = data.suggested_name;
        }
        appendLine("agent", `💡 Suggested location name: "${data.suggested_name}"`);
      }
    } catch (err) {
      console.warn("[3DAgent] suggestLocationName error:", err);
    }
  }

  // ── Feature 1: Auto-tag all sweeps in the space ───────────────────────────

  // Same room within this horizontal distance (metres) → reuse the neighbour's
  // exact label so one room keeps one name. Larger radius feeds the vision model
  // nearby names as context so even new areas stay consistent.
  const AUTOTAG_ROOM_RADIUS = 2.5;
  const AUTOTAG_NEARBY_RADIUS = 7.0;

  function _horizDist(ax, az, bx, bz) {
    const dx = ax - bx, dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // targetUuids: array of sweep uuids to tag, or null = every untagged sweep.
  async function autoTagLocations(targetUuids) {
    if (!sdk || !sdk.Sweep) {
      appendLine("system", "SDK not connected — cannot auto-tag.");
      return;
    }

    const targetSet = Array.isArray(targetUuids) ? new Set(targetUuids) : null;

    isAutoTagging = true;
    autoTagShouldStop = false;
    if (autoTagBtn) { autoTagBtn.disabled = false; var _atl0 = document.getElementById("auto-tag-label"); if (_atl0) _atl0.textContent = "Stop Auto-Tag"; }
    if (autoTagStatusEl) autoTagStatusEl.textContent = "Collecting sweeps…";
    showAgentLoader("🤖 Auto-tagging locations", function () { autoTagShouldStop = true; setAgentLoader("Stopping…"); });
    setAgentLoader("Collecting sweeps…", null);

    try {
      // Collect all sweeps from the SDK observable
      const allSweeps = await new Promise((resolve) => {
        const list = [];
        let sub;
        let stabilizeTimer = null;
        let safetyTimer = null;

        const done = () => {
          if (sub && typeof sub.unsubscribe === "function") sub.unsubscribe();
          if (stabilizeTimer) clearTimeout(stabilizeTimer);
          if (safetyTimer) clearTimeout(safetyTimer);
          resolve(list);
        };

        safetyTimer = setTimeout(done, 10000);

        const onNewSweeps = () => {
          if (stabilizeTimer) clearTimeout(stabilizeTimer);
          stabilizeTimer = setTimeout(() => { clearTimeout(safetyTimer); done(); }, 1500);
        };

        try {
          if (!sdk.Sweep || !sdk.Sweep.data || typeof sdk.Sweep.data.subscribe !== "function") {
            clearTimeout(safetyTimer);
            resolve([]);
            return;
          }
          sub = sdk.Sweep.data.subscribe((sweepMap) => {
            let added = false;
            Object.entries(sweepMap || {}).forEach(([uuid, info]) => {
              if (uuid && !list.find(s => s.uuid === uuid)) {
                list.push({ uuid, ...info });
                added = true;
              }
            });
            if (added) onNewSweeps();
          });
        } catch (e) {
          clearTimeout(safetyTimer);
          resolve([]);
        }
      });

      // Fallback: try sdk.Model.getData()
      if (!allSweeps.length && sdk.Model && typeof sdk.Model.getData === "function") {
        try {
          if (autoTagStatusEl) autoTagStatusEl.textContent = "Trying model data fallback…";
          const modelData = await sdk.Model.getData();
          if (modelData && Array.isArray(modelData.sweeps)) {
            modelData.sweeps.forEach((s) => {
              if (s.sid) allSweeps.push({ uuid: s.sid, ...s });
            });
          }
        } catch (e) {
          console.warn("[3DAgent] Model.getData() fallback failed:", e);
        }
      }

      if (!allSweeps.length) {
        appendLine("system", "No sweeps found. Wait for the viewer to fully load, then try again.");
        return;
      }

      // Fetch existing tags to skip already-tagged sweeps and continue category numbering
      const assetsRes = await fetch(`/api/spaces/${mapId}/assets`, { credentials: "same-origin" });
      const assetsData = await assetsRes.json().catch(() => ({ assets: [] }));
      const existingAssets = assetsData.assets || [];
      const taggedUuids = new Set(existingAssets.map(a => a.sweep_uuid));

      // Continue room numbering ("Office 2") and per-room sweep numbering
      // ("Office 1 #3") from any existing tags, and seed the spatial "placed"
      // list. baseLabel = the room name without the "#n" sweep suffix.
      const categoryCounters = {};    // category -> highest room number
      const roomSweepCounters = {};   // baseLabel -> highest sweep number
      const placed = [];              // {x, z, floorId, category, baseLabel, label}
      existingAssets.forEach(a => {
        const lbl = (a.label_name || "").trim();
        const sm = lbl.match(/^(.*?)\s*#(\d+)\s*$/);          // "<base> #<n>"
        const baseLabel = sm ? sm[1].trim() : lbl;
        if (sm) {
          roomSweepCounters[baseLabel] = Math.max(roomSweepCounters[baseLabel] || 0, parseInt(sm[2]));
        }
        const rm = baseLabel.match(/^(.*?)\s+(\d+)$/);        // "<category> <N>"
        if (rm) {
          const ck = rm[1].trim().toLowerCase();
          categoryCounters[ck] = Math.max(categoryCounters[ck] || 0, parseInt(rm[2]));
        } else {
          const cat = (a.category || "").trim().toLowerCase();
          if (cat) categoryCounters[cat] = Math.max(categoryCounters[cat] || 0, 1);
        }
        const sd = allSweepData[a.sweep_uuid];
        if (sd && sd.position) {
          placed.push({
            x: sd.position.x, z: sd.position.z,
            floorId: (sd.floorInfo || {}).id,
            category: (a.category || "").trim(),
            baseLabel: baseLabel,
            label: lbl,
          });
        }
      });

      let untagged = allSweeps.filter(s => !taggedUuids.has(s.uuid));
      if (targetSet) untagged = untagged.filter(s => targetSet.has(s.uuid));

      // Walk room-by-room: order by floor then position so spatially close
      // sweeps are processed together → labels propagate cleanly.
      untagged.sort((a, b) => {
        const pa = (allSweepData[a.uuid] || {}).position || {};
        const pb = (allSweepData[b.uuid] || {}).position || {};
        return (pa.x || 0) - (pb.x || 0) || (pa.z || 0) - (pb.z || 0);
      });

      const total = untagged.length;
      const scopeLabel = targetSet ? `${total} selected sweep(s)` : `${total} untagged`;
      appendLine("system", `Found ${allSweeps.length} sweep(s). Auto-tagging ${scopeLabel}…`);
      if (autoTagStatusEl) autoTagStatusEl.textContent = `0 / ${total} tagged`;
      setAgentLoader(`Tagging ${total} location(s)…`, 0);

      // Nearest already-placed point on the same floor, within `radius`.
      function _nearestPlaced(x, z, floorId, radius) {
        let best = null, bestD = radius;
        placed.forEach(p => {
          if (floorId != null && p.floorId != null && String(p.floorId) !== String(floorId)) return;
          const d = _horizDist(x, z, p.x, p.z);
          if (d <= bestD) { bestD = d; best = p; }
        });
        return best;
      }

      const taggedResults = [];   // every newly-tagged sweep (for the review modal)
      let tagged = 0;
      for (let i = 0; i < total; i++) {
        if (autoTagShouldStop) { appendLine("system", "⏹ Auto-tagging stopped by user."); break; }

        const sweep = untagged[i];
        const sd  = allSweepData[sweep.uuid] || {};
        const pos = sd.position || sweep.position || null;
        const floorId = (sd.floorInfo || sweep.floorInfo || {}).id;

        let category = null;
        let baseLabel = null;

        // 1) Very close to an already-named point on the same floor → SAME ROOM:
        //    reuse the room's base name (no camera move, no API call).
        const sameRoom = pos ? _nearestPlaced(pos.x, pos.z, floorId, AUTOTAG_ROOM_RADIUS) : null;
        if (sameRoom) {
          baseLabel = sameRoom.baseLabel;
          category = sameRoom.category;
          if (autoTagStatusEl) autoTagStatusEl.textContent = `Sweep ${i + 1} / ${total} (same room)…`;
          setAgentLoader(`Sweep ${i + 1} / ${total} — same room`, Math.round((i / total) * 100));
        } else {
          // 2) New area → travel there, look, and name it WITH nearby context so
          //    the model stays consistent rather than inventing a fresh name.
          if (autoTagStatusEl) autoTagStatusEl.textContent = `Visiting sweep ${i + 1} / ${total}…`;
          setAgentLoader(`Visiting sweep ${i + 1} / ${total}…`, Math.round((i / total) * 100));
          try {
            await sdk.Sweep.moveTo(sweep.uuid, { transition: sdk.Sweep.Transition.FLY, transitionTime: 1200 });
          } catch (navErr) {
            console.warn("[3DAgent] Auto-tag nav error:", navErr);
            continue;
          }
          await sleep(2200);
          if (autoTagShouldStop) { appendLine("system", "⏹ Auto-tagging stopped by user."); break; }

          const nearby = pos
            ? placed.filter(p => (floorId == null || p.floorId == null || String(p.floorId) === String(floorId)) &&
                                 _horizDist(pos.x, pos.z, p.x, p.z) <= AUTOTAG_NEARBY_RADIUS)
            : [];
          const nearbyBaseNames = Array.from(new Set(nearby.map(p => p.baseLabel)));

          let suggestion = null;
          try {
            const imageBase64 = await captureViewportBase64();
            const sugRes = await fetch("/api/suggest-location-name", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ map_id: mapId, image_base64: imageBase64, nearby_names: nearbyBaseNames }),
            });
            const sugData = await sugRes.json().catch(() => ({}));
            suggestion = sugData.suggested_name || null;
          } catch (e) {
            console.warn("[3DAgent] Suggest name error:", e);
          }

          if (!suggestion) {
            appendLine("system", `  Sweep ${i + 1}: could not identify area — skipping.`);
            continue;
          }

          // If the model named an existing nearby room, reuse that room;
          // otherwise it's a new room → assign a fresh numbered room name.
          const matchBase = nearbyBaseNames.find(b => b.toLowerCase() === suggestion.toLowerCase());
          if (matchBase) {
            baseLabel = matchBase;
            const mp = nearby.find(p => p.baseLabel === matchBase);
            category = mp ? mp.category : suggestion;
          } else {
            category = suggestion;
            const catKey = category.toLowerCase();
            categoryCounters[catKey] = (categoryCounters[catKey] || 0) + 1;
            baseLabel = `${category} ${categoryCounters[catKey]}`;
          }
        }

        // Every sweep gets a UNIQUE label within its room so none overwrite
        // each other — e.g. "Office 1 #1", "Office 1 #2".
        roomSweepCounters[baseLabel] = (roomSweepCounters[baseLabel] || 0) + 1;
        const label = `${baseLabel} #${roomSweepCounters[baseLabel]}`;

        try {
          const markRes = await fetch("/api/mark-asset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ map_id: mapId, asset_name: label, sweep_uuid: sweep.uuid, category: category || undefined }),
          });
          const markData = await markRes.json().catch(() => ({}));
          if (markData.ok) {
            tagged++;
            if (pos) placed.push({ x: pos.x, z: pos.z, floorId: floorId, category: category || "", baseLabel: baseLabel, label: label });
            taggedResults.push({
              asset_id: markData.asset_id, label: label, category: category || "",
              sweep_uuid: sweep.uuid, x: pos ? pos.x : null, z: pos ? pos.z : null, floorId: floorId,
            });
            appendLine("agent", `  ✓ Sweep ${i + 1}: "${label}"${sameRoom ? " (same room)" : ""}`);
          }
        } catch (e) {
          console.warn("[3DAgent] Mark asset error:", e);
        }

        if (autoTagStatusEl) autoTagStatusEl.textContent = `${tagged} / ${total} tagged`;
        setAgentLoader(`${tagged} / ${total} tagged`, Math.round(((i + 1) / total) * 100));
      }

      if (!autoTagShouldStop) {
        appendLine("agent", `✅ Auto-tagging complete. ${tagged} location(s) tagged.`);
      }
      if (autoTagStatusEl) autoTagStatusEl.textContent = autoTagShouldStop ? `Stopped — ${tagged} tagged` : `Done — ${tagged} tagged`;
      if (tagged > 0) await _refreshLocationData();
      if (taggedResults.length) openAutoTagResults(taggedResults);
    } catch (err) {
      console.error("[3DAgent] autoTagLocations error:", err);
      appendLine("system", "❌ Auto-tagging failed: " + (err.message || String(err)));
      if (autoTagStatusEl) autoTagStatusEl.textContent = "Error — see chat";
    } finally {
      isAutoTagging = false;
      autoTagShouldStop = false;
      hideAgentLoader();
      if (autoTagBtn) { autoTagBtn.disabled = false; var _atl1 = document.getElementById("auto-tag-label"); if (_atl1) _atl1.textContent = "Auto-Tag Locations"; }
    }
  }

  // ── Feature 4: ReAct multi-step verification loop ────────────────────────
  async function handleReactQuery(data) {
    appendLine("agent", `🧠 Reasoning: ${data.reasoning}`);

    if (!data.candidates || data.candidates.length === 0) {
      appendLine("agent", data.response || "No rooms in the database match the requirement. Scan some rooms first.");
      return;
    }

    const targetAsset = data.target_asset || "item";
    appendLine("system", `Found ${data.candidates.length} candidate room(s) in records. Navigating to verify current state…`);

    const results = [];
    for (const candidate of data.candidates) {
      appendLine("system", `🔍 Checking "${candidate.label}" (recorded: ${candidate.recorded_count} ${targetAsset}(s))…`);

      if (!candidate.sweep_uuid) {
        results.push({ ...candidate, status: "unverified", note: `"${candidate.label}" has no navigation tag — cannot physically verify` });
        appendLine("system", `  ⚠ No navigation tag for "${candidate.label}". Using recorded data only.`);
        continue;
      }

      // Navigate to the room
      await handleNavigate(candidate.sweep_uuid);
      await sleep(2500);

      // Capture viewport and verify
      try {
        const imageBase64 = await captureViewportBase64();
        const verifyRes = await fetch("/api/react-verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            map_id: mapId,
            label: candidate.label,
            target_asset: targetAsset,
            recorded_count: candidate.recorded_count,
            image_base64: imageBase64,
          }),
        });
        const vd = await verifyRes.json().catch(() => ({ ok: false }));
        results.push({ ...candidate, ...vd });
        appendLine("system", `  → ${vd.note || "checked"}`);
      } catch (err) {
        results.push({ ...candidate, status: "error", note: err.message });
        appendLine("system", `  ⚠ Verification error: ${err.message}`);
      }
    }

    // Final recommendation
    const okRooms       = results.filter(r => r.status === "ok");
    const degradedRooms = results.filter(r => r.status === "degraded");
    const unverified    = results.filter(r => r.status === "unverified");

    let report = `📊 Assessment — ${data.reasoning}\n`;
    if (okRooms.length) {
      report += `✅ Best option(s): ${okRooms.map(r => `${r.label} (${r.verified_count ?? r.recorded_count} ${targetAsset}s confirmed)`).join("; ")}\n`;
    }
    if (degradedRooms.length) {
      report += `⚠️  Possible (fewer than expected): ${degradedRooms.map(r => r.note).join("; ")}\n`;
    }
    if (unverified.length) {
      report += `📋 Unverified (from records only): ${unverified.map(r => `${r.label} (${r.recorded_count} ${targetAsset}s on record)`).join("; ")}\n`;
    }
    if (!okRooms.length && !degradedRooms.length && !unverified.length) {
      report += "❌ No rooms currently meet the requirements.\n";
    }

    appendLine("agent", report.trim());
  }

  // ── Scan mode picker helpers ──────────────────────────────────────────────

  async function showScanModePicker() {
    if (!scanModePicker) return;
    await loadScanCategories();
    scanModePicker.style.display = "flex";
  }

  function hideScanModePicker() {
    if (scanModePicker) scanModePicker.style.display = "none";
  }

  async function loadScanCategories() {
    if (!scanCategorySelect) return;
    try {
      const res = await fetch(`/api/spaces/${mapId}/assets`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({ assets: [] }));
      const categories = [...new Set(
        (data.assets || []).map(a => a.category).filter(c => c && c.trim())
      )].sort();
      scanCategorySelect.innerHTML = '<option value="">Select area to scan…</option>';
      categories.forEach(cat => {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        scanCategorySelect.appendChild(opt);
      });
    } catch (err) {
      console.warn("[3DAgent] Could not load scan categories:", err);
    }
  }

  // ── Build aggregated counts from per-view sightings ───────────────────────

  // ── Geometry-based instance de-duplication ───────────────────────────────
  // The same physical object is seen across several of the 6 overlapping views,
  // so a naive MAX-across-views undercounts objects spread around a room (3
  // chairs north + 3 chairs south reads as 3). Instead we project every detected
  // box to a world bearing (camera yaw + horizontal offset within the frame) and
  // cluster instances that fall at the same bearing in the same sweep — that
  // collapses re-sightings of one object while keeping genuinely distinct ones.
  const SCAN_HFOV_DEG        = 90;   // Matterport perspective horizontal FOV (~16:9)
  const SCAN_MERGE_ANGLE     = 20;   // same-sweep bearings within this (deg) = same object
  const SCAN_MERGE_SIZE_RATIO = 3.0; // boxes whose areas differ beyond this aren't merged

  function _norm360(d) { d %= 360; return d < 0 ? d + 360 : d; }
  function _angDiff(a, b) { const d = Math.abs(_norm360(a) - _norm360(b)) % 360; return d > 180 ? 360 - d : d; }
  function _bboxArea(b) { return (b && b.length === 4) ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0; }

  // Every detected box of `name` across all captured views, tagged with the world
  // bearing it sits at and which view it came from.
  function _gatherInstances(name) {
    const out = [];
    pendingScanViewData.forEach((v, vi) => {
      const boxes = (v.bboxes_all && v.bboxes_all[name]) || [];
      const abs = (v.absolute_angle != null ? v.absolute_angle : (v.angle || 0));
      boxes.forEach((bbox) => {
        if (!bbox || bbox.length !== 4) return;
        const cx = (bbox[0] + bbox[2]) / 2;
        out.push({
          sweep_uuid: v.sweep_uuid || "_",
          viewKey: (v.sweep_uuid || "_") + "#" + vi,
          angle: abs,
          pitch: v.pitch || 0,
          bbox,
          bearing: _norm360(abs + (cx - 0.5) * SCAN_HFOV_DEG),
          area: _bboxArea(bbox),
        });
      });
    });
    return out;
  }

  // Cluster the gathered instances into distinct physical objects. Each cluster's
  // representative is its largest (closest/clearest) box. Two boxes from the SAME
  // view are never merged, which guarantees the result is never below any single
  // view's count.
  function _clusterInstancesForName(name) {
    const items = _gatherInstances(name);
    if (!items.length) return [];
    items.sort((a, b) => b.area - a.area); // largest first → rep is the clearest box
    const clusters = [];
    items.forEach((it) => {
      let target = null;
      for (const c of clusters) {
        if (c.sweep !== it.sweep_uuid) continue;
        if (_angDiff(c.bearing, it.bearing) > SCAN_MERGE_ANGLE) continue;
        if (c.members.some((m) => m.viewKey === it.viewKey)) continue; // same frame → distinct
        const r = (it.area > 0 && c.rep.area > 0)
          ? Math.max(it.area / c.rep.area, c.rep.area / it.area) : 1;
        if (r > SCAN_MERGE_SIZE_RATIO) continue; // near vs far object at same bearing
        target = c;
        break;
      }
      if (target) target.members.push(it);
      else clusters.push({ sweep: it.sweep_uuid, bearing: it.bearing, rep: it, members: [it] });
    });
    return clusters;
  }

  function _buildCounts(sightings, totalViews) {
    const counts = {};
    Object.keys(sightings).forEach(name => {
      const viewCounts = sightings[name];
      const maxCount = Math.max(...viewCounts);
      if (maxCount > 0) {
        counts[name] = {
          count: maxCount,
          viewCounts,
          viewsDetected: viewCounts.filter(c => c > 0).length,
          totalViews,
        };
      }
    });
    return counts;
  }

  // ── Scan-result Mattertag overlay helpers ────────────────────────────────

  async function _placeScanTag(sweepUuid, areaName, counts, isConfirmed) {
    if (!sdk || !sdk.Mattertag) return;
    // Remove existing tag for this sweep
    const existing = scanResultTags[sweepUuid];
    if (existing && existing.tagSids && existing.tagSids.length) {
      try { await sdk.Mattertag.remove(existing.tagSids); } catch (_) {}
    }
    const sweepData = allSweepData[sweepUuid];
    if (!sweepData || !sweepData.position) {
      scanResultTags[sweepUuid] = { tagSids: [], counts, areaName, confirmed: isConfirmed };
      return;
    }
    const pos = sweepData.position;
    const label = (isConfirmed ? "✓ " : "📷 ") + (areaName || "Scan");
    const entries = Object.entries(counts || {})
      .map(function (kv) {
        var v = kv[1];
        return [kv[0], typeof v === "object" && v !== null ? (v.count || 0) : (parseInt(v) || 0)];
      })
      .filter(function (kv) { return kv[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 6);
    const desc = entries.length
      ? entries.map(function (kv) { return kv[0] + ": " + kv[1]; }).join("\n")
      : "Scanning…";
    const color = isConfirmed
      ? { r: 0.063, g: 0.639, b: 0.498 }
      : { r: 0.984, g: 0.749, b: 0.141 };
    try {
      const sids = await sdk.Mattertag.add({
        label: label,
        description: desc,
        anchorPosition: { x: pos.x, y: pos.y - 0.1, z: pos.z },
        stemVector: { x: 0, y: 0.4, z: 0 },
        color: color,
      });
      const sidList = Array.isArray(sids) ? sids : [sids];
      scanResultTags[sweepUuid] = { tagSids: sidList, counts, areaName, confirmed: isConfirmed };
    } catch (e) {
      console.warn("[3DAgent] Could not place scan tag:", e);
      scanResultTags[sweepUuid] = { tagSids: [], counts, areaName, confirmed: isConfirmed };
    }
  }

  async function _removeAllScanTags() {
    const allSids = Object.values(scanResultTags)
      .flatMap(function (t) { return t.tagSids || []; })
      .filter(Boolean);
    if (allSids.length && sdk && sdk.Mattertag) {
      try { await sdk.Mattertag.remove(allSids); } catch (_) {}
    }
    scanResultTags = {};
  }

  async function loadAndShowScanTags() {
    if (!sdk || !sdk.Mattertag) {
      appendLine("system", "SDK not ready — please wait for Matterport to connect.");
      return;
    }
    try {
      const [assetsRes, panelRes] = await Promise.all([
        fetch("/api/spaces/" + mapId + "/assets", { credentials: "same-origin" }),
        fetch("/api/spaces/" + mapId + "/assets-panel", { credentials: "same-origin" }),
      ]);
      const assetsData = await assetsRes.json().catch(function () { return { assets: [] }; });
      const panelData  = await panelRes.json().catch(function () { return { scan_summaries: [] }; });

      // label_name (lower-cased) → sweep_uuid
      const labelToSweep = {};
      (assetsData.assets || []).forEach(function (a) {
        if (a.label_name && a.sweep_uuid) labelToSweep[a.label_name.toLowerCase()] = a.sweep_uuid;
      });

      // Group scan rows by area_name → {assetName: count}
      const areaCountsMap = {};
      (panelData.scan_summaries || []).forEach(function (s) {
        if (!s.area_name) return;
        if (!areaCountsMap[s.area_name]) areaCountsMap[s.area_name] = {};
        if (s.asset_name && s.count > 0) areaCountsMap[s.area_name][s.asset_name] = s.count;
      });

      let placed = 0;
      for (const [areaName, counts] of Object.entries(areaCountsMap)) {
        const sweepUuid = labelToSweep[areaName.toLowerCase()];
        if (sweepUuid) {
          await _placeScanTag(sweepUuid, areaName, counts, true);
          placed++;
        }
      }
      if (placed === 0) {
        appendLine("system", "No confirmed scan data with matching tagged locations found. Scan an area and confirm first.");
      } else {
        appendLine("system", "Showing " + placed + " scanned area tag(s) in the 3D space.");
      }
    } catch (e) {
      console.warn("[3DAgent] Failed to load scan tags:", e);
      appendLine("system", "Could not load scan data: " + (e.message || String(e)));
    }
  }

  async function toggleScanTags() {
    scanTagsVisible = !scanTagsVisible;
    const btn = document.getElementById("show-scanned-btn");
    if (scanTagsVisible) {
      if (btn) { btn.style.color = "var(--accent-primary)"; var _l = document.getElementById("show-scanned-label"); if (_l) _l.textContent = "Hide Scanned"; }
      await loadAndShowScanTags();
    } else {
      if (btn) { btn.style.color = ""; var _l = document.getElementById("show-scanned-label"); if (_l) _l.textContent = "Show Scanned"; }
      await _removeAllScanTags();
      appendLine("system", "Scan highlights hidden.");
    }
  }

  // ── Main scan dispatcher ──────────────────────────────────────────────────

  async function scanArea(category) {
    if (!sdk || !sdk.Sweep || !currentSweepUuid) {
      appendLine("system", "SDK not connected — cannot scan yet.");
      return;
    }

    isScanning = true;
    scanShouldStop = false;
    setScanButtonState(true, "⏹ Stop Scan");
    showAgentLoader("📷 Scanning area", function () { scanShouldStop = true; setAgentLoader("Stopping…"); });
    setAgentLoader("Preparing scan…", null);

    try {
      if (category) {
        await scanWholeArea(category);
      } else {
        await scanCurrentSweep();
      }
    } catch (err) {
      console.error("[3DAgent] Area scan error:", err);
      appendLine("system", "❌ Scan failed: " + (err.message || String(err)));
    } finally {
      isScanning = false;
      scanShouldStop = false;
      hideAgentLoader();
      setScanButtonState(false);
    }
  }

  // ── Scan current sweep only (6-angle 360°) ────────────────────────────────

  async function scanCurrentSweep() {
    const areaName = (
      (scanAreaNameInput && scanAreaNameInput.value.trim()) ||
      (scanLocationSelect && scanLocationSelect.value.trim()) ||
      ""
    );

    const scanMode = scanQualityMode;
    const stepAngles = _scanStepAngles();
    appendLine("system", `📸 Starting 360° scan${areaName ? " of " + areaName : ""}… (${scanMode} mode, ${stepAngles.length} angles)`);
    const baseRotation = await getCurrentRotation();
    pendingScanBaseRotation = baseRotation;
    const sightings = {};
    pendingScanViewData = [];

    for (let i = 0; i < stepAngles.length; i++) {
      if (scanShouldStop) { appendLine("system", "⏹ Scan stopped."); clearLiveOverlay(); break; }
      const yaw = (baseRotation.y || 0) + stepAngles[i];
      clearLiveOverlay();
      appendLine("system", `📷 View ${i + 1}/${stepAngles.length}: ${stepAngles[i]}°…`);
      await rotateToYawAtCurrentSweep(yaw, baseRotation.x || 0);
      appendLine("system", `🤖 Analyzing view ${i + 1}/${stepAngles.length}…`);
      setAgentLoader(`Analyzing view ${i + 1} / ${stepAngles.length}…`, Math.round((i / stepAngles.length) * 100));
      const imageBase64 = await captureViewportBase64();
      const scanResult = await postScanAsset({
        map_id: mapId,
        sweep_uuid: currentSweepUuid,
        image_base64: imageBase64,
        area_name: areaName || undefined,
        mode: scanMode,
      });
      mergeViewDetections(sightings, scanResult.objects || {});
      pendingScanViewData.push({
        angle: stepAngles[i],
        absolute_angle: (baseRotation.y || 0) + stepAngles[i],
        pitch: baseRotation.x || 0,
        sweep_uuid: currentSweepUuid,
        objects: scanResult.objects || {},
        bboxes: scanResult.positions || {},
        bboxes_all: scanResult.positions_all || {},
        image: imageBase64,
      });
      showLiveOverlay(i + 1, stepAngles.length, stepAngles[i], scanResult.objects || {});
    }

    clearLiveOverlay();
    // Counts come from Scout (per-frame), aggregated as MAX across the views —
    // this avoids the geometry-dedup overcounting that turned 1 bed into several.
    const counts = _buildCounts(sightings, stepAngles.length);
    pendingScanSweepUuid = currentSweepUuid;
    _prefetchPromise = _prefetchTightBboxes(counts);  // boxes for highlighting only
    pendingScanCounts = counts;
    renderScanReview(counts);
    appendLine("agent", `✅ Scan complete. ${formatCountsForChat(counts)}`);
    appendLine("system", "Review detected items below, then click 'Add to assets'.");
    // Show a pending (yellow) tag at this sweep so user sees what was detected
    await _placeScanTag(currentSweepUuid, areaName || "Current Scan", counts, false);
    await suggestLocationName(counts);
  }

  // ── Scan all sweeps belonging to a tagged category ────────────────────────

  async function scanWholeArea(category) {
    const res = await fetch(`/api/spaces/${mapId}/assets`, { credentials: "same-origin" });
    const data = await res.json().catch(() => ({ assets: [] }));
    const sweeps = (data.assets || []).filter(
      a => a.category && a.category.toLowerCase() === category.toLowerCase() && a.sweep_uuid
    );

    if (!sweeps.length) {
      appendLine("system", `No tagged sweeps found for "${category}". Run Auto-Tag first.`);
      return;
    }

    const scanMode = scanQualityMode;
    const stepAngles = _scanStepAngles();
    appendLine("system", `🔍 Scanning ${sweeps.length} sweep(s) in "${category}"… (${scanMode} mode, ${stepAngles.length} angles each)`);
    const aggregatedSightings = {};

    for (let i = 0; i < sweeps.length; i++) {
      if (scanShouldStop) { appendLine("system", "⏹ Scan stopped."); break; }

      const sweep = sweeps[i];
      setScanButtonState(true, `⏹ Stop (${i + 1}/${sweeps.length})`);
      appendLine("system", `📍 ${sweep.label_name || sweep.sweep_uuid} (${i + 1}/${sweeps.length})…`);
      setAgentLoader(`Scanning ${sweep.label_name || "sweep"} (${i + 1} / ${sweeps.length})…`, Math.round((i / sweeps.length) * 100));

      await handleNavigate(sweep.sweep_uuid);
      await sleep(2200);

      // Place a "scanning…" placeholder tag at this sweep
      await _placeScanTag(sweep.sweep_uuid, sweep.label_name || category, {}, false);

      const sweepLocalSightings = {};
      const baseRotation = await getCurrentRotation();
      for (let ai = 0; ai < stepAngles.length; ai++) {
        const angle = stepAngles[ai];
        if (scanShouldStop) break;
        const yaw = (baseRotation.y || 0) + angle;
        clearLiveOverlay();
        await rotateToYawAtCurrentSweep(yaw, baseRotation.x || 0);
        const imageBase64 = await captureViewportBase64();
        const scanResult = await postScanAsset({
          map_id: mapId,
          sweep_uuid: sweep.sweep_uuid,
          image_base64: imageBase64,
          area_name: category,
          mode: scanMode,
        });
        mergeViewDetections(aggregatedSightings, scanResult.objects || {});
        mergeViewDetections(sweepLocalSightings, scanResult.objects || {});
        showLiveOverlay(ai + 1, stepAngles.length, angle, scanResult.objects || {});
        pendingScanViewData.push({
          angle: angle,
          absolute_angle: (baseRotation.y || 0) + angle,
          pitch: baseRotation.x || 0,
          sweep_uuid: sweep.sweep_uuid,
          objects: scanResult.objects || {},
          bboxes: scanResult.positions || {},
          bboxes_all: scanResult.positions_all || {},
          image: imageBase64,
        });
      }

      // Update tag with what was found at this specific sweep
      const sweepCounts = _buildCounts(sweepLocalSightings, stepAngles.length);
      await _placeScanTag(sweep.sweep_uuid, sweep.label_name || category, sweepCounts, false);
    }

    clearLiveOverlay();
    const counts = _buildCounts(aggregatedSightings, sweeps.length * stepAngles.length);
    if (scanAreaNameInput) scanAreaNameInput.value = category;
    _prefetchPromise = _prefetchTightBboxes(counts);  // boxes for highlighting only
    pendingScanCounts = counts;
    renderScanReview(counts);
    if (!scanShouldStop) {
      appendLine("agent", `✅ Whole-area scan of "${category}" (${sweeps.length} sweeps) complete. ${formatCountsForChat(counts)}`);
      appendLine("system", "Review detected items below, then click 'Add to assets'.");
    }
  }

  async function markAsset(assetName) {
    if (!currentSweepUuid) {
      throw new Error("Current location not detected. Move around the space first.");
    }
    
    const body = {
      map_id: mapId,
      asset_name: assetName,
      sweep_uuid: currentSweepUuid,
    };
    
    const res = await fetch("/api/mark-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(function () {
      return { ok: false, error: "Invalid JSON from server" };
    });
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || res.statusText);
    }
    return data;
  }

  // ── Pathfinding (BFS using Matterport neighbor graph) ──────────────────────

  function findRoute(startId, endId) {
    if (!startId || !endId || startId === endId) return [startId].filter(Boolean);
    const prev = {};
    const queue = [startId];
    const visited = new Set([startId]);

    while (queue.length) {
      const cur = queue.shift();
      const sweep = allSweepData[cur];
      if (!sweep) continue;
      const neighbors = sweep.neighbors || [];
      for (const nid of neighbors) {
        if (visited.has(nid)) continue;
        visited.add(nid);
        prev[nid] = cur;
        if (nid === endId) {
          const path = [];
          let at = endId;
          while (at !== undefined) { path.unshift(at); at = prev[at]; }
          return path;
        }
        queue.push(nid);
      }
    }
    return null; // no path found (disconnected graph)
  }

  // Returns the instance from the list whose sweep_uuid is closest (BFS hops) to the
  // current position. Falls back to the first instance with a sweep_uuid if the graph
  // is not yet loaded, or to the first instance overall if none have a sweep_uuid.
  function findNearestAssetInstance(instances) {
    if (!instances || instances.length === 0) return null;
    const withSweep = instances.filter(i => i.sweep_uuid);
    if (withSweep.length === 0) return instances[0];
    if (withSweep.length === 1) return withSweep[0];
    if (!currentSweepUuid || Object.keys(allSweepData).length === 0) return withSweep[0];

    let best = null, bestDist = Infinity;
    for (const inst of withSweep) {
      const path = findRoute(currentSweepUuid, inst.sweep_uuid);
      const dist = path ? path.length : Infinity;
      if (dist < bestDist) { bestDist = dist; best = inst; }
    }
    return best || withSweep[0];
  }

  function clearRoute() {
    activeRoute = null;
    _routeAbort = true;
    _updateRouteHud();
  }

  function _updateRouteHud() {
    const hud = document.getElementById("route-hud");
    if (!hud) return;
    if (!activeRoute) {
      hud.style.display = "none";
      return;
    }
    const total = activeRoute.path.length - 1;
    const step  = Math.min(activeRoute.step, total);
    document.getElementById("route-hud-label").textContent =
      `📍 ${activeRoute.label}`;
    document.getElementById("route-hud-step").textContent =
      `Step ${step} / ${total}`;
    hud.style.display = "flex";
  }

  // Route navigation — computes path then walks sweep-by-sweep.
  // Falls back to a direct jump when graph data is unavailable or no path exists.
  async function navigateWithRoute(sweepUuid, label) {
    if (!sdk || !sdk.Sweep) {
      appendLine("system", "SDK not connected — cannot navigate.");
      return;
    }

    label = label || "destination";
    const startId = currentSweepUuid;
    const path    = (startId && Object.keys(allSweepData).length)
      ? findRoute(startId, sweepUuid)
      : null;

    // Fewer than 2 hops — just jump directly (no meaningful route to show)
    if (!path || path.length <= 2) {
      appendLine("agent", `Navigating to ${label}…`);
      await handleNavigate(sweepUuid);
      return;
    }

    const steps = path.length - 1;
    appendLine("agent", `📍 Route to ${label} — ${steps} step${steps > 1 ? "s" : ""}`);

    // Activate route state
    _routeAbort = false;
    activeRoute = { path, target: sweepUuid, label, step: 0 };
    _updateRouteHud();

    // Open minimap if closed so the user can see the route
    if (minimapPanel && minimapPanel.style.display === "none") {
      minimapPanel.style.display = "block";
      _startMinimapLoop();
    }

    // Walk the path step by step
    for (let i = 1; i < path.length; i++) {
      if (_routeAbort) {
        appendLine("system", "Route cancelled.");
        return;
      }
      activeRoute.step = i;
      _updateRouteHud();
      const isLast = i === path.length - 1;
      try {
        await sdk.Sweep.moveTo(path[i], {
          transition: sdk.Sweep.Transition.FLY,
          transitionTime: isLast ? 1800 : 600,
        });
      } catch (_) { /* ignore individual step failures */ }
      if (!isLast) await sleep(100);
    }

    activeRoute = null;
    _routeAbort = false;
    _updateRouteHud();
    appendLine("system", `✓ Arrived at ${label}.`);
  }

  // Direct single-jump — used internally (scan, auto-tag, highlight)
  async function handleNavigate(sweepUuid) {
    if (!sdk || !sdk.Sweep) {
      appendLine("system", "SDK not connected — cannot move.");
      return;
    }
    try {
      await sdk.Sweep.moveTo(sweepUuid, {
        transition: sdk.Sweep.Transition.FLY,
        transitionTime: 2000,
      });
    } catch (e) {
      appendLine("system", "Navigation failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  // --- QUICK ASSET FORM HANDLER ---
  const quickAssetForm = document.getElementById("quick-asset-form");
  const quickAssetStatusEl = document.getElementById("quick-asset-status");

  if (quickAssetForm) {
    quickAssetForm.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      
      const assetName = (document.getElementById("quick-asset-name").value || "").trim();
      const assetCategory = (document.getElementById("quick-asset-category").value || "").trim();
      
      if (!assetName) {
        quickAssetStatusEl.textContent = "❌ Please enter a location name";
        quickAssetStatusEl.style.color = "var(--danger)";
        return;
      }

      if (!currentSweepUuid) {
        quickAssetStatusEl.textContent = "❌ Location not detected. Move around first.";
        quickAssetStatusEl.style.color = "var(--danger)";
        return;
      }

      quickAssetStatusEl.textContent = "⏳ Saving...";
      quickAssetStatusEl.style.color = "var(--text-muted)";

      try {
        const body = {
          map_id: mapId,
          asset_name: assetName,
          asset_category: assetCategory || undefined,
          sweep_uuid: currentSweepUuid,
        };

        const res = await fetch("/api/mark-asset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
        
        const data = await res.json().catch(() => ({ ok: false, error: "Invalid response" }));

        if (!res.ok || data.ok === false) {
          throw new Error(data.error || res.statusText);
        }

        quickAssetStatusEl.textContent = "✓ Location saved!";
        quickAssetStatusEl.style.color = "var(--success)";
        document.getElementById("quick-asset-name").value = "";
        document.getElementById("quick-asset-category").value = "";
        await _refreshLocationData();

        setTimeout(() => {
          quickAssetStatusEl.textContent = "";
        }, 3000);
      } catch (err) {
        console.error("[3DAgent] Quick asset error:", err);
        quickAssetStatusEl.textContent = "❌ " + (err.message || String(err));
        quickAssetStatusEl.style.color = "var(--danger)";
      }
    });
  }

  // --- MAINTENANCE REPORT: interactive location → asset → describe flow ---
  const reportForm           = document.getElementById("report-issue-form");
  const reportStatusEl       = document.getElementById("report-status");
  const reportLocationSelect = document.getElementById("report-location-select");
  const reportAssetStep      = document.getElementById("report-asset-step");
  const reportAssetList      = document.getElementById("report-asset-list");
  const reportNoAssets       = document.getElementById("report-no-assets");
  const reportEquipmentInput = document.getElementById("report-equipment");
  const reportIssueBtnEl     = document.getElementById("report-issue-btn");

  let reportSummaries = [];
  let reportSelectedAsset = null;   // {general?, area, name, sweep, angle, bbox, serial, baseName}

  function _reportAssetLabel(s) {
    const name = (s.asset_name || "item");
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    return s.serial_number ? `${cap} #${s.serial_number}` : cap;
  }

  function resetReportFlow() {
    reportSelectedAsset = null;
    if (reportAssetStep) reportAssetStep.style.display = "none";
    if (reportForm) reportForm.style.display = "none";
    if (reportAssetList) reportAssetList.innerHTML = "";
    if (reportEquipmentInput) reportEquipmentInput.value = "";
    const d = document.getElementById("report-description"); if (d) d.value = "";
    const sv = document.getElementById("report-severity"); if (sv) sv.value = "medium";
    if (reportStatusEl) reportStatusEl.textContent = "";
  }

  // Load the scanned assets so the popover can list locations & their assets.
  async function loadReportData() {
    resetReportFlow();
    if (reportLocationSelect) reportLocationSelect.value = "";
    try {
      const res = await fetch(`/api/spaces/${mapId}/assets-panel`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({ ok: false }));
      reportSummaries = (data.ok && Array.isArray(data.scan_summaries)) ? data.scan_summaries : [];
    } catch (_) { reportSummaries = []; }

    const areas = Array.from(new Set(reportSummaries.map(s => s.area_name || "Unspecified"))).sort();
    if (reportLocationSelect) {
      reportLocationSelect.innerHTML = '<option value="">Choose a location…</option>';
      areas.forEach(a => {
        const o = document.createElement("option"); o.value = a; o.textContent = a;
        reportLocationSelect.appendChild(o);
      });
      const og = document.createElement("option"); og.value = "__general__"; og.textContent = "Other / general issue";
      reportLocationSelect.appendChild(og);
    }
    if (reportNoAssets) reportNoAssets.style.display = areas.length ? "none" : "block";
  }

  function buildReportAssetList(area, assets) {
    if (!reportAssetList) return;
    let html = assets.map(s => `<button type="button" class="report-asset-chip" data-id="${s.id}">${_reportAssetLabel(s)}</button>`).join("");
    html += `<button type="button" class="report-asset-chip report-asset-general" data-general="1">Other / general</button>`;
    reportAssetList.innerHTML = html;
    reportAssetList.querySelectorAll(".report-asset-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        reportAssetList.querySelectorAll(".report-asset-chip").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        if (btn.dataset.general) {
          reportSelectedAsset = { general: true, area: area };
          if (reportEquipmentInput) reportEquipmentInput.value = "";
          if (reportForm) reportForm.style.display = "block";
          if (reportEquipmentInput) setTimeout(() => reportEquipmentInput.focus(), 0);
          clearHighlightOverlay();
          return;
        }
        const s = assets.find(a => String(a.id) === btn.dataset.id);
        if (s) selectReportAsset(s, area);
      });
    });
  }

  // Fly to the chosen asset and outline that exact instance.
  async function selectReportAsset(s, area) {
    reportSelectedAsset = {
      general: false, area: area, name: _reportAssetLabel(s),
      sweep: s.sweep_uuid, angle: s.best_angle, bbox: s.bbox,
      serial: s.serial_number, baseName: s.asset_name,
    };
    if (reportEquipmentInput) reportEquipmentInput.value = _reportAssetLabel(s);
    if (reportForm) reportForm.style.display = "block";
    if (!s.sweep_uuid) return;
    await handleNavigate(s.sweep_uuid);
    await sleep(1200);
    if (s.best_angle != null) { try { await rotateToYawAtCurrentSweep(s.best_angle, 0); } catch (_) {} }
    if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
    showHighlightOverlay(_reportAssetLabel(s), s.bbox, { segName: s.asset_name, instanceIndex: (s.serial_number || 1) - 1 });
  }

  async function onReportLocationChange() {
    if (!reportLocationSelect) return;
    const area = reportLocationSelect.value;
    reportSelectedAsset = null;
    if (reportForm) reportForm.style.display = "none";
    clearHighlightOverlay();
    if (!area) { if (reportAssetStep) reportAssetStep.style.display = "none"; return; }

    if (area === "__general__") {
      if (reportAssetStep) reportAssetStep.style.display = "none";
      reportSelectedAsset = { general: true, area: "" };
      if (reportForm) reportForm.style.display = "block";
      if (reportEquipmentInput) setTimeout(() => reportEquipmentInput.focus(), 0);
      return;
    }

    const assets = reportSummaries.filter(s => (s.area_name || "Unspecified") === area && s.sweep_uuid);
    // Bring the user to the location so they can see the assets.
    const first = assets[0];
    if (first && first.sweep_uuid) {
      appendLine("system", `📍 Going to ${area} — click the asset that has the issue.`);
      handleNavigate(first.sweep_uuid);
    }
    buildReportAssetList(area, assets);
    if (reportAssetStep) reportAssetStep.style.display = "block";
  }

  if (reportLocationSelect) reportLocationSelect.addEventListener("change", onReportLocationChange);
  if (reportIssueBtnEl) reportIssueBtnEl.addEventListener("click", function () { loadReportData(); });

  // ── Problem Equipment popover — reported faults; click to fly to + outline ──
  const problemsBtnEl  = document.getElementById("problems-btn");
  const problemsListEl = document.getElementById("problems-list");

  function _sevDot(sev) {
    const color = ({ critical: "#b91c1c", high: "#ea580c", medium: "#d97706", low: "#94a3b8" })[sev] || "#94a3b8";
    return `<span class="problem-sev-dot" style="background:${color};"></span>`;
  }

  async function loadProblemAssets() {
    if (!problemsListEl) return;
    problemsListEl.innerHTML = '<div class="ap-empty">Loading…</div>';
    let problems = [];
    try {
      const res = await fetch(`/api/spaces/${mapId}/problem-assets`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({ ok: false }));
      problems = (data.ok && data.problems) || [];
    } catch (_) {}

    if (!problems.length) {
      problemsListEl.innerHTML = '<div class="ap-empty">No reported problems in this space. 🎉</div>';
      return;
    }
    problemsListEl.innerHTML = problems.map(p => {
      const loc = p.area_name ? ` · ${p.area_name}` : "";
      const noloc = p.sweep_uuid ? "" : " report-asset-chip--noloc";
      const name = (p.equipment_name || "").replace(/"/g, "&quot;");
      return `<button type="button" class="report-asset-chip report-problem-chip${noloc}"
                data-sweep="${p.sweep_uuid || ""}" data-name="${name}">
                ${_sevDot(p.severity)}<span class="problem-chip-name">${p.equipment_name}${loc}</span>
              </button>`;
    }).join("");

    problemsListEl.querySelectorAll(".report-problem-chip").forEach(btn => {
      btn.addEventListener("click", async () => {
        const sweep = btn.dataset.sweep;
        const name = btn.dataset.name;
        if (!sweep) { appendLine("system", `"${name}" has no recorded 3D location.`); return; }
        problemsListEl.querySelectorAll(".report-problem-chip").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        appendLine("system", `🔧 Going to ${name}…`);
        await handleNavigate(sweep);
        await sleep(1400);
        await _highlightReportedAsset(sweep, name);
      });
    });
  }

  if (problemsBtnEl) problemsBtnEl.addEventListener("click", function () { loadProblemAssets(); });

  if (reportForm) {
    reportForm.addEventListener("submit", async function (ev) {
      ev.preventDefault();

      const equipment = (reportEquipmentInput ? reportEquipmentInput.value : "").trim();
      const description = (document.getElementById("report-description").value || "").trim();
      const severity = document.getElementById("report-severity").value || "medium";

      if (!equipment) {
        reportStatusEl.textContent = "❌ Enter the asset / equipment name";
        reportStatusEl.style.color = "var(--danger)";
        return;
      }

      let areaName = (reportSelectedAsset && reportSelectedAsset.area) || "";
      let sweepUuid = (reportSelectedAsset && reportSelectedAsset.sweep) || currentSweepUuid || undefined;
      if (!areaName) {
        const tag = currentSweepUuid ? taggedSweepMap[currentSweepUuid] : null;
        if (tag) areaName = tag.label_name + (tag.category ? " (" + tag.category + ")" : "");
      }

      reportStatusEl.textContent = "⏳ Submitting…";
      reportStatusEl.style.color = "var(--text-muted)";

      try {
        const res = await fetch("/api/maintenance/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            map_id: mapId,
            equipment_name: equipment,
            description: description || undefined,
            severity: severity,
            sweep_uuid: sweepUuid,
            area_name: areaName || undefined,
          }),
        });
        const data = await res.json().catch(() => ({ ok: false, error: "Invalid response" }));
        if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);

        reportStatusEl.textContent = "✓ Issue reported — admin notified.";
        reportStatusEl.style.color = "var(--success)";
        appendLine("system", "🛠️ Maintenance issue reported: " + equipment + (areaName ? " @ " + areaName : "") + " — severity: " + severity + ".");
        resetReportFlow();
        if (reportLocationSelect) reportLocationSelect.value = "";
        clearHighlightOverlay();
        setTimeout(() => { reportStatusEl.textContent = ""; }, 4000);
      } catch (err) {
        console.error("[3DAgent] Report issue error:", err);
        reportStatusEl.textContent = "❌ " + (err.message || String(err));
        reportStatusEl.style.color = "var(--danger)";
      }
    });
  }

  if (scanAreaBtn) {
    scanAreaBtn.addEventListener("click", function () {
      if (isScanning) {
        scanShouldStop = true;
        scanAreaBtn.disabled = true;
        scanAreaBtn.textContent = "⏹ Stopping…";
      } else if (scanModePicker && scanModePicker.style.display !== "none") {
        hideScanModePicker();
      } else {
        showScanModePicker();
      }
    });
  }

  if (scanCurrentBtn) {
    scanCurrentBtn.addEventListener("click", function () {
      hideScanModePicker();
      scanArea(null);
    });
  }

  if (scanWholeAreaBtn) {
    scanWholeAreaBtn.addEventListener("click", function () {
      const cat = scanCategorySelect && scanCategorySelect.value;
      if (!cat) {
        appendLine("system", "Please select an area from the dropdown first.");
        return;
      }
      hideScanModePicker();
      scanArea(cat);
    });
  }

  if (scanModeCancelBtn) {
    scanModeCancelBtn.addEventListener("click", hideScanModePicker);
  }

  if (scanQualityGroup) {
    scanQualityGroup.addEventListener("click", function (e) {
      const opt = e.target.closest(".scan-quality-opt");
      if (!opt || !scanQualityGroup.contains(opt)) return;
      const mode = opt.getAttribute("data-mode");
      if (!mode || !SCAN_MODE_ANGLES[mode]) return;
      scanQualityMode = mode;
      scanQualityGroup.querySelectorAll(".scan-quality-opt").forEach(function (el) {
        const on = el === opt;
        el.classList.toggle("is-selected", on);
        el.setAttribute("aria-checked", on ? "true" : "false");
      });
    });
  }

  if (autoTagBtn) {
    autoTagBtn.addEventListener("click", function () {
      if (isAutoTagging) {
        autoTagShouldStop = true;
        autoTagBtn.disabled = true;
        var _atl2 = document.getElementById("auto-tag-label"); if (_atl2) _atl2.textContent = "Stopping…";
      } else {
        openAutoTagFloorplan();
      }
    });
  }

  // ── Auto-Tag floor-plan sweep selector ────────────────────────────────────
  const autoTagFp           = document.getElementById("autotag-floorplan");
  const autoTagCanvas       = document.getElementById("autotag-canvas");
  const autoTagViewFloor    = document.getElementById("autotag-view-floor");
  const autoTagCountEl      = document.getElementById("autotag-count");
  const autoTagSelectAllBtn = document.getElementById("autotag-select-all");
  const autoTagClearBtn     = document.getElementById("autotag-clear");
  const autoTagRunSelBtn    = document.getElementById("autotag-run-selected");
  const autoTagRunAllBtn    = document.getElementById("autotag-run-all");
  const autoTagFpCancelBtn  = document.getElementById("autotag-fp-cancel");
  const autoTagFpCloseBtn   = document.getElementById("autotag-fp-close");

  const autoTagSelected     = new Set();   // uuids the user picked
  let   autoTagViewFloorId  = null;        // floor shown in the selector
  let   _autoTagHit         = [];          // [{uuid,x,y}] for click hit-testing

  function _floorDisplayName(f) {
    if (f && f.name) return f.name;
    return "Floor " + (((f && f.seq != null) ? f.seq : 0) + 1);
  }

  // Build the set of floors from the sweep data the minimap already loaded.
  function _detectFloors() {
    const map = {};
    Object.values(allSweepData || {}).forEach(function (s) {
      const fi = s && s.floorInfo;
      if (fi && fi.id !== undefined && fi.id !== null) {
        if (!map[fi.id]) {
          const meta = Object.values(floorDataMap || {}).find(function (f) { return f.id === fi.id; });
          map[fi.id] = {
            id: fi.id,
            name: (meta && meta.name) || fi.name || null,
            seq: (meta && meta.sequence != null) ? meta.sequence : (fi.sequence != null ? fi.sequence : 0),
            count: 0,
          };
        }
        map[fi.id].count++;
      }
    });
    return Object.values(map).sort(function (a, b) { return a.seq - b.seq; });
  }

  function _currentFloorId() {
    const s = currentSweepUuid && allSweepData[currentSweepUuid];
    return (s && s.floorInfo && s.floorInfo.id != null) ? s.floorInfo.id : null;
  }

  function _sweepFloorId(uuid, sweepObj) {
    const a = allSweepData[uuid];
    if (a && a.floorInfo && a.floorInfo.id != null) return a.floorInfo.id;
    if (sweepObj && sweepObj.floorInfo && sweepObj.floorInfo.id != null) return sweepObj.floorInfo.id;
    return null;
  }

  // sweeps with a position on a given floor (null = every floor)
  function _getFloorSweeps(floorId) {
    return Object.entries(allSweepData)
      .filter(function (_a) { var s = _a[1]; return s && s.position; })
      .map(function (_a) { return Object.assign({ id: _a[0] }, _a[1]); })
      .filter(function (s) {
        if (floorId === null || floorId === undefined) return true;
        return s.floorInfo && String(s.floorInfo.id) === String(floorId);
      });
  }

  function _updateAutoTagCount() {
    if (autoTagCountEl) autoTagCountEl.textContent = autoTagSelected.size + " selected";
  }

  function renderAutoTagCanvas() {
    if (!autoTagCanvas) return;
    const ctx = autoTagCanvas.getContext("2d");
    const W = autoTagCanvas.width, H = autoTagCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, W, H);

    const sweeps = _getFloorSweeps(autoTagViewFloorId);
    _autoTagHit = [];
    if (!sweeps.length) {
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Floor plan still loading — walk around a bit, then reopen.", W / 2, H / 2);
      _updateAutoTagCount();
      return;
    }

    const proj = _computeProjection(sweeps, W, H, 30);

    // neighbour edges (only within this floor → no cross-floor clutter)
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    const drawn = {};
    sweeps.forEach(function (s) {
      if (!s.neighbors) return;
      const from = proj.toCanvas(s.position);
      s.neighbors.forEach(function (nid) {
        const key = s.id < nid ? s.id + "|" + nid : nid + "|" + s.id;
        if (drawn[key]) return; drawn[key] = true;
        const ns = allSweepData[nid];
        if (!ns || !ns.position) return;
        if (String((ns.floorInfo || {}).id) !== String((s.floorInfo || {}).id)) return;
        const to = proj.toCanvas(ns.position);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      });
    });

    // sweep dots
    sweeps.forEach(function (s) {
      const pt = proj.toCanvas(s.position);
      const tagged = !!taggedSweepMap[s.id];
      const selected = autoTagSelected.has(s.id);
      const isCurrent = s.id === currentSweepUuid;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, selected ? 7 : 6, 0, Math.PI * 2);
      ctx.fillStyle = tagged ? "#c7c7cc" : (selected ? "#0070f3" : "#ffffff");
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.3;
      ctx.strokeStyle = tagged ? "#a0a0a5" : (selected ? "#0a4fb0" : "#7a7a7a");
      ctx.stroke();
      if (isCurrent) {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
        ctx.strokeStyle = "#16a34a"; ctx.lineWidth = 2; ctx.stroke();
      }
      if (!tagged) _autoTagHit.push({ uuid: s.id, x: pt.x, y: pt.y });
    });

    _updateAutoTagCount();
  }

  if (autoTagCanvas) {
    autoTagCanvas.addEventListener("click", function (e) {
      const rect = autoTagCanvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (autoTagCanvas.width / rect.width);
      const y = (e.clientY - rect.top) * (autoTagCanvas.height / rect.height);
      let best = null, bestD = 16 * 16;
      _autoTagHit.forEach(function (h) {
        const dx = h.x - x, dy = h.y - y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = h; }
      });
      if (best) {
        if (autoTagSelected.has(best.uuid)) autoTagSelected.delete(best.uuid);
        else autoTagSelected.add(best.uuid);
        renderAutoTagCanvas();
      }
    });
  }

  function _populateAutoTagFloors() {
    const floors = _detectFloors();
    if (!autoTagViewFloor) return floors;
    autoTagViewFloor.innerHTML = "";
    if (floors.length === 0) {
      autoTagViewFloorId = null;
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "All sweeps";
      autoTagViewFloor.appendChild(opt);
      autoTagViewFloor.style.display = "none";
      return floors;
    }
    autoTagViewFloor.style.display = floors.length > 1 ? "" : "none";
    const curId = _currentFloorId();
    floors.forEach(function (f) {
      const opt = document.createElement("option");
      opt.value = String(f.id);
      opt.textContent = _floorDisplayName(f) + " (" + f.count + ")";
      autoTagViewFloor.appendChild(opt);
    });
    autoTagViewFloorId = (curId != null) ? curId : floors[0].id;
    autoTagViewFloor.value = String(autoTagViewFloorId);
    return floors;
  }

  function openAutoTagFloorplan() {
    if (!autoTagFp) { autoTagLocations(null); return; }
    autoTagSelected.clear();
    _populateAutoTagFloors();
    renderAutoTagCanvas();
    autoTagFp.style.display = "flex";
  }
  function closeAutoTagFloorplan() { if (autoTagFp) autoTagFp.style.display = "none"; }

  if (autoTagViewFloor) autoTagViewFloor.addEventListener("change", function () {
    const v = autoTagViewFloor.value;
    autoTagViewFloorId = v === "" ? null : v;
    renderAutoTagCanvas();
  });
  if (autoTagSelectAllBtn) autoTagSelectAllBtn.addEventListener("click", function () {
    _getFloorSweeps(autoTagViewFloorId).forEach(function (s) {
      if (!taggedSweepMap[s.id]) autoTagSelected.add(s.id);
    });
    renderAutoTagCanvas();
  });
  if (autoTagClearBtn) autoTagClearBtn.addEventListener("click", function () {
    autoTagSelected.clear(); renderAutoTagCanvas();
  });
  if (autoTagRunSelBtn) autoTagRunSelBtn.addEventListener("click", function () {
    if (!autoTagSelected.size) { appendLine("system", "Select at least one sweep, or use “Tag every sweep”."); return; }
    const list = Array.from(autoTagSelected);
    closeAutoTagFloorplan();
    autoTagLocations(list);
  });
  if (autoTagRunAllBtn) autoTagRunAllBtn.addEventListener("click", function () {
    closeAutoTagFloorplan(); autoTagLocations(null);
  });
  if (autoTagFpCancelBtn) autoTagFpCancelBtn.addEventListener("click", closeAutoTagFloorplan);
  if (autoTagFpCloseBtn) autoTagFpCloseBtn.addEventListener("click", closeAutoTagFloorplan);
  if (autoTagFp) autoTagFp.addEventListener("click", function (e) {
    if (e.target === autoTagFp) closeAutoTagFloorplan();
  });

  // ── Auto-Tag Results — review/confirm newly tagged sweeps (hover + CRUD) ────
  const autoTagResultsEl      = document.getElementById("autotag-results");
  const autoTagResultsCanvas  = document.getElementById("autotag-results-canvas");
  const autoTagResultsList     = document.getElementById("autotag-results-list");
  const autoTagResultsTooltip = document.getElementById("autotag-results-tooltip");
  const autoTagResultsTitle   = document.getElementById("autotag-results-title");
  const autoTagResultsClose   = document.getElementById("autotag-results-close");
  const autoTagResultsDone    = document.getElementById("autotag-results-done");

  let _autoTagResults = [];
  let _arHit = [];
  let _arHoverIdx = -1;

  function openAutoTagResults(results) {
    _autoTagResults = (results || []).slice();
    _arHoverIdx = -1;
    if (autoTagResultsTitle) autoTagResultsTitle.textContent = `✅ Auto-Tag Results — ${_autoTagResults.length} sweep(s) tagged`;
    renderAutoTagResultsList();
    renderAutoTagResultsCanvas();
    if (autoTagResultsEl) autoTagResultsEl.style.display = "flex";
  }
  function closeAutoTagResults() { if (autoTagResultsEl) autoTagResultsEl.style.display = "none"; }

  function renderAutoTagResultsCanvas() {
    if (!autoTagResultsCanvas) return;
    const ctx = autoTagResultsCanvas.getContext("2d");
    const W = autoTagResultsCanvas.width, H = autoTagResultsCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, W, H);

    const pts = _autoTagResults.filter(r => r.x != null && r.z != null);
    _arHit = [];
    if (!pts.length) {
      ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.font = "13px Inter, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("Tagged sweeps have no plotted positions.", W / 2, H / 2);
      return;
    }
    const proj = _computeProjection(pts.map(r => ({ position: { x: r.x, z: r.z } })), W, H, 36);
    pts.forEach(r => {
      const idx = _autoTagResults.indexOf(r);
      const c = proj.toCanvas({ x: r.x, z: r.z });
      const hovered = idx === _arHoverIdx;
      ctx.beginPath(); ctx.arc(c.x, c.y, hovered ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = hovered ? "#0070f3" : "#16a34a"; ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = hovered ? "#0a4fb0" : "#0f7a37"; ctx.stroke();
      if (hovered) {
        const short = r.label.length > 18 ? r.label.slice(0, 16) + "…" : r.label;
        ctx.font = "600 10px Inter, sans-serif"; ctx.textAlign = "center";
        ctx.fillStyle = "#111"; ctx.shadowColor = "rgba(255,255,255,0.95)"; ctx.shadowBlur = 4;
        ctx.fillText(short, c.x, c.y - 11); ctx.shadowBlur = 0;
      }
      _arHit.push({ idx: idx, x: c.x, y: c.y });
    });
  }

  function _highlightArRow(idx) {
    if (!autoTagResultsList) return;
    autoTagResultsList.querySelectorAll(".ar-row").forEach(row => {
      row.classList.toggle("ar-row--hover", parseInt(row.dataset.idx) === idx);
    });
    if (idx >= 0) {
      const el = autoTagResultsList.querySelector(`.ar-row[data-idx="${idx}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }

  function renderAutoTagResultsList() {
    if (!autoTagResultsList) return;
    if (!_autoTagResults.length) {
      autoTagResultsList.innerHTML = `<div class="ap-empty">No tags remaining.</div>`;
      return;
    }
    autoTagResultsList.innerHTML = _autoTagResults.map((r, idx) => `
      <div class="ar-row" data-idx="${idx}" data-id="${r.asset_id}">
        <input type="text" class="ar-row-input" value="${_escAttr(r.label)}" data-id="${r.asset_id}">
        <span class="ar-row-cat">${r.category || ""}</span>
        <div class="ar-row-actions">
          ${r.sweep_uuid ? `<button type="button" class="btn small secondary ar-locate" data-sweep="${_escAttr(r.sweep_uuid)}" title="Fly here">▶</button>` : ""}
          <button type="button" class="btn small danger ar-del" data-id="${r.asset_id}" title="Delete">🗑</button>
        </div>
      </div>`).join("");

    autoTagResultsList.querySelectorAll(".ar-row").forEach(row => {
      const idx = parseInt(row.dataset.idx);
      row.addEventListener("mouseenter", () => { _arHoverIdx = idx; renderAutoTagResultsCanvas(); });
      row.addEventListener("mouseleave", () => { _arHoverIdx = -1; renderAutoTagResultsCanvas(); });
    });

    autoTagResultsList.querySelectorAll(".ar-row-input").forEach(inp => {
      inp.addEventListener("change", async () => {
        const id = inp.dataset.id;
        const newName = (inp.value || "").trim();
        const r = _autoTagResults.find(x => String(x.asset_id) === String(id));
        if (!r || !newName || newName === r.label) return;
        try {
          const res = await fetch(`/api/spaces/${mapId}/assets/${id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
            body: JSON.stringify({ label_name: newName }),
          });
          const d = await res.json().catch(() => ({}));
          if (d.ok) { r.label = newName; renderAutoTagResultsCanvas(); await _refreshLocationData(); }
          else { appendLine("system", "Rename failed: " + (d.error || "unknown")); inp.value = r.label; }
        } catch (e) { appendLine("system", "Rename error: " + e.message); inp.value = r.label; }
      });
    });

    autoTagResultsList.querySelectorAll(".ar-locate").forEach(btn => {
      btn.addEventListener("click", () => { handleNavigate(btn.dataset.sweep); });
    });

    autoTagResultsList.querySelectorAll(".ar-del").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        if (!confirm("Delete this tagged location?")) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/spaces/${mapId}/assets/${id}`, { method: "DELETE", credentials: "same-origin" });
          const d = await res.json().catch(() => ({}));
          if (d.ok) {
            _autoTagResults = _autoTagResults.filter(x => String(x.asset_id) !== String(id));
            if (autoTagResultsTitle) autoTagResultsTitle.textContent = `✅ Auto-Tag Results — ${_autoTagResults.length} sweep(s) tagged`;
            renderAutoTagResultsList(); renderAutoTagResultsCanvas();
            await _refreshLocationData();
          } else { appendLine("system", "Delete failed: " + (d.error || "unknown")); btn.disabled = false; }
        } catch (e) { appendLine("system", "Delete error: " + e.message); btn.disabled = false; }
      });
    });
  }

  if (autoTagResultsCanvas) {
    autoTagResultsCanvas.addEventListener("mousemove", e => {
      const rect = autoTagResultsCanvas.getBoundingClientRect();
      const sx = autoTagResultsCanvas.width / rect.width, sy = autoTagResultsCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * sx, y = (e.clientY - rect.top) * sy;
      let best = -1, bestD = 15 * 15, bestPt = null;
      _arHit.forEach(h => { const dx = h.x - x, dy = h.y - y, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = h.idx; bestPt = h; } });
      if (best !== _arHoverIdx) { _arHoverIdx = best; renderAutoTagResultsCanvas(); _highlightArRow(best); }
      if (best >= 0 && bestPt && autoTagResultsTooltip) {
        autoTagResultsTooltip.textContent = _autoTagResults[best].label;
        autoTagResultsTooltip.style.left = (bestPt.x / sx) + "px";
        autoTagResultsTooltip.style.top = (bestPt.y / sy) + "px";
        autoTagResultsTooltip.style.display = "block";
      } else if (autoTagResultsTooltip) {
        autoTagResultsTooltip.style.display = "none";
      }
    });
    autoTagResultsCanvas.addEventListener("mouseleave", () => {
      _arHoverIdx = -1; if (autoTagResultsTooltip) autoTagResultsTooltip.style.display = "none";
      renderAutoTagResultsCanvas(); _highlightArRow(-1);
    });
  }
  if (autoTagResultsClose) autoTagResultsClose.addEventListener("click", closeAutoTagResults);
  if (autoTagResultsDone) autoTagResultsDone.addEventListener("click", closeAutoTagResults);
  if (autoTagResultsEl) autoTagResultsEl.addEventListener("click", e => { if (e.target === autoTagResultsEl) closeAutoTagResults(); });

  if (scanLocationSelect && scanAreaNameInput) {
    scanLocationSelect.addEventListener("change", function () {
      if (scanLocationSelect.value) {
        scanAreaNameInput.value = scanLocationSelect.value;
      }
    });
  }

  if (scanSaveBtn) {
    scanSaveBtn.addEventListener("click", async function () {
      // Use edited counts from selectedScanItems (user-modified values)
      const editedCounts = {};
      Object.keys(selectedScanItems).forEach((assetName) => {
        const count = selectedScanItems[assetName];
        // Only include items with count > 0
        if (count && parseInt(count) > 0) {
          editedCounts[assetName] = parseInt(count);
        }
      });

      if (!Object.keys(editedCounts).length) {
        appendLine("system", "Please add at least one asset with count > 0 before saving.");
        return;
      }

      const areaName = (
        (scanAreaNameInput && scanAreaNameInput.value ? scanAreaNameInput.value : "") ||
        (scanLocationSelect && scanLocationSelect.value ? scanLocationSelect.value : "")
      ).trim();
      if (!areaName) {
        appendLine("system", "Please enter an area name before saving (e.g., Bedroom 1).");
        return;
      }

      scanSaveBtn.disabled = true;
      scanSaveBtn.textContent = "Saving...";
      try {
        // Wait for background bbox pre-fetch to finish so we can persist the data
        if (_prefetchPromise) {
          scanSaveBtn.textContent = "Saving…";
          await _prefetchPromise;
        }

        // Build per-instance bbox data from the pre-fetched cache + scan view metadata.
        // Instance #1 gets the primary detected bbox; additional instances share the
        // same camera angle/sweep but don't have individual bbox positions.
        const bbox_data = {};
        Object.keys(editedCounts).forEach((assetName) => {
          // Fallback view (for instances beyond what was captured, e.g. count edited up).
          let bestView = null, bestCount = 0;
          pendingScanViewData.forEach((view) => {
            const c = view.objects[assetName] || 0;
            if (c > bestCount) { bestCount = c; bestView = view; }
          });
          const fbAngle = bestView ? (bestView.absolute_angle != null ? bestView.absolute_angle : bestView.angle) : null;
          const fbSweep = bestView ? (bestView.sweep_uuid || null) : null;

          const instanceCount = editedCounts[assetName] || 1;
          // Each instance keeps its OWN sweep + absolute angle + box so highlights
          // are precise even when the asset was scanned across multiple sweeps.
          const capInsts = (instanceBboxCache[assetName] && instanceBboxCache[assetName].instances) || [];

          const instances = [];
          for (let i = 0; i < instanceCount; i++) {
            const it = capInsts[i] || null;
            instances.push({
              serial:     i + 1,
              bbox:       it ? it.bbox : null,
              angle:      it ? it.angle : fbAngle,
              sweep_uuid: it ? it.sweep_uuid : fbSweep,
            });
          }
          bbox_data[assetName] = { instances };
        });

        // Use the new confirm-edit endpoint with user-edited counts + bbox data
        const res = await fetch("/api/scan-assets/confirm-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            map_id: mapId,
            area_name: areaName,
            edited_assets: editedCounts,
            sweep_uuid: pendingScanSweepUuid || currentSweepUuid || "",
            bbox_data,
          }),
        });
        const data = await res.json().catch(() => ({ ok: false, error: "Invalid response" }));
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || res.statusText);
        }
        appendLine("agent", `✓ Confirmed! Saved ${Object.keys(editedCounts).length} assets for '${areaName}'.`);

        // Upgrade any pending (yellow) tag for the saved sweep to confirmed (green)
        if (pendingScanSweepUuid) {
          await _placeScanTag(pendingScanSweepUuid, areaName, editedCounts, true);
        }
        // If "Show Scanned Assets" is active, reload to include the new confirmed area
        if (scanTagsVisible) {
          await _removeAllScanTags();
          await loadAndShowScanTags();
        }
        pendingScanSweepUuid = null;

        hideScanReview();
        if (scanAreaNameInput) scanAreaNameInput.value = "";
        if (scanLocationSelect) scanLocationSelect.value = "";
        await loadScanLocations();
      } catch (err) {
        console.error("[3DAgent] Save scanned assets error:", err);
        appendLine("system", "Save failed: " + (err.message || String(err)));
      } finally {
        scanSaveBtn.disabled = false;
        scanSaveBtn.textContent = "Confirm & Save";
      }
    });
  }

  if (scanCancelBtn) {
    scanCancelBtn.addEventListener("click", async function () {
      // Remove the pending (yellow) tag if scan was not confirmed
      if (pendingScanSweepUuid && scanResultTags[pendingScanSweepUuid] &&
          !scanResultTags[pendingScanSweepUuid].confirmed) {
        const sids = scanResultTags[pendingScanSweepUuid].tagSids || [];
        if (sids.length && sdk && sdk.Mattertag) {
          try { await sdk.Mattertag.remove(sids); } catch (_) {}
        }
        delete scanResultTags[pendingScanSweepUuid];
      }
      pendingScanSweepUuid = null;
      hideScanReview();
      appendLine("system", "Scan results discarded.");
    });
  }

  // ── In-chat Scanned Inventory ─────────────────────────────────────────────
  const scannedInChatEl    = document.getElementById("scanned-in-chat");
  const scannedInChatBody  = document.getElementById("scanned-in-chat-body");
  const scannedInChatClose = document.getElementById("scanned-in-chat-close");
  let   scannedInChatOpen  = false;

  async function openScannedInChat() {
    if (!scannedInChatEl) return;
    scannedInChatEl.style.display = "flex";
    scannedInChatOpen = true;
    const btn = document.getElementById("show-scanned-btn");
    if (btn) { btn.style.color = "var(--accent-primary)"; var _l = document.getElementById("show-scanned-label"); if (_l) _l.textContent = "Hide Scanned"; }

    if (!scannedInChatBody) return;
    scannedInChatBody.innerHTML = '<div class="ap-empty">Loading…</div>';
    try {
      const res  = await fetch(`/api/spaces/${mapId}/assets-panel`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) throw new Error(data.error || "Failed to load");
      _renderScannedInChatBody(data.scan_summaries || []);
    } catch (err) {
      scannedInChatBody.innerHTML = `<div class="ap-empty" style="color:var(--danger);">Error: ${err.message}</div>`;
    }
  }

  function closeScannedInChat() {
    if (scannedInChatEl) scannedInChatEl.style.display = "none";
    scannedInChatOpen = false;
    const btn = document.getElementById("show-scanned-btn");
    if (btn) { btn.style.color = ""; var _l = document.getElementById("show-scanned-label"); if (_l) _l.textContent = "Scanned"; }
  }

  function _renderScannedInChatBody(summaries) {
    if (!scannedInChatBody) return;

    const areaMap = {};
    summaries.forEach(s => {
      const area = s.area_name || "Unspecified";
      if (!areaMap[area]) areaMap[area] = [];
      areaMap[area].push(s);
    });
    const areas = Object.keys(areaMap).sort();

    if (!areas.length) {
      scannedInChatBody.innerHTML = '<div class="ap-empty">No scanned inventory yet. Use <strong>📷 Scan Area</strong>.</div>';
      return;
    }

    scannedInChatBody.innerHTML = `
      <div id="sic-area-chips" class="ap-area-chips">
        ${areas.map(a => `<button type="button" class="ap-area-chip" data-area="${a}">
          ${a}<span class="ap-count">${areaMap[a].length}</span>
        </button>`).join("")}
      </div>
      <div id="sic-detail" style="display:none;">
        <button type="button" id="sic-back" class="btn ghost small" style="margin-bottom:0.5rem; width:100%;">← Back to areas</button>
        <div id="sic-detail-rows"></div>
      </div>`;

    const areaChipsEl   = scannedInChatBody.querySelector("#sic-area-chips");
    const sicDetail     = scannedInChatBody.querySelector("#sic-detail");
    const sicDetailRows = scannedInChatBody.querySelector("#sic-detail-rows");
    const sicBack       = scannedInChatBody.querySelector("#sic-back");

    function showSicDetail(area) {
      if (!sicDetailRows) return;
      const rowsByAsset = {};
      (areaMap[area] || []).forEach(s => {
        if (!rowsByAsset[s.asset_name]) rowsByAsset[s.asset_name] = [];
        rowsByAsset[s.asset_name].push(s);
      });
      const canNav = s => s.sweep_uuid && s.best_angle !== null && s.best_angle !== undefined;
      const bboxAttr = s => s.bbox ? JSON.stringify(s.bbox) : "null";

      sicDetailRows.innerHTML = Object.entries(rowsByAsset).map(([assetName, rows]) => {
        rows.sort((a, b) => (a.serial_number || 1) - (b.serial_number || 1));
        const totalCount = rows.reduce((sum, r) => sum + (r.count || 1), 0);
        const isLegacy = rows.length === 1 && !rows[0].serial_number;

        if (isLegacy) {
          const s = rows[0];
          return `<div class="ap-asset-group"><div class="ap-row">
            <div class="ap-row-info"><span class="ap-row-label" style="text-transform:capitalize;">${assetName}</span></div>
            <div class="ap-row-actions">
              <span class="ap-count">${totalCount}</span>
              ${canNav(s) ? `<button type="button" class="btn small secondary ap-highlight-btn"
                data-name="${assetName}" data-sweep="${s.sweep_uuid}"
                data-angle="${s.best_angle}" data-bbox='${bboxAttr(s)}' title="Show in space">🔆</button>` : ""}
            </div>
          </div></div>`;
        }

        const subRows = rows.map(s => {
          const label = `${assetName.charAt(0).toUpperCase() + assetName.slice(1)} #${s.serial_number || 1}`;
          return `<div class="ap-row ap-serial-row">
            <div class="ap-row-info"><span class="ap-row-label ap-serial-label">${label}</span></div>
            <div class="ap-row-actions">
              ${canNav(s)
                ? `<button type="button" class="btn small secondary ap-highlight-btn"
                    data-name="${assetName}" data-sweep="${s.sweep_uuid}"
                    data-angle="${s.best_angle}" data-bbox='${bboxAttr(s)}'
                    data-serial="${s.serial_number || 1}" title="Show in space">🔆</button>`
                : `<span class="ap-no-loc" title="Location not recorded">—</span>`}
            </div>
          </div>`;
        }).join("");

        return `<div class="ap-asset-group">
          <div class="ap-asset-group-header">
            <span style="text-transform:capitalize; font-weight:600;">${assetName}</span>
            <span class="ap-count">${totalCount}</span>
          </div>${subRows}</div>`;
      }).join("");

      sicDetailRows.querySelectorAll(".ap-highlight-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const sweepUuid = btn.dataset.sweep;
          const angle     = parseFloat(btn.dataset.angle);
          const bbox      = JSON.parse(btn.dataset.bbox);
          const assetName = btn.dataset.name;
          const serial    = parseInt(btn.dataset.serial) || 1;
          await handleNavigate(sweepUuid);
          await sleep(1200);
          try { await rotateToYawAtCurrentSweep(angle, 0); } catch (_) {}
          if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
          showHighlightOverlay(`${assetName} #${serial}`, bbox, { segName: assetName, instanceIndex: serial - 1 });
        });
      });

      if (areaChipsEl) areaChipsEl.style.display = "none";
      if (sicDetail) sicDetail.style.display = "";
    }

    scannedInChatBody.querySelectorAll(".ap-area-chip").forEach(btn => {
      btn.addEventListener("click", () => showSicDetail(btn.dataset.area));
    });

    if (sicBack) {
      sicBack.addEventListener("click", () => {
        if (areaChipsEl) areaChipsEl.style.display = "";
        if (sicDetail)   sicDetail.style.display = "none";
      });
    }
  }

  if (scannedInChatClose) {
    scannedInChatClose.addEventListener("click", closeScannedInChat);
  }

  const showScannedBtn = document.getElementById("show-scanned-btn");
  if (showScannedBtn) {
    showScannedBtn.addEventListener("click", function () {
      if (scannedInChatOpen) closeScannedInChat(); else openScannedInChat();
    });
  }

  loadScanLocations();

  // ── In-viewer Assets Panel ────────────────────────────────────────────────

  const assetsPanelEl    = document.getElementById("assets-panel");
  const assetsPanelBody  = document.getElementById("assets-panel-body");
  const assetsPanelOpen  = document.getElementById("assets-panel-open");
  const assetsPanelClose = document.getElementById("assets-panel-close");

  // The Assets/Location panels dock bottom-right where the chat lives — hide the
  // chat while one is open so they don't overlap, and restore it once both close.
  function _hideChatForPanel() {
    const ch = document.getElementById("chat-panel");
    if (ch && ch.style.display !== "none") { ch.dataset.hiddenByPanel = "1"; ch.style.display = "none"; }
  }
  function _restoreChatIfNoPanel() {
    const assetsOpen = assetsPanelEl && assetsPanelEl.style.display !== "none";
    const locOpen = locationPanelEl && locationPanelEl.style.display !== "none";
    if (assetsOpen || locOpen) return;
    const ch = document.getElementById("chat-panel");
    if (ch && ch.dataset.hiddenByPanel === "1") { ch.style.display = ""; delete ch.dataset.hiddenByPanel; }
  }

  async function openAssetsPanel() {
    if (!assetsPanelEl) return;
    if (typeof closeLocationPanel === "function") closeLocationPanel();
    _hideChatForPanel();
    assetsPanelEl.style.display = "flex";
    await refreshAssetsPanel();
  }

  function closeAssetsPanel() {
    if (assetsPanelEl) assetsPanelEl.style.display = "none";
    _restoreChatIfNoPanel();
  }

  async function refreshAssetsPanel() {
    if (!assetsPanelBody) return;
    assetsPanelBody.innerHTML = '<div style="padding:1rem; color:var(--text-muted); font-size:0.85rem; text-align:center;">Loading…</div>';
    try {
      const res = await fetch(`/api/spaces/${mapId}/assets-panel`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) throw new Error(data.error || "Failed to load");
      renderAssetsPanel(data);
    } catch (err) {
      assetsPanelBody.innerHTML = `<div style="padding:1rem; color:var(--danger);">Error: ${err.message}</div>`;
    }
  }

  function renderAssetsPanel(data) {
    const summaries = data.scan_summaries || [];

    // Group summaries by area
    const areaMap = {};
    summaries.forEach(s => {
      const area = s.area_name || "Unspecified";
      if (!areaMap[area]) areaMap[area] = [];
      areaMap[area].push(s);
    });
    const areas = Object.keys(areaMap).sort();

    // Scanned inventory only — navigation locations live in the Location panel.
    let invHtml = `
      <div class="ap-section-title">🔍 Scanned Inventory
        <span class="ap-count">${summaries.length}</span>
      </div>`;

    if (areas.length) {
      invHtml += `
        <div id="ap-area-chips" class="ap-area-chips">
          ${areas.map(a => `
            <button type="button" class="ap-area-chip" data-area="${a}">
              ${a}<span class="ap-count">${areaMap[a].length}</span>
            </button>`).join("")}
        </div>
        <div id="ap-inv-detail" style="display:none;">
          <button type="button" id="ap-inv-back" class="btn ghost small" style="margin-bottom:0.5rem; width:100%;">← Back to areas</button>
          <div id="ap-inv-detail-rows"></div>
        </div>`;
    } else {
      invHtml += `<div class="ap-empty">No scanned inventory yet. Use Scan Area in the viewer.</div>`;
    }

    assetsPanelBody.innerHTML = invHtml;

    // ── Wire: area chips + detail drill-down ──
    const areaChipsEl  = assetsPanelBody.querySelector("#ap-area-chips");
    const invDetail    = assetsPanelBody.querySelector("#ap-inv-detail");
    const invDetailRows = assetsPanelBody.querySelector("#ap-inv-detail-rows");
    const invBack      = assetsPanelBody.querySelector("#ap-inv-back");

    async function showAreaDetail(area) {
      if (!invDetailRows) return;
      // Group rows by asset_name so we can render a header + serial sub-rows
      const rowsByAsset = {};
      (areaMap[area] || []).forEach(s => {
        const key = s.asset_name;
        if (!rowsByAsset[key]) rowsByAsset[key] = [];
        rowsByAsset[key].push(s);
      });

      invDetailRows.innerHTML = Object.entries(rowsByAsset).map(([assetName, rows]) => {
        // Sort by serial_number so they appear in order
        rows.sort((a, b) => (a.serial_number || 1) - (b.serial_number || 1));
        const totalCount = rows.reduce((sum, r) => sum + (r.count || 1), 0);
        const isLegacy = rows.length === 1 && !rows[0].serial_number;

        // Helper: can we navigate to this row's recorded position?
        const canNav = (s) => s.sweep_uuid && s.best_angle !== null && s.best_angle !== undefined;
        const bboxAttr = (s) => s.bbox ? JSON.stringify(s.bbox) : "null";

        if (isLegacy) {
          // Old-format row (count > 1, no serial numbers) — still make it clickable if data is present
          const s = rows[0];
          return `
          <div class="ap-asset-group">
            <div class="ap-row">
              <div class="ap-row-info">
                <span class="ap-row-label" style="text-transform:capitalize;">${assetName}</span>
              </div>
              <div class="ap-row-actions">
                <span class="ap-count">${totalCount}</span>
                ${canNav(s) ? `<button type="button" class="btn small secondary ap-highlight-btn"
                  data-name="${assetName}" data-sweep="${s.sweep_uuid}"
                  data-angle="${s.best_angle}" data-bbox='${bboxAttr(s)}'
                  title="Show in space">🔆</button>` : ""}
                <button type="button" class="btn small danger ap-delete-summary-btn" data-id="${s.id}" title="Delete">🗑</button>
              </div>
            </div>
          </div>`;
        }

        // New format: one row per instance with serial numbers
        const subRows = rows.map(s => {
          const label = `${assetName.charAt(0).toUpperCase() + assetName.slice(1)} #${s.serial_number || 1}`;
          return `
          <div class="ap-row ap-serial-row">
            <div class="ap-row-info">
              <span class="ap-row-label ap-serial-label">${label}</span>
            </div>
            <div class="ap-row-actions">
              ${canNav(s)
                ? `<button type="button" class="btn small secondary ap-highlight-btn"
                    data-name="${assetName}" data-sweep="${s.sweep_uuid}"
                    data-angle="${s.best_angle}" data-bbox='${bboxAttr(s)}'
                    data-serial="${s.serial_number || 1}"
                    title="Show ${label} in space">🔆</button>`
                : `<span class="ap-no-loc" title="Location not recorded">—</span>`}
              <button type="button" class="btn small danger ap-delete-summary-btn" data-id="${s.id}" title="Delete ${label}">🗑</button>
            </div>
          </div>`;
        }).join("");

        return `
        <div class="ap-asset-group">
          <div class="ap-asset-group-header">
            <span style="text-transform:capitalize; font-weight:600;">${assetName}</span>
            <span class="ap-count">${totalCount}</span>
          </div>
          ${subRows}
        </div>`;
      }).join("");

      // Wire: highlight button — navigate to stored sweep + rotate + show stored bbox
      invDetailRows.querySelectorAll(".ap-highlight-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const sweepUuid  = btn.dataset.sweep;
          const angle      = parseFloat(btn.dataset.angle);
          const bbox       = JSON.parse(btn.dataset.bbox);
          const assetName  = btn.dataset.name;
          const serial     = parseInt(btn.dataset.serial) || 1;

          // Keep the Assets panel open so multiple items can be highlighted
          // without re-opening Assets → location → item each time.
          await handleNavigate(sweepUuid);
          await sleep(1200);
          try { await rotateToYawAtCurrentSweep(angle, 0); } catch (_) {}
          if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
          showHighlightOverlay(`${assetName} #${serial}`, bbox, { segName: assetName, instanceIndex: serial - 1 });
        });
      });

      invDetailRows.querySelectorAll(".ap-delete-summary-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this scan entry?")) return;
          btn.disabled = true;
          try {
            const res = await fetch(`/api/spaces/${mapId}/scanned-assets/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
            const d = await res.json().catch(() => ({}));
            if (d.ok) await refreshAssetsPanel();
            else appendLine("system", "Delete failed: " + (d.error || "unknown"));
          } catch (e) { appendLine("system", "Delete error: " + e.message); }
        });
      });

      if (areaChipsEl) areaChipsEl.style.display = "none";
      if (invDetail)   invDetail.style.display = "";

      // Load and render scan history for this area
      try {
        const hRes = await fetch(`/api/spaces/${mapId}/scan-history?area=${encodeURIComponent(area)}`, { credentials: "same-origin" });
        const hData = await hRes.json().catch(() => ({}));
        if (hData.ok) {
          let hHtml = `<div class="ap-section-title" style="margin-top:0.75rem;">📜 Scan History</div>`;

          if (hData.diff && hData.diff.length) {
            hHtml += `<div class="ap-history-diff">`;
            hData.diff.forEach(ch => {
              const sign = ch.delta > 0 ? "+" : "";
              const cls  = ch.delta > 0 ? "diff-up" : "diff-down";
              hHtml += `<div class="ap-diff-row ${cls}">
                <span style="text-transform:capitalize;">${ch.item}</span>
                <span>${ch.previous} → ${ch.current} (<strong>${sign}${ch.delta}</strong>)</span>
              </div>`;
            });
            hHtml += `</div>`;
          } else if (hData.history && hData.history.length >= 2) {
            hHtml += `<div class="ap-empty">No changes since last scan.</div>`;
          }

          if (hData.history && hData.history.length) {
            hHtml += `<div class="ap-history-timeline">`;
            hData.history.forEach((rec, idx) => {
              const items = Object.entries(rec.snapshot || {})
                .map(([k, v]) => `${v} ${k}`).join(", ") || "—";
              hHtml += `<div class="ap-history-entry ${idx === 0 ? 'ap-history-entry--latest' : ''}">
                <span class="ap-history-date">${rec.scanned_at}</span>
                <span class="ap-history-items">${items}</span>
              </div>`;
            });
            hHtml += `</div>`;
          } else {
            hHtml += `<div class="ap-empty">No history yet — confirm a scan to start tracking.</div>`;
          }

          const historyEl = document.createElement("div");
          historyEl.innerHTML = hHtml;
          invDetailRows.appendChild(historyEl);
        }
      } catch (_) { /* history is optional, ignore errors */ }
    }

    assetsPanelBody.querySelectorAll(".ap-area-chip").forEach(chip => {
      chip.addEventListener("click", () => showAreaDetail(chip.dataset.area));
    });
    if (invBack) {
      invBack.addEventListener("click", () => {
        if (invDetail)   invDetail.style.display = "none";
        if (areaChipsEl) areaChipsEl.style.display = "";
      });
    }
  }

  if (assetsPanelOpen)  assetsPanelOpen.addEventListener("click", openAssetsPanel);
  if (assetsPanelClose) assetsPanelClose.addEventListener("click", closeAssetsPanel);

  const routeHudCancel = document.getElementById("route-hud-cancel");
  if (routeHudCancel) routeHudCancel.addEventListener("click", clearRoute);

  // ── In-viewer Location Panel — tag + CRUD + navigate ──────────────────────

  const locationPanelEl    = document.getElementById("location-panel");
  const locationListBody   = document.getElementById("location-list-body");
  const locationBtn        = document.getElementById("location-btn");
  const locationPanelClose = document.getElementById("location-panel-close");

  function _escAttr(s) { return String(s == null ? "" : s).replace(/"/g, "&quot;"); }

  async function openLocationPanel() {
    if (!locationPanelEl) return;
    closeAssetsPanel();                 // keep Locations and Assets separate
    _hideChatForPanel();
    locationPanelEl.style.display = "flex";
    const nameInput = document.getElementById("quick-asset-name");
    if (nameInput) setTimeout(() => nameInput.focus(), 0);
    await refreshLocationPanel();
  }
  function closeLocationPanel() {
    if (locationPanelEl) locationPanelEl.style.display = "none";
    _restoreChatIfNoPanel();
  }

  async function refreshLocationPanel() {
    if (!locationListBody) return;
    locationListBody.innerHTML = '<div class="ap-empty">Loading…</div>';
    try {
      const res = await fetch(`/api/spaces/${mapId}/assets`, { credentials: "same-origin" });
      const data = await res.json().catch(() => ({ assets: [] }));
      renderLocationList(data.assets || []);
    } catch (err) {
      locationListBody.innerHTML = `<div class="ap-empty" style="color:var(--danger);">Error: ${err.message}</div>`;
    }
  }

  function renderLocationList(assets) {
    if (!locationListBody) return;
    if (!assets.length) {
      locationListBody.innerHTML = `<div class="ap-empty">No locations yet. Tag the current spot above, or use Auto-Tag.</div>`;
      return;
    }
    const grouped = {};
    assets.forEach(a => { const c = a.category || "Uncategorized"; (grouped[c] = grouped[c] || []).push(a); });
    const cats = Object.keys(grouped).sort();

    let html = `<input type="text" id="loc-search" class="ap-search-input" placeholder="Search locations or categories…" autocomplete="off">`;
    html += `<div class="ap-section-title">📌 Tagged Locations <span class="ap-count">${assets.length}</span></div>`;
    html += cats.map(cat => `
      <div class="ap-group" data-cat="${_escAttr(cat.toLowerCase())}">
        <div class="ap-group-header ap-collapsible">
          <span class="ap-collapse-icon">▶</span>
          <span>${cat}</span>
          <span class="ap-count">${grouped[cat].length}</span>
        </div>
        <div class="ap-group-rows" style="display:none;">
          ${grouped[cat].map(a => `
            <div class="ap-row" data-label="${_escAttr(a.label_name.toLowerCase())}">
              <div class="ap-row-info">
                <span class="ap-row-label">${a.label_name}</span>
                ${a.sweep_uuid ? `<span class="ap-row-uuid">${a.sweep_uuid.slice(0, 12)}…</span>` : ""}
              </div>
              <div class="ap-row-actions">
                ${a.sweep_uuid ? `<button type="button" class="btn small secondary loc-nav-btn" data-uuid="${_escAttr(a.sweep_uuid)}" data-label="${_escAttr(a.label_name)}" title="Navigate here">▶</button>` : ""}
                <button type="button" class="btn small secondary loc-edit-btn" data-id="${a.asset_id}" data-label="${_escAttr(a.label_name)}" data-category="${_escAttr(a.category || "")}" title="Edit">✏️</button>
                <button type="button" class="btn small danger loc-delete-btn" data-id="${a.asset_id}" title="Delete">🗑</button>
              </div>
            </div>`).join("")}
        </div>
      </div>`).join("");

    locationListBody.innerHTML = html;
    _wireLocationList();
  }

  function _wireLocationList() {
    locationListBody.querySelectorAll(".ap-collapsible").forEach(header => {
      header.addEventListener("click", () => {
        const rows = header.nextElementSibling;
        const icon = header.querySelector(".ap-collapse-icon");
        const open = rows.style.display !== "none";
        rows.style.display = open ? "none" : "";
        if (icon) icon.textContent = open ? "▶" : "▼";
      });
    });

    const search = locationListBody.querySelector("#loc-search");
    if (search) {
      search.addEventListener("input", () => {
        const term = search.value.trim().toLowerCase();
        locationListBody.querySelectorAll(".ap-group").forEach(group => {
          const rows = group.querySelectorAll(".ap-row");
          const rowsC = group.querySelector(".ap-group-rows");
          const icon = group.querySelector(".ap-collapse-icon");
          if (!term) { rowsC.style.display = "none"; if (icon) icon.textContent = "▶"; group.style.display = ""; rows.forEach(r => r.style.display = ""); return; }
          const catMatch = group.dataset.cat.includes(term);
          let any = false;
          rows.forEach(r => { const m = catMatch || (r.dataset.label || "").includes(term); r.style.display = m ? "" : "none"; if (m) any = true; });
          group.style.display = any ? "" : "none";
          if (any) { rowsC.style.display = ""; if (icon) icon.textContent = "▼"; }
        });
      });
    }

    locationListBody.querySelectorAll(".loc-nav-btn").forEach(btn => {
      btn.addEventListener("click", () => navigateWithRoute(btn.dataset.uuid, btn.dataset.label || ""));
    });

    locationListBody.querySelectorAll(".loc-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this location?")) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/spaces/${mapId}/assets/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
          const d = await res.json().catch(() => ({}));
          if (d.ok) await _refreshLocationData();
          else appendLine("system", "Delete failed: " + (d.error || "unknown"));
        } catch (e) { appendLine("system", "Delete error: " + e.message); }
      });
    });

    locationListBody.querySelectorAll(".loc-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => _beginLocationEdit(btn));
    });
  }

  function _beginLocationEdit(btn) {
    const row = btn.closest(".ap-row");
    if (!row) return;
    const id = btn.dataset.id;
    row.innerHTML = `
      <div class="ap-edit-row">
        <input type="text" class="loc-edit-name" value="${_escAttr(btn.dataset.label || "")}" placeholder="Name">
        <input type="text" class="loc-edit-cat" value="${_escAttr(btn.dataset.category || "")}" placeholder="Category">
        <div class="ap-edit-actions">
          <button type="button" class="btn small success loc-edit-save">✓ Save</button>
          <button type="button" class="btn small ghost loc-edit-cancel">Cancel</button>
        </div>
      </div>`;
    const nameI = row.querySelector(".loc-edit-name");
    if (nameI) nameI.focus();
    row.querySelector(".loc-edit-cancel").addEventListener("click", () => refreshLocationPanel());
    row.querySelector(".loc-edit-save").addEventListener("click", async () => {
      const newName = (row.querySelector(".loc-edit-name").value || "").trim();
      const newCat  = (row.querySelector(".loc-edit-cat").value || "").trim();
      if (!newName) { appendLine("system", "Location name can't be empty."); return; }
      try {
        const res = await fetch(`/api/spaces/${mapId}/assets/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ label_name: newName, category: newCat }),
        });
        const d = await res.json().catch(() => ({}));
        if (d.ok) await _refreshLocationData();
        else appendLine("system", "Update failed: " + (d.error || "unknown"));
      } catch (e) { appendLine("system", "Update error: " + e.message); }
    });
  }

  if (locationBtn) locationBtn.addEventListener("click", function () {
    if (locationPanelEl && locationPanelEl.style.display !== "none") closeLocationPanel();
    else openLocationPanel();
  });
  if (locationPanelClose) locationPanelClose.addEventListener("click", closeLocationPanel);

  // ── Shared helper: refresh scan-location dropdown + panels ──────────────────

  async function _refreshLocationData() {
    await loadScanLocations();
    try {
      const r = await fetch(`/api/spaces/${mapId}/assets`, { credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      _buildTaggedSweepMap(d.assets || []);
    } catch (_) {}
    if (assetsPanelEl && assetsPanelEl.style.display !== "none") {
      await refreshAssetsPanel();
    }
    if (locationPanelEl && locationPanelEl.style.display !== "none") {
      await refreshLocationPanel();
    }
  }

  // ── Floor Plan Minimap ───────────────────────────────────────────────────────

  const minimapPanel      = document.getElementById("minimap-popup");
  const minimapCanvas     = document.getElementById("minimap-canvas");
  const minimapOpenBtn    = document.getElementById("minimap-open-btn");
  const minimapCloseBtn   = document.getElementById("minimap-close-btn");
  const minimapExportBtn  = document.getElementById("minimap-export-btn");
  const minimapFloorSel   = document.getElementById("minimap-floor-select");
  const exportModal       = document.getElementById("floorplan-export-modal");
  const exportCanvas      = document.getElementById("export-canvas");
  const exportPngBtn      = document.getElementById("export-png-btn");
  const exportPdfBtn      = document.getElementById("export-pdf-btn");
  const exportModalClose  = document.getElementById("export-modal-close");

  const CATEGORY_COLORS = {
    "kitchen":       "#f97316",
    "bedroom":       "#818cf8",
    "bathroom":      "#22d3ee",
    "living room":   "#a78bfa",
    "office":        "#60a5fa",
    "dining room":   "#f472b6",
    "hallway":       "#94a3b8",
    "conference":    "#fbbf24",
    "lobby":         "#34d399",
  };

  function getCategoryColor(category) {
    if (!category) return "#0070f3";
    return CATEGORY_COLORS[category.toLowerCase()] || "#0070f3";
  }

  function _updateSweepDisplay() {
    var el = document.getElementById("sweep-display");
    if (!el) return;
    var info = taggedSweepMap[currentSweepUuid];
    if (info) {
      el.textContent = info.label_name + (info.category ? " (" + info.category + ")" : "");
    } else {
      el.textContent = currentSweepUuid || "Detecting location…";
    }
  }

  function _buildTaggedSweepMap(assets) {
    taggedSweepMap = {};
    (assets || []).forEach(function (a) {
      if (a.sweep_uuid) {
        taggedSweepMap[a.sweep_uuid] = { label_name: a.label_name, category: a.category };
      }
    });
    _updateSweepDisplay();
  }

  function _getVisibleSweeps() {
    var sweeps = Object.entries(allSweepData)
      .filter(function (_a) { var s = _a[1]; return s && s.position; })
      .map(function (_a) { var id = _a[0], s = _a[1]; return Object.assign({ id: id }, s); });
    if (currentFloorId !== null) {
      sweeps = sweeps.filter(function (s) { return s.floorInfo && s.floorInfo.id === currentFloorId; });
    }
    return sweeps;
  }

  function _computeProjection(sweeps, canvasW, canvasH, padding) {
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    sweeps.forEach(function (s) {
      if (s.position.x < minX) minX = s.position.x;
      if (s.position.x > maxX) maxX = s.position.x;
      if (s.position.z < minZ) minZ = s.position.z;
      if (s.position.z > maxZ) maxZ = s.position.z;
    });
    var rangeX  = maxX - minX || 1;
    var rangeZ  = maxZ - minZ || 1;
    var usableW = canvasW - padding * 2;
    var usableH = canvasH - padding * 2;
    var scale   = Math.min(usableW / rangeX, usableH / rangeZ);
    var offsetX = padding + (usableW - rangeX * scale) / 2;
    var offsetZ = padding + (usableH - rangeZ * scale) / 2;
    return {
      toCanvas: function (pos) {
        return {
          x: offsetX + (pos.x - minX) * scale,
          y: offsetZ + (pos.z - minZ) * scale,
        };
      },
      scale: scale,
    };
  }

  function _drawFloorPlan(ctx, sweeps, proj, dotR, showLabels, labelPx, highlightUuid) {
    // Neighbor edges (subtle path lines)
    var drawnEdges = {};
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.10)";
    ctx.lineWidth   = Math.max(0.5, dotR * 0.25);
    sweeps.forEach(function (s) {
      if (!s.neighbors) return;
      var from = proj.toCanvas(s.position);
      s.neighbors.forEach(function (nid) {
        var edgeKey = s.id < nid ? s.id + "|" + nid : nid + "|" + s.id;
        if (drawnEdges[edgeKey]) return;
        drawnEdges[edgeKey] = true;
        var ns = allSweepData[nid];
        if (!ns || !ns.position) return;
        var to = proj.toCanvas(ns.position);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      });
    });
    ctx.restore();

    // Sweeps (tagged → colored, untagged → dim white)
    sweeps.forEach(function (s) {
      if (s.id === highlightUuid) return; // drawn last
      var pt  = proj.toCanvas(s.position);
      var tag = taggedSweepMap[s.id];
      if (tag) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, dotR * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = getCategoryColor(tag.category);
        ctx.fill();
        if (showLabels) {
          var lbl = tag.label_name.length > 15 ? tag.label_name.slice(0, 13) + "…" : tag.label_name;
          ctx.save();
          ctx.font        = "600 " + labelPx + "px Inter,sans-serif";
          ctx.textAlign   = "center";
          ctx.fillStyle   = "#111111";
          ctx.shadowColor = "rgba(255,255,255,0.95)";
          ctx.shadowBlur  = 4;
          ctx.fillText(lbl, pt.x, pt.y - dotR * 1.5 - 3);
          ctx.restore();
        }
      } else {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.fill();
      }
    });

    // Current-position dot with pulsing ring
    if (highlightUuid && allSweepData[highlightUuid] && allSweepData[highlightUuid].position) {
      var pt2  = proj.toCanvas(allSweepData[highlightUuid].position);
      var pulseR = dotR * 2.8 + minimapPulse * dotR * 2.5;
      ctx.beginPath();
      ctx.arc(pt2.x, pt2.y, pulseR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,112,243," + (0.28 * (1 - minimapPulse)) + ")";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pt2.x, pt2.y, dotR * 2, 0, Math.PI * 2);
      ctx.fillStyle = "#0070f3";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pt2.x, pt2.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
  }

  // Draw the active route as a glowing blue path + amber destination pin.
  // Called from renderMinimap after _drawFloorPlan so it renders on top.
  function _drawRouteOverlay(ctx, proj, dotR) {
    if (!activeRoute || !activeRoute.path || activeRoute.path.length < 2) return;

    const path  = activeRoute.path;
    const step  = activeRoute.step || 0;

    // ── 1. Glow path line ────────────────────────────────────────────────────
    // Passed segment (dimmer blue)
    ctx.save();
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.lineWidth   = Math.max(2, dotR * 1.4);
    ctx.strokeStyle = "rgba(59,130,246,0.35)";
    ctx.shadowColor = "#3b82f6";
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= Math.min(step, path.length - 1); i++) {
      const sd = allSweepData[path[i]];
      if (!sd || !sd.position) { started = false; continue; }
      const pt = proj.toCanvas(sd.position);
      if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();

    // Upcoming segment (bright blue glow)
    ctx.strokeStyle = "#3b82f6";
    ctx.shadowBlur  = 12;
    ctx.lineWidth   = Math.max(2.5, dotR * 1.6);
    ctx.beginPath();
    started = false;
    for (let i = Math.max(0, step); i < path.length; i++) {
      const sd = allSweepData[path[i]];
      if (!sd || !sd.position) { started = false; continue; }
      const pt = proj.toCanvas(sd.position);
      if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    ctx.restore();

    // ── 2. Waypoint dots (skip start & destination) ─────────────────────────
    for (let i = 1; i < path.length - 1; i++) {
      const sd = allSweepData[path[i]];
      if (!sd || !sd.position) continue;
      const pt      = proj.toCanvas(sd.position);
      const passed  = i < step;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotR * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = passed ? "rgba(59,130,246,0.45)" : "#3b82f6";
      ctx.fill();
    }

    // ── 3. Destination pin (amber) ──────────────────────────────────────────
    const destSd = allSweepData[activeRoute.target];
    if (destSd && destSd.position) {
      const pt = proj.toCanvas(destSd.position);
      ctx.save();
      ctx.shadowColor = "#f59e0b";
      ctx.shadowBlur  = 16;
      // outer ring
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotR * 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(245,158,11,0.25)";
      ctx.fill();
      // pin dot
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotR * 2, 0, Math.PI * 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      // white centre
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotR * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
    }

    // ── 4. Destination label ─────────────────────────────────────────────────
    if (destSd && destSd.position) {
      const pt  = proj.toCanvas(destSd.position);
      const lbl = activeRoute.label.length > 16
        ? activeRoute.label.slice(0, 14) + "…"
        : activeRoute.label;
      ctx.save();
      ctx.font        = "bold 9px Inter,sans-serif";
      ctx.textAlign   = "center";
      ctx.fillStyle   = "#f59e0b";
      ctx.shadowColor = "rgba(0,0,0,0.95)";
      ctx.shadowBlur  = 5;
      ctx.fillText(lbl, pt.x, pt.y - dotR * 3 - 3);
      ctx.restore();
    }
  }

  function renderMinimap() {
    if (!minimapCanvas) return;
    var sweeps = _getVisibleSweeps();
    var ctx    = minimapCanvas.getContext("2d");
    var W = minimapCanvas.width, H = minimapCanvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!sweeps.length) {
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for SDK data…", W / 2, H / 2);
      return;
    }

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, W, H);

    var proj = _computeProjection(sweeps, W, H, 20);
    _drawFloorPlan(ctx, sweeps, proj, 3, true, 8, currentSweepUuid);
    _drawRouteOverlay(ctx, proj, 3);

    // Floor label if multiple floors exist
    var floorKeys = Object.keys(floorDataMap);
    if (floorKeys.length > 1) {
      var floorName = currentFloorId !== null
        ? (floorDataMap[Object.keys(floorDataMap).find(function (k) { return floorDataMap[k].id === currentFloorId; })] || {}).name || ("Floor " + currentFloorId)
        : "All floors";
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(floorName, 5, H - 5);
    }
  }

  var _minimapRafId = null;

  function _startMinimapLoop() {
    if (_minimapRafId !== null) return;
    (function loop() {
      minimapPulse = (minimapPulse + 0.025) % 1;
      renderMinimap();
      _minimapRafId = requestAnimationFrame(loop);
    })();
  }

  function _stopMinimapLoop() {
    if (_minimapRafId !== null) {
      cancelAnimationFrame(_minimapRafId);
      _minimapRafId = null;
    }
  }

  function _populateFloorSelect(floors) {
    if (!minimapFloorSel) return;
    var floorList = Object.values(floors);
    if (floorList.length <= 1) { minimapFloorSel.style.display = "none"; return; }
    minimapFloorSel.style.display = "";
    minimapFloorSel.innerHTML = '<option value="">All floors</option>';
    floorList.sort(function (a, b) { return (a.sequence || 0) - (b.sequence || 0); }).forEach(function (f) {
      var opt = document.createElement("option");
      opt.value       = f.id;
      opt.textContent = f.name || ("Floor " + ((f.sequence || 0) + 1));
      minimapFloorSel.appendChild(opt);
    });
  }

  async function initMinimap() {
    if (!sdk || !minimapCanvas) return;

    // Load assets for label overlay
    try {
      var r = await fetch("/api/spaces/" + mapId + "/assets", { credentials: "same-origin" });
      var d = await r.json().catch(function () { return {}; });
      _buildTaggedSweepMap(d.assets || []);
    } catch (e) { console.warn("[3DAgent Minimap] Could not load assets:", e); }

    // Primary source: sdk.Model.getData() gives full sweep positions.
    // The model may not be ready immediately after SDK connect, so we retry.
    async function _loadFromModel() {
      if (!sdk.Model || typeof sdk.Model.getData !== "function") return false;
      try {
        var modelData = await sdk.Model.getData();
        var sweeps = (modelData && Array.isArray(modelData.sweeps)) ? modelData.sweeps : [];
        if (!sweeps.length) return false;
        sweeps.forEach(function (s) {
          var id = s.sid || s.uuid;
          if (!id || !s.position) return;
          allSweepData[id] = {
            sid:       id,
            position:  s.position,
            neighbors: s.neighbors || [],
            floorInfo: s.floorInfo || null,
          };
        });
        console.log("[3DAgent Minimap] Loaded " + Object.keys(allSweepData).length + " sweeps from Model.getData()");
        return Object.keys(allSweepData).length > 0;
      } catch (e) {
        console.warn("[3DAgent Minimap] Model.getData() failed:", e);
        return false;
      }
    }

    // Try immediately, then retry at 2 s, 5 s, 10 s intervals
    var got = await _loadFromModel();
    if (!got) {
      var delays = [2000, 5000, 10000];
      for (var i = 0; i < delays.length; i++) {
        await new Promise(function (res) { setTimeout(res, delays[i]); });
        got = await _loadFromModel();
        if (got) break;
      }
    }

    // Supplementary: sdk.Sweep.data fills in any sweeps Model.getData() missed
    // and provides real-time connectivity updates
    try {
      if (sdk.Sweep && sdk.Sweep.data && typeof sdk.Sweep.data.subscribe === "function") {
        sdk.Sweep.data.subscribe(function (sweepMap) {
          Object.entries(sweepMap || {}).forEach(function (_a) {
            var id = _a[0], s = _a[1];
            if (!s) return;
            if (!allSweepData[id]) allSweepData[id] = { sid: id };
            // Only fill in position if we don't already have one from Model.getData()
            if (s.position && !allSweepData[id].position) allSweepData[id].position = s.position;
            if (s.neighbors)  allSweepData[id].neighbors = s.neighbors;
            if (s.floorInfo)  allSweepData[id].floorInfo = s.floorInfo;
          });
        });
      }
    } catch (e) { console.warn("[3DAgent Minimap] Sweep.data subscribe failed:", e); }

    // Floor data for the floor-filter dropdown
    try {
      if (sdk.Floor && sdk.Floor.data && typeof sdk.Floor.data.subscribe === "function") {
        sdk.Floor.data.subscribe(function (floorMap) {
          floorDataMap = {};
          Object.entries(floorMap || {}).forEach(function (_a) { floorDataMap[_a[0]] = _a[1]; });
          _populateFloorSelect(floorDataMap);
          // Default the minimap to a single floor so stacked floors don't overlap.
          if (currentFloorId === null && Object.keys(floorDataMap).length > 1) {
            var cur = _currentFloorId();
            if (cur != null) {
              currentFloorId = cur;
              if (minimapFloorSel) minimapFloorSel.value = String(cur);
            }
          }
        });
      }
    } catch (e) { console.warn("[3DAgent Minimap] Floor.data subscribe failed:", e); }
  }

  // Open minimap popup (🗺 button in uuid-tracker header)
  if (minimapOpenBtn) {
    minimapOpenBtn.addEventListener("click", function () {
      if (!minimapPanel) return;
      var isOpen = minimapPanel.style.display !== "none";
      if (isOpen) {
        minimapPanel.style.display = "none";
        _stopMinimapLoop();
      } else {
        minimapPanel.style.display = "block";
        _startMinimapLoop();
      }
    });
  }

  // Close minimap popup (✕ inside popup header)
  if (minimapCloseBtn) {
    minimapCloseBtn.addEventListener("click", function () {
      if (minimapPanel) minimapPanel.style.display = "none";
      _stopMinimapLoop();
    });
  }

  // Floor filter
  if (minimapFloorSel) {
    minimapFloorSel.addEventListener("change", function () {
      var val = minimapFloorSel.value;
      currentFloorId = val === "" ? null : parseInt(val, 10);
    });
  }

  // Open export modal
  if (minimapExportBtn) {
    minimapExportBtn.addEventListener("click", function () { openExportModal(); });
  }

  // Open the annotated floor-plan modal from the Export popover
  var exportFloorplanBtn = document.getElementById("export-floorplan-btn");
  if (exportFloorplanBtn) {
    exportFloorplanBtn.addEventListener("click", function () {
      var pop = document.getElementById("export-popover");
      if (pop) pop.style.display = "none";
      openExportModal();
    });
  }

  // Close export modal
  if (exportModalClose) {
    exportModalClose.addEventListener("click", function () {
      if (exportModal) exportModal.style.display = "none";
    });
  }
  if (exportModal) {
    exportModal.addEventListener("click", function (e) {
      if (e.target === exportModal) exportModal.style.display = "none";
    });
  }

  function openExportModal() {
    if (!exportModal || !exportCanvas) return;
    renderExportCanvas();
    exportModal.style.display = "flex";
  }

  function renderExportCanvas() {
    if (!exportCanvas) return;
    var sweeps = _getVisibleSweeps();
    var ctx    = exportCanvas.getContext("2d");
    var W = exportCanvas.width, H = exportCanvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    var HEADER = 64, FOOTER = 48;

    if (!sweeps.length) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.font = "18px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No floor plan data available yet.", W / 2, H / 2 - 10);
      ctx.font = "13px Inter,sans-serif";
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillText("Navigate the space first so the SDK loads sweep positions.", W / 2, H / 2 + 16);
    } else {
      // Compute projection into the body area (below header, above footer)
      var bodyH = H - HEADER - FOOTER;
      var proj  = _computeProjection(sweeps, W, bodyH, 50);
      var shiftedProj = {
        toCanvas: function (pos) {
          var c = proj.toCanvas(pos);
          return { x: c.x, y: c.y + HEADER };
        },
        scale: proj.scale,
      };
      _drawFloorPlan(ctx, sweeps, shiftedProj, 6, true, 12, null);

      // Category legend
      var seen = {};
      Object.values(taggedSweepMap).forEach(function (t) {
        if (t.category && !seen[t.category]) { seen[t.category] = true; }
      });
      var cats = Object.keys(seen);
      if (cats.length) {
        var lx = 20, ly = H - FOOTER + 16;
        ctx.font = "11px Inter,sans-serif";
        ctx.textAlign = "left";
        cats.forEach(function (cat) {
          ctx.beginPath();
          ctx.arc(lx + 5, ly, 5, 0, Math.PI * 2);
          ctx.fillStyle = getCategoryColor(cat);
          ctx.fill();
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillText(cat, lx + 14, ly + 4);
          lx += ctx.measureText(cat).width + 32;
        });
      }
    }

    // Header title
    ctx.fillStyle = "#111111";
    ctx.font = "bold 20px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Annotated Floor Plan", W / 2, 36);

    // Footer timestamp
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.font = "11px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Generated: " + new Date().toLocaleString(), W / 2, H - 14);
  }

  // PNG download
  if (exportPngBtn) {
    exportPngBtn.addEventListener("click", function () {
      if (!exportCanvas) return;
      var link = document.createElement("a");
      link.download = "floorplan.png";
      link.href = exportCanvas.toDataURL("image/png");
      link.click();
    });
  }

  // PDF download (server-side wrapping)
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener("click", async function () {
      if (!exportCanvas) return;
      exportPdfBtn.disabled = true;
      exportPdfBtn.textContent = "Generating PDF…";
      try {
        var imgData = exportCanvas.toDataURL("image/png");
        var res = await fetch("/api/export/floorplan-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ map_id: mapId, image_base64: imgData, title: "Annotated Floor Plan" }),
        });
        if (!res.ok) throw new Error("Server returned " + res.status);
        var blob = await res.blob();
        var url  = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href     = url;
        link.download = "floorplan.pdf";
        link.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        appendLine("system", "PDF export failed: " + e.message);
      } finally {
        exportPdfBtn.disabled = false;
        exportPdfBtn.textContent = "📄 Download PDF";
      }
    });
  }

  // ── Where am I: mark-suggestion UI ─────────────────────────────────────────

  async function doMarkLocation(name, sweepUuid, wrapper) {
    const textEl = wrapper.querySelector(".wai-text");
    const actionsEl = wrapper.querySelector(".wai-actions");
    const editAreaEl = wrapper.querySelector(".wai-edit-area");

    textEl.textContent = `Marking current location as "${name}"…`;
    if (actionsEl) actionsEl.style.display = "none";
    if (editAreaEl) editAreaEl.style.display = "none";

    try {
      const res = await fetch("/api/mark-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ map_id: mapId, asset_name: name, sweep_uuid: sweepUuid }),
      });
      const d = await res.json().catch(() => ({ ok: false }));
      if (d.ok) {
        textEl.textContent = `✓ Location marked as "${name}"!`;
        await _refreshLocationData();
      } else {
        textEl.textContent = `Failed to mark: ${d.error || "unknown error"}`;
      }
    } catch (e) {
      textEl.textContent = `Error: ${e.message}`;
    }
  }

  function showMarkSuggestion(suggestedName, sweepUuid) {
    const wrapper = document.createElement("div");
    wrapper.className = "msg msg-agent";

    const baseText = suggestedName
      ? `Current sweep has not yet been marked. Based on my view, this looks like "${suggestedName}". Do you want to mark it as "${suggestedName}"?`
      : "Current sweep has not yet been marked. I couldn't identify the location from the view. Would you like to give it a name?";

    wrapper.innerHTML = `
      <div class="wai-text">${baseText}</div>
      <div class="wai-actions">
        ${suggestedName ? `<button type="button" class="btn small primary wai-yes">Yes, mark as "${suggestedName}"</button>` : ""}
        <button type="button" class="btn small secondary wai-edit">Edit name</button>
        <button type="button" class="btn small ghost wai-no">No</button>
      </div>
      <div class="wai-edit-area" style="display:none;">
        <input type="text" class="wai-name-input" placeholder="Enter location name…" value="${suggestedName || ""}">
        <div class="wai-edit-actions">
          <button type="button" class="btn small primary wai-confirm">Confirm</button>
          <button type="button" class="btn small ghost wai-cancel">Cancel</button>
        </div>
      </div>
    `;

    logEl.appendChild(wrapper);
    logEl.scrollTop = logEl.scrollHeight;

    const actionsEl = wrapper.querySelector(".wai-actions");
    const editAreaEl = wrapper.querySelector(".wai-edit-area");
    const nameInput = wrapper.querySelector(".wai-name-input");

    const yesBtn = wrapper.querySelector(".wai-yes");
    if (yesBtn) {
      yesBtn.addEventListener("click", function () {
        doMarkLocation(suggestedName, sweepUuid, wrapper);
      });
    }

    wrapper.querySelector(".wai-edit").addEventListener("click", function () {
      actionsEl.style.display = "none";
      editAreaEl.style.display = "";
      nameInput.focus();
      nameInput.select();
    });

    wrapper.querySelector(".wai-no").addEventListener("click", function () {
      wrapper.querySelector(".wai-text").textContent = "Understood, current sweep left unmarked.";
      actionsEl.style.display = "none";
    });

    wrapper.querySelector(".wai-confirm").addEventListener("click", function () {
      const customName = nameInput.value.trim();
      if (!customName) { nameInput.focus(); return; }
      doMarkLocation(customName, sweepUuid, wrapper);
    });

    wrapper.querySelector(".wai-cancel").addEventListener("click", function () {
      editAreaEl.style.display = "none";
      actionsEl.style.display = "";
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    const message = (input.value || "").trim();
    if (!message) {
      return;
    }
    input.value = "";
    appendLine("user", message);

    try {
      let data = await postVla({ message: message, map_id: mapId, current_sweep_uuid: currentSweepUuid });

      if (data.intent === "where_am_i") {
        if (data.found) {
          appendLine("agent", data.response || `You are currently in ${data.label}.`);
        } else if (data.needs_capture) {
          appendLine("system", "Capturing current view to identify your location…");
          let imageBase64;
          try {
            imageBase64 = await captureViewportBase64();
          } catch (err) {
            appendLine("system", "Could not capture view: " + err.message);
            appendLine("agent", "Current sweep is not yet marked. Navigate to a location and say 'mark this as [name]' to tag it.");
            return;
          }
          data = await postVla({
            message: message,
            map_id: mapId,
            current_sweep_uuid: currentSweepUuid,
            image_base64: imageBase64,
            intent_override: "where_am_i",
          });
          showMarkSuggestion(data.suggested_name || null, data.current_sweep_uuid || currentSweepUuid);
        }
        return;
      }

      if (data.needs_capture && data.intent === "visual") {
        appendLine("system", "Capturing view for vision…");
        let imageBase64;
        try {
          imageBase64 = await captureViewportBase64();
        } catch (err) {
          appendLine("system", "Could not capture: " + err.message);
          return;
        }
        data = await postVla({
          message: message,
          map_id: mapId,
          image_base64: imageBase64,
        });
      }

      if (data.intent === "react_query") {
        await handleReactQuery(data);
      } else if (data.intent === "mark_asset" && data.asset_name) {
        appendLine("system", `Marking current location as '${data.asset_name}'...`);
        try {
          const markResult = await markAsset(data.asset_name);
          appendLine("agent", markResult.message || `✓ Location marked as '${data.asset_name}'!`);
          await _refreshLocationData();
        } catch (err) {
          appendLine("system", "Marking failed: " + (err.message || String(err)));
        }
      } else if (data.intent === "navigate" && data.sweep_uuid) {
        appendLine("agent", "Navigating to " + (data.label || "destination") + "…");
        await navigateWithRoute(data.sweep_uuid, data.label || "destination");
      } else if (data.intent === "navigate_asset" && data.instances?.length) {
        const nearest = findNearestAssetInstance(data.instances);
        if (nearest && nearest.sweep_uuid) {
          const label = nearest.area_name
            ? `${data.asset_name} in ${nearest.area_name}`
            : data.asset_name;
          appendLine("agent", `Navigating to ${label}…`);
          await navigateWithRoute(nearest.sweep_uuid, label);
          if (nearest.best_angle != null) {
            await sleep(1200);
            try { await rotateToYawAtCurrentSweep(nearest.best_angle, 0); } catch (_) {}
          }
          if (nearest.bbox_json) {
            if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
            showHighlightOverlay(data.asset_name, nearest.bbox_json, { segName: data.asset_name });
          }
        } else {
          appendLine("agent", `Found ${data.instances.length} ${data.asset_name}(s) but no location data is saved. Use the Assets panel to navigate manually.`);
        }
      } else if (data.intent === "report_issue") {
        appendLine("agent", data.response || "Maintenance report logged.");
        if (data.navigate && data.navigate.sweep_uuid) {
          await handleNavigate(data.navigate.sweep_uuid);
          await sleep(1400);
          await _highlightReportedAsset(data.navigate.sweep_uuid, data.navigate.equipment_name);
        }
      } else if (data.intent === "scan_area") {
        appendLine("agent", data.response || "Opening the scanner…");
        const b = document.getElementById("scan-area-btn"); if (b) b.click();
      } else if (data.intent === "auto_tag") {
        appendLine("agent", data.response || "Opening Auto-Tag…");
        const b = document.getElementById("auto-tag-btn"); if (b) b.click();
      } else if (data.intent === "show_floorplan") {
        appendLine("agent", data.response || "Opening the floor plan…");
        const mp = document.getElementById("minimap-popup");
        const ob = document.getElementById("minimap-open-btn");
        if (ob && mp && mp.style.display !== "block") ob.click();
      } else if (data.response) {
        appendLine("agent", data.response);
      } else {
        appendLine("agent", JSON.stringify(data));
      }
    } catch (err) {
      appendLine("system", err.message || String(err));
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
     SHOWCASE VISUALS — Live HUD · X-Ray Vision · Health Map · Auto-Tour
     Self-contained: reuses the SDK helpers, scan API and sweep data above.
     ══════════════════════════════════════════════════════════════════════ */

  const SEV_RANK  = { critical: 4, high: 3, medium: 2, low: 1 };
  const SEV_COLOR = {
    critical: { r: 0.86, g: 0.15, b: 0.15 },
    high:     { r: 0.96, g: 0.45, b: 0.13 },
    medium:   { r: 0.98, g: 0.75, b: 0.14 },
    low:      { r: 0.20, g: 0.60, b: 0.86 },
  };
  const SEV_COLOR_OK = { r: 0.063, g: 0.639, b: 0.498 };

  async function _fetchJson(url, fallback) {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      const data = await res.json().catch(() => fallback);
      return data || fallback;
    } catch (_) { return fallback; }
  }
  function _loadAssetsPanel() {
    return _fetchJson(`/api/spaces/${mapId}/assets-panel`, { assets: [], scan_summaries: [] });
  }
  async function _loadProblems() {
    const data = await _fetchJson(`/api/spaces/${mapId}/problem-assets`, { problems: [] });
    const list = data.problems || [];
    const bySweep = {};
    list.forEach((p) => { if (p.sweep_uuid) (bySweep[p.sweep_uuid] = bySweep[p.sweep_uuid] || []).push(p); });
    return { list, bySweep };
  }
  function _worstSeverity(problems) {
    let worst = null, wr = 0;
    (problems || []).forEach((p) => { const r = SEV_RANK[p.severity] || 2; if (r > wr) { wr = r; worst = p.severity; } });
    return worst;
  }

  // ── Live Glass HUD ───────────────────────────────────────────────────────
  const hudEl     = document.getElementById("live-hud");
  const hudRoomEl = document.getElementById("live-hud-room");
  const hudAssetsEl = document.getElementById("live-hud-assets");
  const hudRoomsEl  = document.getElementById("live-hud-rooms");
  const hudHealthEl = document.getElementById("live-hud-health");

  function _animateNum(el, to) {
    if (!el) return;
    const from = parseInt(el.textContent, 10) || 0;
    if (from === to) { el.textContent = String(to); return; }
    const dur = 600, t0 = performance.now();
    function tick(t) {
      const k = Math.min(1, (t - t0) / dur);
      el.textContent = String(Math.round(from + (to - from) * k));
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  function updateHudRoom() {
    if (!hudRoomEl) return;
    const info = taggedSweepMap[currentSweepUuid];
    hudRoomEl.textContent = info ? info.label_name : (currentSweepUuid ? "Unmapped area" : "Detecting…");
  }
  async function refreshHudStats() {
    if (!hudEl) return;
    const [panel, problems] = await Promise.all([_loadAssetsPanel(), _loadProblems()]);
    const totalAssets = (panel.scan_summaries || []).reduce((s, r) => s + (r.count || 0), 0);
    const rooms = (panel.assets || []).filter((a) => a.sweep_uuid).length;
    const probCount = problems.list.length;
    const worstRank = problems.list.reduce((m, p) => Math.max(m, SEV_RANK[p.severity] || 2), 0);
    _animateNum(hudAssetsEl, totalAssets);
    _animateNum(hudRoomsEl, rooms);
    if (hudHealthEl) {
      hudHealthEl.textContent = probCount === 0 ? "OK" : String(probCount);
      hudHealthEl.className = "live-hud-stat-num live-hud-health " +
        (probCount === 0 ? "is-ok" : worstRank >= 3 ? "is-bad" : "is-warn");
    }
  }

  // ── X-Ray Asset Vision ───────────────────────────────────────────────────
  const xrayOverlay = document.getElementById("xray-overlay");
  const xraySvg     = document.getElementById("xray-svg");
  const xrayChips   = document.getElementById("xray-chips");
  const xrayHudText = document.getElementById("xray-hud-text");
  const SVG_NS = "http://www.w3.org/2000/svg";
  let xrayActive = false;

  function _setXrayBtn(on) {
    const b = document.getElementById("xray-btn");
    const l = document.getElementById("xray-label");
    if (b) b.classList.toggle("is-active", on);
    if (l) l.textContent = on ? "Exit X-Ray" : "X-Ray Vision";
  }
  function _clearXrayDraw() {
    if (xraySvg) while (xraySvg.firstChild) xraySvg.removeChild(xraySvg.firstChild);
    if (xrayChips) xrayChips.innerHTML = "";
  }
  function closeXray() {
    xrayActive = false;
    if (xrayOverlay) xrayOverlay.style.display = "none";
    _clearXrayDraw();
    _setXrayBtn(false);
  }
  function _drawXray(positionsAll, counts) {
    _clearXrayDraw();
    let drawn = 0;
    Object.keys(positionsAll || {}).forEach((name) => {
      (positionsAll[name] || []).forEach((b, i) => {
        if (drawn >= 40 || !b || b.length !== 4) return;
        const [x1, y1, x2, y2] = b;
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", (x1 * 1000).toFixed(1));
        rect.setAttribute("y", (y1 * 1000).toFixed(1));
        rect.setAttribute("width",  ((x2 - x1) * 1000).toFixed(1));
        rect.setAttribute("height", ((y2 - y1) * 1000).toFixed(1));
        rect.setAttribute("rx", "8");
        rect.style.animationDelay = (drawn * 40) + "ms";
        xraySvg.appendChild(rect);
        const chip = document.createElement("div");
        chip.className = "xray-chip";
        chip.style.left = (((x1 + x2) / 2) * 100).toFixed(2) + "%";
        chip.style.top  = (y1 * 100).toFixed(2) + "%";
        chip.style.animationDelay = (drawn * 40 + 120) + "ms";
        chip.innerHTML = name + ((counts[name] || 0) > 1 ? `<span class="xray-chip-n">#${i + 1}</span>` : "");
        xrayChips.appendChild(chip);
        drawn++;
      });
    });
    const totalItems = Object.values(counts || {}).reduce((s, c) => s + c, 0);
    const totalTypes = Object.keys(counts || {}).length;
    if (xrayHudText) {
      xrayHudText.textContent = totalItems
        ? `${totalItems} asset${totalItems > 1 ? "s" : ""} · ${totalTypes} type${totalTypes > 1 ? "s" : ""} lit up`
        : "No assets detected in this view";
    }
  }
  async function toggleXray() {
    if (xrayActive) { closeXray(); return; }
    if (!sdk || !currentSweepUuid) { appendLine("system", "SDK not ready for X-Ray yet."); return; }
    xrayActive = true;
    _setXrayBtn(true);
    if (xrayOverlay) xrayOverlay.style.display = "block";
    _clearXrayDraw();
    if (xrayHudText) xrayHudText.textContent = "Scanning current view…";
    try {
      const img = await captureViewportBase64();
      if (!xrayActive) return;
      const result = await postScanAsset({
        map_id: mapId, sweep_uuid: currentSweepUuid, image_base64: img, mode: "normal",
      });
      if (!xrayActive) return;
      _drawXray(result.positions_all || {}, result.objects || {});
    } catch (e) {
      if (xrayHudText) xrayHudText.textContent = "X-Ray failed: " + (e.message || String(e));
    }
  }

  // ── Digital-Twin Health Map ──────────────────────────────────────────────
  const healthTags = {}; // sweep_uuid → [tagSid]
  let healthMapActive = false;

  function _setHealthBtn(on) {
    const b = document.getElementById("health-map-btn");
    const l = document.getElementById("health-map-label");
    if (b) b.classList.toggle("is-active", on);
    if (l) l.textContent = on ? "Hide Health Map" : "Health Map";
  }
  async function _clearHealthMap() {
    const all = Object.values(healthTags).reduce((acc, v) => acc.concat(v || []), []).filter(Boolean);
    if (all.length && sdk && sdk.Mattertag) { try { await sdk.Mattertag.remove(all); } catch (_) {} }
    Object.keys(healthTags).forEach((k) => delete healthTags[k]);
  }
  async function toggleHealthMap() {
    if (healthMapActive) {
      healthMapActive = false; _setHealthBtn(false);
      await _clearHealthMap();
      appendLine("system", "🩺 Health Map hidden.");
      return;
    }
    if (!sdk || !sdk.Mattertag) { appendLine("system", "SDK not ready for the Health Map yet."); return; }
    healthMapActive = true; _setHealthBtn(true);
    const [panel, problems] = await Promise.all([_loadAssetsPanel(), _loadProblems()]);
    const rooms = (panel.assets || []).filter((a) => a.sweep_uuid && allSweepData[a.sweep_uuid] && allSweepData[a.sweep_uuid].position);
    let placed = 0;
    for (const a of rooms) {
      if (!healthMapActive) break; // user toggled off mid-build
      const sd = allSweepData[a.sweep_uuid];
      const probs = problems.bySweep[a.sweep_uuid] || [];
      const worst = _worstSeverity(probs);
      const color = worst ? SEV_COLOR[worst] : SEV_COLOR_OK;
      const desc = probs.length
        ? `${worst.toUpperCase()} — ${probs.length} open issue${probs.length > 1 ? "s" : ""}\n` +
          probs.slice(0, 4).map((p) => `• ${p.equipment_name} (${p.severity})`).join("\n")
        : "✓ All equipment healthy";
      try {
        const sids = await sdk.Mattertag.add({
          label: (worst ? "⚠ " : "✓ ") + (a.label_name || "Room"),
          description: desc,
          anchorPosition: { x: sd.position.x, y: sd.position.y - 0.1, z: sd.position.z },
          stemVector: { x: 0, y: 0.45, z: 0 },
          color: color,
        });
        healthTags[a.sweep_uuid] = Array.isArray(sids) ? sids : [sids];
        placed++;
      } catch (e) { console.warn("[3DAgent] Health tag failed:", e); }
    }
    appendLine("system", placed
      ? `🩺 Health Map: ${placed} room(s) colour-coded by maintenance status.`
      : "No tagged rooms to map yet — tag locations or run Auto-Tag first.");
  }

  // ── Cinematic Auto-Tour ──────────────────────────────────────────────────
  let tourActive = false, tourPaused = false, tourMuted = false;
  let tourAbort = false, tourSkip = false;

  function _orderTourStops(stops) {
    const remaining = stops.slice();
    const ordered = [];
    let cur = (currentSweepUuid && allSweepData[currentSweepUuid] && allSweepData[currentSweepUuid].position) || null;
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const p = allSweepData[remaining[i].sweep].position;
        const d = cur ? ((p.x - cur.x) ** 2 + (p.z - cur.z) ** 2) : i;
        if (d < bd) { bd = d; bi = i; }
      }
      const next = remaining.splice(bi, 1)[0];
      ordered.push(next);
      cur = allSweepData[next.sweep].position;
    }
    return ordered;
  }
  function _waitWhilePaused() {
    return new Promise((resolve) => {
      if (!tourPaused) return resolve();
      const iv = setInterval(() => { if (!tourPaused || tourAbort) { clearInterval(iv); resolve(); } }, 150);
    });
  }
  function _sleepTour(ms) {
    return new Promise((resolve) => {
      let elapsed = 0; const step = 100;
      const iv = setInterval(() => {
        if (tourAbort || tourSkip) { clearInterval(iv); return resolve(); }
        if (!tourPaused) elapsed += step;
        if (elapsed >= ms) { clearInterval(iv); resolve(); }
      }, step);
    });
  }
  function _narrate(stop) {
    if (tourMuted || !window.speechSynthesis) return;
    const top = (stop.assets || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 3);
    let text = `${stop.name}. `;
    if (top.length) text += "Containing " + top.map((a) => `${a.count} ${a.asset_name}`).join(", ") + ". ";
    const worst = _worstSeverity(stop.problems);
    text += stop.problems.length
      ? `${stop.problems.length} maintenance issue${stop.problems.length > 1 ? "s" : ""}, worst severity ${worst}.`
      : "All equipment healthy.";
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.03;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }
  function _renderTourCard(stop, i, n) {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set("tour-progress", `Room ${i + 1} / ${n}`);
    set("tour-card-title", stop.name);
    const hb = document.getElementById("tour-card-health");
    if (hb) {
      const worst = _worstSeverity(stop.problems);
      if (stop.problems.length) {
        hb.textContent = `${worst.toUpperCase()} · ${stop.problems.length} issue${stop.problems.length > 1 ? "s" : ""}`;
        hb.className = "tour-card-health " + (SEV_RANK[worst] >= 3 ? "is-bad" : "is-warn");
      } else {
        hb.textContent = "✓ Healthy"; hb.className = "tour-card-health is-ok";
      }
    }
    const ul = document.getElementById("tour-card-assets");
    if (ul) {
      ul.innerHTML = "";
      const top = (stop.assets || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5);
      if (!top.length) {
        const li = document.createElement("li"); li.className = "tca-empty"; li.textContent = "No scanned assets yet"; ul.appendChild(li);
      } else {
        top.forEach((a) => {
          const li = document.createElement("li");
          li.innerHTML = `<span>${a.asset_name}</span><span class="tca-count">${a.count}</span>`;
          ul.appendChild(li);
        });
      }
    }
    const card = document.getElementById("tour-card");
    if (card) { card.classList.remove("is-swap"); void card.offsetWidth; card.classList.add("is-swap"); }
  }
  async function _cinematicPan(stop) {
    let base;
    try { base = await getCurrentRotation(); } catch (_) { base = { x: 0, y: 0 }; }
    const offsets = [0, 50, 100, 150, 200, 250, 300];
    for (const off of offsets) {
      if (tourAbort || tourSkip) break;
      await _waitWhilePaused();
      if (tourAbort || tourSkip) break;
      try { await rotateToYawAtCurrentSweep((base.y || 0) + off, base.x || 0); } catch (_) {}
      await _sleepTour(560);
    }
  }
  function _showTourUI() {
    const o = document.getElementById("tour-overlay"); if (o) o.style.display = "block";
    const b = document.getElementById("auto-tour-btn"); if (b) b.classList.add("is-active");
    const l = document.getElementById("auto-tour-label"); if (l) l.textContent = "Stop Tour";
  }
  function endAutoTour() {
    tourActive = false; tourPaused = false;
    const o = document.getElementById("tour-overlay"); if (o) o.style.display = "none";
    const b = document.getElementById("auto-tour-btn"); if (b) b.classList.remove("is-active");
    const l = document.getElementById("auto-tour-label"); if (l) l.textContent = "Auto-Tour";
    const pb = document.getElementById("tour-pause"); if (pb) pb.textContent = "⏸ Pause";
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
  }
  async function startAutoTour() {
    if (tourActive) return;
    if (!sdk || !sdk.Sweep) { appendLine("system", "SDK not ready for the Auto-Tour yet."); return; }
    const [panel, problems] = await Promise.all([_loadAssetsPanel(), _loadProblems()]);
    const summariesBySweep = {};
    (panel.scan_summaries || []).forEach((s) => { if (s.sweep_uuid) (summariesBySweep[s.sweep_uuid] = summariesBySweep[s.sweep_uuid] || []).push(s); });
    const seen = {};
    let stops = (panel.assets || [])
      .filter((a) => a.sweep_uuid && allSweepData[a.sweep_uuid] && allSweepData[a.sweep_uuid].position)
      .filter((a) => (seen[a.sweep_uuid] ? false : (seen[a.sweep_uuid] = true)))
      .map((a) => ({
        sweep: a.sweep_uuid,
        name: a.label_name || a.category || "Room",
        problems: problems.bySweep[a.sweep_uuid] || [],
        assets: summariesBySweep[a.sweep_uuid] || [],
      }));
    if (!stops.length) { appendLine("system", "No tagged rooms to tour yet — tag locations or run Auto-Tag first."); return; }
    stops = _orderTourStops(stops);

    tourActive = true; tourAbort = false; tourPaused = false;
    _showTourUI();
    appendLine("system", `🎬 Auto-Tour started — flying through ${stops.length} room(s).`);
    for (let i = 0; i < stops.length; i++) {
      if (tourAbort) break;
      tourSkip = false;
      const stop = stops[i];
      try { await handleNavigate(stop.sweep); } catch (_) {}
      if (tourAbort) break;
      await _sleepTour(2100); // let the fly-to settle
      if (tourAbort) break;
      _renderTourCard(stop, i, stops.length);
      _narrate(stop);
      await _cinematicPan(stop);
    }
    if (!tourAbort) appendLine("agent", "✅ Auto-Tour complete.");
    endAutoTour();
  }

  // ── Showcase wiring + HUD bootstrap ──────────────────────────────────────
  (function initShowcase() {
    const xrayBtn = document.getElementById("xray-btn");
    if (xrayBtn) xrayBtn.addEventListener("click", toggleXray);
    const xrayExit = document.getElementById("xray-exit");
    if (xrayExit) xrayExit.addEventListener("click", closeXray);

    const healthBtn = document.getElementById("health-map-btn");
    if (healthBtn) healthBtn.addEventListener("click", toggleHealthMap);

    const tourBtn = document.getElementById("auto-tour-btn");
    if (tourBtn) tourBtn.addEventListener("click", function () {
      if (tourActive) { tourAbort = true; tourSkip = true; tourPaused = false; endAutoTour(); }
      else startAutoTour();
    });
    const tourPauseBtn = document.getElementById("tour-pause");
    if (tourPauseBtn) tourPauseBtn.addEventListener("click", function () {
      tourPaused = !tourPaused;
      tourPauseBtn.textContent = tourPaused ? "▶ Resume" : "⏸ Pause";
      try { if (window.speechSynthesis) { tourPaused ? window.speechSynthesis.pause() : window.speechSynthesis.resume(); } } catch (_) {}
    });
    const tourSkipBtn = document.getElementById("tour-skip");
    if (tourSkipBtn) tourSkipBtn.addEventListener("click", function () { tourSkip = true; });
    const tourMuteBtn = document.getElementById("tour-mute");
    if (tourMuteBtn) tourMuteBtn.addEventListener("click", function () {
      tourMuted = !tourMuted;
      tourMuteBtn.textContent = tourMuted ? "🔇 Muted" : "🔊 Voice";
      try { if (tourMuted && window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
    });
    const tourExitBtn = document.getElementById("tour-exit");
    if (tourExitBtn) tourExitBtn.addEventListener("click", function () {
      tourAbort = true; tourSkip = true; tourPaused = false; endAutoTour();
    });

    if (hudEl) {
      hudEl.style.display = "block";
      updateHudRoom();
      refreshHudStats();
      setInterval(updateHudRoom, 1200);
      setInterval(refreshHudStats, 30000);
    }
  })();
})();