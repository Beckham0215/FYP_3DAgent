# Viewer Layout - Visual Guide

## Before (Issues)
```
┌────────────────────────────────────────────────────────────────┐
│ Sidebar                          │  UUID Tracker (Top-Left)   │
│ (260px blocking view)            │  ┌───────────────────────┐  │
│                                  │  │📍 Current Location   │  │
│ • Dashboard                      │  │◄UUID: abc123...►     │  │
│ • Viewer                         │  └───────────────────────┘  │
│                                  │                              │
│                                  │  ┌────────────────────────┐ │
│ User Profile                     │  │3DAgent Chat Panel    │ │
│ [Avatar] Name                    │  │                      │ │
│                                  │  │ Chat messages...     │ │
│ [Logout]                         │  │ [Input + Send]       │ │
│                                  │  └────────────────────────┘ │
│                                  │                              │
│                                  │  ┌────────────────────────┐ │
│                                  │  │🏷️ Quick Tag (OVERLAP!)│ │
│                                  │  │ Name: _______         │ │
│                                  │  │ Category: _____       │ │
│                                  │  │ [Save]                │ │
│                                  │  └────────────────────────┘ │
│                                  │                              │
│  ◄─── MATTERPORT VIEWER ─────► │                              │
│                                  │                              │
└────────────────────────────────────────────────────────────────┘

❌ Problems:
• Sidebar takes 260px (20% of screen)
• UUID Tracker and Quick Asset Manager OVERLAP
• Chat panel is large (340px wide × 480px tall)
• All overlays block significant viewer area
• No way to minimize panels
```

## After (Fixed!)
```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│                                                                    │
│                 MATTERPORT 3D VIEWER (FULL SCREEN)               │
│                                                                    │
│ ┌──────────────────────────────────────────────────┐             │
│ │📍 Current Loc       − │ ◄─ UUID Tracker (Top)   │             │
│ │◄UUID: abc123...►      │                         │             │
│ └──────────────────────────────────────────────────┘             │
│                                                                    │
│                                                                    │
│                                                                    │
│                                     ┌─────────────────────┐      │
│                                     │3DAgent         − │      │
│                                     │Navigate...   + │◄──── Chat overlay
│                                     │[Chat msgs]      │      │ (Right side)
│                                     │[Input+Send]     │      │
│                                     └─────────────────────┘      │
│                                                                    │
│ ┌──────────────────────────────────────────────────┐             │
│ │🏷️ Quick Tag        − │ ◄─ Quick Asset (Bottom)  │             │
│ │Name: _________       │                           │             │
│ │Category: _____       │                           │             │
│ │[Save]                │                           │             │
│ └──────────────────────────────────────────────────┘             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

✅ Improvements:
• Sidebar HIDDEN (extra 260px for viewer!)
• UUID Tracker @ TOP-LEFT (no overlap)
• Quick Asset @ BOTTOM-LEFT (no overlap)  
• Chat panel COMPACT (320px × 420px)
• All panels have MINIMIZE buttons (−/+)
• ~90% of screen dedicated to viewer
• Minimize state persists (localStorage)
• Fully responsive on mobile
```

## Panel Minimize Feature

### Expanded State
```
┌───────────────────────────────┐
│📍 Current Location          − │
├───────────────────────────────┤
│ Sweep: abc123def456ghi...    │
└───────────────────────────────┘
```

### Minimized State (Click −)
```
┌──────────────┐
│📍 Loc      + │
└──────────────┘
```

## Responsive Design

### Desktop (≥ 768px)
- Full overlays visible
- UUID: top-left, Quick Asset: bottom-left
- Chat: right side
- All panels 100% functional

### Tablet (768px - 640px)
- Overlays repositioned to avoid conflicts
- Chat moved above Quick Asset
- Slightly smaller fonts
- Still fully usable

### Mobile (< 640px)
- Minimal padding on panels
- Overlays stack vertically on left
- Chat on right adjusted for small screens
- Inputs with smaller font size
- Maximum 160px width for side panels

## Minimize Button Behavior

**Click Toggle (−) Button:**
1. Panel minimizes to header-only
2. Content hidden
3. Button changes to + 
4. State saved to localStorage

**Click Toggle (+) Button:**
1. Panel expands back
2. All content visible
3. Button changes to −
4. State saved to localStorage

**On Page Reload:**
- Panels restore to previous state
- No flickering or reset

## File Structure

```
project/
├── static/
│   ├── css/
│   │   └── modern.css          (Updated viewer styles)
│   └── js/
│       ├── panel-controls.js   (NEW - Panel functionality)
│       └── viewer.js
├── templates/
│   └── viewer.html             (Updated layout)
└── VIEWER_FIXES_SUMMARY.md    (Documentation)
```

## Key CSS Changes

```css
/* Hide sidebar in viewer */
.viewer-shell .sidebar { display: none !important; }

/* Full height viewer */
.viewer-root { height: 100vh; }

/* Compact overlays */
.chat-overlay { width: 320px; max-height: 420px; }
#uuid-tracker { max-width: 240px; }
#quick-asset-manager { max-width: 240px; }

/* Minimize state */
.minimized .panel-body { display: none; }
.minimized .chat-body { display: none; }

/* Non-overlapping positions */
#uuid-tracker { top: 16px; left: 16px; }
#quick-asset-manager { bottom: 16px; left: 16px; }
```

## Testing Items

- [x] Sidebar completely hidden
- [x] UUID and Quick Asset panels don't overlap
- [x] Chat overlay is compact (320×420px)
- [x] Minimize buttons toggle properly
- [x] State persists across page reloads
- [x] Mobile responsive layout
- [x] No viewer blocking
- [x] All text readable
- [x] Smooth animations
- [x] Optional drag support (built-in)

---

**Implementation Status**: ✅ Complete and Ready
**Last Updated**: April 7, 2026
