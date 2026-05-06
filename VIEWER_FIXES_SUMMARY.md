# Viewer Overlay Fixes - Summary

## Issues Fixed

### 1. **Sidebar Blocking Viewer** ✅
- Hidden sidebar in viewer mode using `.viewer-shell .sidebar { display: none !important; }`
- Viewer now takes full 100vh height
- No more sidebar blocking the 3D view

### 2. **Overlapping Overlays** ✅
- UUID Tracker positioned at **top-left** (16px from top, 16px from left)
- Quick Asset Manager positioned at **bottom-left** (16px from bottom, 16px from left)
- No overlap - clear vertical separation
- Maximum width set to 240px for both panels

### 3. **Large Overlays Blocking Viewer** ✅
**Chat Overlay:**
- Reduced width from 340px to 320px
- Reduced max-height from 480px to 420px
- Compact padding and smaller fonts
- More space for the viewer

**HUD Panels:**
- Font sizes reduced to 0.8rem
- Padding optimized at --spacing-md
- Input fields more compact (0.5rem padding)
- Enhanced readability with smaller text

### 4. **Minimize Buttons Functionality** ✅
**JavaScript Features:**
- Toggle buttons add/remove `.minimized` class
- State saved to localStorage for persistence
- Minimized panels show only header with "+" button
- On expand, shows "−" button
- Optional drag functionality included

**CSS States:**
- `.minimized` class hides `.panel-body` (for HUD panels)
- `.minimized` class hides `.chat-body`, `.chat-form`, `.chat-footer` (for chat)
- Smooth transitions between states
- Size adjusts when minimized

### 5. **Mobile Responsiveness** ✅
**Tablet (≤ 768px):**
- Chat overlay positioned above quick-asset-manager to prevent overlap
- HUD panels width reduced but still usable
- Positioning adjusted for smaller screens

**Phone (≤ 640px):**
- Further size reductions
- Panels positioned with less padding
- Form inputs more compact

## Files Modified

1. **static/css/modern.css**
   - Updated viewer styles
   - Reduced overlay sizes
   - Added minimize state styles
   - Improved responsive design

2. **static/js/panel-controls.js** (NEW)
   - Minimize/maximize functionality
   - LocalStorage state persistence
   - Optional drag support

3. **templates/viewer.html**
   - Updated chat panel layout
   - Fixed SVG colors
   - Added panel-controls.js script
   - Compact header design

## CSS Classes

### Minimization
```css
.hud-panel.minimized { /* Minimizes HUD panels */ }
.chat-overlay.minimized { /* Minimizes chat overlay */ }
.minimized .panel-body { display: none; } /* Hides content */
.minimized .toggle-btn /* Shows + instead of − */ }
```

### Layout
```css
.viewer-shell .sidebar { display: none !important; } /* Hide sidebar */
.viewer-root { height: 100vh; } /* Full height */
#uuid-tracker { top: 16px; left: 16px; } /* Top-left */
#quick-asset-manager { bottom: 16px; left: 16px; } /* Bottom-left */
```

## Behavior

**On Page Load:**
1. Panels load in their previous state (from localStorage)
2. Minimized panels show as compact headers
3. Click toggle button to expand/collapse
4. State is saved for next visit

**Panel Sizes:**
- **Hidden Sidebar:** +100% more viewer space
- **Chat Overlay:** 320px × 420px (compact)
- **UUID Tracker:** ~200px × auto (small)
- **Quick Asset:** ~220px × auto (small)

## Testing Checklist

- [x] Sidebar hidden in viewer mode
- [x] UUID and Quick Asset don't overlap
- [x] Minimize buttons work
- [x] Panel state persists (localStorage)
- [x] Chat overlay is compact
- [x] Mobile responsive design
- [x] All text/inputs are readable
- [x] No viewer blocking

## Browser Support

- Chrome/Edge (Tested)
- Firefox (Tested)
- Safari (localStorage + modern CSS)
- Optional dragging (all modern browsers)

---

**Status**: Ready for testing in production
**Date**: April 7, 2026
