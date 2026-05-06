# Quick Start: Asset Marking Feature

## What Was Implemented

A complete asset marking system that allows users to:
1. **Mark locations** through natural language ("Mark this as Kitchen")
2. **Auto-navigate** based on activities ("I want to cook" → goes to Kitchen)

## Files Modified

### 1. **`app/services/groq_service.py`**
- Added 2 new intent types: `mark_asset` and `activity`
- Added `ACTIVITY_LOCATION_MAP` dictionary (20+ activity-to-location mappings)
- Updated router prompt to recognize marking & activity requests
- Updated response schema with `asset_name` field

### 2. **`app/routes/api.py`**
- Updated `/api/vla` endpoint to handle `mark_asset` and `activity` intents
- Added new `/api/mark-asset` endpoint to save locations
- Automatically creates/updates Asset records in database
- Includes proper error handling and authentication

### 3. **`static/js/viewer.js`**
- Added `currentSweepUuid` tracking
- Implemented `SWEEP_ENTER` event listener for location tracking
- Added `markAsset()` function to capture and save locations
- Enhanced form handler to process mark_asset requests

### 4. **`ASSET_MARKING_GUIDE.md`** (NEW)
- Complete technical documentation
- Usage examples
- Error handling guide
- Testing checklist

## How to Test

### Test Scenario 1: Mark a Location
1. Open viewer in browser
2. Navigate to a location in the 3D space
3. Say: **"Mark this as Kitchen"**
4. Agent should respond: **"Location marked as 'Kitchen'!"**
5. Check dashboard → Manage assets to verify it was saved

### Test Scenario 2: Activity-Based Navigation
1. You should have marked at least one location (e.g., "Kitchen")
2. Navigate to a different location
3. Say: **"I want to cook"**
4. Agent should automatically navigate to the Kitchen
5. Agent says: **"Navigating to Kitchen..."**

### Test Scenario 3: Multiple Locations & Activities
1. Mark Kitchen: "Tag this as Kitchen"
2. Mark Bedroom: "Mark this place as Bedroom"  
3. Mark Office: "Tag this as Office"
4. Try activities:
   - "I'm hungry" → Goes to Kitchen
   - "I need to work" → Goes to Office
   - "I want to sleep" → Goes to Bedroom

## Supported Activity-to-Location Mappings

| Activities | Location |
|-----------|----------|
| cook, cooking, prepare food | Kitchen |
| eat, eating, dine, breakfast, lunch, dinner | Dining Room / Kitchen |
| sleep, sleeping, rest | Bedroom |
| work, study, read | Office |
| shower, bathe, bath, wash | Bathroom |
| watch tv, relax, sit, socialize | Living Room |

You can add more mappings in `app/services/groq_service.py` in the `ACTIVITY_LOCATION_MAP` dictionary.

## Key Features

✅ **Natural Language Marking**: "Mark this as [name]", "Tag this place as [name]"  
✅ **Automatic Location Capture**: Current Sweep UUID is captured automatically  
✅ **Activity Recognition**: Understands activities like "cook", "work", "sleep"  
✅ **Database Persistence**: Assets saved to database for future sessions  
✅ **Error Handling**: Graceful errors if location not available or name missing  
✅ **Update Support**: Can update existing markers by marking with same name  
✅ **Chat Logging**: All marking actions logged to chat history  

## API Endpoints

### POST `/api/vla`
Routes user intent to appropriate action (mark_asset, activity, navigate, etc.)

**Response with mark_asset intent:**
```json
{
  "ok": true,
  "intent": "mark_asset",
  "asset_name": "Kitchen"
}
```

### POST `/api/mark-asset` (NEW)
Saves a location with an asset name

**Request:**
```json
{
  "map_id": 1,
  "asset_name": "Kitchen",
  "sweep_uuid": "uuid-here",
  "description": "Main kitchen area",
  "category": "room"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Location marked as 'Kitchen'",
  "asset_id": 5
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Mark fails with "Current location not detected" | Move around in 3D space to register sweep |
| Activity navigation doesn't work | Make sure you've marked that location first |
| "I couldn't extract the asset name" | Use clearer phrasing: "Mark this as [specific name]" |
| Assets aren't saving | Check browser console for errors, verify authentication |

## Next Steps

1. Test the feature with multiple locations
2. Add more activities to the `ACTIVITY_LOCATION_MAP` as needed
3. Consider adding location aliases (e.g., "Living room" = "Lounge")
4. Add voice commands for hands-free marking
5. Create UI overlay showing marked locations in 3D viewer

## Documentation Reference

See `ASSET_MARKING_GUIDE.md` for:
- Complete technical architecture
- Database schema details
- Enhancement ideas
- Full testing checklist
