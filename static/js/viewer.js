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
  const scanReviewPanel = document.getElementById("scan-review-panel");
  const scanReviewList = document.getElementById("scan-review-list");
  const scanLocationSelect = document.getElementById("scan-location-select");
  const scanAreaNameInput = document.getElementById("scan-area-name-input");
  const scanSaveBtn = document.getElementById("scan-save-btn");
  const scanCancelBtn = document.getElementById("scan-cancel-btn");

  let sdk = null;
  let currentSweepUuid = null;
  let isScanning = false;
  let pendingScanCounts = null;
  let selectedScanItems = {}; // Track which items user selected to save

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
        const count = data.count || data;
        const detected = data.viewsDetected || 1;
        return [asset, count, detected];
      })
      .sort((a, b) => b[1] - a[1]);
    
    if (!entries.length) {
      return "No assets detected in this 360 scan.";
    }
    // Show actual count and in how many views it was detected
    return entries.map(([asset, count, detected]) => `${asset}: ${count} (seen in ${detected}/6 views)`).join(", ");
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

  function setScanButtonState(scanning) {
    if (!scanAreaBtn) return;
    scanAreaBtn.disabled = scanning;
    scanAreaBtn.textContent = scanning ? "Scanning..." : "Scan Area";
  }

  async function scanArea() {
    if (isScanning) {
      appendLine("system", "Scan already running.");
      return;
    }
    if (!sdk || !sdk.Sweep || !currentSweepUuid) {
      appendLine("system", "SDK not connected — cannot scan yet.");
      return;
    }

    isScanning = true;
    setScanButtonState(true);

    try {
      // Get area name for proximity context before starting
      const areaName = (
        (scanAreaNameInput && scanAreaNameInput.value.trim()) ||
        (scanLocationSelect && scanLocationSelect.value.trim()) ||
        ""
      );

      appendLine("system", `📸 Starting 360° scan${areaName ? " of " + areaName : ""}… (6 angles)`);
      appendLine("system", "Taking screenshots from 6 different angles for thorough analysis.");
      const baseRotation = await getCurrentRotation();
      const stepAngles = [0, 60, 120, 180, 240, 300];

      const sightings = {};
      for (let i = 0; i < stepAngles.length; i += 1) {
        // Stay on current sweep and rotate in-place across 360 degrees.
        const yaw = (baseRotation.y || 0) + stepAngles[i];
        appendLine("system", `📷 View ${i + 1}/${stepAngles.length}: Rotating to angle ${stepAngles[i]}°...`);
        await rotateToYawAtCurrentSweep(yaw, baseRotation.x || 0);

      appendLine("system", `🤖 Analyzing view ${i + 1}/${stepAngles.length} with vision model...`);
        const imageBase64 = await captureViewportBase64();
        const scanResult = await postScanAsset({
          map_id:       mapId,
          sweep_uuid:   currentSweepUuid,
          image_base64: imageBase64,
          area_name:    areaName || undefined,
        });
        console.log(`[3DAgent] View ${i + 1} raw objects:`, JSON.stringify(scanResult.objects));
        console.log(`[3DAgent] View ${i + 1} detected objects:`, scanResult.objects || {});
        mergeViewDetections(sightings, scanResult.objects || {});
      }

      // Aggregate counts: for each object, take the most frequently detected count
      // This handles cases where some views may have objects partially out of frame
      const counts = {};
      Object.keys(sightings).forEach((assetName) => {
        const viewCounts = sightings[assetName];
        if (viewCounts && viewCounts.length > 0) {
          // Use the maximum count detected (most complete view)
          const maxCount = Math.max(...viewCounts);
          if (maxCount > 0) {
            counts[assetName] = {
              count: maxCount,
              viewCounts: viewCounts,
              viewsDetected: viewCounts.filter(c => c > 0).length
            };
          }
        }
      });

      pendingScanCounts = counts;
      renderScanReview(counts);
      appendLine("agent", `✅ Scan complete. Detected items based on ${stepAngles.length} views -> ${formatCountsForChat(counts)}`);
      appendLine("system", "Review detected items below. Uncheck anything incorrect, then click 'Add to assets'.");
      console.log("[3DAgent] Current sweep 360 scan counts:", counts);
    } catch (err) {
      console.error("[3DAgent] Area scan error:", err);
      appendLine("system", "❌ Scan failed: " + (err.message || String(err)));
    } finally {
      isScanning = false;
      setScanButtonState(false);
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
      scanArea();
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

      if (data.intent === "mark_asset" && data.asset_name) {
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