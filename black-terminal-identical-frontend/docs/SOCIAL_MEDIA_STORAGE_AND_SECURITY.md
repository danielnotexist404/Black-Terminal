# Social Media Storage And Security

All professional media lives in the private `professional-media` bucket.

## Paths

- `profiles/{user_id}/avatar|cover/...`
- `posts/{user_id}/{draft_id}/...`
- `messages/{conversation_id}/{user_id}/...`
- `groups/{owner_user_id}/{group_id}/...`

The upload route authenticates the user, rate-limits authorization, validates scope, type and declared size, and issues a short-lived signed upload token for one randomized path. Storage RLS independently enforces ownership or active conversation membership.

The browser accepts JPEG, PNG, and WebP, decodes the image, resizes it, re-encodes it to WebP, and thereby strips EXIF metadata. Before a profile, post, or message stores a media reference, the server checks that the object exists, validates stored MIME and byte size, and inspects the file signature through a short-lived signed URL.

Read URLs expire. No media bucket is public. Failed drafts may leave unreferenced objects; an operational cleanup job should delete unreferenced objects older than the documented retention window after production rollout.
