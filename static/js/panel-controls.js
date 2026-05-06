/**
 * Viewer Panel Control Script
 * Handles minimize/maximize functionality for HUD panels and chat overlay
 */

document.addEventListener('DOMContentLoaded', function() {
  console.log('[Panel Controls] Initializing...');
  
  // Get all toggle buttons
  const toggleButtons = document.querySelectorAll('.toggle-btn');
  console.log('[Panel Controls] Found', toggleButtons.length, 'toggle buttons');
  
  toggleButtons.forEach((button, index) => {
    button.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      
      console.log('[Panel Controls] Button clicked:', index);
      
      // Find the parent panel
      const panel = this.closest('.hud-panel') || this.closest('.chat-overlay');
      if (!panel) {
        console.warn('[Panel Controls] Could not find parent panel for button', index);
        return;
      }
      
      console.log('[Panel Controls] Found panel:', panel.id);
      
      // Toggle minimized class
      const isMinimized = panel.classList.toggle('minimized');
      console.log('[Panel Controls] Panel', panel.id, 'is now:', isMinimized ? 'minimized' : 'normal');
      
      // Update button text
      this.textContent = isMinimized ? '+' : '−';
      this.title = isMinimized ? 'Maximize panel' : 'Minimize panel';
      
      // Save state to localStorage
      const panelId = panel.id;
      if (panelId) {
        localStorage.setItem(`panel_${panelId}_minimized`, isMinimized);
        console.log('[Panel Controls] Saved state for', panelId);
      }
    });
  });
  
  // Restore panel states from localStorage
  const panels = document.querySelectorAll('.hud-panel, .chat-overlay');
  if (panels.length === 0) return;
  
  panels.forEach(panel => {
    const panelId = panel.id;
    if (panelId) {
      const wasMinimized = localStorage.getItem(`panel_${panelId}_minimized`) === 'true';
      if (wasMinimized) {
        panel.classList.add('minimized');
        const toggleBtn = panel.querySelector('.toggle-btn');
        if (toggleBtn) {
          toggleBtn.textContent = '+';
          toggleBtn.title = 'Maximize panel';
        }
      }
    }
  });
  
  // Make panels draggable (optional enhancement)
  makePanelsDraggable();
});

/**
 * Make panels draggable (optional)
 */
function makePanelsDraggable() {
  const panels = document.querySelectorAll('.hud-panel, .chat-overlay');
  
  panels.forEach(panel => {
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    
    const header = panel.querySelector('.panel-header, .chat-header');
    if (!header) return;
    
    header.addEventListener('mousedown', startDrag);
    
    function startDrag(e) {
      // Don't drag if clicking on buttons
      if (e.target.closest('button')) return;
      
      isDragging = true;
      initialX = e.clientX - panel.offsetLeft;
      initialY = e.clientY - panel.offsetTop;
      
      panel.style.cursor = 'grabbing';
      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', stopDrag);
    }
    
    function drag(e) {
      if (!isDragging) return;
      
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      
      // Constrain to viewport
      const maxX = window.innerWidth - panel.offsetWidth;
      const maxY = window.innerHeight - panel.offsetHeight;
      
      currentX = Math.max(0, Math.min(currentX, maxX));
      currentY = Math.max(0, Math.min(currentY, maxY));
      
      panel.style.left = currentX + 'px';
      panel.style.top = currentY + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    
    function stopDrag() {
      isDragging = false;
      panel.style.cursor = 'default';
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', stopDrag);
    }
  });
}
