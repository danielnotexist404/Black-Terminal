# Professional Profile UX

The profile is a market identity, not a settings form.

## Information Hierarchy

1. Cover, avatar, display name, handle, verified role, and organization
2. Headline, specialties, asset classes, and professional credibility counts
3. Owner or visitor actions
4. Sticky route-backed profile tabs
5. Contextual overview, feed, research, assets, statistics, groups, and people

Owners receive editing and publishing actions; visitors receive follow, message, share, mute, block, and private report actions. Follow requests replace immediate follows for private profiles. Blocking removes both follow directions and disables pending message requests.

## Editor

The dedicated editor covers identity, professional description, market focus, location, media, profile visibility, public-stat disclosure, group disclosure, and message policy. Avatar and cover files are re-encoded to WebP in the browser to remove EXIF data, then uploaded through a server-issued scoped token. The server validates path ownership, stored size, MIME metadata, and image signature before persisting the path.

## Responsive Behavior

Desktop uses a full identity header and bounded content workspace. Tablet compresses actions and grids. Mobile uses a single column, horizontally scrollable tabs, and full-width actions without scaling desktop typography.

Empty and private states are explicit. The header remains visible during contextual tab loading.
