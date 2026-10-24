# Loam Brand Guidelines

## Brand Identity

**Name**: Loam  
**Tagline**: Local AI workspaces with focused tools and isolated tasks

## Visual Identity

### Logo
- **Symbol**: Layered geometric L-shape design
- **Style**: Angular, technical, modular
- **Colors**: See color palette below

### Color Palette

**Primary Colors:**
- **Dark Green Base**: `#101d19` - Background, primary surfaces
- **Forest Green**: `#0a1612` to `#1a2d24` - Gradients, depth
- **Sage Green**: `#99d6b5` - Primary accent, text highlights
- **Muted Green**: `#426853` - Borders, secondary elements
- **Warm Accent**: `#cda77a` - Tertiary accent, special highlights

**Usage:**
- Dark greens for backgrounds and containers
- Sage green for primary interactive elements and headings  
- Muted green for borders and dividers
- Warm accent sparingly for emphasis

### Typography

**Headings**: System fonts (system-ui, -apple-system, sans-serif)
- Bold weight (700) for primary headings
- Medium weight (600) for subheadings

**Body**: System fonts
- Regular weight (400) for body text
- Monospace for code: `'Fira Code', 'Consolas', monospace`

### Icons & Symbols

**Mode Icons:**
- Explore (ask): ◌
- Research: ⌕
- Build: ⌘
- Write: ✎
- Data: ▥
- Studio (media): ◇
- Security: 🛡
- Flow (automate): ↗

**Style**: Simple, geometric, unicode-based

## Voice & Tone

### Principles
- **Technical but accessible**: Explain complex features clearly
- **Honest and direct**: No marketing fluff, state capabilities accurately
- **Professional**: Respectful, clear, well-organized
- **Local-first**: Emphasize privacy and local execution

### Language
- Use "workspace" instead of "environment" or "context"
- Use "mode" instead of "profile" or "configuration"  
- Use "task" instead of "session" or "conversation"
- Use "agent" for AI actors, "user" for humans

### Writing Style
- Start with what, then how, then why
- Use active voice
- Keep sentences clear and direct
- Include code examples where helpful
- Document limitations honestly

## Applications

### Documentation
- README should lead with banner and clear value proposition
- Feature documentation must verify claims against source code
- Architecture sections should include diagrams
- Installation steps should be tested and complete

### UI/UX
- Dark theme by default (follows brand colors)
- Green accent for interactive elements
- Clear mode separation with distinct color hints
- File/task isolation visible in UI
- Progress and status always visible

### Badges & Shields
- Version badge: blue (#0080ff)
- License badge: red when unspecified, green when open
- Platform badge: light grey (#lightgrey)
- Tech badges: Use official brand colors (Electron, Node.js, etc.)

## Don'ts

❌ **Never use:**
- Sparkles emoji (✨) or sparkle/star icons
- Generic AI marketing language ("revolutionary", "cutting-edge")
- Claims about features that don't exist in the code
- Screenshots or demos with real API keys/secrets
- Hard-coded examples without noting they are examples

❌ **Avoid:**
- Mixing modes within a single task
- Exposing tools outside their intended mode
- Showing internal verification docs as user-facing
- Ambiguous version numbers or "latest"

## Brand Assets

- Logo SVG: `ui/assets/loam-symbol.svg`
- Banner: `docs/assets/banner.svg`
- Screenshots: `docs/assets/screenshots/`

## Notes

This is a technical tool brand, not a consumer brand. Prioritize:
1. Accuracy over excitement
2. Clarity over brevity
3. Honesty over perfection
4. Documentation over marketing
