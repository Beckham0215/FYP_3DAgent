# 📚 3DAgent - Complete User Manual

Welcome to **3DAgent**, your AI-powered 3D space exploration and management platform. This guide covers everything you need to know to get the most out of our application.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Account Management](#account-management)
3. [Space Management](#space-management)
4. [Using the Viewer](#using-the-viewer)
5. [AI Assistant Features](#ai-assistant-features)
6. [Location Marking & Navigation](#location-marking--navigation)
7. [Asset Management](#asset-management)
8. [Tips & Tricks](#tips--tricks)
9. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Creating Your Account

1. **Visit the Registration Page**
   - Click "Sign Up" on the login page
   - Enter your email address
   - Create a secure password
   - Click "Register" to create your account

2. **Logging In**
   - Visit the login page
   - Enter your email and password
   - Click "Login" to access your dashboard

3. **Dashboard Overview**
   - Your dashboard displays all your spaces
   - Each space shows the Matterport Space ID, creation date, and preview
   - Click "Open Viewer" to explore a space
   - Click "Manage Assets" to view tagged locations and inventory

---

## Account Management

### Profile Settings
- Your profile information is displayed in the sidebar
- Avatar icon shows your initials
- Logout button is available in the sidebar footer

### Managing Multiple Spaces
- You can create unlimited spaces
- Each space is independent with its own assets and inventory
- Switch between spaces via the dashboard

---

## Space Management

### Creating a New Space

1. **From Dashboard**
   - Click the "➕ New Space" button
   - Enter a Matterport Space ID (SID)
   - Give your space a name (optional, defaults to "My space")
   - Click "Save"

2. **What is a Matterport Space ID?**
   - It's a unique identifier for a Matterport 3D space
   - Found in the URL or provided by the space creator
   - Format: typically a long alphanumeric string

### Viewing Spaces
- Spaces appear as cards on your dashboard
- Most recently created/modified spaces appear first
- Each card shows:
  - 📍 Space name
  - 📅 Creation date
  - 🔗 Matterport SID
  - 👁️ "Open Viewer" button
  - ⚙️ "Manage Assets" button

---

## Using the Viewer

### Viewer Layout

The 3D viewer consists of several key components:

1. **Main 3D View**
   - Large interactive 3D space in the center
   - Use mouse to look around and navigate
   - Click to move to different locations

2. **Location Tracker Panel** (Top-Left)
   - Shows your current location's Sweep UUID
   - Updates in real-time as you move
   - Helpful for marking locations

3. **Quick Tag Panel** (Bottom-Left)
   - Quickly save your current location
   - Enter a location name (e.g., "Kitchen")
   - Optionally add a category (e.g., "Room")
   - Click "✓ Save Location" to mark it

4. **AI Assistant Chat Panel** (Right Side)
   - Interact with your AI guide
   - Send natural language commands
   - View assistant responses
   - See scanned asset results

### Navigation Controls

**Mouse Controls:**
- **Look Around**: Move your mouse to rotate the view
- **Move Forward**: Click a spot in the space to move there
- **Zoom**: Scroll to zoom in/out

**Voice Commands** (via AI Assistant):
- "Take me to the kitchen"
- "Go to the living room"
- "Navigate to bedroom 1"

### Panel Controls

- **Minimize Buttons**: Click "−" on any panel to collapse it
- **Expand Buttons**: Click "+" on a minimized panel to expand
- **State Persistence**: Minimized/expanded states are saved

---

## AI Assistant Features

### Starting a Conversation

1. **Send Messages**
   - Type your message in the chat input field at the bottom
   - Press Enter or click the send button
   - The assistant will respond in real-time

2. **Types of Commands**

   **Navigation Commands:**
   - "Take me to the kitchen"
   - "Go to bedroom 1"
   - "Navigate to the office"
   - ✅ Requires pre-marked locations

   **Location Marking Commands:**
   - "Mark this as Kitchen"
   - "Tag this place as Bedroom"
   - "Label this location as Office"
   - ✅ Marks current location for future navigation

   **Activity-Based Navigation:**
   - "I want to cook" → Navigates to Kitchen
   - "I'm hungry" → Navigates to Dining Room
   - "I want to sleep" → Navigates to Bedroom
   - "I need to work" → Navigates to Office
   - "I want to relax" → Navigates to Living Room
   - "I need a shower" → Navigates to Bathroom
   - ✅ Requires locations marked for these activities

   **General Questions:**
   - "What's in this room?"
   - "Tell me about the layout"
   - "Where can I find the bathroom?"
   - ✅ Natural conversation with the AI guide

### Chat Panel Features

- **Message History**: Scroll up to see previous conversation
- **Scanning Results**: View asset count by location
- **Real-time Responses**: Get instant feedback from the assistant
- **Error Messages**: Clear guidance if a command isn't recognized

---

## Location Marking & Navigation

### Why Mark Locations?

Location marking enables:
- Quick navigation via voice commands
- Activity-based assistance ("I'm hungry" → Kitchen)
- Consistent reference points
- Space inventory organization

### Marking a Location (Method 1: Quick Tag Panel)

1. **Navigate to the location** you want to mark
2. **Look at the Quick Tag panel** (bottom-left)
3. **Enter location name** (e.g., "Kitchen", "Master Bedroom")
4. **Optionally add a category** (e.g., "Room", "Bathroom")
5. **Click "✓ Save Location"**
6. **Confirmation** message will appear

### Marking a Location (Method 2: Voice Command)

1. **Navigate to the location**
2. **Open AI Assistant chat**
3. **Type or say**: "Mark this as [Name]"
4. Examples:
   - "Mark this as Kitchen"
   - "Tag this as Bedroom"
   - "Label this as Office"
5. **Assistant confirms**: "Location marked as 'Kitchen'!"

### Navigating to Marked Locations

**Via Voice Command:**
1. Open chat panel
2. Say: "Take me to [Location Name]"
3. Examples:
   - "Go to the kitchen"
   - "Take me to bedroom 1"
   - "Navigate to the office"
4. The viewer automatically moves to that location

**Via Activity:**
1. Open chat panel
2. Say an activity you want to do
3. Examples:
   - "I want to cook" → Goes to Kitchen
   - "I'm hungry" → Goes to Dining Room
   - "I need to work" → Goes to Office
   - "I want to relax" → Goes to Living Room
   - "I want to sleep" → Goes to Bedroom
4. The assistant automatically navigates to the appropriate location

### Viewing All Marked Locations

1. **From Dashboard**, click a space's "Manage Assets" button
2. **Section 1: Navigation Locations**
   - Shows all marked sweep locations
   - Displays location name, category, sweep UUID, and notes
   - Edit or delete marked locations

---

## Asset Management

### Understanding Assets

**Assets** are tagged items or inventory stored in your 3D spaces. There are two types:

1. **Navigation Locations (Manually Tagged)**
   - Sweep-linked labels for voice navigation
   - Used for "Go to Kitchen" commands
   - Created manually via the Quick Tag panel or voice commands

2. **Scanned Assets (Inventory Inventory)**
   - Items discovered through AI scanning
   - Counted by location
   - Can be edited and organized

### Accessing Asset Management

1. **From Dashboard**
   - Click a space card
   - Click "Manage Assets" button

2. **In Viewer**
   - You'll see scanned assets in the chat panel
   - Assets are organized by location/sweep

### Adding Navigation Locations

**Method 1: Quick Tag Panel**
1. In viewer, navigate to a location
2. Use the Quick Tag panel (bottom-left)
3. Enter name and optional category
4. Click "✓ Save Location"

**Method 2: Asset Management Page**
1. Go to "Manage Assets"
2. Section 1: Navigation Locations
3. Fill in the form:
   - **Location Name**: e.g., "Kitchen", "Bedroom 1"
   - **Sweep UUID**: From the location tracker in viewer
   - **Category** (optional): e.g., "Room", "Bathroom"
   - **Description** (optional): Notes about the location
4. Click "✓ Add Location"

### Editing Assets

1. **From Asset Management Page**
2. Hover over an asset row
3. Click "✏️ Edit" button
4. Update the information
5. Save changes

### Deleting Assets

1. **From Asset Management Page**
2. Find the asset you want to remove
3. Click "🗑️" button
4. Confirm deletion

### Viewing Scanned Inventory

**Scanned Assets Section** (lower part of Asset Management):
- Shows inventory results by location
- **Area Name**: Room or location name
- **Asset Name**: Item name (lowercase)
- **Count**: Number of items found
- Edit or delete individual scanned items

### Organizing Scanned Assets

1. **Edit an asset**
   - Click the row or "✏️ Edit"
   - Update area name, asset name, or count
   - Save changes

2. **View by Location**
   - Filter by area name if available
   - Helps organize inventory by room

---

## Tips & Tricks

### Productivity Tips

1. **Mark Key Locations First**
   - Create a kitchen, bedroom, bathroom, and living room locations first
   - These are your reference points

2. **Use Consistent Naming**
   - "Kitchen" instead of "kitchen", "kitch", "cook area"
   - "Master Bedroom" instead of "Master Bed", "Bedroom 1"
   - Consistency helps the AI understand better

3. **Leverage Activity Commands**
   - Instead of "Take me to kitchen" say "I'm hungry"
   - Instead of "Go to office" say "I want to work"
   - The AI can be more helpful with activity context

4. **Organize by Categories**
   - Use categories to group similar locations
   - "Kitchen" as category for kitchenettes
   - "Bathroom" as category for multiple bathrooms

5. **Add Descriptions**
   - "First floor kitchen" vs just "Kitchen"
   - "Master bedroom with ensuite" for clarity
   - Helps when you have similar room names

### Viewer Tips

1. **Finding Your Current Location**
   - Check the Location Tracker panel (top-left)
   - Shows current Sweep UUID in real-time
   - Copy this UUID to mark the location

2. **Exploring Large Spaces**
   - Use activity-based navigation to jump around
   - Say "I want to cook" to quickly reach the kitchen
   - More efficient than clicking through each location

3. **Planning Space Layout**
   - Mark all rooms first to understand the layout
   - Use the Asset Management page to see all locations
   - Helps visualize the entire space structure

4. **Mobile Friendly**
   - The viewer works on tablets and phones
   - Sidebar collapses to hamburger menu on small screens
   - Chat panel adapts to screen size

### Troubleshooting Suggestions

1. **Assistant doesn't recognize a location**
   - Make sure you've marked the location first
   - Say "Mark this as Kitchen" first, then "Go to kitchen"
   - Wait a moment for the database to update

2. **UUID not displaying**
   - Try refreshing the page
   - Make sure you're inside the 3D viewer
   - Check browser console for errors

3. **Location marking fails**
   - Verify you've entered a location name
   - Make sure the space is properly loaded
   - Try using the Asset Management page instead

---

## Troubleshooting

### Common Issues & Solutions

#### Issue: Can't See the 3D Viewer
**Solutions:**
- Check your internet connection
- Ensure JavaScript is enabled in your browser
- Try a different browser
- Clear browser cache and reload
- Check that the Matterport Space ID is correct

#### Issue: AI Assistant Not Responding
**Solutions:**
- Check your internet connection
- Refresh the page
- Make sure you're logged in
- Try a simpler command first
- Wait a moment for the server to respond

#### Issue: Location Not Marked
**Solutions:**
- Ensure you've clicked "✓ Save Location"
- Check the Location Tracker shows a valid Sweep UUID
- Try using the Asset Management page instead
- Refresh and try again

#### Issue: Navigation Not Working
**Solutions:**
- Verify the location has been marked first
- Use exact location name ("Kitchen" not "kitch")
- Try "I want to cook" instead of "Take me to kitchen"
- Check that the marked location has a valid Sweep UUID

#### Issue: Panels Overlapping
**Solutions:**
- Use minimize buttons to hide panels you're not using
- On mobile, panels adjust automatically for screen size
- Try rotating your device if on mobile
- Panels are repositionable in newer versions

### Browser Compatibility

**Recommended Browsers:**
- ✅ Chrome/Chromium (Latest)
- ✅ Firefox (Latest)
- ✅ Safari (Latest)
- ✅ Edge (Latest)

**Requirements:**
- JavaScript enabled
- Cookies enabled (for login sessions)
- WebGL support (for 3D rendering)
- XR spatial tracking support (for advanced features)

### Reporting Issues

If you encounter an issue not listed here:
1. Note the exact steps to reproduce it
2. Check the browser console for error messages (F12 → Console)
3. Try with a different browser
4. Contact support with:
   - Browser and version
   - Error message (if any)
   - Steps to reproduce

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Enter** | Send message in chat |
| **Esc** | May close dialogs (browser dependent) |
| **F12** | Open developer tools for debugging |

---

## FAQ (Frequently Asked Questions)

**Q: Can I share a space with other users?**
A: Currently, spaces are private to your account. Multi-user sharing features may be added in future updates.

**Q: How many locations can I mark?**
A: You can mark as many locations as you need. There's no practical limit.

**Q: Can I export my space data?**
A: Currently, data is stored in your account. Export functionality may be added in future versions.

**Q: What if I mark a location with the wrong name?**
A: Simply edit or delete it from the Asset Management page and mark it again with the correct name.

**Q: Does the app work offline?**
A: No, 3DAgent requires an internet connection to access Matterport spaces and AI services.

**Q: Can I download the 3D space?**
A: Spaces are streamed from Matterport. You cannot download them, but you can explore and mark them anytime.

**Q: How accurate is the activity-based navigation?**
A: The AI understands common activities like cooking, sleeping, working, etc. If a location isn't marked for that activity, the assistant will let you know.

---

## Advanced Features

### Using Sweep UUIDs

**What is a Sweep UUID?**
- Unique identifier for a specific location in the 3D space
- Shown in the Location Tracker panel
- Used internally for precise navigation

**Why use it?**
- Ensures navigation to exact location
- Can manually add locations using Sweep UUID
- Reference point for asset organization

### Asset Categories

**Predefined Categories:**
- Room
- Bathroom
- Kitchen
- Bedroom
- Living Space
- Office
- Outdoor

**Custom Categories:**
- You can create your own categories
- Helps organize similar locations
- Useful for large spaces

---

## Best Practices

1. **Start with Dashboard Overview**
   - Review your spaces and their status
   - Update space information as needed

2. **Mark Locations Systematically**
   - Mark one room at a time
   - Give clear, consistent names
   - Add categories for organization

3. **Use Natural Language**
   - Speak naturally to the AI
   - The assistant understands conversational commands
   - Longer context helps with understanding

4. **Review Marked Locations**
   - Regularly check the Asset Management page
   - Ensure all important locations are marked
   - Delete outdated or duplicate marks

5. **Provide Feedback**
   - Help improve the AI by being clear in requests
   - If a command doesn't work, rephrase it
   - Report errors to help us improve

---

## Support & Resources

### Getting Help
- Review this manual for detailed explanations
- Check the Troubleshooting section
- Explore the FAQ for common questions

### Updates & Changes
- Check the dashboard for announcements
- New features are added regularly
- Manual is updated with each major release

### Feedback
- Your feedback helps us improve
- Report issues and suggest features
- Contact support with questions

---

## Glossary

| Term | Definition |
|------|-----------|
| **Space** | A 3D environment (Matterport 3D tour) you can explore |
| **Sweep UUID** | Unique identifier for a specific location in a space |
| **Navigation Location** | A marked location you can navigate to via voice commands |
| **Asset** | A tagged location or inventory item |
| **Activity** | An action (e.g., cooking, working) that maps to a location |
| **Matterport SID** | Unique identifier for a Matterport 3D space |
| **AI Assistant** | The intelligent chat assistant that helps you navigate |
| **Viewer** | The 3D space exploration interface |

---

## Thank You!

Thank you for using 3DAgent! We're constantly working to improve your experience. Enjoy exploring your spaces with our AI assistant!

**Version:** 2.0  
**Last Updated:** April 2026  
**Platform:** Web-based 3D Space Explorer with AI Assistant

