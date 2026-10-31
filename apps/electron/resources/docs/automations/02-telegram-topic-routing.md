## Telegram Topic Routing

When a Telegram supergroup is paired in **Settings → Messaging → Telegram**, set
`telegramTopic` on a matcher to route its spawned sessions into a dedicated
forum topic. The topic is created on first use and reused thereafter.

```json
{
  "matcher": "^urgent$",
  "telegramTopic": "Urgent Alerts",
  "actions": [
    { "type": "prompt", "prompt": "Look at the urgent issue: $LABEL" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `telegramTopic` | string (1–128 chars) | Topic name. Created on first use, reused thereafter. Multiple matchers using the same value share one topic. |

**Activation requirements** (all must hold; otherwise the field is silently ignored):

- A Telegram supergroup is paired in Settings → Messaging → Telegram
- The Telegram bot is connected
- The bot has the **Manage Topics** admin permission

Names are case-sensitive: `"Reports"` and `"reports"` create separate topics.

### Setting up the Telegram supergroup

If you haven't paired a supergroup yet:

1. **Create / convert a supergroup with Topics enabled.** In Telegram, open the group → tap the group name → Edit (pencil icon) → toggle **Topics** on → Save. The group must be a forum supergroup; regular groups can't host topics.
2. **Add the bot to the supergroup.** Group name → Add members → search for your bot's username → add.
3. **Promote the bot to admin with "Manage Topics".** Group name → Edit → Administrators → Add Administrator → pick the bot → toggle on **Manage Topics** → Save. This is the step most people miss; without it, topic creation fails with `400: not enough rights to create a topic`.
4. **Pair the supergroup.** In Craft Agent: Settings → Messaging → Telegram → **Pair Supergroup**. Copy the 6-digit code, then in any topic of the supergroup type `/pair <code>`. The bot confirms and the Settings row updates with the group's title.

Verify by checking the supergroup row in Settings shows the group title. If automation runs fail later, `~/.craft-agent/logs/messaging-gateway.log` will show `automation_topic_bind_failed` with the underlying Telegram error.

## Complete Examples

### Daily Weather Report

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Daily Weather Report",
        "cron": "0 8 * * *",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled", "weather"],
        "actions": [
          { "type": "prompt", "prompt": "Run the @weather skill and give me today's forecast" }
        ]
      }
    ]
  }
}
```

### Weekday-Only AI News (with Conditions)

Use a `time` condition to restrict a daily schedule to weekdays only:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Morning AI news",
        "cron": "0 9 * * *",
        "timezone": "Europe/Budapest",
        "conditions": [
          {
            "condition": "time",
            "weekday": ["mon", "tue", "wed", "thu", "fri"],
            "timezone": "Europe/Budapest"
          }
        ],
        "labels": ["Scheduled", "ai-news"],
        "actions": [
          { "type": "prompt", "prompt": "Run the @ai-news skill and summarize today's AI developments" }
        ]
      }
    ]
  }
}
```

### Permission Mode Gate (with Conditions)

Only notify when permission mode changes specifically from `safe` to `allow-all`:

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "conditions": [
          {
            "condition": "state",
            "field": "permissionMode",
            "from": "safe",
            "to": "allow-all"
          }
        ],
        "actions": [
          {
            "type": "webhook",
            "url": "${CRAFT_WH_SLACK_URL}",
            "method": "POST",
            "body": { "text": ":warning: Permission escalated from safe to allow-all in *${CRAFT_SESSION_NAME}*" }
          }
        ]
      }
    ]
  }
}
```

### Log Label Changes

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "actions": [
          { "type": "prompt", "prompt": "The label $CRAFT_LABEL was added. Log this change with a timestamp." }
        ]
      }
    ],
    "LabelRemove": [
      {
        "actions": [
          { "type": "prompt", "prompt": "The label $CRAFT_LABEL was removed. Log this change with a timestamp." }
        ]
      }
    ]
  }
}
```

### Urgent Label Notification

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "matcher": "^urgent$",
        "actions": [
          { "type": "prompt", "prompt": "An urgent label was added to this session. Triage the session and summarise what needs immediate attention." }
        ]
      }
    ]
  }
}
```

### Permission Mode Change Notification

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "matcher": "allow-all",
        "actions": [
          { "type": "prompt", "prompt": "The permission mode was changed to allow-all. Log the change and note any security implications." }
        ]
      }
    ]
  }
}
```

### Slack Notification on Status Change

Sends a Slack message when a session is marked as done. Requires `CRAFT_WH_SLACK_URL` in your shell profile.

```json
{
  "version": 2,
  "automations": {
    "SessionStatusChange": [
      {
        "name": "Notify Slack on Done",
        "matcher": "^done$",
        "actions": [
          {
            "type": "webhook",
            "url": "${CRAFT_WH_SLACK_URL}",
            "method": "POST",
            "body": {
              "text": ":white_check_mark: Session *${CRAFT_SESSION_NAME}* marked as done"
            }
          }
        ]
      }
    ]
  }
}
```

### Mixed Actions (Prompt + Webhook)

A single automation can have both prompt and webhook actions. They execute in order.

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "name": "Urgent: Notify and Triage",
        "matcher": "^urgent$",
        "actions": [
          {
            "type": "webhook",
            "url": "${CRAFT_WH_SLACK_URL}",
            "method": "POST",
            "body": { "text": ":rotating_light: Urgent label added to *${CRAFT_SESSION_NAME}*" }
          },
          {
            "type": "prompt",
            "prompt": "An urgent label was added. Triage the session and summarise what needs immediate attention."
          }
        ]
      }
    ]
  }
}
```

### Form-Encoded Request (OAuth / Stripe)

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Refresh API Token",
        "cron": "0 */6 * * *",
        "actions": [
          {
            "type": "webhook",
            "url": "https://auth.example.com/oauth/token",
            "method": "POST",
            "bodyFormat": "form",
            "body": {
              "grant_type": "client_credentials",
              "client_id": "${CRAFT_WH_CLIENT_ID}",
              "client_secret": "${CRAFT_WH_CLIENT_SECRET}"
            }
          }
        ]
      }
    ]
  }
}
```

### Webhook with Custom Headers

```json
{
  "version": 2,
  "automations": {
    "SessionStatusChange": [
      {
        "name": "Log to External API",
        "actions": [
          {
            "type": "webhook",
            "url": "https://api.example.com/craft-events",
            "method": "POST",
            "headers": {
              "Authorization": "Bearer ${CRAFT_WH_API_TOKEN}",
              "X-Source": "craft-agent"
            },
            "body": {
              "event": "${CRAFT_EVENT}",
              "session_id": "${CRAFT_SESSION_ID}",
              "old_status": "${CRAFT_OLD_STATE}",
              "new_status": "${CRAFT_NEW_STATE}"
            }
          }
        ]
      }
    ]
  }
}
```

## Validation

Automations are validated when:
1. The workspace is loaded
2. You edit automations.json (via PreToolUse hook)
3. You run `config_validate` with target `automations` or `all`

**Using config_validate:**

Ask Craft Agent to validate your automations configuration:

```
Validate my automations configuration
```

Or use the `config_validate` tool directly with `target: "automations"`.

**Common validation errors:**
- Invalid JSON syntax
- Unknown event names
- Empty actions array
- Invalid cron expression
- Invalid timezone
- Invalid regex pattern
- Potentially unsafe regex patterns (nested quantifiers)

**To validate manually:**

```bash
# Check automations.json syntax
cat automations.json | jq .
```

## Retry Behavior

Webhook actions have two levels of automatic retry:

### Immediate retry (transient failures)

When a webhook fails with a server error (5xx), timeout, or connection error, it is automatically retried up to **2 times** with exponential backoff (1s → 2s → 4s). Client errors (4xx) are not retried — they indicate a configuration problem.

### Deferred retry (extended outages)

If all immediate retries fail, the webhook is added to a **persistent retry queue**. The queue retries at increasing intervals:

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1st deferred | 5 minutes | 5 min |
| 2nd deferred | 30 minutes | 35 min |
| 3rd deferred | 1 hour | ~1.5 hours |

After the final deferred attempt fails, the webhook is marked as permanently failed in the history. Deferred retries survive app restarts.

> **Note:** Only transient failures (5xx, timeouts, connection errors) are retried. Client errors (4xx) indicate a configuration problem and should be fixed in `automations.json`.

> **Retry and rate limiting:** Retried webhook requests count toward the per-endpoint rate limit (30/min per origin). If a retry would exceed the limit, it is deferred to the next retry window.

## Rate Limits

To protect against runaway automations (e.g., an automation that indirectly triggers itself in a loop), the event bus enforces per-event-type rate limits:

| Event | Max fires / minute |
|-------|--------------------|
| `SchedulerTick` | 60 (1/sec) |
| All others (`LabelAdd`, `FlagChange`, `PreToolUse`, etc.) | 10 |

When a limit is hit, further events of that type are **silently dropped** for the remainder of the 60-second window. A warning is logged. The window resets automatically.

**Example:** If you have a `LabelAdd` task that triggers a prompt which adds a label back to a session, it will fire at most 10 times before being rate-limited — preventing infinite session creation.

## Troubleshooting

### Automation not firing

1. **Check event name** - Must be exact (e.g., `LabelAdd` not `labeladd`)
2. **Check matcher** - Regex must match the event value
3. **Check cron** - For SchedulerTick, verify cron expression with an online tool
4. **Check logs** - Look for `[automations]` or `[Scheduler]` in the logs

### Prompt not creating session

1. Check that the prompt is not empty
2. Verify @mentions reference valid sources/skills

### Webhook not working

1. **Check URL** — Must be a valid `http://` or `https://` URL. Other protocols (ftp, ws, etc.) are rejected at runtime with a clear error.
2. **Check env vars** — Ensure `CRAFT_WH_*` variables are set in your shell profile and Craft Agent was restarted after adding them. URLs using `$VAR` templates are validated after variable expansion — if the variable is empty or unset, the URL will be invalid.
3. **Use the Test button** — Tests connectivity to the URL (note: env vars are not expanded during test)
4. **Check method** — Some endpoints require specific HTTP methods (POST, PUT, etc.)
5. **Check response** — The automation history shows HTTP status codes for webhook executions

### Retrying failed webhooks

When a webhook execution fails (shown with a red indicator in the timeline), you can retry it:

1. Open the automation's detail page
2. In the "Recent Activity" timeline, failed webhook entries show a **Retry** button
3. Click "Retry" to re-execute the webhook actions immediately
4. The retry result is recorded as a new history entry

> **Note:** Retries execute the webhook actions as currently configured. If you've changed the URL or headers since the original failure, the retry uses the updated configuration. Environment variables are not expanded during replay (same as the Test button).

## Best Practices

1. **Start simple** - Test with a basic prompt before building complex workflows
2. **Use labels** - Tag scheduled sessions for easy filtering
3. **Be specific** - Use matchers to avoid triggering on every event
4. **Test cron** - Use [crontab.guru](https://crontab.guru/) to verify expressions
5. **Keep secrets out of config** - Use `CRAFT_WH_*` env vars for webhook URLs and tokens instead of hardcoding them in automations.json
6. **Combine actions** - Use both webhook and prompt actions in a single automation for notification + AI response workflows
