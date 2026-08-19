# Phone test: will the browser keep your data?

**This is for you, Zach, not for an agent.** It should take about twenty
minutes, plus one two-minute check a week later.

---

## Read this part first

Hashigo will keep your 7,716 cards and 102,020 reviews inside the browser's own
private storage on your phone. Browsers are allowed to **delete that storage
without asking** when the phone runs low on space — the database and every audio
file, all at once. There is a way to ask the browser not to: a call named
`persist()`. Whether it says yes depends on things only your real phone can
decide.

**Everything below needs your physical device. No agent in this run could test
any of it, and none of us pretended to.** What we *did* test, on a Windows
desktop in real Chrome:

- The code that asks for permanent storage works, and works in both directions —
  we forced a "yes" and a "no" and the app reported each correctly.
- All ~700 MB fits, writes in roughly 4-25 seconds on a desktop once it is local
  (measured spread 61-149 MiB/s across runs; expect a phone to be slower), and
  reads back in a fraction of a millisecond.
- Two tabs at once gives a clear error, not scrambled data. We checked your
  numbers before and after and nothing was damaged.
- If storage *is* wiped, rebuilding everything from `exports/` on the PC takes
  **16.4 seconds**, audio included.

The three things we could not test, and that this checklist is for:

1. **Whether your phone's Chrome grants permanent storage.** On desktop it said
   no. The documented behaviour is that installing a site to the home screen
   usually flips it to yes. That is step 4 and it is the most important step
   here.
2. **Whether ~700 MB is comfortable on your phone**, as opposed to merely legal.
3. **Whether it all survives being left alone for a week.**

The full engineering detail is in `notes/persistence.md`. You do not need it.

---

## Before you start

You need:

- Your Android phone, and your PC.
- A USB cable (route A below). Strongly preferred — it is less fiddly than
  Wi-Fi, needs no firewall change, and it is the only route that lets you test
  the "add to home screen" step properly.
- Roughly 1 GB free on the phone. The test writes ~700 MB and then deletes it.

On the PC, once:

```bash
npm run spike:bootstrap
node spike/persist/make-icons.mjs
```

The first makes a 69 MB copy of your database for the phone to download. The
second draws the two app icons the "add to home screen" step needs.

---

## Route A — USB cable (recommended)

This makes the phone see the PC's server as `localhost`. That matters more than
it sounds: browsers only allow this private storage on `https://` sites or on
`localhost`, and a plain LAN address like `http://192.168.20.22:<port>` **does not
count** — we tested it (on port 5274, though the port is irrelevant: the scheme
and host decide, not the port), and the storage API is not merely restricted
there, it is completely absent. Route A sidesteps that entirely.

**On the phone, one time only:**

1. Settings → About phone → tap **Build number** seven times. It will say
   "You are now a developer".
2. Settings → System → **Developer options** → turn on **USB debugging**.

**Then, each time:**

3. Plug the phone into the PC with the cable. If the phone asks, choose **File
   transfer** (not "charging only"). Accept the "Allow USB debugging?" prompt.
4. On the PC, start the server and leave this window open:

   ```bash
   npm run spike:dev
   ```

   It will print `http://localhost:5273/`.

5. On the PC, in Chrome, open **`chrome://inspect/#devices`**.
   - Tick **Discover USB devices**. Your phone should appear by name.
   - Click **Port forwarding…**
   - Tick **Enable port forwarding**.
   - Add one row: left box `5273`, right box `localhost:5273`. Click **Done**.

6. On the **phone**, in Chrome, go to:

   ```
   http://localhost:5273/persist/
   ```

No firewall changes are needed on this route — the traffic goes down the cable.

---

## Route B — Wi-Fi, no cable

Use this only if the cable route will not cooperate. It cannot properly test
step 4 (the home-screen install), so do route A eventually.

1. Phone and PC on the **same Wi-Fi**. Not a guest network — guest networks
   usually block phone-to-PC traffic entirely.

2. On the PC:

   ```bash
   npm run spike:dev -- --host
   ```

   It prints a `Network:` line, something like
   `http://192.168.20.22:5273/`. Note that address.

3. **Windows Firewall.** The first time you use `--host`, Windows pops up
   *"Allow Node.js to communicate on these networks"*. Tick **Private
   networks** and click **Allow**. If you dismissed it, or nothing appeared,
   open PowerShell **as Administrator** and run:

   ```powershell
   New-NetFirewallRule -DisplayName "Hashigo spike 5273" -Direction Inbound `
     -Protocol TCP -LocalPort 5273 -Action Allow -Profile Private
   ```

   Tidy up afterwards with:

   ```powershell
   Remove-NetFirewallRule -DisplayName "Hashigo spike 5273"
   ```

4. **On the phone**, Chrome will refuse to use private storage on a plain
   address, so tell it to trust this one. In Chrome on the phone:
   - Go to `chrome://flags`
   - Search for **insecure origins treated as secure**
   - Set the dropdown to **Enabled**
   - In the text box type exactly your address including the port, e.g.
     `http://192.168.20.22:5273`
   - Tap **Relaunch**

   *(We confirmed this flag rescues the page on desktop Chrome. We could not
   confirm it on Android — if the page still says "secure context: false" after
   relaunching, the flag did not take, and you should use route A.)*

5. Open `http://192.168.20.22:5273/persist/` on the phone.

---

## The test

### Step 1 — read the coloured bar at the top

The page runs itself as soon as it loads. The bar at the very top is the answer
to the whole question.

| bar | what it means |
|---|---|
| **Red** — "STORAGE IS BEST-EFFORT" | The browser has *not* promised to keep your data. It may delete all of it, at once, when the phone gets full. Expected on a first visit. Go to step 4. |
| **Green** — "STORAGE IS PERSISTENT" | The browser has promised not to delete Hashigo's data to reclaim space. This is what we want. |

### Step 2 — read the numbers panel

Just under the bar. Write these down or use **copy all of this** at the bottom
of the page.

| line | what a good answer looks like | what a bad answer means |
|---|---|---|
| `secure context` | **true** | If false, nothing else on this page can work. Storage is switched off entirely. Fix the route first (step 4 of route B, or switch to route A). |
| `persisted()` | true is what we want, **false is expected at first** | false = the browser may delete everything without warning. |
| `persist() granted` | same as above | |
| `quota` | some number of GiB | This is how much the browser says you may use. See the warning below. |
| `OPFS usage` | ~66 MiB after the database loads | How much Hashigo is actually using. |
| `installed (display-mode)` | `no (browser tab)` at first, **`yes (standalone)`** after step 4 | This is how we know the home-screen install really took. |
| `oracle from OPFS` | **MATCHES** | This means all 7,716 cards and 102,020 reviews arrived intact. If it says anything else, stop and tell me. |
| `worker can request persistence` | always `NO` | Expected. Not a problem — it is a fact about how browsers are built. |

**About `quota`:** ignore the percentage. On the desktop the browser reported the
same fixed headroom no matter how much we had stored — it will happily say "7%
used" right up until writes start failing. The `OPFS usage` number is real; the
percentage is not a warning system.

### Step 3 — does it survive being closed?

1. Tap **reload the page**.
2. Look at the transcript at the bottom for the line
   `/hashigo.db already in OPFS — reattaching, not re-importing`.

If you see that, the 69 MB database stayed on the phone and did not have to be
downloaded again. That is the basic promise working.

**Then the stronger version:** close Chrome completely (swipe it away from the
app switcher), reopen it, and go back to the page. Same line should appear.

### Step 4 — install it to the home screen ★ THE IMPORTANT ONE

This is the step most likely to turn the red bar green. Browsers treat an
installed app far more generously than a tab.

1. In Chrome on the phone, tap the **⋮** menu.
2. Tap **Add to Home screen**, or **Install app** if that is offered instead.
   *(If it offers "Install app", take it — that is the real install. "Add to
   Home screen" alone may only make a shortcut.)*
3. Confirm.
4. **Close Chrome entirely.** Then open Hashigo from the new home-screen icon
   (it is a small yellow ladder).
5. Look at the numbers panel again:
   - `installed (display-mode)` should now say **`yes (standalone)`**.
   - Look at the top bar.

**Then tap "re-ask for persistence" once**, and read the bar again. Asking again
matters: on the desktop the browser said no *without recording a refusal*, which
means a later ask can still succeed. The app re-asks on every launch for exactly
this reason.

| result | what it means |
|---|---|
| Bar turns **green** after installing | **Best outcome.** Your data is as safe as a browser can make it. This is the answer we most need. |
| Bar stays **red** even when installed | Also a real answer, and an important one. It means Hashigo must treat the phone as a cache, not a home — and stage 11 sync becomes required, not optional. |

Either way, **write down which one happened.** This single result changes the
design.

### Step 5 — the ~700 MB of audio

1. Tap **fill ~700 MB, then delete it**. It will take a while — on the desktop
   anywhere from 4 to 25 seconds depending on the run, on a phone expect longer,
   possibly a lot longer. (These are audio-SHAPED synthetic bytes at the real size
   distribution, not your actual mp3s — the point is the volume, not the audio.)
   Leave the
   screen on.
2. Read from the transcript:
   - `INSERTED 10,816 blobs / 624.6 MiB in …s` — how long your phone took.
   - `50 random BLOB reads: avg … ms` — how fast playing a card's audio would
     be. Desktop was 0.17–0.29 ms. Anything under ~5 ms is fine.
   - `estimate() AFTER : usage … / quota …` — did the phone let you have it?
3. Also note whether the phone got hot, whether Chrome was killed, and whether
   anything else on the phone complained about storage.

| result | what it means |
|---|---|
| Finishes, usage ~778 MiB, reads under 5 ms | All the audio can live on the phone. Offline review on the train just works. |
| Finishes but takes minutes | Still fine, but the first-run download should be optional, not automatic. |
| Fails with a storage or quota error | Then the phone should fetch audio a day at a time. See §6 of `notes/persistence.md` — a typical study day only needs about **7 MB**. |

The test deletes the 700 MB again on the way out. Note, though: on the desktop,
deleting it did **not** reduce the reported usage — that space only comes back
via **delete ALL storage** in step 7. So if usage looks stuck high, that is
expected, not a bug.

### Step 6 — two tabs

You will do this by accident one day, so let us find out now.

1. Tap **hold the database**.
2. Tap **open a second tab**.
3. In the new tab, look at the transcript. It should say:
   `Web Lock NOT available — another tab owns the database. This tab is a
   FOLLOWER.`
4. Now tap **force open anyway** in that second tab. It *should* fail with a
   long message containing `Access Handles cannot be created`.
5. Go back to the first tab and tap **open the database**. Check
   `oracle from OPFS` still says **MATCHES**.

| result | what it means |
|---|---|
| Second tab refuses, first tab still MATCHES | Correct and expected. A clear error is the good outcome. |
| Second tab succeeds while the first still holds it | Tell me immediately — that would be much worse than an error. |
| First tab's numbers changed | Same. Tell me immediately. |

Then close the second tab and tap **force open anyway** in the remaining tab.

Expect this to be annoying, and it is our bug rather than the browser's: closing
a tab really does release the database immediately, but the current code caches
the first failure and keeps reporting it. On the desktop it took five tries over
about fifteen seconds before it cleared. If it is still failing, **reload the
page** and it will work. There is a one-line fix noted for whoever picks up
`src/db/browser.ts` (ORPHAN 3 in `notes/persistence.md`) — you are just seeing it
before it is fixed.

### Step 7 — lose everything on purpose, then get it back

Completely safe. Everything here rebuilds from `exports/` on the PC.

1. Tap **delete ALL storage (simulate eviction)**. `OPFS usage` should drop to
   `0.0 MiB`.
2. **Reload the page** — this step is required; the storage system needs a fresh
   start after that wipe.
3. Tap **recover from nothing** and read
   `TOTAL database recovery: …s`. Desktop measured 1.3-2.7 s over a cable, and that
   figure covers the card database only, NOT the 624.6 MiB of audio. Over Wi-Fi it
   will be dominated by downloading 69 MB.

The point of this step: notice that after the wipe, the page looked completely
normal. **A browser gives no notification when it deletes your data.** An empty
app and a freshly-installed app look identical. That is why the finished app has
to check and tell you.

### Step 8 — one week later (two minutes)

Do not skip this one; it is the only test of the thing we actually fear.

1. Use the phone normally for a week. Do not open Hashigo.
2. Then open it from the home-screen icon and read:
   - the coloured bar
   - `OPFS usage`
   - whether the transcript says `already in OPFS` or re-downloads

If it re-downloaded, the phone threw your data away while you were not looking —
and that is the whole argument for building sync sooner rather than later.

---

## When you are done

Tap **copy all of this** at the bottom of the page and paste it somewhere. It
includes your phone's browser version, every number, and the whole transcript.

The five answers that matter most:

1. Did the bar go **green** after installing to the home screen? (step 4)
2. How long did the 700 MB write take, and did it finish? (step 5)
3. What was the random-read time? (step 5)
4. Did the second tab fail cleanly, with your numbers intact? (step 6)
5. After a week, was the data still there? (step 8)

---

## If something goes wrong

| symptom | likely cause |
|---|---|
| `secure context: false`, quota `0.00 GiB` | You are on a plain `http://` address the browser does not trust. Route A, or route B step 4. This is not a bug in the app; the browser removes the storage API entirely. |
| Page never finishes loading on the phone | The dev server sends a lot of small files. Give it a minute on first load. |
| `404` / `hashigo-bootstrap.db is not there` | Run `npm run spike:bootstrap` on the PC. |
| The ladder icon is missing after installing | Run `node spike/persist/make-icons.mjs` on the PC, then reload and re-install. |
| Phone cannot reach the PC at all on route B | Guest/isolated Wi-Fi, or the firewall rule. Try route A. |
| `chrome://inspect` does not list the phone | USB debugging off, cable in charge-only mode, or the "Allow USB debugging?" prompt was dismissed. |
| Everything fails after the "delete ALL storage" step | Expected — reload the page. That wipe deliberately leaves the storage system unusable until reload. |

---

## One thing to decide, when you have the numbers

Should the phone hold **all** the audio, or fetch it as it goes? We deliberately
did not decide this for you. From your own data:

- All of it: **627 MiB**, once. Then it always works offline, no exceptions.
- A day at a time: **about 7 MB a day** (your last 90 days average 63 cards a
  day, and cards with audio carry 0.11 MiB each). Your busiest day in the last
  90 would have been 15.5 MB; your busiest day ever, 23.6 MB.
- Break-even is about **90 days** of use.
- 74% of your cards have audio: 5,713 of 7,716.

Because you review on the train, "fetch as you go" only works if the app
downloads tomorrow's queue while you are on Wi-Fi — which is 7 MB and takes no
time. Either choice is reversible; the audio now lives in its own file next to
the database, so it can be shipped whole or filled in piece by piece without
changing anything else.

Step 5's numbers are what should decide it. If 627 MiB writes in ten seconds and
you have the space, take the simple option.
