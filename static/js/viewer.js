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

      // Deep-link: a maintenance report can open the viewer at ?goto=<sweep_uuid>
      // so an admin/mechanic lands on the reported location.
      try {
        var _goto = new URLSearchParams(window.location.search).get("goto");
        if (_goto) {
          appendLine("system", "📍 Navigating to the reported location…");
          setTimeout(function () { handleNavigate(_goto); }, 3500);
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

  // bbox is [x1,y1,x2,y2] normalized 0–1 zone boundaries from the vision model.
  // If null/invalid, shows label only so the user knows the camera view is correct.
  function showHighlightOverlay(objectName, bbox) {
    if (!scanHighlightOverlay) return;

    const token = ++_highlightToken;

    // Reset any previous edge outline; the box shows first, the precise
    // outline replaces it once segmentation returns (best-effort).
    if (shoSvgEl)  shoSvgEl.style.display = "none";
    if (shoPolyEl) shoPolyEl.setAttribute("points", "");

    if (shoLabelEl) {
      shoLabelEl.textContent = bbox && bbox.length === 4
        ? `🔆 ${objectName} — highlighted`
        : `🔆 ${objectName} — camera at best view`;
    }

    if (shoMarkerEl) {
      if (bbox && bbox.length === 4) {
        // Position relative to the iframe (the actual 3D viewport)
        const W = iframe.offsetWidth  || 1280;
        const H = iframe.offsetHeight || 720;

        const left   = bbox[0] * W;
        const top    = bbox[1] * H;
        const width  = (bbox[2] - bbox[0]) * W;
        const height = (bbox[3] - bbox[1]) * H;

        if (width > 10 && height > 10) {
          shoMarkerEl.style.left    = left   + "px";
          shoMarkerEl.style.top     = top    + "px";
          shoMarkerEl.style.width   = width  + "px";
          shoMarkerEl.style.height  = height + "px";
          shoMarkerEl.style.display = "block";
        } else {
          shoMarkerEl.style.display = "none";
        }
      } else {
        shoMarkerEl.style.display = "none";
      }
    }

    scanHighlightOverlay.style.display = "block";

    // Refine the rectangle into an edge-hugging outline (non-blocking).
    _refineHighlightWithSeg(objectName, bbox, token);
  }

  // Capture the current viewport and ask the segmentation model for a polygon
  // that hugs the object's edges. Falls back silently to the box on any failure.
  async function _refineHighlightWithSeg(objectName, bboxHint, token) {
    try {
      if (!sdk || !sdk.Renderer || !shoSvgEl || !shoPolyEl) return;
      const image = await captureViewportBase64();
      const res = await fetch("/api/segment-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ image, object_name: objectName, bbox: bboxHint || null }),
      });
      const data = await res.json().catch(() => ({ ok: false }));

      // Bail if the user dismissed or triggered another highlight meanwhile.
      if (token !== _highlightToken) return;
      if (!data.ok || !Array.isArray(data.polygon) || data.polygon.length < 3) return;
      if (!scanHighlightOverlay || scanHighlightOverlay.style.display === "none") return;

      const pts = data.polygon
        .map((p) => `${(+p[0]).toFixed(4)},${(+p[1]).toFixed(4)}`)
        .join(" ");
      shoPolyEl.setAttribute("points", pts);
      shoSvgEl.style.display = "block";
      if (shoMarkerEl) shoMarkerEl.style.display = "none";  // outline is tighter than the box
      if (shoLabelEl)  shoLabelEl.textContent = `🔆 ${objectName} — outlined`;
    } catch (e) {
      /* keep the bounding-box highlight */
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
    const cache  = instanceBboxCache[assetName] || { angle: 0, boxes: [] };
    const hasIdx = instanceIndex != null && !Number.isNaN(instanceIndex);
    const bbox   = hasIdx ? (cache.boxes[instanceIndex] || null) : (tightBboxCache[assetName] || null);
    const label  = hasIdx ? `${assetName} #${instanceIndex + 1}` : assetName;

    clearHighlightOverlay();
    if (shoLabelEl) shoLabelEl.textContent = `🔍 ${label} — locating…`;
    if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";

    const yaw = (pendingScanBaseRotation.y || 0) + (cache.angle || 0);
    try { await rotateToYawAtCurrentSweep(yaw, pendingScanBaseRotation.x || 0); } catch (_) {}
    showHighlightOverlay(label, bbox);
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
          const cache = instanceBboxCache[asset] || { boxes: [] };

          let rows = "";
          for (let i = 0; i < count; i++) {
            const hasBox = !!(cache.boxes && cache.boxes[i]);
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

  // Collect the primary tight bbox for each detected asset from the boxes YOLO
  // already produced during the scan. No extra API call — highlight data is
  // available instantly, sourced from the view where the asset was seen most.
  // tightBboxCache[name] = [x1,y1,x2,y2] | null  (single value, not wrapped in array).
  // Returns a resolved Promise so the save handler's `await` still works.
  function _prefetchTightBboxes(counts) {
    tightBboxCache = {};
    instanceBboxCache = {};
    Object.keys(counts || {}).forEach((name) => {
      // Pick the view where this asset was seen the most — that view holds the
      // full set of per-instance boxes that matches the displayed count.
      let bestView = null, bestCount = -1;
      pendingScanViewData.forEach((view) => {
        const c = view.objects[name] || 0;
        if (c > bestCount) { bestCount = c; bestView = view; }
      });
      const allBoxes = (bestView && bestView.bboxes_all && bestView.bboxes_all[name]) || [];
      const single   = (bestView && bestView.bboxes && bestView.bboxes[name]) || allBoxes[0] || null;
      tightBboxCache[name]    = single;
      instanceBboxCache[name] = {
        angle: bestView ? bestView.angle : 0,
        boxes: allBoxes,
      };
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
    if (autoTagBtn) { autoTagBtn.disabled = false; autoTagBtn.textContent = "⏹ Stop Auto-Tag"; }
    if (autoTagStatusEl) autoTagStatusEl.textContent = "Collecting sweeps…";

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

      // Pre-populate category counters so numbering continues correctly, and
      // seed the spatial "placed" list from existing tags that have positions.
      const categoryCounters = {};
      const placed = [];  // {x, z, floorId, category, label}
      existingAssets.forEach(a => {
        const cat = (a.category || "").trim().toLowerCase();
        if (cat) {
          const numMatch = (a.label_name || "").match(/\s(\d+)$/);
          const num = numMatch ? parseInt(numMatch[1]) : 1;
          categoryCounters[cat] = Math.max(categoryCounters[cat] || 0, num);
        }
        const sd = allSweepData[a.sweep_uuid];
        if (sd && sd.position) {
          placed.push({
            x: sd.position.x, z: sd.position.z,
            floorId: (sd.floorInfo || {}).id,
            category: (a.category || "").trim(),
            label: a.label_name,
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

      let tagged = 0;
      for (let i = 0; i < total; i++) {
        if (autoTagShouldStop) { appendLine("system", "⏹ Auto-tagging stopped by user."); break; }

        const sweep = untagged[i];
        const sd  = allSweepData[sweep.uuid] || {};
        const pos = sd.position || sweep.position || null;
        const floorId = (sd.floorInfo || sweep.floorInfo || {}).id;

        let category = null;
        let label = null;

        // 1) Very close to an already-named point on the same floor → same room,
        //    inherit its exact label. No camera move, no API call.
        const sameRoom = pos ? _nearestPlaced(pos.x, pos.z, floorId, AUTOTAG_ROOM_RADIUS) : null;
        if (sameRoom) {
          label = sameRoom.label;
          category = sameRoom.category;
          if (autoTagStatusEl) autoTagStatusEl.textContent = `Sweep ${i + 1} / ${total} (same room)…`;
        } else {
          // 2) New area → travel there, look, and name it WITH nearby context so
          //    the model stays consistent rather than inventing a fresh name.
          if (autoTagStatusEl) autoTagStatusEl.textContent = `Visiting sweep ${i + 1} / ${total}…`;
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
          const nearbyNames = Array.from(new Set(nearby.map(p => p.label)));

          let suggestion = null;
          try {
            const imageBase64 = await captureViewportBase64();
            const sugRes = await fetch("/api/suggest-location-name", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ map_id: mapId, image_base64: imageBase64, nearby_names: nearbyNames }),
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

          // If the model picked an existing nearby label, reuse it (same room);
          // otherwise it's a new area → assign a fresh numbered label.
          const match = nearby.find(p => p.label.toLowerCase() === suggestion.toLowerCase());
          if (match) {
            label = match.label;
            category = match.category || suggestion;
          } else {
            category = suggestion;
            const catKey = category.toLowerCase();
            categoryCounters[catKey] = (categoryCounters[catKey] || 0) + 1;
            label = `${category} ${categoryCounters[catKey]}`;
          }
        }

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
            if (pos) placed.push({ x: pos.x, z: pos.z, floorId: floorId, category: category || "", label: label });
            appendLine("agent", `  ✓ Sweep ${i + 1}: "${label}"${sameRoom ? " (same room)" : ""}`);
          }
        } catch (e) {
          console.warn("[3DAgent] Mark asset error:", e);
        }

        if (autoTagStatusEl) autoTagStatusEl.textContent = `${tagged} / ${total} tagged`;
      }

      if (!autoTagShouldStop) {
        appendLine("agent", `✅ Auto-tagging complete. ${tagged} location(s) tagged.`);
      }
      if (autoTagStatusEl) autoTagStatusEl.textContent = autoTagShouldStop ? `Stopped — ${tagged} tagged` : `Done — ${tagged} tagged`;
      if (tagged > 0) await _refreshLocationData();
    } catch (err) {
      console.error("[3DAgent] autoTagLocations error:", err);
      appendLine("system", "❌ Auto-tagging failed: " + (err.message || String(err)));
      if (autoTagStatusEl) autoTagStatusEl.textContent = "Error — see chat";
    } finally {
      isAutoTagging = false;
      autoTagShouldStop = false;
      if (autoTagBtn) { autoTagBtn.disabled = false; autoTagBtn.textContent = "🤖 Auto-Tag All Locations"; }
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

    appendLine("system", `📸 Starting 360° scan${areaName ? " of " + areaName : ""}… (6 angles)`);
    const baseRotation = await getCurrentRotation();
    pendingScanBaseRotation = baseRotation;
    const stepAngles = [0, 60, 120, 180, 240, 300];
    const sightings = {};
    pendingScanViewData = [];

    for (let i = 0; i < stepAngles.length; i++) {
      if (scanShouldStop) { appendLine("system", "⏹ Scan stopped."); clearLiveOverlay(); break; }
      const yaw = (baseRotation.y || 0) + stepAngles[i];
      clearLiveOverlay();
      appendLine("system", `📷 View ${i + 1}/${stepAngles.length}: ${stepAngles[i]}°…`);
      await rotateToYawAtCurrentSweep(yaw, baseRotation.x || 0);
      appendLine("system", `🤖 Analyzing view ${i + 1}/${stepAngles.length}…`);
      const imageBase64 = await captureViewportBase64();
      const scanResult = await postScanAsset({
        map_id: mapId,
        sweep_uuid: currentSweepUuid,
        image_base64: imageBase64,
        area_name: areaName || undefined,
      });
      mergeViewDetections(sightings, scanResult.objects || {});
      pendingScanViewData.push({
        angle: stepAngles[i],
        absolute_angle: (baseRotation.y || 0) + stepAngles[i],
        sweep_uuid: currentSweepUuid,
        objects: scanResult.objects || {},
        bboxes: scanResult.positions || {},
        bboxes_all: scanResult.positions_all || {},
        image: imageBase64,
      });
      showLiveOverlay(i + 1, stepAngles.length, stepAngles[i], scanResult.objects || {});
    }

    clearLiveOverlay();
    const counts = _buildCounts(sightings, stepAngles.length);
    pendingScanCounts = counts;
    pendingScanSweepUuid = currentSweepUuid;
    _prefetchPromise = _prefetchTightBboxes(counts);
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

    appendLine("system", `🔍 Scanning ${sweeps.length} sweep(s) in "${category}"…`);
    const stepAngles = [0, 60, 120, 180, 240, 300];
    const aggregatedSightings = {};

    for (let i = 0; i < sweeps.length; i++) {
      if (scanShouldStop) { appendLine("system", "⏹ Scan stopped."); break; }

      const sweep = sweeps[i];
      setScanButtonState(true, `⏹ Stop (${i + 1}/${sweeps.length})`);
      appendLine("system", `📍 ${sweep.label_name || sweep.sweep_uuid} (${i + 1}/${sweeps.length})…`);

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
        });
        mergeViewDetections(aggregatedSightings, scanResult.objects || {});
        mergeViewDetections(sweepLocalSightings, scanResult.objects || {});
        showLiveOverlay(ai + 1, stepAngles.length, angle, scanResult.objects || {});
        pendingScanViewData.push({
          angle: angle,
          absolute_angle: (baseRotation.y || 0) + angle,
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
    pendingScanCounts = counts;
    if (scanAreaNameInput) scanAreaNameInput.value = category;
    _prefetchPromise = _prefetchTightBboxes(counts);
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

  // --- MAINTENANCE REPORT FORM HANDLER ---
  const reportForm = document.getElementById("report-issue-form");
  const reportStatusEl = document.getElementById("report-status");

  if (reportForm) {
    reportForm.addEventListener("submit", async function (ev) {
      ev.preventDefault();

      const equipment = (document.getElementById("report-equipment").value || "").trim();
      const description = (document.getElementById("report-description").value || "").trim();
      const severity = document.getElementById("report-severity").value || "medium";

      if (!equipment) {
        reportStatusEl.textContent = "❌ Enter the equipment name";
        reportStatusEl.style.color = "var(--danger)";
        return;
      }

      // If the current sweep is a known tagged location, send its label as the area.
      let areaName = "";
      const tag = currentSweepUuid ? taggedSweepMap[currentSweepUuid] : null;
      if (tag) areaName = tag.label_name + (tag.category ? " (" + tag.category + ")" : "");

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
            sweep_uuid: currentSweepUuid || undefined,
            area_name: areaName || undefined,
          }),
        });
        const data = await res.json().catch(() => ({ ok: false, error: "Invalid response" }));
        if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);

        reportStatusEl.textContent = "✓ Issue reported — admin notified.";
        reportStatusEl.style.color = "var(--success)";
        document.getElementById("report-equipment").value = "";
        document.getElementById("report-description").value = "";
        document.getElementById("report-severity").value = "medium";
        appendLine("system", "🛠️ Maintenance issue reported: " + equipment + " — severity: " + severity + ".");
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

  if (autoTagBtn) {
    autoTagBtn.addEventListener("click", function () {
      if (isAutoTagging) {
        autoTagShouldStop = true;
        autoTagBtn.disabled = true;
        autoTagBtn.textContent = "⏹ Stopping…";
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
          let bestView = null, bestCount = 0;
          pendingScanViewData.forEach((view) => {
            const c = view.objects[assetName] || 0;
            if (c > bestCount) { bestCount = c; bestView = view; }
          });
          const absoluteAngle = bestView ? bestView.absolute_angle : null;
          const viewSweep     = bestView ? (bestView.sweep_uuid || null) : null;
          const instanceCount = editedCounts[assetName] || 1;
          // Each instance keeps its OWN YOLO box so every asset has a precise
          // location/highlight. Instances beyond the detected boxes (e.g. count
          // edited up) fall back to null and share the view angle.
          const instBoxes = (instanceBboxCache[assetName] && instanceBboxCache[assetName].boxes) || [];

          const instances = [];
          for (let i = 0; i < instanceCount; i++) {
            instances.push({
              serial:     i + 1,
              bbox:       instBoxes[i] || null,
              angle:      absoluteAngle,
              sweep_uuid: viewSweep,
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
          await handleNavigate(sweepUuid);
          await sleep(1200);
          try { await rotateToYawAtCurrentSweep(angle, 0); } catch (_) {}
          if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
          showHighlightOverlay(assetName, bbox);
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

  async function openAssetsPanel() {
    if (!assetsPanelEl) return;
    assetsPanelEl.style.display = "flex";
    await refreshAssetsPanel();
  }

  function closeAssetsPanel() {
    if (assetsPanelEl) assetsPanelEl.style.display = "none";
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
    const assets    = data.assets || [];
    const summaries = data.scan_summaries || [];

    // Group assets by category
    const grouped = {};
    assets.forEach(a => {
      const cat = a.category || "Uncategorized";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(a);
    });
    const categories = Object.keys(grouped).sort();

    // Group summaries by area
    const areaMap = {};
    summaries.forEach(s => {
      const area = s.area_name || "Unspecified";
      if (!areaMap[area]) areaMap[area] = [];
      areaMap[area].push(s);
    });
    const areas = Object.keys(areaMap).sort();

    // ── Section 1: Navigation Locations (collapsed by default, searchable) ──
    let locHtml = `
      <div class="ap-section-title">📌 Navigation Locations
        <span class="ap-count">${assets.length}</span>
      </div>
      <form id="ap-add-location-form" class="ap-add-form">
        <input type="text" id="ap-label" placeholder="Location name (e.g. Kitchen 1)" required autocomplete="off">
        <input type="text" id="ap-category" placeholder="Category (e.g. Kitchen)" autocomplete="off">
        <input type="text" id="ap-uuid" placeholder="${currentSweepUuid || 'Sweep UUID (leave blank for current)'}" autocomplete="off">
        <button type="submit" class="btn primary small" style="width:100%;">✓ Add Location</button>
      </form>`;

    if (assets.length) {
      locHtml += `<input type="text" id="ap-loc-search" class="ap-search-input" placeholder="Search locations or categories…" autocomplete="off">`;
      locHtml += `<div id="ap-loc-list">` + categories.map(cat => `
        <div class="ap-group" data-cat="${cat.toLowerCase()}">
          <div class="ap-group-header ap-collapsible">
            <span class="ap-collapse-icon">▶</span>
            <span>${cat}</span>
            <span class="ap-count">${grouped[cat].length}</span>
          </div>
          <div class="ap-group-rows" style="display:none;">
            ${grouped[cat].map(a => `
              <div class="ap-row" data-label="${a.label_name.toLowerCase()}">
                <div class="ap-row-info">
                  <span class="ap-row-label">${a.label_name}</span>
                  ${a.sweep_uuid ? `<span class="ap-row-uuid">${a.sweep_uuid.slice(0, 12)}…</span>` : ""}
                </div>
                <div class="ap-row-actions">
                  ${a.sweep_uuid ? `<button type="button" class="btn small secondary ap-navigate-btn" data-uuid="${a.sweep_uuid}" data-label="${a.label_name}" title="Go here">▶</button>` : ""}
                  <button type="button" class="btn small danger ap-delete-asset-btn" data-id="${a.asset_id}" title="Delete">🗑</button>
                </div>
              </div>`).join("")}
          </div>
        </div>`).join("") + `</div>`;
    } else {
      locHtml += `<div class="ap-empty">No locations tagged yet. Use Auto-Tag or the Quick Tag panel.</div>`;
    }

    // ── Section 2: Scanned Inventory (area chips, drill-down) ──
    let invHtml = `
      <div class="ap-section-title" style="margin-top:1rem;">🔍 Scanned Inventory
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

    assetsPanelBody.innerHTML = locHtml + invHtml;

    // ── Wire: collapsible location groups ──
    assetsPanelBody.querySelectorAll(".ap-collapsible").forEach(header => {
      header.addEventListener("click", () => {
        const rows = header.nextElementSibling;
        const icon = header.querySelector(".ap-collapse-icon");
        const open = rows.style.display !== "none";
        rows.style.display = open ? "none" : "";
        icon.textContent = open ? "▶" : "▼";
      });
    });

    // ── Wire: location search ──
    const searchInput = assetsPanelBody.querySelector("#ap-loc-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const term = searchInput.value.trim().toLowerCase();
        assetsPanelBody.querySelectorAll(".ap-group").forEach(group => {
          const rows = group.querySelectorAll(".ap-row");
          const rowsContainer = group.querySelector(".ap-group-rows");
          const icon = group.querySelector(".ap-collapse-icon");
          if (!term) {
            rowsContainer.style.display = "none";
            if (icon) icon.textContent = "▶";
            group.style.display = "";
            rows.forEach(r => r.style.display = "");
            return;
          }
          const catMatch = group.dataset.cat.includes(term);
          let anyVisible = false;
          rows.forEach(row => {
            const match = catMatch || (row.dataset.label || "").includes(term);
            row.style.display = match ? "" : "none";
            if (match) anyVisible = true;
          });
          group.style.display = anyVisible ? "" : "none";
          if (anyVisible) { rowsContainer.style.display = ""; if (icon) icon.textContent = "▼"; }
        });
      });
    }

    // ── Wire: navigate buttons ──
    assetsPanelBody.querySelectorAll(".ap-navigate-btn").forEach(btn => {
      btn.addEventListener("click", () => { closeAssetsPanel(); navigateWithRoute(btn.dataset.uuid, btn.dataset.label || ""); });
    });

    // ── Wire: location delete ──
    assetsPanelBody.querySelectorAll(".ap-delete-asset-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this location tag?")) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/spaces/${mapId}/assets/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
          const d = await res.json().catch(() => ({}));
          if (d.ok) await refreshAssetsPanel();
          else appendLine("system", "Delete failed: " + (d.error || "unknown"));
        } catch (e) { appendLine("system", "Delete error: " + e.message); }
      });
    });

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

          // Keep the Assets panel open so multiple items can be highlighted
          // without re-opening Assets → location → item each time.
          await handleNavigate(sweepUuid);
          await sleep(1200);
          try { await rotateToYawAtCurrentSweep(angle, 0); } catch (_) {}
          if (scanHighlightOverlay) scanHighlightOverlay.style.display = "block";
          showHighlightOverlay(assetName, bbox);
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

    // ── Wire: add-location form ──
    const addForm = assetsPanelBody.querySelector("#ap-add-location-form");
    if (addForm) {
      addForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const label    = (addForm.querySelector("#ap-label").value || "").trim();
        const category = (addForm.querySelector("#ap-category").value || "").trim();
        const uuid     = (addForm.querySelector("#ap-uuid").value || "").trim() || currentSweepUuid;
        if (!label) return;
        if (!uuid) { appendLine("system", "No sweep UUID — navigate to a location first."); return; }
        const submitBtn = addForm.querySelector("button[type=submit]");
        submitBtn.disabled = true;
        try {
          const res = await fetch("/api/mark-asset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ map_id: mapId, asset_name: label, sweep_uuid: uuid, category: category || undefined }),
          });
          const d = await res.json().catch(() => ({}));
          if (d.ok) { addForm.reset(); await refreshAssetsPanel(); }
          else appendLine("system", "Save failed: " + (d.error || "unknown"));
        } catch (e) { appendLine("system", "Save error: " + e.message); }
        submitBtn.disabled = false;
      });
    }
  }

  if (assetsPanelOpen)  assetsPanelOpen.addEventListener("click", openAssetsPanel);
  if (assetsPanelClose) assetsPanelClose.addEventListener("click", closeAssetsPanel);

  const routeHudCancel = document.getElementById("route-hud-cancel");
  if (routeHudCancel) routeHudCancel.addEventListener("click", clearRoute);

  // ── Shared helper: refresh scan-location dropdown + open assets panel ────────

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

  // Open export modal from the tools rail
  var exportPlanBtn = document.getElementById("export-plan-btn");
  if (exportPlanBtn) {
    exportPlanBtn.addEventListener("click", function () { openExportModal(); });
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
            showHighlightOverlay(data.asset_name, nearest.bbox_json);
          }
        } else {
          appendLine("agent", `Found ${data.instances.length} ${data.asset_name}(s) but no location data is saved. Use the Assets panel to navigate manually.`);
        }
      } else if (data.response) {
        appendLine("agent", data.response);
      } else {
        appendLine("agent", JSON.stringify(data));
      }
    } catch (err) {
      appendLine("system", err.message || String(err));
    }
  });
})();