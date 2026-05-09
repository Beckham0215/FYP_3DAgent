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
        const sweepDisplayEl = document.getElementById("sweep-display"); // NEW: Get UI element

        sdk.Sweep.current.subscribe(function (sweep) {
          if (sweep && sweep.sid) {
            currentSweepUuid = sweep.sid;
            console.log("[3DAgent] ✓ Current sweep updated via observable:", currentSweepUuid);
            
            // NEW: Update the Top-Left HUD
            if (sweepDisplayEl) {
              sweepDisplayEl.textContent = currentSweepUuid;
            }
          }
        });
      } catch (e) {
        console.warn("[3DAgent] Error subscribing to sweep observable:", e);
      }
      // ------------------------------------------------

      setStatus("✓ SDK connected - you can navigate and use vision.");
      console.log("[3DAgent] ✓ SDK successfully connected");
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
      // Try to take a regular screenshot first
      const resolution = { width: 1280, height: 720 };
      const visibility = { measurements: true, mattertags: true, sweeps: true, views: true };
      
      console.log("[3DAgent] Capturing screenshot...");
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
          return `
          <div class="scan-review-item" data-asset="${asset}">
            <div class="scan-item-label">
              <span class="scan-item-name">${asset}</span>
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

      // Delete button
      scanReviewList.querySelectorAll(".scan-item-btn-delete").forEach((btn) => {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          const item = this.closest(".scan-review-item");
          const asset = item.dataset.asset;
          item.remove();
          delete selectedScanItems[asset];
        });
      });
    }

    scanReviewPanel.style.display = "block";
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

  function hideScanReview() {
    if (!scanReviewPanel) return;
    scanReviewPanel.style.display = "none";
    pendingScanCounts = null;
    selectedScanItems = {};
    if (scanAreaNameInput) scanAreaNameInput.value = "";
    if (scanLocationSelect) scanLocationSelect.value = "";
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

  async function autoTagLocations() {
    if (!sdk || !sdk.Sweep) {
      appendLine("system", "SDK not connected — cannot auto-tag.");
      return;
    }

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

      // Pre-populate category counters so numbering continues correctly
      const categoryCounters = {};
      existingAssets.forEach(a => {
        const cat = (a.category || "").trim().toLowerCase();
        if (cat) {
          const numMatch = (a.label_name || "").match(/\s(\d+)$/);
          const num = numMatch ? parseInt(numMatch[1]) : 1;
          categoryCounters[cat] = Math.max(categoryCounters[cat] || 0, num);
        }
      });

      const untagged = allSweeps.filter(s => !taggedUuids.has(s.uuid));
      const limit = Math.min(untagged.length, 30);

      appendLine("system", `Found ${allSweeps.length} sweep(s), ${untagged.length} untagged. Auto-tagging up to ${limit}…`);
      if (autoTagStatusEl) autoTagStatusEl.textContent = `0 / ${limit} tagged`;

      let tagged = 0;
      for (let i = 0; i < limit; i++) {
        if (autoTagShouldStop) {
          appendLine("system", "⏹ Auto-tagging stopped by user.");
          break;
        }

        const sweep = untagged[i];
        if (autoTagStatusEl) autoTagStatusEl.textContent = `Visiting sweep ${i + 1} / ${limit}…`;

        try {
          await sdk.Sweep.moveTo(sweep.uuid, {
            transition: sdk.Sweep.Transition.FLY,
            transitionTime: 1200,
          });
        } catch (navErr) {
          console.warn("[3DAgent] Auto-tag nav error:", navErr);
          continue;
        }
        await sleep(2200);

        if (autoTagShouldStop) {
          appendLine("system", "⏹ Auto-tagging stopped by user.");
          break;
        }

        // Ask AI to identify the room type (used as category)
        let category = null;
        try {
          const imageBase64 = await captureViewportBase64();
          const sugRes = await fetch("/api/suggest-location-name", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ map_id: mapId, image_base64: imageBase64 }),
          });
          const sugData = await sugRes.json().catch(() => ({}));
          category = sugData.suggested_name || null;
        } catch (e) {
          console.warn("[3DAgent] Suggest name error:", e);
        }

        if (!category) {
          appendLine("system", `  Sweep ${i + 1}: could not identify room — skipping.`);
          continue;
        }

        // Assign numbered label within this category (e.g. "Kitchen 1", "Kitchen 2")
        const catKey = category.toLowerCase();
        categoryCounters[catKey] = (categoryCounters[catKey] || 0) + 1;
        const label = `${category} ${categoryCounters[catKey]}`;

        try {
          const markRes = await fetch("/api/mark-asset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              map_id: mapId,
              asset_name: label,
              sweep_uuid: sweep.uuid,
              category: category,
            }),
          });
          const markData = await markRes.json().catch(() => ({}));
          if (markData.ok) {
            tagged++;
            appendLine("agent", `  ✓ Sweep ${i + 1}: "${label}" [category: ${category}]`);
          }
        } catch (e) {
          console.warn("[3DAgent] Mark asset error:", e);
        }

        if (autoTagStatusEl) autoTagStatusEl.textContent = `${tagged} / ${limit} tagged`;
      }

      if (!autoTagShouldStop) {
        appendLine("agent", `✅ Auto-tagging complete. ${tagged} location(s) tagged.`);
      }
      if (autoTagStatusEl) autoTagStatusEl.textContent = autoTagShouldStop ? `Stopped — ${tagged} tagged` : `Done — ${tagged} tagged`;
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
    scanModePicker.style.display = "block";
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
    const stepAngles = [0, 60, 120, 180, 240, 300];
    const sightings = {};

    for (let i = 0; i < stepAngles.length; i++) {
      if (scanShouldStop) { appendLine("system", "⏹ Scan stopped."); break; }
      const yaw = (baseRotation.y || 0) + stepAngles[i];
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
    }

    const counts = _buildCounts(sightings, stepAngles.length);
    pendingScanCounts = counts;
    renderScanReview(counts);
    appendLine("agent", `✅ Scan complete. ${formatCountsForChat(counts)}`);
    appendLine("system", "Review detected items below, then click 'Add to assets'.");
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

      const baseRotation = await getCurrentRotation();
      for (const angle of stepAngles) {
        if (scanShouldStop) break;
        const yaw = (baseRotation.y || 0) + angle;
        await rotateToYawAtCurrentSweep(yaw, baseRotation.x || 0);
        const imageBase64 = await captureViewportBase64();
        const scanResult = await postScanAsset({
          map_id: mapId,
          sweep_uuid: sweep.sweep_uuid,
          image_base64: imageBase64,
          area_name: category,
        });
        mergeViewDetections(aggregatedSightings, scanResult.objects || {});
      }
    }

    const counts = _buildCounts(aggregatedSightings, sweeps.length * stepAngles.length);
    pendingScanCounts = counts;
    if (scanAreaNameInput) scanAreaNameInput.value = category;
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

  async function handleNavigate(sweepUuid) {
    if (!sdk || !sdk.Sweep) {
      appendLine("system", "SDK not connected — cannot move.");
      return;
    }
    try {
      console.log("[3DAgent] Navigating to sweep:", sweepUuid);
      await sdk.Sweep.moveTo(sweepUuid, {
        transition: sdk.Sweep.Transition.FLY,
        transitionTime: 2000
      });
      appendLine("system", "✓ Moved to destination.");
      console.log("[3DAgent] Navigation complete");
    } catch (e) {
      console.error("[3DAgent] Navigation error:", e);
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
        autoTagLocations();
      }
    });
  }

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
        // Use the new confirm-edit endpoint with user-edited counts
        const res = await fetch("/api/scan-assets/confirm-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            map_id: mapId,
            area_name: areaName,
            edited_assets: editedCounts,
          }),
        });
        const data = await res.json().catch(() => ({ ok: false, error: "Invalid response" }));
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || res.statusText);
        }
        appendLine("agent", `✓ Confirmed! Saved ${Object.keys(editedCounts).length} assets for '${areaName}'.`);
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
    scanCancelBtn.addEventListener("click", function () {
      hideScanReview();
      appendLine("system", "Scan results discarded.");
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
                  ${a.sweep_uuid ? `<button type="button" class="btn small secondary ap-navigate-btn" data-uuid="${a.sweep_uuid}" title="Go here">▶</button>` : ""}
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
      btn.addEventListener("click", () => { handleNavigate(btn.dataset.uuid); closeAssetsPanel(); });
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

    function showAreaDetail(area) {
      if (!invDetailRows) return;
      invDetailRows.innerHTML = (areaMap[area] || []).map(s => `
        <div class="ap-row">
          <div class="ap-row-info">
            <span class="ap-row-label" style="text-transform:capitalize;">${s.asset_name}</span>
          </div>
          <div class="ap-row-actions">
            <span class="ap-count">${s.count}</span>
            <button type="button" class="btn small danger ap-delete-summary-btn" data-id="${s.id}" title="Delete">🗑</button>
          </div>
        </div>`).join("");

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

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    const message = (input.value || "").trim();
    if (!message) {
      return;
    }
    input.value = "";
    appendLine("user", message);

    try {
      let data = await postVla({ message: message, map_id: mapId });

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
        } catch (err) {
          appendLine("system", "Marking failed: " + (err.message || String(err)));
        }
      } else if (data.intent === "navigate" && data.sweep_uuid) {
        appendLine("agent", "Navigating to " + (data.label || "destination") + "…");
        await handleNavigate(data.sweep_uuid);
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