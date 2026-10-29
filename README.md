# Traffic Optimization Engine Simulator

An interactive, in-browser simulator for Twilio's Traffic Optimization Engine. It shows how messages of different priorities share a sender type's throughput under [Traffic Shaping](https://www.twilio.com/docs/messaging/features/traffic-shaping) and [Multi-Tenancy](https://www.twilio.com/docs/messaging/features/multi-tenancy), and how they flow out to carrier queues.

**Live demo:** https://toe-simulator-8125-dev.twil.io/index.html

> This is an educational model, not Twilio's production code. It follows the behavior described in Twilio's public docs and the weighting rules described below. Carrier names and default MPS values are placeholders.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
  - [Sender types and egress](#sender-types-and-egress)
  - [Traffic Shaping](#traffic-shaping)
  - [Multi-Tenancy](#multi-tenancy)
  - [Maximum throughput vs. egress](#maximum-throughput-vs-egress)
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

**The weighting rule:** when several levels have messages waiting, each drains at its weight divided by the total weight of those levels. Levels that aren't sending take nothing.

With 100 MPS, weights 50/30/20, and every sending level backlogged:

| Levels sending | SL 1 | SL 2 | SL 3 |
|---|---|---|---|
| All three | 50 | 30 | 20 |
| SL 1 only | 100 | – | – |
| SL 2 only | – | 100 | – |
| SL 3 only | – | – | 100 |
| SL 1 + SL 3 | 50/70 = **71.4** | – | 20/70 = **28.6** |

These figures are **maximums, not guarantees**. Nothing is reserved: if SL 1 sends fewer messages than its share could drain, SL 3 gets the rest (see [Maximum throughput vs. egress](#maximum-throughput-vs-egress)).

### Multi-Tenancy

Multi-Tenancy divides **each Service Level's throughput** between subaccounts. If Traffic Shaping is None, it divides the whole sender type instead.

| Mode | Behavior |
|---|---|
| **None** (default) | All subaccounts share one first-in, first-out queue per Service Level. A high-volume subaccount can delay everyone else on that level. |
| **Even** | Each subaccount gets its own queue. The subaccounts currently sending on a level split that level's throughput equally. |
| **Weighted** | There are exactly **three tiers**, each with a weight (defaults **60 / 30 / 10**), and each subaccount is assigned to one tier. A level's throughput is split between the tiers currently sending, by tier weight. The subaccounts in a tier then split the tier's share evenly. |

The same rule applies here as for Service Levels: only tiers or subaccounts with messages to send take part in the split, and any throughput they don't use goes to the others.

Each subaccount also chooses which **sender types** it uses (one or more). A sender type's queues only include the subaccounts that use it.

### Maximum throughput vs. egress

Throughput is never guaranteed. For every queue the simulator shows:

- **alloc**: the **most MPS the queue could reach at this moment**. That is the rate it would get if it had unlimited messages waiting, given what every other queue is actually sending right now. It changes as other queues start, stop or speed up.
- **out**: the MPS actually leaving the queue. It is never more than alloc.

**Unused throughput moves to busy queues.** If a queue sends less than its weighted share (for example, 50 msg/s when its share would be 71.4), the difference goes to queues that still have messages waiting. It follows the same hierarchy: siblings come first (other subaccounts in the same tier, then other tiers on the same Service Level), then the other Service Levels by weight. As a result:

- a sender type's total egress stays at its full MPS whenever any message is waiting;
- when a queue empties, the others can use its share **on the next 20 ms step**.

A queue with a backlog keeps drawing its share until the backlog is gone, not just until its stream stops. For example, an SL 1 burst that leaves 457 messages queued drains at 71.4 MPS until the last one is sent. Then SL 3 rises to 100.

### Worked examples

All of these use 100 MPS and Traffic Shaping at 50/30/20. "Backlogged" means the queue is sending faster than it can drain, so it always has messages waiting. Results come from running the simulator's model.

| Scenario | in (msg/s) | out (MPS) | alloc (MPS) |
|---|---|---|---|
| SL 1 and SL 3 both backlogged | 300 / 300 | 71.4 / 28.6 | 71.4 / 28.6 |
| SL 1 sends 50, SL 3 backlogged | 50 / 300 | 50 / 50 | 71.4 / 50 |
| SL 1 sends 1, SL 3 backlogged | 1 / 300 | 1 / 99 | 71.4 / 99 |
| SL 1 and SL 3 each send 20 | 20 / 20 | 20 / 20 | 80 / 80 |
| Even MT: A (SL 1) sends 10, B (SL 1) backlogged, C (SL 3) backlogged | 10 / 300 / 300 | 10 / 61.4 / 28.6 | 35.7 / 61.4 / 28.6 |
| Weighted MT 60/30/10: Tier 1 and Tier 2 on SL 1, Tier 3 on SL 3, all backlogged | 300 each | 47.6 / 23.8 / 28.6 | 47.6 / 23.8 / 28.6 |
| Same, but Tier 1 only sends 5 | 5 / 300 / 300 | 5 / 66.4 / 28.6 | 47.6 / 66.4 / 28.6 |

How to read alloc: a backlogged queue is already sending as fast as it can, so its alloc equals its out. A light queue's alloc is what it *could* reach if it sent more. For SL 1 sending 50, that is 71.4, because SL 3 would drop back to 28.6. In the Multi-Tenancy rows, the spare capacity stays on SL 1, going to B or Tier 2, while SL 3 stays at 28.6.

### Cross-check with throughput-viz

The weighting matches [ankurkwv/throughput-viz](https://github.com/ankurkwv/throughput-viz), in particular its combined Multi-Tenancy and Traffic Shaping scenario (`7-multi-with-traffic-shaping-script.js`). It works **levels first**: each Service Level with messages gets its weighted share of the total, and that share is then split between the tiers with messages on that level, and evenly between the subaccounts in each tier.

We ported its `shape()` function and ran it against this simulator's model (100 MPS, every queue backlogged). The results matched exactly:

| Scenario | throughput-viz | This simulator |
|---|---|---|
| A (Tier 1) SL 1, B (Tier 3) SL 2, C (Tier 2) SL 3; TS 50/30/20, MT 60/30/10 | 50 / 30 / 20 | 50 / 30 / 20 |
| Its own config: SL 7/3, tiers 6/4, three subaccounts on both levels | 14 / 14 / 42 and 6 / 6 / 18 | same |
| A, B, C in Tiers 1, 2, 3, all on SL 1 | 60 / 30 / 10 | 60 / 30 / 10 |

Tier weights only change the split between subaccounts **on the same Service Level**. If each subaccount sends on a different level, the levels' weights decide the split by themselves.

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
  - **alloc**: the most MPS the queue could reach right now (never a guarantee).
- Messages that leave a queue fly to one of the **carrier boxes** on the right, which show each carrier's live MPS.
- **Hovering** a lane shows its backlog, oldest wait, ingress, egress, and the maximum it could achieve now. Hovering the egress meter or a carrier box shows totals.

All live readouts are recomputed every step, so you see a change in throughput as soon as it happens, without any averaging delay.

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
  sim.js       simulation model, with no DOM access: queues, weighted split, stats
  app.js       UI: controls, presets, canvas animation, chart, tooltips
package.json            project metadata and deploy script
.twilioserverlessrc     Twilio Serverless service config
```

The app is plain HTML, CSS and JavaScript, with no dependencies or bundler.

### Model internals (`sim.js`)

- `Simulation.step(dt)` emits messages from active streams, then calls `serve()` for each sender type.
- `rateSplit()` applies the hierarchy (Service Level, then tier, then subaccount) using `waterfill()`, a weighted max-min fair split. Capacity a queue can't use is re-split among the others, siblings first and then up the hierarchy.
- `serve()` uses `rateSplit()` three ways each step:
  1. **out**: with each queue's current demand (unlimited if backlogged, otherwise its ingress).
  2. **alloc**: for each sending queue, the same split again with *that* queue's demand set to unlimited, which gives the most it could reach now.
  3. **Egress**: with the messages actually waiting, to deliver this step's messages.
- Fractional capacity carries over between steps as per-queue credit, so a queue drawing 71.4 MPS sends exactly that over time.

## Deploying to Twilio Serverless

The app is deployed as static assets with the [Twilio CLI](https://www.twilio.com/docs/twilio-cli) and the [Serverless plugin](https://www.twilio.com/docs/labs/serverless-toolkit):

```bash
twilio plugins:install @twilio-labs/plugin-serverless   # once
twilio serverless:deploy --service-name toe-simulator --assets-folder assets --override-existing-project
```

This uses your active `twilio profiles` login. Open the deployed app at `/index.html`; the bare domain returns 404.
