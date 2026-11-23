# Transcriber

Records a conversation through the microphone, turns it into text, then runs a correction pass over the finished transcript. Works in English, Hebrew and Arabic.

## Windows

On this computer: double-click the **Transcriber** icon on the desktop (or `Transcriber.bat`). The app opens in its own window. The first time, allow the microphone when asked.

On another computer: copy `Transcriber-Setup.zip` over, extract it, and run `Install.bat`. It downloads Node.js and Google Chrome if they are missing (through winget), installs the app to `%LOCALAPPDATA%\Programs\Transcriber`, and puts the Transcriber icon on the desktop.

An internet connection is needed while recording.

## Android

The Android version is the same app installed from Chrome as a home-screen app. Android only gives a web app the microphone when it is loaded from an `https://` address, so the `app` folder has to be put online once (any static host works: GitHub Pages, Netlify, Cloudflare Pages).

1. Upload the contents of the `app` folder to the host.
2. Open the address in Chrome on the phone.
3. Chrome menu (⋮) → **Add to Home screen** → **Install**.
4. Open Transcriber from the home screen and allow the microphone.

## Using it

1. Pick the language being spoken: English, עברית or العربية. You can switch while recording.
2. Press **Start recording** and talk. **Pause** holds the recording and **Resume** continues it.
3. Press **Stop**. A window asks what to save: the corrected transcript, the raw transcript, the list of fixes, and the audio recording. Files go to the Downloads folder.
4. The corrected text also stays on screen. **Original** shows what the recognizer heard; the **automatic fixes** list shows every change that was made.
5. Edit the text directly if needed, then **Copy text**, or **Export…** to open the save window again.

The audio recording is kept only until the app is closed, so save it before closing. On Android, audio recording is off by default because the phone usually cannot share the microphone between the recorder and speech recognition; it can be switched on in Settings.

## What the correction pass does

The code is in `app/corrector.js`. It runs four stages over the whole transcript:

1. **Better alternative** – the recognizer gives up to three guesses per phrase. For phrases it was unsure about, the guess whose words fit the rest of the conversation wins.
2. **Clean-up** – removes filler sounds and stutters ("the the", "I think I think"), re-attaches prefixes that were split off ("ש אני" → "שאני", "و قال" → "وقال"), fixes letter forms.
3. **Context rules** – sound-alike words chosen by the words around them: their/there/they're, your/you're, its/it's, to/too, then/than, "should of"; עם/אם in Hebrew; common Arabic misspellings (لاكن, هاذا, انشاء الله).
4. **Consistency** – a name or word that appears once and differs from a frequently used one only by a sound-alike letter (Kalil/Khalil, תכניון/טכניון) is unified with the frequent spelling.

Then sentences get a capital letter and a full stop or question mark.

Run the tests with `node tests/corrector.test.js`.

## Limits

- Speech recognition is the browser's online service (Google's in Chrome). Audio is sent there while recording; the transcript is stored only on the device.
- One language is recognized at a time. Switch the language button when the speakers switch.
- The correction pass is rule-based. It fixes the patterns listed above, not every mishearing, and it is strongest in English.
