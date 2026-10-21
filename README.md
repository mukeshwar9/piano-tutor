# piano-tutor

An aligned piano tutor for a TV mounted above a 61-key keyboard. The TV draws a 61-key strip calibrated to sit exactly above the real keys, notes fall in each key's lane, and the song only moves on when the right keys are pressed (wait mode), or plays on at a set speed and judges your timing (tempo mode). A grand staff of sheet music can run along the top. Notes come from the keyboard over USB MIDI or, with any acoustic piano or keyboard, through a microphone.

It is a small Node server with zero dependencies and two browser pages:

- `/piano`: the TV page. Falling notes inside the calibrated strip in each hand's colour (right hand blue, left hand pink), the keys the song is waiting for lit in their hand's colour, correct keys in green, a wrong key in red with a hint ("B4 → try C5, one white key to the right"), bar, accuracy and streak in the side margins. Opens the calibration by itself until one is saved.
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
- `PIANO_SONGS_DIR`: the songs folder (default `songs/`).
- `PIANO_CAL`: the calibration file (default `piano-calibration.json`); `PIANO_HISTORY`: the score history (default `piano-history.json` next to the calibration). `PIANO_LIGHT`: the room light switch (default `piano-light.json`, same place). None of them is in git.

## Room light

A WiZ colour bulb can follow what you play. Put its address in `config.json` (`"bulb": { "host": "192.0.2.10" }`, a documentation address here; use your bulb's own) and restart. The server talks to it locally over UDP port 38899 and sends no more than 8 updates a second. On macOS it goes through one long-lived `/usr/bin/nc -u` child, because macOS blocks Local Network access for a node process started by launchd (the LaunchAgent) while allowing `nc`; elsewhere node's own UDP socket is used. `bulb.transport` (`"nc"` or `"udp"`) forces one.

The colour is one slowly moving blend of the notes played in the last few seconds: each pitch class has a hue on the circle of fifths (neighbouring notes get neighbouring hues), chords blend, and the colour eases towards the target with a cap on how far hue, saturation and brightness may move per tick, so even a fast run drifts rather than flashes. Brightness stays between about 18 and 65 percent (a little louder playing is a little brighter). Four seconds after the last note it fades slowly to a warm, dim glow, and ten minutes after that the bulb is given back as it was. The first note after a pause fades in from where the bulb was.

The switch is on by default. Flip it with the Light line on the piano page (click, or B on a keyboard) or the Room light button on the link page; `GET /api/piano/light` reads it and `POST /api/piano/light {"enabled":false}` sets it (`{ enabled, configured, status }`, status one of `no-bulb`, `off`, `searching`, `not-found`, `ready`, `active`). The choice is saved in `piano-light.json`; until it has been used, `bulb.enabled` in `config.json` decides. Turning it off stops all sending and puts the bulb back to the state it had (read with `getPilot`) before the light first took control. A bulb that cannot be reached never slows the piano: it shows as "bulb not found" and is asked again quietly every 15 seconds.

To tune the look, change the constants at the top of `light.js` (`DEFAULTS`: decay time, brightness band, saturation, easing, per-tick caps, idle colour and delay) and the timing in `bulb.js` (`DEFAULTS`: update rate, probe interval, release time). Both are plain objects.

## Calibration

Three steps, from the stool; run again whenever the keyboard or TV moves. Use the TV remote or the buttons on the link page:

1. Press the lowest key, then move the left blue line with ◀ ▶ until it sits on that key's left edge as seen from the playing position. OK.
2. Press the highest key, then move the right blue line onto its right edge. OK.
3. Play a few keys: each lights a beam straight above itself. OK saves, Back goes back.

◀ ▶ move a line by 1 TV pixel (about 0.75 mm on a 65-inch TV); held keys, Shift or the link page's 10 buttons move 10. The keys in between follow from the two edges, with black keys at their real offsets. Switch off Transpose on the keyboard first: the page warns when the end keys do not read as C. The calibration is stored on the server in `piano-calibration.json`, in the device pixels of the screen it was made on; a screen of a different width scales it.

## Remote and keyboard keys

On the TV page (Fire TV remote keys arrive as keydown events in Fully Kiosk; letters are for a computer keyboard):

- ◀ ▶: previous / next song (while a practice loop runs: move the loop by a bar).
- ▲ (or H): cycle right hand / left hand / both hands.
- ▼ (or C): calibrate.
- OK: pause, or replay a finished song. R restarts.
- Play-Pause (or L): loop the bar being played, or stop the loop.
- Rewind (or P): Hear it first.
- Fast-Forward (or M): switch to the other page (see Switching pages).
- F: finger numbers on / off. V: falling notes, sheet music or both. S: progress screen. T: tempo mode on / off, and - / = change its speed. K: metronome on / off. N: count-in on / off. U: speed ramp on / off. These have no free remote key; the link page has the same controls.

Menu and Back never reach the page in Fully Kiosk, which is why Rewind and Fast-Forward were chosen (checked with `adb shell input keyevent`).

## Practising

Hands and practice loop:

- Hand mode is Right, Left or Both, chosen with ▲ on the remote or the link page and remembered by the TV browser. In Right or Left mode the other hand's notes still fall, dimmed, and are not waited for; playing one of them while it sounds is not counted as a mistake. A song with one hand only always plays that hand.
- A practice loop repeats one bar or a range of bars. A pass with no wrong key is clean; the right side shows the clean passes in a row as dots (●●○) and the loop finishes after 3 clean passes in a row. A wrong key starts the count over. Notes outside the loop are dimmed. OK loops again after a finish; Play-Pause stops the loop. The link page has hand buttons and a bar range picker.

Hear it first: Rewind on the remote (or P, or the link page's Hear it first button) makes the keyboard play the bar being practised, or the whole loop while one runs, at the song's tempo and for the chosen hand mode. The link page queues every note on the keyboard's Web MIDI output with its own timestamp (channel 1, velocity 80), so the timing holds in a background tab. The TV shows a green "Listen" badge, runs the notes down at tempo and lights each key in its hand's colour as it sounds; afterwards the song is back where it was waiting. Keys arriving while it plays (and for 250 ms after) are not counted, and the link page drops anything the keyboard sends back that matches a note it was just told to play (local echo or MIDI thru). Pressing it again stops it. Without a MIDI output the TV still lights the keys.

Tempo mode: the link page's Wait mode / Tempo mode buttons (or T) choose how the song moves, remembered by the TV browser. In tempo mode the song does not wait: after a one-bar count-in (a big 1 2 3 4 on the TV) the notes fall at the song's tempo scaled by the link page's speed slider, 50% to 100% in steps of 5 (75% to start, also remembered). Each note is judged by when it is struck: within 110 ms of its time it is on time (green), within 300 ms early or late (amber), and a note not struck by then is missed (dark red). A key far from any note's time is wrong, with the same hint as wait mode. Hand modes and the practice loop work as in wait mode, with a count-in before every pass; a pass is clean with no missed note and no wrong key.

Metronome, count-in and speed ramp: the link page's Metronome button (or K) clicks every beat in tempo mode, with the first beat of each bar accented, through the TV's speakers (Web Audio). The clicks follow the song's tempo times the speed, and have their own volume slider. The count-in (on by default; the Count-in button or N) is the one bar of clicks and the big 1 2 3 4 before every start and every loop pass; with it off the notes start at once. The speed ramp (the Speed ramp button or U, with a target slider, 100% by default) works while a practice loop runs in tempo mode: each clean pass raises the speed by 5% up to the target, and a pass with a miss or wrong key holds it. The TV shows the ramp in the mode line and the loop box ("ramp 80% → 100%"). A raise starts the clean count over, so the loop finishes after 3 clean passes at the target, and the ramp starts from the speed slider each time the loop starts. The TV browser remembers the metronome, count-in and ramp settings. Wait mode has no clicks: it waits for keys, so there is no beat to follow.

Sheet music: a grand staff across the top of the strip, right hand on the treble staff and left hand on the bass staff, 2 to 4 bars wide, drawn with VexFlow from the same song data. The step being waited for is amber with an amber playhead, steps played turn green, or red after a wrong key, and the hand not being practised is dimmed. Bar numbers are the ones the practice loop uses and the loop's bars are shaded. Three views, remembered by the TV browser: Falling notes, Both (the default) and Sheet music; switch with the link page's view buttons or V. The key signature comes from the song's `key` or the major key that fits the notes best, the time signature from `beatsPerBar`, and note starts and ends are snapped to sixteenths so MIDI imports come out readable.

Finger numbers: songs can give each note a finger, 1 (thumb) to 5 (little finger), drawn on each falling note and lit key; the link page's Finger numbers button (or F) hides or shows them. All shipped songs carry beginner fingering.

Score history: every finished play (a whole song, or a practice loop that reached its clean passes) is saved on the server in `piano-history.json` (the newest 2000 plays are kept): song, hand mode, wait or tempo mode and speed, loop range, accuracy, timing, best streak, wrong keys, duration and date. The TV shows the song's best accuracy and streak, a results card when a song or loop finishes, and a progress screen (the link page's Show progress on the TV button, or S) with every song's best scores. Timing is the share of struck notes within 110 ms of their time (the same green "on time" as tempo mode), plus the average early or late offset in ms (under 15 ms reads as on the beat). It is recorded only in tempo mode, at any speed, since wait mode waits for the player and shows timing as n/a. Missed notes count against accuracy, not timing, and entries saved before timing existed load with no timing. The results card shows it, and the progress screen shows each song's best timing from whole-song tempo plays. A song is **mastered** when one whole-song play in Both hands at full speed reached 95% accuracy or better.

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
- `POST /api/piano/input` (`{"events":[{"on":true,"note":60,"velocity":90}]}`), `POST /api/piano/control` (`{"cmd":"calibrate|nudge|ok|back|restart|pause|song|hand|loop|listen|fingers|progress|view|tempo|speed|metronome|metronomeVolume|countin|ramp|rampTarget", ...}`), `POST /api/piano/listen`, `POST /api/piano/device`, `POST /api/piano/state`.
- `GET /api/piano/songs[/<id>]`, `POST /api/piano/upload?name=<file name>`, `POST /api/piano/import`.
- `GET|POST /api/piano/light` (the room light switch), `GET|POST /api/piano/calibration`, `GET|POST /api/piano/history`, `GET /api/piano/presence`.
- `POST /api/switch`, `GET /api/config`, `GET /api/debug` (viewport beacon, logged).

## Tests

`npm test` runs every file in `test/`: calibration math, songs, wait and tempo modes, the practice loop and Hear it first (`piano-core`), the speed ramp, metronome and count-in (`ramp-metronome`), mic-mode pitch detection on synthesized piano notes (`pitch`), MIDI and MusicXML import (`song-import`, fixtures written by `test/fixtures/make-fixtures.js`), score history and timing (`piano-history`), the room light's colour and bulb handling with a fake UDP bulb and a fake `nc` child (`light`, `bulb`), the song library (`song-library`, which loads every file in `songs/` and checks it is valid), sheet music (`piano-sheet`), remote keys and switch addresses (`switch`), and the server end to end (`server`).

## Licences

- This project: MIT, see `LICENSE`.
- VexFlow 4.2.5 (MIT, `public/vendor/vexflow-LICENSE.txt`) is vendored as `public/vendor/vexflow-4.2.5-bravura.js`: the npm package's `build/cjs/vexflow-bravura.js`, unmodified (sha256 `d632111c9dc0eedc095e22b1a61913c23c5d166865e4fece61e1554535de355e`), with the Bravura music font built in (SIL Open Font License 1.1), so the TV needs no internet.
- The shipped songs are all public domain: traditional melodies (Mary Had a Little Lamb, Frere Jacques, London Bridge, Au clair de la lune, Twinkle Twinkle Little Star, Greensleeves, When the Saints Go Marching In) and works by composers who died long before 1900: Ludwig van Beethoven (Ode to Joy, 1824; Für Elise, 1810; d. 1827), Johann Pachelbel (Canon in D, c. 1680-1706; d. 1706), Christian Petzold (Minuet in G, c. 1725; d. 1733) and James Lord Pierpont (Jingle Bells, 1857; d. 1893). Amazing Grace is the melody of the tune New Britain (1829) only, without lyrics. The arrangements and fingering in `songs/` are part of this project, and each file's `source` field names where its melody was checked.
