# Voice Capture — iOS Shortcut Setup

## What This Does

One tap on your iPhone homescreen records a voice thought, saves it to Google Drive, and it's ready for Kai to process in your next PAI session.

## Prerequisites

- iPhone with iOS 16+
- Shortcuts app (built-in)
- Google Drive app installed and signed in

## Step-by-Step: Create the Shortcut

### 1. Open Shortcuts App

Open the **Shortcuts** app on your iPhone.

### 2. Create New Shortcut

Tap **+** in the top right to create a new shortcut.

### 3. Add Actions (in this exact order)

#### Action 1: Record Audio

- Tap **Add Action**
- Search for **"Record Audio"**
- Select it
- Settings:
  - Audio Quality: **Normal** (keeps file size small)
  - Start Recording: **On Tap** (or Immediately if preferred)
  - Finish Recording: **On Tap**

#### Action 2: Encode Media

- Tap **+** to add next action
- Search for **"Encode Media"**
- Select it
- Settings:
  - Input: **Recorded Audio** (should auto-populate)
  - Audio Only: **ON**
  - Format: **M4A** (AAC)

#### Action 3: Format Date (for filename)

- Tap **+** to add next action
- Search for **"Format Date"**
- Select it
- Settings:
  - Date: **Current Date**
  - Format: **Custom**
  - Custom format: `yyyyMMdd_HHmmss`

#### Action 4: Set Variable (filename)

- Tap **+** to add next action
- Search for **"Text"**
- Select **Text** action
- Set the text to: `capture_` then insert the **Formatted Date** variable, then `.m4a`
- Result should look like: `capture_[Formatted Date].m4a`

#### Action 5: Save File

- Tap **+** to add next action
- Search for **"Save File"**
- Select it
- Settings:
  - Input: **Encoded Media**
  - Service: **Google Drive** (you may need to grant access)
  - Destination Path: `/VoiceCaptures/`
  - File Name: Use the **Text** variable from step 4
  - Ask Where to Save: **OFF**
  - Overwrite If File Exists: **ON**

#### Action 6: Show Notification

- Tap **+** to add next action
- Search for **"Show Notification"**
- Select it
- Settings:
  - Title: **Captured!**
  - Body: Leave empty or set to: `Thought saved to VoiceCaptures`

### 4. Name the Shortcut

- Tap the dropdown at the top
- Name it: **Capture Thought** (or whatever you prefer)
- Choose an icon (microphone recommended)

### 5. Add to Home Screen

- Tap the **...** menu (top right of shortcut editor)
- Tap **"Add to Home Screen"**
- Choose icon and name
- Tap **Add**

## Usage

1. **Tap the widget** on your homescreen
2. **Speak your thought** (tap stop when done)
3. **See "Captured!"** notification
4. That's it — the file syncs to Google Drive automatically

## Processing Your Captures

In a PAI session, tell Kai:
- "Process my captures"
- "Check my voice notes"
- "What did I capture today?"

Kai will transcribe, classify, and present your thoughts organized for discussion.

## Troubleshooting

**"Google Drive" not showing as save destination:**
- Open Google Drive app first and sign in
- In Shortcuts, you may need to tap "Apps" → "Google Drive" → "Save File"

**Recording quality issues:**
- Try switching Audio Quality to "Very High"
- Speak clearly and close to the phone

**Files not syncing to PC:**
- Check Google Drive for Desktop is running on your Windows PC
- Verify files appear at `G:/My Drive/VoiceCaptures/`

**Shortcut not on homescreen:**
- Go to Shortcuts app → long press the shortcut → Details → Add to Home Screen

## Notes

- Files are ~50-100KB per minute of audio (M4A format)
- Google Drive typically syncs within 1-2 minutes
- Audio stays on your Google Drive — never sent to external APIs
- Transcription happens locally on your PC using faster-whisper
