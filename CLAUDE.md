# ZoneMaestro / CMMP

This is a hospitality music control portal (Operate-mode SaaS), not a marketing site.

## Frontend skills (required)

Before changing UI, layout, motion, or the login page, read these project skills in order:

1. `.claude/skills/design-taste-frontend/SKILL.md` (tasteskill.dev)
2. `.claude/skills/impeccable/SKILL.md` (impeccable.style)
3. `.claude/skills/emil-design-eng/SKILL.md` (emilkowal.ski)
4. `.claude/skills/playwright-cli/SKILL.md` for browser verification

If a file is missing, fetch it from the upstream repo listed in that folder's README and do not invent a replacement aesthetic.

## Product constraints for UI

- Brand: ZoneMaestro. Accent `#5ec8f7`. Ink `#0b0d10`. Shell `#101215`.
- One theme on auth: dark control room. Do not split dark/white.
- Geist only. No serif. No em dashes.
- Keep `email` / `password` field names, Sign in, pairing link to `/servers`.
- Do not add Fluent, Carbon, or a second component library. Stay on shadcn + Tailwind.
- Motion: one enter animation, button `scale(0.97)`, error shake, `prefers-reduced-motion`.
