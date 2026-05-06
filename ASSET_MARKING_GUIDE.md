# Asset Marking Feature - Implementation Guide

## Overview
This feature enables users to mark locations in a Matterport 3D space through natural language prompts. Once marked, the agent can automatically navigate users to those locations when they request related activities.

## How It Works

### 1. Marking a Location
Users can mark their current location by saying phrases like:
- "Mark this as Kitchen"
- "Tag this place as Bedroom"
- "Help me mark this location as Office"
- "Label this as Living Room"

**Process:**
1. User navigates to a location in the 3D space
2. User sends a marking request in natural language
3. The Groq router detects the `mark_asset` intent
4. The system captures the current Sweep UUID
5. The location is saved with the asset name

### 2. Activity-Based Navigation
Users can now request activities, and the agent will navigate them to the appropriate tagged location:
- "I want to cook" → Takes user to Kitchen
- "I want to sleep" → Takes user to Bedroom  
- "I need to work" → Takes user to Office
- "I want to relax" → Takes user to Living Room
- "I'm hungry" / "Let's eat" → Takes user to Dining Room

**Activity-to-Location Mapping:**
- Cook, Cooking, Prepare food → Kitchen
- Eat, Eating, Dine, Have breakfast/lunch/dinner → Dining Room / Kitchen
- Sleep, Sleeping, Rest → Bedroom
- Work, Study, Read → Office
- Shower, Bathe, Bath, Wash → Bathroom
- Watch TV, Relax, Sit, Socialize, Entertain → Living Room

## Technical Architecture

### Backend Changes

#### 1. `groq_service.py`
**New Intents:**
- `mark_asset`: User wants to tag the current location (e.g., "Mark this as Kitchen")
- `activity`: User wants to do an activity (e.g., "I want to cook")

**New Functionality:**
- Updated routing system prompt to recognize marking and activity intents
- Added `ACTIVITY_LOCATION_MAP` dictionary for semantic activity-to-location mapping
- Added `get_location_for_activity()` function for activity resolution
- Updated response schema to include `asset_name` field

**Key Functions:**
```python
def route_intent(user_message, asset_labels) -> dict
    # Returns: {
    #   "intent": "navigate|visual|mark_asset|activity|conversational",
    #   "destination_label": str or None,
    #   "asset_name": str or None,  # NEW: Name of asset to mark
    #   "reply": str or None
    # }

def get_location_for_activity(activity: str) -> str | None
    # Maps activity like "cook" to "kitchen"
```

#### 2. `api.py` - `/api/vla` Endpoint
**New Intent Handling:**
- `mark_asset` intent: Returns response asking for sweep UUID capture
- `activity` intent: Maps activity to location and attempts navigation

```python
if intent == "mark_asset":
    # Returns: {
    #   "ok": True,
    #   "intent": "mark_asset",
    #   "asset_name": str,
    #   "needs_capture": False,
    #   "hint": "Send the current sweep UUID to complete the marking."
    # }

if intent == "activity":
    # Map activity to location and navigate
    # Or return helpful message if location not yet tagged
```

#### 3. `api.py` - New `/api/mark-asset` Endpoint
**Purpose:** Save/mark a location with asset information

**Request:**
```json
{
  "map_id": int,
  "asset_name": str,  // Name for this location (e.g., "Kitchen")
  "sweep_uuid": str,  // Current sweep ID captured from SDK
  "description": str, // Optional description
  "category": str     // Optional category
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Location marked as 'Kitchen'",
  "asset_id": int
}
```

**Features:**
- Creates new Asset record in database
- Updates existing asset if name already exists
- Requires authentication (API key login)
- Validates map_id ownership
- Logs action to ChatHistoryLog

### Frontend Changes

#### `viewer.js`
**New Variables:**
```javascript
let currentSweepUuid = null;  // Tracks the user's current location
```

**SDK Sweep Tracking:**
When SDK connects, the viewer now:
1. Subscribes to `SWEEP_ENTER` events to track location changes
2. Gets initial sweep UUID on connection
3. Updates `currentSweepUuid` whenever user moves

**New Function: `markAsset(assetName)`**
- Sends current location + asset name to `/api/mark-asset`
- Validates that current location is available
- Returns confirmation or error

**Enhanced Form Submission:**
- Added handler for `mark_asset` intent
- Automatically captures current sweep and marks location
- Shows visual feedback during marking process
- Navigates successfully to newly marked location

**Response Handling:**
```javascript
if (data.intent === "mark_asset" && data.asset_name) {
    // Automatically capture sweep and mark location
    const markResult = await markAsset(data.asset_name);
    appendLine("agent", markResult.message);
}
```

## Database Schema (No Changes Required)

Existing `Asset` model is used:
```python
class Asset(db.Model):
    asset_id = db.Column(db.Integer, primary_key=True)
    map_id = db.Column(db.Integer, db.ForeignKey(...))
    label_name = db.Column(db.String(200))      # "Kitchen", "Bedroom", etc.
    sweep_uuid = db.Column(db.String(64))       # Location in 3D space
    description = db.Column(db.Text)
    category = db.Column(db.String(100))
```

## Usage Examples

### Example 1: Marking a Kitchen
```
User: "I'm at the kitchen area now, mark this as Kitchen"
Agent: [Detects mark_asset intent, captures current sweep]
Agent: "Location marked as 'Kitchen'!"

User: Later... "I want to cook"
Agent: [Maps "cook" to "kitchen", finds marked Kitchen asset]
Agent: "Navigating to Kitchen..."
[User automatically moved to Kitchen]
```

### Example 2: Multiple Locations
```
User: (at different location) "Tag this as Office"
Agent: "Location marked as 'Office'!"

User: "Help me mark this place as Bedroom"
Agent: "Location marked as 'Bedroom'!"

User: "I need to work"
Agent: [Finds marked "Office" location]
Agent: "Taking you to Office..."
```

### Example 3: Updating Markers
```
User: "I moved the office setup, mark this as Office"
Agent: [Detects existing "Office", updates sweep location]
Agent: "Office location updated!"
```

## Error Handling

1. **No Current Location:**
   - Error: "Current location not detected. Move around the space first."
   - Solution: User must move in 3D space; SDK needs to register sweep

2. **Missing Asset Name:**
   - Error: "I understand you want to mark a location, but I couldn't extract the asset name."
   - Solution: User should say "Mark this as [specific name]"

3. **Activity Without Tagged Location:**
   - Error: "I'd love to help you [activity], but I haven't tagged a '[location]' location yet."
   - Solution: User can mark the location by visiting it first

4. **Not Authenticated:**
   - Error: "Unauthorized"
   - Solution: User must be logged in

## Future Enhancements

1. **Batch Marking:** Enable marking multiple locations in one session
2. **Location Aliases:** Support multiple names for same location ("Living Room" = "Lounge")
3. **Category-Based Marking:** Auto-categorize by room type
4. **Time-Based Activities:** Map time of day to activities ("breakfast" → morning + kitchen)
5. **Privacy Settings:** Hide/show marked locations from other users
6. **Photo Snapshots:** Attach photos to marked locations for quick visual reference
7. **Voice Commands:** Full voice interface for marking

## Testing Checklist

- [ ] Mark location with natural language prompt
- [ ] Verify sweep UUID is captured correctly
- [ ] Navigate to marked location
- [ ] Request activity and verify auto-navigation
- [ ] Update existing marker
- [ ] Test with multiple assets
- [ ] Verify database entries are created
- [ ] Test error cases (no location, no name, etc.)
- [ ] Verify chat history logs marking actions
- [ ] Test activity mapping for various phrases
