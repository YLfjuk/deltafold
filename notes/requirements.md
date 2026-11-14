# deltafold requirements

This file states what deltafold must do and the qualities it must have. The
implementation follows these requirements; design choices, provisional behavior,
and work that is not done yet are in [decisions](decisions.md). Each requirement
has a stable identifier for reference in issues and reviews.

## Scope

deltafold models a package's version history and resolves the migration
instructions between two versions, including an explicit initial baseline.
Package authors declare changes, actions, migrations, equivalence rules, and
shortcuts once. Consumers receive an ordered plan of the instructions that remain
after optimization and can run it with their own handlers. The same declarations
produce release notes and upgrade or downgrade guides.

Three relationships stay separate: release ancestry (which release a version
descends from), migration routes (supported transitions between exact versions),
and execution bindings (which handler performs an action). Optimization never
erases release history.

## Functional requirements

### Declarations

- **DECL-1.** A change has a stable identity, a description, and metadata whose
  fields and meaning the consumer defines. The core stores change metadata but
  never interprets it. A change can record that it reverts earlier changes or
  backports another change. Editing its description keeps its identity.
- **DECL-1a.** Changes declared through one shared definition must all have the
  metadata shape that definition requires.
- **DECL-2.** An action kind defines a payload and how to describe an action of
  that kind. Actions have stable identities, and one kind can have many
  independently handled actions.
- **DECL-3.** A version records the release it descends from. Several versions
  can descend from one release. Declaration order and version numbering never
  change ancestry, and ancestry has no cycles.
- **DECL-4.** A migration is a transition between two exact versions. It records
  which changes it handles, separately from the changes a release contains, and
  its instructions combine prose with the actions it performs.
- **DECL-5.** Instruction prose can belong to one action, so that it disappears
  wherever that action is optimized away. Prose can mention an action without
  performing it.
- **DECL-6.** A transition that needs no work is declared explicitly. It is never
  inferred from a missing migration.
- **DECL-7.** A reverse transition exists only when the author declares it.
- **DECL-8.** Migrations can be added after a release without changing how the
  release is declared.
- **DECL-9.** One identity has one definition. Referring to the same definition
  from several places is valid; conflicting definitions are errors.
- **DECL-10.** A package's name and history are declared together, once.
- **DECL-11.** Validation reports every independent declaration problem at once,
  in a deterministic order.

### Planning

- **PLAN-1.** Planning needs no handlers and never touches consumer files.
- **PLAN-2.** A plan with no work is valid. The absence of a supported route is a
  failure, never "no work".
- **PLAN-3.** A route follows declared migrations only. Sharing an ancestor does
  not allow a route to go down to that ancestor and back up to another branch.
  An explicitly declared shortcut may take such a path, because the author
  asserts its equivalence.
- **PLAN-4.** One migration holds all the work of a transition between two
  versions, and declaring a second one for the same transition is an error.
  Alternative routes are distinct paths between the versions.
- **PLAN-5.** When several routes connect the versions, planning fails with
  identifiable candidates unless the consumer selects one, either by identity or
  by an explicit preference that leaves exactly one candidate.
- **PLAN-6.** A shortcut is an alternative to the specific route it names, and it
  must start and end where that route does.
- **PLAN-7.** An unsupported request reports the versions that are reachable, the
  reachable versions closest to the target, and what blocks the route. Nothing
  falls back to another version without the consumer's choice.
- **PLAN-8.** Consumers can list the versions they can upgrade or downgrade to,
  with the routes to each.
- **PLAN-9.** A reverse migration is a route like any other. It never undoes a
  previous run.

### Optimization

- **OPT-1.** A rule asserts that a sequence of consecutive actions is equivalent
  to a replacement sequence, which may be empty.
- **OPT-2.** Rules can apply across migration boundaries. They never apply around
  an action between the matched ones, around a migration that contains only
  prose, or across independent branches.
- **OPT-3.** Rewriting independent branches as a whole requires a rule that names
  that structure explicitly.
- **OPT-4.** Replacements can feed other rules. Every replacement keeps ordered
  provenance of what it replaced.
- **OPT-5.** Rules that rewrite back into an earlier state, or that can produce
  different results depending on which applies first, are reported as errors.
  The result never depends on the order in which rules are registered.

### Execution

- **EXEC-1.** Handlers can be Promise callbacks or Effect programs, and both kinds
  work in one run. Effect handlers keep their typed errors, services, and
  interruption. Promise handlers receive a cancellation signal and the services
  they declare.
- **EXEC-2.** A handler's declared failures keep their types. Any other failure
  becomes an unexpected-handler error that names the action.
- **EXEC-3.** Integration modules, official or third party, provide handlers in
  the same form. The executor needs no registry of engines and never inspects a
  handler's internals. The core assumes no language, file type, parser, or
  codemod engine.
- **EXEC-4.** Before any check or action runs, every planned action must have
  exactly one handler for its definition. A missing handler for a replacement
  names the rule and the actions it replaced. Where the planned actions are known
  statically, missing handlers are type errors.
- **EXEC-5.** A precondition that does not hold skips its action with a reason. A
  precondition that cannot be evaluated fails the run.
- **EXEC-6.** Migrations run one after another. Independent branches within a
  migration can run concurrently, with an optional limit.
- **EXEC-7.** After a failure, no new action starts, and actions already running
  finish without interruption. The result reports each action as completed,
  skipped, failed (with the failing phase), interrupted, or not attempted.
- **EXEC-8.** Cancellation and timeouts are separate from failures. They stop new
  actions as soon as they occur and interrupt the affected work. The result
  records whether interrupted work is known to have stopped.
- **EXEC-9.** A dry run never performs actions. It evaluates checks whose result
  cannot depend on unperformed work and reports the rest as undetermined. A
  failed check stays a failure. Cancellation and timeouts apply to its checks.
- **EXEC-10.** A run reports that its progress is not saved, and a failed run
  never claims to have undone completed work.

### Documents

- **DOC-1.** The same declarations produce documents for unreleased changes, one
  release, a package's history, and the guide for a resolved plan.
- **DOC-2.** Changes are grouped into configurable sections that select changes
  by their metadata. Empty sections are omitted, and unmatched changes appear in
  a catch-all section unless it is disabled. Without configured sections, a
  release lists all of its changes in one section.
- **DOC-3.** A history keeps every historical change, including reverted ones, and
  is titled with the package name. A guide omits instructions that optimization
  removed, keeps shared and prose-only instructions of steps that still have
  work, and can explain the omissions. A step whose actions were all removed is
  omitted with its shared prose; prose that must always appear belongs in an
  action.
- **DOC-4.** Release metadata, such as dates or commits, stays outside the
  history. Missing, duplicate, or unrelated metadata is an error.
- **DOC-5.** Extensions add content at defined points of a release or a history,
  once per scope, in configuration order, without processing each other's
  output.
- **DOC-6.** Heading levels follow nesting unless set explicitly, and unsupported
  levels are errors.
- **DOC-7.** Documents are format neutral and render to Markdown and HTML. Text is
  escaped in every format, and links with unsafe schemes are not rendered.

### Command-line interface

- **CLI-1.** A ready-made command-line interface, or a builder that package
  authors expose from their own package, shares one command implementation. The
  package identity comes from the package declaration.
- **CLI-2.** Commands cover changelog generation, migration planning and
  application, dry runs, and listing upgrade and downgrade destinations.
  Unsupported or ambiguous routes fail instead of guessing.
- **CLI-3.** Documents and structured results go to standard output unless
  another destination is chosen; diagnostics and progress go to standard error.
  The log level never suppresses results or a failing exit status, and
  machine-readable output stays parseable.
- **CLI-4.** Loading a package's entry module never starts migration work.

## Non-functional requirements

- **NFR-1.** deltafold is an ESM TypeScript library built on Effect 4, under the
  MIT license.
- **NFR-2.** Modeling, planning, execution, and documents are platform
  independent. Platform APIs appear only at explicit runtime boundaries.
- **NFR-3.** Planning and rendering are deterministic: issues, candidates,
  explanations, and reports have stable orders.
- **NFR-4.** Planning always terminates within bounded effort and reports the
  bound it reached instead of hanging or crashing.
- **NFR-5.** Identifiers of actions in a plan, routes, and errors are stable and
  machine readable, and errors carry structured fields.
- **NFR-6.** deltafold never retries, rolls back, or interrupts sibling work
  unless explicitly configured to, and never claims exactly-once external
  effects.
- **NFR-7.** Consumers who do not render documents do not load rendering
  dependencies.
