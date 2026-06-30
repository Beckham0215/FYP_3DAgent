# 3DAgent — FYP Phase 2 Presentation

> Conversational AI agent for navigating, understanding and maintaining Matterport 3D digital twins.
>
> **Format:** slide content + speaker script per slide. Target talk time ~15 min + demo.
> **Live-demo policy:** the system runs **live**; the recorded video is a *backup only* (see the
> Demo Safety Checklist at the end).

---

## Slide 1 — Introduction (Title)

**On-slide:**
- **3DAgent** — *Talk to your building.*
- An AI agent layer that turns a passive Matterport 3D twin into something you can **ask questions, navigate by voice, inventory, and report faults in** — using natural language.
- Built with: Flask · Matterport SDK · Groq Llama-3.3-70B (reasoning) · Llama-4 Scout + YOLOv8 + Grounding DINO (vision)
- Your name · Supervisor · Programme · Date

**Script (~45 sec):**
> "Good morning. My project is called **3DAgent**. The idea in one line: *talk to your building*.
> Companies are spending a lot of money turning their facilities into Matterport 3D digital twins —
> but once it's captured, that twin is mostly a passive thing you click around in. My project adds an
> **AI agent** on top of it. You can speak or type in plain English — 'take me to the nearest fire
> extinguisher', 'how many chairs are in the meeting room', 'report that the projector is broken' —
> and the agent understands the intent, acts inside the 3D space, and remembers what's there. Let me
> explain why this matters."

---

## Slide 2 — Problem Statement & Objectives

**On-slide (left: problems / right: objectives):**

**Problems**
1. Digital twins are **passive** — navigation is manual click-by-click; there's no understanding of *what* is in the space.
2. Facility/asset data lives in **spreadsheets disconnected from the 3D space** — you can't see *where* an asset actually is.
3. Reporting a fault means describing a location in words ("the one near the back stairs") — **slow and error-prone**.
4. Existing twins offer **no natural-language interface** and no automated inventory.

**Objectives**
1. Build a **natural-language agent** that classifies user intent and acts inside a live 3D twin.
2. Provide **AI vision** that detects, counts, names and outlines assets directly from the viewport.
3. Enable **spatially-pinned maintenance reporting** with severity triage and an admin workflow.
4. Support **planning queries** (e.g. "a room for 10 people") via multi-step reasoning + visual verification.
5. **Evaluate** the AI components rigorously, not just demo them.

**Script (~90 sec):**
> "The problem. A Matterport twin is beautiful but **passive** — you navigate it manually, click by click,
> and it has no idea what's inside it. At the same time, the data *about* the building — the asset
> registers, the maintenance logs — sits in spreadsheets that are completely **disconnected from the
> 3D model**. So you know there are forty chairs somewhere, but not *where*. And when a worker wants to
> report a broken item, they describe the location in words, which is slow and easily wrong.
>
> So I set five objectives. **One**, a natural-language agent that understands intent and acts in the
> space. **Two**, AI vision that can detect, count and outline assets straight from what the camera
> sees. **Three**, maintenance reporting that's pinned to the exact spot in 3D, with severity and an
> admin triage flow. **Four**, planning queries — answering 'I need a room for ten people' by reasoning
> and then *verifying* with vision. And **five** — and this is something most projects skip — I wanted
> to **measure** how good the AI actually is, with a proper evaluation framework."

---

## Slide 3 — System Architecture (1 slide, sets up the demo)

**On-slide (simple flow diagram):**
```
User (voice / text)
      │
      ▼
Intent Router  ──►  14 intents  (Groq Llama-3.3-70B, tool-calling)
      │              navigate · query_assets · scan_area · auto_tag ·
      │              report_issue · react_query · where_am_i · …
      ├──► Navigation        → Matterport SDK fly-to sweep
      ├──► Vision pipeline    → Scout (names, open-vocab)
      │                         → YOLOv8 + Grounding DINO (boxes)
      │                         → YOLOv8-seg (tight outlines)
      ├──► Inventory / scan   → SQLite (assets, counts, per-instance)
      └──► Maintenance        → reports pinned to sweep + severity triage

Flask + SQLAlchemy backend · evaluation suite (eval/)
```

**Script (~60 sec):**
> "Quickly, how it works. Everything starts with what the user says. A **semantic router** —
> running Llama-3.3-70B on Groq — classifies the message into one of **14 intents**: navigate, scan,
> query assets, report a fault, planning, and so on. Depending on the intent it routes to one of four
> subsystems: **navigation** drives the Matterport SDK; the **vision pipeline** detects assets;
> **inventory** persists what's scanned; and **maintenance** files reports.
>
> The vision pipeline is the part I'm most proud of and worth one sentence: a large vision model,
> **Llama-4 Scout**, *names* whatever it sees with no fixed class list — so it can say 'fire
> extinguisher' or 'centrifuge', not just the 80 generic classes. Then **local computer-vision
> models — YOLOv8 and Grounding DINO — draw the boxes** for exactly those names, and YOLOv8-seg traces
> a tight outline. So the cloud model is the *brain that names*, and the local models are the *eyes
> that point*. That's the design. Now let me show it live."

---

## Slide 4 — System Demo (overview slide, then switch to the app)

**On-slide (the demo agenda — keep visible as a checklist):**
- ① Natural-language **navigation** (voice/text)
- ② **Scan** a room → detect, count & outline assets
- ③ **Auto-tag** locations from vision
- ④ **Planning** query — "a room for 10 people" (reasoning + verify)
- ⑤ **Report a fault** → pinned in 3D + severity triage
- ⑥ **Dashboard / inventory / export**

**Script (intro to demo, ~20 sec):**
> "I'll demo six things in order. If anything stalls on the WiFi, I have a recorded backup, but I'll
> run it live first. Switching to the app."

### Demo script — segment by segment

**① Navigation (~60 sec)**
> "This is a real Matterport twin loaded in the viewer. I'll just talk to it." → *Type/say:* **"take me
> to the kitchen."**
> "The router classified that as a *navigate* intent, matched 'kitchen' to a tagged location, and the
> SDK flew us there. I can also navigate to a *physical object*, not just a room —" → *"take me to the
> nearest fire extinguisher."* → "It finds the scanned instance and flies to it. No manual clicking."

**② Scan a room (~75 sec)**
> "Now let's understand what's *in* a room. I'll run **Scan Area**." → *Trigger scan.*
> "Watch — the agent detects each asset, counts it, and draws a tight outline around it. The names
> aren't limited to a fixed list: it's reading the actual objects. These counts are saved per-instance,
> so 'chair #1', 'chair #2' — which matters in a second when we report a fault on a *specific* one."

**③ Auto-tag (~45 sec)**
> "Doing that room-by-room manually is tedious, so there's **Auto-Tag**: the agent walks every sweep,
> uses vision to name each area, and tags them automatically." → *Show a short run or pre-tagged result.*
> "It clusters nearby viewpoints so one room keeps one name instead of being re-labelled at every step."
> *(Optional honesty point: "I actually fixed a flood-fill bug here recently where one room name spread
> across the whole floor — happy to talk about it in Q&A.")*

**④ Planning query — ReAct (~60 sec)**
> *Say:* **"I need a meeting room for 10 people."**
> "This isn't a lookup — the agent *reasons*: ten people needs at least ten chairs. It searches the
> scanned inventory, finds candidate rooms, and can **verify with live vision** that the chairs are
> actually still there. So it's planning plus grounding, not just a database query."

**⑤ Report a fault (~60 sec)**
> *Say:* **"report chair #1 has a broken leg."**
> "The agent extracts the asset, the problem, and infers **severity** — 'broken' becomes high. It files
> a maintenance report **pinned to that chair's exact location** in the twin, and flies there to show
> it. On the admin side —" → *open Maintenance page* → "reports are ranked by severity, a mechanic can
> be assigned, and status moves open → assigned → resolved."

**⑥ Dashboard / inventory / export (~45 sec)**
> "Everything feeds a dashboard — tagged locations, total inventory, last-scan time per space — and the
> inventory and floor plan can be **exported to CSV or PDF** for handover. That's the full loop:
> understand the space, inventory it, act on it, report on it."

---

## Slide 5 — Usability / User-Experience Analysis

**On-slide:**
- **Designed for two roles:** *workers* (report & navigate) and *admins* (triage & assign) — role-aware UI.
- **Lowest-friction input:** plain language and voice — no menus to learn; the agent maps speech → action.
- **Trust through transparency:** every detected asset is **outlined** in the view, and faults are
  **shown in place** — the user sees *why* the AI said what it said.
- **Graceful fallbacks:** if the cloud vision returns nothing, local CV takes over; dual API keys avoid
  rate-limit dead-ends; long actions show progress loaders.
- **Measured quality (intent router):**
  - Accuracy **98.6%** (95% CI 92.3–99.7%), 14 intents
  - **100%** slot-filling accuracy (e.g. extracting the room/asset name correctly)
  - DB endpoints p50 ~1–2 ms
- *(If you ran a small user test, add: N testers, task success rate, SUS score here.)*

**Script (~75 sec):**
> "On usability. The system is built around **two real roles** — the worker who reports and navigates,
> and the admin who triages — and the interface adapts to each. The core UX decision was to make the
> **input as low-friction as possible**: natural language and voice, so there's nothing to learn. You
> say what you want; the agent figures out the action.
>
> The second decision was **transparency to build trust**. AI that just gives an answer is hard to
> trust, so every asset the vision detects is **outlined right in the view**, and every fault is shown
> **in its real location**. The user can see the evidence.
>
> And rather than just claim it works, I measured it. The intent router scores **98.6% accuracy across
> all 14 intents**, with a confidence interval, and **100% on extracting the right slot values** — the
> room name, the asset name. The database responses are a couple of milliseconds. So the experience is
> both low-effort and verifiably accurate."

---

## Slide 6 — Conclusion

**On-slide (three columns):**

**✅ Achievements**
- Working conversational agent over a live Matterport twin — 14 intents, voice + text.
- Hybrid open-vocabulary vision: detect, count, **outline** assets; auto-tag rooms.
- Spatially-pinned maintenance with severity triage & role-based workflow.
- ReAct planning with visual verification.
- Rigorous **evaluation suite** (Wilson CIs, slot-filling, latency, robustness).

**⚠️ Current Limitations**
- Vision/LLM depend on **internet + Groq API**; free-tier daily token cap limits heavy use.
- Scans take a few seconds (cloud + local model pipeline).
- Room separation in auto-tag is **geometry-based**, not wall-aware (doorway edge-cases).
- Single-user ownership model; no multi-tenant org accounts yet.

**🚀 Future Work**
- On-device / cached models to reduce internet dependence.
- Wall-aware room segmentation (or Matterport room data) for perfect auto-tagging.
- Scheduled re-scans + **inventory-drift alerts** ("3 chairs missing since last scan").
- Mobile + QR deep-links from physical asset → its twin & maintenance history.

**Script (~90 sec):**
> "To conclude. What I've **achieved**: a working conversational agent on a live digital twin, with
> voice and text, fourteen intents; a hybrid vision pipeline that not only detects and counts assets but
> *outlines* them and can auto-tag whole floors; maintenance reporting pinned in 3D with a proper triage
> workflow; planning queries that reason and verify; and an evaluation suite that actually measures all
> of it.
>
> The **limitations**, honestly: the AI depends on internet and the Groq API, and the free tier has a
> daily token cap, so heavy continuous use is constrained. Scans take a few seconds because they chain
> a cloud model and local models. And the auto-tag room grouping is geometry-based — it doesn't know
> where the walls are — so it can misjudge a viewpoint sitting right in a doorway.
>
> For **future work**, the priorities are: move models on-device or cache them to cut the internet
> dependence; use wall-aware segmentation for perfect room tagging; add scheduled re-scans with
> **inventory-drift alerts**; and a mobile experience with QR codes that jump from a physical asset
> straight to its digital twin. Thank you — I'm happy to take questions."

---

## Appendix A — Demo Safety Checklist (do this before you present)

**Per the Phase-2 rules: run live, keep the video as backup only.**

- [ ] **Record the full demo video** beforehand (screen + voice) — this is your fallback for a WiFi/API failure.
- [ ] App already **running and warmed up** before you walk in (vision models preloaded — see `run.py`).
- [ ] Log in beforehand; open the target space's **viewer** so the twin is fully loaded (no live load wait).
- [ ] **Pre-seed data**: at least one space with a few tagged locations, one scanned room, and 1–2
      maintenance reports — so nothing is empty if a live step fails.
- [ ] Confirm **`GROQ_API_KEY` (and the fallback key)** have token budget left; don't burn the daily cap rehearsing.
- [ ] Have a **mobile hotspot** as a WiFi backup.
- [ ] Pre-type the exact demo phrases somewhere you can copy from (speech recognition can misfire under stress).
- [ ] Decide your **"30-second rule"**: if a live step hasn't responded in ~30s, switch to the video for that step and move on.
- [ ] Browser zoom set so outlines/labels are visible from the back of the room.

## Appendix B — Likely Q&A (prep answers)

- *"Why a cloud LLM and not pure CV?"* → Open-vocabulary naming: CV's 80 classes can't name a
  centrifuge or a fire extinguisher; the LLM names, CV localises. Best of both.
- *"How accurate is the intent classifier?"* → 98.6%, 14 classes, 95% CI 92.3–99.7%, 100% slot-filling
  (from the eval suite).
- *"What happens with no internet?"* → Local CV (YOLO/DINO) still detects; navigation and inventory
  still work; only the conversational layer degrades. (Honest about the limitation.)
- *"Is it secure / multi-user?"* → Per-user space ownership + role-based maintenance; multi-tenant org
  accounts are future work.
- *"That auto-tag bug?"* → Distance-only reuse chained into a flood-fill; fixed by matching only against
  vision-named *anchors* so a name can't propagate transitively.
