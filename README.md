# Level Up ⚡

**Trade endless scrolling for short daily missions.** Level Up is a mobile-first web app that turns
a few minutes of distraction into quick challenges, with XP, levels and daily streaks.

> Screenshots / GIF: _add 2–3 images here (home, mission, reward/streak screen)._

## Features

- **Daily missions** with a timer and an XP reward
- **Levels and progression** with smooth animations (Motion)
- **Streaks:** consecutive days, personal record and a "perfect week" celebration
- **Frictionless sign-in:** start anonymously, then link a Google or Apple account (Firebase Auth)
- **Offline-friendly:** persistent Firestore cache
- **Firestore security rules** that validate field types and document ownership
- **1v1 challenge flow (prototype):** lobby, invite link/QR and match result screens

## Tech stack

| Layer | Technology |
|---|---|
| UI | React 19, TypeScript, Tailwind CSS 4, Motion |
| Data & auth | Firebase Auth, Cloud Firestore (with security rules), Analytics |
| Tooling | Vite, Vitest, GitHub Actions |

## Architecture

The screen, the progression rules, and storage are separate. React renders state and responds to input. XP, levels, the mission catalog, and daily streaks are pure functions with no browser dependency, and that is what the unit tests cover. Sign-in and sync go through Firebase.

```mermaid
flowchart TD
  subgraph screen [Screen]
    App["App"]
    Hook["useStreak and controller"]
  end

  subgraph rules [Rules]
    Missions["Mission catalog"]
    Progression["XP and levels"]
    Engine["Streak engine"]
    History["Daily history in UTC"]
  end

  subgraph storage [Storage]
    Local["localStorage: levelup_data"]
    Firestore["Firestore: users/uid"]
    Auth["Firebase Auth"]
  end

  User["User"] --> App
  App --> Missions
  App --> Progression
  App --> Hook
  Hook --> Engine
  Engine --> History
  Hook --> Local
  History --> Local
  App -->|"XP, level, mission, and history"| Firestore
  Firestore -->|"live snapshot"| App
  Auth --> App
```

When a mission finishes, the flow is:

1. The catalog computes that mission's duration and XP.
2. Total XP increases. On screen, the level is total XP divided by 100, rounded down. On the Firestore document, a profile with 0 XP is stored as level 1.
3. The controller appends the UTC day to the history without repeating the same day. The engine recalculates the streak, the personal record, and the perfect week.
4. State is merged into `localStorage` and, about a second later, into the `users/{uid}` document.
5. When the app opens, the Firestore snapshot restores the mission index, XP, and history. The engine reconciles the streak with today's UTC day, including older profiles that did not yet store daily history.

## Streak engine

The streak logic lives in pure, framework-free functions, which makes it easy to test:

```
src/services/streak/
├── streakEngine.ts        # current streak, personal record, perfect-week detection
├── streakEngine.test.ts   # streak unit tests (Vitest)
├── streakHistory.test.ts  # dedupe, trim and legacy history recovery
├── streakHistory.ts       # per-day (UTC) completion history and de-duplication
├── streakStorage.ts       # local persistence
└── streakTypes.ts         # shared types
src/features/streak/       # glue between the engine and the UI
src/hooks/useStreak.ts     # React hook
```

## Getting started

Requirements: Node.js 20+ and a Firebase project (Auth + Firestore enabled).

```bash
git clone https://github.com/ottonielmorais2008-rgb/level-up.git
cd level-up
npm ci
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev                  # http://localhost:3000
```

Deploy the security rules with the Firebase CLI: `firebase deploy --only firestore:rules`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run lint` | Type-check with `tsc --noEmit` |
| `npm test` | Run the unit tests (Vitest) |
| `npm run build` | Production build |

## Running the tests

The tests use Vitest and run in Node. They do not need Firebase, environment variables, or a browser.

```bash
npm ci
npm test
```

`npm test` runs every `*.test.ts` file: progression (XP, levels, and mission rewards), streak history, and the streak engine. To rerun one file while editing:

```bash
npx vitest src/services/progression/progression.test.ts
```

In continuous integration, every push and pull request runs `npm ci`, the type check (`npm run lint`), `npm test`, and `npm run build`.

## Known issues / roadmap

- **`src/App.tsx` is very large** (~3,400 lines). Next step: split it into screens and components.
- **XP and streaks are written by the client.** The Firestore rules check types, not how much XP was
  earned, so a user could inflate their own score. Plan: move XP awarding to a Cloud Function or
  limit increments in the rules.
- **Profiles are readable by any signed-in user** (including anonymous users), which is needed for
  challenges. Plan: split public and private profile fields.
- **Streak days are counted in UTC.** In Portugal, a mission completed between 00:00 and 01:00
  during summer time counts for the previous day.
- **Share/QR links point to `https://levelup.app`**, a domain this project does not control. They
  should use the app's real deployment URL (e.g. from an environment variable).
- **1v1 challenges are a UI prototype:** the invite link is generated in the browser and is not yet
  backed by real matchmaking.
- Some dependencies from the original prototype (`@google/genai`, `express`, `dotenv`) are not used by
  the current code and can be removed.

### Recently fixed

- The "perfect week" celebration never fired: the engine compared the streak before and after a
  completion using the same history. The completion is now compared against the history from
  *before* it was recorded (covered by `streakEngine.test.ts`).

## What went wrong

The "perfect week" celebration never fired. It is supposed to run when a new completion day brings
the streak to a multiple of 7. `completeMissionFromHistory` compared the streak before and after
using the same history, which already included today's completion. That day was already marked
complete, so it was not a new day, the streak did not count as increased, and
`shouldCelebratePerfectWeek` stayed false.

That shared-history comparison is still what the function does if the earlier history is omitted
(its comment calls this the old behaviour). `streakEngine.test.ts` covers both results: `does not
celebrate twice on the same day` passes one seven-day history for both sides and expects the flag
to stay off; `detects a new completion day and celebrates a perfect week` passes the six days from
before the seventh completion and expects the flag on, with streak 7. The fix passes that earlier
history. `handleMissionStreakUpdate` sends `session.history` from before the new day is recorded,
and `completeMissionToday` copies the history before appending today.

- **XP is written by the client.** Firestore rules require `xp` to be a non-negative integer on the
  owner's document. They accept any larger value, so a signed-in user can inflate their own score.
  Plan: move XP awarding to a Cloud Function, or limit increments in the rules.
- **Streak days are counted in UTC.** In Portugal, a mission completed between 00:00 and 01:00
  during summer time counts for the previous day.
- **Share and QR links point to `https://levelup.app`**, a domain this project does not control.
  They should use the app's real deployment URL (for example from an environment variable).
- **`src/App.tsx` is very large** (about 3,400 lines). Next step: split it into screens and
  components.
- **`@google/genai`, `express`, and `dotenv` are unused.** They come from the original prototype
  and can be removed.

## How it was built

The first prototype was generated with Google AI Studio (AI-assisted development). This version adds
environment-based Firebase configuration, the streak fix with unit tests, documented known issues
and CI. Project rules for AI coding assistants are in `.cursor/rules/`.

## License

[MIT](LICENSE). `src/App.tsx` keeps the Apache-2.0 header from the original Google AI Studio template.
