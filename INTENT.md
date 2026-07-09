# Loom — Statement of Intent

Why this project exists and the principles that govern its design. The
companion to AGENTS.md: that file says *how* to build here; this one says
*why*, so decisions stay coherent when the original reasons aren't in the
room. (Not to be confused with `app/intent/` — the NL parsing layer.)

## Purpose

Loom exists to initiate people into the workflow of communicating with an
AI to get something real in their life. Cut files are the output; the
*product* is a person who has learned that talking to a machine is a loop —
say what you want, look at what you got, say what's wrong, repeat — with a
real tool grounding every turn.

Success is therefore measurable in the funnel log: a user's third session
should contain longer, more specific utterances and a higher ratio of
refinement turns than their first. If people aren't learning to talk,
Loom is failing at its actual job no matter how many programs it exports.

## The two miscalibrations

Almost everyone arrives with a vending-machine model of AI — words in,
artifact out, one transaction — and errs in one of two directions:

- **Underestimators** tried early chatbots, got trinkets, left. The cure
  is physical output: the moment a spindle moves because of a sentence
  they typed, the prior dies.
- **Overestimators** pattern-match generation onto *search* (Thingiverse:
  two words work because a human already did the specifying). The cure is
  the honest decline and the visible refinement loop: the machine didn't
  read your mind, and didn't need to, because correcting it took one
  sentence.

Design consequences, permanent:

- **Never lead with a gallery.** Galleries put people in search mode.
  Lead with conversation; sample prompts are full sentences, never
  keywords.
- **The first-run experience is a three-beat arc: ask → refine → cut.**
  The refinement beat is where both miscalibrations die. A first run that
  succeeds in one shot re-teaches the vending machine.
- **Suggestions teach grammar, not recipes.** Chips demonstrate move-types
  (create, refine, parametrize, style, constrain) across different
  artifacts. A chip's visible text is exactly what it puts in the box —
  the specificity that makes prompting work is the pedagogy; never hide
  it behind a short label. Chips populate and focus, never submit: the
  final act of every suggestion is the user typing.

## Access and pricing

- **Meter, don't sell credits.** Per-use credits teach hoarding and tax
  the experimentation phase users need to climb the learning curve — a
  lesson visible in every credit-priced design generator on the market.
  A refilling allowance makes marginal
  experiments feel free and makes hitting the limit a natural pause, not
  a loss. This also feeds the flywheel: the decline log is the roadmap,
  and it only fills if people ask freely — including asks they expect
  to fail.
- **BYO API key is scaffolding, not the product.** It filters for
  self-serve testers and yields real per-ask cost data; it is a five-step
  identity ceremony in front of a fifty-cent experience and must never be
  the public on-ramp.
- **Bind the meter to the machine, not the person.** The tool's serial
  identifies; a separate random entitlement key authenticates (the
  identifier is never the authenticator). Revenue rides payment shapes
  customers already accepted — the machine, the support plan. The service
  holds nothing breachable: the best way to protect user data is to not
  have it.
- **The funnel log is the biggest PII surface.** This product's core use
  case is personalization, and personalization *is* PII — name signs,
  address plaques, memorials. Users can't do the job without telling us.
  Keep utterances verbatim only for declines (the backlog needs them);
  truncate or drop fulfilled utterances after a short window; never
  co-locate IPs with utterances.

## The platform bargain

- **The exit test.** A contribution is fairly obtained only if it would
  still pay off for the contributor were Loom to vanish tomorrow. A
  primitive is a tool its author's shop needed anyway; a recipe is a
  business its author runs on these rails. If contributors are building
  our asset instead of theirs, the flywheel stops — keeping the deal
  generous *is* the self-interested move.
- **The sword-law.** Any skill encoded to scale will eventually be
  performed without its author (recordings → piracy → models trained on
  the corpus; the mold out-replicated by the bigger replicator). So never
  sell contributors rent-on-encodings — that income the pattern always
  kills. Encodings are a commons that raise the value of the
  un-encodable, and contributor income anchors there: machine time,
  materials, fixturing, locality, the route, the relationship. The open
  foundation is not charity; it is obedience to this law.
- **Engineer the exits.** Handoff hooks, exportable recipes, an open
  foundation repo. A platform that extracts doesn't build doors; ours
  must, conspicuously.

## The interface warning

Whoever owns the layer where intent enters a system ends up owning
everything below it, and everything below gets commoditized (the PC's
fate: value went to the interface owners; the hardware became DoorDash
kitchens). "Talk to AI to make things" is an interface layer, and
interface layers consolidate. The defense: the interface ships *with*
the machine, on an open foundation, with working exits — a fixture of the
tool, never a landlord over it.

## The shared surface stays clean (the anti-Boeing rule)

Mature GUI software fossilizes because every big customer's workflow must
manifest on the one surface everyone shares — a thousand rational
concessions, each "one checkbox," summing to something unusable
(SolidWorks' ordinate chains, ×1000). An intent interface is the first
paradigm with somewhere else to put the concession — so put it there:

> **Accommodations go in the customer's layer — their policies, their
> prompts, their frozen defaults — never in the shared surface.**

Complexity below the rail lands in tested strategy code; complexity above
it lands in per-tenant policy; the box where someone types "make me a
stool" stays permanently clean. There is no such thing as one checkbox;
there is only the first of a thousand.

## Who this is for

The intermittent user — which is nearly everyone. Ceremony-heavy tools
are priced for daily users who amortize the ontology; everyone else pays
full re-entry cost per visit, knowing exactly what they want while the
tool demands they re-earn the right to say it. Conversation is the only
production interface with zero re-entry cost, and it is also the
phone-native generation's *native* interface: the prompt box, with
dictation and eventually the photographed sketch, IS fabrication's
touchscreen. What it strips is tool fluency (a skill with a fading
half-life); what it keeps is design learning — specification, iteration,
tolerance, cause-and-effect — delivered by the refinement loop, with the
verifier as the truth-telling teacher.

## The long thesis

ShopBot was founded on "Personal Robot" — a CNC as essential as the PC.
The prediction was an *interface* prediction, early by one revolution:
affordable iron arrived decades ago, but fabrication never got its GUI
moment. English is that moment. And the endpoint may not be a robot in
every garage: specification cost is what kept bespoke fabrication from
outsourcing the way lawn care did ("mow my lawn" is a complete spec; a
stool never was). A verified Job is a portable, trustworthy,
executable-by-a-stranger artifact — the PDF of fabrication — and it makes
the middle-distance node viable: personal fabrication for everyone,
backed by a machine within ten miles, owned by a neighbor, not a
platform. That is 100kGarages with the missing half supplied.
