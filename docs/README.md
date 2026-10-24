# Loam Documentation

This directory contains technical documentation, design decisions, verification reports, and development guides for Loam.

## 📚 Documentation Structure

### Core Documentation

- **[BUILD_SPEC.md](BUILD_SPEC.md)** - Build system specification and packaging details
- **[COMPACTION_SPEC.md](COMPACTION_SPEC.md)** - Memory and context compaction specifications
- **[GAP_REVIEW.md](GAP_REVIEW.md)** - Feature gaps and roadmap planning

### Architecture & Design

- **[claude-code-architecture.md](claude-code-architecture.md)** - Architectural analysis and comparisons
- **[brand-guidelines.md](brand-guidelines.md)** - Brand identity and design guidelines

### Integration & Services

- **[loam-integration.md](loam-integration.md)** - Integration testing and service status
- **[loam-service-audit.md](loam-service-audit.md)** - Service audit and capabilities
- **[effectcraft-integration.md](effectcraft-integration.md)** - EffectCraft integration details
- **[filmcraft-integration.md](filmcraft-integration.md)** - FilmCraft integration details

### Security

- **security-*.md** - Security assessment reports and vulnerability documentation
  - Command injection prevention
  - XSS protection
  - HTML insertion repairs
  - Security gates and development practices

### Verification Reports

Multiple verification documents covering:
- Mobile development verification
- Companion system fixes
- Creative pipeline verification
- Agent system audits
- Frontier capability progress

### Development Plans

- **[AGENTS_PLAN.md](AGENTS_PLAN.md)** - Agent system planning and architecture
- **mobile-*.md** - Mobile development roadmaps and verification
- **swarm-*.md** - Swarm intelligence progress and implementation

## 📝 Language Note

Many technical documents in this directory are written in Arabic as they were created during internal development. The main user-facing documentation (README.md in the root directory) is in English.

## 🔍 Finding Documentation

Use these commands to navigate the documentation:

```bash
# List all markdown files
ls docs/*.md

# Search for specific topics
grep -r "keyword" docs/*.md

# View documentation structure
tree docs/
```

## 🤝 Contributing Documentation

When adding new documentation:

1. Use clear, descriptive filenames
2. Include a summary at the top of each document
3. Link related documents
4. Keep English as the primary language for user-facing docs
5. Include evidence and verification results where applicable

## 📊 Document Categories

### By Type
- **Specifications**: BUILD_SPEC, COMPACTION_SPEC
- **Audits**: service-audit, security-*, verification reports
- **Guides**: integration guides, architecture docs
- **Plans**: AGENTS_PLAN, roadmap documents
- **Reviews**: GAP_REVIEW, fix verification reports

### By Audience
- **Users**: Integration guides, getting started
- **Developers**: Build specs, architecture, security gates
- **Contributors**: Development plans, verification procedures
- **Auditors**: Security reports, service audits, verification evidence

---

For the main project documentation, see [README.md](../README.md) in the repository root.
