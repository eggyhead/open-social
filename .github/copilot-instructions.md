# Copilot Instructions for Open Social

This is the Open Social community server — Express + PostgreSQL + ATProto infrastructure for managing groups/communities on the AT Protocol.

## Available Copilot Skills (gstack)

The following AI-assisted workflow skills are available in `.github/copilot-skills/`:

- **review.md** — Code review workflow for analyzing changes
- **qa.md** — Quality assurance and testing workflow
- **ship.md** — Shipping and deployment workflow
- **investigate.md** — Investigation and debugging workflow

## Key Architecture

- **Express** server with PostgreSQL (Kysely query builder)
- **ATProto PDS** integration for decentralized group data
- Dual auth: API key (scrypt-hashed) + CIMD/HTTP Message Signatures
- Groups are DIDs, user data lives in user's ATProto repo
- TtlCache for performance-critical lookups
- Vitest for testing (70% coverage target)
