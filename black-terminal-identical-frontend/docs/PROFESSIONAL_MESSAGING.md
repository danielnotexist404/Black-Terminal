# Professional Messaging

## Conversation Model

Direct conversations use a canonical sorted participant key. `social_start_direct_conversation` atomically creates or reuses the conversation, restores membership, and creates a message request when policy requires one. This prevents duplicate one-to-one threads under concurrent requests.

Message policy is Everyone, Followers, or Nobody. A pending requester may send one introductory message; the recipient must accept before replying. Blocking disables pending requests and all server routes re-check membership and relationship restrictions.

## Delivery

Messages support text, approved images, and shared posts/indicators/strategies/groups. Each send carries a client message ID protected by a unique database constraint. Conversation messages use cursor pagination and read state is stored per member.

The active conversation alone receives a realtime subscription. Typing is ephemeral broadcast data and is never persisted. Channels and timers are cleaned up when the conversation changes or the component unmounts.

## Privacy

Only active members can read a conversation, its messages, reads, and attachments. Message images use private storage and short-lived signed URLs. Message bodies are not written to product analytics. Users can archive, mute, delete their own messages, decline requests, mute profiles, and block accounts.
