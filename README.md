# Traffic Optimization Engine Simulator

An interactive, in-browser simulator for Twilio's Traffic Optimization Engine. It shows how messages of different priorities share a sender type's throughput under [Traffic Shaping](https://www.twilio.com/docs/messaging/features/traffic-shaping) and [Multi-Tenancy](https://www.twilio.com/docs/messaging/features/multi-tenancy), and how they flow out to carrier queues.

**Live demo:** https://toe-simulator-8125-dev.twil.io/index.html

> This is an educational model, not Twilio's production code. It follows the behavior described in Twilio's public docs and the allocation rules described below. Carrier names and default MPS values are placeholders.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
  - [Sender types and egress](#sender-types-and-egress)
  - [Traffic Shaping](#traffic-shaping)
  - [Multi-Tenancy](#multi-tenancy)
  - [Allocation vs. egress (lending)](#allocation-vs-egress-lending)
  - [Worked examples](#worked-examples)
- [Using the simulator](#using-the-simulator)
- [Presets](#presets)
- [Project layout](#project-layout)
- [Deploying to Twilio Serverless](#deploying-to-twilio-serverless)

## Quick start

There is no build step and nothing to install. Either:

- open the [live demo](https://toe-simulator-8125-dev.twil.io/index.html), or
- clone the repo and open `assets/index.html` in a browser.

Choose a preset, set Traffic Shaping and Multi-Tenancy, and press **▶ Start simulation**.

## How it works

Each sender type's throughput is divided in a fixed order. Traffic Shaping comes first, then Multi-Tenancy:

```
sender-type egress MPS
  └─ Traffic Shaping: Service Level 1 / 2 / 3   (by SL weight; one group if None)
       └─ Multi-Tenancy tier 1 / 2 / 3          (by tier weight; Weighted mode only)
            └─ subaccounts                       (even split; one shared FIFO if None)
                 └─ egress → Carrier 1, Carrier 2, Carrier 3
```

The model advances in 20 ms steps. Every step it decides how much each queue may send and delivers messages first-in, first-out within each queue.

### Sender types and egress

The simulator models three sender types: **Short Code** (default 100 MPS), **Long Code** (20 MPS) and **Alphanumeric** (30 MPS).

- Each sender type has **one egress MPS**, the downstream total shared by all of its carriers. If Short Code is set to 100 MPS, Carrier 1, 2 and 3 *together* receive 100 MPS. Each carrier does not get 100.
- Every sender type has three carriers, named **Carrier 1**, **Carrier 2** and **Carrier 3**. Messages are spread evenly across them as they leave the queue.
- Sender types are independent. Traffic on Short Code never affects Long Code.

### Traffic Shaping

Traffic Shaping assigns each message a **Service Level** (SL) from its `MessageIntent`, and divides throughput between the levels by weight.

| Mode | Behavior |
|---|---|
| **None** (default) | Every message goes into one first-in, first-out queue per sender type, whatever its `MessageIntent`. Messages are still colored by the level they *would* get. |
| **Weighted** | Each level gets its own queue and a weight. Defaults are **50 / 30 / 20**, Twilio's documented defaults. |

The default `MessageIntent` → Service Level mapping follows Twilio's docs and can be changed under **MessageIntent → Service Level mapping**:

| Service Level | `MessageIntent` values |
|---|---|
| SL 1 | `otp`, `notifications`, `fraud`, `security` |
| SL 2 | `customercare`, `delivery`, `education`, `events` |
| SL 3 | `polling`, `announcements`, `marketing`, and messages with no intent |

**The weighting rule:** a level's allocation is its weight divided by the total weight of the levels that are **currently sending**. A level counts as sending if it has an active stream or messages waiting.

With 100 MPS and weights 50/30/20:

| Levels sending | SL 1 | SL 2 | SL 3 |
|---|---|---|---|
| All three | 50 | 30 | 20 |
| SL 1 only | 100 | – | – |
| SL 2 only | – | 100 | – |
| SL 3 only | – | – | 100 |
| SL 1 + SL 3 | 50/70 = **71.4** | – | 20/70 = **28.6** |

The allocation depends on *whether* a level is sending, **not on how much**. One OTP per second on SL 1 still reserves 71.4 MPS while SL 3 is sending.

### Multi-Tenancy

Multi-Tenancy divides **each Service Level's allocation** between subaccounts. If Traffic Shaping is None, it divides the whole sender type instead.

| Mode | Behavior |
|---|---|
| **None** (default) | All subaccounts share one first-in, first-out queue per Service Level. A high-volume subaccount can delay everyone else on that level. |
| **Even** | Each subaccount gets its own queue. The subaccounts currently sending on a level split that level's allocation equally. |
| **Weighted** | There are exactly **three tiers**, each with a weight (defaults **60 / 30 / 10**), and each subaccount is assigned to one tier. A level's allocation is split between the tiers currently sending, by tier weight. The subaccounts in a tier then split the tier's share evenly. |

The same rule applies here as for Service Levels: only tiers or subaccounts that are **sending** count, and send rate doesn't affect the split.

Each subaccount also chooses which **sender types** it uses (one or more). A sender type's queues only include the subaccounts that use it.

### Allocation vs. egress (lending)

The simulator tracks two separate figures for every queue:

- **Allocation** is the MPS a queue is *guaranteed* while it's sending, from the weighting rules above. It ignores send rate.
- **Egress** is the MPS actually leaving the queue.

**Unused share is lent out.** If a queue has a smaller backlog than its allocation can drain (for example, it's sending 50 msg/s but is allocated 71.4), the spare capacity is lent to queues that still have messages waiting. Lending follows the same hierarchy: siblings come first (other subaccounts in the same tier, then other tiers on the same Service Level), then the other Service Levels by weight. As a result:

- a queue's egress can be **higher** than its allocation while it borrows;
- a sender type's total egress stays at its full MPS whenever any message is waiting;
- when a queue empties, its share moves to the others **on the next 20 ms step**.

A queue keeps its allocation until its backlog is gone, not just until its stream stops. For example, an SL 1 burst that leaves 457 messages queued keeps 71.4 MPS until the last one is sent. Then SL 3 jumps to 100.

### Worked examples

All of these use 100 MPS and Traffic Shaping at 50/30/20. "Backlogged" means the queue is sending faster than it can drain, so it always has messages waiting. Results come from running the simulator's model.

| Scenario | in (msg/s) | out (MPS) | alloc (MPS) |
|---|---|---|---|
| SL 1 and SL 3 both backlogged | 300 / 300 | 71.4 / 28.6 | 71.4 / 28.6 |
| SL 1 sends 50, SL 3 backlogged | 50 / 300 | 50 / 50 | 71.4 / 28.6 |
| SL 1 sends 1, SL 3 backlogged | 1 / 300 | 1 / 99 | 71.4 / 28.6 |
| Even MT: A (SL 1) sends 10, B (SL 1) backlogged, C (SL 3) backlogged | 10 / 300 / 300 | 10 / 61.4 / 28.6 | 35.7 / 35.7 / 28.6 |
| Weighted MT 60/30/10: Tier 1 and Tier 2 on SL 1, Tier 3 on SL 3, all backlogged | 300 each | 47.6 / 23.8 / 28.6 | 47.6 / 23.8 / 28.6 |
| Same, but Tier 1 only sends 5 | 5 / 300 / 300 | 5 / 66.4 / 28.6 | 47.6 / 23.8 / 28.6 |

In the last two Multi-Tenancy rows, the spare capacity stays on SL 1, going to B or Tier 2, while SL 3 keeps its 28.6.

## Using the simulator

### Controls (left panel)

| Section | What you can set |
|---|---|
| **Scenario** | Pick a built-in or saved preset. Save, update or delete your own (see [Presets](#presets)). |
| **Traffic Shaping** | None or Weighted, the SL 1/2/3 weights (slider or number), and the `MessageIntent` → Service Level mapping. |
| **Multi-Tenancy** | None, Even or Weighted, the three tier weights (Weighted only), and each subaccount's name, tier and sender types. Subaccounts can be added or removed. |
| **Carriers by sender type** | The egress MPS for Short Code, Alphanumeric and Long Code. |
| **Traffic** | Message streams. Each stream has a subaccount, a sender type (limited to that subaccount's types), a `MessageIntent`, a rate in msg/s, a start time and a duration, in simulated seconds. |

The settings lock while a simulation runs. **Reset** unlocks them.

### Top bar

- **View source** opens this repository.
- **Speed** runs the simulation at 0.25× to 10× real time.
- **▶ Start / ❚❚ Pause / ▶ Resume / ▶ Run again** controls the run. **Reset** clears it.

### Animation

- Each **row** is a sender type, labeled with its egress meter: `in X · out Y / MPS`.
- Each **lane** is one queue, labeled `SL · Tier · Subaccount` (depending on modes). The front of the queue is on the right. Each message is drawn as a dot, colored and shaped by its Service Level: ● SL 1, ■ SL 2, ▲ SL 3. Large backlogs show a `+N` overflow count.
- Each lane shows live **`in · out · alloc`**:
  - **in**: messages arriving per second (the total rate of its active streams);
  - **out**: MPS leaving the queue right now;
  - **alloc**: MPS guaranteed to the queue right now.
- Messages that leave a queue fly to one of the **carrier boxes** on the right, which show each carrier's live MPS.
- **Hovering** a lane shows its backlog, oldest wait, ingress, egress, allocation, how much it's borrowing, and its allocation if every lane were sending. Hovering the egress meter or a carrier box shows totals.

All live readouts are recomputed every step, so you see a change in allocation as soon as it happens, without any averaging delay.

### Results

- **Stat tiles** show simulated time, messages sent, delivered, waiting, and total throughput.
- **Messages waiting in queue, by Service Level** is a line chart of backlog over time. Hover it for exact values.
- **Time spent in queue** is a table of delivered count, average, p50, p95 and max wait, by Service Level and by subaccount.

## Presets

**Built-in presets** load a set of subaccounts and streams, and reset Traffic Shaping, Multi-Tenancy and MPS to their defaults:

| Preset | What it shows |
|---|---|
| Marketing blast + OTP burst | A 320 msg/s marketing blast on Short Code, with an OTP burst and customer-care traffic arriving partway through. Two subaccounts also send on Long Code. |
| Noisy neighbor subaccount | One Long Code subaccount floods announcements while two others send small amounts of notifications and delivery traffic. |
| Mixed sender types | Traffic spread across Short Code, Alphanumeric and Long Code, with subaccounts that use several sender types. |

**Saved presets** store a complete snapshot: Traffic Shaping (mode, weights, mapping), Multi-Tenancy (mode, tier weights), subaccounts, MPS per sender type, and all streams.

- **Save as preset…** saves the current settings under a name. If the name is already taken, it asks before replacing that preset.
- **Update** overwrites the selected saved preset.
- **Delete** removes it after you confirm.

Saved presets are kept in the browser's **localStorage** under the key `toe-sim-presets-v1`. They are tied to one browser and one site: they don't sync between browsers or machines, and clearing site data deletes them. Nothing is sent to a server.

## Project layout

```
assets/
  index.html   page structure
  styles.css   layout and theme (light and dark)
  sim.js       simulation model, with no DOM access: queues, allocation, lending, stats
  app.js       UI: controls, presets, canvas animation, chart, tooltips
package.json            project metadata and deploy script
.twilioserverlessrc     Twilio Serverless service config
```

The app is plain HTML, CSS and JavaScript, with no dependencies or bundler.

### Model internals (`sim.js`)

- `Simulation.step(dt)` emits messages from active streams, then calls `serve()` for each sender type.
- `serve()` runs two passes each step:
  1. **Allocation**: `weightedShare()` splits the MPS by weight among *sending* nodes (Service Level, then tier, then subaccount). The result is shown as `alloc`.
  2. **Egress**: `waterfill()` (a weighted max-min fair split) applies the same weights to what each queue actually has waiting, from the top of the hierarchy down. This is what lends unused share to siblings first and then up the hierarchy.
- Fractional capacity carries over between steps as per-queue credit, so a queue allocated 71.4 MPS sends exactly that over time.

## Deploying to Twilio Serverless

The app is deployed as static assets with the [Twilio CLI](https://www.twilio.com/docs/twilio-cli) and the [Serverless plugin](https://www.twilio.com/docs/labs/serverless-toolkit):

```bash
twilio plugins:install @twilio-labs/plugin-serverless   # once
twilio serverless:deploy --service-name toe-simulator --assets-folder assets --override-existing-project
```

This uses your active `twilio profiles` login. Open the deployed app at `/index.html`; the bare domain returns 404.
