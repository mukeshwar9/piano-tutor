# piano-tutor

An aligned piano tutor for a TV mounted above a 61-key keyboard. The TV draws a 61-key strip calibrated to sit exactly above the real keys, notes fall in each key's lane, and the song only moves on when the right keys are pressed (wait mode), or plays on at a set speed and judges your timing (tempo mode). A grand staff of sheet music can run along the top. Notes come from the keyboard over USB MIDI or, with any acoustic piano or keyboard, through a microphone.

It is a small Node server with zero dependencies and two browser pages:

- `/piano`: the TV page. Falling notes inside the calibrated strip in each hand's colour (right hand blue, left hand pink), the keys the song is waiting for lit in their hand's colour, correct keys in green, a wrong key in red with a hint ("B4 → try C5, one white key to the right"), bar, accuracy and streak in the side margins. Opens the calibration by itself until one is saved.
- `/piano`, tutorial mode: ten lessons that start from the very first step, on the same page (see Tutorial mode).
- `/piano/link`: the input page, open on the computer the keyboard is plugged into (or a phone or laptop with a microphone). It reads the keyboard with Web MIDI (or listens through a microphone, see Mic mode) and relays every note on/off to the server, plays Hear it first on the keyboard through its MIDI output (the same USB cable), shows whether the keyboard, its sound output, the server and the TV page are connected, and has calibration, song, hand, loop, view and tempo controls, plus a test keyboard (click, or type A W S E D F T G Y H U J K) for trying everything without a keyboard.

The server relays notes from the link page to the TV over Server-Sent Events and keeps the calibration, score history and songs.

## Hardware

- A TV or monitor with a browser, placed directly above the keyboard: a smart TV browser, or a Fire TV Stick running Fully Kiosk Browser (the remote keys below are the Fire TV's).
- A 61-key keyboard (C2 to C7) with USB MIDI. It was built with a Casio CT-S1, which is class-compliant USB-MIDI (no driver) over its micro-USB port. Other key counts work too: calibration reads the lowest and highest key.
- Or no cable at all: any piano or keyboard and a microphone on the device running the link page (Mic mode).
- A computer that runs the server, usually also the one the keyboard plugs into, with Node 18 or later and Chrome (for Web MIDI).

## Setup

```sh
git clone <this repo> piano-tutor
cd piano-tutor
node server.js
```

It listens on `0.0.0.0:4420` (set `PIANO_PORT`, or `port` in `config.json`, to change it).

1. Connect the keyboard's USB port to the computer with a data cable.
2. On that computer, open `http://localhost:4420/piano/link` in Chrome and allow MIDI devices when asked. Web MIDI only works on `localhost` or HTTPS, so open it by `localhost`, not by the LAN address. "Keyboard: CASIO USB-MIDI" (or similar) turns green when it is found. Keep the tab open while playing.
3. On the TV's browser, open `http://<server-lan-address>:4420/piano`.

`node server.js` with no arguments needs nothing else; `npm test` (or `node test/<name>.test.js`) runs the tests.

### Start it at login (macOS)

`com.example.piano-tutor.plist` is a LaunchAgent template. Replace `__REPO__` with the repo's absolute path, `__NODE__` with the node binary (`command -v node`) and `__HOME__` with your home folder, then:

```sh
cp com.example.piano-tutor.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.piano-tutor.plist
```

Logs go to `~/Library/Logs/piano-tutor.log`. Restart after config changes with `launchctl kickstart -k gui/$(id -u)/com.example.piano-tutor`; remove it with `launchctl bootout gui/$(id -u)/com.example.piano-tutor` and delete the plist.

### Settings

`config.json` (optional, not in git; see `config.example.json`) or environment variables:

- `port` / `PIANO_PORT`: the port (default 4420).
- `wallUrl` / `PIANO_WALL_URL`: another page the TV can switch to with Fast-Forward, such as a dashboard served elsewhere, for example `http://{host}:4410/`. `{host}` stands for the host the TV loaded the piano page from. Empty (the default): no other page, and Fast-Forward only shows a note. See Switching pages.
- `bulb` (`config.json` only): `{ "host": "192.0.2.10", "enabled": true }`, the address of a WiZ colour bulb on the same network (see Room light). Without a host the light does nothing.
- `PIANO_SONGS_DIR`: the songs folder (default `songs/`). `PIANO_LESSONS_DIR`: the tutorial lessons folder (default `lessons/`).
- `PIANO_CAL`: the calibration file (default `piano-calibration.json`); `PIANO_HISTORY`: the score history (default `piano-history.json` next to the calibration). `PIANO_LIGHT`: the room light switch (default `piano-light.json`, same place). `PIANO_PROGRESS`: the tutorial progress (default `piano-progress.json`, same place). None of them is in git.

## Room light

A WiZ colour bulb can follow what you play. Put its address in `config.json` (`"bulb": { "host": "192.0.2.10" }`, a documentation address here; use your bulb's own) and restart. The server talks to it locally over UDP port 38899 and sends no more than 8 updates a second. On macOS it goes through one long-lived `/usr/bin/nc -u` child, because macOS blocks Local Network access for a node process started by launchd (the LaunchAgent) while allowing `nc`; elsewhere node's own UDP socket is used. `bulb.transport` (`"nc"` or `"udp"`) forces one.

The colour is one slowly moving blend of the notes played in the last couple of seconds, the newest leading, so chords blend and a melody walks through colours. Each pitch class has a place on the chosen palette in pitch order (C lowest, B highest), so a scale walks along the palette one way and a fifth is a clearly different colour. The register shifts hue and brightness a little, and saturation (55 to 100 percent, low-passed) rises with the extremes of the keyboard and with fuller chords. The colour eases towards the target with a cap on how far hue, saturation and brightness may move per tick, so even a fast run drifts rather than flashes. Brightness stays between about 18 and 65 percent (a little louder or higher is a little brighter). Four seconds after the last note it fades slowly to the palette's calm idle glow, and ten minutes after that the bulb is given back as it was. The first note after a pause fades in from where the bulb was.

Palettes: Spectrum (the full colour wheel, the default), Aurora (greens, teals, violets), Sunset (reds, oranges, magentas, pinks), Ocean (blues, cyans, teals) and Warm (amber, the softest look). Choose one with the chooser next to the switch on the link page, or with O on the piano page (or a click on its name); it eases over, nothing jumps. `bulb.palette` in `config.json` sets the first choice.

The switch is on by default. Flip it with the Light line on the piano page (click, or B on a keyboard) or the Room light button on the link page; `GET /api/piano/light` reads it and `POST /api/piano/light {"enabled":false}` and/or `{"palette":"ocean"}` sets it (`{ enabled, configured, status, palette, palettes }`, status one of `no-bulb`, `off`, `searching`, `not-found`, `ready`, `active`). The switch and the palette are saved in `piano-light.json`; until they have been used, `bulb.enabled` and `bulb.palette` in `config.json` decide. Turning it off stops all sending and puts the bulb back to the state it had (read with `getPilot`) before the light first took control. A bulb that cannot be reached never slows the piano: it shows as "bulb not found" and is asked again quietly every 15 seconds.

To tune the look, change the constants at the top of `light.js` (`PALETTES`: hue arc, saturation range and idle colour of each palette; `DEFAULTS`: decay time, brightness band, register shifts, easing, per-tick caps and idle delay; `paletteT` is the pitch-to-palette map) and the timing in `bulb.js` (`DEFAULTS`: update rate, probe interval, release time). Both are plain objects.

## Calibration

Three steps, from the stool; run again whenever the keyboard or TV moves. Use the TV remote or the buttons on the link page:

1. Press the lowest key, then move the left blue line with ◀ ▶ until it sits on that key's left edge as seen from the playing position. OK.
2. Press the highest key, then move the right blue line onto its right edge. OK.
3. Play a few keys: each lights a beam straight above itself. OK saves, Back goes back.

◀ ▶ move a line by 1 TV pixel (about 0.75 mm on a 65-inch TV); held keys, Shift or the link page's 10 buttons move 10. The keys in between follow from the two edges, with black keys at their real offsets. Switch off Transpose on the keyboard first: the page warns when the end keys do not read as C. The calibration is stored on the server in `piano-calibration.json`, in the device pixels of the screen it was made on; a screen of a different width scales it.

## Remote and keyboard keys

On the TV page (Fire TV remote keys arrive as keydown events in Fully Kiosk; letters are for a computer keyboard):

- ◀ ▶: previous / next song (while a practice loop runs: move the loop by a bar).
- ▲ (or H): cycle right hand / left hand / both hands. ▲ three times within about a second also switches the telemetry readout (see Telemetry); the three presses cycle the hand all the way round, so it ends as it was.
- ▼ (or C): calibrate.
- OK: pause, or replay a finished song. R restarts.
- Play-Pause (or L): loop the bar being played, or stop the loop.
- Rewind (or P): Hear it first. Press Rewind twice within half a second, or hold it, or press W, to hear the whole song instead.
- Fast-Forward (or M): switch to the other page (see Switching pages).
- E: tutorial mode (also by stepping ◀ or ▶ past the ends of the song list). F: finger numbers on / off. X: light effects (Off, Lite, Neon + Sparks, All). D: the telemetry readout (fps, frame times, effects level, note-to-light delay). V: falling notes, sheet music or both. S: progress screen. T: tempo mode on / off, and - / = change its speed. K: metronome on / off. N: count-in on / off. U: speed ramp on / off. These have no free remote key; the link page has the same controls.

Menu and Back never reach the page in Fully Kiosk, which is why Rewind and Fast-Forward were chosen (checked with `adb shell input keyevent`).

## Practising

Hands and practice loop:

- Hand mode is Right, Left or Both, chosen with ▲ on the remote or the link page and remembered by the TV browser. In Right or Left mode the other hand's notes still fall, dimmed, and are not waited for; playing one of them while it sounds is not counted as a mistake. A song with one hand only always plays that hand.
- Play the other hand: with Right or Left chosen and the keyboard's MIDI output open, the keyboard plays the hand you are not practising, so you practise one hand against the other. It plays at the song's tempo, in step with the TV's clock: in wait mode the other hand follows the song position your hand has reached (it stops where the TV waits for your key and goes on when you play it), in tempo mode it follows the clock, and in a practice loop it plays only the loop's bars and starts again with each pass. The TV sends the notes a quarter of a second ahead as `POST /api/piano/listen` with `auto: true` (the same route Hear it first uses) and the link page queues them on the MIDI output, apart from Hear it first, and does not count them as your input. With both hands, no MIDI output (or a microphone as the input) or no link page, nothing is played and the other hand's notes only fall dimmed, as before. Pausing, finishing, Hear it first, changing the song, hand or loop, calibration, closing the TV page or losing it on the link page release every note still sounding.
- A practice loop repeats one bar or a range of bars. A pass with no wrong key is clean; the right side shows the clean passes in a row as dots (●●○) and the loop finishes after 3 clean passes in a row. A wrong key starts the count over. Notes outside the loop are dimmed. OK loops again after a finish; Play-Pause stops the loop. The link page has hand buttons and a bar range picker.

Hear it first: Rewind on the remote (or P, or the link page's Hear it first button) makes the keyboard play the bar being practised, or the whole loop while one runs, at the song's tempo and for the chosen hand mode. The link page queues every note on the keyboard's Web MIDI output with its own timestamp (channel 1, velocity 80), so the timing holds in a background tab. The TV shows a green "Listen" badge, runs the notes down at tempo and lights each key in its hand's colour as it sounds; afterwards the song is back where it was waiting. Keys arriving while it plays (and for 250 ms after) are not counted, and the link page drops anything the keyboard sends back that matches a note it was just told to play (local echo or MIDI thru). Pressing it again stops it. Without a MIDI output the TV still lights the keys.

Hear the whole song: press Rewind twice quickly on the remote (this needs no key repeat, which Fully Kiosk on a Fire Stick may not send), or hold it (where the key repeats, about half a second starts it), press W at the TV, or use the link page's Hear the whole song button. The keyboard plays the entire song from the first bar to the end at the song's own tempo (at the speed slider's setting in tempo mode), both hands, or only the hand chosen. The TV shows a green "Playing the whole song" badge with a progress bar and the current bar ("Bar 12 of 80"), runs the falling notes down in time and lights the keys as they sound. It stops at once on any of: the same key again (Rewind, W, or the button, which reads Stop the song meanwhile), any key played on the keyboard, or leaving the song (another song, a new hand or loop, calibration, the wall page, closing the page). Afterwards the song is back where it was waiting (in tempo mode: at the start of the song or loop with a count-in).

The song is not sent in one piece, so a seven-minute song costs no more than a short one. The TV cuts it into 4 s chunks and sends each one 3 s before it is due, one at a time, to `POST /api/piano/listen` as `{ whole: true, first, last, base, span, events }` (`base` is the chunk's start in ms from the song's start, each event's `at` counts from `base`, and a chunk with no notes is still sent: it tells the link page the TV is alive). The link page starts its clock at the first chunk and queues each chunk's messages on the MIDI output at their place on it, so the output never holds more than a few seconds of notes. A lost connection ends the song cleanly: if a chunk cannot be sent the TV stops and shows it; if the link page loses the server, or no chunk arrives for a few seconds after the last one was due, it releases every key and stops; a chunk that arrives long after its time is skipped rather than played in a burst. Without a MIDI output the TV still lights the keys.

Tempo mode: the link page's Wait mode / Tempo mode buttons (or T) choose how the song moves, remembered by the TV browser. In tempo mode the song does not wait: after a one-bar count-in (a big 1 2 3 4 on the TV) the notes fall at the song's tempo scaled by the link page's speed slider, 50% to 100% in steps of 5 (75% to start, also remembered). Each note is judged by when it is struck: within 110 ms of its time it is on time (green), within 300 ms early or late (amber), and a note not struck by then is missed (dark red). A key far from any note's time is wrong, with the same hint as wait mode. Hand modes and the practice loop work as in wait mode, with a count-in before every pass; a pass is clean with no missed note and no wrong key.

Metronome, count-in and speed ramp: the link page's Metronome button (or K) clicks every beat in tempo mode, with the first beat of each bar accented, through the TV's speakers (Web Audio). The clicks follow the song's tempo times the speed, and have their own volume slider. The count-in (on by default; the Count-in button or N) is the one bar of clicks and the big 1 2 3 4 before every start and every loop pass; with it off the notes start at once. The speed ramp (the Speed ramp button or U, with a target slider, 100% by default) works while a practice loop runs in tempo mode: each clean pass raises the speed by 5% up to the target, and a pass with a miss or wrong key holds it. The TV shows the ramp in the mode line and the loop box ("ramp 80% → 100%"). A raise starts the clean count over, so the loop finishes after 3 clean passes at the target, and the ramp starts from the speed slider each time the loop starts. The TV browser remembers the metronome, count-in and ramp settings. Wait mode has no clicks: it waits for keys, so there is no beat to follow.

Sheet music: a grand staff across the top of the strip, right hand on the treble staff and left hand on the bass staff, 2 to 4 bars wide, drawn with VexFlow from the same song data. The step being waited for is amber with an amber playhead, steps played turn green, or red after a wrong key, and the hand not being practised is dimmed. Bar numbers are the ones the practice loop uses and the loop's bars are shaded. Three views, remembered by the TV browser: Falling notes, Both (the default) and Sheet music; switch with the link page's view buttons or V. The key signature comes from the song's `key` or the major key that fits the notes best, the time signature from `beatsPerBar`, and note starts and ends are snapped to sixteenths so MIDI imports come out readable.

Finger numbers: songs can give each note a finger, 1 (thumb) to 5 (little finger), drawn on each falling note and lit key; the link page's Finger numbers button (or F) hides or shows them. All shipped songs carry beginner fingering.

Score history: every finished play (a whole song, or a practice loop that reached its clean passes) is saved on the server in `piano-history.json` (the newest 2000 plays are kept): song, hand mode, wait or tempo mode and speed, loop range, accuracy, timing, best streak, wrong keys, duration and date. The TV shows the song's best accuracy and streak, a results card when a song or loop finishes, and a progress screen (the link page's Show progress on the TV button, or S) with every song's best scores. Timing is the share of struck notes within 110 ms of their time (the same green "on time" as tempo mode), plus the average early or late offset in ms (under 15 ms reads as on the beat). It is recorded only in tempo mode, at any speed, since wait mode waits for the player and shows timing as n/a. Missed notes count against accuracy, not timing, and entries saved before timing existed load with no timing. The results card shows it, and the progress screen shows each song's best timing from whole-song tempo plays. A song is **mastered** when one whole-song play in Both hands at full speed reached 95% accuracy or better.

## Light effects

The TV page can draw its notes as light, in the style of the glowing piano videos: bars with a halo, sparks that burst from a key and drift up, keys that light and sink when they are pressed, and an aurora behind the falling notes. Every effect is drawn from gradients made once at start, added together on the one canvas; nothing is copied from any video or artwork.

Four levels, cycled with X on a keyboard at the TV or chosen on the link page (Light effects: Off, Lite, Neon + Sparks, All), with an intensity slider (0-100%, 65 to start). Both are remembered by the TV browser (`localStorage` keys `pianoFx` and `pianoFxIntensity`).

| Level | What it draws |
|---|---|
| Off | Exactly the page without effects. |
| Lite (the default) | A halo on the bar that is sounding, a flash where it meets the hit line, sparks from the pressed key and a lit, sinking key with a beam. Light enough for a Fire TV Stick. |
| Neon + Sparks | Also a halo and a trailing light on every falling bar, and a glow along the hit line. |
| All | Also Aurora: soft curtains of light behind the falling notes that slide towards the latest notes, in the colours of the room light's palette (O changes both). It is a few CSS elements behind the canvas, so it costs no canvas drawing. |

How the effects behave:

- They follow how hard a key is struck: MIDI velocity sets the size of the flash and the number and speed of the sparks. The microphone hears no velocity and counts as 0.7. A chord shares one budget, each note getting 1/√n of it, so a big chord brightens the screen instead of whiting it out.
- A pressed key sinks a little, takes its hand's colour (right blue, left pink) and sends a beam up. A judged colour (green, amber, red) always wins over the hand colour. A wrong key gets red light and no sparks: the effects never celebrate a mistake.
- Hear it first lights the keys with its own look at 60%: a tinted key with a bright rim and a hollow beam with a pulse travelling up it, and half the sparks. Keys the music plays do not sink.
- With the sheet music up, the effects stay in the falling strip below it and the staff panel is drawn on top; with sheet music only, just the key light and short sparks remain. Dimmed notes (the hand not being practised) get no glow.
- Calibration always draws without effects.
- If frames run slow the page steps down by itself: slower than 30 fps for 1.5 s drops one level (1: no Aurora, 2: a third of the sparks, 3: lite bars and no hit-line glow) and 8 s of comfortably fast frames bring it back. Changing the level on the TV starts again from the full level.
- The telemetry readout (see Telemetry) shows the governor's level next to the preset, the live sparks and the effects' draw time in ms. It works with the effects Off too, for measuring a baseline. Opening the page as `/piano?nogov` switches the governor off, to measure a level without it stepping down.

The code is `public/piano-fx.js` (a module like `piano-core.js`; its settings, governor and particle pool are tested in `test/piano-fx.test.js`).

## Telemetry

Is the Fire TV slow? The TV page can show its own speed in the bottom left corner, below the side columns and clear of the keys, the falling notes and the hit line, and report the same numbers to the server so they can be read from the Mac. It is off by default.

Switch it on or off any of these ways; the choice is remembered by the TV browser (`localStorage` key `pianoTelemetry`):

- On the Fire TV remote: press ▲ three times within about a second. The remote has no free key, so this is a short sequence; the three presses cycle the hands right, left, both and back, so the hand ends as it was, and a toast says "Telemetry on" or "Telemetry off".
- D on a keyboard at the TV.
- The link page's Telemetry button (card "TV speed").
- `/piano?telemetry=1` (or `=0`) in the address; it is remembered too.

What the readout shows (it is redrawn twice a second at most, never per frame):

- fps now (the last second) and the average over 5 s; the worst frame time in the last 5 s; the number of long frames (over 50 ms) in the last 10 s. The text turns amber under 45 fps average and red under 30.
- The effects preset and the governor's level (`gov -` with the effects off, `gov off` with `?nogov`), the live sparks and the effects' draw time.
- Note-to-light: the time from a played note arriving at the page (from the link page, over the server) to the end of the frame that draws it, last, average and maximum over 10 s. It shows "no notes yet" until real notes are played; Hear it first and other notes the TV plays itself are not measured. It is the page's own delay (event handling plus waiting for the next frame and drawing it), not the network or the keyboard, and the browser still presents the frame after that, up to one frame later.
- The Chrome (WebView) version, the device pixel ratio and the viewport size, and JS heap memory where `performance.memory` exists.

While it is on, the TV posts the numbers to `POST /api/piano/telemetry` at most every 2 s (never more than one request in flight). `GET /api/piano/telemetry` returns them from the Mac:

```sh
curl -s http://localhost:4420/api/piano/telemetry
```

```json
{ "live": true, "ageMs": 1400, "latest": { "fps": 48.2, "fps5": 51.7, "worst": 96.4, "long": 3, "level": 1, "preset": "lite", "latency": { "last": 30, "avg": 28.4, "max": 61, "n": 5 }, "mem": 40, "chrome": "114", "dpr": 1.5, "w": 1280, "h": 720, "at": 1700000000000 },
  "summary": { "samples": 30, "spanMs": 58000, "fpsMean": 51.2, "fpsMin": 44.8, "worstMs": 120.5, "longFrames": 4, "latency": { "avgMs": 29, "maxMs": 88, "notes": 6 } }, "now": 1700000001400 }
```

`latest` is the newest sample, `summary` covers the newest 30 (about a minute), `ageMs` says how old the latest is and `live` is false when nothing came in the last 6 s (telemetry off, or the TV page closed); `latest` and `summary` are null before the first report. The link page shows the same numbers and updates as they arrive. The server keeps the newest 150 samples in memory only: nothing is written to disk, and a sample holds numbers, the effects preset, the Chrome major version and the screen size, nothing that identifies a person or the device (the user agent is not sent). The code is `public/piano-telemetry.js` (frame window, latency, key sequence, readout; pure, tested in `test/piano-telemetry.test.js`) and `telemetry.js` (the store, tested in `test/telemetry-store.test.js` and `test/server.test.js`). Measuring costs very little: a frame only writes one number into a fixed ring, and the statistics are worked out when the readout is redrawn.

## Tutorial mode

A complete beginner can start here. Ten short lessons teach the keyboard, the note names, the fingers, the beat, two hands and reading music, one idea per step, with large plain text on the TV (32 px or more at 1080p) and a few encouraging lines after each step. Everything on the piano page is reused: the aligned keyboard and key lighting, the falling notes, the sheet music, wait mode and tempo mode with the metronome and count-in, Hear it first, and the timing score. A wrong key never costs anything: it shows red, the right key shows amber, and the lesson waits.

Opening it: step ◀ or ▶ on the remote past the end of the song list (the tutorial sits between the last song and the first), press E on a keyboard, open `/piano?learn=1`, or use the Tutorial card on the link page. The menu shows a progress strip, the ten lessons and where you stopped. Remote keys: ▲ ▼ choose, OK start or resume, ⏯ start the lesson over, ◀ ▶ back to the songs. In a lesson: ▶ next (or skip a step you are stuck on, but never a check), ◀ back, OK continue (or try a check again), ▲ start the step again, ⏪ (or P) hear it, ⏯ pause a timed step, ▼ the lesson list. A hint line at the bottom of the panel always shows the keys that work.

The lessons:

| # | Lesson | What it teaches | Check |
| --- | --- | --- | --- |
| 1 | Meet the keyboard | White and black keys, the groups of two and three, every C, middle C | Find five Cs |
| 2 | Note names | C D E F G A B, walking up and down, finding notes by name | Ten named notes |
| 3 | Right hand and fingers | Sitting, finger numbers 1 to 5, thumb on middle C, C D E F G | Up and down |
| 4 | Beats and note lengths | A steady beat, counting, quarter, half and whole notes | Timing |
| 5 | Your first tunes | Hot Cross Buns and Mary Had a Little Lamb, slowly and with the click | Mary |
| 6 | Left hand | Bass position, five fingers, a C and G bass line | Left-hand five-finger line |
| 7 | Rests and time signatures | Counting a rest, 4/4 and 3/4, an accented first beat | Timing |
| 8 | Reading the staff | Lines and spaces, the treble clef, C to A, matching a note to a key | Read and play a line |
| 9 | Hands together | Twinkle Twinkle Little Star: one hand, then both | Both hands, bars 1 to 4 |
| 10 | Your first piece | Ode to Joy, right hand then both, and a summary of what you learned | Both hands, timed |

A lesson is a list of steps. The step types are `explain` (text, optional lit keys, finger numbers, letters, the black-key groups or a staff; next with ▶ or any key), `find` ("play any C", any matching key counts), `play` (a short sequence in wait mode, or in tempo mode with `tempo` and `metronome`; `hand`, finger numbers, `blind` to hide the lit keys, `view` for sheet music), `repeat` (the same sequence again faster, with the click, or without highlights), `rhythm` (play on the click, scored with the timing logic), `read` (a note on a staff, press its key) and `check` (a short final exercise with a pass mark, 80% by default, as many tries as needed). A check can score the notes (`metric: "accuracy"`, the default) or the share of notes on the beat (`"timing"`, used with `tempo`).

Progress is saved per lesson in `piano-progress.json` next to the score history (not in git; `PIANO_PROGRESS` changes the path): not started, in progress with the last step (so a lesson resumes where you stopped), or passed with the best accuracy. Lessons unlock in order, each after the one before it is passed, and any passed lesson can be played again. A missing or damaged file just means starting fresh.

Adding a lesson: drop a JSON file into `lessons/`; the files are read in file name order (`11-sharps-and-flats.json` comes after `10-...`), and the next time the lesson menu opens it is there; no restart is needed. A lesson has an `id` (lower-case words joined by dashes), a `title`, a one-line `goal` and a list of `steps`:

```json
{
  "id": "my-lesson",
  "title": "My lesson",
  "goal": "Play three notes.",
  "steps": [
    { "type": "explain", "title": "Three notes", "text": "Thumb on C, then D and E.", "highlight": ["C4", "D4", "E4"], "fingers": { "C4": 1, "D4": 2, "E4": 3 } },
    { "type": "find", "prompt": "Play any E", "target": "E" },
    { "type": "play", "notes": [["C4", 0, 1, 1], ["D4", 1, 1, 2], ["E4", 2, 1, 3]], "hand": "right", "bpm": 60 },
    { "type": "check", "notes": [["E4", 0, 1, 3], ["D4", 1, 1, 2], ["C4", 2, 1, 1]], "hand": "right", "bpm": 60, "blind": true, "pass": 0.8 }
  ]
}
```

Notes are `[name, startBeat, lengthBeats, finger]` as in song files (`[name, start, length, "R" or "L", finger]` for a note with its own hand). A step can also take its notes from a library song, `"song": { "id": "ode-to-joy", "from": 1, "to": 4 }` (bars), and the server fills in the notes. Keys in `highlight` are `"C4"` (that key) or `"C*"` (every C); a `find` target is `"C"` (any C) or `"C4"` (that key only), with `count` for several different keys. Keep texts short: a `text` is at most 190 characters. Run `node validate-lessons.js` (it is part of `npm test`) to check every lesson: it fails on a malformed step, a note outside the 61 keys, a text too long for the TV, or a library song that does not exist. The lessons are read by the server and served at `GET /api/piano/lessons` (and `/api/piano/lessons/<id>`).

## Mic mode

The link page's Input card switches between Keyboard cable (MIDI) and Microphone, remembered by that browser. With Microphone the page listens through the microphone of whatever device runs it (a computer, a laptop, or a phone on the music rest: Chrome on Android, Safari on iPhone), finds the note being played and sends it to the TV exactly like a MIDI note.

- Start listening asks for the microphone. A level meter shows the sound with the gate a note has to pass, and the last note heard with its tuning. Sensitivity Low / Normal / High moves the gate for a noisy room or a soft piano.
- The check listens to the room to set the noise gate, then asks for any C and reports the note, its tuning and the delay from the key to the page.
- Detection runs in the browser (`public/pitch.js`): YIN pitch detection on the signal taken down to about 12 kHz, an energy envelope for onsets, a noise gate that follows the room's noise floor, and a comb filter that cancels the previous note still ringing.
- One note at a time is reliable; chords are not (a microphone hears one pitch). So while the input is the microphone the TV is forgiving: the right note name an octave up or down counts, only a chord's top note is waited for, and the other hand is not counted wrong. Practising one hand at a time works best.
- Microphone access (and Web MIDI on a phone) needs a secure page on any device other than the server's own `localhost`: put the server behind an HTTPS reverse proxy (Caddy, nginx or similar) and open the link page through it. Keep the page in front with the screen on; phones pause the microphone in the background.

## Songs

Thirteen songs ship in `songs/`, listed here from easiest to hardest:

| Song | Composer / origin | Level (1-5) | Time | Hands |
| --- | --- | --- | --- | --- |
| Mary Had a Little Lamb | Traditional (American, c. 1830) | 1 | 4/4 | Right |
| Frere Jacques | Traditional (French, 18th century) | 1 | 4/4 | Right |
| London Bridge Is Falling Down | Traditional (English) | 1 | 4/4 | Right |
| Au clair de la lune | Traditional (French, 18th century) | 1 | 4/4 | Right |
| Twinkle Twinkle Little Star | Traditional, "Ah vous dirai-je, maman" (c. 1761) | 1 | 4/4 | Both |
| Ode to Joy | Beethoven, Symphony No. 9 (1824) | 2 | 4/4 | Both |
| When the Saints Go Marching In | Traditional (African-American spiritual) | 2 | 4/4 | Both |
| Jingle Bells | James Lord Pierpont (1857) | 2 | 4/4 | Both |
| Amazing Grace | Traditional (American), tune New Britain (1829) | 2 | 3/4 | Both |
| Minuet in G | Christian Petzold (c. 1725) | 3 | 3/4 | Both |
| Greensleeves | Traditional (English, 16th century) | 3 | 6/8 | Right |
| Canon in D | Johann Pachelbel (c. 1680-1706) | 3 | 4/4 | Both |
| Für Elise | Beethoven (1810) | 4 | 3/8 | Both |

Each JSON song carries an optional `difficulty` from 1 (easiest) to 5; the TV does not use it yet and lists songs alphabetically by file name. The new songs are short beginner arrangements in easy keys, transposed to C where the original is in another key.

## Adding songs

Songs are files in `songs/`: JSON, MIDI (`.mid`) or MusicXML (`.musicxml`, zipped `.mxl`). Drop one into the folder, or add it with the link page's Add a song file button, and within seconds it is in the TV's ◀ ▶ list; no restart is needed. The TV plays the song last chosen on it, else the first one, or `?song=<file name without extension>`.

JSON songs:

```json
{
  "title": "Ode to Joy",
  "composer": "Ludwig van Beethoven",
  "license": "Public domain",
  "hand": "right",
  "bpm": 80,
  "beatsPerBar": 4,
  "key": "C",
  "notes": [["E4", 0, 1], ["E4", 1, 1], ["F4", 2, 1]]
}
```

Each note is `[name, startBeat, lengthBeats]`, `[name, startBeat, lengthBeats, hand]` with hand `"R"` or `"L"`, or either form with a finger added: `[name, startBeat, lengthBeats, hand, finger]`, or `[name, startBeat, lengthBeats, finger]` (names like `C4`, `F#3`, `Bb2`; C4 is middle C). A note without a hand belongs to the song's `hand` (right when absent). Notes starting on the same beat form a chord. Notes outside the calibrated range are moved by an octave and outlined in violet. `key` is optional and only sets the sheet music's key signature. `difficulty` is optional too, 1 (easiest) to 5, and is not used by the TV yet.

- MIDI (format 0 or 1): each track (and channel) is a part; with two or more parts the highest-sounding one is the right hand and the lowest the left. A one-part file is split by pitch at middle C. Timing is snapped to sixteenths (or eighth-note triplets), near-simultaneous notes become chords, ghost notes and drums are dropped.
- MusicXML: staff 1 of a two-staff part is the right hand and staff 2 the left. Tempo, bars, chords, ties and `<fingering>` are read; grace notes are left out; repeats are played as written once.

The link page's Song files card lists every file with its load error, if any, and for MIDI and MusicXML a hands setting, the split note and a Re-import button; settings are saved next to the file as `<file>.import.json`. Uploads are limited to 8 MB, must import cleanly, and never replace an existing file.

## Switching pages

The TV can share the screen with another page, such as a dashboard on another server. Set `wallUrl` to its address; Fast-Forward then goes there, and the link page's Show the wall / Show the piano buttons switch the TV with `POST /api/switch {"to":"wall"|"piano"}`. The other page links back to `http://<this server>:4420/piano`, and to hear the link page's switch requests it can open `GET /api/piano/events?role=wall` on this server (Server-Sent Events, allowed from any origin) and follow `switch` events. Switching reloads the page; the calibration lives on the server, so it survives.

## API

- `GET /api/piano/events?role=tv|link|wall`: Server-Sent Events: `midi`, `control`, `calibration`, `light`, `presence`, `tv-state`, `listen`, `songs`, `history`, `switch`.
- `POST /api/piano/input` (`{"events":[{"on":true,"note":60,"velocity":90}]}`), `POST /api/piano/control` (`{"cmd":"calibrate|nudge|ok|back|restart|pause|song|hand|loop|listen|fingers|fx|fxIntensity|progress|view|tempo|speed|metronome|metronomeVolume|countin|ramp|rampTarget|learn|fx|fxIntensity|telemetry", ...}`), `POST /api/piano/listen`, `POST /api/piano/device`, `POST /api/piano/state`.
- `GET /api/piano/songs[/<id>]`, `POST /api/piano/upload?name=<file name>`, `POST /api/piano/import`.
- `GET|POST /api/piano/light` (the room light switch), `GET|POST /api/piano/telemetry` (the TV's speed numbers, see Telemetry), `GET|POST /api/piano/calibration`, `GET|POST /api/piano/history`, `GET /api/piano/presence`.
- `GET /api/piano/lessons`, `GET /api/piano/lessons/<id>`, `GET|POST /api/piano/progress` (tutorial lessons and `{ lesson, action: "step" | "attempt" | "pass", step?, score? }`).
- `POST /api/switch`, `GET /api/config`, `GET /api/debug` (viewport beacon, logged).

## Tests

`npm test` runs every file in `test/`: calibration math, songs, wait and tempo modes, the practice loop and Hear it first (`piano-core`), hearing the whole song (`whole-song`: the plan, its chunks and the chunked sender against a fake sender and clock), the other hand played for the player (`auto-hand`: when it plays, its scheduling in wait mode, tempo mode and a loop, and the no-output and Both-hands cases), the speed ramp, metronome and count-in (`ramp-metronome`), mic-mode pitch detection on synthesized piano notes (`pitch`), MIDI and MusicXML import (`song-import`, fixtures written by `test/fixtures/make-fixtures.js`), score history and timing (`piano-history`), the room light's colour and bulb handling with a fake UDP bulb and a fake `nc` child (`light`, `bulb`), the song library (`song-library`, which loads every file in `songs/` and checks it is valid), the tutorial (`lessons`: lesson validation including every shipped lesson, the step runner, pass marks and retries, progress and unlock order, and the validator script; `lesson-server`: the lesson and progress endpoints), `validate-lessons.js` (run first by `npm test`), sheet music (`piano-sheet`), the light effects' settings, frame-rate governor and particle pool (`piano-fx`), the TV telemetry (`piano-telemetry`: frame-time window statistics, long frames, note-to-light latency, the remote's key sequence; `telemetry-store`: the server's in-memory store), remote keys and switch addresses (`switch`), and the server end to end (`server`).

## Licences

- This project: MIT, see `LICENSE`.
- VexFlow 4.2.5 (MIT, `public/vendor/vexflow-LICENSE.txt`) is vendored as `public/vendor/vexflow-4.2.5-bravura.js`: the npm package's `build/cjs/vexflow-bravura.js`, unmodified (sha256 `d632111c9dc0eedc095e22b1a61913c23c5d166865e4fece61e1554535de355e`), with the Bravura music font built in (SIL Open Font License 1.1), so the TV needs no internet.
- The shipped songs are all public domain: traditional melodies (Mary Had a Little Lamb, Frere Jacques, London Bridge, Au clair de la lune, Twinkle Twinkle Little Star, Greensleeves, When the Saints Go Marching In) and works by composers who died long before 1900: Ludwig van Beethoven (Ode to Joy, 1824; Für Elise, 1810; d. 1827), Johann Pachelbel (Canon in D, c. 1680-1706; d. 1706), Christian Petzold (Minuet in G, c. 1725; d. 1733) and James Lord Pierpont (Jingle Bells, 1857; d. 1893). Amazing Grace is the melody of the tune New Britain (1829) only, without lyrics. The arrangements and fingering in `songs/` are part of this project, and each file's `source` field names where its melody was checked.
